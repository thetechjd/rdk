// packages/rdk-cli/src/retrodeck-api.ts
// Authenticated fetch for the RetroDeck API (api.retrodeck.ai).
//
// Auth model (verified against the backend):
//   - Durable credential: retrodeckRefreshToken (long-lived, ~days)
//   - Short-lived credential: retrodeckAccessToken (~24h JWT)
// When the access token expires, an API call returns 401. We then exchange the
// refresh token for a fresh access token (POST /api/v1/auth/refresh) and retry
// once. The user only ever sees a "run rdk account:login" prompt if the REFRESH
// token itself is rejected — never on routine access-token expiry.
//
// This mirrors the WebSocket client's structure (durable credential → fresh JWT
// → use it), with the refresh token as the durable credential. Note the node
// apiKey/RDK-Central JWT does NOT authenticate this API (separate signing keys).

import { loadConfig, updateConfig } from './config.js';

/** Thrown only when re-authentication is genuinely required (refresh failed). */
export class RetrodeckAuthError extends Error {
  constructor(message = 'RetroDeck session expired') {
    super(message);
    this.name = 'RetrodeckAuthError';
  }
}

async function refreshAccessToken(apiBase: string, refreshToken: string): Promise<string> {
  const res = await fetch(`${apiBase}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    // Refresh token expired or revoked — re-login is genuinely required.
    throw new RetrodeckAuthError();
  }
  const data = await res.json() as { accessToken?: string; refreshToken?: string };
  if (!data.accessToken) throw new RetrodeckAuthError();
  updateConfig({
    retrodeckAccessToken: data.accessToken,
    // Some servers rotate the refresh token on use — persist it if returned.
    ...(data.refreshToken ? { retrodeckRefreshToken: data.refreshToken } : {}),
  });
  return data.accessToken;
}

/**
 * Fetch a RetroDeck API path with the stored access token, transparently
 * refreshing on 401 and retrying once. `path` is relative to retrodeckApiUrl
 * (e.g. "/api/v1/balances/me"). Throws RetrodeckAuthError if the session can't
 * be established or refreshed.
 */
export async function retrodeckFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const config = loadConfig();
  const apiBase = config.retrodeckApiUrl;
  if (!apiBase || !config.retrodeckAccessToken) {
    throw new RetrodeckAuthError('Not logged in to RetroDeck');
  }

  const withAuth = (token: string): RequestInit => ({
    signal: AbortSignal.timeout(8000),
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });

  const res = await fetch(`${apiBase}${path}`, withAuth(config.retrodeckAccessToken));
  if (res.status !== 401) return res;

  // Access token expired — mint a fresh one with the refresh token and retry.
  if (!config.retrodeckRefreshToken) throw new RetrodeckAuthError();
  const fresh = await refreshAccessToken(apiBase, config.retrodeckRefreshToken);
  return fetch(`${apiBase}${path}`, withAuth(fresh));
}
