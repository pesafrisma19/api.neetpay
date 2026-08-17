import crypto from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

export type PrismaTxOrClient = Prisma.TransactionClient | PrismaClient;

/**
 * Generate SHA-256 fingerprint from raw token string
 * Raw token is NEVER stored in the lifecycle table.
 */
export function createTokenFingerprint(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken.trim()).digest('hex');
}

export class GoBizLifecycleTracker {
  /**
   * Record initial ACCESS and REFRESH token lifecycles during onboarding
   */
  static async recordInitialTokens(
    tx: PrismaTxOrClient,
    goBizAccountId: string,
    accessToken: string,
    refreshToken: string
  ) {
    const now = new Date();
    const accessFp = createTokenFingerprint(accessToken);
    const refreshFp = createTokenFingerprint(refreshToken);

    await tx.goBizTokenLifecycle.create({
      data: {
        goBizAccountId,
        tokenType: 'ACCESS',
        tokenFingerprint: accessFp,
        issuedAt: now,
        lastAttemptAt: now,
        lastSuccessAt: now,
      },
    });

    await tx.goBizTokenLifecycle.create({
      data: {
        goBizAccountId,
        tokenType: 'REFRESH',
        tokenFingerprint: refreshFp,
        issuedAt: now,
        lastAttemptAt: now,
        lastSuccessAt: now,
      },
    });
  }

  /**
   * Update lifecycle record on successful ACCESS token usage
   */
  static async recordAccessSuccess(
    tx: PrismaTxOrClient,
    goBizAccountId: string,
    accessTokenFingerprint: string
  ) {
    const now = new Date();
    const active = await tx.goBizTokenLifecycle.findFirst({
      where: {
        goBizAccountId,
        tokenType: 'ACCESS',
        tokenFingerprint: accessTokenFingerprint,
        replacedAt: null,
      },
      orderBy: { issuedAt: 'desc' },
    });

    if (active) {
      await tx.goBizTokenLifecycle.update({
        where: { id: active.id },
        data: {
          lastAttemptAt: now,
          lastSuccessAt: now,
        },
      });
    }
  }

  /**
   * Update lifecycle record on ACCESS token authentication failure
   */
  static async recordAccessFailure(
    tx: PrismaTxOrClient,
    goBizAccountId: string,
    accessTokenFingerprint: string,
    failureCode: string
  ) {
    const now = new Date();
    const active = await tx.goBizTokenLifecycle.findFirst({
      where: {
        goBizAccountId,
        tokenType: 'ACCESS',
        tokenFingerprint: accessTokenFingerprint,
        replacedAt: null,
      },
      orderBy: { issuedAt: 'desc' },
    });

    if (active) {
      await tx.goBizTokenLifecycle.update({
        where: { id: active.id },
        data: {
          lastAttemptAt: now,
          failedAt: active.failedAt || now,
          failureCode,
        },
      });
    }
  }

  /**
   * Record REFRESH token attempt
   */
  static async recordRefreshAttempt(
    tx: PrismaTxOrClient,
    goBizAccountId: string,
    refreshTokenFingerprint: string
  ) {
    const now = new Date();
    const active = await tx.goBizTokenLifecycle.findFirst({
      where: {
        goBizAccountId,
        tokenType: 'REFRESH',
        tokenFingerprint: refreshTokenFingerprint,
        replacedAt: null,
      },
      orderBy: { issuedAt: 'desc' },
    });

    if (active) {
      await tx.goBizTokenLifecycle.update({
        where: { id: active.id },
        data: {
          lastAttemptAt: now,
        },
      });
    }
  }

  /**
   * Record REFRESH token failure
   */
  static async recordRefreshFailure(
    tx: PrismaTxOrClient,
    goBizAccountId: string,
    refreshTokenFingerprint: string,
    failureCode: string
  ) {
    const now = new Date();
    const active = await tx.goBizTokenLifecycle.findFirst({
      where: {
        goBizAccountId,
        tokenType: 'REFRESH',
        tokenFingerprint: refreshTokenFingerprint,
        replacedAt: null,
      },
      orderBy: { issuedAt: 'desc' },
    });

    if (active) {
      await tx.goBizTokenLifecycle.update({
        where: { id: active.id },
        data: {
          lastAttemptAt: now,
          failedAt: now,
          failureCode,
        },
      });
    }
  }

  /**
   * Handle rotation when new tokens are received
   * - Marks old ACCESS as replacedAt and creates new ACCESS lifecycle
   * - If new refresh token has DIFFERENT fingerprint: marks old REFRESH as replacedAt and creates new REFRESH lifecycle
   * - If new refresh token is identical (unrotated): updates existing REFRESH record without creating duplicate
   */
  static async recordTokenRotation(
    tx: PrismaTxOrClient,
    goBizAccountId: string,
    oldAccessFp: string,
    newAccessToken: string,
    oldRefreshFp: string,
    newRefreshToken: string
  ) {
    const now = new Date();
    const newAccessFp = createTokenFingerprint(newAccessToken);
    const newRefreshFp = createTokenFingerprint(newRefreshToken);

    // 1. Mark old ACCESS token as replaced
    const oldAccessRecord = await tx.goBizTokenLifecycle.findFirst({
      where: {
        goBizAccountId,
        tokenType: 'ACCESS',
        tokenFingerprint: oldAccessFp,
        replacedAt: null,
      },
      orderBy: { issuedAt: 'desc' },
    });

    if (oldAccessRecord) {
      await tx.goBizTokenLifecycle.update({
        where: { id: oldAccessRecord.id },
        data: { replacedAt: now },
      });
    }

    // 2. Create new ACCESS token lifecycle record
    await tx.goBizTokenLifecycle.create({
      data: {
        goBizAccountId,
        tokenType: 'ACCESS',
        tokenFingerprint: newAccessFp,
        issuedAt: now,
        lastAttemptAt: now,
        lastSuccessAt: now,
      },
    });

    // 3. Handle REFRESH token
    if (newRefreshFp !== oldRefreshFp) {
      // Rotation occurred: replace old and create new
      const oldRefreshRecord = await tx.goBizTokenLifecycle.findFirst({
        where: {
          goBizAccountId,
          tokenType: 'REFRESH',
          tokenFingerprint: oldRefreshFp,
          replacedAt: null,
        },
        orderBy: { issuedAt: 'desc' },
      });

      if (oldRefreshRecord) {
        await tx.goBizTokenLifecycle.update({
          where: { id: oldRefreshRecord.id },
          data: { replacedAt: now },
        });
      }

      await tx.goBizTokenLifecycle.create({
        data: {
          goBizAccountId,
          tokenType: 'REFRESH',
          tokenFingerprint: newRefreshFp,
          issuedAt: now,
          lastAttemptAt: now,
          lastSuccessAt: now,
        },
      });
    } else {
      // No rotation: update existing refresh record's lastSuccessAt without duplicate
      const currentRefreshRecord = await tx.goBizTokenLifecycle.findFirst({
        where: {
          goBizAccountId,
          tokenType: 'REFRESH',
          tokenFingerprint: oldRefreshFp,
          replacedAt: null,
        },
        orderBy: { issuedAt: 'desc' },
      });

      if (currentRefreshRecord) {
        await tx.goBizTokenLifecycle.update({
          where: { id: currentRefreshRecord.id },
          data: {
            lastAttemptAt: now,
            lastSuccessAt: now,
          },
        });
      }
    }
  }
}
