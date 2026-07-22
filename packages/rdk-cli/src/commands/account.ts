// packages/rdk-cli/src/commands/account.ts
import { loadConfig, updateConfig } from '../config.js';
import { retrodeckFetch, RetrodeckAuthError } from '../retrodeck-api.js';
import { LocalStore } from '@rdk/core';
import { t, mark, divider } from '../theme.js';
import { grantCryptocadetSubscription, type CryptoCadetPlanOffer } from './cryptocadet.js';

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
      const res = await retrodeckFetch('/api/v1/balances/me');
      if (res.ok) {
        const data = await res.json() as { balanceUsdc: number; creditLimitUsd: number };
        console.log(`Balance:      ${t.green(`$${Number(data.balanceUsdc).toFixed(4)} USDC`)}`);
        if (data.creditLimitUsd > 0) {
          console.log(`Credit limit: ${t.body(`$${Number(data.creditLimitUsd).toFixed(2)}`)}`);
        }
      } else {
        console.log(`Balance:      ${t.dim(`unavailable (HTTP ${res.status})`)}`);
      }
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

function planChoice(p: ApiPlan, current: string) {
  const price = p.price_monthly === 0 ? 'Free' : `$${p.price_monthly}/mo`;
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

  // Live plans — the same source the dashboard pricing reads (never hardcoded).
  const spinner = ora('Fetching plans...').start();
  let plans: ApiPlan[];
  try {
    const res = await retrodeckFetch('/api/v1/plans');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    plans = await res.json() as ApiPlan[];
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

  // Downgrade to Free — immediate, no payment.
  if (selected.price_monthly === 0) {
    const s = ora('Switching to Free...').start();
    try {
      const res = await retrodeckFetch('/api/v1/plans/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: 'free' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      updateConfig({ plan: 'free' });
      s.succeed('Switched to Free.');
    } catch (e) { s.fail((e as Error).message); }
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
    const res = await retrodeckFetch('/api/v1/plans/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId, interval, source: 'cli' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { checkoutUrl } = await res.json() as { checkoutUrl: string | null };
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
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
    let activated = false;
    for (let i = 0; i < 12 && !activated; i++) {
      try {
        const vr = await retrodeckFetch('/api/v1/plans/verify-payment');
        if (vr.ok) {
          const v = await vr.json() as { paid?: boolean; plan?: { id?: string; name?: string } };
          if (v.paid) {
            activated = true;
            updateConfig({ plan: v.plan?.id ?? planId });
            verify.succeed(`${v.plan?.name ?? selected.name} plan activated`);
            break;
          }
        }
      } catch { /* keep polling */ }
      await sleep(2500);
    }
    if (!activated) {
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
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  const s = ora('Preparing crypto subscription...').start();
  try {
    const selRes = await retrodeckFetch('/api/v1/plans/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId, interval, method: 'cryptocadet', source: 'cli' }),
    });
    if (!selRes.ok) throw new Error(`HTTP ${selRes.status}`);
    const selData = await selRes.json() as { cryptocadet?: CryptoCadetPlanOffer };
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

    const actRes = await retrodeckFetch('/api/v1/plans/activate-crypto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId, buyerWallet: outcome.buyerWallet }),
    });
    if (!actRes.ok) throw new Error(`activate HTTP ${actRes.status}`);

    const verify = ora('Waiting for the first charge to settle...').start();
    let activated = false;
    for (let i = 0; i < 30 && !activated; i++) {
      try {
        const vr = await retrodeckFetch('/api/v1/plans/verify-payment');
        if (vr.ok) {
          const v = await vr.json() as { paid?: boolean; plan?: { id?: string; name?: string } };
          if (v.paid) {
            activated = true;
            updateConfig({ plan: v.plan?.id ?? planId });
            verify.succeed(`${v.plan?.name ?? planName} plan activated`);
            break;
          }
        }
      } catch { /* keep polling */ }
      await sleep(3000);
    }
    if (!activated) {
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

export async function withdrawEarnings(): Promise<void> {
  const config = loadConfig();
  if (!config.walletAddress) {
    console.log(t.error('No wallet configured. Run: rdk account and add a wallet address.'));
    return;
  }
  console.log(t.warn('Withdrawal triggers settlement of pending on-chain tips to your wallet.'));
  console.log(t.dim('This is handled by the rdk-x402 background process.'));
  console.log(`Wallet: ${t.body(`${config.walletAddress} (${config.walletChain})`)}`);
}
