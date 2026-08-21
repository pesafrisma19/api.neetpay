import { Hono } from 'hono';
import { prisma } from '../../lib/prisma.js';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { successResponse, errorResponse } from '../../lib/response.js';
import type { AppEnv } from '../../types/hono.js';

export const dashboardTransactionsRouter = new Hono<AppEnv>();

/**
 * GET /api/transactions
 * List paginated transactions with status and search filters (Dashboard Authenticated)
 */
dashboardTransactionsRouter.get('/', requireAuth, async (c) => {
  const user = c.get('user');

  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '10', 10)));
  const status = c.req.query('status')?.toUpperCase();
  const search = c.req.query('search')?.trim();
  const paymentAccountId = c.req.query('paymentAccountId')?.trim();

  const skip = (page - 1) * limit;

  const where: any = {
    userId: user.id,
  };

  if (status && status !== 'ALL' && ['PENDING', 'PAID', 'EXPIRED', 'FAILED'].includes(status)) {
    where.status = status;
  }

  if (paymentAccountId) {
    where.paymentAccountId = paymentAccountId;
  }

  if (search) {
    where.OR = [
      { merchantTradeNo: { contains: search, mode: 'insensitive' } },
      { externalRefNo: { contains: search, mode: 'insensitive' } },
      { customerName: { contains: search, mode: 'insensitive' } },
      { customerEmail: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [total, transactions] = await Promise.all([
    prisma.transaction.count({ where }),
    prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        paymentAccount: {
          select: {
            id: true,
            name: true,
            provider: {
              select: {
                code: true,
                name: true,
              },
            },
            goBizAccount: {
              select: {
                outletName: true,
                merchantName: true,
              },
            },
          },
        },
      },
    }),
  ]);

  const items = transactions.map((trx) => ({
    id: trx.id,
    reference: trx.merchantTradeNo,
    externalRefNo: trx.externalRefNo,
    amount: Number(trx.amount),
    feeAmount: Number(trx.feeAmount),
    uniqueCode: trx.uniqueCode,
    totalAmount: Number(trx.totalAmount),
    status: trx.status,
    paymentAccount: {
      id: trx.paymentAccount?.id || '',
      name: trx.paymentAccount?.name || 'GoBiz QRIS',
      providerCode: trx.paymentAccount?.provider?.code,
      providerName: trx.paymentAccount?.provider?.name,
      outletName: trx.paymentAccount?.goBizAccount?.outletName || trx.paymentAccount?.name || 'GoBiz Outlet',
      merchantName: trx.paymentAccount?.goBizAccount?.merchantName || null,
    },
    customerName: trx.customerName,
    customerEmail: trx.customerEmail,
    qrisUrl: trx.qrisUrl ? `https://api.neetpay.web.id/v1/transactions/${trx.merchantTradeNo}/qr.png` : null,
    createdAt: trx.createdAt.toISOString(),
    paidAt: trx.paidAt ? trx.paidAt.toISOString() : null,
    expiredAt: trx.expiredAt.toISOString(),
  }));

  const totalPages = Math.ceil(total / limit) || 1;

  return c.json(
    successResponse(
      {
        items,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      },
      'Transactions retrieved successfully'
    )
  );
});

/**
 * GET /api/transactions/:id
 * Single transaction details with timeline events and webhook delivery status (Dashboard Authenticated)
 */
