// packages/rdk-cli/src/commands/account.ts
import { loadConfig, updateConfig } from '../config.js';
import { retrodeckFetch, RetrodeckAuthError } from '../retrodeck-api.js';
import {
  CRYPTO_POLL,
  activateCryptoPlan,
  fetchPlans,
  pollPlanActivation,
  selectPlan,
  fetchBalance,
  fetchWithdrawable,
  fetchWithdrawalStatus,
  fetchWithdrawals,
  requestWithdrawal,
  sessionFromConfig,
} from '../payments.js';
import { LocalStore } from '@rdk/core';
import { t, mark, divider } from '../theme.js';
import { grantCryptocadetSubscription, type CryptoCadetPlanOffer } from './cryptocadet.js';
import { printBalanceWarning } from './balance.js';
import { computeWithdrawalBreakdown } from '@retrodeck/payments-contract';

export async function showAccount(): Promise<void> {
  const config = loadConfig();

  // Refresh the plan from the authoritative source (/users/me) so it's never
  // stale or undefined; fall back to the cached value if offline.
  let planName = config.plan ?? 'free';
  if (config.retrodeckApiUrl && config.retrodeckAccessToken) {
    try {
      const meRes = await retrodeckFetch('/api/v1/users/me');
      if (meRes.ok) {
        const me = await meRes.json() as { user?: { planId?: string } };
        if (me.user?.planId) {
          planName = me.user.planId;
          if (planName !== config.plan) updateConfig({ plan: planName });
        }
      }
    } catch { /* best-effort — keep the cached plan */ }
  }

  const store = new LocalStore();
  const stats = store.getStats();
  store.close();

  console.log(t.heading('\nRDK Account'));
  console.log(divider(40));
  console.log(`Node ID:      ${t.body(config.nodeId)}`);
  console.log(`Plan:         ${t.green(planName)}`);
  console.log(`Domain:       ${t.body(config.domain)}`);
  console.log(`RDK Central:  ${t.body(config.centralApiUrl)}`);
  if (config.retrodeckUserId) {
    console.log(`RetroDeck:   ${t.body(config.retrodeckApiUrl ?? 'https://api.retrodeck.ai')}`);
    console.log(`Email:        ${config.emailVerified ? mark.ok() + ' verified' : mark.warn() + ' ' + t.warn('unverified')}`);
  }
  console.log('');
  console.log(`Vault:        ${t.body(`${config.vaultAdapter} @ ${config.vaultPath}`)}`);
  console.log(`Chunks:       ${t.body(`${stats.totalChunks.toLocaleString()} indexed (${stats.syncedChunks.toLocaleString()} synced, ${stats.pendingChunks.toLocaleString()} pending sync)`)}`);
  console.log(`              ${t.dim(`${stats.privateChunks.toLocaleString()} private, ${stats.publicChunks.toLocaleString()} public${stats.localChunks > 0 ? `, ${stats.localChunks.toLocaleString()} local-only` : ''}`)}`);
  if (config.walletAddress) {
    console.log(`Wallet:       ${t.body(`${config.walletAddress} (${config.walletChain})`)}`);
  }

  if (config.retrodeckApiUrl && config.retrodeckAccessToken) {
    try {
      const balance = await fetchBalance(sessionFromConfig(config.retrodeckApiUrl));
      // Colour by the SERVER's assessment, not unconditionally green — an always-
      // green balance is why "insufficient balance" arrived as a surprise.
      const level = balance.status?.level ?? 'ok';
      const paint = level === 'ok' ? t.green : level === 'low' ? t.warn : t.error;
      console.log(`Balance:      ${paint(`$${balance.balanceUsdc.toFixed(4)} USDC`)}`);
      if (balance.creditLimitUsd > 0) {
        console.log(`Credit limit: ${t.body(`$${balance.creditLimitUsd.toFixed(2)}`)}`);
      }
      console.log('');
      printBalanceWarning(balance.status);
    } catch (e) {
      if (e instanceof RetrodeckAuthError) {
        console.log(`Balance:      ${t.warn('session expired — run: rdk account:login')}`);
      } else {
        console.log(`Balance:      ${t.dim('unavailable (could not reach RetroDeck)')}`);
      }
    }
  }
}

