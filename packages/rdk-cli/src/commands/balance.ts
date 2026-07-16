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
    // Self-heal: credit any top-up that completed but wasn't verified yet
    // (crediting happens on verification — there's no async Stripe webhook).
    try { await retrodeckFetch('/api/v1/balances/verify-topup'); } catch { /* best-effort */ }

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

// `rdk topup [amount]` — add USDC credit via card (Stripe) or crypto (CryptoCadet).
// Defaults to $10. Method: --crypto / --stripe, else an interactive prompt (default card).
export async function topup(
  amountArg?: string,
  opts: { method?: 'stripe' | 'cryptocadet' } = {},
): Promise<void> {
  const ora = (await import('ora')).default;
  const { openUrl } = await import('../open-url.js');
  const config = loadConfig();

  // Accept "10", "$10", "10.50". Default to $10 when omitted.
  const amountUsd = amountArg !== undefined ? Number(String(amountArg).replace(/[$,\s]/g, '')) : 10;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    console.log(t.error('  Invalid amount. Usage: rdk topup [amount]   e.g. rdk topup 25'));
    return;
  }

  // Pick a payment method: explicit flag, else prompt (default card); non-TTY → card.
  let method = opts.method;
  if (!method) {
    if (process.stdin.isTTY) {
      const { select } = await import('../prompts.js');
      method = await select<'stripe' | 'cryptocadet'>({
        message: `Add $${amountUsd.toFixed(2)} USDC via:`,
        choices: [
          { name: 'Credit card', value: 'stripe',     hint: 'Stripe' },
          { name: 'Crypto',      value: 'cryptocadet', hint: 'CryptoCadet — USDC on Base' },
        ],
        default: 'stripe',
      });
    } else {
      method = 'stripe';
    }
  }

  if (method === 'cryptocadet') {
    await topupCrypto(amountUsd);
    return;
  }

  // Stripe success returns to the dashboard, not the marketing site.
  const dashboardUrl = (config.retrodeckApiUrl ?? 'https://api.retrodeck.ai').replace('//api.', '//dashboard.');
  const spinner = ora(`Creating checkout to add $${amountUsd.toFixed(2)} USDC...`).start();
  try {
    const res = await retrodeckFetch('/api/v1/balances/topup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountUsd, method: 'stripe', source: 'cli', returnUrl: dashboardUrl }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { checkoutUrl, paymentId } = await res.json() as { checkoutUrl: string | null; paymentId?: string };
    if (!checkoutUrl) throw new Error('No checkout URL returned');

    spinner.succeed(`Opening checkout to add $${amountUsd.toFixed(2)} USDC`);
    openUrl(checkoutUrl);
    console.log(t.dim(`  If your browser didn't open: ${checkoutUrl}`));
    console.log('');

    // Stripe can't redirect back to a terminal, so wait for the user to return
    // after paying, then poll verify-topup — which is what actually credits the
    // balance (there's no async webhook; crediting happens on verification).
    const { pressEnter } = await import('../prompts.js');
    await pressEnter('Complete the payment in your browser, then press Enter:');

    const verify = ora('Confirming your top-up...').start();
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
    let credited = false;
    let newBalance = 0;
    for (let i = 0; i < 12 && !credited; i++) {
      try {
        const verRes = paymentId
          ? await retrodeckFetch('/api/v1/balances/verify-topup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ paymentRef: paymentId }),
            })
          : await retrodeckFetch('/api/v1/balances/verify-topup'); // GET latest
        if (verRes.ok) {
          const ver = await verRes.json() as { completed?: boolean; balance?: number };
          if (ver.completed) { credited = true; newBalance = Number(ver.balance ?? 0); break; }
        }
      } catch { /* keep polling */ }
      await sleep(2500);
    }
    if (credited) {
      verify.succeed(`Added $${amountUsd.toFixed(2)} USDC — balance is now $${newBalance.toFixed(4)}`);
    } else {
      verify.warn('Payment not confirmed yet — it can take a moment to settle.');
      console.log(t.dim('  Run `rdk balance` shortly; it re-checks any pending top-up.'));
    }
    console.log('');
  } catch (e) {
    if (e instanceof RetrodeckAuthError) {
      spinner.fail('Not logged in to RetroDeck. Run: rdk account:login');
    } else {
      spinner.fail((e as Error).message);
    }
  }
}

// Crypto top-up: install/init/fund the CryptoCadet signer, mint a quote from RetroDeck,
// pay it on-chain, then poll verify-topup (which credits the balance).
async function topupCrypto(amountUsd: number): Promise<void> {
  const ora = (await import('ora')).default;
  const { payTopupWithCryptocadet } = await import('./cryptocadet.js');

  const outcome = await payTopupWithCryptocadet({
    amountUsd,
    mintQuote: async () => {
      try {
        const res = await retrodeckFetch('/api/v1/balances/topup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amountUsd, method: 'cryptocadet', source: 'cli' }),
        });
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try { const b = await res.json() as { message?: string }; if (b?.message) msg = b.message; } catch { /* keep status */ }
          console.log(t.warn(`  Server declined the crypto top-up: ${msg}`));
          return null;
        }
        const data = await res.json() as { cryptocadet?: import('./cryptocadet.js').CryptoCadetTopup };
        return data.cryptocadet ?? null;
      } catch {
        return null;
      }
    },
  });

  if (outcome.status !== 'paid') {
    console.log(t.warn(`  Crypto top-up ${outcome.status}: ${outcome.detail}`));
    console.log('');
    return;
  }

  const verify = ora('Confirming your on-chain top-up...').start();
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  let credited = false;
  let newBalance = 0;
  for (let i = 0; i < 20 && !credited; i++) {
    try {
      const verRes = await retrodeckFetch('/api/v1/balances/verify-topup');
      if (verRes.ok) {
        const ver = await verRes.json() as { completed?: boolean; balance?: number };
        if (ver.completed) { credited = true; newBalance = Number(ver.balance ?? 0); break; }
      }
    } catch { /* keep polling */ }
    await sleep(3000);
  }
  if (credited) {
    verify.succeed(`Added $${amountUsd.toFixed(2)} USDC — balance is now $${newBalance.toFixed(4)}`);
  } else {
    verify.warn('Payment broadcast — crediting can take a moment to settle.');
    console.log(t.dim('  Run `rdk balance` shortly; it re-checks any pending top-up.'));
  }
  console.log('');
}
