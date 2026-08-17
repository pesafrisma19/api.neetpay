import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireAuth, requireAdmin } from '../../middleware/auth.middleware.js';
import { successResponse, errorResponse } from '../../lib/response.js';
import type { AppEnv } from '../../types/hono.js';

export const adminRouter = new Hono<AppEnv>();

// Apply requireAuth and requireAdmin to all admin endpoints
adminRouter.use('*', requireAuth);
adminRouter.use('*', requireAdmin);

/**
 * 1. Admin Platform Overview
 * GET /api/admin/overview
 */
adminRouter.get('/overview', async (c) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      totalUsers,
      freeUsers,
      proUsers,
      totalTransactionsToday,
      totalTransactionsMonth,
      paidTransactionsMonth,
      volumeMonthResult,
      paidCount,
      pendingCount,
      expiredCount,
      totalPaymentAccounts,
      activePaymentAccounts,
      needsReauthAccounts,
      qrisUnavailableAccounts,
      successfulWebhooks,
      retryingWebhooks,
      failedWebhooks,
      activePendingTransactions,
      accountsWithPending,
    ] = await Promise.all([
      // Users
      prisma.user.count(),
      prisma.subscription.count({
        where: { status: 'ACTIVE', plan: { code: 'FREE' } },
      }),
      prisma.subscription.count({
        where: { status: 'ACTIVE', plan: { code: 'PRO' } },
      }),
      // Transactions
      prisma.transaction.count({
        where: { createdAt: { gte: startOfToday } },
      }),
      prisma.transaction.count({
        where: { createdAt: { gte: startOfMonth } },
      }),
      prisma.transaction.count({
        where: { status: 'PAID', createdAt: { gte: startOfMonth } },
      }),
      prisma.transaction.aggregate({
        where: { status: 'PAID', createdAt: { gte: startOfMonth } },
        _sum: { totalAmount: true },
      }),
      prisma.transaction.count({ where: { status: 'PAID' } }),
      prisma.transaction.count({ where: { status: 'PENDING' } }),
      prisma.transaction.count({ where: { status: 'EXPIRED' } }),
      // Payment Accounts
      prisma.paymentAccount.count(),
      prisma.paymentAccount.count({ where: { isActive: true, status: 'ACTIVE' } }),
      prisma.paymentAccount.count({ where: { status: 'NEEDS_REAUTH' } }),
      prisma.goBizAccount.count({
        where: { OR: [{ qrString: null }, { qrString: '' }] },
      }),
      // Webhooks
      prisma.webhookDelivery.count({ where: { status: 'SUCCESS' } }),
      prisma.webhookDelivery.count({
        where: { status: 'PENDING', attemptsCount: { gt: 0 } },
      }),
      prisma.webhookDelivery.count({ where: { status: 'FAILED' } }),
      // Worker / Pending
      prisma.transaction.count({ where: { status: 'PENDING' } }),
      prisma.paymentAccount.count({
        where: {
          isActive: true,
          status: 'ACTIVE',
          transactions: { some: { status: 'PENDING' } },
        },
      }),
    ]);

    const overviewData = {
      users: {
        total: totalUsers,
        free: freeUsers,
        pro: proUsers,
      },
      transactions: {
        today: totalTransactionsToday,
        month: totalTransactionsMonth,
        monthPaid: paidTransactionsMonth,
        monthVolume: Number(volumeMonthResult._sum.totalAmount || 0),
        totalPaid: paidCount,
        totalPending: pendingCount,
        totalExpired: expiredCount,
      },
      paymentAccounts: {
        total: totalPaymentAccounts,
        active: activePaymentAccounts,
        needsReauth: needsReauthAccounts,
        qrisUnavailable: qrisUnavailableAccounts,
      },
      webhooks: {
        successful: successfulWebhooks,
        retrying: retryingWebhooks,
        failed: failedWebhooks,
      },
      worker: {
        status: 'OPERATIONAL',
        activePendingTransactions,
        accountsBeingPolled: accountsWithPending,
      },
    };

    return c.json(successResponse(overviewData, 'Admin overview retrieved'));
  } catch (err: any) {
    return c.json(errorResponse('OVERVIEW_FETCH_FAILED', err.message), 500);
  }
});

