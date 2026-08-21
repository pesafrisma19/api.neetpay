import crypto from 'crypto';
import { prisma } from '../../lib/prisma.js';
import { encryptAES, decryptAES } from '../../lib/encryption.js';
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
   * Verify if user has purchased / been granted GoPay Merchant Dynamic access (Rp 500.000 add-on)
   */
  private static async verifyDynamicAccess(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { hasDynamicAccess: true },
    });

    if (!user) {
      throw new Error('USER_NOT_FOUND');
    }

    if (!user.hasDynamicAccess) {
      throw new Error('DYNAMIC_ACCESS_REQUIRED');
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
    await this.verifyDynamicAccess(userId);
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
    await this.verifyDynamicAccess(userId);
    await this.verifyAccountLimit(userId);
    return await GoBizClient.requestOtp(phoneNumber);
  }

  /**
   * Verify SMS OTP and Connect GoPay Merchant Dynamic
   */
  static async verifyOtpAndConnect(userId: string, input: ConnectDynamicOtpInput) {
    await this.verifyDynamicAccess(userId);
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

  /**
   * Create production hosted checkout for GoPay Merchant Dynamic using stored encrypted credentials (NO re-login)
   */
  static async createHostedCheckout(
    paymentAccount: any,
    params: {
      externalRefNo: string;
      totalAmount: number;
      customerName?: string | null;
      customerEmail?: string | null;
    }
  ): Promise<{
    paymentUrl: string;
    paymentLinkId: string;
    providerOrderId: string;
    qrString: string | null;
    qrisUrl: string | null;
    deeplinkUrl?: string | null;
  }> {
    if (!paymentAccount.goBizAccount?.credentialEncrypted) {
      throw new Error('CREDENTIALS_NOT_FOUND: Please reconnect your GoPay Merchant Dynamic account');
    }

    let serverKey: string;
    try {
      const decrypted = JSON.parse(decryptAES(paymentAccount.goBizAccount.credentialEncrypted));
      serverKey = decrypted.serverKey;
    } catch {
      throw new Error('FAILED_DECRYPT_CREDENTIALS: Stored credentials could not be decrypted');
    }

    if (!serverKey) {
      throw new Error('SERVER_KEY_MISSING: Midtrans Server Key not found in stored credentials');
    }

    const authHeader = `Basic ${Buffer.from(`${serverKey}:`).toString('base64')}`;
    const providerOrderId = params.externalRefNo;

    const customerDetails: any = {
      first_name: params.customerName?.trim() || 'Customer',
    };
    if (params.customerEmail?.trim()) {
      customerDetails.email = params.customerEmail.trim();
    }

    logger.info(
      { paymentAccountId: paymentAccount.id, providerOrderId, amount: params.totalAmount },
      'Creating GoPay Merchant Dynamic hosted checkout'
    );

    const snapRes = await fetch('https://app.midtrans.com/snap/v1/transactions', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': authHeader,
        'X-Override-Notification': 'https://api.neetpay.web.id/api/webhooks/providers/midtrans',
      },
      body: JSON.stringify({
        transaction_details: {
          order_id: providerOrderId,
          gross_amount: params.totalAmount,
        },
        customer_details: customerDetails,
        customer_required: false,
        custom_field1: params.externalRefNo,
        enabled_payments: ['gopay'],
      }),
    });

    if (!snapRes.ok) {
      const errBody = await snapRes.text();
      logger.error({ status: snapRes.status, errBody }, 'Failed to create snap transaction for hosted checkout');
      throw new Error(`HOSTED_CHECKOUT_FAILED: HTTP ${snapRes.status}`);
    }

    const snapData = (await snapRes.json()) as any;

    if (!snapData.token || !snapData.redirect_url) {
      throw new Error('INVALID_GATEWAY_RESPONSE: token or redirect_url missing from snap response');
    }

    // Step 2: Pre-charge to extract EMVCo dynamic qr_string and qris_url
    let qrString: string | null = null;
    let qrisUrl: string | null = null;
    let deeplinkUrl: string | null = null;

    try {
      const chargeRes = await fetch(`https://app.midtrans.com/snap/v2/transactions/${snapData.token}/charge`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payment_type: 'gopay',
        }),
      });

      if (chargeRes.ok) {
        const chargeData = (await chargeRes.json()) as any;
        qrString =
          typeof chargeData.qr_string === 'string' && chargeData.qr_string.trim()
            ? chargeData.qr_string.trim()
            : (chargeData.qr_payload || null);

        qrisUrl =
          typeof chargeData.qr_code_url === 'string' && chargeData.qr_code_url.trim()
            ? chargeData.qr_code_url.trim()
            : (chargeData.qris_url || chargeData.qr_url || null);

        deeplinkUrl =
          typeof chargeData.deeplink_url === 'string' && chargeData.deeplink_url.trim()
            ? chargeData.deeplink_url.trim()
            : (Array.isArray(chargeData.actions)
                ? chargeData.actions.find((a: any) => a.name === 'deeplink-redirect')?.url || null
                : null);

        logger.info(
          {
            providerOrderId,
            hasQrString: !!qrString,
            hasQrisUrl: !!qrisUrl,
            qrisUrl,
            hasDeeplink: !!deeplinkUrl,
          },
          'Snap dynamic QRIS string & image URL pre-charged successfully'
        );
      } else {
        const chargeErr = await chargeRes.text();
        logger.warn(
          { status: chargeRes.status, chargeErr, providerOrderId },
          'Snap pre-charge step returned non-OK, falling back to hosted redirect URL'
        );
      }
    } catch (chargeErr: any) {
      logger.warn(
        { error: chargeErr.message, providerOrderId },
        'Snap pre-charge fetch error, falling back to hosted redirect URL'
      );
    }

    return {
      qrString,
      qrisUrl,
      deeplinkUrl,
      paymentUrl: snapData.redirect_url,
      paymentLinkId: snapData.token || providerOrderId,
      providerOrderId,
    };
  }

  /**
   * Create a single isolated Test Dynamic QR (Rp 1.000) using stored encrypted credentials (NO re-login)
   */
  static async createTestQr(userId: string, paymentAccountId: string) {
    const paymentAccount = await prisma.paymentAccount.findFirst({
      where: {
        id: paymentAccountId,
        userId,
        isActive: true,
      },
      include: {
        provider: true,
        goBizAccount: true,
      },
    });

    if (!paymentAccount) {
      throw new Error('PAYMENT_ACCOUNT_NOT_FOUND');
    }

    if (paymentAccount.provider.code !== 'GOBIZ_DYNAMIC') {
      throw new Error('INVALID_PROVIDER: Test Dynamic QR is only supported for GoPay Merchant Dynamic accounts');
    }

    if (!paymentAccount.goBizAccount?.credentialEncrypted) {
      throw new Error('CREDENTIALS_NOT_FOUND: Please reconnect your GoPay Merchant Dynamic account');
    }

    // Decrypt stored credentials without logging in again
    let serverKey: string;
    try {
      const decrypted = JSON.parse(decryptAES(paymentAccount.goBizAccount.credentialEncrypted));
      serverKey = decrypted.serverKey;
    } catch {
      throw new Error('FAILED_DECRYPT_CREDENTIALS: Stored credentials could not be decrypted');
    }

    if (!serverKey) {
      throw new Error('SERVER_KEY_MISSING: Midtrans Server Key not found in stored credentials');
    }

    const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const testOrderId = `NEET-TEST-${randomSuffix}`;
    const authHeader = `Basic ${Buffer.from(`${serverKey}:`).toString('base64')}`;

    logger.info(
      { userId, paymentAccountId, testOrderId },
      'Creating Test Dynamic QR (Rp 1.000) using Snap pre-charge flow'
    );

    const snapRes = await fetch('https://app.midtrans.com/snap/v1/transactions', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify({
        transaction_details: {
          order_id: testOrderId,
          gross_amount: 1000,
        },
        enabled_payments: ['gopay'],
      }),
    });

    if (!snapRes.ok) {
      const errBody = await snapRes.text();
      logger.error({ status: snapRes.status, errBody }, 'Failed to create test snap transaction');
      throw new Error(`MIDTRANS_CREATE_FAILED: HTTP ${snapRes.status}`);
    }

    const snapData = (await snapRes.json()) as any;
    let qrImage: string | null = null;

    if (snapData.token) {
      try {
        const chargeRes = await fetch(`https://app.midtrans.com/snap/v2/transactions/${snapData.token}/charge`, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            payment_type: 'gopay',
          }),
        });

        if (chargeRes.ok) {
          const chargeData = (await chargeRes.json()) as any;
          const qrCodeUrl =
            (typeof chargeData.qr_code_url === 'string' && chargeData.qr_code_url.trim())
              ? chargeData.qr_code_url.trim()
              : (Array.isArray(chargeData.actions)
                  ? chargeData.actions.find((a: any) => a.name === 'generate-qr-code')?.url
                  : null);

          if (qrCodeUrl) {
            try {
              const parsedUrl = new URL(qrCodeUrl);
              if (parsedUrl.protocol === 'https:' && parsedUrl.hostname === 'api.midtrans.com') {
                const imgRes = await fetch(parsedUrl.toString(), {
                  method: 'GET',
                  headers: {
                    'User-Agent': 'NeetPay-Gateway/1.0',
                    'Accept': 'image/png,image/*,*/*',
                  },
                  redirect: 'error',
                  signal: AbortSignal.timeout(10000),
                });

                if (imgRes.ok) {
                  const contentType = imgRes.headers.get('content-type') || 'image/png';
                  if (contentType.startsWith('image/')) {
                    const imgBuffer = await imgRes.arrayBuffer();
                    const base64Data = Buffer.from(imgBuffer).toString('base64');
                    qrImage = `data:${contentType};base64,${base64Data}`;
                  }
                }
              }
            } catch {
              // Ignore image fetch error safely
            }
          }
        }
      } catch (chargeErr: any) {
        logger.warn({ error: chargeErr.message, testOrderId }, 'Test Snap pre-charge fetch error');
      }
    }

    return {
      testOrderId,
      amount: 1000,
      status: 'PENDING',
      qrImage,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Check status of a test transaction using stored credentials (NO re-login)
   */
  static async checkTestStatus(userId: string, paymentAccountId: string, orderId: string) {
    const paymentAccount = await prisma.paymentAccount.findFirst({
      where: {
        id: paymentAccountId,
        userId,
        isActive: true,
      },
      include: {
        provider: true,
        goBizAccount: true,
      },
    });

    if (!paymentAccount) {
      throw new Error('PAYMENT_ACCOUNT_NOT_FOUND');
    }

    if (!paymentAccount.goBizAccount?.credentialEncrypted) {
      throw new Error('CREDENTIALS_NOT_FOUND');
    }

    let serverKey: string;
    try {
      const decrypted = JSON.parse(decryptAES(paymentAccount.goBizAccount.credentialEncrypted));
      serverKey = decrypted.serverKey;
    } catch {
      throw new Error('FAILED_DECRYPT_CREDENTIALS');
    }

    const authHeader = `Basic ${Buffer.from(`${serverKey}:`).toString('base64')}`;

    // Query Midtrans Status API
    const res = await fetch(`https://api.midtrans.com/v2/${orderId}/status`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': authHeader,
      },
    });

    const data = (await res.json()) as any;

    if (res.status === 404 || data.status_code === '404') {
      return {
        orderId,
        status: 'PENDING',
        rawStatus: 'pending',
        isPaid: false,
        amount: 1000,
      };
    }

    const txStatus = (data.transaction_status || '').toLowerCase();
    let mappedStatus: 'PENDING' | 'PAID' | 'EXPIRED' | 'FAILED' = 'PENDING';
    let isPaid = false;

    if (txStatus === 'settlement' || txStatus === 'capture') {
      mappedStatus = 'PAID';
      isPaid = true;
    } else if (txStatus === 'expire') {
      mappedStatus = 'EXPIRED';
    } else if (txStatus === 'deny' || txStatus === 'cancel') {
      mappedStatus = 'FAILED';
    } else {
      mappedStatus = 'PENDING';
    }

    return {
      orderId,
      transactionId: data.transaction_id || null,
      status: mappedStatus,
      rawStatus: txStatus,
      isPaid,
      amount: data.gross_amount ? Number(data.gross_amount) : 1000,
      paidAt: data.settlement_time || null,
      issuer: data.issuer || data.payment_type || 'gopay',
      acquirer: data.acquirer || 'gopay',
    };
  }
}
