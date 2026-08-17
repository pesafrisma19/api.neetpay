import { Hono } from 'hono';
import { z } from 'zod';
import { TransactionService } from './transactions.service.js';
import { requireApiKey } from '../../middleware/api-key.middleware.js';
import { successResponse, errorResponse } from '../../lib/response.js';
import type { AppEnv } from '../../types/hono.js';

export const transactionsRouter = new Hono<AppEnv>();

export const createTransactionSchema = z.object({
  orderId: z.string().min(1, 'orderId is required').max(100, 'orderId is too long'),
  amount: z.number().positive('amount must be a positive number').min(1000, 'Minimum amount is Rp 1.000'),
  paymentAccountId: z.string().optional(),
  customerName: z.string().max(100).optional(),
  customerEmail: z.string().email().optional(),
  metadata: z.record(z.any()).optional(),
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
