import { prisma } from '../../lib/prisma.js';
import { encryptAES, decryptAES } from '../../lib/encryption.js';
import { GoBizClient, type GoBizTokenInfo } from '../../providers/gobiz/gobiz.client.js';

export interface ConnectWithOtpInput {
  otpToken: string;
  otp: string;
  uniqueId: string;
  accountName?: string;
  customMinAmount?: number;
  customMaxAmount?: number;
  manualQrString?: string;
}

export interface ConnectWithPasswordInput {
  email: string;
  password: string;
  accountName?: string;
  customMinAmount?: number;
  customMaxAmount?: number;
  manualQrString?: string;
}

export class PaymentAccountService {
  /**
   * Helper to parse or calculate token expiry Date
   * Priority: 1. expiresIn seconds -> 2. JWT payload exp -> 3. Standard GoBiz 30 days default
   */
  static calculateTokenExpiry(accessToken: string, expiresIn?: number): Date {
    if (expiresIn && typeof expiresIn === 'number' && expiresIn > 0) {
      return new Date(Date.now() + expiresIn * 1000);
    }

    try {
      const parts = accessToken.split('.');
      if (parts.length === 3) {
        const payloadJson = Buffer.from(parts[1], 'base64').toString('utf8');
        const payload = JSON.parse(payloadJson);
        if (payload.exp && typeof payload.exp === 'number') {
          return new Date(payload.exp * 1000);
        }
      }
    } catch {}

    // Standard GoBiz session validity is 30 days
    const DEFAULT_GOBIZ_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
    return new Date(Date.now() + DEFAULT_GOBIZ_TOKEN_LIFETIME_MS);
  }

