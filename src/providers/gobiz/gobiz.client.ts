import crypto from 'crypto';

export interface GoBizTokenInfo {
  accessToken: string;
  refreshToken: string;
  tokenType?: string;
  expiresIn?: number;
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

export interface GoBizJournalItem {
  id: string; // Journal ID / External Mutation ID (providerRefId)
  transactionId?: string;
  amount: number; // Gross nominal in IDR
  type: 'CREDIT' | 'DEBIT';
  paymentMethod?: string;
  status?: string;
  createdAt: Date; // metadata.transaction.transaction_time
  customerName?: string;
  rawJournal?: any;
}

export class GoBizClient {
  private static BASE_URL = 'https://api.gobiz.co.id';
  private static PORTAL_URL = 'https://portal.gofoodmerchant.co.id';

  private static getHeaders(extraHeaders: Record<string, string> = {}) {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'X-Appid': 'go-biz-web-dashboard',
      'X-Appversion': 'platform-v3.98.1-bf97ae9c',
      'X-Deviceos': 'web',
      'X-Platform': 'Web',
      'X-User-Type': 'merchant',
      'X-Uniqueid': crypto.randomUUID(),
      ...extraHeaders,
    };
  }

  /**
   * Request 4-digit SMS OTP from GoBiz
   */
  static async requestOtp(phoneNumber: string): Promise<{ otpToken: string; uniqueId: string }> {
    let cleanPhone = phoneNumber.trim().replace(/^0/, '62').replace(/^\+/, '');
    if (!cleanPhone.startsWith('62')) {
      cleanPhone = `62${cleanPhone}`;
    }

    const headers = this.getHeaders();
    const response = await fetch(`${this.BASE_URL}/goid/otp/request`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        client_id: 'go-biz-web-new',
        phone_number: cleanPhone,
        country_code: 'ID',
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      let errorMsg = `GoBiz OTP Request Failed: ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed.errors?.[0]?.message) {
          errorMsg = parsed.errors[0].message;
        }
      } catch {}
      throw new Error(errorMsg);
    }

    const data = (await response.json()) as any;
    const otpToken = data.otp_token || data.data?.otp_token;
    const uniqueId = data.unique_id || data.data?.unique_id || crypto.randomUUID();

    if (!otpToken) {
      throw new Error('GoBiz did not return otp_token');
    }

    return { otpToken, uniqueId };
  }

  /**
   * Verify 4-digit SMS OTP and receive initial Access & Refresh Tokens
   */
  static async verifyOtp(otpToken: string, otp: string, uniqueId: string): Promise<GoBizTokenInfo> {
    const headers = this.getHeaders();
    const response = await fetch(`${this.BASE_URL}/goid/token`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        client_id: 'go-biz-web-new',
        grant_type: 'otp',
        otp,
        otp_token: otpToken,
        unique_id: uniqueId,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      let errorMsg = `GoBiz OTP Verification Failed: ${response.status}`;
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
      throw new Error('GoBiz did not return access_token');
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || '',
      tokenType: data.token_type,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Direct Login using GoBiz Email & Password (2-Step OAuth Flow)
   */
  static async loginWithPassword(email: string, password: string): Promise<GoBizTokenInfo> {
    const headers = this.getHeaders();

    // Step 1: Login Request
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
      let errorMsg = `GoBiz Login Failed: ${step1Res.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed.errors?.[0]?.message) {
          errorMsg = parsed.errors[0].message;
        }
      } catch {}
      throw new Error(errorMsg);
    }

    const step1Data = (await step1Res.json()) as any;

    if (step1Data.access_token) {
      return {
        accessToken: step1Data.access_token,
        refreshToken: step1Data.refresh_token || '',
        tokenType: step1Data.token_type,
        expiresIn: step1Data.expires_in,
      };
    }

    // Step 2: Request token via password grant
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

