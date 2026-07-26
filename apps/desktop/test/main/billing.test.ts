import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CRYPTO_SUBSCRIBE_PAGE,
  CRYPTO_TOPUP_PAGE,
  STRIPE_CHECKOUT,
  seedHappyPath,
  startStubApi,
  type StubApi,
} from '../helpers/stub-api.js';

/**
 * Checkpoints 6–10 — the desktop payment surface.
 *
 * IMPORTANT: the desktop app has NO WALLET. Both crypto checkpoints are
 * handoff-and-poll: the backend returns a HOSTED dashboard page, the app opens it
 * with `shell.openExternal`, and then polls. Any test here that pretends to sign
 * a transaction would be testing something the product does not do.
 *
 * These drive the real `electron/node-service.ts` through the real
 * `@rdk/node/retrodeck-client` against a stub HTTP server, so the wiring between
 * the two layers is under test. Only Electron itself and @rdk/core are mocked —
 * one needs a display, the other loads SQLite and an ONNX runtime.
 */

const openExternal = vi.fn(async () => {});

vi.mock('electron', () => ({
  shell: { openExternal },
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0-test' },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: class {},
}));

vi.mock('@rdk/core', () => ({
  LocalStore: class {},
  RDKRouter: class {},
  RDKIndexer: class {},
  LocalEmbeddingModel: class {},
  cosineSimilarity: () => 0,
  keyFromHex: () => undefined,
  decrypt: () => '',
  fileState: () => ({}),
}));

vi.mock('@rdk/node/sync-service', () => ({ SyncService: class {} }));

let api: StubApi;
let service: import('../../electron/node-service.js').NodeService;

/** Write a config as `rdk init` would leave it, pointed at the stub server. */
async function seedConfig(apiUrl: string, overrides: Record<string, unknown> = {}) {
  const { saveConfig } = await import('@rdk/node/config');
  saveConfig({
    nodeId: 'node-test',
    apiKey: 'test-api-key',
    centralApiUrl: 'http://127.0.0.1:1',
    plan: 'free',
    vaultAdapter: 'filesystem',
    vaultPath: '/tmp/vault',
    domain: 'test',
    walletChain: 'base',
    mcpPort: 7777,
    createdAt: new Date(0).toISOString(),
    retrodeckApiUrl: apiUrl,
    retrodeckAccessToken: 'access-1',
    retrodeckRefreshToken: 'refresh-1',
    ...overrides,
  } as never);
}

beforeAll(async () => {
  api = await startStubApi();
});

afterAll(async () => {
  await api.close();
});

beforeEach(async () => {
  api.reset();
  seedHappyPath(api);
  await seedConfig(api.url);
  openExternal.mockClear();

  const { NodeService } = await import('../../electron/node-service.js');
  service = new NodeService();
});

afterEach(() => {
  // A contract violation answers 400, which several callers treat as a
  // benign "not yet" — so it has to be asserted explicitly or it hides.
  expect(api.violations, api.violations.join("\n")).toEqual([]);
  vi.clearAllMocks();
});

// ── Checkpoint 6 · subscription upgrade via Stripe ──────────────────────────

