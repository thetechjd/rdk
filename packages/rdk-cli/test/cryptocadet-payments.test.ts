import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CRYPTO_PLAN_OFFER, CRYPTO_TOPUP, seedHappyPath, startStubApi, type StubApi } from './helpers/stub-api.js';
import { installFakeCadet, type CadetScenario, type FakeCadet } from './helpers/fake-cadet.js';
import { seedCliConfig } from './helpers/cli-config.js';

/**
 * Checkpoints 12 and 15 — the CLI crypto rails.
 *
 * These drive the REAL `commands/cryptocadet.ts` against a fake `cryptocadet`
 * binary on PATH. That boundary is where the surprises live: the CryptoCadet CLI
 * exits 0 for every business outcome, so the status is on stdout JSON, and its
 * default policy escalates anything above 0.50 USDC. Code that branches on the
 * exit code treats a REFUSED payment as a crash and an ESCALATE as a success.
 *
 * `CRYPTOCADET_HOME` is read into a module-level const at import time, so the
 * module under test is imported dynamically AFTER the fake is installed.
 */
let api: StubApi;
let cadet: FakeCadet | undefined;

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
  // Auto-answer confirm(), EXCEPT the "install/update @cryptocadet/cli now?"
  // prompts — accepting those makes the test shell out to a real `npm i -g`,
  // which touches the developer's machine, needs the network, and fails with
  // EACCES on CI. Declining is also the more useful assertion: it proves RDK
  // stops cleanly instead of proceeding without a signer.
  vi.doMock('../src/prompts.js', () => ({
    confirm: vi.fn(async (opts: { message?: string } = {}) =>
      !/\b(install|update)\b/i.test(opts.message ?? '')),
    select: vi.fn(async () => 'stripe'),
    input: vi.fn(async () => ''),
    pressEnter: vi.fn(async () => {}),
  }));
});

afterEach(() => {
  cadet?.cleanup();
  cadet = undefined;
  vi.resetModules();
  vi.doUnmock('../src/prompts.js');
});

/** Import the module fresh, so it picks up the current CRYPTOCADET_HOME/PATH. */
async function loadCryptocadet() {
  vi.resetModules();
  return import('../src/commands/cryptocadet.js');
}

// ── Checkpoint 15 · top-up via crypto ───────────────────────────────────────

describe('Checkpoint 15 · CLI top-up via crypto', () => {
  async function payTopup(scenario: CadetScenario = 'confirmed', opts: { spendable?: string } = {}) {
    cadet = installFakeCadet({ scenario, initialized: true, ...opts });
    const { payTopupWithCryptocadet } = await loadCryptocadet();
    return payTopupWithCryptocadet({
      amountUsd: 25,
      mintQuote: async () => CRYPTO_TOPUP as never,
    });
  }

  it('reports paid on CONFIRMED', async () => {
    await expect(payTopup('confirmed')).resolves.toEqual({ status: 'paid' });
  });

  it('treats PENDING as paid — the transaction was broadcast', async () => {
    // Broadcast-but-unconfirmed money is spent. Re-paying would double-charge, so
    // PENDING must go to the verify poll, not back to the pay button.
    await expect(payTopup('pending')).resolves.toEqual({ status: 'paid' });
  });

  it('treats DUPLICATE as paid — the ledger already has this quote', async () => {
    await expect(payTopup('duplicate')).resolves.toEqual({ status: 'paid' });
  });

  it('does NOT report paid on REFUSED', async () => {
    const outcome = await payTopup('refused');
    expect(outcome.status).toBe('failed');
    expect((outcome as { detail: string }).detail).toMatch(/not allowlisted/);
  });

  it('does NOT report paid on FAILED', async () => {
    const outcome = await payTopup('failed');
    expect(outcome.status).toBe('failed');
  });

  it('re-runs with --approve when the policy escalates, and only then pays', async () => {
    // The shipped policy escalates above 0.50 USDC, so a realistic top-up ALWAYS
    // lands here first. Every one of these runs exits 0.
    const outcome = await payTopup('escalate');

    expect(outcome).toEqual({ status: 'paid' });
    const checkouts = cadet!.callsTo('checkout');
    expect(checkouts).toHaveLength(2);
    expect(checkouts[0].argv).not.toContain('--approve');
    expect(checkouts[1].argv).toContain('--approve');
  });

  it('allowlists the quote recipient on the first attempt', async () => {
    await payTopup('confirmed');
    // The buyer policy ships with an EMPTY recipient list, so without this every
    // first payment is REFUSED.
    expect(cadet!.callsTo('checkout')[0].argv).toContain('--allowlist-recipient');
  });

  it('passes the quote by file, and cleans the file up', async () => {
    await payTopup('confirmed');

    const argv = cadet!.callsTo('checkout')[0].argv;
    const idx = argv.indexOf('--quote-file');
    expect(idx).toBeGreaterThanOrEqual(0);

    const file = argv[idx + 1];
    const fs = await import('node:fs');
    // The quote is written 0600 to a temp path; leaving it behind leaks a signed
    // payment authorisation onto disk.
    expect(fs.existsSync(file)).toBe(false);
  });

  it('funds the wallet BEFORE paying the quote', async () => {
    await payTopup('confirmed', { spendable: '0' });

    const verbs = cadet!.calls().map((c) => c.argv[0]);
    // Quotes carry a ~5-minute TTL while funding is a slow human action, so the
    // order is deliberate (see the header comment in commands/cryptocadet.ts).
    expect(verbs.indexOf('topup:request')).toBeLessThan(verbs.indexOf('checkout'));
  });

  it('reads the shortfall against the exact base-unit amount from the server', async () => {
    await payTopup('confirmed', { spendable: '0' });

    const req = cadet!.callsTo('topup:request')[0];
    // `<token>=<baseUnits>`, lowercased token, and the SERVER's amount string —
    // not a locally recomputed one, which is how a decimals bug gets in.
    expect(req.argv[1]).toBe(`${CRYPTO_TOPUP.token.toLowerCase()}=${CRYPTO_TOPUP.amount}`);
  });

  it('skips cleanly when the binary is not installed', async () => {
    cadet = installFakeCadet({ scenario: 'missing' });
    const { payTopupWithCryptocadet } = await loadCryptocadet();

    const outcome = await payTopupWithCryptocadet({
      amountUsd: 25,
      mintQuote: async () => {
        throw new Error('mintQuote must not run when there is no signer');
      },
    });

    expect(outcome.status).toBe('skipped');
    // No quote should have been minted — a quote burns a TTL window and a
    // single-use id for a payment that cannot happen.
    expect(api.to('/api/v1/balances/topup')).toHaveLength(0);
  });

  it('does not pay when the server declines to mint a quote', async () => {
    cadet = installFakeCadet({ scenario: 'confirmed', initialized: true });
    const { payTopupWithCryptocadet } = await loadCryptocadet();

    const outcome = await payTopupWithCryptocadet({ amountUsd: 25, mintQuote: async () => null });

    // 'failed' rather than 'skipped': the wallet was funded on the strength of a
    // top-up that then could not be created, so the user is owed an explanation,
    // not a silent no-op.
    expect(outcome).toEqual({ status: 'failed', detail: 'could not obtain a payment quote' });
    // Whatever the label, nothing may be broadcast without a quote.
    expect(cadet!.callsTo('checkout')).toHaveLength(0);
  });
});