  /**
   * Fetch recent credit mutations from GoBiz (Endpoint: POST https://api.gobiz.co.id/journals/search)
   */
  static async fetchJournals(
    accessToken: string,
    merchantId: string,
    options?: { startTime?: Date; endTime?: Date; pageSize?: number }
  ): Promise<GoBizJournalItem[]> {
    const startTime = options?.startTime || new Date(Date.now() - 3600000);
    const endTime = options?.endTime || new Date();

    const payload = {
      from: 0,
      size: options?.pageSize || 50,
      sort: { time: { order: 'desc' } },
      included_categories: { incoming: ['transaction_share', 'action'] },
      query: [
        {
          op: 'and',
          clauses: [
            {
              field: 'metadata.transaction.status',
              op: 'in',
              value: ['settlement', 'capture'],
            },
            {
              field: 'metadata.transaction.transaction_time',
              op: 'gte',
              value: startTime.toISOString(),
            },
            {
              field: 'metadata.transaction.transaction_time',
              op: 'lte',
              value: endTime.toISOString(),
            },
            ...(merchantId
              ? [
                  {
                    field: 'metadata.transaction.merchant_id',
                    op: 'equal',
                    value: merchantId,
                  },
                ]
              : []),
          ],
        },
      ],
    };

    const response = await fetch(`${this.BASE_URL}/journals/search`, {
      method: 'POST',
      headers: {
        'Host': 'api.gobiz.co.id',
        'Accept': 'application/json, text/plain, */*, application/vnd.journal.v1+json',
        'Content-Type': 'application/json; charset=utf-8',
        'authentication-type': 'go-id',
        'Origin': 'https://portal.gofoodmerchant.co.id',
        'Referer': 'https://portal.gofoodmerchant.co.id/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GoBiz Journals Search Failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as any;
    const hits = data.hits || [];

    return (Array.isArray(hits) ? hits : [])
      .map((hit: any) => {
        const tx = hit.metadata?.transaction || {};

        // Explicit Minor Unit Normalization:
        // GoBiz metadata.transaction.gross_amount is defined in minor units (cents)
        // e.g. 5003700 -> Rp 50.037 (gross_amount / 100)
        let normalizedAmount = 0;
        if (typeof tx.gross_amount === 'number' && tx.gross_amount > 0) {
          normalizedAmount = tx.gross_amount / 100;
        } else if (typeof hit.amount === 'number' && hit.amount > 0) {
          normalizedAmount = hit.amount;
        }

        // External Mutation / Journal ID
        const externalId = String(hit.id || tx.id || tx.order_ref_id || tx.transaction_id || crypto.randomUUID());

        // Timestamp: metadata.transaction.transaction_time
        const txTime = tx.transaction_time || hit.time || hit.created_at || new Date().toISOString();
        const paymentType = tx.payment_type ? String(tx.payment_type).toUpperCase() : (tx.payment_method ? String(tx.payment_method).toUpperCase() : '');
        const rawStatus = (tx.status || hit.status || '').toUpperCase();

        return {
          id: externalId,
          transactionId: tx.order_ref_id || tx.id || tx.transaction_id || undefined,
          amount: normalizedAmount,
          type: 'CREDIT' as const,
          paymentMethod: paymentType,
          status: rawStatus,
          createdAt: new Date(txTime),
          customerName: tx.customer_name || 'Guest',
          rawJournal: {
            hitId: hit.id,
            orderRefId: tx.order_ref_id || null,
            transactionId: tx.id || null,
            grossAmount: tx.gross_amount ?? hit.amount ?? null,
            normalizedAmount,
            transactionTime: txTime,
            status: tx.status || hit.status || null,
            paymentType: tx.payment_type || null,
          },
        };
      })
      .filter((item) => {
        // Strict Eligibility Filter:
        // 1. Must be QRIS
        // 2. Must be settled / captured / success
        // 3. Amount > 0
        const isQris = item.paymentMethod === 'QRIS';
        const isSuccess = ['SETTLEMENT', 'CAPTURE', 'SUCCESS'].includes(item.status);
        return isQris && isSuccess && item.amount > 0;
      });
  }

  /**
   * Automatically fetch static QRIS string (aspi_qr_string) from GoBiz Merchant Portal
   */
  static async fetchQrisStringFromPortal(accessToken: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.PORTAL_URL}/id/dashboard`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Cookie': `access_token=${accessToken}; selected_country=ID; language=id`,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        },
      });

      if (!response.ok) return null;

      const html = await response.text();

      // Extract aspi_qr_string
      const aspiMatch = html.match(/aspi_qr_string\\*"\s*:\s*\\*"([^\\"]+)/);
      if (aspiMatch && aspiMatch[1]?.startsWith('00020101')) {
        return aspiMatch[1];
      }

      // Fallback: search for EMVCo 00020101 pattern
      const emvcoMatch = html.match(/(00020101[A-Za-z0-9\s\\,&_-]+?6304[A-Za-z0-9]{4})/);
      if (emvcoMatch && emvcoMatch[1]) {
        return emvcoMatch[1];
      }

      return null;
    } catch {
      return null;
    }
  }
}
