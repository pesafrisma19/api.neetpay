import { prisma } from '../../lib/prisma.js';
import { encryptAES, decryptAES } from '../../lib/encryption.js';
import { GoBizClient, type GoBizTokenInfo } from './gobiz.client.js';
import {
  createTokenFingerprint,
  GoBizLifecycleTracker,
} from './gobiz.lifecycle.js';

// In-memory mutex for concurrency protection per GoBiz account ID
const activeRecoveryPromises = new Map<string, Promise<GoBizTokenInfo>>();

export class GoBizAdapter {
  /**
   * Helper to detect if an error is genuine GoBiz authentication invalidation
   */
  static isAuthenticationError(error: any): boolean {
    if (!error) return false;
    const msg = String(error.message || error).toLowerCase();
    const status = error.status || error.statusCode;

    if (status === 401 || status === 403) return true;
    if (
      msg.includes('401') ||
      msg.includes('unauthorized') ||
      msg.includes('token_expired') ||
      msg.includes('invalid_token') ||
      msg.includes('session expired') ||
      msg.includes('goid:error:validation')
    ) {
      return true;
    }
    return false;
  }

  /**
   * Execute GoBiz API call with active session and reactive auto-refresh fallback
   * Retries original request maximum 1 time upon successful token recovery.
   */
  static async executeWithSession<T>(
    goBizAccountId: string,
    operation: (accessToken: string) => Promise<T>
  ): Promise<T> {
    const goBizAccount = await prisma.goBizAccount.findUnique({
      where: { id: goBizAccountId },
      include: { paymentAccount: true },
    });

    if (!goBizAccount) {
      throw new Error('GOBIZ_ACCOUNT_NOT_FOUND');
    }

    if (!goBizAccount.paymentAccount.isActive || goBizAccount.paymentAccount.status === 'INACTIVE') {
      throw new Error('ACCOUNT_INACTIVE');
    }

    let credentials: { accessToken: string; refreshToken: string };
    try {
      credentials = JSON.parse(decryptAES(goBizAccount.credentialEncrypted));
    } catch {
      throw new Error('CREDENTIAL_DECRYPTION_FAILED');
    }

    const accessFp = createTokenFingerprint(credentials.accessToken);
    const refreshFp = createTokenFingerprint(credentials.refreshToken);

    try {
      // 1. Attempt original operation with current access_token
      const result = await operation(credentials.accessToken);

      // Record access success
      await GoBizLifecycleTracker.recordAccessSuccess(prisma, goBizAccountId, accessFp);
      await prisma.goBizAccount.update({
        where: { id: goBizAccountId },
        data: { lastConnectionCheckAt: new Date() },
      });

      return result;
    } catch (primaryError: any) {
      // Check if failure is an authentication error
      if (!this.isAuthenticationError(primaryError)) {
        // Business logic or network error; don't trigger refresh
        throw primaryError;
      }

      // Record access token failure
      await GoBizLifecycleTracker.recordAccessFailure(
        prisma,
        goBizAccountId,
        accessFp,
        primaryError.message || 'AUTH_FAILURE_401'
      );

      // 2. Trigger Reactive Recovery with Concurrency Protection
      const freshTokens = await this.recoverSessionWithConcurrencyProtection(
        goBizAccountId,
        goBizAccount,
        credentials,
        accessFp,
        refreshFp
      );

      // 3. Retry original operation with fresh access token (Max 1 retry)
      const retryResult = await operation(freshTokens.accessToken);

      // Record retry success
      const newAccessFp = createTokenFingerprint(freshTokens.accessToken);
      await GoBizLifecycleTracker.recordAccessSuccess(prisma, goBizAccountId, newAccessFp);

      return retryResult;
    }
  }

  /**
   * Concurrency-guarded session recovery
   */
  private static async recoverSessionWithConcurrencyProtection(
    goBizAccountId: string,
    account: any,
    credentials: { accessToken: string; refreshToken: string },
    oldAccessFp: string,
    oldRefreshFp: string
  ): Promise<GoBizTokenInfo> {
    // If another request is currently recovering this account, wait for it
    const existingRecovery = activeRecoveryPromises.get(goBizAccountId);
    if (existingRecovery) {
      return await existingRecovery;
    }

    const recoveryPromise = this.performSessionRecovery(
      goBizAccountId,
      account,
      credentials,
      oldAccessFp,
      oldRefreshFp
    ).finally(() => {
      activeRecoveryPromises.delete(goBizAccountId);
    });

    activeRecoveryPromises.set(goBizAccountId, recoveryPromise);
    return await recoveryPromise;
  }

