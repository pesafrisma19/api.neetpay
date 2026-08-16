import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

logger.info(
  { pollIntervalMs: env.WORKER_WEBHOOK_POLL_INTERVAL_MS },
  'Webhook worker initialized (standby mode for V1 setup)'
);

// Webhook delivery & retry logic will be connected during webhook module phase
