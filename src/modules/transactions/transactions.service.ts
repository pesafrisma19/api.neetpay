import crypto from 'crypto';
import { prisma } from '../../lib/prisma.js';
import { generateDynamicQRIS } from '../../lib/qris.js';
import { GoBizDynamicService } from '../payment-accounts/gobiz-dynamic.service.js';

export interface CreateTransactionInput {
  orderId: string;
  amount: number;
  paymentAccountId?: string;
  customerName?: string;
  customerEmail?: string;
  metadata?: Record<string, any>;
}

// V1 QRIS Transaction Expiry is strictly 5 minutes (300 seconds)
export const TRANSACTION_EXPIRY_MS = 5 * 60 * 1000;

export class TransactionService {
  /**
   * Generate clean unique external reference number (e.g. NP-20260816-A1B2C3)
   */
  private static generateRefNo(): string {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `NP-${today}-${randomHex}`;
  }

  /**
   * Calculate Fee based on user's PaymentFeeRule with explicit ceiling rounding for percentage fractions
   * Basis points: 100 = 1.00%, 250 = 2.50%
   * Rounding Rule: Fractional cents are rounded UP to the nearest integer Rupiah (Math.ceil)
   */
  static calculateFee(baseAmount: number, feeType: string, feeValue: number): number {
    if (feeType === 'FLAT') {
      return feeValue;
    }
    if (feeType === 'PERCENT') {
      // feeValue in basis points (e.g. 250 for 2.50%)
      // Rp 10.000 * 250 / 10.000 = 250
      // Rp 10.001 * 250 / 10.000 = 250.025 -> ceil = 251
      return Math.ceil((baseAmount * feeValue) / 10000);
    }
    return 0;
  }

