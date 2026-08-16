import type { ErrorHandler } from 'hono';
import { ZodError } from 'zod';
import { logger } from '../lib/logger.js';
import { errorResponse } from '../lib/response.js';

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof ZodError) {
    return c.json(
      errorResponse('VALIDATION_ERROR', 'Input validation failed', err.flatten()),
      400
    );
  }

  logger.error({ err, path: c.req.path, method: c.req.method }, 'Unhandled API Error');

  const isDev = process.env.NODE_ENV === 'development';
  return c.json(
    errorResponse(
      'INTERNAL_SERVER_ERROR',
      isDev ? err.message : 'An unexpected error occurred',
      isDev ? err.stack : undefined
    ),
    500
  );
};
