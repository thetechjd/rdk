// packages/rdk-core/src/crypto.ts
// AES-256-GCM vault encryption. Node.js built-in crypto only — no external deps.

import crypto from 'crypto';

const ALGORITHM  = 'aes-256-gcm';
const KEY_LENGTH = 32;  // 256 bits
const IV_LENGTH  = 12;  // 96 bits — standard for GCM
const TAG_LENGTH = 16;  // 128-bit auth tag

export type VaultKey = Buffer;

export function generateVaultKey(): VaultKey {
  return crypto.randomBytes(KEY_LENGTH);
}

export function keyToHex(key: VaultKey): string {
  return key.toString('hex');
}

export function keyFromHex(hex: string): VaultKey {
  return Buffer.from(hex, 'hex');
}

/** Encrypt plaintext with AES-256-GCM. Returns base64(iv + tag + ciphertext). */
export function encrypt(plaintext: string, key: VaultKey): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/** Decrypt AES-256-GCM ciphertext produced by encrypt(). */
export function decrypt(ciphertext: string, key: VaultKey): string {
  const combined  = Buffer.from(ciphertext, 'base64');
  const iv        = combined.subarray(0, IV_LENGTH);
  const tag       = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return decipher.update(encrypted) + decipher.final('utf8');
}

/** Wrap the vault key with an invite-code-derived transfer key for sharing. */
export function createKeyShare(vaultKey: VaultKey, inviteCode: string): string {
  const transferKey = deriveTransferKey(inviteCode);
  return encrypt(keyToHex(vaultKey), transferKey);
}

/** Unwrap a key share received from a vault owner. */
export function unwrapKeyShare(keyShare: string, inviteCode: string): VaultKey {
  const transferKey = deriveTransferKey(inviteCode);
  const hex = decrypt(keyShare, transferKey);
  return keyFromHex(hex);
}

function deriveTransferKey(inviteCode: string): VaultKey {
  const salt = Buffer.from('rdk-key-share-v1', 'utf8');
  return crypto.pbkdf2Sync(inviteCode, salt, 100_000, KEY_LENGTH, 'sha256');
}
