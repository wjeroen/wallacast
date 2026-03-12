import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const PREFIX = 'enc:';

function getKey(): Buffer | null {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex) return null;
  if (keyHex.length !== 64) {
    console.error('[Encryption] ENCRYPTION_KEY must be 64 hex characters (32 bytes). Encryption disabled.');
    return null;
  }
  return Buffer.from(keyHex, 'hex');
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext; // No key = store as plaintext

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: enc:<iv_hex>:<ciphertext_hex>:<tag_hex>
  return PREFIX + iv.toString('hex') + ':' + encrypted.toString('hex') + ':' + tag.toString('hex');
}

export function decrypt(value: string): string {
  if (!value.startsWith(PREFIX)) return value; // Plaintext, return as-is

  const key = getKey();
  if (!key) {
    console.error('[Encryption] Encrypted value found but ENCRYPTION_KEY is not set. Cannot decrypt.');
    return value; // Return the raw enc: string — API calls will fail, but app won't crash
  }

  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    console.error('[Encryption] Malformed encrypted value, returning as-is');
    return value;
  }

  const [ivHex, ciphertextHex, tagHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}