/**
 * 2. Admin Users List
 * GET /api/admin/users
 */
adminRouter.get('/users', async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '15', 10)));
    const search = c.req.query('search')?.trim();
    const planFilter = c.req.query('plan')?.trim().toUpperCase();
    const statusFilter = c.req.query('status')?.trim().toUpperCase();

    const where: any = {};

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (statusFilter && ['ACTIVE', 'SUSPENDED', 'PENDING_VERIFICATION'].includes(statusFilter)) {
      where.status = statusFilter;
    }

    if (planFilter && ['FREE', 'PRO'].includes(planFilter)) {
      where.subscriptions = {
        some: {
          status: 'ACTIVE',
          plan: { code: planFilter },
        },
      };
    }

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
          createdAt: true,
          subscriptions: {
            where: { status: 'ACTIVE' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { plan: true },
          },
          monthlyUsages: {
            orderBy: { yearMonth: 'desc' },
            take: 1,
          },
          _count: {
            select: {
              paymentAccounts: true,
              transactions: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const formattedUsers = users.map((u) => {
      const activeSub = u.subscriptions[0];
      const usage = u.monthlyUsages[0];

      return {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        status: u.status,
        createdAt: u.createdAt,
        plan: {
          code: activeSub?.plan.code || 'FREE',
          name: activeSub?.plan.name || 'Free Tier',
          limit: activeSub?.plan.paymentAccountLimit || 1,
        },
        monthlyUsage: {
          totalTransactions: usage?.totalTransactions || 0,
          totalVolume: Number(usage?.totalVolume || 0),
        },
        counts: {
          paymentAccounts: u._count.paymentAccounts,
          transactions: u._count.transactions,
        },
      };
    });

    return c.json(
      successResponse(
        {
          items: formattedUsers,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
        'Admin users retrieved'
      )
    );
  } catch (err: any) {
    return c.json(errorResponse('USERS_FETCH_FAILED', err.message), 500);
  }
});

/**
 * 3. Admin User Detail
 * GET /api/admin/users/:id
 */
adminRouter.get('/users/:id', async (c) => {
  try {
    const userId = c.req.param('id');

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        subscriptions: {
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { plan: true },
        },
        paymentAccounts: {
          include: {
            provider: true,
            goBizAccount: {
              select: {
                merchantName: true,
                outletName: true,
                authType: true,
                qrString: true,
                lastConnectionCheckAt: true,
                createdAt: true,
              },
            },
          },
        },
        webhookConfig: {
          select: {
            url: true,
            isEnabled: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        apiCredential: {
          select: {
            id: true,
            keyPrefix: true,
            lastUsedAt: true,
            createdAt: true,
          },
        },
      },
    });

    if (!user) {
      return c.json(errorResponse('USER_NOT_FOUND', 'User does not exist'), 404);
    }

    // Get transaction stats
    const [txSummary, volumePaid] = await Promise.all([
      prisma.transaction.groupBy({
        by: ['status'],
        where: { userId },
        _count: { id: true },
      }),
      prisma.transaction.aggregate({
        where: { userId, status: 'PAID' },
        _sum: { totalAmount: true },
      }),
    ]);

    const statusCounts: Record<string, number> = {};
    let totalTx = 0;
    txSummary.forEach((s) => {
      statusCounts[s.status] = s._count.id;
      totalTx += s._count.id;
    });

    const activeSub = user.subscriptions[0];

    return c.json(
      successResponse(
        {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            status: user.status,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
            plan: {
              code: activeSub?.plan.code || 'FREE',
              name: activeSub?.plan.name || 'Free Plan',
              priceMonthly: Number(activeSub?.plan.priceMonthly || 0),
              accountLimit: activeSub?.plan.paymentAccountLimit || 1,
              monthlyLimit: activeSub?.plan.monthlyTransactionLimit || 30,
            },
            apiCredential: user.apiCredential
              ? {
                  keyPrefix: user.apiCredential.keyPrefix,
                  createdAt: user.apiCredential.createdAt,
                  lastUsedAt: user.apiCredential.lastUsedAt,
                }
              : null,
            webhookConfig: user.webhookConfig
              ? {
                  url: user.webhookConfig.url,
                  isEnabled: user.webhookConfig.isEnabled,
                  createdAt: user.webhookConfig.createdAt,
                }
              : null,
          },
          paymentAccounts: user.paymentAccounts.map((pa) => ({
            id: pa.id,
            name: pa.name,
            provider: pa.provider.name,
            status: pa.status,
            isActive: pa.isActive,
            outletName: pa.goBizAccount?.outletName || pa.name,
            merchantName: pa.goBizAccount?.merchantName || 'GoBiz',
            authType: pa.goBizAccount?.authType,
            hasQrString: !!pa.goBizAccount?.qrString,
            lastConnectionCheckAt: pa.goBizAccount?.lastConnectionCheckAt,
            createdAt: pa.createdAt,
          })),
          transactions: {
            total: totalTx,
            paid: statusCounts['PAID'] || 0,
            pending: statusCounts['PENDING'] || 0,
            expired: statusCounts['EXPIRED'] || 0,
            totalVolumePaid: Number(volumePaid._sum.totalAmount || 0),
          },
        },
        'Admin user detail retrieved'
      )
    );
  } catch (err: any) {
    return c.json(errorResponse('USER_DETAIL_FAILED', err.message), 500);
  }
});

