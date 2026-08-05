import { useCallback, useEffect, useState } from 'react';
import type { Account, AccountWallet, EarningsSummary, WithdrawalView } from '../../shared/ipc';
import { useApp } from '../store';
import { computeWithdrawalBreakdown } from '@retrodeck/payments-contract';

export function Earnings() {
  const app = useApp();
  const { dataVersion } = app;
  const [data, setData] = useState<EarningsSummary | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [payout, setPayout] = useState<{ enabled: boolean; chain: string; reason?: string } | null>(null);
  const [history, setHistory] = useState<WithdrawalView[]>([]);
  const [wallets, setWallets] = useState<AccountWallet[]>([]);
  const [selectedWalletId, setSelectedWalletId] = useState('');
  const [busy, setBusy] = useState(false);
  /** Blank means "everything withdrawable" — the previous behaviour, which was
   *  also the ONLY behaviour: there was no way to take out part of a balance. */
  const [amountInput, setAmountInput] = useState('');

  const refresh = useCallback(() => {
    window.rdk.getEarnings().then(setData);
    window.rdk.getAccount().then(setAccount);
    window.rdk.getWithdrawalStatus().then(setPayout);
    window.rdk.getWithdrawals().then(setHistory);
    window.rdk.getWallets().then((rows) => {
      setWallets(rows);
      setSelectedWalletId((current) =>
        current || rows.find((wallet) => wallet.isPrimary)?.id || rows[0]?.id || '');
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh, dataVersion]);

  // Withdrawable is the SERVER's figure — never re-derived here. It is balance
  // minus the credit limit, and getting that arithmetic wrong in a client is
  // how a user ends up requesting more than they can actually take out.
  const withdrawable = account?.withdrawable ?? 0;
  const wallet = wallets.find((candidate) => candidate.id === selectedWalletId)
    ?? (account?.walletAddress
      ? { id: 'legacy', address: account.walletAddress, chain: payout?.chain ?? 'base', isPrimary: true }
      : undefined);

  // What will actually be withdrawn: the typed amount, or everything.
  const typed = amountInput.trim() === '' ? null : Number(amountInput);
  const amountValid = typed === null || (Number.isFinite(typed) && typed > 0 && typed <= withdrawable);
  const amount = typed !== null && amountValid ? typed : withdrawable;
  const amountError = !amountValid
    ? (Number.isFinite(typed) && (typed as number) > withdrawable
        ? `Only $${withdrawable.toFixed(2)} is withdrawable.`
        : 'Enter an amount greater than zero.')
    : null;

  // Fee preview, using the SAME function the server records with and the rate
  // the server published. A locally-invented 15% here could quote a payout we
  // do not send.
  const breakdown =
    amount > 0 && account?.withdrawalTaxRate != null
      ? computeWithdrawalBreakdown(amount, account.withdrawalTaxRate)
      : null;

  const withdraw = useCallback(async () => {
    if (!wallet || amount <= 0 || !amountValid || !payout?.enabled) return;
    setBusy(true);
    const r = await window.rdk.requestWithdrawal(amount, wallet.address, wallet.chain);
    setBusy(false);
    if (r.ok) {
      // "Requested", not "sent" — settlement happens on-chain afterwards.
      const received = breakdown?.net ?? amount;
      app.toast(`Withdrawal requested — $${received.toFixed(2)} to ${wallet.address.slice(0, 10)}…`);
      app.refreshData();
      refresh();
    } else {
      app.toast(r.error ?? 'Withdrawal failed', true);
    }
  }, [app, refresh, wallet, amount, amountValid, payout, breakdown]);

  if (!data) return <div className="empty">loading earnings…</div>;

  const max = Math.max(1, ...data.overTime.map(d => d.usdc));

  return (
    <div className="earnings">
      <div>
        <div className="section-label">total earned</div>
        <div className="total">${data.totalUsdc.toFixed(2)}</div>
      </div>

      <div>
        <div className="section-label" style={{ marginBottom: 6 }}>withdraw</div>
        <div className="row" style={{ alignItems: 'center', gap: 10 }}>
          <span className="earn">${withdrawable.toFixed(2)} withdrawable</span>
          <input
            className="amount-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            max={withdrawable || undefined}
            placeholder="all"
            aria-label="Amount to withdraw in USDC"
            value={amountInput}
            disabled={withdrawable <= 0}
            onChange={(event) => setAmountInput(event.target.value)}
          />
          {wallets.length > 0 && (
            <select
              aria-label="Destination wallet"
              value={selectedWalletId}
              onChange={(event) => setSelectedWalletId(event.target.value)}
            >
              {wallets.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.address.slice(0, 8)}…{candidate.address.slice(-4)} · {candidate.chain}
                </option>
              ))}
            </select>
          )}
          <button
            className="cassette"
            disabled={busy || !payout?.enabled || !wallet || withdrawable <= 0 || !amountValid}
            title={
              !wallet ? 'Add a wallet address in Settings → Account first.'
                : !payout?.enabled ? (payout?.reason ?? 'Payouts are unavailable right now.')
                : withdrawable <= 0 ? 'Nothing withdrawable yet.'
                : amountError ? amountError
                : breakdown
                  ? `Send $${breakdown.net.toFixed(2)} USDC to ${wallet.address} on ${wallet.chain} `
                    + `(a ${(breakdown.taxRate * 100).toFixed(0)}% fee of $${breakdown.tax.toFixed(2)} is withheld)`
                  : `Send $${amount.toFixed(2)} USDC to ${wallet.address} on ${wallet.chain}`
            }
            onClick={withdraw}
          >{busy ? 'requesting…' : 'withdraw →'}</button>
        </div>

        {/* Say why the button is dead rather than leaving it inert. */}
        {amountError && <div className="hint" style={{ marginTop: 6, color: 'var(--tape, #E8521A)' }}>{amountError}</div>}

        {/* The fee, before the button is pressed. A withdrawal debits at once,
            so the net must not first appear in the confirmation toast. */}
        {!amountError && breakdown && (
          <div className="hint" style={{ marginTop: 6 }}>
            ${breakdown.gross.toFixed(2)} withdrawn · {(breakdown.taxRate * 100).toFixed(0)}% fee
            −${breakdown.tax.toFixed(2)} · you receive{' '}
            <strong style={{ color: 'var(--phosphor)' }}>${breakdown.net.toFixed(2)}</strong>
          </div>
        )}
        {/* Say why it's unavailable rather than showing a dead button. */}
        {!payout?.enabled && (
          <div className="hint">{payout?.reason ?? 'Payouts are unavailable on this server right now.'}</div>
        )}
        {payout?.enabled && !wallet && (
          <div className="hint">Add a payout wallet in the Dashboard billing page, then refresh this view.</div>
        )}
        {payout?.enabled && wallet && (
          <div className="hint">
            Sent to {wallet.address} on {wallet.chain}. Settlement is on-chain and takes a moment —
            the status below updates when it lands.
          </div>
        )}
      </div>

      {history.length > 0 && (
        <div>
          <div className="section-label" style={{ marginBottom: 6 }}>withdrawals</div>
          {history.map(w => (
            <div key={w.id} className="doc-row">
              <span>
                ${w.amountUsdc.toFixed(2)}
                <span style={{ color: 'var(--muted)' }}> · {new Date(w.requestedAt).toLocaleDateString()}</span>
              </span>
              <span>
                <span style={{ color: w.status === 'completed' ? 'var(--phosphor)' : w.status === 'failed' ? 'var(--error, #f66)' : 'var(--muted)' }}>
                  {w.status}
                </span>
                {w.status === 'failed' && <span style={{ color: 'var(--muted)' }}> · refunded</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {data.overTime.length > 0 && (
        <div>
          <div className="section-label" style={{ marginBottom: 10 }}>over time</div>
          <div className="bars">
            {data.overTime.map((d, i) => (
              <div key={i} className="bar" style={{ height: `${(d.usdc / max) * 100}%` }} title={`${d.date}: $${d.usdc.toFixed(2)}`} />
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="section-label" style={{ marginBottom: 6 }}>by document</div>
        {data.byDocument.length === 0 && <div className="hint">No earning documents yet. Publish public chunks to start earning tips when the network retrieves them.</div>}
        {data.byDocument.map(d => (
          <div key={d.chunkId} className="doc-row">
            <span>{d.title}</span>
            <span><span style={{ color: 'var(--muted)' }}>{d.retrievals} retrievals</span> &nbsp; <span className="earn">${d.earnedUsdc.toFixed(2)}</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}
