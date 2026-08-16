import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('4000').transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters').default('development_secret_key_neetpay_v1_1234567890abcdef'),
  ENCRYPTION_KEY: z.string().min(32, 'ENCRYPTION_KEY must be at least 32 characters').default('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
  CORS_ORIGIN: z.string().default('*'),
  WORKER_PAYMENT_POLL_INTERVAL_MS: z.string().default('5000').transform((val) => parseInt(val, 10)),
  WORKER_WEBHOOK_POLL_INTERVAL_MS: z.string().default('3000').transform((val) => parseInt(val, 10)),
  ADMIN_EMAIL: z.string().email().default('admin@neetpay.web.id'),
  ADMIN_PASSWORD: z.string().min(8).default('AdminSecurePassword2026!'),
  ADMIN_NAME: z.string().default('NeetPay Root Admin'),
});

export const env = envSchema.parse(process.env);
export type EnvConfig = z.infer<typeof envSchema>;
