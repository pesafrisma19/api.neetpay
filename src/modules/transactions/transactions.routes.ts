import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { TransactionService } from './transactions.service.js';
import { requireApiKey } from '../../middleware/api-key.middleware.js';
import { successResponse, errorResponse } from '../../lib/response.js';
import type { AppEnv } from '../../types/hono.js';

export const transactionsRouter = new Hono<AppEnv>();
export const publicPayRouter = new Hono<AppEnv>();

export const createTransactionSchema = z.object({
  orderId: z.string().min(1, 'orderId is required').max(100, 'orderId is too long'),
  amount: z.number().positive('amount must be a positive number').min(1000, 'Minimum amount is Rp 1.000'),
  paymentAccountId: z.string().optional(),
  customerName: z.string().max(100).optional(),
  customerEmail: z.string().email().optional(),
  metadata: z.record(z.any()).optional(),
});

/**
 * Public Route: Proxy QRIS image directly from internal provider URL without redirect (SSRF Protected)
 * GET /v1/transactions/:reference/qr.png
 */
transactionsRouter.get('/:reference/qr.png', async (c) => {
  const reference = c.req.param('reference');

  const trx = await prisma.transaction.findFirst({
    where: {
      merchantTradeNo: reference,
    },
    select: {
      id: true,
      qrisUrl: true,
    },
  });

  if (!trx || !trx.qrisUrl) {
    return c.text('QR image not found', 404);
  }

  // Strict SSRF Guard
  let targetUrl: URL;
  try {
    targetUrl = new URL(trx.qrisUrl);
  } catch {
    return c.text('Invalid QR image configuration', 500);
  }

  // 1. Enforce HTTPS only
  if (targetUrl.protocol !== 'https:') {
    return c.text('Insecure image URL rejected', 400);
  }

  // 2. Strict Whitelist of allowed provider image hostnames
  const ALLOWED_HOSTNAMES = ['api.midtrans.com', 'app.midtrans.com'];
  if (!ALLOWED_HOSTNAMES.includes(targetUrl.hostname)) {
    return c.text('Unauthorized image host', 403);
  }

  // 3. Fetch server-side with timeout & no arbitrary redirect follow
  try {
    const res = await fetch(targetUrl.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'NeetPay-Gateway/1.0',
        'Accept': 'image/png,image/jpeg,image/*,*/*',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return c.text(`Provider image error: ${res.status}`, 502);
    }

    const contentType = res.headers.get('content-type') || 'image/png';
    if (!contentType.startsWith('image/')) {
      return c.text('Invalid content type from provider', 502);
    }

    const imageBuffer = await res.arrayBuffer();

    return c.body(imageBuffer, 200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
  } catch {
    return c.text('Failed to retrieve QR image', 502);
  }
});

/**
 * Public Merchant API: Create Dynamic QRIS Transaction
 * POST /v1/transactions
 */
transactionsRouter.post('/', requireApiKey, async (c) => {
  const merchantUser = c.get('merchantUser');
  const body = await c.req.json();
  const parsed = createTransactionSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      errorResponse('VALIDATION_ERROR', 'Input validation failed', parsed.error.flatten()),
      400
    );
  }

  try {
    const transaction = await TransactionService.createTransaction(
      merchantUser.id,
      parsed.data
    );
    return c.json(
      successResponse(transaction, 'Transaction created successfully'),
      201
    );
  } catch (err: any) {
    const msg = err.message || 'Failed to create transaction';

    if (msg === 'DYNAMIC_ACCESS_REQUIRED') {
      return c.json(
        errorResponse(
          'DYNAMIC_ACCESS_REQUIRED',
          'GoPay Merchant Dynamic memerlukan aktivasi add-on Rp500.000 sekali bayar.'
        ),
        403
      );
    }

    if (msg === 'MONTHLY_LIMIT_EXCEEDED') {
      return c.json(
        errorResponse(
          'MONTHLY_LIMIT_EXCEEDED',
          'You have reached your monthly transaction limit for your current subscription plan. Please upgrade to Pro for unlimited transactions.'
        ),
        403
      );
    }

    if (msg === 'NO_ACTIVE_PAYMENT_ACCOUNT') {
      return c.json(
        errorResponse(
          'NO_ACTIVE_PAYMENT_ACCOUNT',
          'No active payment account found. Please connect your GoBiz account in the NeetPay dashboard.'
        ),
        400
      );
    }

    if (msg === 'BASE_QRIS_NOT_FOUND') {
      return c.json(
        errorResponse(
          'BASE_QRIS_NOT_FOUND',
          'Connected payment account does not have a valid Base QRIS configured.'
        ),
        400
      );
    }

    if (msg === 'DUPLICATE_PENDING_ORDER') {
      return c.json(
        errorResponse(
          'DUPLICATE_PENDING_ORDER',
          `An active pending transaction already exists with orderId "${parsed.data.orderId}".`
        ),
        409
      );
    }

    if (msg === 'DUPLICATE_PENDING_AMOUNT') {
      return c.json(
        errorResponse(
          'DUPLICATE_PENDING_AMOUNT',
          'An active pending transaction with the same payment amount already exists for this payment account. Please retry after payment is completed or expired, or enable unique codes on the Payment Account.'
        ),
        409
      );
    }

    if (msg.startsWith('AMOUNT_OUT_OF_RANGE')) {
      return c.json(errorResponse('AMOUNT_OUT_OF_RANGE', msg), 400);
    }

    return c.json(errorResponse('CREATE_TRANSACTION_FAILED', msg), 400);
  }
});

