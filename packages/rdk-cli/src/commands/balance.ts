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
    console.log(t.dim('  Top up:    rdk account:upgrade'));
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