dashboardTransactionsRouter.get('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const trxId = c.req.param('id');

  const trx = await prisma.transaction.findFirst({
    where: {
      id: trxId,
      userId: user.id,
    },
    include: {
      paymentAccount: {
        include: {
          provider: {
            select: {
              code: true,
              name: true,
            },
          },
          goBizAccount: {
            select: {
              outletName: true,
              merchantName: true,
              merchantId: true,
            },
          },
        },
      },
      events: {
        orderBy: { createdAt: 'asc' },
      },
      webhookDeliveries: {
        include: {
          attempts: {
            orderBy: { createdAt: 'asc' },
          },
        },
      },
    },
  });

  if (!trx) {
    return c.json(errorResponse('TRANSACTION_NOT_FOUND', 'Transaction not found or unauthorized.'), 404);
  }

  // Find linked provider event reference if paid
  let providerRefId: string | null = null;
  if (trx.status === 'PAID') {
    const paymentDetectedEvent = trx.events.find((evt: any) => evt.type === 'PAYMENT_DETECTED');
    if (paymentDetectedEvent?.metadata && (paymentDetectedEvent.metadata as any).providerRefId) {
      providerRefId = (paymentDetectedEvent.metadata as any).providerRefId;
    } else {
      const providerEvent = await prisma.providerEvent.findFirst({
        where: {
          paymentAccountId: trx.paymentAccountId || '',
          createdAt: {
            gte: trx.createdAt,
          },
        },
        orderBy: { createdAt: 'asc' },
      });
      providerRefId = providerEvent?.providerRefId || null;
    }
  }

  const publicQrUrl = trx.qrisUrl
    ? `https://api.neetpay.web.id/v1/transactions/${trx.merchantTradeNo}/qr.png`
    : null;
  const publicCheckoutUrl = `https://neetpay.web.id/pay/${trx.merchantTradeNo}`;

  const rawMeta = (trx.metadata as any) || {};
  const sanitizedMetadata: Record<string, any> = {
    ...rawMeta,
    ...(rawMeta.checkoutUrl ? { checkoutUrl: publicCheckoutUrl } : {}),
  };
  delete sanitizedMetadata.paymentLinkId;

  return c.json(
    successResponse(
      {
        id: trx.id,
        reference: trx.merchantTradeNo,
        externalRefNo: trx.externalRefNo,
        amount: Number(trx.amount),
        feeAmount: Number(trx.feeAmount),
        feeType: trx.feeType,
        feeValue: trx.feeValue,
        uniqueCode: trx.uniqueCode,
        totalAmount: Number(trx.totalAmount),
        status: trx.status,
        customerName: trx.customerName,
        customerEmail: trx.customerEmail,
        metadata: sanitizedMetadata,
        qrisPayload: trx.qrisPayload,
        qrisUrl: publicQrUrl,
        checkoutUrl: publicCheckoutUrl,
        providerRefId,
        paymentAccount: {
          id: trx.paymentAccount?.id,
          name: trx.paymentAccount?.name,
          providerCode: trx.paymentAccount?.provider?.code,
          providerName: trx.paymentAccount?.provider?.name,
          outletName: trx.paymentAccount?.goBizAccount?.outletName,
          merchantName: trx.paymentAccount?.goBizAccount?.merchantName,
        },
        timeline: trx.events.map((evt: any) => {
          const evtMeta = (evt.metadata as any) || {};
          const sanitizedEvtMeta = {
            ...evtMeta,
            ...(evtMeta.checkoutUrl ? { checkoutUrl: publicCheckoutUrl } : {}),
          };
          return {
            id: evt.id,
            type: evt.type,
            fromStatus: evt.fromStatus,
            toStatus: evt.toStatus,
            metadata: sanitizedEvtMeta,
            createdAt: evt.createdAt.toISOString(),
          };
        }),
        webhookDeliveries: trx.webhookDeliveries.map((wh: any) => ({
          id: wh.id,
          event: wh.event,
          status: wh.status,
          attemptsCount: wh.attemptsCount,
          createdAt: wh.createdAt.toISOString(),
          attempts: wh.attempts.map((att: any) => ({
            id: att.id,
            attempt: att.attempt,
            httpStatus: att.httpStatus,
            error: att.error,
            durationMs: att.durationMs,
            createdAt: att.createdAt.toISOString(),
          })),
        })),
        createdAt: trx.createdAt.toISOString(),
        paidAt: trx.paidAt ? trx.paidAt.toISOString() : null,
        expiredAt: trx.expiredAt.toISOString(),
        updatedAt: trx.updatedAt.toISOString(),
      },
      'Transaction details retrieved successfully'
    )
  );
});