/**
 * 4. Admin Global Transactions List
 * GET /api/admin/transactions
 */
adminRouter.get('/transactions', async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '15', 10)));
    const search = c.req.query('search')?.trim();
    const status = c.req.query('status')?.trim().toUpperCase();
    const userId = c.req.query('userId')?.trim();

    const where: any = {};

    if (userId) {
      where.userId = userId;
    }

    if (status && ['PAID', 'PENDING', 'EXPIRED', 'FAILED'].includes(status)) {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { externalRefNo: { contains: search, mode: 'insensitive' } },
        { merchantTradeNo: { contains: search, mode: 'insensitive' } },
        { id: { contains: search, mode: 'insensitive' } },
        { customerName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, items] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        include: {
          user: {
            select: { id: true, email: true, name: true },
          },
          paymentAccount: {
            include: {
              goBizAccount: {
                select: { outletName: true, merchantName: true },
              },
            },
          },
          provider: {
            select: { code: true, name: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const formatted = items.map((tx) => ({
      id: tx.id,
      merchantTradeNo: tx.merchantTradeNo,
      externalRefNo: tx.externalRefNo,
      amount: Number(tx.amount),
      feeType: tx.feeType,
      feeAmount: Number(tx.feeAmount),
      uniqueCode: tx.uniqueCode,
      totalAmount: Number(tx.totalAmount),
      status: tx.status,
      customerName: tx.customerName,
      customerEmail: tx.customerEmail,
      createdAt: tx.createdAt,
      paidAt: tx.paidAt,
      expiredAt: tx.expiredAt,
      user: {
        id: tx.user.id,
        name: tx.user.name,
        email: tx.user.email,
      },
      paymentAccount: {
        id: tx.paymentAccount.id,
        name: tx.paymentAccount.name,
        outletName: tx.paymentAccount.goBizAccount?.outletName || tx.paymentAccount.name,
        merchantName: tx.paymentAccount.goBizAccount?.merchantName || 'GoBiz',
      },
      provider: tx.provider.name,
    }));

    return c.json(
      successResponse(
        {
          items: formatted,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
        'Admin transactions retrieved'
      )
    );
  } catch (err: any) {
    return c.json(errorResponse('TRANSACTIONS_FETCH_FAILED', err.message), 500);
  }
});

/**
 * 5. Admin Single Transaction Detail
 * GET /api/admin/transactions/:id
 */
adminRouter.get('/transactions/:id', async (c) => {
  try {
    const id = c.req.param('id');

    const tx = await prisma.transaction.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, email: true, name: true },
        },
        paymentAccount: {
          include: {
            goBizAccount: {
              select: {
                merchantId: true,
                outletId: true,
                merchantName: true,
                outletName: true,
                authType: true,
              },
            },
          },
        },
        provider: {
          select: { code: true, name: true },
        },
        events: {
          orderBy: { createdAt: 'asc' },
        },
        webhookDeliveries: {
          include: {
            attempts: {
              orderBy: { createdAt: 'desc' },
            },
          },
        },
      },
    });

    if (!tx) {
      return c.json(errorResponse('TRANSACTION_NOT_FOUND', 'Transaction not found'), 404);
    }

    // Check matching provider event
    const providerEvent = await prisma.providerEvent.findFirst({
      where: {
        paymentAccountId: tx.paymentAccountId,
        rawPayload: {
          path: ['normalizedAmount'],
          equals: Number(tx.totalAmount),
        },
      },
      select: {
        id: true,
        eventType: true,
        providerRefId: true,
        isProcessed: true,
        processedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const result = {
      id: tx.id,
      merchantTradeNo: tx.merchantTradeNo,
      externalRefNo: tx.externalRefNo,
      amount: Number(tx.amount),
      feeType: tx.feeType,
      feeAmount: Number(tx.feeAmount),
      uniqueCode: tx.uniqueCode,
      totalAmount: Number(tx.totalAmount),
      status: tx.status,
      customerName: tx.customerName,
      customerEmail: tx.customerEmail,
      metadata: tx.metadata,
      createdAt: tx.createdAt,
      paidAt: tx.paidAt,
      expiredAt: tx.expiredAt,
      user: {
        id: tx.user.id,
        name: tx.user.name,
        email: tx.user.email,
      },
      paymentAccount: {
        id: tx.paymentAccount.id,
        name: tx.paymentAccount.name,
        merchantId: tx.paymentAccount.goBizAccount?.merchantId,
        outletId: tx.paymentAccount.goBizAccount?.outletId,
        outletName: tx.paymentAccount.goBizAccount?.outletName || tx.paymentAccount.name,
        merchantName: tx.paymentAccount.goBizAccount?.merchantName || 'GoBiz',
      },
      provider: tx.provider.name,
      events: tx.events.map((e) => ({
        id: e.id,
        type: e.type,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        metadata: e.metadata,
        createdAt: e.createdAt,
      })),
      webhookDeliveries: tx.webhookDeliveries.map((w) => ({
        id: w.id,
        event: w.event,
        status: w.status,
        attemptsCount: w.attemptsCount,
        nextRetryAt: w.nextRetryAt,
        createdAt: w.createdAt,
        attempts: w.attempts.map((a) => ({
          id: a.id,
          attempt: a.attempt,
          httpStatus: a.httpStatus,
          durationMs: a.durationMs,
          error: a.error,
          createdAt: a.createdAt,
        })),
      })),
      providerEvent: providerEvent || null,
    };

    return c.json(successResponse(result, 'Admin transaction detail retrieved'));
  } catch (err: any) {
    return c.json(errorResponse('TRANSACTION_DETAIL_FAILED', err.message), 500);
  }
});