describe('Checkpoint 6 · Desktop subscription upgrade via Stripe', () => {
  it('sends planId, interval, method and source:desktop', async () => {
    const result = await service.selectPlan('pro', 'monthly', 'stripe');

    expect(result.ok).toBe(true);
    expect(api.last('/api/v1/plans/select')!.body).toEqual({
      planId: 'pro',
      interval: 'monthly',
      method: 'stripe',
      // `source: 'desktop'` is what makes the server return to the static
      // "close this tab" page — a desktop user has no dashboard tab open.
      source: 'desktop',
    });
  });

  it('opens the checkout URL in the system browser, exactly once', async () => {
    await service.selectPlan('pro', 'monthly', 'stripe');

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(STRIPE_CHECKOUT);
  });

  it('does NOT open a browser when the server rejects the change', async () => {
    api.once('/api/v1/plans/select', { status: 402, json: { message: 'nope' } });

    const result = await service.selectPlan('pro', 'monthly', 'stripe');

    expect(result.ok).toBe(false);
    // Sending the user to a browser after a failed call opens a stale or blank
    // page and reads as "the app is broken".
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('persists the new plan to config once verification confirms it', async () => {
    const { loadConfig } = await import('@rdk/node/config');

    const result = await service.verifySubscription();

    expect(result.paid).toBe(true);
    // The status bar and plan badge read from config, so a confirmed payment that
    // is never persisted shows the user their OLD plan until they re-launch.
    expect(loadConfig().plan).toBe('pro');
  });

  it('reports unpaid without touching config while the payment is pending', async () => {
    api.on('/api/v1/plans/verify-payment', { json: { plan: { id: 'pro' }, paid: false } });
    const { loadConfig } = await import('@rdk/node/config');

    const result = await service.verifySubscription();

    expect(result.paid).toBe(false);
    expect(loadConfig().plan).toBe('free');
  });

  it('never throws from verifySubscription — it runs on a poll timer', async () => {
    api.on('/api/v1/plans/verify-payment', { status: 500, json: {} });

    // A throw here would surface as an unhandled rejection inside a setTimeout in
    // the renderer, killing the poll loop for the rest of the session.
    await expect(service.verifySubscription()).resolves.toEqual({ paid: false });
  });
});

// ── Checkpoint 7 · subscription upgrade via crypto ──────────────────────────

describe('Checkpoint 7 · Desktop subscription upgrade via crypto', () => {
  it('marks the request as cryptocadet from the desktop', async () => {
    await service.selectPlan('pro', 'monthly', 'cryptocadet');

    expect(api.last('/api/v1/plans/select')!.body).toMatchObject({
      method: 'cryptocadet',
      source: 'desktop',
    });
  });

  it('opens the HOSTED subscribe page, not a Stripe URL', async () => {
    const result = await service.selectPlan('pro', 'monthly', 'cryptocadet');

    expect(result.ok).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(CRYPTO_SUBSCRIBE_PAGE);
    // The desktop has no wallet. If a backend regression ever routed
    // `source: 'desktop'` into the CLI branch, `checkoutUrl` would be null and
    // the app would open nothing at all while reporting success.
    const opened = openExternal.mock.calls[0][0] as string;
    expect(opened).toContain('/dashboard/billing/subscribe/cryptocadet');
    expect(opened).not.toContain('checkout.stripe.com');
  });

  it('never calls activate-crypto — that is the CLI\'s job, not the desktop\'s', async () => {
    await service.selectPlan('pro', 'monthly', 'cryptocadet');
    await service.verifySubscription();

    // The hosted page performs the on-chain grant and registers the
    // subscription. The desktop only hands off and polls.
    expect(api.to('/api/v1/plans/activate-crypto')).toHaveLength(0);
  });

  it('reports failure rather than opening nothing when no URL comes back', async () => {
    api.once('/api/v1/plans/select', { json: { plan: { id: 'pro' }, checkoutUrl: null } });

    const result = await service.selectPlan('pro', 'monthly', 'cryptocadet');

    // A paid plan with a null checkoutUrl is a server-side bug; silently doing
    // nothing would leave the user staring at an unchanged screen.
    expect(openExternal).not.toHaveBeenCalled();
    expect(result.checkoutUrl ?? null).toBeNull();
  });
});

// ── Checkpoint 8 · downgrade ────────────────────────────────────────────────

describe('Checkpoint 8 · Desktop subscription downgrade', () => {
  it('sends a bare {planId} for Free', async () => {
    await service.selectPlan('free');

    // No interval and no method — Free has neither a billing period nor a rail.
    expect(api.last('/api/v1/plans/select')!.body).toEqual({ planId: 'free' });
  });

  it('applies in place, opening no browser', async () => {
    const result = await service.selectPlan('free');

    expect(result.ok).toBe(true);
    expect(result.checkoutUrl ?? null).toBeNull();
    // `checkoutUrl: null` means the server already applied it and cancelled the
    // subscription. Opening a browser here would navigate to `null`.
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('shows the server\'s plan, not the locally cached one', async () => {
    // Config still says 'pro' while the server has already applied the downgrade.
    await seedConfig(api.url, { plan: 'pro' });
    api.on('/api/v1/users/me', {
      json: { user: { id: 'u1', email: 'user@example.test', planId: 'free' } },
    });
    const { NodeService } = await import('../../electron/node-service.js');
    const svc = new NodeService();

    // The server is the source of truth for what the user is being billed for;
    // trusting stale local config would show a plan they no longer have.
    expect((await svc.getAccount()).plan).toBe('free');
  });

  it('surfaces a refused cancellation instead of reporting success', async () => {
    api.once('/api/v1/plans/select', {
      status: 502,
      json: { message: 'Could not cancel your subscription' },
    });

    const result = await service.selectPlan('free');

    // The server refuses the downgrade if Stripe would not cancel. Reporting
    // success here tells the user they stopped paying while charges continue.
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ── Checkpoint 9 · top-up via Stripe ────────────────────────────────────────

describe('Checkpoint 9 · Desktop top-up via Stripe', () => {
  it('sends amount, method, source:desktop and a dashboard returnUrl', async () => {
    await service.createTopup(25, 'stripe');

    const body = api.last('/api/v1/balances/topup')!.body as Record<string, unknown>;
    expect(body).toMatchObject({ amountUsd: 25, method: 'stripe', source: 'desktop' });
    expect(body.returnUrl).toBeTruthy();
  });

  it('opens the checkout and returns the paymentId for the poll', async () => {
    const result = await service.createTopup(25, 'stripe');

    expect(result.ok).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(STRIPE_CHECKOUT);
    // Losing the paymentId silently degrades the poll to "most recent pending",
    // which can credit and report on a DIFFERENT payment.
    expect(result.paymentId).toBe('00000000-0000-4000-8000-000000000001');
  });

  it('threads the paymentId through to verify-topup', async () => {
    const { paymentId } = await service.createTopup(25, 'stripe');
    await service.verifyTopup(paymentId);

    const req = api.last('/api/v1/balances/verify-topup')!;
    expect(req.method).toBe('POST');
    expect(req.body).toEqual({ paymentRef: paymentId });
  });

  it('falls back to a bare GET when no ref is known', async () => {
    await service.verifyTopup();

    expect(api.last('/api/v1/balances/verify-topup')!.method).toBe('GET');
  });

  it('returns the credited balance', async () => {
    await expect(service.verifyTopup('00000000-0000-4000-8000-000000000001')).resolves.toEqual({
      completed: true,
      balanceUsdc: 67.5,
    });
  });

  it('never throws from verifyTopup — it runs on a poll timer', async () => {
    api.on('/api/v1/balances/verify-topup', { status: 500, json: {} });

    await expect(service.verifyTopup('00000000-0000-4000-8000-000000000001')).resolves.toEqual({ completed: false });
  });

  it('does not open a browser when the top-up cannot be created', async () => {
    api.once('/api/v1/balances/topup', { status: 400, json: { message: 'no' } });

    const result = await service.createTopup(25, 'stripe');

    expect(result.ok).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });
});

// ── Checkpoint 10 · top-up via crypto ───────────────────────────────────────

describe('Checkpoint 10 · Desktop top-up via crypto', () => {
  it('opens the hosted crypto checkout page', async () => {
    const result = await service.createTopup(25, 'cryptocadet');

    expect(result.ok).toBe(true);
    expect(api.last('/api/v1/balances/topup')!.body).toMatchObject({
      method: 'cryptocadet',
      source: 'desktop',
    });
    expect(openExternal).toHaveBeenCalledWith(CRYPTO_TOPUP_PAGE);
  });

  it('refuses rather than calling openExternal(null)', async () => {
    // `method: 'cryptocadet'` means a LOCAL signer binary on the CLI, where the
    // server returns checkoutUrl: null. The desktop has no such binary, so a null
    // URL is unusable — it must fail loudly, not pass null to Electron.
    api.once('/api/v1/balances/topup', {
      json: { method: 'cryptocadet', checkoutUrl: null, paymentId: '00000000-0000-4000-8000-000000000001' },
    });

    const result = await service.createTopup(25, 'cryptocadet');

    expect(result.ok).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('polls the same verify endpoint as the card path', async () => {
    const { paymentId } = await service.createTopup(25, 'cryptocadet');
    await service.verifyTopup(paymentId);

    // Both rails settle through verify-topup; there is no separate crypto path.
    expect(api.to('/api/v1/balances/verify-topup')).toHaveLength(1);
  });
});

// ── the account read ────────────────────────────────────────────────────────

describe('getAccount', () => {
  it('self-heals a pending top-up before reading the balance', async () => {
    await service.getAccount();

    // Crediting happens on verification — there is no Stripe webhook — so a
    // payment completed while the app was closed is rescued here or never.
    expect(api.to('/api/v1/balances/verify-topup')).toHaveLength(1);
    expect(api.to('/api/v1/balances/me')).toHaveLength(1);
  });

  it('reports the live plan and balance', async () => {
    const account = await service.getAccount();

    expect(account).toMatchObject({
      signedIn: true,
      plan: 'pro',
      balanceUsdc: 42.5,
      creditLimitUsd: 10,
    });
  });

  it('still returns a usable account when the balance call fails', async () => {
    api.on('/api/v1/balances/me', { status: 503, json: {} });

    const account = await service.getAccount();

    // The Settings screen must still render; a missing balance is a dash, not a
    // blank page.
    expect(account.signedIn).toBe(true);
    expect(account.balanceUsdc).toBeUndefined();
  });

  it('flags an expired session rather than silently showing signed-out', async () => {
    api.on('/api/v1/balances/verify-topup', { status: 401, json: {} });
    api.on('/api/v1/users/me', { status: 401, json: {} });
    api.on('/api/v1/balances/me', { status: 401, json: {} });
    api.on('/api/v1/auth/refresh', { status: 401, json: {} });

    const account = await service.getAccount();

    expect(account.signedIn).toBe(true);
    expect(account.sessionExpired ?? false).toBe(true);
  });

  it('refreshes an expired access token transparently', async () => {
    api.once('/api/v1/balances/me', { status: 401, json: {} });

    const account = await service.getAccount();

    expect(api.to('/api/v1/auth/refresh').length).toBeGreaterThan(0);
    expect(account.balanceUsdc).toBe(42.5);
  });
});

// ── low-balance status ──────────────────────────────────────────────────────

describe('low-balance status', () => {
  it('passes the server-computed status through to the renderer', async () => {
    api.on('/api/v1/balances/me', {
      json: {
        balanceUsdc: 4,
        creditLimitUsd: 0,
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

    const account = await service.getAccount();

    // Untouched, including the copy — the desktop must not decide for itself what
    // "low" means, or it will disagree with the dashboard and the CLI.
    expect(account.balanceStatus).toMatchObject({ level: 'low', action: 'topup' });
    expect(account.balanceStatus!.message).toBe(
      'Your query credit is running low ($4.00). Consider topping up.',
    );
  });

  it('omits the status when the API predates it', async () => {
    api.on('/api/v1/balances/me', { json: { balanceUsdc: 10, creditLimitUsd: 0 } });

    const account = await service.getAccount();

    // Deploy skew: the desktop app ships on its own cadence and cannot assume the
    // API is as new as it is.
    expect(account.balanceStatus).toBeUndefined();
    expect(account.balanceUsdc).toBe(10);
  });
});
