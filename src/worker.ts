import { PaymentWorker } from './worker/payment.worker.js';
import { DynamicPaymentWorker } from './worker/dynamic-payment.worker.js';
import { WebhookDispatcher } from './worker/webhook.dispatcher.js';

console.log('========================================================================');
console.log('🚀 NEETPAY V1 PAYMENT WORKER ENGINE');
console.log('========================================================================');

const POLLING_INTERVAL_MS = 5000; // 5 seconds per polling cycle
let isRunning = false;
let timer: NodeJS.Timeout | null = null;
let isProcessing = false;

async function runWorkerCycle() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    // 1. Static QRIS Reconciliation (GoBiz Journal Polling)
    await PaymentWorker.processPaymentCycle();

    // 2. Dynamic QRIS Fallback Reconciliation (Midtrans Status API Polling)
    await DynamicPaymentWorker.processDynamicPaymentCycle();

    // 3. Outbound Webhook Delivery Dispatcher to Merchant Clients
    await WebhookDispatcher.processPendingDeliveries();
  } catch (err: any) {
    console.error('[Worker Engine] Cycle error:', err.message);
  } finally {
    isProcessing = false;
  }
}

function start() {
  if (isRunning) return;
  isRunning = true;
  console.log(`[Worker Engine] Started with polling interval ${POLLING_INTERVAL_MS}ms`);

  const loop = async () => {
    if (!isRunning) return;
    try {
      await runWorkerCycle();
    } finally {
      if (isRunning) {
        timer = setTimeout(loop, POLLING_INTERVAL_MS);
      }
    }
  };

  loop();
}

function stop() {
  isRunning = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  console.log('[Worker Engine] Stopped');
}

start();

// Handle Graceful Shutdown
const shutdown = (signal: string) => {
  console.log(`\n[Worker Process] Received ${signal}. Gracefully shutting down...`);
  stop();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