// ── Checkpoint 12 · subscription upgrade via crypto ─────────────────────────

describe('Checkpoint 12 · CLI subscription upgrade via crypto', () => {
  async function grant(scenario: CadetScenario = 'confirmed', opts: { spendable?: string } = {}) {
    cadet = installFakeCadet({
      scenario,
      initialized: true,
      agentAddress: '0x3333333333333333333333333333333333333333',
      ...opts,
    });
    const { grantCryptocadetSubscription } = await loadCryptocadet();
    return grantCryptocadetSubscription(CRYPTO_PLAN_OFFER as never);
  }

  it('grants the approval with exactly the collector and cap the server issued', async () => {
    const outcome = await grant();

    expect(outcome.status).toBe('granted');
    const argv = cadet!.callsTo('subs:grant')[0].argv;
    expect(argv[argv.indexOf('--collector') + 1]).toBe(CRYPTO_PLAN_OFFER.collector);
    // The cap is the TOTAL pull authority delegated. Too small and renewals lapse;
    // too large and the collector can take more than the plan is worth.
    expect(argv[argv.indexOf('--cap') + 1]).toBe(CRYPTO_PLAN_OFFER.cap);
    expect(argv[argv.indexOf('--token') + 1]).toBe(CRYPTO_PLAN_OFFER.token);
  });

  it('returns the agent wallet from the binary, never an assumed address', async () => {
    const outcome = await grant();

    // This address becomes `buyerWallet` on activate-crypto, and the collector
    // pulls `transferFrom(buyerWallet, …)`. A wrong one makes every pull fail.
    expect(outcome).toMatchObject({
      status: 'granted',
      buyerWallet: '0x3333333333333333333333333333333333333333',
    });
  });

  it('funds against raw balance, not spendable', async () => {
    await grant('confirmed', { spendable: '0' });

    // The collector pulls against the raw balance; gating on `spendable` would
    // demand funds the subscription does not actually need.
    expect(cadet!.callsTo('wallet:show').length).toBeGreaterThan(0);
    expect(cadet!.callsTo('subs:grant')).toHaveLength(1);
  });

  it('does not grant when the binary is missing', async () => {
    cadet = installFakeCadet({ scenario: 'missing' });
    const { grantCryptocadetSubscription } = await loadCryptocadet();

    const outcome = await grantCryptocadetSubscription(CRYPTO_PLAN_OFFER as never);
    expect(outcome.status).not.toBe('granted');
  });

  it('reports failure when the grant transaction is rejected', async () => {
    // `subs:grant` is one of the few verbs that exits NON-zero on failure.
    const outcome = await grant('refused');
    expect(outcome.status).not.toBe('granted');
  });
});
