import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

logger.info(
  { pollIntervalMs: env.WORKER_PAYMENT_POLL_INTERVAL_MS },
  'Payment worker initialized (standby mode for V1 setup)'
);

// Worker polling logic will be connected during payment engine implementation phase
