import { Hono } from 'hono';
import { PaymentAccountService } from './payment-accounts.service.js';
import { requireApiKey } from '../../middleware/api-key.middleware.js';
import { successResponse } from '../../lib/response.js';
import type { AppEnv } from '../../types/hono.js';

export const paymentChannelsRouter = new Hono<AppEnv>();

/**
 * Public Merchant API: List Active Payment Channels
 * GET /v1/payment-channels
 */
paymentChannelsRouter.get('/', requireApiKey, async (c) => {
  const merchantUser = c.get('merchantUser');
  const channels = await PaymentAccountService.listPublicChannels(merchantUser.id);
  return c.json(
    successResponse(channels, 'Payment channels retrieved successfully')
  );
});