/**
 * 6. Admin Global Payment Accounts List
 * GET /api/admin/payment-accounts
 */
adminRouter.get('/payment-accounts', async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '15', 10)));
    const search = c.req.query('search')?.trim();
    const status = c.req.query('status')?.trim().toUpperCase();
    const userId = c.req.query('userId')?.trim();

    const where: any = {};

    if (userId) {
      where.userId = userId;
    }

    if (status && ['ACTIVE', 'NEEDS_REAUTH', 'INACTIVE', 'ERROR'].includes(status)) {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        {
          goBizAccount: {
            OR: [
              { outletName: { contains: search, mode: 'insensitive' } },
              { merchantName: { contains: search, mode: 'insensitive' } },
              { loginIdentifier: { contains: search, mode: 'insensitive' } },
            ],
          },
        },
      ];
    }

    const [total, items] = await Promise.all([
      prisma.paymentAccount.count({ where }),
      prisma.paymentAccount.findMany({
        where,
        include: {
          user: {
            select: { id: true, email: true, name: true },
          },
          provider: {
            select: { code: true, name: true },
          },
          goBizAccount: {
            select: {
              id: true,
              authType: true,
              merchantId: true,
              outletId: true,
              merchantName: true,
              outletName: true,
              loginIdentifier: true,
              qrString: true,
              qrUpdatedAt: true,
              lastConnectionCheckAt: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const formatted = items.map((pa) => ({
      id: pa.id,
      name: pa.name,
      status: pa.status,
      isActive: pa.isActive,
      customMinAmount: pa.customMinAmount ? Number(pa.customMinAmount) : null,
      customMaxAmount: pa.customMaxAmount ? Number(pa.customMaxAmount) : null,
      lastSyncedAt: pa.lastSyncedAt,
      createdAt: pa.createdAt,
      user: {
        id: pa.user.id,
        name: pa.user.name,
        email: pa.user.email,
      },
      provider: pa.provider.name,
      goBiz: pa.goBizAccount
        ? {
            authType: pa.goBizAccount.authType,
            merchantId: pa.goBizAccount.merchantId,
            outletId: pa.goBizAccount.outletId,
            merchantName: pa.goBizAccount.merchantName || 'GoBiz',
            outletName: pa.goBizAccount.outletName || pa.name,
            maskedIdentifier: pa.goBizAccount.loginIdentifier
              ? pa.goBizAccount.loginIdentifier.replace(/^(.{3}).*(@.*|\d{4})$/, '$1•••$2')
              : 'N/A',
            hasQrString: !!pa.goBizAccount.qrString,
            qrUpdatedAt: pa.goBizAccount.qrUpdatedAt,
            lastConnectionCheckAt: pa.goBizAccount.lastConnectionCheckAt,
          }
        : null,
    }));

    return c.json(
      successResponse(
        {
          items: formatted,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
        'Admin payment accounts retrieved'
      )
    );
  } catch (err: any) {
    return c.json(errorResponse('PAYMENT_ACCOUNTS_FETCH_FAILED', err.message), 500);
  }
});

/**
 * 7. Admin Single Payment Account Detail
 * GET /api/admin/payment-accounts/:id
 */
adminRouter.get('/payment-accounts/:id', async (c) => {
  try {
    const id = c.req.param('id');

    const pa = await prisma.paymentAccount.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            subscriptions: {
              where: { status: 'ACTIVE' },
              include: { plan: true },
              take: 1,
            },
          },
        },
        provider: true,
        goBizAccount: {
          include: {
            tokenLifecycles: {
              orderBy: { issuedAt: 'desc' },
              take: 10,
            },
          },
        },
      },
    });

    if (!pa) {
      return c.json(errorResponse('ACCOUNT_NOT_FOUND', 'Payment account not found'), 404);
    }

    const sub = pa.user.subscriptions[0];

    // Safe Token Lifecycle Summary
    const lifecycles = pa.goBizAccount?.tokenLifecycles.map((tl) => ({
      id: tl.id,
      tokenType: tl.tokenType,
      tokenFingerprint: tl.tokenFingerprint ? `${tl.tokenFingerprint.slice(0, 8)}••••` : 'N/A',
      issuedAt: tl.issuedAt,
      lastSuccessAt: tl.lastSuccessAt,
      lastAttemptAt: tl.lastAttemptAt,
      failedAt: tl.failedAt,
      failureCode: tl.failureCode,
    })) || [];

    const result = {
      id: pa.id,
      name: pa.name,
      status: pa.status,
      isActive: pa.isActive,
      customMinAmount: pa.customMinAmount ? Number(pa.customMinAmount) : null,
      customMaxAmount: pa.customMaxAmount ? Number(pa.customMaxAmount) : null,
      lastSyncedAt: pa.lastSyncedAt,
      createdAt: pa.createdAt,
      owner: {
        id: pa.user.id,
        name: pa.user.name,
        email: pa.user.email,
        plan: sub?.plan.code || 'FREE',
      },
      provider: {
        code: pa.provider.code,
        name: pa.provider.name,
      },
      goBiz: pa.goBizAccount
        ? {
            id: pa.goBizAccount.id,
            authType: pa.goBizAccount.authType,
            merchantId: pa.goBizAccount.merchantId,
            outletId: pa.goBizAccount.outletId,
            merchantName: pa.goBizAccount.merchantName || 'GoBiz',
            outletName: pa.goBizAccount.outletName || pa.name,
            maskedIdentifier: pa.goBizAccount.loginIdentifier
              ? pa.goBizAccount.loginIdentifier.replace(/^(.{3}).*(@.*|\d{4})$/, '$1•••$2')
              : 'N/A',
            hasQrString: !!pa.goBizAccount.qrString,
            qrUpdatedAt: pa.goBizAccount.qrUpdatedAt,
            lastConnectionCheckAt: pa.goBizAccount.lastConnectionCheckAt,
            connectedSince: pa.goBizAccount.createdAt,
            tokenLifecycles: lifecycles,
          }
        : null,
    };

    return c.json(successResponse(result, 'Admin payment account detail retrieved'));
  } catch (err: any) {
    return c.json(errorResponse('PAYMENT_ACCOUNT_DETAIL_FAILED', err.message), 500);
  }
});

