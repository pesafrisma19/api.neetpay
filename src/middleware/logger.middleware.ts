import type { MiddlewareHandler } from 'hono';
import { logger } from '../lib/logger.js';

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const start = Date.now();
  const { method, path } = c.req;

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;

  logger.info({
    method,
    path,
    status,
    durationMs: duration,
  }, `${method} ${path} -> ${status} (${duration}ms)`);
};
