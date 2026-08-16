import { Hono } from 'hono';
import { z } from 'zod';
import { PaymentAccountService } from './payment-accounts.service.js';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { successResponse, errorResponse } from '../../lib/response.js';
import type { AppEnv } from '../../types/hono.js';

export const paymentAccountsRouter = new Hono<AppEnv>();

const requestOtpSchema = z.object({
  phoneNumber: z.string().min(8, 'Phone number is required'),
});

const verifyOtpSchema = z.object({
  otpToken: z.string().min(1, 'otpToken is required'),
  otp: z.string().length(4, 'OTP must be 4 digits'),
  uniqueId: z.string().min(1, 'uniqueId is required'),
  accountName: z.string().optional(),
  customMinAmount: z.number().positive().optional(),
  customMaxAmount: z.number().positive().optional(),
  manualQrString: z.string().min(20).optional(),
});

const connectPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
  accountName: z.string().optional(),
  customMinAmount: z.number().positive().optional(),
  customMaxAmount: z.number().positive().optional(),
  manualQrString: z.string().min(20).optional(),
});

/**
 * Request OTP from GoBiz
 * POST /api/payment-accounts/gobiz/request-otp
 */
paymentAccountsRouter.post('/gobiz/request-otp', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = requestOtpSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      errorResponse('VALIDATION_ERROR', 'Input validation failed', parsed.error.flatten()),
      400
    );
  }

  try {
    const result = await PaymentAccountService.requestOtp(user.id, parsed.data.phoneNumber);
    return c.json(successResponse(result, 'GoBiz OTP requested successfully. Check your SMS.'));
  } catch (err: any) {
    if (err.message === 'ACCOUNT_LIMIT_EXCEEDED') {
      return c.json(
        errorResponse('ACCOUNT_LIMIT_EXCEEDED', 'You have reached the maximum payment account limit for your current subscription plan.'),
        403
      );
    }
    return c.json(errorResponse('GOBIZ_OTP_FAILED', err.message || 'Failed to request GoBiz OTP'), 400);
  }
});

/**
 * Verify OTP and Connect GoBiz Account
 * POST /api/payment-accounts/gobiz/verify-otp
 */
paymentAccountsRouter.post('/gobiz/verify-otp', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = verifyOtpSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      errorResponse('VALIDATION_ERROR', 'Input validation failed', parsed.error.flatten()),
      400
    );
  }

  try {
    const account = await PaymentAccountService.verifyOtpAndConnect(user.id, parsed.data);
    return c.json(successResponse(account, 'GoBiz account connected successfully!'), 201);
  } catch (err: any) {
    if (err.message === 'ACCOUNT_LIMIT_EXCEEDED') {
      return c.json(
        errorResponse('ACCOUNT_LIMIT_EXCEEDED', 'Payment account limit exceeded for your current plan.'),
        403
      );
    }
    return c.json(errorResponse('GOBIZ_CONNECT_FAILED', err.message || 'Failed to verify and connect GoBiz account'), 400);
  }
});

/**
 * Direct Connect GoBiz using Email & Password
 * POST /api/payment-accounts/gobiz/connect-password
 */
paymentAccountsRouter.post('/gobiz/connect-password', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = connectPasswordSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      errorResponse('VALIDATION_ERROR', 'Input validation failed', parsed.error.flatten()),
      400
    );
  }

  try {
    const account = await PaymentAccountService.connectWithPassword(user.id, parsed.data);
    return c.json(successResponse(account, 'GoBiz account connected successfully via credentials!'), 201);
  } catch (err: any) {
    if (err.message === 'ACCOUNT_LIMIT_EXCEEDED') {
      return c.json(
        errorResponse('ACCOUNT_LIMIT_EXCEEDED', 'Payment account limit exceeded for your current plan.'),
        403
      );
    }
    return c.json(errorResponse('GOBIZ_CONNECT_FAILED', err.message || 'Failed to login and connect GoBiz account'), 400);
  }
});

/**
 * List Connected Payment Accounts
 * GET /api/payment-accounts
 */
paymentAccountsRouter.get('/', requireAuth, async (c) => {
  const user = c.get('user');
  const accounts = await PaymentAccountService.listAccounts(user.id);
  return c.json(successResponse(accounts, 'Payment accounts retrieved'));
});

/**
 * Disconnect / Deactivate Payment Account
 * DELETE /api/payment-accounts/:id
 */
paymentAccountsRouter.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const accountId = c.req.param('id');

  try {
    const result = await PaymentAccountService.disconnectAccount(user.id, accountId);
    return c.json(successResponse(result, 'Payment account disconnected'));
  } catch (err: any) {
    if (err.message === 'ACCOUNT_NOT_FOUND') {
      return c.json(errorResponse('ACCOUNT_NOT_FOUND', 'Payment account not found.'), 404);
    }
    throw err;
  }
});
