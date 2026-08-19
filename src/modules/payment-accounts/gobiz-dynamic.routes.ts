import { Hono } from 'hono';
import { z } from 'zod';
import { GoBizDynamicService } from './gobiz-dynamic.service.js';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { successResponse, errorResponse } from '../../lib/response.js';
import type { AppEnv } from '../../types/hono.js';

export const goBizDynamicRouter = new Hono<AppEnv>();

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
});

const connectPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
  accountName: z.string().optional(),
  customMinAmount: z.number().positive().optional(),
  customMaxAmount: z.number().positive().optional(),
});

/**
 * Request OTP for GoPay Merchant Dynamic
 * POST /api/payment-accounts/gobiz-dynamic/request-otp
 */
goBizDynamicRouter.post('/request-otp', requireAuth, async (c) => {
  const user = c.get('user');

  if (!user.hasDynamicAccess) {
    return c.json(
      errorResponse(
        'DYNAMIC_ACCESS_REQUIRED',
        'GoPay Merchant Dynamic memerlukan aktivasi add-on Rp500.000 sekali bayar.'
      ),
      403
    );
  }

  const body = await c.req.json();
  const parsed = requestOtpSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      errorResponse('VALIDATION_ERROR', 'Input validation failed', parsed.error.flatten()),
      400
    );
  }

  try {
    const result = await GoBizDynamicService.requestOtp(user.id, parsed.data.phoneNumber);
    return c.json(successResponse(result, 'GoPay Merchant OTP requested successfully. Check your SMS.'));
  } catch (err: any) {
    if (err.message === 'DYNAMIC_ACCESS_REQUIRED') {
      return c.json(
        errorResponse(
          'DYNAMIC_ACCESS_REQUIRED',
          'GoPay Merchant Dynamic memerlukan aktivasi add-on Rp500.000 sekali bayar.'
        ),
        403
      );
    }
    if (err.message === 'ACCOUNT_LIMIT_EXCEEDED') {
      return c.json(
        errorResponse('ACCOUNT_LIMIT_EXCEEDED', 'You have reached the maximum payment account limit for your current subscription plan.'),
        403
      );
    }
    return c.json(errorResponse('GOBIZ_OTP_FAILED', err.message || 'Failed to request GoPay Merchant OTP'), 400);
  }
});

/**
 * Verify OTP and Connect GoPay Merchant Dynamic
 * POST /api/payment-accounts/gobiz-dynamic/verify-otp
 */
goBizDynamicRouter.post('/verify-otp', requireAuth, async (c) => {
  const user = c.get('user');

  if (!user.hasDynamicAccess) {
    return c.json(
      errorResponse(
        'DYNAMIC_ACCESS_REQUIRED',
        'GoPay Merchant Dynamic memerlukan aktivasi add-on Rp500.000 sekali bayar.'
      ),
      403
    );
  }

  const body = await c.req.json();
  const parsed = verifyOtpSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      errorResponse('VALIDATION_ERROR', 'Input validation failed', parsed.error.flatten()),
      400
    );
  }

  try {
    const account = await GoBizDynamicService.verifyOtpAndConnect(user.id, parsed.data);
    return c.json(successResponse(account, 'GoPay Merchant Dynamic account connected successfully via OTP!'), 201);
  } catch (err: any) {
    if (err.message === 'DYNAMIC_ACCESS_REQUIRED') {
      return c.json(
        errorResponse(
          'DYNAMIC_ACCESS_REQUIRED',
          'GoPay Merchant Dynamic memerlukan aktivasi add-on Rp500.000 sekali bayar.'
        ),
        403
      );
    }
    if (err.message === 'ACCOUNT_LIMIT_EXCEEDED') {
      return c.json(
        errorResponse('ACCOUNT_LIMIT_EXCEEDED', 'Payment account limit exceeded for your current plan.'),
        403
      );
    }
    return c.json(errorResponse('GOBIZ_CONNECT_FAILED', err.message || 'Failed to verify and connect GoPay Merchant Dynamic account'), 400);
  }
});

/**
 * Connect GoPay Merchant Dynamic using Email & Password
 * POST /api/payment-accounts/gobiz-dynamic/connect-password
 */
goBizDynamicRouter.post('/connect-password', requireAuth, async (c) => {
  const user = c.get('user');

  if (!user.hasDynamicAccess) {
    return c.json(
      errorResponse(
        'DYNAMIC_ACCESS_REQUIRED',
        'GoPay Merchant Dynamic memerlukan aktivasi add-on Rp500.000 sekali bayar.'
      ),
      403
    );
  }

  const body = await c.req.json();
  const parsed = connectPasswordSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      errorResponse('VALIDATION_ERROR', 'Input validation failed', parsed.error.flatten()),
      400
    );
  }

  try {
    const account = await GoBizDynamicService.connectWithPassword(user.id, parsed.data);
    return c.json(successResponse(account, 'GoPay Merchant Dynamic account connected successfully!'), 201);
  } catch (err: any) {
    if (err.message === 'DYNAMIC_ACCESS_REQUIRED') {
      return c.json(
        errorResponse(
          'DYNAMIC_ACCESS_REQUIRED',
          'GoPay Merchant Dynamic memerlukan aktivasi add-on Rp500.000 sekali bayar.'
        ),
        403
      );
    }
    if (err.message === 'ACCOUNT_LIMIT_EXCEEDED') {
      return c.json(
        errorResponse('ACCOUNT_LIMIT_EXCEEDED', 'Payment account limit exceeded for your current plan. Please upgrade to Pro.'),
        403
      );
    }
    return c.json(errorResponse('GOBIZ_CONNECT_FAILED', err.message || 'Failed to connect GoPay Merchant Dynamic account'), 400);
  }
});

const checkStatusSchema = z.object({
  orderId: z.string().min(1, 'orderId is required'),
});

/**
 * Create Test Dynamic QR (Rp 1.000) for a connected GoPay Dynamic Account
 * POST /api/payment-accounts/gobiz-dynamic/:id/test-qr
 */
goBizDynamicRouter.post('/:id/test-qr', requireAuth, async (c) => {
  const user = c.get('user');
  const accountId = c.req.param('id');

  try {
    const result = await GoBizDynamicService.createTestQr(user.id, accountId);
    return c.json(successResponse(result, 'Test Dynamic QR generated successfully'));
  } catch (err: any) {
    return c.json(
      errorResponse('CREATE_TEST_QR_FAILED', err.message || 'Failed to create test dynamic QR'),
      400
    );
  }
});

/**
 * Check Status of a Test Transaction (NO re-login)
 * POST /api/payment-accounts/gobiz-dynamic/:id/test-status
 */
goBizDynamicRouter.post('/:id/test-status', requireAuth, async (c) => {
  const user = c.get('user');
  const accountId = c.req.param('id');
  const body = await c.req.json();
  const parsed = checkStatusSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      errorResponse('VALIDATION_ERROR', 'Input validation failed', parsed.error.flatten()),
      400
    );
  }

  try {
    const result = await GoBizDynamicService.checkTestStatus(user.id, accountId, parsed.data.orderId);
    return c.json(successResponse(result, 'Test transaction status retrieved'));
  } catch (err: any) {
    return c.json(
      errorResponse('CHECK_TEST_STATUS_FAILED', err.message || 'Failed to check test transaction status'),
      400
    );
  }
});
