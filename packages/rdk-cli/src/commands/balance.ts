// packages/rdk-cli/src/commands/balance.ts
// `rdk balance` and `rdk topup` — the CLI's read and credit paths.
//
// All network calls go through src/payments.ts, which both this file and
// `rdk init` share. See the note at the top of that module for why.
import { loadConfig } from '../config.js';
import { RetrodeckAuthError } from '../retrodeck-api.js';
import {
  CRYPTO_POLL,
  createTopup,
  dashboardUrlFor,
  fetchBalance,
  parseAmount,
  pollTopupCredit,
  selfHealPendingTopup,
  sessionFromConfig,
  setAlertThreshold,
  setCreditLimit,
  fetchSubscriptionHealth,
  type BalanceStatus,
  type SubscriptionHealth,
} from '../payments.js';
import { t } from '../theme.js';

/**
 * Print the server's low-balance warning, if there is one.
 *
 * The message text comes from the server so the CLI, dashboard and desktop all
 * say the same thing. Shared by `rdk balance` and `rdk account`.
 */
export function printBalanceWarning(status?: BalanceStatus): void {
  if (!status || status.level === 'ok') return;

  const paint = status.level === 'low' ? t.warn : t.error;
  console.log(`  ${paint(status.message)}`);
  if (status.action === 'topup') {
    console.log(t.dim('  Add credit:  rdk topup [amount]'));
  }
  if (status.muted && status.level === 'empty') {
    console.log(t.dim('  Low-balance alerts are off — enable them with: rdk balance:alert <usd>'));
  }
  console.log('');
}

/**
 * Print the crypto subscription warning, if the plan has stopped collecting.
 *
 * Separate from the balance warning: this is about the user's own wallet no
 * longer being chargeable, and the remedy differs per cause.
 */
export function printSubscriptionWarning(health?: SubscriptionHealth | null): void {
  if (!health || health.remedy === 'none') return;

  const paint = health.status === 'lapsed' ? t.error : t.warn;
  console.log(`  ${paint(health.message)}`);

  if (health.remedy === 'fund_wallet' && health.buyerWallet) {
    console.log(t.dim(`  Wallet:  ${health.buyerWallet}`));
  }
  if (health.nextRetryAt) {
    console.log(t.dim(`  Next attempt: ${new Date(health.nextRetryAt).toLocaleString()}`));
  }
  if (health.remedy === 'increase_approval' || health.remedy === 'reapprove') {
    console.log(t.dim('  Fix it with: rdk account:upgrade  (choose crypto again)'));
  }
  console.log('');
}

/** `rdk subscription:status` — the crypto subscription's health. */
export async function showSubscriptionStatus(opts: { json?: boolean } = {}): Promise<void> {
  const config = loadConfig();
  const session = sessionFromConfig(config.retrodeckApiUrl);
  try {
    const health = await fetchSubscriptionHealth(session);
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, health }, null, 2));
      return;
    }
    if (!health || health.status === 'none') {
      console.log(t.dim('  No crypto subscription.'));
      return;
    }
    console.log(t.heading('\n  Crypto subscription\n'));
    console.log(`  ${t.dim('plan:')}    ${health.planId ?? '—'}`);
    console.log(`  ${t.dim('status:')}  ${health.status}`);
    if (health.reason) console.log(`  ${t.dim('reason:')}  ${health.reason}`);
    console.log('');
    printSubscriptionWarning(health);
  } catch (e) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: (e as Error).message }, null, 2));
      return;
    }
    console.log(t.error(`  ${(e as Error).message}`));
  }
}

