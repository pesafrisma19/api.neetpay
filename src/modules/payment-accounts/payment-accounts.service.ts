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
}

export interface ConnectWithPasswordInput {
  email: string;
  password: string;
  accountName?: string;
  customMinAmount?: number;
  customMaxAmount?: number;
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
   * Step 2: Verify OTP and save connected GoBiz account
   */
  static async verifyOtpAndConnect(userId: string, input: ConnectWithOtpInput) {
    await this.verifyAccountLimit(userId);

    // 1. Verify OTP with GoBiz
    const tokens = await GoBizClient.verifyOtp(input.otpToken, input.otp, input.uniqueId);

    // 2. Fetch Merchant Profile from GoBiz
    const profile = await GoBizClient.getMerchantProfile(tokens.accessToken);

    // 3. Save Connected Account
    return await this.saveConnectedAccount(userId, tokens, profile, {
      accountName: input.accountName || profile.outletName,
      customMinAmount: input.customMinAmount,
      customMaxAmount: input.customMaxAmount,
    });
  }

  /**
   * Direct connect using GoBiz email & password
   */
  static async connectWithPassword(userId: string, input: ConnectWithPasswordInput) {
    await this.verifyAccountLimit(userId);

    const tokens = await GoBizClient.loginWithPassword(input.email, input.password);
    const profile = await GoBizClient.getMerchantProfile(tokens.accessToken);

    return await this.saveConnectedAccount(userId, tokens, profile, {
      accountName: input.accountName || profile.outletName,
      customMinAmount: input.customMinAmount,
      customMaxAmount: input.customMaxAmount,
    });
  }

  /**
   * Helper to persist PaymentAccount + GoBizAccount with AES-256-GCM encryption
   */
  private static async saveConnectedAccount(
    userId: string,
    tokens: GoBizTokenInfo,
    profile: any,
    options: {
      accountName: string;
      customMinAmount?: number;
      customMaxAmount?: number;
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
          outletId: profile.merchantId, // GoBiz main outlet ID matches merchant ID
          merchantName: profile.outletName,
          outletName: profile.outletName,
          loginIdentifier: profile.phone || '',
          credentialEncrypted,
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
      createdAt: paymentAccount.createdAt,
    };
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
      goBiz: acc.goBizAccount,
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
