// packages/rdk-cli/src/commands/cryptocadet.ts
//
// Drives the CryptoCadet CLI (`cryptocadet` / `ccx`) for a crypto top-up during `rdk init`.
// RetroDeck is the merchant: it mints a signed quote (via mintQuote()); this module gets
// the user's local signer installed, initialized, and funded, then pays the quote on-chain.
//
// Ordering matters: we FUND before minting the quote. Quotes are time-boxed (~5 min TTL),
// but funding is a human on-chain action that can take much longer — so the quote is minted
// only once the float is ready, then paid immediately.
//
// The CryptoCadet CLI holds the wallet key; RDK never sees it. We only spawn the binary.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confirm } from '../prompts.js';
import { note, success, warning, t } from '../theme.js';

/** The crypto payload RetroDeck returns on a `cryptocadet` top-up (balances/topup). */
export interface CryptoCadetTopup {
  quote: unknown; // full SignedQuote — passed verbatim to `cryptocadet checkout`
  server: string;
  recipient: string;
  token: string; // USDC address, lowercased
  amount: string; // base units
  chainId: number;
}

interface WalletShow {
  agentAddress: string;
  chainId: number;
  tokens: Array<{ token: string; symbol: string; balance: string; reserve: string; spendable: string }>;
}

type CheckoutStatus = 'CONFIRMED' | 'PENDING' | 'REFUSED' | 'ESCALATE' | 'DUPLICATE' | 'FAILED';

export type TopupOutcome =
  | { status: 'paid' } // broadcast (CONFIRMED/PENDING/DUPLICATE) — poll verify-topup next
  | { status: 'skipped'; detail: string }
  | { status: 'failed'; detail: string };

const CRYPTOCADET_HOME =
  process.env.CRYPTOCADET_HOME ?? path.join(os.homedir(), '.cryptocadet');

/** Locate the CryptoCadet binary on PATH (ENOENT ⇒ not installed). Any exit code counts as
 *  "present" — the CLI exits non-zero on an unknown verb but the binary still ran. */
function findBin(): string | null {
  for (const bin of ['cryptocadet', 'ccx']) {
    const r = spawnSync(bin, ['policy:show'], { stdio: 'ignore' });
    if (!r.error) return bin;
  }
  return null;
}

/** Run the CLI capturing stdout as JSON; stdin/stderr are inherited so keychain prompts and
 *  errors reach the user. Returns the parsed object, or null on non-zero exit / bad JSON. */
function runJson<T>(bin: string, args: string[]): T | null {
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
    timeout: 10 * 60 * 1000,
  });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return null;
  }
}

function isInitialized(): boolean {
  return fs.existsSync(path.join(CRYPTOCADET_HOME, 'config.json'));
}

/** Ensure `cryptocadet` is installed; offer a global npm install if it's missing. */
async function ensureInstalled(): Promise<string | null> {
  let bin = findBin();
  if (bin) return bin;

  note('CryptoCadet CLI is not installed — it holds your agent wallet and signs payments.');
  const ok = await confirm({ message: 'Install @cryptocadet/cli now (npm i -g)?', default: true });
  if (!ok) {
    note('Skipped. Install it with: npm i -g @cryptocadet/cli   (or https://cryptocadet.app/install.sh)');
    return null;
  }

  const r = spawnSync('npm', ['install', '-g', '@cryptocadet/cli'], {
    stdio: 'inherit',
    timeout: 5 * 60 * 1000,
  });
  if (r.status !== 0) {
    warning('npm install failed. On a locked-down machine try the standalone installer:');
    note('  curl -fsSL https://cryptocadet.app/install.sh | sh');
    return null;
  }
  bin = findBin();
  if (!bin) {
    warning('CryptoCadet installed but not on PATH — open a new terminal and re-run rdk init.');
    return null;
  }
  success('CryptoCadet CLI installed');
  return bin;
}

