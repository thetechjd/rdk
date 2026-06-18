// packages/rdk-cli/src/link-node.ts
// Ensures this RDK node is linked to the user's RetroDeck account so the
// dashboard can resolve and display the node's indexed chunks.
//
// The link lives in retrodeck-api's `rdk_nodes` table (separate from RDK
// Central). Historically it was a single fire-and-forget call during `rdk init`
// with the result swallowed — if it failed (expired/absent token, transient
// error, node registered or account logged in outside `init`), chunks synced to
// RDK Central but never appeared in the dashboard, because the dashboard reads
// `SELECT node_id FROM rdk_nodes WHERE user_id = $1` and found nothing.
//
// This helper is idempotent and verified: it checks the existing links first
// (transparently refreshing an expired access token), only links when the node
// is missing, and reports the outcome instead of swallowing it. retrodeck-api's
// /nodes/link is NOT idempotent (it would insert duplicate rows), so the
// check-before-link is required — never POST blindly.

import { loadConfig, updateConfig, type RDKConfig } from './config.js';

const DEFAULT_RETRODECK_API = 'https://api.retrodeck.ai';

export interface LinkResult {
  status: 'linked' | 'already-linked' | 'skipped' | 'failed';
  reason?: string;
}

function retrodeckApi(config: RDKConfig): string {
  return config.retrodeckApiUrl ?? process.env.RETRODECK_API_URL ?? DEFAULT_RETRODECK_API;
}

// Refresh the RetroDeck access token using the stored refresh token and persist
// the new pair. Returns the fresh access token, or null if refresh failed.
async function refreshAccessToken(config: RDKConfig): Promise<string | null> {
  if (!config.retrodeckRefreshToken) return null;
  try {
    const res = await fetch(`${retrodeckApi(config)}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: config.retrodeckRefreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { accessToken?: string; refreshToken?: string };
    if (!data.accessToken) return null;
    updateConfig({
      retrodeckAccessToken: data.accessToken,
      retrodeckRefreshToken: data.refreshToken ?? config.retrodeckRefreshToken,
    });
    return data.accessToken;
  } catch {
    return null;
  }
}

// GET /nodes/me (the node IDs already linked to this account), with one
// transparent token refresh on 401. Returns null if it can't be determined.
async function fetchLinkedNodeIds(
  config: RDKConfig,
  token: string,
): Promise<{ ids: string[]; token: string } | null> {
  const url = `${retrodeckApi(config)}/api/v1/nodes/me`;
  let active = token;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${active}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return null;
    }
    if (res.status === 401 && attempt === 0) {
      const fresh = await refreshAccessToken(config);
      if (!fresh) return null;
      active = fresh;
      continue;
    }
    if (!res.ok) return null;
    const nodes = await res.json() as Array<{ node_id?: string }>;
    return { ids: nodes.map(n => n.node_id).filter((id): id is string => !!id), token: active };
  }
  return null;
}

// Link this node to the user's RetroDeck account if it isn't already.
// Safe to call repeatedly (idempotent). Pass a freshly minted `accessToken`
// (e.g. right after login) to link even when the existing-links check can't be
// performed; otherwise the check guards against duplicate inserts.
export async function ensureNodeLinked(
  opts: { config?: RDKConfig; accessToken?: string; displayName?: string } = {},
): Promise<LinkResult> {
  const config = opts.config ?? loadConfig();

  if (!config.nodeId || config.nodeId.startsWith('local-')) {
    return { status: 'skipped', reason: 'offline node — run rdk network:join' };
  }
  let token = opts.accessToken ?? config.retrodeckAccessToken;
  if (!token) return { status: 'skipped', reason: 'not logged in — run rdk account:login' };

  // Idempotency guard: check existing links before inserting, because
  // retrodeck-api's /nodes/link would otherwise create duplicate rows.
  const linked = await fetchLinkedNodeIds(config, token);
  if (linked) {
    token = linked.token;
    if (linked.ids.includes(config.nodeId)) return { status: 'already-linked' };
  } else if (!opts.accessToken) {
    // Couldn't verify and we don't have a trusted fresh token — bail rather
    // than risk a blind duplicate insert.
    return { status: 'failed', reason: 'could not verify existing links' };
  }

  try {
    const res = await fetch(`${retrodeckApi(config)}/api/v1/nodes/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        nodeId: config.nodeId,
        apiKeyHint: (config.apiKey ?? '').slice(0, 12),
        displayName: opts.displayName,
        domain: config.domain,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { status: 'linked' };
    return { status: 'failed', reason: `HTTP ${res.status}` };
  } catch (e) {
    return { status: 'failed', reason: (e as Error).message };
  }
}
