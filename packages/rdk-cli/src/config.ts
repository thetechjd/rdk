// packages/rdk-cli/src/config.ts
// Manages ~/.rdk/config.json — node identity, encrypted secrets, settings.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export interface RDKConfig {
  // RDK node identity
  nodeId: string;
  apiKey: string;             // encrypted at rest
  centralApiUrl: string;

  // RetroDeck account
  retrodeckUserId?: string;
  retrodeckApiUrl?: string;
  retrodeckAccessToken?: string;  // encrypted at rest
  retrodeckRefreshToken?: string; // encrypted at rest
  emailVerified?: boolean;

  // Node settings
  plan: string;
  vaultAdapter: string;
  vaultPath: string;
  domain: string;
  walletAddress?: string;
  walletChain: string;
  mcpPort: number;
  createdAt: string;
}

const RDK_DIR = path.join(os.homedir(), '.rdk');
const CONFIG_PATH = path.join(RDK_DIR, 'config.json');
// Machine-specific key: hash of hostname + os username (deters casual reads of config)
const MACHINE_KEY = crypto.createHash('sha256').update(`${os.hostname()}${os.userInfo().username}`).digest();

export function ensureRDKDir(): void {
  if (!fs.existsSync(RDK_DIR)) fs.mkdirSync(RDK_DIR, { recursive: true, mode: 0o700 });
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

export function loadConfig(): RDKConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('RDK not initialized. Run: rdk init');
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as RDKConfig;
  raw.apiKey = decryptValue(raw.apiKey);
  if (raw.retrodeckAccessToken) raw.retrodeckAccessToken = decryptValue(raw.retrodeckAccessToken);
  if (raw.retrodeckRefreshToken) raw.retrodeckRefreshToken = decryptValue(raw.retrodeckRefreshToken);
  return raw;
}

export function saveConfig(config: RDKConfig): void {
  ensureRDKDir();
  const toSave: RDKConfig = {
    ...config,
    apiKey: encryptValue(config.apiKey),
    retrodeckAccessToken: config.retrodeckAccessToken
      ? encryptValue(config.retrodeckAccessToken)
      : undefined,
    retrodeckRefreshToken: config.retrodeckRefreshToken
      ? encryptValue(config.retrodeckRefreshToken)
      : undefined,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2), { mode: 0o600 });
}

export function updateConfig(partial: Partial<RDKConfig>): void {
  const existing = loadConfig();
  saveConfig({ ...existing, ...partial });
}

// AES-256-GCM encryption using machine-derived key
export function encryptValue(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MACHINE_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `enc:${Buffer.concat([iv, authTag, encrypted]).toString('base64')}`;
}

export function decryptValue(stored: string): string {
  if (!stored?.startsWith('enc:')) return stored; // plaintext fallback for dev
  try {
    const buf = Buffer.from(stored.slice(4), 'base64');
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', MACHINE_KEY, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final('utf-8');
  } catch {
    throw new Error('Failed to decrypt config value. Config may be corrupted or moved from another machine.');
  }
}
