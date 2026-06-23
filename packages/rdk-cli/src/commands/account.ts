// packages/rdk-cli/src/commands/account.ts
import { loadConfig, updateConfig } from '../config.js';
import { retrodeckFetch, RetrodeckAuthError } from '../retrodeck-api.js';
import { LocalStore } from '@rdk/core';
import { t, mark, divider } from '../theme.js';

export async function showAccount(): Promise<void> {
  const config = loadConfig();
  const store = new LocalStore();
  const stats = store.getStats();
  store.close();

  console.log(t.heading('\nRDK Account'));
  console.log(divider(40));
  console.log(`Node ID:      ${t.body(config.nodeId)}`);
  console.log(`Plan:         ${t.green(config.plan ?? 'free')}`);
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

export async function upgradeAccount(): Promise<void> {
  const ora   = (await import('ora')).default;
  const open  = (await import('open')).default;
  const config = loadConfig();

  const retrodeckApiUrl = config.retrodeckApiUrl ?? 'https://api.retrodeck.ai';
  if (config.retrodeckAccessToken) {
    const spinner = ora('Opening billing portal...').start();
    try {
      await open(`${retrodeckApiUrl.replace('api.', '')}/dashboard/billing`);
      spinner.succeed('Opened RetroDeck billing in browser');
    } catch (e) {
      spinner.fail((e as Error).message);
      console.log(t.dim('Manual: https://retrodeck.ai/dashboard/billing'));
    }
    return;
  }

  const spinner = ora('Opening billing portal...').start();
  try {
    const res = await fetch(`${config.centralApiUrl}/api/v1/billing/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: 'starter', interval: 'monthly' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { checkoutUrl } = await res.json() as { checkoutUrl: string };
    spinner.succeed('Opening browser...');
    await open(checkoutUrl);
  } catch (e) {
    spinner.fail((e as Error).message);
    console.log(t.dim('Manual: https://retrodeck.ai/dashboard/billing'));
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
