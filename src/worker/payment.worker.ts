import { prisma } from '../lib/prisma.js';
import { GoBizClient, type GoBizJournalItem } from '../providers/gobiz/gobiz.client.js';
import { GoBizAdapter } from '../providers/gobiz/gobiz.adapter.js';
import { WebhookService } from '../modules/webhooks/webhook.service.js';
import { WebhookDispatcher } from './webhook.dispatcher.js';

// Reconciliation Grace Period after expiredAt (60 seconds)
export const RECONCILIATION_GRACE_MS = 60 * 1000;

export interface PaymentCycleResult {
  accountsPolled: number;
  transactionsChecked: number;
  matchedPaid: number;
  expiredCount: number;
}

export class PaymentWorker {
  private static isRunning = false;
  private static timer: NodeJS.Timeout | null = null;
  private static isProcessingCycle = false;

  /**
   * Execute one complete payment reconciliation cycle (GOBIZ Native journal polling)
   */
  static async processPaymentCycle(): Promise<PaymentCycleResult> {
    if (this.isProcessingCycle) {
      return { accountsPolled: 0, transactionsChecked: 0, matchedPaid: 0, expiredCount: 0 };
    }
    this.isProcessingCycle = true;

    try {
      const result: PaymentCycleResult = {
        accountsPolled: 0,
        transactionsChecked: 0,
        matchedPaid: 0,
        expiredCount: 0,
      };

      // 1. Find all active GOBIZ PaymentAccounts that have at least 1 PENDING transaction
      const accountsWithPending = await prisma.paymentAccount.findMany({
        where: {
          isActive: true,
          status: 'ACTIVE',
          provider: {
            code: 'GOBIZ',
          },
          transactions: {
            some: {
              status: 'PENDING',
            },
          },
        },
        include: {
          goBizAccount: true,
        },
      });

      // If > 0 PENDING accounts, process each PaymentAccount against GoBiz
      if (accountsWithPending.length > 0) {
        // 2. Process each PaymentAccount independently
        for (const paymentAccount of accountsWithPending) {
          if (!paymentAccount.goBizAccount) {
            continue;
          }

          // If account needs re-auth, do not bombard GoBiz
          if (paymentAccount.status === 'NEEDS_REAUTH') {
            continue;
          }

          // Fetch all PENDING transactions for this account
          const pendingTrxs = await prisma.transaction.findMany({
            where: {
              paymentAccountId: paymentAccount.id,
              status: 'PENDING',
            },
            orderBy: { createdAt: 'asc' },
          });

          if (pendingTrxs.length === 0) {
            continue;
          }

          result.accountsPolled++;
          result.transactionsChecked += pendingTrxs.length;

          console.log(
            `[Worker Poller] 🔄 Polling PaymentAccount ${paymentAccount.id} (${paymentAccount.goBizAccount.outletName}) | Active PENDING: ${pendingTrxs.length}`
          );

          // Determine journal query time range (earliest transaction createdAt - 30s buffer up to now)
          const earliestCreatedAt = pendingTrxs[0].createdAt;
          const startTime = new Date(earliestCreatedAt.getTime() - 30000);
          const endTime = new Date();

          // Fetch journals from GoBiz (EXACTLY 1 request per PaymentAccount per polling cycle)
          let journals: GoBizJournalItem[] = [];
          try {
            journals = await GoBizAdapter.executeWithSession(
              paymentAccount.goBizAccount.id,
              (accessToken) =>
                GoBizClient.fetchJournals(
                  accessToken,
                  paymentAccount.goBizAccount!.merchantId,
                  { startTime, endTime }
                )
            );
            console.log(
              `[Worker Poller] 📥 GoBiz /journals/search HTTP 200 OK | Received ${journals.length} eligible QRIS mutation(s)`
            );
          } catch (err: any) {
            console.warn(`[Worker Poller] ⚠️ GoBiz fetch error for account ${paymentAccount.id}:`, err.message);
            journals = [];
          }

          const creditJournals = journals.filter(
            (j) => j.type === 'CREDIT' && j.amount > 0
          );

          const matchedTrxIds = new Set<string>();

          // 3. Match Credit Mutations against PENDING Transactions
          for (const journal of creditJournals) {
            // Check if this mutation has already been used in ProviderEvent
            const existingProcessedEvent = await prisma.providerEvent.findFirst({
              where: {
                providerId: paymentAccount.providerId,
                providerRefId: journal.id,
                isProcessed: true,
              },
            });

            if (existingProcessedEvent) {
              continue; // Already processed mutation -> skip!
            }

            // Strict Payment Window:
            // Transaction time must be within [createdAt, expiredAt]
            const candidateTrx = pendingTrxs.find((trx) => {
              if (matchedTrxIds.has(trx.id)) return false;

              const isAmountMatch = Number(trx.totalAmount) === journal.amount;
              const isAfterCreation = journal.createdAt.getTime() >= trx.createdAt.getTime();
              const isBeforeExpiry = journal.createdAt.getTime() <= trx.expiredAt.getTime();

              return isAmountMatch && isAfterCreation && isBeforeExpiry;
            });

            if (candidateTrx) {
              const detectedAt = new Date();
              const latencySeconds = ((detectedAt.getTime() - journal.createdAt.getTime()) / 1000).toFixed(1);

              console.log(`\n========================================================================`);
              console.log(`[Worker Matcher] 💰 PAYMENT MATCH FOUND!`);
              console.log(`- Transaction ID : ${candidateTrx.id}`);
              console.log(`- Total Amount   : Rp ${Number(candidateTrx.totalAmount).toLocaleString('id-ID')}`);
              console.log(`- GoBiz Ref ID   : ${journal.id}`);
              console.log(`- Mutation Amount: Rp ${journal.amount.toLocaleString('id-ID')}`);
              console.log(`- Paid At        : ${journal.createdAt.toISOString()}`);
              console.log(`- Detected At    : ${detectedAt.toISOString()}`);
              console.log(`- Detection Delay: ${latencySeconds} seconds`);
              console.log(`========================================================================\n`);

              // Perform Atomic Transition PENDING -> PAID with database-level row lock
              const matched = await this.atomicTransitionPaid(
                paymentAccount.id,
                paymentAccount.providerId,
                candidateTrx,
                journal
              );

              if (matched) {
                matchedTrxIds.add(candidateTrx.id);
                result.matchedPaid++;
                console.log(`[Worker Matcher] ✅ State changed: PENDING -> PAID for Transaction ${candidateTrx.id}`);
              }
            }
          }

          // 4. Handle Expiration for Transactions past Reconciliation Grace Period (expiredAt + 60s)
          const now = new Date();
          for (const trx of pendingTrxs) {
            if (matchedTrxIds.has(trx.id)) continue;

            const graceDeadline = new Date(trx.expiredAt.getTime() + RECONCILIATION_GRACE_MS);
            if (now > graceDeadline) {
              const expired = await this.atomicTransitionExpired(trx);
              if (expired) {
                result.expiredCount++;
              }
            }
          }
        }
      }

      // 5. Process any pending webhook deliveries
      try {
        await WebhookDispatcher.processPendingDeliveries();
      } catch (webhookErr: any) {
        console.error('[PaymentWorker] Webhook dispatch cycle error:', webhookErr.message);
      }

      return result;
    } finally {
      this.isProcessingCycle = false;
    }
  }

