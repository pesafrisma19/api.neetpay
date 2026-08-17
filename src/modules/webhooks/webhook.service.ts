import { prisma } from '../../lib/prisma.js';
import { encryptAES, decryptAES } from '../../lib/encryption.js';
import { WebhookSecurity } from './webhook.security.js';
import { Prisma } from '@prisma/client';

export interface WebhookConfigResponse {
  id: string;
  url: string;
  isEnabled: boolean;
  events: string[];
  secretMasked: string;
  createdAt: Date;
  updatedAt: Date;
}

export class WebhookService {
  /**
   * Retrieves WebhookConfig for a user with secret masked
   */
  public static async getConfig(userId: string): Promise<WebhookConfigResponse | null> {
    const config = await prisma.webhookConfig.findUnique({
      where: { userId },
    });

    if (!config) return null;

    let rawSecret = '';
    try {
      rawSecret = decryptAES(config.secretKey);
    } catch {
      rawSecret = config.secretKey;
    }

    return {
      id: config.id,
      url: config.url,
      isEnabled: config.isEnabled,
      events: config.events,
      secretMasked: WebhookSecurity.maskSecret(rawSecret),
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }

  /**
   * Updates or creates WebhookConfig. If creating for the first time, returns the raw secret once.
   */
  public static async updateConfig(
    userId: string,
    data: { url: string; isEnabled?: boolean }
  ): Promise<{ config: WebhookConfigResponse; rawSecret?: string }> {
    const validation = WebhookSecurity.validateUrl(data.url);
    if (!validation.isValid) {
      throw new Error(`INVALID_WEBHOOK_URL: ${validation.error}`);
    }

    const existing = await prisma.webhookConfig.findUnique({
      where: { userId },
    });

    if (existing) {
      const updated = await prisma.webhookConfig.update({
        where: { userId },
        data: {
          url: data.url,
          isEnabled: data.isEnabled !== undefined ? data.isEnabled : existing.isEnabled,
        },
      });

      let rawSecret = '';
      try {
        rawSecret = decryptAES(updated.secretKey);
      } catch {
        rawSecret = updated.secretKey;
      }

      return {
        config: {
          id: updated.id,
          url: updated.url,
          isEnabled: updated.isEnabled,
          events: updated.events,
          secretMasked: WebhookSecurity.maskSecret(rawSecret),
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        },
      };
    } else {
      // First time setup: Generate new secret and return raw secret once
      const rawSecret = WebhookSecurity.generateSecret();
      const encryptedSecret = encryptAES(rawSecret);

      const created = await prisma.webhookConfig.create({
        data: {
          userId,
          url: data.url,
          secretKey: encryptedSecret,
          isEnabled: data.isEnabled !== undefined ? data.isEnabled : true,
          events: ['transaction.paid', 'transaction.expired'],
        },
      });

      return {
        config: {
          id: created.id,
          url: created.url,
          isEnabled: created.isEnabled,
          events: created.events,
          secretMasked: WebhookSecurity.maskSecret(rawSecret),
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
        },
        rawSecret,
      };
    }
  }

  /**
   * Rotates webhook secret and returns the new raw secret once
   */
  public static async rotateSecret(userId: string): Promise<{ secret: string; maskedSecret: string }> {
    const rawSecret = WebhookSecurity.generateSecret();
    const encryptedSecret = encryptAES(rawSecret);

    const existing = await prisma.webhookConfig.findUnique({ where: { userId } });

    if (existing) {
      await prisma.webhookConfig.update({
        where: { userId },
        data: { secretKey: encryptedSecret },
      });
    } else {
      await prisma.webhookConfig.create({
        data: {
          userId,
          url: '',
          secretKey: encryptedSecret,
          isEnabled: false,
        },
      });
    }

    return {
      secret: rawSecret,
      maskedSecret: WebhookSecurity.maskSecret(rawSecret),
    };
  }

  /**
   * Builds standardized, clean JSON payload for webhook events
   */
  public static buildPayload(
    event: 'transaction.paid' | 'transaction.expired' | 'webhook.test',
    transaction?: any
  ): any {
    const now = new Date().toISOString();

    if (event === 'webhook.test') {
      return {
        event: 'webhook.test',
        created_at: now,
        data: {
          message: 'NeetPay webhook test',
        },
      };
    }

    if (!transaction) {
      throw new Error('Transaction data required for transaction event payload');
    }

    return {
      event,
      created_at: now,
      data: {
        id: transaction.id,
        reference: transaction.merchantTradeNo,
        status: event === 'transaction.paid' ? 'PAID' : 'EXPIRED',
        amount: Number(transaction.amount),
        fee_amount: Number(transaction.feeAmount),
        unique_code: transaction.uniqueCode,
        total_amount: Number(transaction.totalAmount),
        paid_at: event === 'transaction.paid' && transaction.paidAt ? transaction.paidAt.toISOString() : null,
        created_at: transaction.createdAt.toISOString(),
        expires_at: transaction.expiredAt.toISOString(),
      },
    };
  }

  /**
   * Enqueues WebhookDelivery if User has an active, enabled WebhookConfig.
   * Safe against duplicates via DB constraint @@unique([transactionId, event]).
   */
  public static async enqueueDelivery(
    dbClient: Prisma.TransactionClient | typeof prisma,
    params: {
      userId: string;
      transaction: any;
      event: 'transaction.paid' | 'transaction.expired';
    }
  ): Promise<any | null> {
    const { userId, transaction, event } = params;

    // Check if user has active webhook config
    const config = await dbClient.webhookConfig.findUnique({
      where: { userId },
    });

    if (!config || !config.isEnabled || !config.url || config.url.trim() === '') {
      return null; // No webhook configured or disabled -> Silent skip
    }

    const payload = this.buildPayload(event, transaction);

    try {
      const delivery = await dbClient.webhookDelivery.create({
        data: {
          userId,
          transactionId: transaction.id,
          event,
          payload,
          status: 'PENDING',
          nextRetryAt: new Date(), // Immediate dispatch
          attemptsCount: 0,
        },
      });

      return delivery;
    } catch (err: any) {
      if (err.code === 'P2002') {
        // Duplicate delivery for this (transactionId, event) -> Already enqueued
        return null;
      }
      throw err;
    }
  }
}
