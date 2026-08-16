import { Hono } from 'hono';
import { ApiKeyService } from './api-keys.service.js';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { successResponse, errorResponse } from '../../lib/response.js';
import type { AppEnv } from '../../types/hono.js';

export const apiKeyRouter = new Hono<AppEnv>();

/**
 * Get Current User's API Key Metadata
 * GET /api/api-key
 */
apiKeyRouter.get('/', requireAuth, async (c) => {
  const user = c.get('user');
  const metadata = await ApiKeyService.getMetadata(user.id);
  return c.json(successResponse(metadata, 'API Key metadata retrieved'));
});

/**
 * Generate First API Key
 * POST /api/api-key/generate
 */
apiKeyRouter.post('/generate', requireAuth, async (c) => {
  const user = c.get('user');

  try {
    const result = await ApiKeyService.generate(user.id);
    return c.json(successResponse(result, 'API Key generated successfully'), 201);
  } catch (err: any) {
    if (err.message === 'API_KEY_ALREADY_EXISTS') {
      return c.json(
        errorResponse(
          'API_KEY_ALREADY_EXISTS',
          'You already have an API key. Use the rotate endpoint if you need to regenerate your key.'
        ),
        409
      );
    }
    throw err;
  }
});

/**
 * Rotate / Regenerate API Key
 * POST /api/api-key/rotate
 */
apiKeyRouter.post('/rotate', requireAuth, async (c) => {
  const user = c.get('user');

  try {
    const result = await ApiKeyService.rotate(user.id);
    return c.json(successResponse(result, 'API Key rotated successfully'));
  } catch (err: any) {
    if (err.message === 'API_KEY_NOT_FOUND') {
      return c.json(
        errorResponse('API_KEY_NOT_FOUND', 'No existing API key found to rotate. Generate one first.'),
        404
      );
    }
    throw err;
  }
});