/** Run `cryptocadet init` interactively if the signer isn't set up yet. */
async function ensureInitialized(bin: string): Promise<boolean> {
  if (isInitialized()) return true;
  note("Let's set up your CryptoCadet agent wallet (one-time). Pick the buyer role.");
  console.log('');
  // Interactive: the user chooses network/role and sees their new wallet address. Its own
  // banner + prompts run on the inherited terminal.
  const r = spawnSync(bin, ['init'], { stdio: 'inherit' });
  if (r.status !== 0 || !isInitialized()) {
    warning('CryptoCadet setup did not complete. Run `cryptocadet init` then retry.');
    return false;
  }
  return true;
}

function walletShow(bin: string): WalletShow | null {
  return runJson<WalletShow>(bin, ['wallet:show', '--json']);
}

function usdcEntry(w: WalletShow) {
  return w.tokens.find((x) => x.symbol.toUpperCase() === 'USDC') ?? w.tokens[0];
}

/** Poll the agent wallet until its USDC covers `amountBaseUnits`. Funding is a human action
 *  (send USDC from the main wallet to the agent address) — never auto-drained. `field` is
 *  'spendable' for per-call top-ups (respects the reserve) or 'balance' for subscription
 *  funding (the collector pulls against raw balance, not spendable). */
async function ensureFunded(
  bin: string,
  amountBaseUnits: string,
  field: 'spendable' | 'balance' = 'spendable',
): Promise<boolean> {
  const need = BigInt(amountBaseUnits);
  for (;;) {
    const w = walletShow(bin);
    if (!w) {
      warning('Could not read the agent wallet balance (`cryptocadet wallet:show`).');
      return false;
    }
    const usdc = usdcEntry(w);
    const have = BigInt((field === 'balance' ? usdc?.balance : usdc?.spendable) ?? '0');
    if (have >= need) {
      success(`Agent wallet funded (${fmtUsdc(have)} USDC)`);
      return true;
    }

    const shortfall = need - have;
    console.log('');
    note(`Your agent wallet needs ${fmtUsdc(shortfall)} more USDC (chain ${w.chainId}).`);
    note('Send USDC from your main wallet to your agent address:');
    console.log(`  ${t.body(w.agentAddress)}`);
    // topup:request prints the exact per-token shortfall + agent address (no auto-drain).
    spawnSync(bin, ['topup:request', `${(usdc?.token ?? '').toLowerCase()}=${amountBaseUnits}`], { stdio: 'inherit' });
    console.log('');
    const again = await confirm({ message: 'Sent it? Check the balance again', default: true });
    if (!again) {
      note('Fund the wallet later, then run `rdk init` again to finish your top-up.');
      return false;
    }
  }
}

/** Pay the merchant quote via `cryptocadet checkout`. Allowlists the payout recipient first
 *  (the buyer policy ships with none) and re-runs with --approve on an ESCALATE decision. */