  /**
   * Create Dynamic QRIS Transaction for Merchant API with Database-Level Row Locking
   */
  static async createTransaction(userId: string, input: CreateTransactionInput) {
    if (!input.orderId || !input.orderId.trim()) {
      throw new Error('ORDER_ID_REQUIRED');
    }
    if (!input.amount || input.amount <= 0) {
      throw new Error('INVALID_AMOUNT');
    }

    const orderIdClean = input.orderId.trim();

    // Execute within Prisma interactive transaction with PostgreSQL row-level locks
    const result = await prisma.$transaction(
      async (tx) => {
        // 1. Quota Concurrency Guard: Lock User Subscription Row in PostgreSQL
        const lockedSubs: Array<{ id: string; planId: string; currentPeriodStart: Date; currentPeriodEnd: Date }> =
          await tx.$queryRaw`
            SELECT "id", "planId", "currentPeriodStart", "currentPeriodEnd"
            FROM "subscriptions"
            WHERE "userId" = ${userId} AND "status" = 'ACTIVE'
            LIMIT 1
            FOR UPDATE
          `;

        if (!lockedSubs || lockedSubs.length === 0) {
          throw new Error('SUBSCRIPTION_INACTIVE');
        }

        const activeSub = lockedSubs[0];

        const plan = await tx.plan.findUnique({
          where: { id: activeSub.planId },
        });

        if (!plan) {
          throw new Error('SUBSCRIPTION_PLAN_NOT_FOUND');
        }

        // Check monthly quota under row lock
        const monthlyLimit = plan.monthlyTransactionLimit; // null = unlimited (PRO), 30 = FREE
        if (monthlyLimit !== null) {
          const periodUsage = await tx.transaction.count({
            where: {
              userId,
              createdAt: {
                gte: activeSub.currentPeriodStart,
                lte: activeSub.currentPeriodEnd,
              },
            },
          });

          if (periodUsage >= monthlyLimit) {
            throw new Error('MONTHLY_LIMIT_EXCEEDED');
          }
        }

        // 2. Resolve PaymentAccount & GoBizAccount
        const paymentAccount = await tx.paymentAccount.findFirst({
          where: {
            userId,
            isActive: true,
            status: 'ACTIVE',
            ...(input.paymentAccountId ? { id: input.paymentAccountId } : {}),
          },
          include: {
            goBizAccount: true,
            provider: true,
          },
        });

        if (!paymentAccount) {
          throw new Error('NO_ACTIVE_PAYMENT_ACCOUNT');
        }

        const isDynamic = paymentAccount.provider.code === 'GOBIZ_DYNAMIC';

        if (isDynamic) {
          const owner = await tx.user.findUnique({
            where: { id: userId },
            select: { hasDynamicAccess: true },
          });

          if (!owner?.hasDynamicAccess) {
            throw new Error('DYNAMIC_ACCESS_REQUIRED');
          }
        }

        if (!isDynamic && !paymentAccount.goBizAccount?.qrString) {
          throw new Error('BASE_QRIS_NOT_FOUND');
        }
        if (isDynamic && !paymentAccount.goBizAccount?.credentialEncrypted) {
          throw new Error('CREDENTIALS_NOT_FOUND');
        }

        // 3. Unique Total Amount & Collision Guard: Lock PaymentAccount row in PostgreSQL
        // Serializes parallel requests for the same payment account
        await tx.$queryRaw`
          SELECT "id" FROM "payment_accounts" WHERE "id" = ${paymentAccount.id} FOR UPDATE
        `;

        // 4. Validate Min & Max Limits
        const minAmount = paymentAccount.customMinAmount
          ? Number(paymentAccount.customMinAmount)
          : 1000;
        const maxAmount = paymentAccount.customMaxAmount
          ? Number(paymentAccount.customMaxAmount)
          : 10000000;

        if (input.amount < minAmount || input.amount > maxAmount) {
          throw new Error(
            `AMOUNT_OUT_OF_RANGE: Minimum is Rp ${minAmount.toLocaleString('id-ID')} and maximum is Rp ${maxAmount.toLocaleString('id-ID')}`
          );
        }

        // 5. Check Duplicate Active Order ID
        const existingPending = await tx.transaction.findFirst({
          where: {
            userId,
            merchantTradeNo: orderIdClean,
            status: 'PENDING',
          },
        });

        if (existingPending) {
          throw new Error('DUPLICATE_PENDING_ORDER');
        }

        // 6. Resolve Payment Method & Calculate Fee
        const qrisMethod = await tx.paymentMethod.findUnique({
          where: { code: 'QRIS' },
        });

        if (!qrisMethod) {
          throw new Error('PAYMENT_METHOD_NOT_FOUND');
        }

        const feeRule = await tx.paymentFeeRule.findUnique({
          where: {
            userId_paymentMethodId: {
              userId,
              paymentMethodId: qrisMethod.id,
            },
          },
        });

        const feeType = feeRule && feeRule.isEnabled ? feeRule.type : 'NONE';
        const feeValue = feeRule && feeRule.isEnabled ? feeRule.value : 0;
        const feeAmount = this.calculateFee(input.amount, feeType, feeValue);

        const baseTotal = input.amount + feeAmount;
        let uniqueCode = 0;
        let totalAmount = baseTotal;
        let qrisPayload: string | null = null;
        let qrisUrl: string | null = null;
        let checkoutUrl: string | null = null;
        let providerOrderId: string | null = null;
        let paymentLinkId: string | null = null;

        const externalRefNo = this.generateRefNo();

        if (isDynamic) {
          // GOBIZ_DYNAMIC: Exact amount (uniqueCode = 0), hosted checkout created provider-side + dynamic QR extraction
          uniqueCode = 0;
          totalAmount = baseTotal;

          const hosted = await GoBizDynamicService.createHostedCheckout(paymentAccount, {
            externalRefNo,
            totalAmount,
            customerName: input.customerName,
            customerEmail: input.customerEmail,
          });

          checkoutUrl = hosted.paymentUrl;
          providerOrderId = hosted.providerOrderId;
          paymentLinkId = hosted.paymentLinkId;
          qrisPayload = hosted.qrString || null;
          qrisUrl = hosted.qrisUrl || null;
        } else {
          // GOBIZ NATIVE: Existing algorithm
          const activePending = await tx.transaction.findMany({
            where: {
              paymentAccountId: paymentAccount.id,
              status: 'PENDING',
            },
            select: {
              totalAmount: true,
            },
          });

          const usedTotalAmounts = new Set(activePending.map((t) => Number(t.totalAmount)));
          const useUniqueCode = paymentAccount.useUniqueCode;

          if (useUniqueCode) {
            let allocatedCode: number | null = null;
            let allocatedTotal: number | null = null;

            for (let candidateCode = 1; candidateCode <= 999; candidateCode++) {
              const candidateTotal = baseTotal + candidateCode;
              if (!usedTotalAmounts.has(candidateTotal)) {
                allocatedCode = candidateCode;
                allocatedTotal = candidateTotal;
                break;
              }
            }

            if (!allocatedCode || !allocatedTotal) {
              throw new Error('NO_AVAILABLE_UNIQUE_AMOUNT: Transaction limit reached for this payment window. Please retry shortly.');
            }

            uniqueCode = allocatedCode;
            totalAmount = allocatedTotal;
          } else {
            if (usedTotalAmounts.has(baseTotal)) {
              throw new Error('DUPLICATE_PENDING_AMOUNT');
            }
            uniqueCode = 0;
            totalAmount = baseTotal;
          }

          qrisPayload = generateDynamicQRIS(
            paymentAccount.goBizAccount!.qrString!,
            totalAmount
          );
        }

        // 9. Deterministic Expiry Duration: 5 MINUTES (or 15 mins for hosted checkout)
        const createdAt = new Date();
        const expiryDuration = isDynamic ? 15 * 60 * 1000 : TRANSACTION_EXPIRY_MS;
        const expiredAt = new Date(createdAt.getTime() + expiryDuration);

        // 10. Persist Transaction & Event
        const trx = await tx.transaction.create({
          data: {
            merchantTradeNo: orderIdClean,
            externalRefNo,
            userId,
            paymentAccountId: paymentAccount.id,
            paymentMethodId: qrisMethod.id,
            providerId: paymentAccount.providerId,
            amount: input.amount,
            feeType,
            feeValue,
            feeAmount,
            uniqueCode,
            totalAmount,
            status: 'PENDING',
            qrisPayload,
            qrisUrl,
            createdAt,
            expiredAt,
            customerName: input.customerName || null,
            customerEmail: input.customerEmail || null,
            metadata: {
              ...(input.metadata || {}),
              provider: isDynamic ? 'GOBIZ_DYNAMIC' : 'GOBIZ',
              ...(checkoutUrl ? { checkoutUrl, providerOrderId, paymentLinkId } : {}),
            },
          },
        });

        await tx.transactionEvent.create({
          data: {
            transactionId: trx.id,
            type: 'TRANSACTION_CREATED',
            toStatus: 'PENDING',
            metadata: {
              amount: input.amount,
              feeAmount,
              uniqueCode,
              totalAmount,
              expiredAt,
              provider: isDynamic ? 'GOBIZ_DYNAMIC' : 'GOBIZ',
              method: 'QRIS',
              ...(checkoutUrl ? { checkoutUrl } : {}),
            },
          },
        });

        return trx;
      },
      {
        maxWait: 10000,
        timeout: 20000,
      }
    );

    return {
      id: result.id,
      reference: result.merchantTradeNo,
      external_ref_no: result.externalRefNo,
      status: result.status,
      amount: Number(result.amount),
      fee_amount: Number(result.feeAmount),
      unique_code: result.uniqueCode,
      total_amount: Number(result.totalAmount),
      qr_string: result.qrisPayload,
      qris_url: result.qrisUrl,
      checkout_url: (result.metadata as any)?.checkoutUrl || undefined,
      customer_name: result.customerName,
      customer_email: result.customerEmail,
      metadata: result.metadata,
      expires_at: result.expiredAt,
      created_at: result.createdAt,
    };
  }

