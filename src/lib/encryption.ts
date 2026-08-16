import crypto from 'crypto';
import { env } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit Auth Tag

/**
 * Get 32-byte Buffer key from ENCRYPTION_KEY in env
 */
function getKey(): Buffer {
  const hex = env.ENCRYPTION_KEY;
  if (hex.length === 64) {
    return Buffer.from(hex, 'hex');
  }
  return crypto.createHash('sha256').update(hex).digest();
}

/**
 * Encrypt plain text using AES-256-GCM
 * Output format: <iv_hex>:<auth_tag_hex>:<cipher_hex>
 */
export function encryptAES(plainText: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt cipher text using AES-256-GCM
 */
export function decryptAES(cipherText: string): string {
  const key = getKey();
  const parts = cipherText.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format (expected iv:authTag:cipher)');
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