/**
 * 8. Admin Webhook Failures
 * GET /api/admin/webhooks/failures
 */
adminRouter.get('/webhooks/failures', async (c) => {
  try {
    const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '15', 10)));
    const statusFilter = c.req.query('status')?.trim().toUpperCase(); // FAILED or PENDING
    const search = c.req.query('search')?.trim();

    const where: any = {
      OR: [
        { status: 'FAILED' },
        { status: 'PENDING', attemptsCount: { gt: 0 } },
      ],
    };

    if (statusFilter === 'FAILED') {
      where.OR = undefined;
      where.status = 'FAILED';
    } else if (statusFilter === 'RETRYING' || statusFilter === 'PENDING') {
      where.OR = undefined;
      where.status = 'PENDING';
      where.attemptsCount = { gt: 0 };
    }

    if (search) {
      where.AND = [
        {
          OR: [
            { user: { email: { contains: search, mode: 'insensitive' } } },
            { user: { name: { contains: search, mode: 'insensitive' } } },
            { transaction: { externalRefNo: { contains: search, mode: 'insensitive' } } },
            { transaction: { merchantTradeNo: { contains: search, mode: 'insensitive' } } },
          ],
        },
      ];
    }

    const [total, items] = await Promise.all([
      prisma.webhookDelivery.count({ where }),
      prisma.webhookDelivery.findMany({
        where,
        include: {
          user: {
            select: { id: true, email: true, name: true },
          },
          transaction: {
            select: {
              id: true,
              merchantTradeNo: true,
              externalRefNo: true,
              totalAmount: true,
              status: true,
            },
          },
          attempts: {
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const formatted = items.map((w) => {
      const latestAttempt = w.attempts[0];
      return {
        id: w.id,
        event: w.event,
        status: w.status,
        attemptsCount: w.attemptsCount,
        nextRetryAt: w.nextRetryAt,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        user: {
          id: w.user.id,
          name: w.user.name,
          email: w.user.email,
        },
        transaction: w.transaction
          ? {
              id: w.transaction.id,
              merchantTradeNo: w.transaction.merchantTradeNo,
              externalRefNo: w.transaction.externalRefNo,
              totalAmount: Number(w.transaction.totalAmount),
              status: w.transaction.status,
            }
          : null,
        latestAttempt: latestAttempt
          ? {
              attempt: latestAttempt.attempt,
              httpStatus: latestAttempt.httpStatus,
              durationMs: latestAttempt.durationMs,
              error: latestAttempt.error,
              createdAt: latestAttempt.createdAt,
            }
          : null,
        attempts: w.attempts.map((a) => ({
          attempt: a.attempt,
          httpStatus: a.httpStatus,
          durationMs: a.durationMs,
          error: a.error,
          createdAt: a.createdAt,
        })),
      };
    });

    return c.json(
      successResponse(
        {
          items: formatted,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
        'Admin webhook failures retrieved'
      )
    );
  } catch (err: any) {
    return c.json(errorResponse('WEBHOOK_FAILURES_FETCH_FAILED', err.message), 500);
  }
});

/**
 * 9. Admin Worker & System Health
 * GET /api/admin/health
 */
adminRouter.get('/health', async (c) => {
  try {
    const startTime = Date.now();

    // 1. Database Ping Check
    let dbStatus = 'CONNECTED';
    let dbLatencyMs = 0;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbLatencyMs = Date.now() - startTime;
    } catch {
      dbStatus = 'ERROR';
    }

    // 2. Count Pending Transactions & Active Accounts
    const [
      pendingTxCount,
      activePollingAccountsCount,
      pendingWebhooksCount,
      failedWebhooksCount,
      recentProviderEvents,
      recentLifecycles,
    ] = await Promise.all([
      prisma.transaction.count({ where: { status: 'PENDING' } }),
      prisma.paymentAccount.count({
        where: {
          isActive: true,
          status: 'ACTIVE',
          transactions: { some: { status: 'PENDING' } },
        },
      }),
      prisma.webhookDelivery.count({
        where: { status: 'PENDING', attemptsCount: { gt: 0 } },
      }),
      prisma.webhookDelivery.count({ where: { status: 'FAILED' } }),
      prisma.providerEvent.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          eventType: true,
          providerRefId: true,
          isProcessed: true,
          processedAt: true,
          createdAt: true,
        },
      }),
      prisma.goBizTokenLifecycle.findMany({
        take: 5,
        orderBy: { issuedAt: 'desc' },
        select: {
          tokenType: true,
          lastSuccessAt: true,
          lastAttemptAt: true,
          failedAt: true,
          failureCode: true,
          goBizAccount: {
            select: { outletName: true },
          },
        },
      }),
    ]);

    const memory = process.memoryUsage();

    const healthData = {
      api: {
        status: 'UP',
        version: '1.0.0',
        nodeVersion: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
        memory: {
          rssMb: Math.round(memory.rss / (1024 * 1024)),
          heapUsedMb: Math.round(memory.heapUsed / (1024 * 1024)),
          heapTotalMb: Math.round(memory.heapTotal / (1024 * 1024)),
        },
        env: process.env.NODE_ENV || 'development',
      },
      database: {
        status: dbStatus,
        latencyMs: dbLatencyMs,
      },
      worker: {
        status: 'OPERATIONAL',
        pollingIntervalMs: 5000,
        activePollingAccountsCount,
        pendingTransactionsCount: pendingTxCount,
        reconciliationGraceMs: 60000,
      },
      webhookDispatcher: {
        status: 'OPERATIONAL',
        pollingIntervalMs: 3000,
        pendingRetriesCount: pendingWebhooksCount,
        failedDeliveriesCount: failedWebhooksCount,
      },
      recentActivity: {
        recentProviderEvents,
        recentTokenLifecycles: recentLifecycles.map((l) => ({
          tokenType: l.tokenType,
          outletName: l.goBizAccount.outletName,
          lastSuccessAt: l.lastSuccessAt,
          failedAt: l.failedAt,
          failureCode: l.failureCode,
        })),
      },
      timestamp: new Date().toISOString(),
    };

    return c.json(successResponse(healthData, 'System health diagnostics retrieved'));
  } catch (err: any) {
    return c.json(errorResponse('HEALTH_FETCH_FAILED', err.message), 500);
  }
});