  /**
   * Actual session recovery implementation (Refresh -> Password Fallback -> Needs Re-Auth)
   */
  private static async performSessionRecovery(
    goBizAccountId: string,
    account: any,
    credentials: { accessToken: string; refreshToken: string },
    oldAccessFp: string,
    oldRefreshFp: string
  ): Promise<GoBizTokenInfo> {
    // Step A: Attempt Refresh Token
    if (credentials.refreshToken) {
      await GoBizLifecycleTracker.recordRefreshAttempt(prisma, goBizAccountId, oldRefreshFp);

      try {
        const refreshed = await GoBizClient.refreshAccessToken(credentials.refreshToken);

        const newAccessToken = refreshed.accessToken;
        const newRefreshToken = refreshed.refreshToken || credentials.refreshToken;

        const newCredentialEncrypted = encryptAES(
          JSON.stringify({
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
          })
        );

        // Atomically update DB and lifecycle records
        await prisma.$transaction(async (tx) => {
          await tx.goBizAccount.update({
            where: { id: goBizAccountId },
            data: {
              credentialEncrypted: newCredentialEncrypted,
              credentialExpiresAt: null, // No assumed expiry
              lastConnectionCheckAt: new Date(),
            },
          });

          await tx.paymentAccount.update({
            where: { id: account.paymentAccountId },
            data: { status: 'ACTIVE' },
          });

          await GoBizLifecycleTracker.recordTokenRotation(
            tx,
            goBizAccountId,
            oldAccessFp,
            newAccessToken,
            oldRefreshFp,
            newRefreshToken
          );
        });

        return {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
        };
      } catch (refreshErr: any) {
        // Refresh token failed/rejected
        await GoBizLifecycleTracker.recordRefreshFailure(
          prisma,
          goBizAccountId,
          oldRefreshFp,
          refreshErr.message || 'REFRESH_TOKEN_FAILED'
        );
      }
    }

    // Step B: Password Fallback (if authType === 'PASSWORD' and encryptedPassword exists)
    if (account.authType === 'PASSWORD' && account.encryptedPassword) {
      try {
        const decryptedPassword = decryptAES(account.encryptedPassword);
        const email = account.loginIdentifier;

        const loginTokens = await GoBizClient.loginWithPassword(email, decryptedPassword);

        const newCredentialEncrypted = encryptAES(
          JSON.stringify({
            accessToken: loginTokens.accessToken,
            refreshToken: loginTokens.refreshToken,
          })
        );

        await prisma.$transaction(async (tx) => {
          await tx.goBizAccount.update({
            where: { id: goBizAccountId },
            data: {
              credentialEncrypted: newCredentialEncrypted,
              credentialExpiresAt: null,
              lastConnectionCheckAt: new Date(),
            },
          });

          await tx.paymentAccount.update({
            where: { id: account.paymentAccountId },
            data: { status: 'ACTIVE' },
          });

          await GoBizLifecycleTracker.recordTokenRotation(
            tx,
            goBizAccountId,
            oldAccessFp,
            loginTokens.accessToken,
            oldRefreshFp,
            loginTokens.refreshToken
          );
        });

        return loginTokens;
      } catch (passwordErr: any) {
        // Password login also failed (user changed password on GoBiz)
        await prisma.paymentAccount.update({
          where: { id: account.paymentAccountId },
          data: { status: 'NEEDS_REAUTH' },
        });

        throw new Error('GOBIZ_REAUTH_REQUIRED');
      }
    }

    // Step C: OTP Account where refresh failed -> mark NEEDS_REAUTH
    await prisma.paymentAccount.update({
      where: { id: account.paymentAccountId },
      data: { status: 'NEEDS_REAUTH' },
    });

    throw new Error('GOBIZ_REAUTH_REQUIRED');
  }
}
