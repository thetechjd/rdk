// packages/rdk-node/src/register-node.ts
//
// Turning an offline node into one that can actually serve.
//
// Desktop onboarding creates a config with `nodeId: local-<hash>` — a real,
// working local vault with no identity on RDK Central. Everything about that
// state LOOKS fine: you can index, publish, and query, because querying only
// needs Central's HTTP API. But `getWsClient()` returns null for a `local-` id,
// so the node can never hold the WebSocket Central uses to fetch content at
// query time. Its chunks are indexed and permanently unretrievable.
//
// The only cure lived behind `rdk network:join`, a CLI command a desktop user
// has no way to discover — and `startNode()` reported success anyway, so
// pressing "start node" appeared to do nothing, forever, with no explanation.
//
// Registration belongs here, shared, and it must happen on its own.

import { loadConfig, updateConfig, type RDKConfig } from './config.js';
import * as retrodeck from './retrodeck-client.js';

/** A config that has no identity on RDK Central and therefore cannot serve. */
export function isOfflineNode(config: Pick<RDKConfig, 'nodeId' | 'apiKey'>): boolean {
  return !config.nodeId
    || config.nodeId.startsWith('local-')
    || (config.apiKey ?? '').startsWith('rdk_local_');
}

export interface RegisterOptions {
  centralApiUrl: string;
  email: string;
  displayName: string;
  domain?: string;
  walletAddress?: string;
  walletChain?: string;
}

/** Register a new node with RDK Central. Returns its real id and API key. */
export async function registerNode(
  opts: RegisterOptions,
): Promise<{ nodeId: string; apiKey: string }> {
  const res = await fetch(`${opts.centralApiUrl}/api/v1/nodes/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: opts.email,
      displayName: opts.displayName,
      contributionDomain: opts.domain,
      walletAddress: opts.walletAddress || undefined,
      walletChain: opts.walletChain,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json() as { nodeId: string; apiKey: string };
}

export type EnsureResult =
  | { status: 'already-online'; nodeId: string }
  | { status: 'registered'; nodeId: string }
  | { status: 'blocked'; reason: string };

/**
 * Make sure this machine has a node identity that can serve, registering one if
 * it doesn't. Idempotent and safe to call on every launch.
 *
 * Requires a signed-in RetroDeck account: the node is registered against that
 * email and then linked to the account, so its chunks and earnings show up on
 * the right dashboard. Without a sign-in there is nobody to register as, which
 * is a real answer the caller must surface rather than a failure to hide.
 */
export async function ensureServableNode(
  opts: { displayName?: string } = {},
): Promise<EnsureResult> {
  let config: RDKConfig;
  try {
    config = loadConfig();
  } catch (e) {
    return { status: 'blocked', reason: `No RDK config on this machine (${(e as Error).message}).` };
  }

  if (!isOfflineNode(config)) return { status: 'already-online', nodeId: config.nodeId };

  if (!config.retrodeckAccessToken) {
    return {
      status: 'blocked',
      reason: 'This machine has an offline node. Sign in to register it on the network.',
    };
  }

  const me = await retrodeck.getMe().catch(() => null);
  if (!me?.email) {
    return {
      status: 'blocked',
      reason: 'Could not read your account — sign in again, then start the node.',
    };
  }

  const registered = await registerNode({
    centralApiUrl: config.centralApiUrl,
    email: me.email,
    displayName: opts.displayName ?? `RDK ${config.domain ?? 'general'} node`,
    domain: config.domain,
    walletAddress: config.walletAddress,
    walletChain: config.walletChain,
  });

  // The API key changes with the node identity — both must land together, or
  // the next call authenticates as a node that no longer exists.
  updateConfig({ nodeId: registered.nodeId, apiKey: registered.apiKey });

  // The WS client captures nodeId + apiKey at construction and is cached for
  // the process. Without dropping it, this process keeps authenticating as the
  // `local-` identity it just replaced and stays offline for its whole life.
  try {
    const { resetWsClient } = await import('./ws/client.js');
    resetWsClient();
  } catch { /* no client had been built yet */ }

  // Link it to the RetroDeck account so its chunks and earnings are attributed.
  // Best-effort: a node that serves but isn't linked yet is far better than one
  // that refuses to start because a dashboard row is missing.
  try {
    const { ensureNodeLinked } = await import('./link-node.js');
    await ensureNodeLinked({ accessToken: config.retrodeckAccessToken });
  } catch { /* linking retries on the next launch */ }

  return { status: 'registered', nodeId: registered.nodeId };
}
