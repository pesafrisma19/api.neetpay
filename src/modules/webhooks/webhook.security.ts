import crypto from 'crypto';
import net from 'net';
import dns from 'dns';

export class WebhookSecurity {
  /**
   * Generates a standard NeetPay webhook secret: whsec_<32 hex chars>
   */
  public static generateSecret(): string {
    const randomHex = crypto.randomBytes(16).toString('hex');
    return `whsec_${randomHex}`;
  }

  /**
   * Masks a webhook secret for safe display on dashboard: whsec_••••••••••••1234
   */
  public static maskSecret(secret: string): string {
    if (!secret || secret.length < 10) return 'whsec_••••••••';
    const suffix = secret.slice(-4);
    return `whsec_${'•'.repeat(Math.max(8, secret.length - 10))}${suffix}`;
  }

  /**
   * Computes HMAC-SHA256 signature for a webhook payload
   * Format: HMAC_SHA256(secret, `${timestamp}.${rawBody}`)
   */
  public static computeSignature(secret: string, timestamp: number, rawBody: string): string {
    const payloadToSign = `${timestamp}.${rawBody}`;
    return crypto.createHmac('sha256', secret).update(payloadToSign).digest('hex');
  }

  /**
   * Verifies HMAC-SHA256 signature using timing-safe equality
   */
  public static verifySignature(
    secret: string,
    timestamp: number,
    rawBody: string,
    providedSignature: string
  ): boolean {
    const expectedSignature = this.computeSignature(secret, timestamp, rawBody);
    if (expectedSignature.length !== providedSignature.length) {
      return false;
    }
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'utf8'),
      Buffer.from(providedSignature, 'utf8')
    );
  }

  /**
   * Determines if an IP string is a private, loopback, link-local, or cloud metadata address
   */
  public static isPrivateOrInternalIp(ip: string): boolean {
    const cleanIp = ip.replace(/^\[|\]$/g, '').toLowerCase();

    // Check IPv4-mapped IPv6 e.g. ::ffff:127.0.0.1
    if (cleanIp.startsWith('::ffff:')) {
      const v4Part = cleanIp.slice(7);
      if (net.isIPv4(v4Part)) {
        return this.isPrivateOrInternalIp(v4Part);
      }
    }

    const ipType = net.isIP(cleanIp);
    if (ipType === 4) {
      const parts = cleanIp.split('.').map((p) => parseInt(p, 10));
      const [a, b] = parts;

      // Loopback (127.0.0.0/8 & 0.0.0.0/8)
      if (a === 127 || a === 0) return true;

      // Private Network Class A (10.0.0.0/8)
      if (a === 10) return true;

      // Private Network Class B (172.16.0.0/12: 172.16 - 172.31)
      if (a === 172 && b >= 16 && b <= 31) return true;

      // Private Network Class C (192.168.0.0/16)
      if (a === 192 && b === 168) return true;

      // Link-local / Cloud Metadata (169.254.0.0/16)
      if (a === 169 && b === 254) return true;

      // Carrier-grade NAT (100.64.0.0/10: 100.64 - 100.127)
      if (a === 100 && b >= 64 && b <= 127) return true;

      // Multicast (224.0.0.0/4) & Reserved (240.0.0.0/4)
      if (a >= 224) return true;

      return false;
    } else if (ipType === 6) {
      // IPv6 Loopback (::1) & Unspecified (::)
      if (cleanIp === '::1' || cleanIp === '::') return true;

      // IPv6 Unique Local Address (fc00::/7 -> fc.. or fd..)
      if (cleanIp.startsWith('fc') || cleanIp.startsWith('fd')) return true;

      // IPv6 Link-local (fe80::/10)
      if (cleanIp.startsWith('fe80:') || cleanIp.startsWith('fe8') || cleanIp.startsWith('fe9') || cleanIp.startsWith('fea') || cleanIp.startsWith('feb')) return true;

      return false;
    }

    return false;
  }

  /**
   * SSRF Protection: Validates URL syntax and static hostname / IP rules
   */
  public static validateUrl(
    urlString: string,
    options: { allowLocalhost?: boolean } = {}
  ): { isValid: boolean; error?: string; parsed?: URL } {
    try {
      const parsed = new URL(urlString);

      // 1. Protocol check
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { isValid: false, error: 'URL must use http or https protocol.' };
      }

      let hostname = parsed.hostname.toLowerCase();
      // Strip IPv6 brackets if present e.g. "[::1]" -> "::1"
      if (hostname.startsWith('[') && hostname.endsWith(']')) {
        hostname = hostname.slice(1, -1);
      }

      // If testing flag is explicitly allowed, only permit loopback (localhost / 127.0.0.1 / ::1)
      const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
      if (options.allowLocalhost && isLoopback) {
        return { isValid: true, parsed };
      }

      // 2. Reject localhost and obvious internal domain names
      if (
        hostname === 'localhost' ||
        hostname === '::1' ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.internal') ||
        hostname === 'metadata.google.internal'
      ) {
        return { isValid: false, error: 'Internal/localhost URLs are not permitted (SSRF protection).' };
      }

      // 3. IP address inspection (literal IPv4 & IPv6)
      if (this.isPrivateOrInternalIp(hostname)) {
        return { isValid: false, error: 'Private, loopback, or cloud metadata IP addresses are not permitted.' };
      }

      return { isValid: true, parsed };
    } catch {
      return { isValid: false, error: 'Invalid URL format.' };
    }
  }

  /**
   * SSRF Protection with DNS Resolution: Resolves hostname and validates all resolved IPs
   */
  public static async resolveAndValidateUrl(
    urlString: string,
    options: { allowLocalhost?: boolean } = {}
  ): Promise<{ isValid: boolean; error?: string; parsed?: URL }> {
    const staticCheck = this.validateUrl(urlString, options);
    if (!staticCheck.isValid || !staticCheck.parsed) {
      return staticCheck;
    }

    let hostname = staticCheck.parsed.hostname.toLowerCase();
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1);
    }

    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (options.allowLocalhost && isLoopback) {
      return { isValid: true, parsed: staticCheck.parsed };
    }

    // If hostname is already a literal IP, staticCheck already validated it
    if (net.isIP(hostname)) {
      return { isValid: true, parsed: staticCheck.parsed };
    }

    // DNS Resolution check for hostnames
    try {
      const addresses = await dns.promises.lookup(hostname, { all: true });
      for (const addr of addresses) {
        if (this.isPrivateOrInternalIp(addr.address)) {
          return {
            isValid: false,
            error: `SSRF_BLOCK: Hostname '${hostname}' resolved to private/internal IP address (${addr.address}).`,
          };
        }
      }
    } catch (dnsErr: any) {
      return {
        isValid: false,
        error: `DNS resolution failed for hostname '${hostname}': ${dnsErr.message}`,
      };
    }

    return { isValid: true, parsed: staticCheck.parsed };
  }

  /**
   * Safe HTTP Dispatch with SSRF-protected Redirect Handling (Up to maxRedirects)
   */
  public static async safeDispatch(
    initialUrl: string,
    options: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      timeoutMs?: number;
      allowLocalhost?: boolean;
      maxRedirects?: number;
    }
  ): Promise<{
    status: number;
    statusText: string;
    text: () => Promise<string>;
    finalUrl: string;
  }> {
    const maxRedirects = options.maxRedirects ?? 3;
    const timeoutMs = options.timeoutMs ?? 10000;
    let currentUrl = initialUrl;
    let redirectCount = 0;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      while (redirectCount <= maxRedirects) {
        // Validate URL + DNS resolution before each hop
        const validation = await this.resolveAndValidateUrl(currentUrl, {
          allowLocalhost: options.allowLocalhost,
        });

        if (!validation.isValid) {
          throw new Error(validation.error || 'Blocked by SSRF protection');
        }

        const response = await fetch(currentUrl, {
          method: options.method,
          headers: options.headers,
          body: options.body,
          redirect: 'manual', // Do NOT follow redirects automatically
          signal: controller.signal,
        });

        // If redirect status code (301, 302, 303, 307, 308)
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) {
            return {
              status: response.status,
              statusText: response.statusText,
              text: () => response.text(),
              finalUrl: currentUrl,
            };
          }

          redirectCount++;
          if (redirectCount > maxRedirects) {
            throw new Error(`Too many redirects (exceeded limit of ${maxRedirects})`);
          }

          // Resolve relative or absolute redirect URL
          const resolvedTarget = new URL(location, currentUrl).toString();

          // Validate target before following
          const targetCheck = await this.resolveAndValidateUrl(resolvedTarget, {
            allowLocalhost: options.allowLocalhost,
          });

          if (!targetCheck.isValid) {
            throw new Error(`SSRF_BLOCK: Redirect to internal address '${resolvedTarget}' blocked.`);
          }

          currentUrl = resolvedTarget;
          continue;
        }

        return {
          status: response.status,
          statusText: response.statusText,
          text: () => response.text(),
          finalUrl: currentUrl,
        };
      }

      throw new Error(`Exceeded maximum redirect hops of ${maxRedirects}`);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
