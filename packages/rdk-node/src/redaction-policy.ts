// packages/rdk-node/src/redaction-policy.ts
//
// Gets the org's model-facing redaction policy onto this node and keeps it there.
//
// The compliance claim this file has to hold up: an org admin sets the policy
// once, and every member node enforces it on model-facing egress regardless of
// which model is asking. Two consequences shape the implementation.
//
// FAIL CLOSED. The cached policy is installed from disk BEFORE the node can
// serve a query, and a failed refresh keeps enforcing what is cached. A node
// that cannot reach the API, or whose RetroDeck session has lapsed, must not
// quietly revert to serving raw content - that would turn "go offline" into a
// one-step bypass. Only the API saying "this node's orgs have no policy" turns
// enforcement off.
//
// ON NODE. Central never sees the content and never sees the token map. What
// travels is the rule set, which is pattern definitions and term lists - not
// sensitive, which is exactly why it can be distributed.
//
// Honest boundary: a member with root on their own laptop can patch the binary.
// What this rules out is bypass through any supported path - config, CLI flag,
// choice of model, or pulling the network cable.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  DISABLED_REDACTION_POLICY,
  setActiveRedactionPolicy,
  type RedactionPolicy,
  type RedactionRule,
} from '@rdk/core';
import { loadConfigOrNull, rdkDir } from './config.js';
import { retrodeckFetch, RetrodeckAuthError } from './retrodeck-client.js';

const POLICY_FILE = 'redaction-policy.json';
const SALT_FILE = 'redaction-salt';
const DEFAULT_REFRESH_MINUTES = 15;

export interface RedactionPolicySyncOptions {
  intervalMinutes?: number;
  log?: (message: string) => void;
}

export interface RedactionPolicySync {
  /** Fetch now, outside the schedule. Resolves to the policy now in force. */
  refresh(): Promise<RedactionPolicy>;
  stop(): void;
}

/** What the API returns from GET /api/v1/redaction/policy. */
interface PolicyResponse {
  enabled: boolean;
  version: string;
  rules: RedactionRule[];
  /** Orgs whose rules were merged, for the status line. */
  orgs?: Array<{ id: string; name?: string }>;
}

interface CachedPolicy {
  enabled: boolean;
  version: string;
  rules: RedactionRule[];
  orgs?: Array<{ id: string; name?: string }>;
  fetchedAt: string;
}

// -- token salt --------------------------------------------------------------

/**
 * This node's token-derivation key, created on first use.
 *
 * It is what makes a token non-invertible and what makes it stable across
 * sessions on this machine. It is deliberately NOT synced: a salt shared across
 * an org would let one member's token map decode another's, and a salt sent to
 * Central would put the inversion key next to the index.
 */
