import { prisma } from '../../lib/prisma.js';
import { encryptAES } from '../../lib/encryption.js';
import { GoBizClient, type GoBizTokenInfo } from '../../providers/gobiz/gobiz.client.js';
import { GoBizLifecycleTracker } from '../../providers/gobiz/gobiz.lifecycle.js';

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
   * Step 2: Verify OTP and save connected GoBiz account (authType: OTP)
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

    // Default display name format: {Payment Method} {Provider Label} - {Outlet/Merchant Name}
    const defaultDisplayName = input.accountName?.trim() ||
      (profile.outletName ? `QRIS GoBiz - ${profile.outletName.trim()}` : 'QRIS GoBiz');

    // 4. Save Connected Account with authType = OTP
    return await this.saveConnectedAccount(userId, tokens, profile, {
      accountName: defaultDisplayName,
      authType: 'OTP',
      loginIdentifier: profile.phone || '',
      customMinAmount: input.customMinAmount,
      customMaxAmount: input.customMaxAmount,
      qrString: qrString || undefined,
    });
  }

  /**
   * Direct connect using GoBiz email & password (authType: PASSWORD)
   */
  static async connectWithPassword(userId: string, input: ConnectWithPasswordInput) {
    await this.verifyAccountLimit(userId);

    const tokens = await GoBizClient.loginWithPassword(input.email, input.password);
    const profile = await GoBizClient.getMerchantProfile(tokens.accessToken);

    let qrString = input.manualQrString || null;
    if (!qrString) {
      qrString = await GoBizClient.fetchQrisStringFromPortal(tokens.accessToken);
    }

    // For PASSWORD accounts, password is encrypted with AES-256-GCM for automatic recovery fallback
    const encryptedPassword = encryptAES(input.password);

    // Default display name format: {Payment Method} {Provider Label} - {Outlet/Merchant Name}
    const defaultDisplayName = input.accountName?.trim() ||
      (profile.outletName ? `QRIS GoBiz - ${profile.outletName.trim()}` : 'QRIS GoBiz');

    return await this.saveConnectedAccount(userId, tokens, profile, {
      accountName: defaultDisplayName,
      authType: 'PASSWORD',
      loginIdentifier: input.email.trim().toLowerCase(),
      encryptedPassword,
      customMinAmount: input.customMinAmount,
      customMaxAmount: input.customMaxAmount,
      qrString: qrString || undefined,
    });
  }

  /**
   * Helper to persist PaymentAccount + GoBizAccount with AES-256-GCM encryption & Token Lifecycle
   */
  private static async saveConnectedAccount(
    userId: string,
    tokens: GoBizTokenInfo,
    profile: any,
    options: {
      accountName: string;
      authType: 'OTP' | 'PASSWORD';
      loginIdentifier: string;
      encryptedPassword?: string;
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

    // Create PaymentAccount, GoBizAccount, and Initial Token Lifecycles in atomic transaction
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

      const goBizAccount = await tx.goBizAccount.create({
        data: {
          paymentAccountId: account.id,
          authType: options.authType,
          merchantId: profile.merchantId,
          outletId: profile.merchantId, // GoBiz main outlet ID
          merchantName: profile.outletName,
          outletName: profile.outletName,
          loginIdentifier: options.loginIdentifier,
          credentialEncrypted,
          encryptedPassword: options.encryptedPassword || null,
          credentialExpiresAt: null, // No assumed expiry
          qrString: options.qrString || null,
          qrUpdatedAt: options.qrString ? new Date() : null,
          lastConnectionCheckAt: new Date(),
        },
      });

      // Record Initial ACCESS & REFRESH token lifecycles
      await GoBizLifecycleTracker.recordInitialTokens(
        tx,
        goBizAccount.id,
        tokens.accessToken,
        tokens.refreshToken
      );

      return account;
    });

    return {
      id: paymentAccount.id,
      name: paymentAccount.name,
      status: paymentAccount.status,
      provider: 'GOBIZ',
      merchantName: profile.outletName,
      outletName: profile.outletName,
      hasQrString: !!options.qrString,
      connectedAt: paymentAccount.createdAt,
    };
  }

  /**
   * List Public Active Payment Channels for Merchant API (GET /v1/payment-channels)
   * Sanitized: Never exposes credentials, tokens, or GoBiz internals
   */
  static async listPublicChannels(userId: string) {
    const accounts = await prisma.paymentAccount.findMany({
      where: {
        userId,
        isActive: true,
        status: 'ACTIVE',
        goBizAccount: {
          qrString: { not: null },
        },
      },
      include: {
        provider: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return accounts.map((acc) => ({
      id: acc.id,
      name: acc.name,
      method: 'QRIS',
      provider: acc.provider.code,
    }));
  }

  /**
   * List all Connected Payment Accounts for Dashboard (with token lifecycle audit)
   */
  static async listAccounts(userId: string) {
    const accounts = await prisma.paymentAccount.findMany({
      where: { userId, isActive: true },
      include: {
        provider: true,
        goBizAccount: {
          select: {
            id: true,
            authType: true,
            merchantId: true,
            outletId: true,
            merchantName: true,
            outletName: true,
            qrString: true,
            qrUpdatedAt: true,
            lastConnectionCheckAt: true,
            createdAt: true,
            tokenLifecycles: {
              select: {
                tokenType: true,
                tokenFingerprint: true,
                issuedAt: true,
                lastSuccessAt: true,
                lastAttemptAt: true,
                failedAt: true,
                replacedAt: true,
                failureCode: true,
              },
              orderBy: { issuedAt: 'desc' },
              take: 10,
            },
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
            id: acc.goBizAccount.id,
            authType: acc.goBizAccount.authType,
            merchantId: acc.goBizAccount.merchantId,
            outletId: acc.goBizAccount.outletId,
            merchantName: acc.goBizAccount.merchantName,
            outletName: acc.goBizAccount.outletName,
            hasQrString: !!acc.goBizAccount.qrString,
            qrUpdatedAt: acc.goBizAccount.qrUpdatedAt,
            lastConnectionCheckAt: acc.goBizAccount.lastConnectionCheckAt,
            connectedSince: acc.goBizAccount.createdAt,
            tokenLifecycles: acc.goBizAccount.tokenLifecycles,
          }
        : null,
      createdAt: acc.createdAt,
    }));
  }

  /**
   * Get single Payment Account details with GoBiz token lifecycles and fee rule
   */
  static async getAccount(userId: string, accountId: string) {
    const acc = await prisma.paymentAccount.findFirst({
      where: { id: accountId, userId },
      include: {
        provider: true,
        goBizAccount: {
          include: {
            tokenLifecycles: {
              orderBy: { issuedAt: 'desc' },
              take: 20,
            },
          },
        },
      },
    });

    if (!acc) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }

    // Get user's fee rule for QRIS
    const qrisMethod = await prisma.paymentMethod.findUnique({ where: { code: 'QRIS' } });
    const feeRule = qrisMethod
      ? await prisma.paymentFeeRule.findUnique({
          where: {
            userId_paymentMethodId: {
              userId,
              paymentMethodId: qrisMethod.id,
            },
          },
        })
      : null;

    return {
      id: acc.id,
      name: acc.name,
      status: acc.status,
      isActive: acc.isActive,
      provider: acc.provider.code,
      providerName: acc.provider.name,
      customMinAmount: acc.customMinAmount ? Number(acc.customMinAmount) : null,
      customMaxAmount: acc.customMaxAmount ? Number(acc.customMaxAmount) : null,
      lastSyncedAt: acc.lastSyncedAt,
      feeRule: {
        type: feeRule?.type || 'NONE',
        value: feeRule?.value || 0,
        isEnabled: feeRule?.isEnabled ?? true,
      },
      goBiz: acc.goBizAccount
        ? {
            id: acc.goBizAccount.id,
            authType: acc.goBizAccount.authType,
            merchantId: acc.goBizAccount.merchantId,
            outletId: acc.goBizAccount.outletId,
            merchantName: acc.goBizAccount.merchantName,
            outletName: acc.goBizAccount.outletName,
            loginIdentifierMasked: acc.goBizAccount.loginIdentifier
              ? acc.goBizAccount.loginIdentifier.slice(0, 3) + '••••' + acc.goBizAccount.loginIdentifier.slice(-3)
              : null,
            hasQrString: !!acc.goBizAccount.qrString,
            qrUpdatedAt: acc.goBizAccount.qrUpdatedAt,
            lastConnectionCheckAt: acc.goBizAccount.lastConnectionCheckAt,
            connectedSince: acc.goBizAccount.createdAt,
            tokenLifecycles: acc.goBizAccount.tokenLifecycles.map((tl) => ({
              id: tl.id,
              tokenType: tl.tokenType,
              tokenFingerprint: tl.tokenFingerprint,
              issuedAt: tl.issuedAt,
              lastSuccessAt: tl.lastSuccessAt,
              lastAttemptAt: tl.lastAttemptAt,
              failedAt: tl.failedAt,
              replacedAt: tl.replacedAt,
              failureCode: tl.failureCode,
            })),
          }
        : null,
      createdAt: acc.createdAt,
      updatedAt: acc.updatedAt,
    };
  }

  /**
   * Update Payment Account settings (Display Name, Limits, Fee Rule)
   */
  static async updateAccount(
    userId: string,
    accountId: string,
    data: {
      name?: string;
      customMinAmount?: number | null;
      customMaxAmount?: number | null;
      feeType?: 'NONE' | 'FLAT' | 'PERCENT';
      feeValue?: number;
    }
  ) {
    const account = await prisma.paymentAccount.findFirst({
      where: { id: accountId, userId },
    });

    if (!account) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }

    const trimmedName = data.name !== undefined ? data.name.trim() : undefined;
    if (trimmedName !== undefined && trimmedName.length === 0) {
      throw new Error('ACCOUNT_NAME_REQUIRED');
    }

    await prisma.paymentAccount.update({
      where: { id: accountId },
      data: {
        ...(trimmedName !== undefined ? { name: trimmedName } : {}),
        ...(data.customMinAmount !== undefined ? { customMinAmount: data.customMinAmount } : {}),
        ...(data.customMaxAmount !== undefined ? { customMaxAmount: data.customMaxAmount } : {}),
      },
    });

    // Update or upsert Fee Rule if feeType provided
    if (data.feeType) {
      const qrisMethod = await prisma.paymentMethod.findUnique({ where: { code: 'QRIS' } });
      if (qrisMethod) {
        await prisma.paymentFeeRule.upsert({
          where: {
            userId_paymentMethodId: {
              userId,
              paymentMethodId: qrisMethod.id,
            },
          },
          update: {
            type: data.feeType,
            value: data.feeValue !== undefined ? Math.max(0, data.feeValue) : 0,
            isEnabled: data.feeType !== 'NONE',
          },
          create: {
            userId,
            paymentMethodId: qrisMethod.id,
            type: data.feeType,
            value: data.feeValue !== undefined ? Math.max(0, data.feeValue) : 0,
            isEnabled: data.feeType !== 'NONE',
          },
        });
      }
    }

    return this.getAccount(userId, accountId);
  }

  /**
   * Resync QRIS timestamp for Payment Account
   */
  static async resyncQris(userId: string, accountId: string) {
    const account = await prisma.paymentAccount.findFirst({
      where: { id: accountId, userId },
      include: { goBizAccount: true },
    });

    if (!account || !account.goBizAccount) {
      throw new Error('ACCOUNT_NOT_FOUND');
    }

    await prisma.goBizAccount.update({
      where: { id: account.goBizAccount.id },
      data: {
        qrUpdatedAt: new Date(),
        lastConnectionCheckAt: new Date(),
      },
    });

    return {
      synced: true,
      qrUpdatedAt: new Date(),
    };
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
