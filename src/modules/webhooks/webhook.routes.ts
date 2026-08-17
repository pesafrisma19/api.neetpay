import { Hono } from 'hono';
import { z } from 'zod';
import { WebhookService } from './webhook.service.js';
import { WebhookSecurity } from './webhook.security.js';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { successResponse, errorResponse } from '../../lib/response.js';
import { prisma } from '../../lib/prisma.js';
import { decryptAES } from '../../lib/encryption.js';
import type { AppEnv } from '../../types/hono.js';

export const webhookRouter = new Hono<AppEnv>();

const updateWebhookSchema = z.object({
  url: z.string().min(1, 'Webhook URL is required').url('Invalid URL format'),
  isEnabled: z.boolean().optional(),
});

/**
 * GET /api/webhook
 * Fetch current user's webhook configuration with secret masked
 */
webhookRouter.get('/', requireAuth, async (c) => {
  const user = c.get('user');
  const config = await WebhookService.getConfig(user.id);
  return c.json(successResponse(config));
});

/**
 * PUT /api/webhook
 * Update or initialize webhook URL and enabled status
 */
webhookRouter.put('/', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = updateWebhookSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      errorResponse('VALIDATION_ERROR', 'Input validation failed', parsed.error.flatten()),
      400
    );
  }

  try {
    const result = await WebhookService.updateConfig(user.id, parsed.data);
    return c.json(
      successResponse(
        {
          ...result.config,
          secret: result.rawSecret || undefined,
        },
        result.rawSecret
          ? 'Webhook configured successfully. Save your webhook signing secret now!'
          : 'Webhook configuration updated successfully.'
      )
    );
  } catch (err: any) {
    if (err.message?.startsWith('INVALID_WEBHOOK_URL')) {
      return c.json(errorResponse('INVALID_WEBHOOK_URL', err.message), 400);
    }
    return c.json(errorResponse('INTERNAL_ERROR', err.message || 'Failed to update webhook config'), 500);
  }
});

/**
 * POST /api/webhook/rotate-secret
 * Rotates the signing secret and returns the new raw secret once
 */
webhookRouter.post('/rotate-secret', requireAuth, async (c) => {
  const user = c.get('user');
  const result = await WebhookService.rotateSecret(user.id);
  return c.json(
    successResponse(
      result,
      'New webhook secret generated. Save this secret now as it will not be displayed again.'
    )
  );
});

/**
 * POST /api/webhook/test
 * Sends a test webhook event (webhook.test) to the configured merchant endpoint
 */