export async function showBalance(opts: { json?: boolean } = {}): Promise<void> {
  const config = loadConfig();
  if (!config.retrodeckApiUrl || !config.retrodeckAccessToken) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: 'not_logged_in' }, null, 2));
      return;
    }
    console.log(t.warn('Not logged in to RetroDeck. Run: rdk account:login'));
    return;
  }

  const session = sessionFromConfig(config.retrodeckApiUrl);

  try {
    // Credit any top-up that completed but was never verified — crediting happens
    // on verification, so without this a closed checkout tab strands the payment.
    await selfHealPendingTopup(session);

    const balance = await fetchBalance(session);

    if (opts.json) {
      console.log(JSON.stringify({ ok: true, ...balance }, null, 2));
      return;
    }

    const level = balance.status?.level ?? 'ok';
    // Colour the figure by the SERVER's assessment. Printing it green while the
    // account is empty is what made "insufficient balance" a surprise.
    const paint = level === 'ok' ? t.green : level === 'low' ? t.warn : t.error;

    console.log(t.heading('\n  Balance\n'));
    console.log(`  ${t.dim('current:')}       ${paint(`$${balance.balanceUsdc.toFixed(4)} USDC`)}`);
    console.log(`  ${t.dim('credit limit:')}  $${balance.creditLimitUsd.toFixed(2)}`);
    console.log(`  ${t.dim('withdrawable:')}  $${balance.withdrawable.toFixed(4)}`);
    console.log('');
    printBalanceWarning(balance.status);
    console.log(t.dim('  Top up:    rdk topup [amount]'));
    console.log(t.dim('  Withdraw:  rdk earnings:withdraw'));
    console.log('');
  } catch (e) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: (e as Error).message }, null, 2));
      return;
    }
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

  const amountUsd = parseAmount(amountArg, 10);
  if (amountUsd === null) {
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

  const session = sessionFromConfig(config.retrodeckApiUrl);
  const spinner = ora(`Creating checkout to add $${amountUsd.toFixed(2)} USDC...`).start();
  try {
    const { checkoutUrl, paymentId } = await createTopup(session, {
      amountUsd,
      method: 'stripe',
      // Stripe returns to the dashboard, not the marketing site.
      returnUrl: dashboardUrlFor(config.retrodeckApiUrl ?? 'https://api.retrodeck.ai'),
    });
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
    const result = await pollTopupCredit(session, { paymentRef: paymentId });

    if (result.completed) {
      verify.succeed(
        `Added $${amountUsd.toFixed(2)} USDC — balance is now $${result.balance.toFixed(4)}`,
      );
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
  const config = loadConfig();
  const session = sessionFromConfig(config.retrodeckApiUrl);

  const outcome = await payTopupWithCryptocadet({
    amountUsd,
    mintQuote: async () => {
      try {
        const result = await createTopup(session, { amountUsd, method: 'cryptocadet' });
        return (result.cryptocadet as never) ?? null;
      } catch (e) {
        console.log(t.warn(`  Server declined the crypto top-up: ${(e as Error).message}`));
        return null;
      }
    },
  });

  // `payTopupWithCryptocadet` reports every business outcome as a value — the
  // CryptoCadet CLI exits 0 for REFUSED/ESCALATE/FAILED alike, so anything other
  // than an explicit 'paid' means nothing was broadcast.
  if (outcome.status !== 'paid') {
    console.log(t.warn(`  Crypto top-up ${outcome.status}: ${outcome.detail}`));
    console.log('');
    return;
  }

  const verify = ora('Confirming your on-chain top-up...').start();
  const result = await pollTopupCredit(session, { ...CRYPTO_POLL });

  if (result.completed) {
    verify.succeed(
      `Added $${amountUsd.toFixed(2)} USDC — balance is now $${result.balance.toFixed(4)}`,
    );
  } else {
    verify.warn('Payment broadcast — crediting can take a moment to settle.');
    console.log(t.dim('  Run `rdk balance` shortly; it re-checks any pending top-up.'));
  }
  console.log('');
}

// ── `rdk balance:limit` / `rdk balance:alert` ───────────────────────────────
// These endpoints existed but were reachable ONLY from `rdk init`, so a user
// could never change their credit limit or low-balance threshold afterwards —
// and the alert threshold defaults to 0, which disables alerts entirely.

export async function setLimitCommand(amountArg: string): Promise<void> {
  const limitUsd = parseAmount(amountArg, NaN);
  if (limitUsd === null || !Number.isFinite(limitUsd)) {
    console.log(t.error('  Invalid amount. Usage: rdk balance:limit <usd>   e.g. rdk balance:limit 20'));
    return;
  }
  const config = loadConfig();
  try {
    const { creditLimit } = await setCreditLimit(sessionFromConfig(config.retrodeckApiUrl), limitUsd);
    console.log(t.green(`  Credit limit set to $${creditLimit.toFixed(2)}.`));
    console.log(t.dim('  Earnings above this stay withdrawable; below it they fund queries.'));
  } catch (e) {
    console.log(t.error(`  ${(e as Error).message}`));
  }
}

export async function setAlertCommand(
  amountArg: string | undefined,
  opts: { off?: boolean } = {},
): Promise<void> {
  const thresholdUsd = opts.off ? 0 : parseAmount(amountArg, NaN);
  if (thresholdUsd === null || !Number.isFinite(thresholdUsd)) {
    console.log(t.error('  Invalid amount. Usage: rdk balance:alert <usd> | --off'));
    return;
  }
  const config = loadConfig();
  try {
    const { alertThreshold } = await setAlertThreshold(
      sessionFromConfig(config.retrodeckApiUrl),
      thresholdUsd,
    );
    if (alertThreshold > 0) {
      console.log(t.green(`  You'll be emailed when your balance drops below $${alertThreshold.toFixed(2)}.`));
    } else {
      console.log(t.warn('  Low-balance alerts are OFF. You will not be warned before queries start failing.'));
    }
  } catch (e) {
    console.log(t.error(`  ${(e as Error).message}`));
  }
}
