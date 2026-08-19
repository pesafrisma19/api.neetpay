import { prisma } from '../../lib/prisma.js';
import { encryptAES } from '../../lib/encryption.js';
import { GoBizClient, type GoBizTokenInfo } from '../../providers/gobiz/gobiz.client.js';
import { GoBizLifecycleTracker } from '../../providers/gobiz/gobiz.lifecycle.js';
import { logger } from '../../lib/logger.js';

export interface ConnectDynamicPasswordInput {
  email: string;
  password: string;
  accountName?: string;
  customMinAmount?: number;
  customMaxAmount?: number;
}

export interface ConnectDynamicOtpInput {
  otpToken: string;
  otp: string;
  uniqueId: string;
  accountName?: string;
  customMinAmount?: number;
  customMaxAmount?: number;
}

export class GoBizDynamicService {
  /**
   * Verify if user has available payment account quota in their active plan
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
   * Helper to persist PaymentAccount + GoBizAccount for GOBIZ_DYNAMIC with AES-256-GCM encryption
   */
  private static async saveDynamicConnectedAccount(
    userId: string,
    tokens: GoBizTokenInfo,
    profile: { merchantId: string; outletName: string; serverKey?: string; clientKey?: string },
    options: {
      accountName: string;
      authType: 'OTP' | 'PASSWORD';
      loginIdentifier: string;
      encryptedPassword?: string;
      customMinAmount?: number;
      customMaxAmount?: number;
    }
  ) {
    // Find GOBIZ_DYNAMIC provider
    const provider = await prisma.paymentProvider.findUnique({
      where: { code: 'GOBIZ_DYNAMIC' },
    });

    if (!provider) {
      throw new Error('PROVIDER_NOT_FOUND: GOBIZ_DYNAMIC provider is not seeded');
    }

    // Encrypt GoBiz credentials + Midtrans Server Key securely using AES-256-GCM
    const credentialEncrypted = encryptAES(
      JSON.stringify({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        serverKey: profile.serverKey || '',
        clientKey: profile.clientKey || '',
      })
    );

    // Create PaymentAccount and GoBizAccount atomically
    const paymentAccount = await prisma.$transaction(async (tx) => {
      const account = await tx.paymentAccount.create({
        data: {
          userId,
          providerId: provider.id,
          name: options.accountName,
          customMinAmount: options.customMinAmount,
          customMaxAmount: options.customMaxAmount,
          useUniqueCode: false, // Dynamic QR uses exact nominal (no unique code needed)
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
          outletId: profile.merchantId,
          merchantName: profile.outletName,
          outletName: profile.outletName,
          loginIdentifier: options.loginIdentifier,
          credentialEncrypted,
          encryptedPassword: options.encryptedPassword || null,
          credentialExpiresAt: null,
          qrString: null, // Dynamic QR does not require base static QR
          qrUpdatedAt: null,
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

    logger.info(
      { userId, paymentAccountId: paymentAccount.id, provider: 'GOBIZ_DYNAMIC' },
      'GoPay Merchant Dynamic account connected successfully'
    );

    return {
      id: paymentAccount.id,
      name: paymentAccount.name,
      status: paymentAccount.status,
      provider: 'GOBIZ_DYNAMIC',
      providerName: 'GoPay Merchant Dynamic',
      merchantName: profile.outletName,
      outletName: profile.outletName,
      hasQrString: false,
      connectedAt: paymentAccount.createdAt,
    };
  }

  /**
   * Connect GoPay Merchant Dynamic using Email & Password
   */
  static async connectWithPassword(userId: string, input: ConnectDynamicPasswordInput) {
    await this.verifyAccountLimit(userId);

    // 1. Authenticate with GoBiz
    const tokenInfo = await GoBizClient.loginWithPassword(input.email, input.password);

    // 2. Fetch Merchant Profile & Midtrans Server Key
    const searchRes = await fetch('https://api.gobiz.co.id/v1/merchants/search', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'authentication-type': 'go-id',
        'authorization': `Bearer ${tokenInfo.accessToken}`,
        'content-type': 'application/json',
        'x-appid': 'go-biz-web-dashboard',
        'x-platform': 'Web',
        'x-deviceos': 'Web',
      },
      body: JSON.stringify({ from: 0, to: 10 }),
    });

    if (!searchRes.ok) {
      throw new Error(`FAILED_FETCH_MERCHANT_PROFILE: HTTP ${searchRes.status}`);
    }

    const searchData = (await searchRes.json()) as any;
    const hit = searchData.hits?.[0];

    if (!hit) {
      throw new Error('MERCHANT_PROFILE_EMPTY: No merchant outlet found for this GoBiz account');
    }

    const merchantId = hit.id;
    const outletName = hit.outlet_name || hit.name || 'GoPay Merchant Outlet';
    const serverKey = hit.server_key;
    const clientKey = hit.client_key;

    if (!serverKey) {
      throw new Error('SERVER_KEY_NOT_FOUND: Midtrans Server Key not found in GoBiz profile');
    }

    // Encrypt password for automatic re-auth capability
    const encryptedPassword = encryptAES(input.password);

    return await this.saveDynamicConnectedAccount(
      userId,
      tokenInfo,
      { merchantId, outletName, serverKey, clientKey },
      {
        accountName: input.accountName?.trim() || outletName,
        authType: 'PASSWORD',
        loginIdentifier: input.email.trim().toLowerCase(),
        encryptedPassword,
        customMinAmount: input.customMinAmount,
        customMaxAmount: input.customMaxAmount,
      }
    );
  }

  /**
   * Request SMS OTP for GoPay Merchant Dynamic
   */
  static async requestOtp(userId: string, phoneNumber: string) {
    await this.verifyAccountLimit(userId);
    return await GoBizClient.requestOtp(phoneNumber);
  }

  /**
   * Verify SMS OTP and Connect GoPay Merchant Dynamic
   */
  static async verifyOtpAndConnect(userId: string, input: ConnectDynamicOtpInput) {
    await this.verifyAccountLimit(userId);

    // 1. Verify OTP with GoBiz
    const tokenInfo = await GoBizClient.verifyOtp(input.otpToken, input.otp, input.uniqueId);

    // 2. Fetch Merchant Profile & Midtrans Server Key
    const searchRes = await fetch('https://api.gobiz.co.id/v1/merchants/search', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'authentication-type': 'go-id',
        'authorization': `Bearer ${tokenInfo.accessToken}`,
        'content-type': 'application/json',
        'x-appid': 'go-biz-web-dashboard',
        'x-platform': 'Web',
        'x-deviceos': 'Web',
      },
      body: JSON.stringify({ from: 0, to: 10 }),
    });

    if (!searchRes.ok) {
      throw new Error(`FAILED_FETCH_MERCHANT_PROFILE: HTTP ${searchRes.status}`);
    }

    const searchData = (await searchRes.json()) as any;
    const hit = searchData.hits?.[0];

    if (!hit) {
      throw new Error('MERCHANT_PROFILE_EMPTY: No merchant outlet found for this GoBiz account');
    }

    const merchantId = hit.id;
    const outletName = hit.outlet_name || hit.name || 'GoPay Merchant Outlet';
    const serverKey = hit.server_key;
    const clientKey = hit.client_key;

    if (!serverKey) {
      throw new Error('SERVER_KEY_NOT_FOUND: Midtrans Server Key not found in GoBiz profile');
    }

    return await this.saveDynamicConnectedAccount(
      userId,
      tokenInfo,
      { merchantId, outletName, serverKey, clientKey },
      {
        accountName: input.accountName?.trim() || outletName,
        authType: 'OTP',
        loginIdentifier: 'PHONE_OTP',
        customMinAmount: input.customMinAmount,
        customMaxAmount: input.customMaxAmount,
      }
    );
  }
}
