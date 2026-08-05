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

import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
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

export interface WalletShow {
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

/** First CryptoCadet CLI version with the `checkout` verb rdk pays quotes through.
 *  An older global install (e.g. one the user set up earlier) lacks it — and rdk
 *  auto-installs ONLY when nothing is found — so we gate on this explicitly. */
const MIN_CRYPTOCADET = '0.2.1';

/** Compare dotted numeric versions. <0 if a<b, 0 if equal, >0 if a>b. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * spawnSync that actually resolves npm-global bins on Windows.
 *
 * npm installs global executables as `.cmd` shims (`cryptocadet.cmd`, `npm.cmd`).
 * Node's spawn WITHOUT a shell ignores PATHEXT, so `spawnSync('cryptocadet', …)`
 * ENOENTs even though the shim is on PATH — exactly why PowerShell finds
 * `cryptocadet` but rdk reported it "not installed", and why the `npm install`
 * attempt "failed" without npm ever running. Newer Node also refuses to launch a
 * `.cmd` without a shell (CVE-2024-27980), so `shell: true` is the correct fix.
 * Under a shell args are NOT auto-quoted, so quote them to keep paths with spaces
 * (e.g. C:\Users\First Last\…) intact. POSIX behaviour is unchanged.
 */
function runSync(cmd: string, args: string[], opts: SpawnSyncOptions = {}) {
  if (process.platform === 'win32') {
    const quoted = args.map((a) => `"${String(a).replace(/"/g, '""')}"`);
    return spawnSync(cmd, quoted, { ...opts, shell: true });
  }
  return spawnSync(cmd, args, opts);
}

/** Where the standalone (curl) installer keeps its own copy. Its shim usually
 *  lands on PATH ahead of the npm global prefix, so `npm i -g` can install a new
 *  version that PATH never resolves to. */
const INSTALLER_PREFIX = path.join(os.homedir(), '.cryptocadet-cli');

/** Locate the CryptoCadet binary (⇒ null if not installed). */
function findBin(): string | null {
  for (const bin of ['cryptocadet', 'ccx']) {
    // Windows: `where` applies PATHEXT (.cmd/.exe) like the shell does, so it sees
    // the npm shim; exit 0 ⇒ found. (A plain shell run can't tell "missing" from
    // "ran and exited non-zero" — a missing command yields status≠0 with no error.)
    // POSIX: spawn resolves via PATH and ENOENT (r.error) ⇒ absent; any exit code
    // counts as present — the CLI exits non-zero on an unknown verb but still ran.
    const found = process.platform === 'win32'
      ? spawnSync('where', [bin], { stdio: 'ignore', shell: true }).status === 0
      : !spawnSync(bin, ['policy:show'], { stdio: 'ignore' }).error;
    if (found) return bin;
  }
  return null;
}

/** Where PATH actually resolves `cryptocadet` to. Used only for diagnostics —
 *  a stale standalone install shadowing a fresh `npm i -g` looks identical to
 *  "the update didn't work" unless we can name the file being run. */
function resolvedBinPath(bin: string): string | null {
  if (bin.includes(path.sep)) return bin; // already absolute
  const probe = process.platform === 'win32'
    ? spawnSync('where', [bin], { encoding: 'utf8', shell: true })
    : spawnSync('command', ['-v', bin], { encoding: 'utf8', shell: true });
  const out = (probe.stdout ?? '').toString().trim().split(/\r?\n/)[0];
  return out || null;
}

/** Run the CLI capturing stdout as JSON; stdin/stderr are inherited so keychain prompts and
 *  errors reach the user. Returns the parsed object, or null on non-zero exit / bad JSON. */
function runJson<T>(bin: string, args: string[]): T | null {
  const r = runSync(bin, args, {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
    timeout: 10 * 60 * 1000,
  });
  const out = r.stdout == null ? '' : r.stdout.toString();
  if (r.status !== 0 || !out) return null;
  try {
    return JSON.parse(out) as T;
  } catch {
    return null;
  }
}

function isInitialized(): boolean {
  return fs.existsSync(path.join(CRYPTOCADET_HOME, 'config.json'));
}

/** The installed CLI's version, or null if it's too old to report one (pre-`version` verb). */
function cadetVersion(bin: string): string | null {
  return runJson<{ version?: string }>(bin, ['--version'])?.version ?? null;
}

/**
 * Install/update the CryptoCadet CLI, into whichever install PATH actually
 * resolves to.
 *
 * `npm i -g` writes to the npm global prefix. When the standalone installer's
 * shim (`~/.cryptocadet-cli`, usually via `~/.local/bin`) comes first on PATH,
 * that global install is invisible: rdk updates one copy, keeps running the
 * other, and reports "still reports an old version after updating" forever —
 * a PATH-shadowing problem that re-running cannot fix. So: update in place.
 */
function npmInstallCadet(spec: string, bin?: string | null): boolean {
  const resolved = bin ? resolvedBinPath(bin) : null;
  const inStandalone = !!resolved && resolved.startsWith(INSTALLER_PREFIX);
  const standaloneApp = path.join(INSTALLER_PREFIX, 'app');

  const args = inStandalone
    ? ['install', '--prefix', standaloneApp, '--omit=dev', '--no-fund', '--no-audit', spec]
    : ['install', '-g', spec];
  if (inStandalone) {
    note(`  Updating the standalone install at ${standaloneApp} (that's what your PATH uses).`);
  }

  const r = runSync('npm', args, { stdio: 'inherit', timeout: 5 * 60 * 1000 });
  if (r.status !== 0) {
    // r.error is set when npm itself couldn't be launched (vs. ran and failed) —
    // surface it so the message isn't misleading about what actually went wrong.
    if (r.error) note(`  (could not launch npm: ${r.error.message})`);
    return false;
  }
  return true;
}

/** Ensure `cryptocadet` is installed AND new enough to pay quotes; offer install/update. */
async function ensureInstalled(): Promise<string | null> {
  let bin = findBin();

  // Not installed → offer a global install (fresh install pulls a current version).
  if (!bin) {
    note('CryptoCadet CLI is not installed — it holds your agent wallet and signs payments.');
    const ok = await confirm({ message: 'Install @cryptocadet/cli now (npm i -g)?', default: true });
    if (!ok) {
      note('Skipped. Install it with: npm i -g @cryptocadet/cli   (or https://cryptocadet.app/install.sh)');
      return null;
    }
    if (!npmInstallCadet('@cryptocadet/cli@latest')) {
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
  }

  // Capability gate: rdk pays via `cryptocadet checkout`, which older builds lack
  // entirely — and pre-0.2.1 builds also send the wrong auth scheme and finalize at
  // the wrong confirmation depth (USDC moves on-chain, the top-up is never credited).
  // Detect and offer to update rather than press on into a broken checkout.
  const ver = cadetVersion(bin);
  if (ver === null || cmpVersion(ver, MIN_CRYPTOCADET) < 0) {
    note(`Your CryptoCadet CLI (${ver ?? 'older than ' + MIN_CRYPTOCADET}) is too old to pay quotes — rdk needs ≥ ${MIN_CRYPTOCADET}.`);
    const where = resolvedBinPath(bin);
    if (where) note(`  Using: ${where}`);
    const ok = await confirm({ message: 'Update @cryptocadet/cli now?', default: true });
    if (!ok) {
      note('Update it with: npm i -g @cryptocadet/cli@latest');
      return null;
    }
    if (!npmInstallCadet('@cryptocadet/cli@latest', bin)) {
      warning('npm update failed. Update manually: npm i -g @cryptocadet/cli@latest');
      return null;
    }
    const after = cadetVersion(bin);
    if (after === null || cmpVersion(after, MIN_CRYPTOCADET) < 0) {
      // Name the file being run. "Open a new terminal and re-run" is useless
      // advice when the cause is one install shadowing another on PATH — the
      // user needs to know WHICH copy is winning to do anything about it.
      const where = resolvedBinPath(bin);
      warning(`CryptoCadet still reports ${after ?? 'an old version'} after updating.`);
      if (where) {
        note(`  Your PATH resolves 'cryptocadet' to: ${where}`);
        note('  A second, older install is shadowing the updated one. Remove it, or put the');
        note('  updated install earlier on PATH, then re-run.');
      }
      return null;
    }
    success(`CryptoCadet CLI updated (${after})`);
  }

  return bin;
}

/** Run `cryptocadet init` interactively if the signer isn't set up yet. */
async function ensureInitialized(bin: string): Promise<boolean> {
  if (isInitialized()) return true;
  note("Let's set up your CryptoCadet agent wallet (one-time). Pick the buyer role.");
  console.log('');
  // Interactive: the user chooses network/role and sees their new wallet address. Its own
  // banner + prompts run on the inherited terminal.
  const r = runSync(bin, ['init'], { stdio: 'inherit' });
  if (r.status !== 0 || !isInitialized()) {
    warning('CryptoCadet setup did not complete. Run `cryptocadet init` then retry.');
    return false;
  }
  return true;
}

function walletShow(bin: string): WalletShow | null {
  return runJson<WalletShow>(bin, ['wallet:show', '--json']);
}

/** The wallet's USDC entry, or null. Deliberately does NOT fall back to
 *  `tokens[0]`: quoting in USDC and then funding/paying with whatever token
 *  happened to be listed first is worse than stopping with a clear message.
 *
 *  Matched by ADDRESS when the offer names one. A wallet whose allowlist holds
 *  both the old and the new USDC contract has two entries with the symbol
 *  "USDC", and matching on symbol alone returned whichever was listed first —
 *  so the balance shown, and checked against, could be the wrong token's. The
 *  server tells us which contract the payment will actually use; believe it. */
export function usdcEntry(w: WalletShow, tokenAddress?: string) {
  if (tokenAddress) {
    const want = tokenAddress.toLowerCase();
    const exact = w.tokens.find((x) => x.token.toLowerCase() === want);
    if (exact) return exact;
    // The offer names a contract this wallet does not hold. Falling back to the
    // symbol here would report a balance for a token the payment cannot use.
    return null;
  }
  return w.tokens.find((x) => x.symbol.toUpperCase() === 'USDC') ?? null;
}

/**
 * Does the agent wallet hold any native currency to pay gas with?
 *
 * `wallet:show` reports ERC-20 balances only, so a wallet can look perfectly
 * funded while being unable to broadcast anything — USDC is the payment, native
 * ETH is the postage. That failure otherwise surfaces only as
 * `broadcast failed: insufficient funds for gas` after the user believes funding
 * is done.
 *
 * Advisory: any problem reading the chain returns true, because a diagnostic
 * must never be the thing that blocks a payment.
 */
async function hasGas(bin: string, w: WalletShow): Promise<boolean> {
  let rpcUrl: string | undefined;
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(CRYPTOCADET_HOME, 'config.json'), 'utf8'),
    ) as { rpcUrl?: string };
    rpcUrl = cfg.rpcUrl;
  } catch { /* no readable config — skip the check */ }
  if (!rpcUrl) return true;

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [w.agentAddress, 'latest'],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return true;
    const { result } = (await res.json()) as { result?: string };
    if (!result) return true;
    if (BigInt(result) > 0n) return true;
  } catch {
    return true;
  }

  console.log('');
  warning('Your agent wallet has USDC but no native balance for gas — the payment would fail.');
  note(`  Send a small amount of the chain's native currency to ${w.agentAddress} (chain ${w.chainId}).`);
  note('  USDC pays the merchant; native currency pays the transaction fee.');
  return false;
}

