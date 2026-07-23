// packages/rdk-node/src/retrodeck-client.ts
//
// Authenticated client for the RetroDeck API (api.retrodeck.ai) — the account /
// plans / balance / top-up / subscription backend. This is a DIFFERENT service
// from RDK Central (api.rdk.network), which owns node registration, chunk sync
// and tips/earnings and authenticates with the node apiKey. Mixing them up sends
// account calls to the wrong host with the wrong token.
//
// Auth model (mirrors packages/rdk-cli/src/retrodeck-api.ts):
//   - durable credential : retrodeckRefreshToken (long-lived)
//   - short-lived        : retrodeckAccessToken (~24h JWT)
// On 401 we exchange the refresh token for a fresh access token, persist it, and
// retry once. Only a rejected REFRESH token means the user must log in again.

import { loadConfig, loadConfigOrNull, updateConfig } from './config.js';
import { ensureNodeLinked, type LinkResult } from './link-node.js';

/** Thrown only when re-authentication is genuinely required (refresh failed). */
export class RetrodeckAuthError extends Error {
  constructor(message = 'RetroDeck session expired') {
    super(message);
    this.name = 'RetrodeckAuthError';
  }
}

export const RETRODECK_DEFAULT_URL = 'https://api.retrodeck.ai';

export interface ApiPlan {
  id: string;
  name: string;
  price_monthly: number;
  max_queries_day: number;
  max_chunks: number;
}

export interface BalanceInfo {
  balanceUsdc: number;
  creditLimitUsd: number;
}

