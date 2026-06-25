// packages/rdk-cli/src/commands/balance.ts
// Dedicated `rdk balance` — quick USDC balance check without the full account view.
import { loadConfig } from '../config.js';
import { retrodeckFetch, RetrodeckAuthError } from '../retrodeck-api.js';
import { t } from '../theme.js';

export async function showBalance(): Promise<void> {
  const config = loadConfig();
  if (!config.retrodeckApiUrl || !config.retrodeckAccessToken) {
    console.log(t.warn('Not logged in to RetroDeck. Run: rdk account:login'));
    return;
  }

  try {
    const res = await retrodeckFetch('/api/v1/balances/me');
    if (!res.ok) {
      console.log(t.error(`Could not fetch balance (HTTP ${res.status}).`));
      return;
    }

    const data = await res.json() as { balanceUsdc?: number; creditLimitUsd?: number };
    const balance = Number(data.balanceUsdc ?? 0);
    const creditLimit = Number(data.creditLimitUsd ?? 0);
    const withdrawable = Math.max(0, balance - creditLimit);

    console.log(t.heading('\n  Balance\n'));
    console.log(`  ${t.dim('current:')}       ${t.green(`$${balance.toFixed(4)} USDC`)}`);
    console.log(`  ${t.dim('credit limit:')}  $${creditLimit.toFixed(2)}`);
    console.log(`  ${t.dim('withdrawable:')}  $${withdrawable.toFixed(4)}`);
    console.log('');
    console.log(t.dim('  Top up:    rdk topup [amount]'));
    console.log(t.dim('  Withdraw:  rdk earnings:withdraw'));
    console.log('');
  } catch (e) {
    if (e instanceof RetrodeckAuthError) {
      console.log(t.warn('Your RetroDeck session has expired. Run: rdk account:login'));
    } else {
      console.log(t.error('Could not reach RetroDeck to fetch your balance.'));
    }
  }
}

// `rdk topup [amount]` — add USDC credit via Stripe. Defaults to $10.
export async function topup(amountArg?: string): Promise<void> {
  const ora = (await import('ora')).default;
  const open = (await import('open')).default;
  const config = loadConfig();

  // Accept "10", "$10", "10.50". Default to $10 when omitted.
  const amountUsd = amountArg !== undefined ? Number(String(amountArg).replace(/[$,\s]/g, '')) : 10;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    console.log(t.error('  Invalid amount. Usage: rdk topup [amount]   e.g. rdk topup 25'));
    return;
  }

  // Stripe success returns to the dashboard, not the marketing site.
  const dashboardUrl = (config.retrodeckApiUrl ?? 'https://api.retrodeck.ai').replace('//api.', '//dashboard.');
  const spinner = ora(`Creating checkout to add $${amountUsd.toFixed(2)} USDC...`).start();
  try {
    const res = await retrodeckFetch('/api/v1/balances/topup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountUsd, method: 'stripe', returnUrl: dashboardUrl }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { checkoutUrl } = await res.json() as { checkoutUrl: string | null };
    if (!checkoutUrl) throw new Error('No checkout URL returned');

    spinner.succeed(`Opening checkout to add $${amountUsd.toFixed(2)} USDC`);
    try { await open(checkoutUrl); } catch { /* headless — link printed below */ }
    console.log(t.dim(`  ${checkoutUrl}`));
    console.log(t.dim('  Your balance updates once payment completes.'));
    console.log('');
  } catch (e) {
    if (e instanceof RetrodeckAuthError) {
      spinner.fail('Not logged in to RetroDeck. Run: rdk account:login');
    } else {
      spinner.fail((e as Error).message);
    }
  }
}