/** Poll the agent wallet until its USDC covers `amountBaseUnits`. Funding is a human action
 *  (send USDC from the main wallet to the agent address) — never auto-drained. `field` is
 *  'spendable' for per-call top-ups (respects the reserve) or 'balance' for subscription
 *  funding (the collector pulls against raw balance, not spendable). */
async function ensureFunded(
  bin: string,
  amountBaseUnits: string,
  field: 'spendable' | 'balance' = 'spendable',
  tokenAddress?: string,
): Promise<boolean> {
  const need = BigInt(amountBaseUnits);
  for (;;) {
    const w = walletShow(bin);
    if (!w) {
      warning('Could not read the agent wallet balance (`cryptocadet wallet:show`).');
      return false;
    }
    const usdc = usdcEntry(w, tokenAddress);
    if (!usdc) {
      if (tokenAddress) {
        warning(`Your agent wallet does not hold the USDC contract this payment uses on chain ${w.chainId}.`);
        note(`  Expected token: ${tokenAddress}`);
        note('  Add it to the policy allowlist, or re-run `cryptocadet init` for the right network.');
      } else {
        warning(`Your agent wallet has no USDC token configured on chain ${w.chainId}.`);
        note('  Add it to the policy allowlist, or re-run `cryptocadet init` for the right network.');
      }
      return false;
    }
    const have = BigInt((field === 'balance' ? usdc.balance : usdc.spendable) ?? '0');
    if (have >= need) {
      success(`Agent wallet funded (${fmtUsdc(have)} USDC)`);
      // USDC pays the merchant; native ETH pays the gas to move it. Funding one
      // and not the other is the common mistake, and without this check the
      // shortfall only surfaces as a cryptic broadcast failure after the user
      // thinks they're done.
      if (!(await hasGas(bin, w))) return false;
      return true;
    }

    const shortfall = need - have;
    console.log('');
    note(`Your agent wallet needs ${fmtUsdc(shortfall)} more USDC (chain ${w.chainId}).`);
    note('Send USDC from your main wallet to your agent address:');
    console.log(`  ${t.body(w.agentAddress)}`);
    // topup:request prints the exact per-token shortfall + agent address (no auto-drain).
    runSync(bin, ['topup:request', `${usdc.token.toLowerCase()}=${amountBaseUnits}`], { stdio: 'inherit' });
    console.log('');
    const again = await confirm({ message: 'Sent it? Check the balance again', default: true });
    if (!again) {
      note('Fund the wallet later, then run `rdk init` again to finish your top-up.');
      return false;
    }
  }
}

