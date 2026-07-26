import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Account } from '../../shared/ipc';

/**
 * The renderer half of checkpoints 6–10.
 *
 * Everything network-shaped lives in `node-service.ts` (covered in
 * `test/main/billing.test.ts`); the renderer's own responsibilities are narrow
 * but load-bearing: what it passes over IPC, and the poll loop that turns a
 * browser handoff into a credited balance. There is no Stripe webhook, so if
 * this loop stops early the user's money sits in `pending`.
 */

const toast = vi.fn();

vi.mock('../../src/store', () => ({
  useApp: () => ({
    account: null,
    status: null,
    caps: null,
    toast,
    settingsOpen: true,
    setSettingsOpen: vi.fn(),
    refreshStatus: vi.fn(),
    refreshAccount: vi.fn(),
  }),
}));

// LoginForm reaches for IPC we don't care about here.
vi.mock('../../src/LoginForm', () => ({ LoginForm: () => null }));

const { Settings } = await import('../../src/Settings');

const SIGNED_IN: Account = {
  signedIn: true,
  email: 'user@example.test',
  plan: 'starter',
  balanceUsdc: 42.5,
  creditLimitUsd: 10,
};

interface RdkStub {
  getAccount: ReturnType<typeof vi.fn>;
  getPlans: ReturnType<typeof vi.fn>;
  selectPlan: ReturnType<typeof vi.fn>;
  verifySubscription: ReturnType<typeof vi.fn>;
  createTopup: ReturnType<typeof vi.fn>;
  verifyTopup: ReturnType<typeof vi.fn>;
  openTopUp: ReturnType<typeof vi.fn>;
  openUpgrade: ReturnType<typeof vi.fn>;
  getPreferences: ReturnType<typeof vi.fn>;
  getMcpInfo: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
}

let rdk: RdkStub;

function installRdk(overrides: Partial<RdkStub> = {}): RdkStub {
  rdk = {
    getAccount: vi.fn(async () => SIGNED_IN),
    getPlans: vi.fn(async () => ({
      ok: true,
      plans: [
        { id: 'free', name: 'Free', priceMonthly: 0, maxQueriesDay: 100, maxChunks: 1000 },
        { id: 'pro', name: 'Pro', priceMonthly: 97, maxQueriesDay: 10000, maxChunks: 100000 },
      ],
    })),
    selectPlan: vi.fn(async () => ({ ok: true, checkoutUrl: 'https://checkout.stripe.com/c/pay/x' })),
    verifySubscription: vi.fn(async () => ({ paid: false })),
    createTopup: vi.fn(async () => ({ ok: true, paymentId: 'pay_1' })),
    verifyTopup: vi.fn(async () => ({ completed: false })),
    openTopUp: vi.fn(),
    openUpgrade: vi.fn(),
    getPreferences: vi.fn(async () => ({})),
    getMcpInfo: vi.fn(async () => ({})),
    getStatus: vi.fn(async () => ({})),
    ...overrides,
  } as RdkStub;
  (window as unknown as { rdk: RdkStub }).rdk = rdk;
  return rdk;
}

/** Render Settings and switch to the account section.
 *  The section switcher is a row of <div>s, not buttons — hence getByText. */
async function openAccount(user = userEvent) {
  render(<Settings />);
  await user.click(await screen.findByText('account', { selector: '.settings-tab' }));
  // Wait for the account section to have loaded, not just mounted. The word
  // "balance" appears in both a <label> and a hint, so anchor on the amount input.
  await screen.findByRole('button', { name: /top up/i });
}