/**
 * Public Merchant API: Get Transaction Status & Details
 * GET /v1/transactions/:id
 */
transactionsRouter.get('/:id', requireApiKey, async (c) => {
  const merchantUser = c.get('merchantUser');
  const identifier = c.req.param('id');

  try {
    const transaction = await TransactionService.getTransaction(
      merchantUser.id,
      identifier
    );
    return c.json(
      successResponse(transaction, 'Transaction details retrieved')
    );
  } catch (err: any) {
    if (err.message === 'TRANSACTION_NOT_FOUND') {
      return c.json(
        errorResponse('TRANSACTION_NOT_FOUND', 'Transaction not found with the provided identifier.'),
        404
      );
    }
    return c.json(
      errorResponse('GET_TRANSACTION_FAILED', err.message || 'Failed to retrieve transaction'),
      500
    );
  }
});

/**
 * Public Checkout Route: Get minimal safe payment details for hosted /pay/:reference
 * GET /v1/pay/:reference
 */
publicPayRouter.get('/:reference', async (c) => {
  const reference = c.req.param('reference');

  const trx = await prisma.transaction.findFirst({
    where: {
      merchantTradeNo: reference,
    },
    include: {
      user: {
        select: {
          name: true,
        },
      },
      paymentAccount: {
        include: {
          goBizAccount: {
            select: {
              outletName: true,
              merchantName: true,
            },
          },
        },
      },
    },
  });

  if (!trx) {
    return c.json(
      errorResponse('TRANSACTION_NOT_FOUND', 'Transaction not found with the provided identifier.'),
      404
    );
  }

  const publicQrUrl = trx.qrisUrl
    ? `https://api.neetpay.web.id/v1/transactions/${trx.merchantTradeNo}/qr.png`
    : null;

  let safeDeeplinkUrl: string | null = null;
  const rawDeeplink = (trx.metadata as any)?.deeplinkUrl;
  if (typeof rawDeeplink === 'string' && rawDeeplink.trim()) {
    const trimmed = rawDeeplink.trim();
    if (trimmed.startsWith('gojek://') || trimmed.startsWith('gopay://')) {
      safeDeeplinkUrl = trimmed;
    } else {
      try {
        const parsed = new URL(trimmed);
        if (!['app.midtrans.com', 'api.midtrans.com'].includes(parsed.hostname)) {
          safeDeeplinkUrl = trimmed;
        }
      } catch {
        // Invalid URL safely rejected
      }
    }
  }

  return c.json(
    successResponse(
      {
        reference: trx.merchantTradeNo,
        merchant_name: trx.user?.name || 'NeetPay Merchant',
        outlet_name: trx.paymentAccount?.goBizAccount?.outletName || trx.paymentAccount?.name || 'QRIS Outlet',
        amount: Number(trx.amount),
        fee_amount: Number(trx.feeAmount),
        total_amount: Number(trx.totalAmount),
        status: trx.status,
        qris_url: publicQrUrl,
        deeplink_url: safeDeeplinkUrl,
        created_at: trx.createdAt.toISOString(),
        expires_at: trx.expiredAt.toISOString(),
        paid_at: trx.paidAt ? trx.paidAt.toISOString() : null,
      },
      'Public checkout details retrieved successfully'
    )
  );
});