async function payQuote(bin: string, topup: CryptoCadetTopup): Promise<TopupOutcome> {
  const file = path.join(os.tmpdir(), `rdk-ccx-quote-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(topup.quote), { mode: 0o600 });
  try {
    let res = runJson<{ status: CheckoutStatus; reason?: string }>(bin, [
      'checkout', '--quote-file', file, '--allowlist-recipient', '--json',
    ]);

    if (res?.status === 'ESCALATE') {
      note(`This payment is above your per-tx auto-approve limit: ${res.reason ?? ''}`);
      const approve = await confirm({ message: `Approve paying ${fmtUsdc(BigInt(topup.amount))} USDC now?`, default: true });
      if (!approve) return { status: 'skipped', detail: 'escalation not approved' };
      res = runJson<{ status: CheckoutStatus; reason?: string }>(bin, [
        'checkout', '--quote-file', file, '--approve', '--json',
      ]);
    }

    if (!res) return { status: 'failed', detail: 'checkout produced no result (see errors above)' };
    switch (res.status) {
      case 'CONFIRMED':
      case 'PENDING':
      case 'DUPLICATE':
        return { status: 'paid' };
      case 'REFUSED':
      case 'FAILED':
        return { status: 'failed', detail: res.reason ?? res.status };
      case 'ESCALATE':
        return { status: 'skipped', detail: 'still requires approval' };
      default:
        return { status: 'failed', detail: `unexpected status ${res.status}` };
    }
  } finally {
    try { fs.unlinkSync(file); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Full crypto top-up: install → init → fund → mint quote → pay. Returns `paid` once the
 * on-chain payment is broadcast (the caller then polls verify-topup to confirm crediting).
 * `amountUsd` is whole dollars; USDC is 6-decimal so base units = dollars × 1e6.
 */
export async function payTopupWithCryptocadet(opts: {
  amountUsd: number;
  mintQuote: () => Promise<CryptoCadetTopup | null>;
}): Promise<TopupOutcome> {
  const bin = await ensureInstalled();
  if (!bin) return { status: 'skipped', detail: 'CryptoCadet CLI not installed' };

  if (!(await ensureInitialized(bin))) return { status: 'skipped', detail: 'signer not initialized' };

  const amountBaseUnits = (BigInt(Math.round(opts.amountUsd)) * 1_000_000n).toString();
  if (!(await ensureFunded(bin, amountBaseUnits))) return { status: 'skipped', detail: 'wallet not funded' };

  // Mint the quote LAST — right before we pay it — so its short TTL isn't spent waiting.
  const topup = await opts.mintQuote();
  if (!topup || !topup.quote) return { status: 'failed', detail: 'could not obtain a payment quote' };

  note(`Paying ${fmtUsdc(BigInt(topup.amount))} USDC on chain ${topup.chainId} → ${topup.recipient}`);
  return payQuote(bin, topup);
}

/** The crypto payload RetroDeck returns on a `cryptocadet` plan selection. */
export interface CryptoCadetPlanOffer {
  subscriptionRef: string;
  collector: string;
  token: string; // USDC address
  amountPerPeriod: string; // base units
  cap: string; // base units (total on-chain approval)
  periodSeconds: number;
  interval: string;
  chainId: number;
  server: string;
}

export type SubscribeOutcome =
  | { status: 'granted'; buyerWallet: string } // approval on-chain; caller registers + verifies
  | { status: 'skipped'; detail: string }
  | { status: 'failed'; detail: string };

/**
 * Grant the on-chain approval for a crypto subscription: install → init → fund (at least one
 * period, against raw balance) → `cryptocadet subs:grant --collector --cap`. Returns the
 * buyer's agent wallet so the caller can register the subscription with RetroDeck.
 * Funding note: the wallet also needs a little native ETH for the approve tx's gas.
 */
export async function grantCryptocadetSubscription(offer: CryptoCadetPlanOffer): Promise<SubscribeOutcome> {
  const bin = await ensureInstalled();
  if (!bin) return { status: 'skipped', detail: 'CryptoCadet CLI not installed' };
  if (!(await ensureInitialized(bin))) return { status: 'skipped', detail: 'signer not initialized' };

  // Need at least one period's worth of USDC in the wallet for the first pull.
  if (!(await ensureFunded(bin, offer.amountPerPeriod, 'balance'))) {
    return { status: 'skipped', detail: 'wallet not funded for the first period' };
  }

  const w = walletShow(bin);
  if (!w?.agentAddress) return { status: 'failed', detail: 'could not read agent wallet address' };

  note(`Approving ${fmtUsdc(BigInt(offer.cap))} USDC of pull authority to the collector...`);
  const grant = runJson<{ txHash?: string }>(bin, [
    'subs:grant', '--token', offer.token, '--collector', offer.collector, '--cap', offer.cap,
  ]);
  if (!grant?.txHash) return { status: 'failed', detail: 'approval transaction failed (see errors above)' };

  success(`Approval granted (tx ${grant.txHash})`);
  return { status: 'granted', buyerWallet: w.agentAddress };
}

function fmtUsdc(base: bigint): string {
  const whole = base / 1_000_000n;
  const frac = (base % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
