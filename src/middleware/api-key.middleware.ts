import type { MiddlewareHandler } from 'hono';
import { prisma } from '../lib/prisma.js';
import { errorResponse } from '../lib/response.js';
import { hashApiKey } from '../modules/api-keys/api-keys.service.js';
import type { AppEnv } from '../types/hono.js';

export const requireApiKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json(
      errorResponse(
        'UNAUTHORIZED',
        'API Key required. Provide your API Key in Authorization header: Bearer np_live_...'
      ),
      401
    );
  }

  const rawKey = authHeader.substring(7).trim();

  if (!rawKey.startsWith('np_live_')) {
    return c.json(
      errorResponse('INVALID_API_KEY_FORMAT', 'Invalid API key format. Must begin with np_live_'),
      401
    );
  }

  const keyHash = hashApiKey(rawKey);

  const cred = await prisma.apiCredential.findUnique({
    where: { keyHash },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
        },
      },
    },
  });

  if (!cred) {
    return c.json(
      errorResponse('INVALID_API_KEY', 'The provided API Key is invalid or has been revoked/rotated.'),
      401
    );
  }

  if (cred.user.status !== 'ACTIVE') {
    return c.json(
      errorResponse('ACCOUNT_INACTIVE', 'Merchant account is not active.'),
      403
    );
  }

  // Update lastUsedAt asynchronously
  prisma.apiCredential
    .update({
      where: { id: cred.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {});

  // Attach merchant user context
  c.set('merchantUser', cred.user);
  c.set('apiCredential', cred);

  await next();
};
