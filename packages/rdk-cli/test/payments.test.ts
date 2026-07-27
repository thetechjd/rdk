import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CRYPTO_POLL,
  PaymentApiError,
  STRIPE_POLL,
  activateCryptoPlan,
  createTopup,
  dashboardUrlFor,
  fetchBalance,
  fetchPlans,
  parseAmount,
  pollPlanActivation,
  pollTopupCredit,
  selectPlan,
  fetchSubscriptionHealth,
  selfHealPendingTopup,
  sessionFromConfig,
  sessionFromToken,
  setAlertThreshold,
  setCreditLimit,
  verifyTopup,
} from '../src/payments.js';
import { isFreePlan } from '../src/commands/account.js';
import { loadConfig } from '../src/config.js';
import { RetrodeckAuthError } from '../src/retrodeck-api.js';
import { PLANS, seedHappyPath, startStubApi, type StubApi } from './helpers/stub-api.js';
import { noSleep, seedCliConfig } from './helpers/cli-config.js';

/**
 * Checkpoints 11–15 at the request layer.
 *
 * `src/payments.ts` is the single implementation behind `rdk account:upgrade`,
 * `rdk topup`, `rdk balance` AND `rdk init` — the onboarding path used to be a
 * second copy with raw `fetch`, no token refresh, and its own poll cadences.
 * Testing here covers every entry point at once; the command layer above it is
 * prompts and spinners.
 */
let api: StubApi;

beforeAll(async () => {
  api = await startStubApi();
});

afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  api.reset();
  seedHappyPath(api);
  seedCliConfig(api.url);
});

const session = () => sessionFromConfig(api.url);

// ── Checkpoint 11 · subscription upgrade via Stripe ─────────────────────────