export function nodeTokenSalt(): string {
  const file = path.join(rdkDir(), SALT_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf-8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {
    // Not created yet, or unreadable - fall through and write a fresh one.
  }
  const salt = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(rdkDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${salt}\n`, { mode: 0o600 });
  } catch {
    // Cannot persist: tokens stay consistent for this process, which still
    // satisfies within-response consistency. Nothing is served unredacted.
  }
  return salt;
}

// -- disk cache --------------------------------------------------------------

function policyPath(): string {
  return path.join(rdkDir(), POLICY_FILE);
}

export function readCachedPolicy(): CachedPolicy | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(policyPath(), 'utf-8')) as CachedPolicy;
    if (typeof parsed?.enabled !== 'boolean' || !Array.isArray(parsed?.rules)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedPolicy(cached: CachedPolicy): void {
  try {
    fs.mkdirSync(rdkDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(policyPath(), JSON.stringify(cached, null, 2), { mode: 0o600 });
  } catch {
    // A node that cannot cache still enforces the policy it holds in memory;
    // it just refetches on next start.
  }
}

/** Attach this node's salt to a rule set so the engine can derive tokens. */
function toPolicy(source: CachedPolicy | PolicyResponse): RedactionPolicy {
  return {
    enabled: source.enabled,
    version: source.version,
    rules: source.rules,
    tokenSalt: nodeTokenSalt(),
  };
}

// -- lifecycle ---------------------------------------------------------------

/**
 * Install the cached policy synchronously.
 *
 * Call this before anything can serve a query. The refresh below is async and
 * may never complete; enforcement must not wait on it.
 */
export function installCachedRedactionPolicy(): RedactionPolicy {
  const cached = readCachedPolicy();
  const policy = cached ? toPolicy(cached) : DISABLED_REDACTION_POLICY;
  setActiveRedactionPolicy(policy);
  return policy;
}

/**
 * Install the cached policy, then keep it current.
 *
 * Returns immediately; the first fetch runs in the background so a slow or
 * unreachable API never delays the node coming up.
 */
export function startRedactionPolicySync(
  opts: RedactionPolicySyncOptions = {},
): RedactionPolicySync {
  const log = opts.log ?? ((message: string) => console.error(`[rdk] ${message}`));
  const installed = installCachedRedactionPolicy();
  if (installed.enabled && installed.rules.length > 0) {
    log(`redaction policy ${installed.version} in force (${installed.rules.length} rule(s), cached)`);
  }

  const intervalMs = Math.max(1, opts.intervalMinutes ?? DEFAULT_REFRESH_MINUTES) * 60_000;
  const refresh = () => refreshRedactionPolicy(log);

  void refresh();
  const timer = setInterval(() => { void refresh(); }, intervalMs);
  timer.unref?.();

  return {
    refresh: () => refresh(),
    stop: () => clearInterval(timer),
  };
}

/**
 * Fetch the effective policy and install it. Never throws.
 *
 * On any failure the previously installed policy stays in force - see the
 * fail-closed note at the top of the file.
 */
export async function refreshRedactionPolicy(
  log: (message: string) => void = (message) => console.error(`[rdk] ${message}`),
): Promise<RedactionPolicy> {
  const config = loadConfigOrNull();
  const current = readCachedPolicy();

  if (!config?.retrodeckAccessToken) {
    if (current?.enabled) {
      log('no RetroDeck session; continuing to enforce the cached redaction policy');
    }
    return installCachedRedactionPolicy();
  }

  try {
    const query = config.nodeId ? `?nodeId=${encodeURIComponent(config.nodeId)}` : '';
    const response = await retrodeckFetch(`/api/v1/redaction/policy${query}`);

    if (response.status === 404) {
      // The API is too old to know about redaction. Keep enforcing whatever is
      // cached rather than treating an outdated server as "no policy".
      return installCachedRedactionPolicy();
    }
    if (!response.ok) {
      log(`redaction policy fetch failed (HTTP ${response.status}); keeping the policy in force`);
      return installCachedRedactionPolicy();
    }

    const payload = await response.json() as PolicyResponse;
    if (typeof payload?.enabled !== 'boolean' || !Array.isArray(payload?.rules)) {
      log('redaction policy response was malformed; keeping the policy in force');
      return installCachedRedactionPolicy();
    }

    const cached: CachedPolicy = {
      enabled: payload.enabled,
      version: payload.version,
      rules: payload.rules,
      orgs: payload.orgs,
      fetchedAt: new Date().toISOString(),
    };
    writeCachedPolicy(cached);

    const policy = toPolicy(cached);
    setActiveRedactionPolicy(policy);

    if (current?.version !== payload.version) {
      log(payload.enabled && payload.rules.length > 0
        ? `redaction policy updated to ${payload.version} (${payload.rules.length} rule(s))`
        : 'redaction policy cleared by the org admin');
    }
    return policy;
  } catch (error) {
    const reason = error instanceof RetrodeckAuthError
      ? 'RetroDeck session expired'
      : (error as Error).message;
    if (current?.enabled) {
      log(`redaction policy refresh failed (${reason}); the cached policy stays in force`);
    }
    return installCachedRedactionPolicy();
  }
}

/** What `rdk status` and the desktop show about redaction. No values, ever. */
export function redactionStatus(): {
  enabled: boolean;
  version: string | null;
  ruleCount: number;
  orgs: Array<{ id: string; name?: string }>;
  fetchedAt: string | null;
} {
  const cached = readCachedPolicy();
  return {
    enabled: Boolean(cached?.enabled) && (cached?.rules.length ?? 0) > 0,
    version: cached?.version ?? null,
    ruleCount: cached?.rules.filter((rule) => rule.enabled !== false).length ?? 0,
    orgs: cached?.orgs ?? [],
    fetchedAt: cached?.fetchedAt ?? null,
  };
}
