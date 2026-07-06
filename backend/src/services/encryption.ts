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
  // Double-wrap guard: an already-encrypted value (starts with the 'enc:' prefix) is returned
  // unchanged. A decrypt failure or a round-tripped Settings form must never cause an
  // already-encrypted value to be wrapped a second time, which would permanently corrupt the secret.
  if (plaintext.startsWith(PREFIX)) return plaintext;

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

  // On any failure below we return '' (empty string), NOT the raw stored value. The backend
  // treats '' as "not configured" everywhere (the key-remove button also stores ''), so the
  // affected feature degrades to cleanly unavailable and the Settings page still loads.
  // Returning the raw 'enc:iv:ct:tag' string instead would be dangerous, callers would send it
  // upstream as an API key or Wallabag password (confusing 401/403s), and if it were ever
  // re-saved it would get encrypted a second time, permanently corrupting the secret.
  const key = getKey();
  if (!key) {
    console.error('[Encryption] Encrypted value found but ENCRYPTION_KEY is not set, cannot decrypt. This secret will appear unconfigured until it is re-entered in Settings.');
    return '';
  }

  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    console.error('[Encryption] Malformed encrypted value, cannot decrypt. This secret will appear unconfigured until it is re-entered in Settings.');
    return '';
  }

  const [ivHex, ciphertextHex, tagHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch {
    // Auth-tag mismatch throws here, which happens when the ENCRYPTION_KEY is wrong or was
    // rotated. Degrade gracefully like the paths above instead of 500-ing every settings read.
    console.error('[Encryption] Failed to decrypt value, the ENCRYPTION_KEY is wrong or was rotated. This secret will appear unconfigured until it is re-entered in Settings.');
    return '';
  }
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}
