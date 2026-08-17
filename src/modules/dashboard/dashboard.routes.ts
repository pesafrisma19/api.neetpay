import { Hono } from 'hono';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { successResponse } from '../../lib/response.js';
import type { AppEnv } from '../../types/hono.js';

export const dashboardRouter = new Hono<AppEnv>();

/**
 * GET /api/dashboard/overview
 * Consolidated metrics, subscription quota, account statuses, and recent transactions for User Dashboard
 */
dashboardRouter.get('/overview', requireAuth, async (c) => {
  const authUser = c.get('user');

  // 1. Fetch User & Active Subscription
  const user = await prisma.user.findUnique({
    where: { id: authUser.id },
    include: {
      subscriptions: {
        where: { status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: { plan: true },
      },
      webhookConfig: true,
      paymentAccounts: {
        where: { isActive: true },
        include: {
          goBizAccount: {
            select: {
              outletName: true,
              merchantName: true,
              lastConnectionCheckAt: true,
              qrUpdatedAt: true,
            },
          },
        },
      },
    },
  });

  if (!user) {
    return c.json({ success: false, message: 'User not found' }, 404);
  }

  const activeSub = user.subscriptions[0] || null;
  const plan = activeSub?.plan || {
    code: 'FREE',
    name: 'Free Plan',
    monthlyTransactionLimit: 30,
    paymentAccountLimit: 1,
    priceMonthly: 0,
  };

  // 2. Calculate Transaction Usage in Current Billing Period
  const periodStart = activeSub?.currentPeriodStart || new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const periodEnd = activeSub?.currentPeriodEnd || new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59);

  const usedThisMonth = await prisma.transaction.count({
    where: {
      userId: user.id,
      createdAt: {
        gte: periodStart,
        lte: periodEnd,
      },
    },
  });

  const limit = plan.monthlyTransactionLimit;
  const isUnlimited = limit === null || limit === undefined;
  const usagePercentage = isUnlimited ? 0 : Math.min(100, Math.round((usedThisMonth / limit) * 100));

  // 3. Count Lifetime Transactions by Status
  const [totalCount, paidCount, pendingCount, expiredCount] = await Promise.all([
    prisma.transaction.count({ where: { userId: user.id } }),
    prisma.transaction.count({ where: { userId: user.id, status: 'PAID' } }),
    prisma.transaction.count({ where: { userId: user.id, status: 'PENDING' } }),
    prisma.transaction.count({ where: { userId: user.id, status: 'EXPIRED' } }),
  ]);

  // 4. Fetch 5 Recent Transactions
  const recentTransactions = await prisma.transaction.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: {
      paymentAccount: {
        select: {
          name: true,
          goBizAccount: {
            select: { outletName: true },
          },
        },
      },
    },
  });

  const formattedRecent = recentTransactions.map((trx) => ({
    id: trx.id,
    reference: trx.merchantTradeNo,
    externalRefNo: trx.externalRefNo,
    amount: Number(trx.amount),
    feeAmount: Number(trx.feeAmount),
    uniqueCode: trx.uniqueCode,
    totalAmount: Number(trx.totalAmount),
    status: trx.status,
    paymentAccountName: trx.paymentAccount?.goBizAccount?.outletName || trx.paymentAccount?.name || 'GoBiz QRIS',
    createdAt: trx.createdAt.toISOString(),
    paidAt: trx.paidAt ? trx.paidAt.toISOString() : null,
    expiredAt: trx.expiredAt.toISOString(),
  }));

  return c.json(
    successResponse(
      {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
        plan: {
          code: plan.code,
          name: plan.name,
          priceMonthly: plan.priceMonthly,
          monthlyTransactionLimit: plan.monthlyTransactionLimit,
          paymentAccountLimit: plan.paymentAccountLimit,
          isUnlimited,
        },
        usage: {
          usedThisMonth,
          limit: plan.monthlyTransactionLimit,
          isUnlimited,
          percentage: usagePercentage,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
        },
        transactions: {
          total: totalCount,
          paid: paidCount,
          pending: pendingCount,
          expired: expiredCount,
        },
        paymentAccounts: {
          connectedCount: user.paymentAccounts.length,
          limit: plan.paymentAccountLimit,
          isLimitReached: user.paymentAccounts.length >= plan.paymentAccountLimit,
          accounts: user.paymentAccounts.map((acc) => ({
            id: acc.id,
            name: acc.name,
            outletName: acc.goBizAccount?.outletName || acc.name,
            merchantName: acc.goBizAccount?.merchantName,
            status: acc.status,
            lastSyncedAt: acc.lastSyncedAt,
          })),
        },
        webhook: {
          isConfigured: !!user.webhookConfig?.url,
          isEnabled: user.webhookConfig?.isEnabled ?? false,
          url: user.webhookConfig?.url || null,
        },
        recentTransactions: formattedRecent,
      },
      'Dashboard overview retrieved successfully'
    )
  );
});
