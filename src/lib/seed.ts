import { prisma } from './prisma.js';
import { logger } from './logger.js';

export async function runBaseSeed() {
  logger.info('🌱 Starting NeetPay V1 base seed...');

  // 1. Seed Plan FREE
  const freePlan = await prisma.plan.upsert({
    where: { code: 'FREE' },
    update: {
      name: 'Free',
      priceMonthly: 0,
      monthlyTransactionLimit: 30,
      paymentAccountLimit: 1,
      isActive: true,
      isPublic: true,
    },
    create: {
      code: 'FREE',
      name: 'Free',
      priceMonthly: 0,
      monthlyTransactionLimit: 30,
      paymentAccountLimit: 1,
      isActive: true,
      isPublic: true,
      features: {
        analytics: 'basic',
        support: 'community',
      },
    },
  });
  logger.info({ plan: freePlan.code }, '✓ Plan FREE seeded');

  // 2. Seed Plan PRO
  const proPlan = await prisma.plan.upsert({
    where: { code: 'PRO' },
    update: {
      name: 'Pro',
      priceMonthly: 20000,
      monthlyTransactionLimit: null, // Unlimited
      paymentAccountLimit: 3,
      isActive: true,
      isPublic: true,
    },
    create: {
      code: 'PRO',
      name: 'Pro',
      priceMonthly: 20000,
      monthlyTransactionLimit: null, // Unlimited
      paymentAccountLimit: 3,
      isActive: true,
      isPublic: true,
      features: {
        analytics: 'advanced',
        support: 'priority',
        customWebhookRetry: true,
      },
    },
  });
  logger.info({ plan: proPlan.code }, '✓ Plan PRO seeded');

  // 3. Seed Payment Provider: GOBIZ
  const goBizProvider = await prisma.paymentProvider.upsert({
    where: { code: 'GOBIZ' },
    update: {
      name: 'GoBiz',
      isEnabled: true,
      isMaintenance: false,
    },
    create: {
      code: 'GOBIZ',
      name: 'GoBiz',
      isEnabled: true,
      isMaintenance: false,
    },
  });
  logger.info({ provider: goBizProvider.code }, '✓ Payment Provider GOBIZ seeded');

  // 4. Seed Payment Method: QRIS
  const qrisMethod = await prisma.paymentMethod.upsert({
    where: { code: 'QRIS' },
    update: {
      name: 'QRIS',
      type: 'QRIS',
      isEnabled: true,
    },
    create: {
      code: 'QRIS',
      name: 'QRIS',
      type: 'QRIS',
      isEnabled: true,
    },
  });
  logger.info({ method: qrisMethod.code }, '✓ Payment Method QRIS seeded');

  // 5. Seed ProviderPaymentMethod: GOBIZ -> QRIS
  const providerMethod = await prisma.providerPaymentMethod.upsert({
    where: {
      providerId_paymentMethodId: {
        providerId: goBizProvider.id,
        paymentMethodId: qrisMethod.id,
      },
    },
    update: {
      providerMethodCode: 'GOBIZ_QRIS',
      isEnabled: true,
      minAmount: 1000,
      maxAmount: 10000000,
    },
    create: {
      providerId: goBizProvider.id,
      paymentMethodId: qrisMethod.id,
      providerMethodCode: 'GOBIZ_QRIS',
      isEnabled: true,
      minAmount: 1000,
      maxAmount: 10000000,
      providerFeePercent: 0,
      providerFeeFlat: 0,
    },
  });
  logger.info({ mapping: `${goBizProvider.code} -> ${qrisMethod.code}` }, '✓ ProviderPaymentMethod GOBIZ-QRIS mapped');

  logger.info('🎉 NeetPay V1 base seed completed successfully!');
}

// Execute directly if run via CLI
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runBaseSeed()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'Failed to run base seed');
      process.exit(1);
    });
}
