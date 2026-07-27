// packages/rdk-cli/src/payments.ts
//
// Every RetroDeck payment call the CLI makes, in one place.
//
// This exists because the logic was implemented TWICE: `commands/account.ts` +
// `commands/balance.ts` went through `retrodeckFetch` (with 401 refresh), while
// `commands/init.ts` re-implemented the same calls with raw `fetch` and a
// hand-rolled `Authorization` header. The two drifted — different request
// bodies, different poll cadences, and no token refresh on the onboarding path.
//
// The reason `init.ts` could not simply call `retrodeckFetch` is real, not
// laziness: `retrodeckFetch` reads credentials from `~/.rdk/config.json`, and
// during `rdk init` that file is not written until the very end of setup. Hence
// `PaymentsSession` — the same operations over either credential source.
//
// This module is network + polling only. Prompts, spinners and `openUrl` stay in
// the command layer.

import { retrodeckFetch } from './retrodeck-api.js';

export interface PaymentsSession {
  /** Base URL, exposed so callers can derive the dashboard origin. */
  readonly apiBase: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export const RETRODECK_DEFAULT_URL = 'https://api.retrodeck.ai';

/**
 * A session backed by the stored config, with transparent 401 refresh.
 * The normal path for every command except `init`.
 */
export function sessionFromConfig(apiBase?: string): PaymentsSession {
  return {
    apiBase: apiBase ?? RETRODECK_DEFAULT_URL,
    fetch: (path, init) => retrodeckFetch(path, init),
  };
}

/**
 * A session backed by an in-memory access token, for `rdk init` — which
 * authenticates before `~/.rdk/config.json` exists.
 *
 * No refresh: the token was minted seconds earlier by register/login, so it
 * cannot have expired, and there is nowhere to persist a rotated one yet.
 */
export function sessionFromToken(apiBase: string, accessToken: string): PaymentsSession {
  return {
    apiBase,
    fetch: (path, init = {}) =>
      fetch(`${apiBase}${path}`, {
        signal: AbortSignal.timeout(8000),
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${accessToken}` },
      }),
  };
}

// ── polling cadences ────────────────────────────────────────────────────────
//
// There were five different cadences across the two implementations
// (12×2.5s, 10×3s, 20×3s, 24×2.5s, 30×3s) with no stated reason for any of them.
// Two remain, and the difference between them IS meaningful:

/** After a browser checkout the user has already returned, so settlement is
 *  near-immediate — 30s is generous. */
export const STRIPE_POLL = { attempts: 12, intervalMs: 2500 } as const;

/** On-chain settlement needs block confirmations, and a subscription's first
 *  charge waits on a collector tick (up to 60s) — 90s. */
export const CRYPTO_POLL = { attempts: 30, intervalMs: 3000 } as const;

export interface PollOptions {
  attempts?: number;
  intervalMs?: number;
  /** Injectable so tests don't wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each retry, for spinner text. */
  onAttempt?: (attempt: number) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── shapes ──────────────────────────────────────────────────────────────────

export interface ApiPlan {
  id: string;
  name: string;
  price_monthly: number;
  price_yearly?: number;
  max_queries_day: number;
  max_chunks: number;
}

export interface CryptoPlanOffer {
  subscriptionRef: string;
  collector: string;
  token: string;
  amountPerPeriod: string;
  cap: string;
  periodSeconds: number;
  interval: string;
  chainId: number;
  server: string;
}

export interface SelectPlanResult {
  checkoutUrl: string | null;
  cryptocadet?: CryptoPlanOffer;
}

export interface CryptoCadetTopup {
  quote: unknown;
  server: string;
  recipient: string;
  token: string;
  amount: string;
  chainId: number;
}

export interface TopupResult {
  checkoutUrl: string | null;
  paymentId?: string;
  cryptocadet?: CryptoCadetTopup;
}

export class PaymentApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'PaymentApiError';
  }
}

/** Read the server's error message when it sends one; fall back to the status. */
async function toError(res: Response, fallback: string): Promise<PaymentApiError> {
  let message = `${fallback} (HTTP ${res.status})`;
  try {
    const body = (await res.json()) as { message?: string | string[] };
    if (body?.message) {
      message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    }
  } catch {
    /* non-JSON body — keep the status message */
  }
  return new PaymentApiError(message, res.status);
}

// ── plans ───────────────────────────────────────────────────────────────────

/** The live plan catalogue. Public — no auth required. */
export async function fetchPlans(session: PaymentsSession): Promise<ApiPlan[]> {
  const res = await session.fetch('/api/v1/plans');
  if (!res.ok) throw await toError(res, 'Could not fetch plans');
  const plans = (await res.json()) as ApiPlan[];
  return Array.isArray(plans) ? plans : [];
}

/**
 * Start a plan change.
 *
 * Free carries neither an interval nor a method — it has no billing period and
 * no payment rail, and the server applies it immediately (cancelling any active
 * subscription) rather than returning a checkout URL.
 */
export async function selectPlan(
  session: PaymentsSession,
  opts: {
    planId: string;
    interval?: 'monthly' | 'yearly';
    method?: 'stripe' | 'cryptocadet';
  },
): Promise<SelectPlanResult> {
  const body: Record<string, unknown> =
    opts.planId === 'free'
      ? { planId: 'free', source: 'cli' }
      : {
          planId: opts.planId,
          interval: opts.interval ?? 'monthly',
          method: opts.method ?? 'stripe',
          source: 'cli',
        };

  const res = await session.fetch('/api/v1/plans/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res, 'Plan change failed');
  return (await res.json()) as SelectPlanResult;
}

/** Register a granted on-chain approval so the collector can start pulling. */
export async function activateCryptoPlan(
  session: PaymentsSession,
  opts: { planId: string; buyerWallet: string },
): Promise<{ registered: boolean; subscriptionId: string | null; status: string }> {
  const res = await session.fetch('/api/v1/plans/activate-crypto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId: opts.planId, buyerWallet: opts.buyerWallet }),
  });
  if (!res.ok) throw await toError(res, 'Could not register the crypto subscription');
  return (await res.json()) as { registered: boolean; subscriptionId: string | null; status: string };
}

export interface PlanVerification {
  paid: boolean;
  planId?: string;
  planName?: string;
}

/**
 * Ask whether the plan change has landed.
 *
 * The CLI returns to a static "close this tab" page and so has no session ref to
 * pass — the server resolves the user's pending subscription itself. Verification
 * is also what ACTIVATES the plan: there is no Stripe webhook.
 */
export async function verifyPlanPayment(session: PaymentsSession): Promise<PlanVerification> {
  const res = await session.fetch('/api/v1/plans/verify-payment');
  if (!res.ok) return { paid: false };
  const v = (await res.json()) as { paid?: boolean; plan?: { id?: string; name?: string } };
  return { paid: !!v.paid, planId: v.plan?.id, planName: v.plan?.name };
}

/** Poll `verifyPlanPayment` until it reports paid, or the attempts run out. */
export async function pollPlanActivation(
  session: PaymentsSession,
  opts: PollOptions = {},
): Promise<PlanVerification> {
  const { attempts = STRIPE_POLL.attempts, intervalMs = STRIPE_POLL.intervalMs } = opts;
  const sleep = opts.sleep ?? realSleep;

  for (let i = 0; i < attempts; i++) {
    opts.onAttempt?.(i);
    try {
      const v = await verifyPlanPayment(session);
      if (v.paid) return v;
    } catch {
      // A transient failure must not abort the poll — the payment may still land.
    }
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return { paid: false };
}

export type SubscriptionRemedy = 'none' | 'fund_wallet' | 'increase_approval' | 'reapprove';

/** Why a crypto subscription is or isn't collecting, plus the fix. */
export interface SubscriptionHealth {
  status: 'none' | 'pending_grant' | 'registered' | 'active' | 'skipped' | 'lapsed' | 'cancelled';
  planId: string | null;
  reason: string | null;
  nextRetryAt: string | null;
  requiredAmountUsdc: number | null;
  buyerWallet: string | null;
  collector: string | null;
  remedy: SubscriptionRemedy;
  message: string;
}

export async function fetchSubscriptionHealth(
  session: PaymentsSession,
): Promise<SubscriptionHealth | null> {
  const res = await session.fetch('/api/v1/plans/subscription/health');
  // Older API, or no subscription — either way there is nothing to warn about.
  if (!res.ok) return null;
  return (await res.json()) as SubscriptionHealth;
}

// ── balances ────────────────────────────────────────────────────────────────

export type BalanceLevel = 'ok' | 'low' | 'critical' | 'empty';

/** Server-computed low-balance status. `message` is printed verbatim. */
export interface BalanceStatus {
  level: BalanceLevel;
  balance: number;
  threshold: number;
  thresholdIsDefault: boolean;
  muted: boolean;
  spendable: number;
  message: string;
  action: 'none' | 'topup';
}

export interface BalanceInfo {
  balanceUsdc: number;
  creditLimitUsd: number;
  /** null = never configured (server default applies); 0 = muted; >0 = chosen. */
  alertThreshold: number | null;
  withdrawable: number;
  /** Absent when talking to an API older than this field. */
  status?: BalanceStatus;
}

export async function fetchBalance(session: PaymentsSession): Promise<BalanceInfo> {
  const res = await session.fetch('/api/v1/balances/me');
  if (!res.ok) throw await toError(res, 'Could not fetch balance');
  const d = (await res.json()) as Partial<BalanceInfo> & { balanceStatus?: BalanceStatus };
  const balanceUsdc = Number(d.balanceUsdc ?? 0);
  const creditLimitUsd = Number(d.creditLimitUsd ?? 0);
  return {
    balanceUsdc,
    creditLimitUsd,
    // null and 0 mean different things (unset vs muted) — do not collapse them.
    alertThreshold: d.alertThreshold == null ? null : Number(d.alertThreshold),
    // Prefer the server's figure; fall back only if an older API omits it.
    withdrawable: Number(d.withdrawable ?? Math.max(0, balanceUsdc - creditLimitUsd)),
    status: d.balanceStatus,
  };
}

// ── Withdrawals ─────────────────────────────────────────────────────────────
// Money OUT. The server debits the balance the moment a withdrawal is accepted
// and settles it on-chain asynchronously, so a request is a real commitment —
// check `fetchWithdrawalStatus()` before offering it, rather than debiting into
// a queue that may not be drainable.

export interface WithdrawalStatus {
  /** False when the server cannot settle payouts right now. */
  enabled: boolean;
  /** The ONE chain this server pays out on — never chosen by the client. */
  chain: string;
  reason?: string;
}

export interface WithdrawalRecord {
  id: string;
  amountUsdc: number;
  walletAddress: string;
  walletChain: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | string;
  txHash: string | null;
  requestedAt: string;
  completedAt: string | null;
}

export async function fetchWithdrawalStatus(session: PaymentsSession): Promise<WithdrawalStatus> {
  const res = await session.fetch('/api/v1/balances/withdrawals/status');
  // An older API has no such route — treat that as "unknown, let the request
  // itself decide" rather than blocking a withdrawal that might work.
  if (res.status === 404) return { enabled: true, chain: 'unknown' };
  if (!res.ok) throw await toError(res, 'Could not check withdrawal availability');
  return (await res.json()) as WithdrawalStatus;
}

export async function requestWithdrawal(
  session: PaymentsSession,
  opts: { amountUsdc: number; walletAddress: string },
): Promise<{ withdrawalId: string; status: string; chain: string }> {
  const res = await session.fetch('/api/v1/balances/withdraw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // No chain: the server pays on the chain it holds a funded wallet for, and
    // sending one only creates a way to disagree with it.
    body: JSON.stringify({ amountUsdc: opts.amountUsdc, walletAddress: opts.walletAddress }),
  });
  if (!res.ok) throw await toError(res, 'Withdrawal failed');
  return (await res.json()) as { withdrawalId: string; status: string; chain: string };
}

export async function fetchWithdrawals(session: PaymentsSession): Promise<WithdrawalRecord[]> {
  const res = await session.fetch('/api/v1/balances/withdrawals');
  if (!res.ok) throw await toError(res, 'Could not fetch withdrawals');
  const rows = (await res.json()) as Record<string, unknown>[];
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    id: String(r.id),
    amountUsdc: Number(r.amount_usdc ?? 0),
    walletAddress: String(r.wallet_address ?? ''),
    walletChain: String(r.wallet_chain ?? ''),
    status: String(r.status ?? 'pending'),
    txHash: (r.tx_hash as string | null) ?? null,
    requestedAt: String(r.requested_at ?? ''),
    completedAt: (r.completed_at as string | null) ?? null,
  }));
}

export async function createTopup(
  session: PaymentsSession,
  opts: { amountUsd: number; method: 'stripe' | 'cryptocadet'; returnUrl?: string },
): Promise<TopupResult> {
  const res = await session.fetch('/api/v1/balances/topup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amountUsd: opts.amountUsd,
      method: opts.method,
      source: 'cli',
      ...(opts.returnUrl ? { returnUrl: opts.returnUrl } : {}),
    }),
  });
  if (!res.ok) throw await toError(res, 'Could not create checkout');
  return (await res.json()) as TopupResult;
}

export interface TopupVerification {
  completed: boolean;
  balance: number;
}

/**
 * Verify — and thereby CREDIT — a top-up.
 *
 * Crediting happens here, not via a webhook, so this doubles as the self-heal for
 * a payment that completed while the CLI wasn't watching. Passing `paymentRef`
 * targets a specific top-up; omitting it lets the server pick the most recent
 * pending one.
 */
export async function verifyTopup(
  session: PaymentsSession,
  paymentRef?: string,
): Promise<TopupVerification> {
  const res = paymentRef
    ? await session.fetch('/api/v1/balances/verify-topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentRef }),
      })
    : await session.fetch('/api/v1/balances/verify-topup');

  if (!res.ok) return { completed: false, balance: 0 };
  const v = (await res.json()) as { completed?: boolean; balance?: number };
  return { completed: !!v.completed, balance: Number(v.balance ?? 0) };
}

export async function pollTopupCredit(
  session: PaymentsSession,
  opts: PollOptions & { paymentRef?: string } = {},
): Promise<TopupVerification> {
  const { attempts = STRIPE_POLL.attempts, intervalMs = STRIPE_POLL.intervalMs } = opts;
  const sleep = opts.sleep ?? realSleep;

  for (let i = 0; i < attempts; i++) {
    opts.onAttempt?.(i);
    try {
      const v = await verifyTopup(session, opts.paymentRef);
      if (v.completed) return v;
    } catch {
      /* keep polling */
    }
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return { completed: false, balance: 0 };
}

/**
 * Best-effort self-heal, for read paths like `rdk balance`.
 *
 * A user who closed the checkout tab has a paid-but-unverified top-up sitting in
 * `pending`; since crediting happens on verification, this is the only thing that
 * rescues it. Never throws — a failed sweep must not stop the balance rendering.
 */
export async function selfHealPendingTopup(session: PaymentsSession): Promise<void> {
  try {
    await verifyTopup(session);
  } catch {
    /* best-effort by design */
  }
}

// ── limits & alerts ─────────────────────────────────────────────────────────

export async function setCreditLimit(
  session: PaymentsSession,
  limitUsd: number,
): Promise<{ creditLimit: number }> {
  const res = await session.fetch('/api/v1/balances/set-limit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limitUsd }),
  });
  if (!res.ok) throw await toError(res, 'Could not set the credit limit');
  return (await res.json()) as { creditLimit: number };
}

export async function setAlertThreshold(
  session: PaymentsSession,
  thresholdUsd: number,
): Promise<{ alertThreshold: number }> {
  const res = await session.fetch('/api/v1/balances/set-alert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thresholdUsd }),
  });
  if (!res.ok) throw await toError(res, 'Could not set the alert threshold');
  return (await res.json()) as { alertThreshold: number };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** The dashboard origin for a given API base (`api.` → `dashboard.`). */
export function dashboardUrlFor(apiBase: string): string {
  return apiBase.replace('//api.', '//dashboard.');
}

/**
 * Parse a user-supplied amount: "25", "$25", "25.50", "1,000".
 * Returns null for anything non-positive or unparseable — callers must not
 * silently fall back to a default, which would charge an amount nobody asked for.
 */
export function parseAmount(input: string | undefined, fallback: number): number | null {
  if (input === undefined) return fallback;
  const cleaned = String(input).replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
