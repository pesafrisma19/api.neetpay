import { PaymentWorker } from './worker/payment.worker.js';

console.log('========================================================================');
console.log('🚀 NEETPAY V1 PAYMENT WORKER ENGINE');
console.log('========================================================================');

const POLLING_INTERVAL_MS = 5000; // 5 seconds per polling cycle

// Start Payment Worker
PaymentWorker.start(POLLING_INTERVAL_MS);

// Handle Graceful Shutdown
const shutdown = (signal: string) => {
  console.log(`\n[Worker Process] Received ${signal}. Gracefully shutting down...`);
  PaymentWorker.stop();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