  /**
   * Get Transaction Details by ID or External Ref No
   */
  static async getTransaction(userId: string, identifier: string) {
    const transaction = await prisma.transaction.findFirst({
      where: {
        userId,
        OR: [
          { id: identifier },
          { externalRefNo: identifier },
          { merchantTradeNo: identifier },
        ],
      },
      include: {
        paymentAccount: {
          select: {
            name: true,
          },
        },
        paymentMethod: {
          select: {
            code: true,
            name: true,
          },
        },
      },
    });

    if (!transaction) {
      throw new Error('TRANSACTION_NOT_FOUND');
    }

    return {
      id: transaction.id,
      reference: transaction.merchantTradeNo,
      external_ref_no: transaction.externalRefNo,
      status: transaction.status,
      payment_method: transaction.paymentMethod.code,
      account_name: transaction.paymentAccount.name,
      amount: Number(transaction.amount),
      fee_amount: Number(transaction.feeAmount),
      unique_code: transaction.uniqueCode,
      total_amount: Number(transaction.totalAmount),
      qr_string: transaction.qrisPayload,
      qris_url: transaction.qrisUrl,
      checkout_url: (transaction.metadata as any)?.checkoutUrl || undefined,
      customer_name: transaction.customerName,
      customer_email: transaction.customerEmail,
      metadata: transaction.metadata,
      paid_at: transaction.paidAt,
      expires_at: transaction.expiredAt,
      created_at: transaction.createdAt,
    };
  }
}
