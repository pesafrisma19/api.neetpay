import { prisma } from '../lib/prisma.js';
import { decryptAES } from '../lib/encryption.js';
import { WebhookSecurity } from '../modules/webhooks/webhook.security.js';

export interface DispatchResult {
  processed: number;
  succeeded: number;
  failed: number;
  retried: number;
}

export class WebhookDispatcher {
  /**
   * Retry delays in milliseconds based on attempt count (1-indexed attempt number just finished):
   * Attempt 1 failed -> wait 30 seconds
   * Attempt 2 failed -> wait 2 minutes
   * Attempt 3 failed -> wait 10 minutes
   * Attempt 4 failed -> wait 30 minutes
   * Attempt 5 failed -> FAILED (no more retries)
   */
  public static readonly RETRY_DELAYS_MS = [
    30 * 1000,        // After attempt 1 -> retry in 30s
    2 * 60 * 1000,    // After attempt 2 -> retry in 2m
    10 * 60 * 1000,   // After attempt 3 -> retry in 10m
    30 * 60 * 1000,   // After attempt 4 -> retry in 30m
  ];

  public static readonly MAX_ATTEMPTS = 5;
  public static readonly TIMEOUT_MS = 10000;

  /**
   * Processes all pending WebhookDeliveries due for dispatch
   */
  public static async processPendingDeliveries(
    options: { allowLocalhost?: boolean } = {}
  ): Promise<DispatchResult> {
    const result: DispatchResult = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      retried: 0,
    };

    const now = new Date();

    // Fetch batch of pending deliveries due for dispatch
    const pendingDeliveries = await prisma.webhookDelivery.findMany({
      where: {
        status: 'PENDING',
        attemptsCount: { lt: this.MAX_ATTEMPTS },
        OR: [
          { nextRetryAt: null },
          { nextRetryAt: { lte: now } },
        ],
      },
      include: {
        user: {
          include: { webhookConfig: true },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    if (pendingDeliveries.length === 0) {
      return result;
    }

    const allowLocalhost =
      options.allowLocalhost ||
      process.env.NODE_ENV === 'test' ||
      process.env.ALLOW_LOCAL_WEBHOOK === 'true';

    for (const delivery of pendingDeliveries) {
      result.processed++;
      const config = delivery.user.webhookConfig;

      // 1. If user disabled or deleted webhook config, mark delivery as FAILED
      if (!config || !config.isEnabled || !config.url) {
        await prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'FAILED', nextRetryAt: null },
        });
        result.failed++;
        continue;
      }

      // 2. Prepare Payload, Headers, and Signature
      let rawSecret = '';
      try {
        rawSecret = decryptAES(config.secretKey);
      } catch {
        rawSecret = config.secretKey;
      }

      const rawBody = JSON.stringify(delivery.payload);
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = WebhookSecurity.computeSignature(rawSecret, timestamp, rawBody);

      const attemptNumber = delivery.attemptsCount + 1;
      const startTime = Date.now();

      let httpStatus: number | null = null;
      let responseBody: string | null = null;
      let errorMessage: string | null = null;
      let isSuccess = false;

      // 3. Dispatch HTTP POST with safe redirect handling & SSRF protection
      try {
        const response = await WebhookSecurity.safeDispatch(config.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'User-Agent': 'NeetPay-Webhook/1.0',
            'X-NeetPay-Signature': signature,
            'X-NeetPay-Timestamp': timestamp.toString(),
            'X-NeetPay-Event': delivery.event,
            'X-NeetPay-Delivery-Id': delivery.id,
          },
          body: rawBody,
          timeoutMs: this.TIMEOUT_MS,
          allowLocalhost,
        });

        httpStatus = response.status;
        const text = await response.text();
        responseBody = text ? text.slice(0, 2000) : null;

        // HTTP 200-299 is considered SUCCESS (including 200, 201, 204)
        if (httpStatus >= 200 && httpStatus <= 299) {
          isSuccess = true;
        } else {
          errorMessage = `HTTP error status ${httpStatus}`;
        }
      } catch (err: any) {
        if (err.name === 'AbortError') {
          errorMessage = `Request timed out after ${this.TIMEOUT_MS}ms`;
        } else {
          errorMessage = err.message || 'Unknown network error';
        }
      }

      const durationMs = Date.now() - startTime;

      // 4. Update Database Records
      if (isSuccess) {
        await prisma.$transaction([
          prisma.webhookAttempt.create({
            data: {
              webhookDeliveryId: delivery.id,
              attempt: attemptNumber,
              httpStatus,
              responseBody,
              durationMs,
            },
          }),
          prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: {
              status: 'SUCCESS',
              attemptsCount: attemptNumber,
              nextRetryAt: null,
            },
          }),
        ]);
        result.succeeded++;
      } else {
        const hasMoreAttempts = attemptNumber < this.MAX_ATTEMPTS;
        const nextDelay = hasMoreAttempts
          ? this.RETRY_DELAYS_MS[attemptNumber - 1] || 30 * 60 * 1000
          : null;
        const nextRetryAt = nextDelay ? new Date(Date.now() + nextDelay) : null;

        await prisma.$transaction([
          prisma.webhookAttempt.create({
            data: {
              webhookDeliveryId: delivery.id,
              attempt: attemptNumber,
              httpStatus,
              responseBody,
              error: errorMessage,
              durationMs,
            },
          }),
          prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: {
              status: hasMoreAttempts ? 'PENDING' : 'FAILED',
              attemptsCount: attemptNumber,
              nextRetryAt,
            },
          }),
        ]);

        if (hasMoreAttempts) {
          result.retried++;
        } else {
          result.failed++;
        }
      }
    }

    return result;
  }
}