async function refreshAccessToken(apiBase: string, refreshToken: string): Promise<string> {
  const res = await fetch(`${apiBase}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new RetrodeckAuthError();
  const data = (await res.json()) as { accessToken?: string; refreshToken?: string };
  if (!data.accessToken) throw new RetrodeckAuthError();
  updateConfig({
    retrodeckAccessToken: data.accessToken,
    // Some servers rotate the refresh token on use — persist it if returned.
    ...(data.refreshToken ? { retrodeckRefreshToken: data.refreshToken } : {}),
  });
  return data.accessToken;
}

/** Fetch a RetroDeck path with the stored access token; refresh + retry once on 401. */
export async function retrodeckFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const config = loadConfig();
  const apiBase = config.retrodeckApiUrl ?? RETRODECK_DEFAULT_URL;
  if (!config.retrodeckAccessToken) throw new RetrodeckAuthError('Not logged in to RetroDeck');

  const withAuth = (token: string): RequestInit => ({
    signal: AbortSignal.timeout(15_000),
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });

  const res = await fetch(`${apiBase}${path}`, withAuth(config.retrodeckAccessToken));
  if (res.status !== 401) return res;

  if (!config.retrodeckRefreshToken) throw new RetrodeckAuthError();
  const fresh = await refreshAccessToken(apiBase, config.retrodeckRefreshToken);
  return fetch(`${apiBase}${path}`, withAuth(fresh));
}

/** True when a RetroDeck session exists (an access token is stored). */
export function isLoggedIn(): boolean {
  try {
    return !!loadConfig().retrodeckAccessToken;
  } catch {
    return false;
  }
}

/** The dashboard origin, derived from the API host (api. → dashboard.). */
export function dashboardUrl(): string {
  const base = (() => {
    try { return loadConfig().retrodeckApiUrl ?? RETRODECK_DEFAULT_URL; } catch { return RETRODECK_DEFAULT_URL; }
  })();
  return base.replace('//api.', '//dashboard.');
}

// ── Login / logout ───────────────────────────────────────────────────────────

export interface LoginResult {
  ok: boolean;
  error?: string;
  emailVerified?: boolean;
  plan?: string;
  /** Outcome of linking this node to the account (dashboard visibility). */
  link?: LinkResult;
}

/** Base URL used for login, before any config exists to read from. */
function retrodeckBase(): string {
  const cfg = loadConfigOrNull();
  return cfg?.retrodeckApiUrl ?? process.env.RETRODECK_API_URL ?? RETRODECK_DEFAULT_URL;
}

/**
 * Email/password login against the RetroDeck API — the same exchange the CLI's
 * `rdk account:login` performs. Captures BOTH tokens, resolves the authoritative
 * plan from /users/me, persists everything to ~/.rdk/config.json (shared with the
 * CLI), then idempotently links this node to the account so its chunks show up in
 * the dashboard.
 */
export async function login(email: string, password: string): Promise<LoginResult> {
  const apiBase = retrodeckBase();
  let data: { accessToken: string; refreshToken: string };
  try {
    const res = await fetch(`${apiBase}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Invalid credentials' };
    if (res.status >= 500) return { ok: false, error: `RetroDeck is temporarily unavailable (HTTP ${res.status}). Try again shortly.` };
    if (!res.ok) return { ok: false, error: `Login failed (HTTP ${res.status})` };
    data = (await res.json()) as { accessToken: string; refreshToken: string };
  } catch (e) {
    return { ok: false, error: `Could not reach RetroDeck: ${(e as Error).message}` };
  }
  if (!data.accessToken) return { ok: false, error: 'Login failed (no token returned)' };

  const existing = loadConfigOrNull();
  let userId = existing?.retrodeckUserId ?? '';
  let plan = existing?.plan;
  let emailVerified: boolean | undefined;

  // /users/me is the authoritative source of the plan (the token doesn't carry it).
  try {
    const meRes = await fetch(`${apiBase}/api/v1/users/me`, {
      headers: { Authorization: `Bearer ${data.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (meRes.ok) {
      const me = (await meRes.json()) as { user: { id: string; emailVerified: boolean; planId?: string } };
      userId = me.user.id;
      plan = me.user.planId ?? plan ?? 'free';
      emailVerified = me.user.emailVerified;
    }
  } catch { /* non-fatal — tokens are still good */ }

  updateConfig({
    retrodeckAccessToken: data.accessToken,
    retrodeckRefreshToken: data.refreshToken,
    retrodeckUserId: userId,
    retrodeckApiUrl: apiBase,
    plan,
    ...(emailVerified !== undefined ? { emailVerified } : {}),
  });

  // Link the node so the dashboard can resolve its chunks. Pass the fresh token
  // explicitly (as the CLI does) so it links even if the check can't be done.
  let link: LinkResult | undefined;
  try { link = await ensureNodeLinked({ accessToken: data.accessToken }); } catch { /* non-fatal */ }

  return { ok: true, emailVerified, plan, link };
}

/** Clear the RetroDeck session. The node's own apiKey/identity is untouched. */
export function logout(): void {
  updateConfig({
    retrodeckAccessToken: undefined,
    retrodeckRefreshToken: undefined,
  });
}

// ── Account ──────────────────────────────────────────────────────────────────

export async function getMe(): Promise<{ id?: string; email?: string; emailVerified?: boolean; planId?: string } | null> {
  const res = await retrodeckFetch('/api/v1/users/me');
  if (!res.ok) return null;
  const data = (await res.json()) as { user?: { id?: string; email?: string; emailVerified?: boolean; planId?: string } };
  return data.user ?? null;
}

export async function getBalance(): Promise<BalanceInfo | null> {
  const res = await retrodeckFetch('/api/v1/balances/me');
  if (!res.ok) return null;
  const d = (await res.json()) as { balanceUsdc?: number; creditLimitUsd?: number };
  return { balanceUsdc: Number(d.balanceUsdc ?? 0), creditLimitUsd: Number(d.creditLimitUsd ?? 0) };
}

// ── Plans / subscription ─────────────────────────────────────────────────────

export async function getPlans(): Promise<ApiPlan[]> {
  const res = await retrodeckFetch('/api/v1/plans');
  if (!res.ok) throw new Error(`Could not fetch plans (HTTP ${res.status})`);
  return (await res.json()) as ApiPlan[];
}

/**
 * Select a plan. Free is applied immediately (no checkout). Paid plans return a
 * `checkoutUrl` to open in the browser — the web checkout handles BOTH card and
 * crypto, so no payment credentials are ever collected in-app.
 */
export async function selectPlan(planId: string, interval?: 'monthly' | 'yearly'): Promise<{ checkoutUrl: string | null }> {
  const body: Record<string, unknown> = interval ? { planId, interval, source: 'desktop' } : { planId };
  const res = await retrodeckFetch('/api/v1/plans/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Plan change failed (HTTP ${res.status})`);
  const d = (await res.json()) as { checkoutUrl?: string | null };
  return { checkoutUrl: d.checkoutUrl ?? null };
}

/** Poll after a checkout handoff. Persists the new plan to config when paid. */
export async function verifySubscription(): Promise<{ paid: boolean; planId?: string; planName?: string }> {
  const res = await retrodeckFetch('/api/v1/plans/verify-payment');
  if (!res.ok) return { paid: false };
  const v = (await res.json()) as { paid?: boolean; plan?: { id?: string; name?: string } };
  if (v.paid && v.plan?.id) updateConfig({ plan: v.plan.id });
  return { paid: !!v.paid, planId: v.plan?.id, planName: v.plan?.name };
}

// ── Balance top-up ───────────────────────────────────────────────────────────

/**
 * Create a top-up checkout. Both methods return a browser `checkoutUrl`:
 *  - `stripe`      → Stripe card checkout session;
 *  - `cryptocadet` → a hosted crypto checkout page (renders the signed quote:
 *                    amount, payout address, deadline) the user completes in the
 *                    browser — no local wallet binary needed on the desktop.
 */
export async function createTopup(
  amountUsd: number,
  method: 'stripe' | 'cryptocadet' = 'stripe',
): Promise<{ checkoutUrl: string | null; paymentId?: string }> {
  const res = await retrodeckFetch('/api/v1/balances/topup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amountUsd, method, source: 'desktop', returnUrl: dashboardUrl() }),
  });
  if (!res.ok) throw new Error(`Could not create checkout (HTTP ${res.status})`);
  const d = (await res.json()) as { checkoutUrl?: string | null; paymentId?: string };
  return { checkoutUrl: d.checkoutUrl ?? null, paymentId: d.paymentId };
}

/**
 * Verify (and CREDIT) a top-up. Crediting happens on verification — there is no
 * async Stripe webhook — so this doubles as the self-heal for a payment that
 * completed while the app wasn't looking.
 */
export async function verifyTopup(paymentRef?: string): Promise<{ completed: boolean; balanceUsdc?: number }> {
  const res = paymentRef
    ? await retrodeckFetch('/api/v1/balances/verify-topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentRef }),
      })
    : await retrodeckFetch('/api/v1/balances/verify-topup');
  if (!res.ok) return { completed: false };
  const v = (await res.json()) as { completed?: boolean; balance?: number };
  return { completed: !!v.completed, balanceUsdc: v.balance != null ? Number(v.balance) : undefined };
}
