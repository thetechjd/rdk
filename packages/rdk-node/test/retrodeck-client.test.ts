import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updateConfig, loadConfig, saveConfig, type RDKConfig } from '../src/config.js';
import {
  RETRODECK_DEFAULT_URL,
  createTopup,
  dashboardUrl,
  selectPlan,
  verifySubscription,
  verifyTopup,
} from '../src/retrodeck-client.js';

const API = 'http://127.0.0.1:19099';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let captured: Captured[] = [];
let responses: Array<{ status: number; json?: unknown }> = [];

function respond(...queue: Array<{ status: number; json?: unknown }>) {
  responses = queue;
}

/** A minimal but complete `~/.rdk/config.json`, as `rdk init` would leave it. */
function seedConfig(overrides: Partial<RDKConfig> = {}): void {
  saveConfig({
    nodeId: 'node-test',
    apiKey: 'test-api-key',
    centralApiUrl: 'http://127.0.0.1:19098',
    plan: 'free',
    vaultAdapter: 'filesystem',
    vaultPath: '/tmp/vault',
    domain: 'test',
    walletChain: 'base',
    mcpPort: 7777,
    createdAt: new Date(0).toISOString(),
    retrodeckApiUrl: API,
    retrodeckAccessToken: 'access-1',
    retrodeckRefreshToken: 'refresh-1',
    ...overrides,
  });
}

