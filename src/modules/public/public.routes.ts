import { Hono } from 'hono';
import { prisma } from '../../lib/prisma.js';
import { successResponse } from '../../lib/response.js';
import type { AppEnv } from '../../types/hono.js';

export const publicRouter = new Hono<AppEnv>();

export interface PublicActivityItem {
  amount: number;
  paymentMethod: string;
  paidAt: string;
}

let cachedActivities: { data: PublicActivityItem[]; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60 * 1000;

/**
 * Truncate a Date to minute precision (seconds & ms set to 0 in UTC)
 * Example: 2026-08-22T12:30:47.381Z -> 2026-08-22T12:30:00.000Z
 */
function truncateToMinute(date: Date): string {
  const d = new Date(date.getTime());
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}

/**
 * Public Route: Get recent paid transaction activities (Anonymized & Privacy-Safe)
 * GET /v1/public/activity
 */
publicRouter.get('/activity', async (c) => {
  const now = Date.now();

  // Return cached result if valid
  if (cachedActivities && now < cachedActivities.expiresAt) {
    return c.json(
      successResponse(
        { activities: cachedActivities.data },
        'Recent public activity retrieved successfully'
      )
    );
  }

  try {
    const transactions = await prisma.transaction.findMany({
      where: {
        status: 'PAID',
        paidAt: { not: null },
      },
      orderBy: {
        paidAt: 'desc',
      },
      take: 8,
      select: {
        amount: true,
        paidAt: true,
        paymentMethod: {
          select: {
            code: true,
            name: true,
          },
        },
      },
    });

    const activities: PublicActivityItem[] = transactions.map((t) => {
      const method = t.paymentMethod?.name || t.paymentMethod?.code || 'QRIS';
      const paidDate = t.paidAt || new Date();

      return {
        amount: Number(t.amount),
        paymentMethod: method,
        paidAt: truncateToMinute(paidDate),
      };
    });

    cachedActivities = {
      data: activities,
      expiresAt: now + CACHE_TTL_MS,
    };

    return c.json(
      successResponse(
        { activities },
        'Recent public activity retrieved successfully'
      )
    );
  } catch {
    // Graceful error fallback with empty activities array without leaking database internals
    return c.json(
      successResponse(
        { activities: [] },
        'Recent public activity retrieved successfully'
      )
    );
  }
});