  /**
   * Helper to verify if user has available payment account quota in their active plan
   */
  private static async verifyAccountLimit(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        subscriptions: {
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { plan: true },
        },
        paymentAccounts: {
          where: { isActive: true },
        },
      },
    });

    if (!user) {
      throw new Error('USER_NOT_FOUND');
    }

    const currentPlan = user.subscriptions[0]?.plan;
    const limit = currentPlan?.paymentAccountLimit ?? 1;
    const activeCount = user.paymentAccounts.length;

    if (activeCount >= limit) {
      throw new Error('ACCOUNT_LIMIT_EXCEEDED');
    }
  }

  /**
   * Step 1: Request OTP from GoBiz
   */
  static async requestOtp(userId: string, phoneNumber: string) {
    await this.verifyAccountLimit(userId);
    return await GoBizClient.requestOtp(phoneNumber);
  }

  /**
   * Step 2: Verify OTP and save connected GoBiz account (with automatic QRIS extraction)
   */
  static async verifyOtpAndConnect(userId: string, input: ConnectWithOtpInput) {
    await this.verifyAccountLimit(userId);

    // 1. Verify OTP with GoBiz
    const tokens = await GoBizClient.verifyOtp(input.otpToken, input.otp, input.uniqueId);

    // 2. Fetch Merchant Profile from GoBiz
    const profile = await GoBizClient.getMerchantProfile(tokens.accessToken);

    // 3. Automatically fetch static QRIS string from GoBiz Portal
    let qrString = input.manualQrString || null;
    if (!qrString) {
      qrString = await GoBizClient.fetchQrisStringFromPortal(tokens.accessToken);
    }

    // 4. Save Connected Account
    return await this.saveConnectedAccount(userId, tokens, profile, {
      accountName: input.accountName || profile.outletName,
      customMinAmount: input.customMinAmount,
      customMaxAmount: input.customMaxAmount,
      qrString: qrString || undefined,
    });
  }

  /**
   * Direct connect using GoBiz email & password
   */
  static async connectWithPassword(userId: string, input: ConnectWithPasswordInput) {
    await this.verifyAccountLimit(userId);

    const tokens = await GoBizClient.loginWithPassword(input.email, input.password);
    const profile = await GoBizClient.getMerchantProfile(tokens.accessToken);

    let qrString = input.manualQrString || null;
    if (!qrString) {
      qrString = await GoBizClient.fetchQrisStringFromPortal(tokens.accessToken);
    }

    return await this.saveConnectedAccount(userId, tokens, profile, {
      accountName: input.accountName || profile.outletName,
      customMinAmount: input.customMinAmount,
      customMaxAmount: input.customMaxAmount,
      qrString: qrString || undefined,
    });
  }

  /**
   * Helper to persist PaymentAccount + GoBizAccount with AES-256-GCM encryption & QRIS
   */
  private static async saveConnectedAccount(
    userId: string,
    tokens: GoBizTokenInfo,
    profile: any,
    options: {
      accountName: string;
      customMinAmount?: number;
      customMaxAmount?: number;
      qrString?: string;
    }
  ) {
    // Find GOBIZ provider
    const provider = await prisma.paymentProvider.findUnique({
      where: { code: 'GOBIZ' },
    });

    if (!provider) {
      throw new Error('PROVIDER_NOT_FOUND');
    }

    // Encrypt GoBiz credentials securely using AES-256-GCM
    const credentialEncrypted = encryptAES(
      JSON.stringify({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      })
    );

    // Calculate token expiration timestamp
    const credentialExpiresAt = this.calculateTokenExpiry(tokens.accessToken, tokens.expiresIn);

    // Create PaymentAccount and GoBizAccount in atomic transaction
    const paymentAccount = await prisma.$transaction(async (tx) => {
      const account = await tx.paymentAccount.create({
        data: {
          userId,
          providerId: provider.id,
          name: options.accountName,
          customMinAmount: options.customMinAmount,
          customMaxAmount: options.customMaxAmount,
          status: 'ACTIVE',
          isActive: true,
          lastSyncedAt: new Date(),
        },
      });

      await tx.goBizAccount.create({
        data: {
          paymentAccountId: account.id,
          merchantId: profile.merchantId,
          outletId: profile.merchantId, // GoBiz main outlet ID
          merchantName: profile.outletName,
          outletName: profile.outletName,
          loginIdentifier: profile.phone || '',
          credentialEncrypted,
          credentialExpiresAt,
          qrString: options.qrString || null,
          qrUpdatedAt: options.qrString ? new Date() : null,
          lastConnectionCheckAt: new Date(),
        },
      });

      return account;
    });

    return {
      id: paymentAccount.id,
      name: paymentAccount.name,
      status: paymentAccount.status,
      provider: 'GOBIZ',
      merchantId: profile.merchantId,
      outletName: profile.outletName,
      customMinAmount: paymentAccount.customMinAmount,
      customMaxAmount: paymentAccount.customMaxAmount,
      hasQrString: !!options.qrString,
      credentialExpiresAt,
      createdAt: paymentAccount.createdAt,
    };
  }

  /**
   * Ensure fresh and valid access_token for GoBiz API calls.
   * If token is expired or within 24 hours of expiry, auto-refresh via refresh_token.
   */
  static async ensureValidToken(paymentAccountId: string): Promise<string> {
    const goBizAccount = await prisma.goBizAccount.findUnique({
      where: { paymentAccountId },
    });

    if (!goBizAccount) {
      throw new Error('GOBIZ_ACCOUNT_NOT_FOUND');
    }

    const decrypted = JSON.parse(decryptAES(goBizAccount.credentialEncrypted));
    const isExpiringSoon =
      goBizAccount.credentialExpiresAt &&
      goBizAccount.credentialExpiresAt.getTime() - Date.now() < 24 * 60 * 60 * 1000; // < 24 hours

    if (!isExpiringSoon || !decrypted.refreshToken) {
      return decrypted.accessToken;
    }

    try {
      // Auto-refresh token with GoBiz
      const newTokens = await GoBizClient.refreshAccessToken(decrypted.refreshToken);
      const newCredentialEncrypted = encryptAES(
        JSON.stringify({
          accessToken: newTokens.accessToken,
          refreshToken: newTokens.refreshToken || decrypted.refreshToken,
        })
      );
      const newExpiresAt = this.calculateTokenExpiry(newTokens.accessToken, newTokens.expiresIn);

      await prisma.goBizAccount.update({
        where: { paymentAccountId },
        data: {
          credentialEncrypted: newCredentialEncrypted,
          credentialExpiresAt: newExpiresAt,
          lastConnectionCheckAt: new Date(),
        },
      });

      return newTokens.accessToken;
    } catch {
      // Fallback to existing token if refresh fails temporarily
      return decrypted.accessToken;
    }
  }

  /**
   * List all payment accounts for a user
   */
  static async listAccounts(userId: string) {
    const accounts = await prisma.paymentAccount.findMany({
      where: { userId, isActive: true },
      include: {
        provider: {
          select: {
            code: true,
            name: true,
          },
        },
        goBizAccount: {
          select: {
            merchantId: true,
            outletId: true,
            merchantName: true,
            outletName: true,
            qrString: true,
            qrUpdatedAt: true,
            credentialExpiresAt: true,
            lastConnectionCheckAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return accounts.map((acc) => ({
      id: acc.id,
      name: acc.name,
      status: acc.status,
      provider: acc.provider.code,
      providerName: acc.provider.name,
      customMinAmount: acc.customMinAmount,
      customMaxAmount: acc.customMaxAmount,
      lastSyncedAt: acc.lastSyncedAt,
      goBiz: acc.goBizAccount
        ? {
            merchantId: acc.goBizAccount.merchantId,
            outletId: acc.goBizAccount.outletId,
            merchantName: acc.goBizAccount.merchantName,
            outletName: acc.goBizAccount.outletName,
            hasQrString: !!acc.goBizAccount.qrString,
            qrUpdatedAt: acc.goBizAccount.qrUpdatedAt,
            credentialExpiresAt: acc.goBizAccount.credentialExpiresAt,
            lastConnectionCheckAt: acc.goBizAccount.lastConnectionCheckAt,
          }
        : null,
      createdAt: acc.createdAt,
    }));
  }

  /**
   * Disconnect / Deactivate payment account
   */
  static async disconnectAccount(userId: string, accountId: string) {
    const account = await prisma.paymentAccount.findFirst({
      where: { id: accountId, userId },
    });

    if (!account) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }

    await prisma.paymentAccount.update({
      where: { id: accountId },
      data: {
        isActive: false,
        status: 'INACTIVE',
      },
    });

    return { disconnected: true };
  }
}
