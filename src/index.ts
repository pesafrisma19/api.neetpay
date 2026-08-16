import { serve } from '@hono/node-server';
import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';

serve({
  fetch: app.fetch,
  port: env.PORT,
}, (info) => {
  logger.info({ port: info.port, env: env.NODE_ENV }, `🚀 NeetPay API Server running at http://localhost:${info.port}`);
});

export default app;