beforeEach(() => {
  installRdk();
  toast.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Settings · top-up', () => {
  it('rejects a non-numeric amount without calling IPC', async () => {
    await openAccount();

    const input = screen.getByDisplayValue('10');
    await userEvent.clear(input);
    await userEvent.type(input, 'abc');
    await userEvent.click(screen.getByRole('button', { name: /top up/i }));

    expect(rdk.createTopup).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Enter a valid amount', true);
  });

  it.each(['0', '-5'])('rejects %s without calling IPC', async (amount) => {
    await openAccount();

    const input = screen.getByDisplayValue('10');
    await userEvent.clear(input);
    await userEvent.type(input, amount);
    await userEvent.click(screen.getByRole('button', { name: /top up/i }));

    expect(rdk.createTopup).not.toHaveBeenCalled();
  });

  it('passes the amount and the selected method', async () => {
    await openAccount();

    const input = screen.getByDisplayValue('10');
    await userEvent.clear(input);
    await userEvent.type(input, '25');
    await userEvent.click(screen.getByRole('button', { name: /top up/i }));

    await waitFor(() => expect(rdk.createTopup).toHaveBeenCalledWith(25, 'stripe'));
  });

  it('switches to the crypto rail when the user picks it', async () => {
    await openAccount();
    await userEvent.click(screen.getByRole('button', { name: /^crypto$/i }));
    await userEvent.click(screen.getByRole('button', { name: /top up/i }));

    await waitFor(() => expect(rdk.createTopup).toHaveBeenCalledWith(10, 'cryptocadet'));
  });

  it('does not start polling when the top-up could not be created', async () => {
    installRdk({ createTopup: vi.fn(async () => ({ ok: false, error: 'Could not start' })) });
    await openAccount();
    await userEvent.click(screen.getByRole('button', { name: /top up/i }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith('Could not start', true));
    expect(screen.queryByText(/waiting for payment/i)).not.toBeInTheDocument();
  });
});

describe('Settings · plan change', () => {
  it('sends no interval or method for a free plan', async () => {
    await openAccount();
    await userEvent.click(screen.getByRole('button', { name: /change plan/i }));
    await userEvent.click(await screen.findByRole('button', { name: /free/i }));

    // A $0 plan has neither a billing period nor a payment rail.
    await waitFor(() => expect(rdk.selectPlan).toHaveBeenCalledWith('free', undefined, undefined));
  });

  it('sends the interval and method for a paid plan', async () => {
    await openAccount();
    await userEvent.click(screen.getByRole('button', { name: /change plan/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^pro/i }));

    await waitFor(() => expect(rdk.selectPlan).toHaveBeenCalledWith('pro', 'monthly', 'stripe'));
  });

  it('does not start polling when the change is applied immediately', async () => {
    installRdk({ selectPlan: vi.fn(async () => ({ ok: true, checkoutUrl: null })) });
    await openAccount();
    await userEvent.click(screen.getByRole('button', { name: /change plan/i }));
    await userEvent.click(await screen.findByRole('button', { name: /free/i }));

    // `checkoutUrl: null` means the server already applied it — there is nothing
    // to wait for, and showing a spinner would imply otherwise.
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/switched to/i)));
    expect(screen.queryByText(/waiting for checkout/i)).not.toBeInTheDocument();
  });
});