describe('Checkpoint 11 · CLI subscription upgrade via Stripe', () => {
  it('sends planId, interval, method and source:cli', async () => {
    const result = await selectPlan(session(), { planId: 'pro', interval: 'monthly', method: 'stripe' });

    expect(result.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(api.last('/api/v1/plans/select')!.body).toEqual({
      planId: 'pro',
      interval: 'monthly',
      method: 'stripe',
      source: 'cli',
    });
  });

  it('marks the checkout as CLI-sourced so it returns to the close-this-tab page', async () => {
    // `source: 'cli'` is what makes the server pick the static return page over a
    // dashboard URL. Stripe cannot redirect to a terminal, so a dashboard
    // success_url would strand the user on a page they never asked for.
    await selectPlan(session(), { planId: 'pro', interval: 'yearly', method: 'stripe' });
    expect((api.last('/api/v1/plans/select')!.body as { source: string }).source).toBe('cli');
  });

  it('defaults to monthly/stripe when unspecified', async () => {
    await selectPlan(session(), { planId: 'starter' });
    expect(api.last('/api/v1/plans/select')!.body).toMatchObject({
      interval: 'monthly',
      method: 'stripe',
    });
  });

  it('surfaces the server message rather than a bare status code', async () => {
    api.once('/api/v1/plans/select', {
      status: 400,
      json: { message: 'Stripe price not configured for this plan' },
    });

    await expect(selectPlan(session(), { planId: 'pro' })).rejects.toThrow(
      /Stripe price not configured/,
    );
  });

  it('exposes the status on the thrown error', async () => {
    api.once('/api/v1/plans/select', { status: 402, json: {} });
    await expect(selectPlan(session(), { planId: 'pro' })).rejects.toMatchObject({
      name: 'PaymentApiError',
      status: 402,
    });
  });

  describe('polling for activation', () => {
    it('stops as soon as the payment is confirmed', async () => {
      const result = await pollPlanActivation(session(), { sleep: noSleep });

      expect(result).toMatchObject({ paid: true, planId: 'pro', planName: 'Pro' });
      // One request — a poll that keeps going after success wastes the user's time
      // and hammers the API.
      expect(api.to('/api/v1/plans/verify-payment')).toHaveLength(1);
    });

    it('verifies WITHOUT a ref — the CLI has no session id to return with', async () => {
      await pollPlanActivation(session(), { sleep: noSleep });
      // The CLI lands on a static page, so it cannot carry ?ref=&token= back.
      expect(api.last('/api/v1/plans/verify-payment')!.path).toBe('/api/v1/plans/verify-payment');
    });

    it('gives up after the documented number of attempts', async () => {
      api.on('/api/v1/plans/verify-payment', { json: { plan: PLANS[1], paid: false } });

      const result = await pollPlanActivation(session(), { sleep: noSleep });

      expect(result.paid).toBe(false);
      expect(api.to('/api/v1/plans/verify-payment')).toHaveLength(STRIPE_POLL.attempts);
    });

    it('keeps polling through a transient server error', async () => {
      api.once('/api/v1/plans/verify-payment', { status: 500, json: {} });
      api.once('/api/v1/plans/verify-payment', { status: 502, json: {} });

      // A blip must not abandon a payment that is about to land.
      const result = await pollPlanActivation(session(), { sleep: noSleep });
      expect(result.paid).toBe(true);
      expect(api.to('/api/v1/plans/verify-payment').length).toBeGreaterThan(2);
    });

    it('uses a longer cadence for crypto than for card', () => {
      // Card settlement is a browser redirect; crypto waits on block confirmations
      // and a collector tick. There used to be five arbitrary cadences.
      expect(CRYPTO_POLL.attempts * CRYPTO_POLL.intervalMs).toBeGreaterThan(
        STRIPE_POLL.attempts * STRIPE_POLL.intervalMs,
      );
    });
  });

  describe('401 refresh and retry', () => {
    it('refreshes the access token, persists the rotated one, and retries once', async () => {
      api.once('/api/v1/plans/select', { status: 401, json: {} });

      const result = await selectPlan(session(), { planId: 'pro', interval: 'monthly' });

      expect(result.checkoutUrl).toBeTruthy();
      expect(api.requests.map((r) => r.pathname)).toEqual([
        '/api/v1/plans/select',
        '/api/v1/auth/refresh',
        '/api/v1/plans/select',
      ]);
      // The retry must carry the NEW token, and the rotated refresh token must be
      // written to disk — otherwise the very next command 401s again.
      expect(api.to('/api/v1/plans/select')[1].headers.authorization).toBe('Bearer access-2');
      expect(loadConfig().retrodeckAccessToken).toBe('access-2');
      expect(loadConfig().retrodeckRefreshToken).toBe('refresh-2');
    });

    it('raises RetrodeckAuthError when the refresh token itself is rejected', async () => {
      api.once('/api/v1/plans/select', { status: 401, json: {} });
      api.once('/api/v1/auth/refresh', { status: 401, json: {} });

      await expect(selectPlan(session(), { planId: 'pro' })).rejects.toBeInstanceOf(
        RetrodeckAuthError,
      );
    });

    it('refreshes on the balance path too — every command shares one client', async () => {
      api.once('/api/v1/balances/me', { status: 401, json: {} });

      const balance = await fetchBalance(session());

      expect(balance.balanceUsdc).toBe(42.5);
      expect(api.to('/api/v1/auth/refresh')).toHaveLength(1);
    });
  });
});

// ── Checkpoint 13 · downgrade ───────────────────────────────────────────────

describe('Checkpoint 13 · CLI subscription downgrade', () => {
  it('sends a bare {planId, source} for Free', async () => {
    const result = await selectPlan(session(), { planId: 'free' });

    // No interval, no method — Free has neither a billing period nor a rail, and
    // the server treats this as "cancel the subscription and apply immediately".
    expect(api.last('/api/v1/plans/select')!.body).toEqual({ planId: 'free', source: 'cli' });
    expect(result.checkoutUrl).toBeNull();
  });

  it('ignores an interval or method passed for Free', async () => {
    await selectPlan(session(), { planId: 'free', interval: 'yearly', method: 'cryptocadet' });
    expect(api.last('/api/v1/plans/select')!.body).toEqual({ planId: 'free', source: 'cli' });
  });

  it('never enters a poll loop — there is nothing to confirm', async () => {
    await selectPlan(session(), { planId: 'free' });
    expect(api.to('/api/v1/plans/verify-payment')).toHaveLength(0);
  });

  it('propagates a refused cancellation instead of reporting success', async () => {
    // The server refuses the downgrade if Stripe would not cancel. The CLI must
    // not print "Switched to Free" while the charges continue.
    api.once('/api/v1/plans/select', {
      status: 502,
      json: { message: 'Could not cancel your subscription' },
    });

    await expect(selectPlan(session(), { planId: 'free' })).rejects.toThrow(
      /Could not cancel your subscription/,
    );
  });

  it('switches between paid tiers with a single select call', async () => {
    await selectPlan(session(), { planId: 'starter', interval: 'monthly', method: 'stripe' });
    expect(api.to('/api/v1/plans/select')).toHaveLength(1);
    expect(api.last('/api/v1/plans/select')!.body).toMatchObject({ planId: 'starter' });
  });

  describe('recognising the Free plan', () => {
    // The UI guard used to be `price_monthly === 0`, and Postgres sends decimals
    // as strings — so "0.00" !== 0, the downgrade branch never ran, and choosing
    // Free prompted for a billing interval and a payment method before failing
    // with "No checkout URL returned" on a change the server had already made.
    it('treats a string price of "0.00" as free', () => {
      expect(isFreePlan({ id: 'free', price_monthly: '0.00' as unknown as number })).toBe(true);
    });

    it('treats a numeric 0 as free', () => {
      expect(isFreePlan({ id: 'free', price_monthly: 0 })).toBe(true);
    });

    it('recognises free by id even if the price is missing entirely', () => {
      expect(isFreePlan({ id: 'free' })).toBe(true);
    });

    it('does not mistake a paid plan for free, string or number', () => {
      expect(isFreePlan({ id: 'starter', price_monthly: '29.00' as unknown as number })).toBe(false);
      expect(isFreePlan({ id: 'pro', price_monthly: 97 })).toBe(false);
    });
  });
});

// ── Checkpoint 14 · top-up via Stripe ───────────────────────────────────────

describe('Checkpoint 14 · CLI top-up via Stripe', () => {
  it('sends amount, method, source:cli and a dashboard returnUrl', async () => {
    const result = await createTopup(session(), {
      amountUsd: 25,
      method: 'stripe',
      returnUrl: dashboardUrlFor('https://api.retrodeck.ai'),
    });

    expect(api.last('/api/v1/balances/topup')!.body).toEqual({
      amountUsd: 25,
      method: 'stripe',
      source: 'cli',
      returnUrl: 'https://dashboard.retrodeck.ai',
    });
    expect(result.checkoutUrl).toContain('checkout.stripe.com');
    expect(result.paymentId).toBeTruthy();
  });

  it('targets the specific payment when a ref is known', async () => {
    await verifyTopup(session(), '00000000-0000-4000-8000-000000000001');

    const req = api.last('/api/v1/balances/verify-topup')!;
    expect(req.method).toBe('POST');
    expect(req.body).toEqual({ paymentRef: '00000000-0000-4000-8000-000000000001' });
  });

  it('falls back to the server picking the most recent pending top-up', async () => {
    await verifyTopup(session());

    const req = api.last('/api/v1/balances/verify-topup')!;
    expect(req.method).toBe('GET');
    expect(req.body).toBeUndefined();
  });

  it('threads the paymentId through the poll loop', async () => {
    api.on('/api/v1/balances/verify-topup', { json: { balance: 0, completed: false } });

    await pollTopupCredit(session(), { paymentRef: '00000000-0000-4000-8000-000000000001', attempts: 2, sleep: noSleep });

    // Dropping the ref silently falls back to "most recent pending", which can
    // credit and report on a DIFFERENT payment than the one just made.
    for (const req of api.to('/api/v1/balances/verify-topup')) {
      expect(req.body).toEqual({ paymentRef: '00000000-0000-4000-8000-000000000001' });
    }
  });

  it('reports the credited balance once settlement lands', async () => {
    const result = await pollTopupCredit(session(), { sleep: noSleep });
    expect(result).toEqual({ completed: true, balance: 67.5 });
  });

  it('reports not-completed rather than throwing when verification fails', async () => {
    api.on('/api/v1/balances/verify-topup', { status: 500, json: {} });

    // The payment may still settle; crashing here would be worse than waiting.
    await expect(verifyTopup(session(), '00000000-0000-4000-8000-000000000001')).resolves.toEqual({ completed: false, balance: 0 });
  });

  describe('the self-heal on `rdk balance`', () => {
    it('sweeps pending top-ups before reading the balance', async () => {
      // This is the ONLY reconciliation a CLI user has. There is no Stripe
      // webhook, so a user who closed the checkout tab is credited here or never.
      await selfHealPendingTopup(session());
      await fetchBalance(session());

      expect(api.requests.map((r) => r.pathname)).toEqual([
        '/api/v1/balances/verify-topup',
        '/api/v1/balances/me',
      ]);
    });

    it('never throws, so a failed sweep cannot stop the balance rendering', async () => {
      api.on('/api/v1/balances/verify-topup', { status: 503, json: {} });

      await expect(selfHealPendingTopup(session())).resolves.toBeUndefined();
      await expect(fetchBalance(session())).resolves.toMatchObject({ balanceUsdc: 42.5 });
    });

    it('survives a hard network failure', async () => {
      const dead = sessionFromConfig('http://127.0.0.1:1');
      seedCliConfig('http://127.0.0.1:1');
      await expect(selfHealPendingTopup(dead)).resolves.toBeUndefined();
    });
  });

  describe('amount parsing', () => {
    it.each([
      ['25', 25],
      ['$25', 25],
      ['25.50', 25.5],
      ['1,000', 1000],
      [' 10 ', 10],
    ])('accepts %s', (input, expected) => {
      expect(parseAmount(input, 10)).toBe(expected);
    });

    it.each(['abc', '-5', '0', '', '$', 'NaN'])('rejects %s', (input) => {
      // Returning the default here would charge an amount the user never asked
      // for — `rdk topup abc` must fail, not quietly bill $10.
      expect(parseAmount(input, 10)).toBeNull();
    });

    it('uses the default only when the argument is absent', () => {
      expect(parseAmount(undefined, 10)).toBe(10);
    });
  });

  it('prefers the server-computed withdrawable over recomputing it', async () => {
    api.on('/api/v1/balances/me', {
      json: { balanceUsdc: 100, creditLimitUsd: 40, alertThreshold: 5, withdrawable: 55 },
    });

    // 100 − 40 would be 60. The server's 55 wins: only it knows about pending
    // withdrawals and holds. Clients must not re-derive money.
    expect((await fetchBalance(session())).withdrawable).toBe(55);
  });
});

// ── credit limit & low-balance alert ────────────────────────────────────────

describe('credit limit and low-balance alert', () => {
  it('sets the credit limit', async () => {
    await setCreditLimit(session(), 20);
    expect(api.last('/api/v1/balances/set-limit')!.body).toEqual({ limitUsd: 20 });
  });

  it('sets the alert threshold', async () => {
    await setAlertThreshold(session(), 5);
    expect(api.last('/api/v1/balances/set-alert')!.body).toEqual({ thresholdUsd: 5 });
  });

  it('sends 0 to disable alerts', async () => {
    api.once('/api/v1/balances/set-alert', { json: { alertThreshold: 0 } });
    const result = await setAlertThreshold(session(), 0);
    expect(api.last('/api/v1/balances/set-alert')!.body).toEqual({ thresholdUsd: 0 });
    expect(result.alertThreshold).toBe(0);
  });

  it('surfaces the server rejection when the threshold exceeds the limit', async () => {
    api.once('/api/v1/balances/set-alert', {
      status: 400,
      json: { message: 'Alert threshold must be less than credit limit' },
    });

    await expect(setAlertThreshold(session(), 999)).rejects.toThrow(/must be less than credit limit/);
  });
});

// ── the init session ────────────────────────────────────────────────────────

describe('the `rdk init` session', () => {
  it('authenticates from an in-memory token, before config.json exists', async () => {
    // `rdk init` registers, then runs the plan and credit steps, and only writes
    // ~/.rdk/config.json at the very end. A config-backed client throws there —
    // which is exactly why init used to carry its own raw-fetch copy.
    const s = sessionFromToken(api.url, 'fresh-token');

    await selectPlan(s, { planId: 'pro', interval: 'monthly', method: 'stripe' });

    expect(api.last('/api/v1/plans/select')!.headers.authorization).toBe('Bearer fresh-token');
  });

  it('drives the identical request bodies as the configured session', async () => {
    await selectPlan(sessionFromToken(api.url, 'fresh-token'), {
      planId: 'pro',
      interval: 'monthly',
      method: 'stripe',
    });
    const fromInit = api.last('/api/v1/plans/select')!.body;

    api.reset();
    seedHappyPath(api);
    await selectPlan(session(), { planId: 'pro', interval: 'monthly', method: 'stripe' });
    const fromAccount = api.last('/api/v1/plans/select')!.body;

    // The whole point of the refactor: onboarding and the account command can no
    // longer drift apart.
    expect(fromInit).toEqual(fromAccount);
  });

  it('reaches the same top-up and activation endpoints', async () => {
    const s = sessionFromToken(api.url, 'fresh-token');

    await createTopup(s, { amountUsd: 20, method: 'stripe' });
    await activateCryptoPlan(s, {
      planId: 'pro',
      buyerWallet: '0x1111111111111111111111111111111111111111',
    });
    await setCreditLimit(s, 20);
    await setAlertThreshold(s, 5);

    expect(api.requests.map((r) => r.pathname)).toEqual([
      '/api/v1/balances/topup',
      '/api/v1/plans/activate-crypto',
      '/api/v1/balances/set-limit',
      '/api/v1/balances/set-alert',
    ]);
  });
});

// ── misc ────────────────────────────────────────────────────────────────────

describe('helpers', () => {
  it('derives the dashboard origin from the API host', () => {
    expect(dashboardUrlFor('https://api.retrodeck.ai')).toBe('https://dashboard.retrodeck.ai');
  });

  it('leaves a localhost base alone — there is no api. subdomain to swap', () => {
    expect(dashboardUrlFor('http://localhost:3001')).toBe('http://localhost:3001');
  });

  it('returns the plan catalogue from the server, never a local table', async () => {
    const plans = await fetchPlans(session());
    expect(plans.map((p) => p.id)).toEqual(['free', 'starter', 'pro', 'enterprise']);
    expect(plans.find((p) => p.id === 'pro')!.price_monthly).toBe(97);
  });

  it('exposes PaymentApiError for callers that branch on status', () => {
    expect(new PaymentApiError('nope', 402)).toMatchObject({ status: 402, name: 'PaymentApiError' });
  });
});

afterEach(() => {
  // A contract violation answers 400, which several callers treat as a
  // benign "not yet" — so it has to be asserted explicitly or it hides.
  expect(api.violations, api.violations.join("\n")).toEqual([]);
  api.reset();
});

// ── low-balance status ──────────────────────────────────────────────────────

describe('low-balance status', () => {
  it('carries the server-computed status through untouched', async () => {
    api.on('/api/v1/balances/me', {
      json: {
        balanceUsdc: 4,
        creditLimitUsd: 0,
        alertThreshold: null,
        withdrawable: 4,
        balanceStatus: {
          level: 'low',
          balance: 4,
          threshold: 5,
          thresholdIsDefault: true,
          muted: false,
          spendable: 4,
          message: 'Your query credit is running low ($4.00). Consider topping up.',
          action: 'topup',
        },
      },
    });

    const balance = await fetchBalance(session());

    // The CLI must not recompute the level or rewrite the copy — that is how the
    // three surfaces end up disagreeing about whether the user is in trouble.
    expect(balance.status).toMatchObject({ level: 'low', action: 'topup' });
    expect(balance.status!.message).toBe(
      'Your query credit is running low ($4.00). Consider topping up.',
    );
  });

  it('distinguishes an unset threshold from a muted one', async () => {
    api.on('/api/v1/balances/me', {
      json: { balanceUsdc: 10, creditLimitUsd: 0, alertThreshold: null, withdrawable: 10 },
    });
    expect((await fetchBalance(session())).alertThreshold).toBeNull();

    api.on('/api/v1/balances/me', {
      json: { balanceUsdc: 10, creditLimitUsd: 0, alertThreshold: 0, withdrawable: 10 },
    });
    // Collapsing null to 0 here would report every unconfigured user as muted.
    expect((await fetchBalance(session())).alertThreshold).toBe(0);
  });

  it('tolerates an API that predates balanceStatus', async () => {
    api.on('/api/v1/balances/me', {
      json: { balanceUsdc: 10, creditLimitUsd: 0, alertThreshold: null, withdrawable: 10 },
    });

    const balance = await fetchBalance(session());
    // Deploy skew: the CLI ships independently of the API and must not crash.
    expect(balance.status).toBeUndefined();
    expect(balance.balanceUsdc).toBe(10);
  });
});

// ── crypto subscription health ──────────────────────────────────────────────

describe('crypto subscription health', () => {
  it('reports a lapsed subscription with an actionable remedy', async () => {
    api.on('/api/v1/plans/subscription/health', {
      json: {
        status: 'lapsed',
        planId: 'pro',
        reason: 'insufficient_balance',
        nextRetryAt: null,
        requiredAmountUsdc: 97,
        buyerWallet: '0x1111111111111111111111111111111111111111',
        collector: '0x00000000000000000000000000000000000000b2',
        remedy: 'fund_wallet',
        message: 'Your wallet ran out of USDC, so the subscription stopped.',
      },
    });

    const health = await fetchSubscriptionHealth(session());

    // `remedy` is the whole point: the three lapse causes look identical from
    // the outside but need completely different actions.
    expect(health).toMatchObject({ status: 'lapsed', remedy: 'fund_wallet', requiredAmountUsdc: 97 });
  });

  it('returns null rather than throwing when the endpoint is absent', async () => {
    api.on('/api/v1/plans/subscription/health', { status: 404, json: {} });

    // The CLI ships independently of the API — an older server must not break
    // `rdk account`.
    await expect(fetchSubscriptionHealth(session())).resolves.toBeNull();
  });

  it('reports none for a user with no crypto subscription', async () => {
    api.on('/api/v1/plans/subscription/health', {
      json: {
        status: 'none', planId: null, reason: null, nextRetryAt: null,
        requiredAmountUsdc: null, buyerWallet: null, collector: null,
        remedy: 'none', message: 'No crypto subscription.',
      },
    });

    const health = await fetchSubscriptionHealth(session());
    expect(health).toMatchObject({ status: 'none', remedy: 'none' });
  });
});