beforeEach(() => {
  captured = [];
  responses = [];
  seedConfig();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      captured.push({
        url: String(url),
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const next = responses.shift() ?? { status: 200, json: {} };
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        json: async () => next.json ?? {},
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dashboardUrl', () => {
  it('derives the dashboard origin from the API host', () => {
    updateConfig({ retrodeckApiUrl: 'https://api.retrodeck.ai' });
    expect(dashboardUrl()).toBe('https://dashboard.retrodeck.ai');
  });

  it('falls back to the default API host when none is configured', () => {
    seedConfig({ retrodeckApiUrl: undefined });
    expect(dashboardUrl()).toBe('https://dashboard.retrodeck.ai');
    expect(RETRODECK_DEFAULT_URL).toBe('https://api.retrodeck.ai');
  });

  it('leaves a localhost base untouched — there is no api. subdomain to swap', () => {
    updateConfig({ retrodeckApiUrl: 'http://localhost:3001' });
    expect(dashboardUrl()).toBe('http://localhost:3001');
  });
});

describe('selectPlan — the request the desktop actually sends', () => {
  it('sends interval/method/source only for paid plans', async () => {
    respond({ status: 200, json: { checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_1' } });

    const res = await selectPlan('pro', 'monthly', 'stripe');

    expect(res.checkoutUrl).toBe('https://checkout.stripe.com/c/pay/cs_1');
    expect(captured[0].url).toBe(`${API}/api/v1/plans/select`);
    expect(captured[0].method).toBe('POST');
    expect(captured[0].body).toEqual({
      planId: 'pro',
      interval: 'monthly',
      method: 'stripe',
      source: 'desktop',
    });
  });

  it('marks crypto upgrades as method:cryptocadet, source:desktop', async () => {
    respond({
      status: 200,
      json: {
        checkoutUrl: 'https://dashboard.retrodeck.ai/dashboard/billing/subscribe/cryptocadet?ref=ccsub_1',
      },
    });

    const res = await selectPlan('pro', 'monthly', 'cryptocadet');

    expect(captured[0].body).toMatchObject({ method: 'cryptocadet', source: 'desktop' });
    // The desktop has no wallet: crypto must hand off to the hosted page, never
    // to a Stripe URL and never to null (which would open nothing).
    expect(res.checkoutUrl).toContain('/dashboard/billing/subscribe/cryptocadet');
  });

  it('downgrades to free with a bare {planId} body', async () => {
    respond({ status: 200, json: { checkoutUrl: null } });

    const res = await selectPlan('free');

    // `forbidNonWhitelisted` is not the issue here — sending `method:'stripe'`
    // alongside a free plan would be accepted but is semantically wrong, and a
    // non-null checkoutUrl would send the user to a checkout for a $0 plan.
    expect(captured[0].body).toEqual({ planId: 'free' });
    expect(res.checkoutUrl).toBeNull();
  });

  it('throws with the status code when the backend rejects the change', async () => {
    respond({ status: 402 });
    await expect(selectPlan('pro', 'monthly')).rejects.toThrow('Plan change failed (HTTP 402)');
  });
});

describe('createTopup', () => {
  it('sends the amount, method, desktop source and a dashboard returnUrl', async () => {
    updateConfig({ retrodeckApiUrl: 'https://api.retrodeck.ai' });
    respond({ status: 200, json: { checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_2', paymentId: 'pay_1' } });

    const res = await createTopup(25, 'stripe');

    expect(captured[0].body).toEqual({
      amountUsd: 25,
      method: 'stripe',
      source: 'desktop',
      returnUrl: 'https://dashboard.retrodeck.ai',
    });
    expect(res).toEqual({ checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_2', paymentId: 'pay_1' });
  });

  it('returns the hosted crypto checkout page for method:cryptocadet', async () => {
    respond({
      status: 200,
      json: { checkoutUrl: 'https://dashboard.retrodeck.ai/dashboard/billing/cryptocadet?ref=pay_1', paymentId: 'pay_1' },
    });

    const res = await createTopup(25, 'cryptocadet');

    expect(captured[0].body).toMatchObject({ method: 'cryptocadet', source: 'desktop' });
    expect(res.checkoutUrl).toContain('/dashboard/billing/cryptocadet');
  });
});

describe('verifyTopup — the poll/self-heal path (there is no Stripe webhook)', () => {
  it('POSTs with a paymentRef when one is known', async () => {
    respond({ status: 200, json: { completed: true, balance: 67.5 } });

    const res = await verifyTopup('pay_1');

    expect(captured[0].method).toBe('POST');
    expect(captured[0].body).toEqual({ paymentRef: 'pay_1' });
    expect(res).toEqual({ completed: true, balanceUsdc: 67.5 });
  });

  it('GETs without a ref, letting the server pick the most recent pending top-up', async () => {
    respond({ status: 200, json: { completed: false, balance: 42 } });

    const res = await verifyTopup();

    expect(captured[0].method).toBe('GET');
    expect(captured[0].body).toBeUndefined();
    expect(res.completed).toBe(false);
  });

  it('reports not-completed rather than throwing when verification fails', async () => {
    // A failed poll must never crash the caller — the payment may still settle.
    respond({ status: 500 });
    await expect(verifyTopup('pay_1')).resolves.toEqual({ completed: false });
  });
});

describe('verifySubscription', () => {
  it('persists the new plan to config once the payment is confirmed', async () => {
    respond({ status: 200, json: { paid: true, plan: { id: 'pro', name: 'Pro' } } });

    const res = await verifySubscription();

    expect(res).toEqual({ paid: true, planId: 'pro', planName: 'Pro' });
    expect(loadConfig().plan).toBe('pro');
  });

  it('does not touch the stored plan while the payment is unconfirmed', async () => {
    updateConfig({ plan: 'free' });
    respond({ status: 200, json: { paid: false, plan: { id: 'pro', name: 'Pro' } } });

    await verifySubscription();

    expect(loadConfig().plan).toBe('free');
  });
});

describe('401 refresh-and-retry', () => {
  it('exchanges the refresh token, persists the rotated one, and retries once', async () => {
    respond(
      { status: 401 },
      { status: 200, json: { accessToken: 'access-2', refreshToken: 'refresh-2' } },
      { status: 200, json: { checkoutUrl: null } },
    );

    await selectPlan('free');

    expect(captured.map((c) => c.url)).toEqual([
      `${API}/api/v1/plans/select`,
      `${API}/api/v1/auth/refresh`,
      `${API}/api/v1/plans/select`,
    ]);
    // The retry must carry the NEW token, and the rotated refresh token must be
    // written to disk — otherwise the next command 401s again.
    expect(captured[2].headers.Authorization).toBe('Bearer access-2');
    expect(loadConfig().retrodeckAccessToken).toBe('access-2');
    expect(loadConfig().retrodeckRefreshToken).toBe('refresh-2');
  });

  it('raises RetrodeckAuthError when the refresh token itself is rejected', async () => {
    respond({ status: 401 }, { status: 401 });

    await expect(selectPlan('free')).rejects.toMatchObject({ name: 'RetrodeckAuthError' });
  });
});
