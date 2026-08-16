import { Hono } from 'hono';
import { z } from 'zod';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { AuthService } from './auth.service.js';
import { successResponse, errorResponse } from '../../lib/response.js';
import { requireAuth, SESSION_COOKIE_NAME } from '../../middleware/auth.middleware.js';
import { env } from '../../config/env.js';
import type { AppEnv } from '../../types/hono.js';

export const authRouter = new Hono<AppEnv>();

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

/**
 * Public User Registration
 * POST /api/auth/register
 */
authRouter.post('/register', async (c) => {
  const body = await c.req.json();
  const parsed = registerSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      errorResponse('VALIDATION_ERROR', 'Input validation failed', parsed.error.flatten()),
      400
    );
  }

  try {
    const user = await AuthService.register(parsed.data);
    return c.json(
      successResponse(user, 'Account registered successfully. You can now log in.', undefined),
      201
    );
  } catch (err: any) {
    if (err.message === 'EMAIL_EXISTS') {
      return c.json(
        errorResponse('EMAIL_EXISTS', 'An account with this email address already exists.'),
        409
      );
    }
    throw err;
  }
});

/**
 * User Login & Session Creation
 * POST /api/auth/login
 */
authRouter.post('/login', async (c) => {
  const body = await c.req.json();
  const parsed = loginSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      errorResponse('VALIDATION_ERROR', 'Input validation failed', parsed.error.flatten()),
      400
    );
  }

  try {
    const ipAddress = c.req.header('x-forwarded-for') || c.req.header('x-real-ip');
    const userAgent = c.req.header('user-agent');

    const result = await AuthService.login({
      ...parsed.data,
      ipAddress,
      userAgent,
    });

    // Set secure HttpOnly cookie
    setCookie(c, SESSION_COOKIE_NAME, result.sessionToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: env.NODE_ENV === 'production' ? 'lax' : 'lax',
      path: '/',
      expires: result.expiresAt,
    });

    return c.json(
      successResponse(
        {
          user: result.user,
          session: {
            expiresAt: result.expiresAt,
          },
          token: result.sessionToken, // Also returned in JSON for API/SPA convenience
        },
        'Logged in successfully'
      )
    );
  } catch (err: any) {
    if (err.message === 'INVALID_CREDENTIALS') {
      return c.json(
        errorResponse('INVALID_CREDENTIALS', 'Invalid email or password.'),
        401
      );
    }
    if (err.message === 'ACCOUNT_SUSPENDED') {
      return c.json(
        errorResponse('ACCOUNT_SUSPENDED', 'Your account has been suspended. Please contact support.'),
        403
      );
    }
    throw err;
  }
});

/**
 * User Logout & Session Revocation
 * POST /api/auth/logout
 */
authRouter.post('/logout', async (c) => {
  const rawToken = getCookie(c, SESSION_COOKIE_NAME) || c.req.header('Authorization')?.replace('Bearer ', '').trim();

  if (rawToken) {
    await AuthService.logout(rawToken);
  }

  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
  });

  return c.json(successResponse({ loggedOut: true }, 'Logged out successfully'));
});

/**
 * Get Current Authenticated User Profile
 * GET /api/me
 */
authRouter.get('/me', requireAuth, async (c) => {
  const authUser = c.get('user');
  const userProfile = await AuthService.getMe(authUser.id);

  return c.json(successResponse(userProfile, 'User profile retrieved'));
});