/** Does a REFUSED decision look like a per-transaction / daily cap, as opposed
 *  to something we must not paper over (unknown token, wrong chain, bad quote)? */
function isCapRefusal(reason?: string): boolean {
  return /per[- ]?tx|pertx|daily|cap|limit|exceed/i.test(reason ?? '');
}

/** Pay the merchant quote via `cryptocadet checkout`. Allowlists the payout recipient first
 *  (the buyer policy ships with none), re-runs with --approve on an ESCALATE decision, and
 *  offers to raise a per-payment cap that would otherwise refuse the payment outright. */
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

    // A per-transaction cap refuses outright rather than escalating, and the
    // remedy (raise the cap) is not something a user can guess from the raw
    // reason string. Offer it — but only ever with explicit consent, because
    // this is a spending limit on their wallet.
    if (res?.status === 'REFUSED' && isCapRefusal(res.reason)) {
      const amountUsdc = fmtUsdc(BigInt(topup.amount));
      console.log('');
      note(`Your wallet's per-payment limit is lower than this payment (${amountUsdc} USDC).`);
      note(`  Reason from CryptoCadet: ${res.reason ?? 'per-transaction cap exceeded'}`);
      const raise = await confirm({
        message: `Raise the per-payment limit to ${amountUsdc} USDC and retry?`,
        default: false,
      });
      if (!raise) {
        return {
          status: 'skipped',
          detail: `per-payment limit too low for ${amountUsdc} USDC — raise it with: ` +
            `cryptocadet policy:set --kind perTx --token ${topup.token} --usdc ${amountUsdc}`,
        };
      }
      const set = runSync(bin, [
        'policy:set', '--kind', 'perTx', '--token', topup.token, '--usdc', amountUsdc,
      ], { stdio: 'inherit' });
      if (set.status !== 0) {
        return { status: 'failed', detail: 'could not raise the per-payment limit' };
      }
      success(`Per-payment limit raised to ${amountUsdc} USDC`);
      res = runJson<{ status: CheckoutStatus; reason?: string }>(bin, [
        'checkout', '--quote-file', file, '--allowlist-recipient', '--approve', '--json',
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

  // The funding check above ran before the quote existed, so it matched USDC by
  // symbol. Now the quote names the exact contract — re-check against it, since
  // a wallet holding both the old and the new USDC would otherwise have been
  // measured against the wrong one and fail at broadcast instead of here.
  if (!(await ensureFunded(bin, topup.amount, 'spendable', topup.token))) {
    return { status: 'skipped', detail: 'wallet not funded for the quoted token' };
  }

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
  if (!(await ensureFunded(bin, offer.amountPerPeriod, 'balance', offer.token))) {
    return { status: 'skipped', detail: 'wallet not funded for the first period' };
  }

  const w = walletShow(bin);
  if (!w?.agentAddress) return { status: 'failed', detail: 'could not read agent wallet address' };

  note(`Approving ${fmtUsdc(BigInt(offer.cap))} USDC of pull authority to the collector...`);
  const grantArgs = [
    'subs:grant', '--token', offer.token, '--collector', offer.collector, '--cap', offer.cap, '--json',
  ];
  let grant = runJson<{ txHash?: string; status?: CheckoutStatus; reason?: string }>(bin, grantArgs);

  // The approval goes through the same policy engine as a payment, so it can be
  // escalated or refused for exactly the reasons a checkout can — and until now
  // this call had no handling for either, so it just reported "approval
  // transaction failed" with the real cause buried in stderr.
  if (grant?.status === 'ESCALATE') {
    note(`This approval is above your auto-approve limit: ${grant.reason ?? ''}`);
    const ok = await confirm({
      message: `Approve granting ${fmtUsdc(BigInt(offer.cap))} USDC of pull authority now?`,
      default: true,
    });
    if (!ok) return { status: 'skipped', detail: 'approval not authorized' };
    grant = runJson<{ txHash?: string; status?: CheckoutStatus; reason?: string }>(bin, [...grantArgs, '--approve']);
  }

  if (grant?.status === 'REFUSED') {
    return {
      status: 'failed',
      detail: isCapRefusal(grant.reason)
        ? `your wallet's limit is below the ${fmtUsdc(BigInt(offer.cap))} USDC approval this plan needs — ` +
          `raise it with: cryptocadet policy:set --kind perTx --token ${offer.token} --usdc ${fmtUsdc(BigInt(offer.cap))}`
        : (grant.reason ?? 'approval refused by your wallet policy'),
    };
  }

  if (!grant?.txHash) return { status: 'failed', detail: 'approval transaction failed (see errors above)' };

  success(`Approval granted (tx ${grant.txHash})`);
  return { status: 'granted', buyerWallet: w.agentAddress };
}

function fmtUsdc(base: bigint): string {
  const whole = base / 1_000_000n;
  const frac = (base % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
