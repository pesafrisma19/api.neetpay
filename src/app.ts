import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { env } from './config/env.js';
import { errorHandler } from './middleware/error.middleware.js';
import { requestLogger } from './middleware/logger.middleware.js';
import { successResponse } from './lib/response.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { apiKeyRouter } from './modules/api-keys/api-keys.routes.js';
import { paymentAccountsRouter } from './modules/payment-accounts/payment-accounts.routes.js';
import { webhookRouter } from './modules/webhooks/webhook.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { transactionsRouter } from './modules/transactions/transactions.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { dashboardTransactionsRouter } from './modules/transactions/dashboard-transactions.routes.js';
import { requireApiKey } from './middleware/api-key.middleware.js';
import type { AppEnv } from './types/hono.js';

export const app = new Hono<AppEnv>();

// Global Middleware
const allowedOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim());

app.use('*', cors({
  origin: (origin) => {
    // If wildcard or in allowed list or development
    if (env.CORS_ORIGIN === '*' || !origin || allowedOrigins.includes(origin)) {
      return origin || '*';
    }
    return allowedOrigins[0] || 'https://neetpay.web.id';
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  exposeHeaders: ['Content-Length', 'Set-Cookie'],
  maxAge: 600,
  credentials: true,
}));

app.use('*', requestLogger);

// Global Error Handler
app.onError(errorHandler);

// Health Check Route
app.get('/health', (c) => {
  return c.json(
    successResponse(
      {
        service: 'neetpay-api',
        version: '1.0.0',
        status: 'UP',
        timestamp: new Date().toISOString(),
      },
      'NeetPay API Gateway is operational'
    )
  );
});

// Dashboard Management Routes
app.route('/api/auth', authRouter);
app.route('/api/dashboard', dashboardRouter);
app.route('/api/transactions', dashboardTransactionsRouter);
app.route('/api/api-key', apiKeyRouter);
app.route('/api/payment-accounts', paymentAccountsRouter);
app.route('/api/webhook', webhookRouter);
app.route('/api/admin', adminRouter);

// Public Merchant Transactions API (https://api.neetpay.web.id/v1/transactions)
app.route('/v1/transactions', transactionsRouter);

// Forward /api/me to authRouter /me
app.get('/api/me', (c) => authRouter.fetch(new Request(`${new URL(c.req.url).origin}/me`, c.req.raw)));

// Test Protected Route for Merchant API Key Verification
app.get('/api/test/merchant-auth', requireApiKey, (c) => {
  const merchantUser = c.get('merchantUser');
  return c.json(
    successResponse(
      {
        authenticated: true,
        merchantId: merchantUser.id,
        merchantEmail: merchantUser.email,
        merchantName: merchantUser.name,
      },
      'Merchant API Key authentication verified successfully'
    )
  );
});

export default app;
