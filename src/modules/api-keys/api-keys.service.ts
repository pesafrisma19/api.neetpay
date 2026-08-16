import crypto from 'crypto';
import { prisma } from '../../lib/prisma.js';

export function generateSecureApiKey(): { rawKey: string; keyPrefix: string; keyHash: string } {
  // Generate 24 bytes (48 hex chars) of cryptographically secure random data
  const randomHex = crypto.randomBytes(24).toString('hex');
  const rawKey = `np_live_${randomHex}`;
  const keyPrefix = `np_live_${randomHex.slice(0, 6)}...`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  return { rawKey, keyPrefix, keyHash };
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

export class ApiKeyService {
  /**
   * Get metadata for a user's API Key (Safe - Never returns raw key or hash)
   */
  static async getMetadata(userId: string) {
    const cred = await prisma.apiCredential.findUnique({
      where: { userId },
      select: {
        id: true,
        keyPrefix: true,
        lastUsedAt: true,
        rotatedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!cred) {
      return {
        exists: false,
      };
    }

    return {
      exists: true,
      keyPrefix: cred.keyPrefix,
      createdAt: cred.createdAt,
      rotatedAt: cred.rotatedAt,
      lastUsedAt: cred.lastUsedAt,
    };
  }

  /**
   * Generate first API key for user. Fails if user already has an API key.
   */
  static async generate(userId: string) {
    const existing = await prisma.apiCredential.findUnique({
      where: { userId },
    });

    if (existing) {
      throw new Error('API_KEY_ALREADY_EXISTS');
    }

    const { rawKey, keyPrefix, keyHash } = generateSecureApiKey();

    const cred = await prisma.apiCredential.create({
      data: {
        userId,
        keyPrefix,
        keyHash,
      },
    });

    return {
      rawKey, // Returned ONLY once upon creation!
      keyPrefix: cred.keyPrefix,
      createdAt: cred.createdAt,
      message: 'Save this API Key now. It will not be shown again.',
    };
  }

  /**
   * Rotate user's API key. Replaces old hash with new hash immediately invalidating the old key.
   */
  static async rotate(userId: string) {
    const existing = await prisma.apiCredential.findUnique({
      where: { userId },
    });

    if (!existing) {
      throw new Error('API_KEY_NOT_FOUND');
    }

    const { rawKey, keyPrefix, keyHash } = generateSecureApiKey();

    const updated = await prisma.apiCredential.update({
      where: { userId },
      data: {
        keyPrefix,
        keyHash,
        rotatedAt: new Date(),
      },
    });

    return {
      rawKey, // Returned ONLY once upon rotation!
      keyPrefix: updated.keyPrefix,
      rotatedAt: updated.rotatedAt,
      message: 'Your API Key has been rotated. Previous API key is now permanently invalid.',
    };
  }
}