webhookRouter.post('/test', requireAuth, async (c) => {
  const user = c.get('user');
  const config = await prisma.webhookConfig.findUnique({
    where: { userId: user.id },
  });

  if (!config || !config.url) {
    return c.json(errorResponse('NO_WEBHOOK_CONFIGURED', 'No webhook URL configured for this account.'), 400);
  }

  if (!config.isEnabled) {
    return c.json(errorResponse('WEBHOOK_DISABLED', 'Webhook is currently disabled for this account.'), 400);
  }

  const allowLocalhost = process.env.NODE_ENV === 'test' || process.env.ALLOW_LOCAL_WEBHOOK === 'true';
  const urlCheck = WebhookSecurity.validateUrl(config.url, { allowLocalhost });
  if (!urlCheck.isValid) {
    return c.json(errorResponse('INVALID_WEBHOOK_URL', urlCheck.error || 'Invalid webhook URL'), 400);
  }

  let rawSecret = '';
  try {
    rawSecret = decryptAES(config.secretKey);
  } catch {
    rawSecret = config.secretKey;
  }

  const payload = WebhookService.buildPayload('webhook.test');
  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);

  // Create WebhookDelivery record
  const delivery = await prisma.webhookDelivery.create({
    data: {
      userId: user.id,
      event: 'webhook.test',
      payload,
      status: 'PENDING',
      attemptsCount: 1,
    },
  });

  const signature = WebhookSecurity.computeSignature(rawSecret, timestamp, rawBody);
  const startTime = Date.now();
  let httpStatus: number | null = null;
  let responseBody: string | null = null;
  let errorMsg: string | null = null;

  try {
    const res = await WebhookSecurity.safeDispatch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'NeetPay-Webhook/1.0',
        'X-NeetPay-Signature': signature,
        'X-NeetPay-Timestamp': timestamp.toString(),
        'X-NeetPay-Event': 'webhook.test',
        'X-NeetPay-Delivery-Id': delivery.id,
      },
      body: rawBody,
      timeoutMs: 10000,
      allowLocalhost,
    });

    httpStatus = res.status;
    const text = await res.text();
    responseBody = text ? text.slice(0, 2000) : null;

    if (httpStatus >= 200 && httpStatus <= 299) {
      await prisma.$transaction([
        prisma.webhookAttempt.create({
          data: {
            webhookDeliveryId: delivery.id,
            attempt: 1,
            httpStatus,
            responseBody,
            durationMs: Date.now() - startTime,
          },
        }),
        prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'SUCCESS' },
        }),
      ]);

      return c.json(
        successResponse({
          deliveryId: delivery.id,
          event: 'webhook.test',
          status: 'SUCCESS',
          httpStatus,
          durationMs: Date.now() - startTime,
          responseBody,
        }, 'Test webhook delivered successfully.')
      );
    } else {
      errorMsg = `Endpoint returned HTTP ${httpStatus}`;
    }
  } catch (err: any) {
    errorMsg = err.name === 'AbortError' ? 'Request timed out after 10000ms' : err.message;
  }

  const durationMs = Date.now() - startTime;
  await prisma.$transaction([
    prisma.webhookAttempt.create({
      data: {
        webhookDeliveryId: delivery.id,
        attempt: 1,
        httpStatus,
        responseBody,
        error: errorMsg,
        durationMs,
      },
    }),
    prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED' },
    }),
  ]);

  return c.json(
    errorResponse('TEST_WEBHOOK_FAILED', `Test webhook delivery failed: ${errorMsg}`, {
      deliveryId: delivery.id,
      httpStatus,
      durationMs,
      error: errorMsg,
    }),
    400
  );
});

/**
 * GET /api/webhook/deliveries
 * Webhook delivery history for merchant dashboard
 */
webhookRouter.get('/deliveries', requireAuth, async (c) => {
  const user = c.get('user');
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '15', 10)));
  const skip = (page - 1) * limit;

  const [total, deliveries] = await Promise.all([
    prisma.webhookDelivery.count({ where: { userId: user.id } }),
    prisma.webhookDelivery.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        transaction: {
          select: {
            merchantTradeNo: true,
            totalAmount: true,
          },
        },
        attempts: {
          orderBy: { attempt: 'asc' },
        },
      },
    }),
  ]);

  const items = deliveries.map((d) => ({
    id: d.id,
    event: d.event,
    status: d.status,
    attemptsCount: d.attemptsCount,
    nextRetryAt: d.nextRetryAt ? d.nextRetryAt.toISOString() : null,
    reference: d.transaction?.merchantTradeNo || (d.payload as any)?.data?.reference || null,
    totalAmount: d.transaction ? Number(d.transaction.totalAmount) : (d.payload as any)?.data?.total_amount || null,
    payload: d.payload,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    attempts: d.attempts.map((a) => ({
      id: a.id,
      attempt: a.attempt,
      httpStatus: a.httpStatus,
      responseBody: a.responseBody,
      error: a.error,
      durationMs: a.durationMs,
      createdAt: a.createdAt.toISOString(),
    })),
  }));

  const totalPages = Math.ceil(total / limit) || 1;

  return c.json(
    successResponse(
      {
        items,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
      'Webhook deliveries history retrieved'
    )
  );
});

