import crypto from 'crypto';

export interface GoBizTokenInfo {
  accessToken: string;
  refreshToken: string;
  tokenType?: string;
  expiresIn?: number;
}

export interface GoBizOtpRequestResult {
  otpToken: string;
  otpExpiresIn: number;
  otpLength: number;
  uniqueId: string;
}

export interface GoBizMerchantProfile {
  merchantId: string;
  outletName: string;
  outletAddress?: string;
  phone?: string;
  kycStatus?: string;
  bankName?: string;
  accountNo?: string;
  accountName?: string;
  rawMerchant?: any;
}

export class GoBizClient {
  private static readonly BASE_URL = 'https://api.gobiz.co.id';

  private static getHeaders(uniqueId?: string): Record<string, string> {
    return {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'X-Appid': 'go-biz-web-dashboard',
      'X-Appversion': 'platform-v3.98.1-bf97ae9c',
      'X-Deviceos': 'Web',
      'X-Phonemake': 'Windows 10 64-bit',
      'X-Phonemodel': 'Chrome/120.0.0.0',
      'X-Platform': 'Web',
      'X-User-Locale': 'en-US',
      'X-User-Type': 'merchant',
      'Gojek-Country-Code': 'ID',
      'Gojek-Timezone': 'Asia/Jakarta',
      'Authentication-Type': 'go-id',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'X-Uniqueid': uniqueId || crypto.randomUUID(),
    };
  }

  /**
   * Request OTP via SMS to registered GoBiz phone number
   */
  static async requestOtp(phoneNumber: string): Promise<GoBizOtpRequestResult> {
    const uniqueId = crypto.randomUUID();

    // Normalize phone number (remove +62, 62, 0, spaces)
    let phone = phoneNumber.replace(/[\s+-]/g, '');
    if (phone.startsWith('62')) phone = phone.slice(2);
    else if (phone.startsWith('0')) phone = phone.slice(1);

    const headers = this.getHeaders(uniqueId);

    const response = await fetch(`${this.BASE_URL}/goid/login/request`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        client_id: 'go-biz-web-new',
        phone_number: phone,
        country_code: '62',
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GoBiz OTP Request Failed: ${response.status} ${text}`);
    }

    const result = (await response.json()) as any;

    if (!result.success || !result.data?.otp_token) {
      const msg = result.errors?.[0]?.message || 'Failed to request OTP from GoBiz';
      throw new Error(msg);
    }

    return {
      otpToken: result.data.otp_token,
      otpExpiresIn: result.data.otp_expires_in || 720,
      otpLength: result.data.otp_length || 4,
      uniqueId, // Paired UUID for verifyOTP
    };
  }

  /**
   * Verify OTP and obtain access_token and refresh_token
   */
  static async verifyOtp(otpToken: string, otp: string, uniqueId: string): Promise<GoBizTokenInfo> {
    const headers = this.getHeaders(uniqueId);

    const response = await fetch(`${this.BASE_URL}/goid/token`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        client_id: 'go-biz-web-new',
        grant_type: 'otp',
        data: {
          otp: otp.trim(),
          otp_token: otpToken.trim(),
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      let errorMsg = `GoBiz OTP Verify Failed: ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed.errors?.[0]?.message) {
          errorMsg = parsed.errors[0].message;
        }
      } catch {}
      throw new Error(errorMsg);
    }

    const data = (await response.json()) as any;

    if (!data.access_token) {
      throw new Error('OTP verified but no access_token returned by GoBiz');
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || '',
      tokenType: data.token_type,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Login directly with GoBiz registered Email & Password
   */
  static async loginWithPassword(email: string, password: string): Promise<GoBizTokenInfo> {
    const uniqueId = crypto.randomUUID();
    const headers = this.getHeaders(uniqueId);

    // Step 1: Initiate Password Login
    const step1Res = await fetch(`${this.BASE_URL}/goid/login/request`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        client_id: 'go-biz-web-new',
        email: email.trim().toLowerCase(),
        login_type: 'password',
      }),
    });

    if (!step1Res.ok) {
      const text = await step1Res.text();
      throw new Error(`GoBiz Login Step 1 Failed: ${step1Res.status} ${text}`);
    }

    // Step 2: Request Token
    const step2Res = await fetch(`${this.BASE_URL}/goid/token`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        client_id: 'go-biz-web-new',
        grant_type: 'password',
        data: {
          email: email.trim().toLowerCase(),
          password,
        },
      }),
    });

    if (!step2Res.ok) {
      const text = await step2Res.text();
      let errorMsg = `GoBiz Login Failed: ${step2Res.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed.errors?.[0]?.message) {
          errorMsg = parsed.errors[0].message;
        }
      } catch {}
      throw new Error(errorMsg);
    }

    const data = (await step2Res.json()) as any;

    if (!data.access_token) {
      throw new Error('GoBiz login succeeded but no access_token found in response');
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || '',
      tokenType: data.token_type,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Refresh access token using refresh token
   */
  static async refreshAccessToken(refreshToken: string): Promise<GoBizTokenInfo> {
    const headers = this.getHeaders();

    const response = await fetch(`${this.BASE_URL}/goid/token`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        client_id: 'go-biz-web-new',
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GoBiz Token Refresh Failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as any;

    if (!data.access_token) {
      throw new Error('Refresh succeeded but no access_token found');
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      tokenType: data.token_type,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Get user and merchant configuration
   */
  static async getMerchantProfile(accessToken: string): Promise<GoBizMerchantProfile> {
    const headers = {
      ...this.getHeaders(),
      'Authorization': `Bearer ${accessToken}`,
      'x-tencent': 'true',
    };

    const response = await fetch(`${this.BASE_URL}/goresto/v5/public/users/config`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GoBiz Config Request Failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as any;
    const m = data.merchant || {};

    return {
      merchantId: m.id || 'UNKNOWN_MERCHANT',
      outletName: m.outlet_name || 'My GoBiz Store',
      outletAddress: m.outlet_address || '',
      phone: m.phone || '',
      kycStatus: m.kyc_status || 'unknown',
      bankName: m.bank_account?.bank_name,
      accountNo: m.bank_account?.account_no,
      accountName: m.bank_account?.account_name,
      rawMerchant: m,
    };
  }
}
