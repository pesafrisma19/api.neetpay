import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { errorResponse } from '../lib/response.js';
import type { AppEnv } from '../types/hono.js';

export const SESSION_COOKIE_NAME = 'neetpay_session';

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Dashboard Session Authentication Middleware
 * Strictly expects valid HttpOnly session cookie (neetpay_session).
 * Does NOT accept merchant API keys.
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const rawToken = getCookie(c, SESSION_COOKIE_NAME);

  if (!rawToken) {
    return c.json(
      errorResponse('UNAUTHORIZED', 'Authentication session required. Please log in.'),
      401
    );
  }

  // Ensure rawToken is not an API key accidentally sent in cookie
  if (rawToken.startsWith('np_live_')) {
    return c.json(
      errorResponse('UNAUTHORIZED', 'API Keys cannot be used as dashboard session credentials.'),
      401
    );
  }

  const tokenHash = hashToken(rawToken);

  const session = await prisma.authSession.findUnique({
    where: { tokenHash },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
          hasDynamicAccess: true,
          dynamicActivatedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!session) {
    return c.json(
      errorResponse('UNAUTHORIZED', 'Invalid or expired session. Please log in again.'),
      401
    );
  }

  // Check 7-day expiration
  if (session.expiresAt < new Date()) {
    prisma.authSession.delete({ where: { id: session.id } }).catch(() => {});
    return c.json(
      errorResponse('SESSION_EXPIRED', 'Session has expired (7-day maximum lifetime). Please log in again.'),
      401
    );
  }

  if (session.user.status !== 'ACTIVE') {
    return c.json(
      errorResponse('ACCOUNT_INACTIVE', 'User account is suspended or pending verification.'),
      403
    );
  }

  // Update lastUsedAt in background without blocking
  prisma.authSession
    .update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {});

  // Attach to Hono context
  c.set('user', session.user);
  c.set('session', session);

  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');

  if (!user || user.role !== 'ADMIN') {
    return c.json(
      errorResponse('FORBIDDEN', 'Access denied. Administrator privileges required.'),
      403
    );
  }

  await next();
};