export async function accountLogin(): Promise<void> {
  const ora = (await import('ora')).default;
  const config = loadConfig();
  const retrodeckApiUrl =
    config.retrodeckApiUrl ??
    process.env.RETRODECK_API_URL ??
    'https://api.retrodeck.ai';

  const { input, password } = await import('../prompts.js');

  const email = await input({
    message: 'Email:',
    validate: v => (v.includes('@') && v.includes('.')) || 'Enter a valid email',
  });
  const pw = await password({ message: 'Password:' });

  const spinner = ora('Logging in...').start();
  try {
    const res = await fetch(`${retrodeckApiUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pw }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Invalid credentials');
    }
    if (res.status >= 500) {
      throw new Error(`RetroDeck is temporarily unavailable (HTTP ${res.status}). Try again shortly.`);
    }
    if (!res.ok) {
      throw new Error(`Login failed (HTTP ${res.status})`);
    }
    const data = await res.json() as { accessToken: string; refreshToken: string };

    let userId = config.retrodeckUserId ?? '';
    // /users/me is the authoritative source of the account's plan (the node
    // auth endpoint doesn't carry it). Capture it here so status/network:join
    // show the real plan instead of falling back to 'free'.
    let plan = config.plan;
    try {
      const meRes = await fetch(`${retrodeckApiUrl}/api/v1/users/me`, {
        headers: { Authorization: `Bearer ${data.accessToken}` },
      });
      if (meRes.ok) {
        const me = await meRes.json() as { user: { id: string; emailVerified: boolean; planId?: string } };
        userId = me.user.id;
        plan = me.user.planId ?? plan ?? 'free';
        updateConfig({ emailVerified: me.user.emailVerified });
      }
    } catch {}

    updateConfig({
      retrodeckAccessToken: data.accessToken,
      retrodeckRefreshToken: data.refreshToken,
      retrodeckUserId: userId,
      retrodeckApiUrl,
      plan,
    });
    spinner.succeed(`Logged in to RetroDeck`);

    // Ensure this node is linked to the account so the dashboard can resolve
    // and display its chunks. Uses the freshly minted token; idempotent.
    const { ensureNodeLinked } = await import('../link-node.js');
    const link = await ensureNodeLinked({ accessToken: data.accessToken });
    if (link.status === 'linked') {
      console.log(t.dim('  ✓ Node linked — your chunks will appear in the dashboard'));
    } else if (link.status === 'failed') {
      console.log(t.warn(`  Could not link node to account (${link.reason}). Retry: rdk account:relink`));
    }
  } catch (e) {
    spinner.fail((e as Error).message);
  }
}

// Idempotently (re)links this node to the user's RetroDeck account. Fixes the
// case where the original `rdk init` link was swallowed or never ran, leaving
// chunks synced to Central but invisible in the dashboard.
export async function accountRelink(): Promise<void> {
  const ora = (await import('ora')).default;
  const spinner = ora('Linking node to your RetroDeck account...').start();
  const { ensureNodeLinked } = await import('../link-node.js');
  const link = await ensureNodeLinked();
  switch (link.status) {
    case 'linked':
      spinner.succeed('Node linked — your chunks will now appear in the dashboard');
      break;
    case 'already-linked':
      spinner.succeed('Node already linked to your account');
      break;
    case 'skipped':
      spinner.warn(link.reason ?? 'Nothing to link');
      break;
    case 'failed':
      spinner.fail(`Link failed: ${link.reason}`);
      break;
  }
}

interface ApiPlan {
  id: string;
  name: string;
  price_monthly: number;
  max_queries_day: number;
  max_chunks: number;
}

/** A plan that costs nothing. Tolerates the price arriving as a string — older
 *  servers send Postgres decimals unconverted — and falls back to the plan id,
 *  which is what the server actually branches on. */
export function isFreePlan(p: { id: string; price_monthly?: number | string | null }): boolean {
  return p.id === 'free' || Number(p.price_monthly ?? 0) === 0;
}

function planChoice(p: ApiPlan, current: string) {
  const price = isFreePlan(p) ? 'Free' : `$${Number(p.price_monthly).toFixed(2)}/mo`;
  const q = p.max_queries_day >= 1000 ? `${(p.max_queries_day / 1000).toFixed(0)}K` : String(p.max_queries_day);
  const c = p.max_chunks >= 1_000_000 ? `${(p.max_chunks / 1_000_000).toFixed(0)}M` : `${(p.max_chunks / 1000).toFixed(0)}K`;
  return {
    name: `${p.name.padEnd(12)} ${price}${p.id === current ? '  (current)' : ''}`,
    value: p.id,
    hint: `${q} queries/day, ${c} chunks`,
  };
}

// Interactive plan change. Selection happens in the CLI; PAYMENT is handed off
// to a browser checkout (we never collect card details). Free is immediate.
export async function upgradeAccount(): Promise<void> {
  const ora = (await import('ora')).default;
  const config = loadConfig();

  if (!config.retrodeckAccessToken) {
    console.log(t.warn('Log in first: rdk account:login'));
    return;
  }

  const { select, pressEnter } = await import('../prompts.js');

  const session = sessionFromConfig(config.retrodeckApiUrl);

  // Live plans — the same source the dashboard pricing reads (never hardcoded).
  const spinner = ora('Fetching plans...').start();
  let plans: ApiPlan[];
  try {
    plans = await fetchPlans(session);
    spinner.stop();
  } catch (e) {
    spinner.fail(e instanceof RetrodeckAuthError
      ? 'Session expired — run: rdk account:login'
      : `Could not fetch plans: ${(e as Error).message}`);
    return;
  }
  if (!plans.length) { console.log(t.warn('No plans available.')); return; }

  const current = config.plan ?? 'free';
  console.log('');
  console.log(`  ${t.dim('Current plan:')} ${t.green(current)}`);

  const planId = await select({
    message: 'Change to:',
    choices: plans.map(p => planChoice(p, current)),
    default: current,
  });

  if (planId === current) { console.log(t.dim('  No change.')); return; }
  const selected = plans.find(p => p.id === planId)!;

  // Downgrade to Free — applied immediately, and it CANCELS the active
  // subscription server-side. Confirm first: it is an irreversible billing
  // change, not a navigation.
  //
  // Keyed on the plan id, not the price. This guard used to read
  // `selected.price_monthly === 0`, and the API sends that column as the string
  // "0.00" (Postgres decimal), so it never matched: choosing Free fell through
  // to the interval and payment prompts and then reported "No checkout URL
  // returned" for a downgrade the server had already applied. The id is the
  // thing the server itself branches on, and it cannot be a number in disguise.
  if (isFreePlan(selected)) {
    const { confirm } = await import('../prompts.js');
    const ok = await confirm({
      message: 'Switching to Free cancels your current subscription. Continue?',
      default: false,
    });
    if (!ok) { console.log(t.dim('  No change.')); return; }

    const s = ora('Switching to Free...').start();
    try {
      await selectPlan(session, { planId: 'free' });
      updateConfig({ plan: 'free' });
      s.succeed('Switched to Free — your subscription has been cancelled.');
    } catch (e) {
      // The server refuses to downgrade if the cancellation failed, so the user
      // is still on their paid plan and still being billed. Say so.
      s.fail(`${(e as Error).message} — you are still on ${current}.`);
    }
    return;
  }

  // Paid — choose billing interval, then a payment method.
  const interval = await select<'monthly' | 'yearly'>({
    message: 'Billing interval:',
    choices: [
      { name: 'Monthly', value: 'monthly' },
      { name: 'Yearly',  value: 'yearly', hint: 'save ~17%' },
    ],
    default: 'monthly',
  });

  // Payment method. This mirrors the onboarding flow (init.ts) — crypto was missing here,
  // so upgrades silently defaulted to Stripe. Card hands off to a browser checkout; crypto
  // sets up a recurring USDC pull via CryptoCadet, entirely in the CLI.
  const method = await select<'stripe' | 'cryptocadet'>({
    message: `Pay for ${selected.name} (${interval}) via:`,
    choices: [
      { name: 'Credit card', value: 'stripe',      hint: 'Stripe' },
      { name: 'Crypto',      value: 'cryptocadet', hint: 'CryptoCadet — recurring USDC on Base' },
    ],
    default: 'stripe',
  });

  if (method === 'cryptocadet') {
    await upgradeWithCrypto(planId, interval, selected.name);
    return;
  }

  const s = ora('Creating checkout...').start();
  try {
    const { checkoutUrl } = await selectPlan(session, { planId, interval, method: 'stripe' });
    s.stop();
    if (!checkoutUrl) { console.log(t.warn('No checkout URL returned.')); return; }

    const { openUrl } = await import('../open-url.js');
    console.log('');
    console.log(`  Complete your ${selected.name} subscription (card):`);
    console.log(`  ${t.body(checkoutUrl)}`);
    openUrl(checkoutUrl);
    console.log('');

    await pressEnter('Complete the payment in your browser, then press Enter:');
    const verify = ora('Confirming your upgrade...').start();
    const result = await pollPlanActivation(session);

    if (result.paid) {
      updateConfig({ plan: result.planId ?? planId });
      verify.succeed(`${result.planName ?? selected.name} plan activated`);
    } else {
      verify.warn('Upgrade not confirmed yet — it can take a moment to settle.');
      console.log(t.dim('  Run `rdk account` once it completes to see your new plan.'));
    }
  } catch (e) {
    s.fail((e as Error).message);
  }
}

// Crypto upgrade path — the recurring-USDC counterpart to the Stripe browser checkout.
// Mirrors the onboarding flow in init.ts: POST plans/select with method 'cryptocadet' to get
// the on-chain offer, grant the capped pull approval via the CryptoCadet CLI, register it with
// POST plans/activate-crypto, then poll until the first charge settles.
async function upgradeWithCrypto(planId: string, interval: 'monthly' | 'yearly', planName: string): Promise<void> {
  const ora = (await import('ora')).default;
  const session = sessionFromConfig(loadConfig().retrodeckApiUrl);
  const s = ora('Preparing crypto subscription...').start();
  try {
    const selData = await selectPlan(session, { planId, interval, method: 'cryptocadet' });
    s.stop();
    if (!selData.cryptocadet) {
      console.log(t.warn('  Server did not return a crypto offer — no change to your plan.'));
      return;
    }

    // Fund + grant the on-chain approval via the CryptoCadet CLI.
    const outcome = await grantCryptocadetSubscription(selData.cryptocadet);
    if (outcome.status !== 'granted') {
      console.log(t.warn(`  Crypto subscription ${outcome.status}: ${outcome.detail}.`));
      console.log(t.dim('  No change to your plan.'));
      return;
    }

    // The wallet that granted the allowance IS the one the collector pulls from —
    // it must come from the binary's own output, never be assumed.
    await activateCryptoPlan(session, { planId, buyerWallet: outcome.buyerWallet });

    const verify = ora('Waiting for the first charge to settle...').start();
    // Longer cadence than the card path: activation waits on a block confirmation
    // AND a collector tick, not just a browser redirect.
    const result = await pollPlanActivation(session, { ...CRYPTO_POLL });

    if (result.paid) {
      updateConfig({ plan: result.planId ?? planId });
      verify.succeed(`${result.planName ?? planName} plan activated`);
    } else {
      verify.stop();
      console.log(t.dim('  Subscription registered — the first charge is settling on-chain.'));
      console.log(t.dim('  Your plan activates once it confirms. Run `rdk account` later to check.'));
    }
  } catch (e) {
    s.fail(`Crypto subscription failed: ${(e as Error).message}`);
  }
}

export async function rotateApiKey(): Promise<void> {
  const ora = (await import('ora')).default;
  const config = loadConfig();
  const spinner = ora('Rotating API key...').start();

  try {
    const res = await fetch(`${config.centralApiUrl}/api/v1/nodes/me/apikey/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { apiKey } = await res.json() as { apiKey: string };
    updateConfig({ apiKey });
    spinner.succeed('API key rotated and saved.');
    console.log(t.warn(`New key: ${apiKey}  ← save this`));
  } catch (e) {
    spinner.fail((e as Error).message);
  }
}

export async function showEarnings(): Promise<void> {
  const config = loadConfig();
  const store = new LocalStore();
  const pendingTips = store.getPendingTipTotal();
  const pendingTipList = store.getPendingTips();
  store.close();

  console.log(t.heading('\nEarnings'));
  console.log(divider(40));
  console.log(`Pending tips (local queue):  ${t.body(`$${pendingTips.toFixed(4)} USDC (${pendingTipList.length} tips)`)}`);

  try {
    const res = await fetch(`${config.centralApiUrl}/api/v1/tips/earnings`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (res.ok) {
      const data = await res.json() as { totalUsdc: number; pendingUsdc: number; settledUsdc: number };
      console.log('');
      console.log(t.body('Network earnings:'));
      console.log(`  Total:    ${t.green(`$${Number(data.totalUsdc).toFixed(4)} USDC`)}`);
      console.log(`  Settled:  ${t.body(`$${Number(data.settledUsdc).toFixed(4)} USDC`)}`);
      console.log(`  Pending:  ${t.body(`$${Number(data.pendingUsdc).toFixed(4)} USDC`)}`);
    }
  } catch {}
}

/**
 * Withdraw your balance to your wallet.
 *
 * This used to print three reassuring lines and return, citing a background
 * settlement process that does not run — so a user would see a "success" and
 * watch for funds that were never sent. It now performs the actual withdrawal,
 * and every message it prints reflects something the server confirmed.
 */
export async function withdrawEarnings(opts: { amount?: number } = {}): Promise<void> {
  const ora = (await import('ora')).default;
  const config = loadConfig();

  if (!config.retrodeckAccessToken) {
    console.log(t.warn('Log in first: rdk account:login'));
    return;
  }
  if (!config.walletAddress) {
    console.log(t.error('No wallet configured. Run: rdk account and add a wallet address.'));
    return;
  }

  const session = sessionFromConfig(config.retrodeckApiUrl);
  const spinner = ora('Checking withdrawal availability...').start();

  try {
    const [status, balance, withdrawable] = await Promise.all([
      fetchWithdrawalStatus(session),
      fetchBalance(session),
      // Carries the fee rate. Read from the server rather than assumed — a
      // hardcoded rate here would quote a payout the server does not send.
      fetchWithdrawable(session).catch(() => null),
    ]);

    // Say so BEFORE taking the money. Requesting a withdrawal debits the balance
    // immediately, so offering it when the server can't settle would strand funds.
    if (!status.enabled) {
      spinner.fail(status.reason ?? 'Withdrawals are unavailable on this server right now.');
      console.log(t.dim('  Your balance is unchanged.'));
      return;
    }
    if (balance.withdrawable <= 0) {
      spinner.stop();
      console.log(t.warn('Nothing withdrawable.'));
      console.log(t.dim(
        `  Balance $${balance.balanceUsdc.toFixed(4)}, of which $${balance.creditLimitUsd.toFixed(2)} ` +
        'is reserved against your credit limit.',
      ));
      return;
    }

    const amount = opts.amount ?? balance.withdrawable;
    if (amount > balance.withdrawable) {
      spinner.fail(`Only $${balance.withdrawable.toFixed(4)} USDC is withdrawable.`);
      return;
    }
    spinner.stop();

    // Show the fee split BEFORE asking. A withdrawal debits immediately and
    // settles asynchronously, so the net must never be a surprise afterwards.
    const breakdown =
      withdrawable?.taxRate != null
        ? computeWithdrawalBreakdown(amount, withdrawable.taxRate)
        : null;

    if (breakdown) {
      console.log('');
      console.log(`  ${t.dim('withdrawing:')}  $${breakdown.gross.toFixed(4)} USDC`);
      console.log(`  ${t.dim(`fee (${(breakdown.taxRate * 100).toFixed(0)}%):`)}     ${t.warn(`-$${breakdown.tax.toFixed(4)}`)}`);
      console.log(`  ${t.dim('you receive:')}  ${t.green(`$${breakdown.net.toFixed(4)} USDC`)}`);
      console.log('');
    }

    const { confirm } = await import('../prompts.js');
    const ok = await confirm({
      message: breakdown
        ? `Send $${breakdown.net.toFixed(4)} USDC to ${config.walletAddress} on ${status.network ?? status.chain}?`
        : `Withdraw $${amount.toFixed(4)} USDC to ${config.walletAddress} on ${status.network ?? status.chain}?`,
      default: false,
    });
    if (!ok) { console.log(t.dim('  Cancelled.')); return; }

    const sending = ora('Requesting withdrawal...').start();
    const result = await requestWithdrawal(session, {
      amountUsdc: amount,
      walletAddress: config.walletAddress,
      walletChain: status.chain,
    });
    // Report the server's figures, not the requested ones.
    const net = result.netUsdc ?? breakdown?.net ?? amount;
    sending.succeed(`Withdrawal requested — $${net.toFixed(4)} USDC to ${config.walletAddress}`);
    if (result.taxUsdc != null) {
      console.log(t.dim(`  $${Number(result.grossUsdc ?? amount).toFixed(4)} debited, $${Number(result.taxUsdc).toFixed(4)} fee withheld.`));
    }
    // Deliberately not "sent": settlement is asynchronous, and claiming
    // otherwise is the exact thing that made this command lie before.
    console.log(t.dim(`  ${result.withdrawalId} · ${result.status} on ${result.chain}`));
    console.log(t.dim('  Track it with: rdk earnings:withdrawals'));
  } catch (e) {
    spinner.fail((e as Error).message);
    process.exitCode = 1;
  }
}

/** Withdrawal history, so a user can see what actually settled. */
export async function listWithdrawals(): Promise<void> {
  const config = loadConfig();
  if (!config.retrodeckAccessToken) {
    console.log(t.warn('Log in first: rdk account:login'));
    return;
  }
  try {
    const rows = await fetchWithdrawals(sessionFromConfig(config.retrodeckApiUrl));
    if (!rows.length) { console.log(t.dim('No withdrawals yet.')); return; }

    console.log('');
    console.log(t.body('Withdrawals:'));
    for (const w of rows) {
      const when = w.requestedAt ? new Date(w.requestedAt).toLocaleString() : '';
      const state = w.status === 'completed' ? t.green(w.status)
        : w.status === 'failed' ? t.error(w.status)
        : t.warn(w.status);
      console.log(`  $${w.amountUsdc.toFixed(4)} USDC  ${state}  ${t.dim(when)}`);
      console.log(t.dim(`    → ${w.walletAddress} (${w.walletChain})`));
      if (w.txHash) console.log(t.dim(`    tx ${w.txHash}`));
      if (w.status === 'failed') console.log(t.dim('    balance was re-credited'));
    }
  } catch (e) {
    console.log(t.error((e as Error).message));
    process.exitCode = 1;
  }
}
