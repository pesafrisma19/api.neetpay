import { prisma } from '../lib/prisma.js';
import { decryptAES } from '../lib/encryption.js';
import { WebhookService } from '../modules/webhooks/webhook.service.js';

export interface DynamicCycleResult {
  transactionsChecked: number;
  matchedPaid: number;
  expiredCount: number;
  errorsCount: number;
}

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

export class DynamicPaymentWorker {
  private static isProcessingCycle = false;

  /**
   * Execute one complete dynamic QRIS (Midtrans GOBIZ_DYNAMIC) status check cycle
   */
  static async processDynamicPaymentCycle(): Promise<DynamicCycleResult> {
    if (this.isProcessingCycle) {
      return { transactionsChecked: 0, matchedPaid: 0, expiredCount: 0, errorsCount: 0 };
    }
    this.isProcessingCycle = true;

    const result: DynamicCycleResult = {
      transactionsChecked: 0,
      matchedPaid: 0,
      expiredCount: 0,
      errorsCount: 0,
    };

    try {
      // 1. Query pending GOBIZ_DYNAMIC transactions
      const pendingDynamicTrxs = await prisma.transaction.findMany({
        where: {
          status: 'PENDING',
          provider: {
            code: 'GOBIZ_DYNAMIC',
          },
        },
        include: {
          paymentAccount: {
            include: {
              goBizAccount: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });

      if (pendingDynamicTrxs.length === 0) {
        return result;
      }

      result.transactionsChecked = pendingDynamicTrxs.length;

      for (const trx of pendingDynamicTrxs) {
        const orderId = trx.externalRefNo;
        const paymentAccount = trx.paymentAccount;
        const now = new Date();
        const isPastExpiry = now > new Date(trx.expiredAt);

        if (!paymentAccount?.goBizAccount?.credentialEncrypted) {
          if (isPastExpiry) {
            await this.atomicTransitionExpired(trx, { order_id: orderId });
            console.log(`[DynamicWorker] ⌛ Stale transaction ${orderId} without credentials transitioned to EXPIRED`);
            result.expiredCount++;
          } else {
            console.warn(
              `[DynamicWorker] ⚠️ Missing credentials for transaction ${trx.id} (Account: ${trx.paymentAccountId})`
            );
            result.errorsCount++;
          }
          continue;
        }

        // 2. Decrypt Server Key safely
        let serverKey = '';
        try {
          const decrypted = JSON.parse(decryptAES(paymentAccount.goBizAccount.credentialEncrypted));
          serverKey = decrypted.serverKey;
        } catch (err: any) {
          if (isPastExpiry) {
            await this.atomicTransitionExpired(trx, { order_id: orderId });
            console.log(`[DynamicWorker] ⌛ Stale transaction ${orderId} (expired ${trx.expiredAt.toISOString()}) transitioned to EXPIRED`);
            result.expiredCount++;
          } else {
            console.error(
              `[DynamicWorker] ⚠️ Failed to decrypt credentials for transaction ${trx.id}: ${err.message}`
            );
            result.errorsCount++;
          }
          continue;
        }

        if (!serverKey) {
          if (isPastExpiry) {
            await this.atomicTransitionExpired(trx, { order_id: orderId });
            console.log(`[DynamicWorker] ⌛ Stale transaction ${orderId} without serverKey transitioned to EXPIRED`);
            result.expiredCount++;
          } else {
            console.warn(`[DynamicWorker] ⚠️ Server key missing in decrypted credentials for transaction ${trx.id}`);
            result.errorsCount++;
          }
          continue;
        }

        // 3. Query Midtrans Status API
        let midtransData: any = null;
        try {
          const authHeader = `Basic ${Buffer.from(`${serverKey}:`).toString('base64')}`;
          const res = await fetch(`https://api.midtrans.com/v2/${orderId}/status`, {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Authorization: authHeader,
            },
          });

          midtransData = await res.json();

          if (res.status === 404 || midtransData.status_code === '404') {
            if (isPastExpiry) {
              await this.atomicTransitionExpired(trx, { order_id: orderId });
              console.log(`[DynamicWorker] ⌛ Expired transaction ${orderId} (404 in gateway) transitioned to EXPIRED`);
              result.expiredCount++;
            }
            continue;
          }

          if (!res.ok && res.status >= 500) {
            console.warn(`[DynamicWorker] ⚠️ Midtrans API returned HTTP ${res.status} for order ${orderId}`);
            result.errorsCount++;
            continue;
          }
        } catch (fetchErr: any) {
          console.warn(`[DynamicWorker] ⚠️ Network error checking status for order ${orderId}: ${fetchErr.message}`);
          result.errorsCount++;
          continue;
        }

        const txStatus = (midtransData.transaction_status || '').toLowerCase();
        const statusCode = midtransData.status_code;

        // 4. Map Gateway Status & Reconcile
        if (
          txStatus === 'settlement' ||
          (txStatus === 'capture' && midtransData.fraud_status === 'accept' && statusCode === '200')
        ) {
          console.log(`[DynamicWorker] 💰 Settlement detected for order ${orderId} (${trx.merchantTradeNo})`);
          const transitioned = await this.atomicTransitionPaid(trx, midtransData);
          if (transitioned) {
            result.matchedPaid++;
            console.log(`[DynamicWorker] ✅ Order ${orderId} successfully transitioned to PAID`);
          } else {
            console.log(`[DynamicWorker] ℹ️ Order ${orderId} already transitioned (idempotent skip)`);
          }
        } else if (txStatus === 'expire') {
          console.log(`[DynamicWorker] ⌛ Expiration detected for order ${orderId} (${trx.merchantTradeNo})`);
          const transitioned = await this.atomicTransitionExpired(trx, midtransData);
          if (transitioned) {
            result.expiredCount++;
            console.log(`[DynamicWorker] ⌛ Order ${orderId} successfully transitioned to EXPIRED`);
          }
        } else if (txStatus === 'pending') {
          // Still awaiting payment -> keep pending
          continue;
        } else {
          // Unhandled gateway status (e.g. deny, cancel, refund) -> log only, do not guess
          console.log(
            `[DynamicWorker] ℹ️ Unhandled status '${txStatus}' for order ${orderId} (status_code: ${statusCode})`
          );
        }
      }

      return result;
    } catch (cycleErr: any) {
      console.error('[DynamicWorker] Cycle error:', cycleErr.message);
      return result;
    } finally {
      this.isProcessingCycle = false;
    }
  }

  /**
   * Atomic transition PENDING -> PAID protected by PostgreSQL row locking & unique constraint
   */
  private static async atomicTransitionPaid(trx: any, midtransData: any): Promise<boolean> {
    const paidAt =
      parseMidtransTimestamp(midtransData.settlement_time) ??
      parseMidtransTimestamp(midtransData.transaction_time) ??
      new Date();

    const providerRefId = midtransData.transaction_id || midtransData.order_id || trx.externalRefNo;

    try {
      return await prisma.$transaction(
        async (tx) => {
          // 1. Lock Transaction row to prevent concurrent race condition with Webhook
          const lockedTrx: Array<{ id: string; status: string; totalAmount: any }> =
            await tx.$queryRaw`
              SELECT "id", "status", "totalAmount"
              FROM "transactions"
              WHERE "id" = ${trx.id} AND "status" = 'PENDING'
              LIMIT 1
              FOR UPDATE
            `;

          if (!lockedTrx || lockedTrx.length === 0 || lockedTrx[0].status !== 'PENDING') {
            return false; // Already transitioned by inbound webhook or previous cycle
          }

          // 2. Insert ProviderEvent with database unique constraint (providerId + providerRefId)
          await tx.providerEvent.create({
            data: {
              providerId: trx.providerId,
              paymentAccountId: trx.paymentAccountId,
              providerRefId,
              eventType: 'PAYMENT_SETTLEMENT',
              rawPayload: midtransData,
              isProcessed: true,
              processedAt: new Date(),
            },
          });

          // 3. Update Transaction Status to PAID
          await tx.transaction.update({
            where: { id: trx.id },
            data: {
              status: 'PAID',
              paidAt,
            },
          });

          // 4. Create TransactionEvent PAYMENT_DETECTED
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
                source: 'FALLBACK_POLLER',
                settlementDetails: {
                  transactionId: midtransData.transaction_id,
                  orderId: midtransData.order_id,
                  paymentType: midtransData.payment_type || 'qris',
                  grossAmount: midtransData.gross_amount,
                  acquirer: midtransData.acquirer,
                },
              },
            },
          });

          // 5. Enqueue WebhookDelivery for transaction.paid to merchant
          await WebhookService.enqueueDelivery(tx, {
            userId: trx.userId,
            transaction: {
              ...trx,
              status: 'PAID',
              paidAt,
            },
            event: 'transaction.paid',
          });

          return true;
        },
        {
          maxWait: 10000,
          timeout: 20000,
        }
      );
    } catch (err: any) {
      // Catch Prisma unique constraint violation (P2002) if duplicate provider event raced with inbound webhook
      if (err.code === 'P2002') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Atomic transition PENDING -> EXPIRED
   */
  private static async atomicTransitionExpired(trx: any, midtransData: any): Promise<boolean> {
    return await prisma.$transaction(
      async (tx) => {
        // 1. Lock Transaction row
        const lockedTrx: Array<{ id: string; status: string }> =
          await tx.$queryRaw`
            SELECT "id", "status"
            FROM "transactions"
            WHERE "id" = ${trx.id} AND "status" = 'PENDING'
            LIMIT 1
            FOR UPDATE
          `;

        if (!lockedTrx || lockedTrx.length === 0 || lockedTrx[0].status !== 'PENDING') {
          return false;
        }

        // 2. Update Transaction status to EXPIRED
        await tx.transaction.update({
          where: { id: trx.id },
          data: { status: 'EXPIRED' },
        });

        // 3. Create TransactionEvent EXPIRED
        await tx.transactionEvent.create({
          data: {
            transactionId: trx.id,
            type: 'EXPIRED',
            fromStatus: 'PENDING',
            toStatus: 'EXPIRED',
            metadata: {
              reason: 'GATEWAY_PAYMENT_EXPIRED',
              orderId: midtransData.order_id || trx.externalRefNo,
              source: 'FALLBACK_POLLER',
            },
          },
        });

        // 4. Enqueue WebhookDelivery for transaction.expired
        await WebhookService.enqueueDelivery(tx, {
          userId: trx.userId,
          transaction: {
            ...trx,
            status: 'EXPIRED',
          },
          event: 'transaction.expired',
        });

        return true;
      },
      {
        maxWait: 10000,
        timeout: 20000,
      }
    );
  }
}
