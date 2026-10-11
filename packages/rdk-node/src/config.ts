// packages/rdk-node/src/config.ts
// Manages ~/.rdk/config.json — node identity, encrypted secrets, settings.
// The single canonical config layer: the CLI, @retrodeck/mcp, and the desktop
// app all import this instead of each keeping their own copy + machine-key crypto.

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
  /** Email this node was set up with. Used to register on RDK Central when no
   *  RetroDeck session is available to read one from. */
  ownerEmail?: string;

  // Node settings
  plan: string;
  vaultAdapter: string;
  vaultPath: string;
  domain: string;
  walletAddress?: string;
  walletChain: string;
  mcpPort: number;
  createdAt: string;

  // Auto-sync settings
  autoSync?: boolean;              // default: true
  syncIntervalMinutes?: number;    // default: 5
  publicFolders?: string[];        // relative paths within vault that are public

  /** Default visibility for new indexing (re-index, batch flows). Explicit
   *  per-action choices (drag-drop dialog, publish commands) always win. */
  defaultVisibility?: 'private' | 'public';

  /** Standing authorization for `rdk query` to retrieve without a human choosing.
   *  Off by default: retrieval settles a tip, so spending is opt-in. An agent
   *  operating under standing authorization sets this once instead of passing
   *  --auto on every call. Per-invocation flags always win. */
  queryAutoRetrieve?: boolean;
  /** Ceiling, in USDC, on a tip that may be settled without a human choosing.
   *  Applies to non-interactive retrieval only — an interactive picker shows the
   *  tip next to every choice, so the human has already seen the price. */
  queryMaxTipUsdc?: number;

  // Encryption
  vaultKeyHex?: string;                      // own vault key (encrypted at rest)
  sharedVaultKeys?: Record<string, string>;  // ownerNodeId → hex key (encrypted at rest)
}

const DEFAULT_RDK_DIR = process.env.RDK_HOME ?? path.join(os.homedir(), '.rdk');
const CONFIG_PATH = process.env.RDK_CONFIG_PATH
  ? path.resolve(process.env.RDK_CONFIG_PATH)
  : path.join(DEFAULT_RDK_DIR, 'config.json');
const RDK_DIR = path.dirname(CONFIG_PATH);
/** Public Central endpoint. `api.rdk.network` was documented but never had DNS;
 * production has always been routed by nginx at rdk.retrodeck.ai. */
export const DEFAULT_CENTRAL_API_URL = 'https://rdk.retrodeck.ai';
const DEAD_CENTRAL_API_URLS = new Set([
  'https://api.rdk.network',
  'http://api.rdk.network',
]);
// Machine-specific key: hash of hostname + os username (deters casual reads of config)
const hostedKey = process.env.RDK_CONFIG_ENCRYPTION_KEY;
if (hostedKey && !/^[a-f0-9]{64}$/i.test(hostedKey)) {
  throw new Error('RDK_CONFIG_ENCRYPTION_KEY must contain 32 hex-encoded bytes');
}
const MACHINE_KEY = hostedKey
  ? Buffer.from(hostedKey, 'hex')
  : crypto.createHash('sha256').update(`${os.hostname()}${os.userInfo().username}`).digest();

/** Absolute path of the ~/.rdk directory (honors RDK_HOME). */
export function rdkDir(): string {
  return RDK_DIR;
}

export function ensureRDKDir(): void {
  if (!fs.existsSync(RDK_DIR)) fs.mkdirSync(RDK_DIR, { recursive: true, mode: 0o700 });
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH) || !!process.env.RDK_API_KEY;
}

export function loadConfig(): RDKConfig {
  const envApiKey = process.env.RDK_API_KEY?.trim();
  if (!fs.existsSync(CONFIG_PATH) && !envApiKey) {
    throw new Error(
      'No RDK credentials found. Set RDK_API_KEY (dashboard.retrodeck.ai → settings → API key) ' +
      'or provide RDK_CONFIG_PATH. Interactive setup requires a terminal: rdk init.',
    );
  }
  const raw: RDKConfig = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as RDKConfig
    : {
        nodeId: process.env.RDK_NODE_ID ?? 'headless',
        apiKey: envApiKey!,
        centralApiUrl: process.env.RDK_CENTRAL_URL ?? process.env.RDK_API_URL ?? DEFAULT_CENTRAL_API_URL,
        plan: 'free', vaultAdapter: 'filesystem',
        vaultPath: process.env.RDK_VAULT_PATH ?? '',
        domain: process.env.RDK_DOMAIN ?? 'general', walletChain: 'base',
        mcpPort: 4242, createdAt: new Date(0).toISOString(),
      };
  if (DEAD_CENTRAL_API_URLS.has(raw.centralApiUrl?.replace(/\/+$/, ''))) {
    raw.centralApiUrl = DEFAULT_CENTRAL_API_URL;
  }
  raw.apiKey = envApiKey ?? decryptValue(raw.apiKey);
  if (process.env.RDK_VAULT_PATH) raw.vaultPath = process.env.RDK_VAULT_PATH;
  if (raw.retrodeckAccessToken) raw.retrodeckAccessToken = decryptValue(raw.retrodeckAccessToken);
  if (raw.retrodeckRefreshToken) raw.retrodeckRefreshToken = decryptValue(raw.retrodeckRefreshToken);
  if (raw.vaultKeyHex) raw.vaultKeyHex = decryptValue(raw.vaultKeyHex);
  if (raw.sharedVaultKeys) {
    for (const [nodeId, key] of Object.entries(raw.sharedVaultKeys)) {
      raw.sharedVaultKeys[nodeId] = decryptValue(key);
    }
  }
  return raw;
}

/** loadConfig() but returns null instead of throwing when absent/undecryptable. */
export function loadConfigOrNull(): RDKConfig | null {
  try {
    return configExists() ? loadConfig() : null;
  } catch {
    return null;
  }
}

export function saveConfig(config: RDKConfig): void {
  ensureRDKDir();
  const encryptedSharedKeys: Record<string, string> = {};
  for (const [nodeId, key] of Object.entries(config.sharedVaultKeys ?? {})) {
    encryptedSharedKeys[nodeId] = encryptValue(key);
  }
  const toSave: RDKConfig = {
    ...config,
    apiKey: encryptValue(config.apiKey),
    retrodeckAccessToken: config.retrodeckAccessToken
      ? encryptValue(config.retrodeckAccessToken)
      : undefined,
    retrodeckRefreshToken: config.retrodeckRefreshToken
      ? encryptValue(config.retrodeckRefreshToken)
      : undefined,
    vaultKeyHex: config.vaultKeyHex ? encryptValue(config.vaultKeyHex) : undefined,
    sharedVaultKeys: Object.keys(encryptedSharedKeys).length > 0 ? encryptedSharedKeys : undefined,
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
