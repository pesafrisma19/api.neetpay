import { Hono } from 'hono';
import crypto from 'crypto';
import { prisma } from '../../lib/prisma.js';
import { decryptAES } from '../../lib/encryption.js';
import { WebhookService } from './webhook.service.js';
import { logger } from '../../lib/logger.js';
import type { AppEnv } from '../../types/hono.js';

export const midtransInboundRouter = new Hono<AppEnv>();

/**
 * Parse Midtrans timestamp string ("YYYY-MM-DD HH:mm:ss" in WIB / UTC+7) into a valid UTC Date object.
 * Returns null if timestamp is missing, malformed, or invalid.
 */
function parseMidtransTimestamp(timeStr?: string): Date | null {
  if (!timeStr || typeof timeStr !== 'string') return null;

  const trimmed = timeStr.trim();

  if (trimmed.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(trimmed.replace(' ', 'T') + '+07:00');
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * POST /api/webhooks/providers/midtrans
 * Public Inbound Payment Notification receiver for GoPay Merchant Dynamic (Midtrans Payment Link/Snap)
 * Secured via SHA-512 signature verification using stored merchant Server Key
 */
midtransInboundRouter.post('/', async (c) => {
  let payload: any;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ status: 'error', message: 'Invalid JSON payload' }, 400);
  }

  // Acknowledge Midtrans dashboard test notifications / connected account health checks
  const isAccountTest =
    (payload.account_status || payload.account_id) &&
    !payload.transaction_status;

  const isPaymentNotificationTest =
    typeof payload.order_id === 'string' &&
    payload.order_id.startsWith('payment_notif_test_');

  if (isAccountTest || isPaymentNotificationTest) {
    return c.json(
      { status: 'success', message: 'Midtrans test notification acknowledged' },
      200
    );
  }

  const externalRefNo = payload.custom_field1;
  const orderId = payload.order_id;
  const statusCode = payload.status_code;
  const grossAmount = payload.gross_amount;
  const signatureKey = payload.signature_key;
  const transactionStatus = (payload.transaction_status || '').toLowerCase();
  const transactionId = payload.transaction_id;

  if (!externalRefNo) {
    logger.warn({ orderId, transactionStatus }, 'Inbound webhook missing custom_field1');
    return c.json({ status: 'error', message: 'custom_field1 missing' }, 400);
  }

  if (!orderId || !statusCode || !grossAmount || !signatureKey) {
    logger.warn({ externalRefNo }, 'Inbound webhook missing required signature fields');
    return c.json({ status: 'error', message: 'Missing required signature parameters' }, 400);
  }

  // 1. Resolve Transaction & Associated GoPay Merchant Dynamic Account
  const trx = await prisma.transaction.findUnique({
    where: { externalRefNo },
    include: {
      paymentAccount: {
        include: {
          goBizAccount: true,
          provider: true,
        },
      },
    },
  });

  if (!trx || trx.paymentAccount?.provider?.code !== 'GOBIZ_DYNAMIC') {
    logger.warn({ externalRefNo }, 'Transaction not found or provider mismatch in inbound webhook');
    return c.json({ status: 'error', message: 'Transaction not found or invalid provider' }, 404);
  }

  if (!trx.paymentAccount.goBizAccount?.credentialEncrypted) {
    logger.error({ externalRefNo, accountId: trx.paymentAccountId }, 'Stored credentials not found for dynamic account');
    return c.json({ status: 'error', message: 'Account credentials missing' }, 500);
  }

  // 2. Decrypt Server Key
  let serverKey = '';
  try {
    const decrypted = JSON.parse(decryptAES(trx.paymentAccount.goBizAccount.credentialEncrypted));
    serverKey = decrypted.serverKey;
  } catch (err: any) {
    logger.error({ externalRefNo, err: err.message }, 'Failed to decrypt credentials during webhook verification');
    return c.json({ status: 'error', message: 'Credential decryption failure' }, 500);
  }

  if (!serverKey) {
    return c.json({ status: 'error', message: 'Server Key not found' }, 500);
  }

  // 3. Verify SHA-512 Signature (order_id + status_code + gross_amount + ServerKey)
  const rawString = `${orderId}${statusCode}${grossAmount}${serverKey}`;
  const computedHex = crypto.createHash('sha512').update(rawString).digest('hex');

  const bufComputed = Buffer.from(computedHex, 'hex');
  const bufSignature = Buffer.from(signatureKey, 'hex');

  if (bufComputed.length !== bufSignature.length || !crypto.timingSafeEqual(bufComputed, bufSignature)) {
    logger.warn({ externalRefNo, orderId }, 'Midtrans webhook signature validation failed');
    return c.json({ status: 'error', message: 'Invalid signature key' }, 403);
  }

  logger.info(
    { externalRefNo, orderId, transactionStatus, transactionId },
    'Midtrans webhook signature verified successfully'
  );

  // 4. Handle Status Transitions
  if (transactionStatus === 'settlement') {
    // Optional Zero-Trust Confirmation via Gateway Status API
    try {
      const authHeader = `Basic ${Buffer.from(`${serverKey}:`).toString('base64')}`;
      const statusRes = await fetch(`https://api.midtrans.com/v2/${orderId}/status`, {
        headers: {
          'Accept': 'application/json',
          'Authorization': authHeader,
        },
      });

      if (statusRes.ok) {
        const confirmData = (await statusRes.json()) as any;
        if (confirmData.transaction_status !== 'settlement') {
          logger.warn(
            { orderId, gatewayStatus: confirmData.transaction_status },
            'Gateway status confirmation mismatch'
          );
          return c.json({ status: 'error', message: 'Status confirmation mismatch' }, 400);
        }
      }
    } catch (e: any) {
      logger.warn({ orderId, error: e.message }, 'Gateway confirmation check skipped due to network warning');
    }

    const paidAt =
      parseMidtransTimestamp(payload.settlement_time) ??
      parseMidtransTimestamp(payload.transaction_time) ??
      new Date();
    const providerRefId = transactionId || orderId;

    try {
      await prisma.$transaction(async (tx) => {
        // Lock transaction row
        const lockedTrx: Array<{ id: string; status: string; totalAmount: any }> =
          await tx.$queryRaw`
            SELECT "id", "status", "totalAmount"
            FROM "transactions"
            WHERE "id" = ${trx.id}
            LIMIT 1
            FOR UPDATE
          `;

        if (!lockedTrx || lockedTrx.length === 0) {
          return;
        }

        // Idempotency: If already marked PAID, do nothing
        if (lockedTrx[0].status === 'PAID') {
          logger.info({ trxId: trx.id, externalRefNo }, 'Transaction already settled (idempotent notification)');
          return;
        }

        // Record ProviderEvent
        await tx.providerEvent.create({
          data: {
            providerId: trx.providerId,
            paymentAccountId: trx.paymentAccountId,
            providerRefId,
            eventType: 'PAYMENT_SETTLEMENT',
            rawPayload: payload,
            isProcessed: true,
            processedAt: new Date(),
          },
        });

        // Update Transaction to PAID
        await tx.transaction.update({
          where: { id: trx.id },
          data: {
            status: 'PAID',
            paidAt,
          },
        });

        // Create TransactionEvent PAYMENT_DETECTED
        await tx.transactionEvent.create({
          data: {
            transactionId: trx.id,
            type: 'PAYMENT_DETECTED',
            fromStatus: 'PENDING',
            toStatus: 'PAID',
            metadata: {
              provider: 'GOBIZ_DYNAMIC',
              providerRefId,
              matchedAmount: Number(trx.totalAmount),
              paidAt: paidAt.toISOString(),
              settlementDetails: {
                transactionId: payload.transaction_id,
                orderId: payload.order_id,
                paymentType: payload.payment_type || 'qris',
                grossAmount: payload.gross_amount,
                acquirer: payload.acquirer,
              },
            },
          },
        });

        // Enqueue Outbound Webhook to Merchant Client
        await WebhookService.enqueueDelivery(tx, {
          userId: trx.userId,
          transaction: {
            ...trx,
            status: 'PAID',
            paidAt,
          },
          event: 'transaction.paid',
        });
      }, {
        maxWait: 10000,
        timeout: 20000,
      });

      logger.info({ externalRefNo, trxId: trx.id }, 'Transaction settled successfully via inbound webhook');
    } catch (err: any) {
      if (err.code === 'P2002') {
        // Unique constraint violation on providerEvent (already processed concurrently)
        logger.info({ externalRefNo }, 'Duplicate webhook event handled idempotently');
        return c.json({ status: 'success', message: 'Duplicate notification acknowledged' }, 200);
      }
      logger.error({ externalRefNo, err: err.message }, 'Failed to transition transaction to PAID');
      return c.json({ status: 'error', message: 'Transaction transition error' }, 500);
    }
  } else if (transactionStatus === 'expire') {
    try {
      await prisma.$transaction(async (tx) => {
        const lockedTrx: Array<{ id: string; status: string }> =
          await tx.$queryRaw`
            SELECT "id", "status"
            FROM "transactions"
            WHERE "id" = ${trx.id}
            LIMIT 1
            FOR UPDATE
          `;

        if (!lockedTrx || lockedTrx.length === 0 || lockedTrx[0].status !== 'PENDING') {
          return;
        }

        await tx.transaction.update({
          where: { id: trx.id },
          data: { status: 'EXPIRED' },
        });

        await tx.transactionEvent.create({
          data: {
            transactionId: trx.id,
            type: 'EXPIRED',
            fromStatus: 'PENDING',
            toStatus: 'EXPIRED',
            metadata: {
              reason: 'GATEWAY_PAYMENT_EXPIRED',
              orderId,
            },
          },
        });

        await WebhookService.enqueueDelivery(tx, {
          userId: trx.userId,
          transaction: {
            ...trx,
            status: 'EXPIRED',
          },
          event: 'transaction.expired',
        });
      }, {
        maxWait: 10000,
        timeout: 20000,
      });
    } catch (err: any) {
      logger.error({ externalRefNo, err: err.message }, 'Failed to transition transaction to EXPIRED');
    }
  } else if (transactionStatus === 'deny' || transactionStatus === 'cancel') {
    try {
      await prisma.$transaction(async (tx) => {
        const lockedTrx: Array<{ id: string; status: string }> =
          await tx.$queryRaw`
            SELECT "id", "status"
            FROM "transactions"
            WHERE "id" = ${trx.id}
            LIMIT 1
            FOR UPDATE
          `;

        if (!lockedTrx || lockedTrx.length === 0 || lockedTrx[0].status !== 'PENDING') {
          return;
        }

        await tx.transaction.update({
          where: { id: trx.id },
          data: { status: 'CANCELLED' },
        });

        await tx.transactionEvent.create({
          data: {
            transactionId: trx.id,
            type: 'CANCELLED',
            fromStatus: 'PENDING',
            toStatus: 'CANCELLED',
            metadata: {
              reason: `GATEWAY_${transactionStatus.toUpperCase()}`,
              orderId,
            },
          },
        });
      }, {
        maxWait: 10000,
        timeout: 20000,
      });
    } catch (err: any) {
      logger.error({ externalRefNo, err: err.message }, 'Failed to transition transaction to CANCELLED');
    }
  }

  return c.json({ status: 'success', message: 'Notification processed' }, 200);
});