  /**
   * Atomic transition PENDING -> PAID protected by PostgreSQL row locking & unique constraint
   */
  private static async atomicTransitionPaid(
    paymentAccountId: string,
    providerId: string,
    trx: any,
    journal: GoBizJournalItem
  ): Promise<boolean> {
    try {
      return await prisma.$transaction(async (tx) => {
        // 1. Lock Transaction row
        const lockedTrx: Array<{ id: string; status: string; totalAmount: any }> =
          await tx.$queryRaw`
            SELECT "id", "status", "totalAmount"
            FROM "transactions"
            WHERE "id" = ${trx.id} AND "status" = 'PENDING'
            LIMIT 1
            FOR UPDATE
          `;

        if (!lockedTrx || lockedTrx.length === 0 || lockedTrx[0].status !== 'PENDING') {
          return false; // Already transitioned by another process
        }

        // 2. Insert ProviderEvent with database unique constraint (providerId + providerRefId)
        // If another process inserted this providerRefId concurrently, database throws unique constraint error (P2002)
        await tx.providerEvent.create({
          data: {
            providerId,
            paymentAccountId,
            providerRefId: journal.id,
            eventType: 'CREDIT_MUTATION',
            rawPayload: journal.rawJournal || {
              journalId: journal.id,
              transactionId: journal.transactionId || null,
              amount: journal.amount,
              paymentMethod: journal.paymentMethod || 'QRIS',
              createdAt: journal.createdAt.toISOString(),
              customerName: journal.customerName || null,
            },
            isProcessed: true,
            processedAt: new Date(),
          },
        });

        // 3. Update Transaction Status to PAID
        await tx.transaction.update({
          where: { id: trx.id },
          data: {
            status: 'PAID',
            paidAt: journal.createdAt,
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
              provider: 'GOBIZ',
              providerRefId: journal.id,
              matchedAmount: Number(trx.totalAmount),
              paidAt: journal.createdAt.toISOString(),
              journalDetails: {
                journalId: journal.id,
                transactionId: journal.transactionId || null,
                paymentMethod: journal.paymentMethod || 'QRIS',
                grossAmount: journal.amount,
                customerName: journal.customerName || null,
              },
            },
          },
        });

        // 5. Enqueue WebhookDelivery for transaction.paid
        await WebhookService.enqueueDelivery(tx, {
          userId: trx.userId,
          transaction: {
            ...trx,
            status: 'PAID',
            paidAt: journal.createdAt,
          },
          event: 'transaction.paid',
        });

        return true;
      }, {
        maxWait: 10000,
        timeout: 20000,
      });
    } catch (err: any) {
      // Catch Prisma unique constraint violation (P2002) if duplicate provider event raced
      if (err.code === 'P2002') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Atomic transition PENDING -> EXPIRED after 60s reconciliation grace
   */
  private static async atomicTransitionExpired(trx: any): Promise<boolean> {
    return await prisma.$transaction(async (tx) => {
      // Lock Transaction row
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
            reason: 'PAYMENT_TIMEOUT_AFTER_GRACE',
            expiredAt: trx.expiredAt.toISOString(),
            graceSeconds: 60,
          },
        },
      });

      // Enqueue WebhookDelivery for transaction.expired
      await WebhookService.enqueueDelivery(tx, {
        userId: trx.userId,
        transaction: {
          ...trx,
          status: 'EXPIRED',
        },
        event: 'transaction.expired',
      });

      return true;
    }, {
      maxWait: 10000,
      timeout: 20000,
    });
  }

  /**
   * Start recurring background worker loop
   */
  static start(intervalMs = 5000) {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`[PaymentWorker] Started with polling interval ${intervalMs}ms`);

    const runLoop = async () => {
      if (!this.isRunning) return;

      try {
        await this.processPaymentCycle();
      } catch (err: any) {
        console.error('[PaymentWorker] Cycle error:', err.message);
      } finally {
        if (this.isRunning) {
          this.timer = setTimeout(runLoop, intervalMs);
        }
      }
    };

    runLoop();
  }

  /**
   * Stop background worker loop
   */
  static stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('[PaymentWorker] Stopped');
  }
}