describe('Settings · the verify poll', () => {
  it('polls verify-topup on a 2.5s cadence after a handoff', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    installRdk();
    await openAccount(user);
    await user.click(screen.getByRole('button', { name: /top up/i }));

    await waitFor(() => expect(rdk.createTopup).toHaveBeenCalled());
    expect(rdk.verifyTopup).not.toHaveBeenCalled(); // nothing before the first tick

    await vi.advanceTimersByTimeAsync(2500);
    await waitFor(() => expect(rdk.verifyTopup).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(2500);
    await waitFor(() => expect(rdk.verifyTopup).toHaveBeenCalledTimes(2));
  });

  it('carries the paymentId on every poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    installRdk();
    await openAccount(user);
    await user.click(screen.getByRole('button', { name: /top up/i }));
    await waitFor(() => expect(rdk.createTopup).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(2500);

    // Dropping the ref falls back to "most recent pending", which can credit and
    // report on a different payment than the one just made.
    await waitFor(() => expect(rdk.verifyTopup).toHaveBeenCalledWith('pay_1'));
  });

  it('stops as soon as the credit lands', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    installRdk({ verifyTopup: vi.fn(async () => ({ completed: true, balanceUsdc: 67.5 })) });
    await openAccount(user);
    await user.click(screen.getByRole('button', { name: /top up/i }));
    await waitFor(() => expect(rdk.createTopup).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(2500);
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/credited/i)));

    const callsAtSuccess = rdk.verifyTopup.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2500 * 5);
    // A loop that keeps running after success hammers the API for no reason.
    expect(rdk.verifyTopup.mock.calls.length).toBe(callsAtSuccess);
  });

  it('gives up after exactly 24 attempts and says so', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    installRdk();
    await openAccount(user);
    await user.click(screen.getByRole('button', { name: /top up/i }));
    await waitFor(() => expect(rdk.createTopup).toHaveBeenCalled());

    // ~60s of polling. The count is behaviour, not an implementation detail:
    // stopping earlier abandons a payment that is still settling on-chain.
    await vi.advanceTimersByTimeAsync(2500 * 30);

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.stringMatching(/not confirmed yet/i), true),
    );
    expect(rdk.verifyTopup.mock.calls.length).toBe(24);
  });

  it('polls verify-subscription, not verify-topup, after a plan handoff', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    installRdk();
    await openAccount(user);
    await user.click(screen.getByRole('button', { name: /change plan/i }));
    await user.click(await screen.findByRole('button', { name: /^pro/i }));
    await waitFor(() => expect(rdk.selectPlan).toHaveBeenCalled());

    await vi.advanceTimersByTimeAsync(2500);

    await waitFor(() => expect(rdk.verifySubscription).toHaveBeenCalled());
    expect(rdk.verifyTopup).not.toHaveBeenCalled();
  });

  it('lets the user cancel the wait without cancelling the payment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    installRdk();
    await openAccount(user);
    await user.click(screen.getByRole('button', { name: /top up/i }));
    await waitFor(() => expect(rdk.createTopup).toHaveBeenCalled());

    await user.click(await screen.findByRole('button', { name: /^cancel$/i }));
    const callsAtCancel = rdk.verifyTopup.mock.calls.length;

    await vi.advanceTimersByTimeAsync(2500 * 5);
    // Dismissing the spinner stops the poll. The payment itself is unaffected —
    // `getAccount`'s self-heal picks it up on the next refresh.
    expect(rdk.verifyTopup.mock.calls.length).toBe(callsAtCancel);
  });
});

describe('Settings · signed-out and expired states', () => {
  it('disables the payment controls when signed out', async () => {
    installRdk({ getAccount: vi.fn(async () => ({ signedIn: false, plan: 'free' }) as Account) });
    render(<Settings />);
    await userEvent.click(await screen.findByText('account', { selector: '.settings-tab' }));

    // Every payment control must be inert without a session — clicking them would
    // produce an opaque auth error.
    for (const name of [/top up/i, /^card$/i, /^crypto$/i]) {
      const button = screen.queryByRole('button', { name });
      if (button) expect(button).toBeDisabled();
    }
  });

  it('surfaces an expired session instead of a silently broken screen', async () => {
    installRdk({
      getAccount: vi.fn(async () => ({ signedIn: true, plan: 'pro', sessionExpired: true }) as Account),
    });
    render(<Settings />);
    await userEvent.click(await screen.findByText('account', { selector: '.settings-tab' }));

    // This banner was unreachable until `getAccount` stopped swallowing the auth
    // error from every inner call — the user saw a signed-in screen with a
    // missing balance and no explanation.
    expect(await screen.findByText(/sign in again|session (has )?expired/i)).toBeInTheDocument();
  });
});

describe('Settings · low-balance warning', () => {
  const lowStatus = {
    level: 'low' as const,
    balance: 4,
    threshold: 5,
    thresholdIsDefault: true,
    muted: false,
    spendable: 4,
    message: 'Your query credit is running low ($4.00). Consider topping up.',
    action: 'topup' as const,
  };

  it('renders the server message verbatim', async () => {
    installRdk({
      getAccount: vi.fn(async () => ({ ...SIGNED_IN, balanceStatus: lowStatus }) as Account),
    });
    await openAccount();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your query credit is running low ($4.00). Consider topping up.',
    );
  });

  it('shows nothing when the balance is healthy', async () => {
    installRdk({
      getAccount: vi.fn(async () =>
        ({ ...SIGNED_IN, balanceStatus: { ...lowStatus, level: 'ok', action: 'none' } }) as Account,
      ),
    });
    await openAccount();

    // A standing "you're fine" badge is noise, and noise gets ignored.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders normally when the API sends no status at all', async () => {
    installRdk({ getAccount: vi.fn(async () => SIGNED_IN) });
    await openAccount();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/\$42\.50 USDC/)).toBeInTheDocument();
  });
});
