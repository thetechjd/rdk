import { useCallback, useEffect, useState } from 'react';
import type { Account, EarningsSummary, WithdrawalView } from '../../shared/ipc';
import { useApp } from '../store';

export function Earnings() {
  const app = useApp();
  const { dataVersion } = app;
  const [data, setData] = useState<EarningsSummary | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [payout, setPayout] = useState<{ enabled: boolean; chain: string; reason?: string } | null>(null);
  const [history, setHistory] = useState<WithdrawalView[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    window.rdk.getEarnings().then(setData);
    window.rdk.getAccount().then(setAccount);
    window.rdk.getWithdrawalStatus().then(setPayout);
    window.rdk.getWithdrawals().then(setHistory);
  }, []);

  useEffect(() => { refresh(); }, [refresh, dataVersion]);

  // Withdrawable is the SERVER's figure — never re-derived here. It is balance
  // minus the credit limit, and getting that arithmetic wrong in a client is
  // how a user ends up requesting more than they can actually take out.
  const withdrawable = account?.withdrawable ?? 0;
  const wallet = account?.walletAddress;

  const withdraw = useCallback(async () => {
    if (!wallet || withdrawable <= 0) return;
    setBusy(true);
    const r = await window.rdk.requestWithdrawal(withdrawable, wallet);
    setBusy(false);
    if (r.ok) {
      // "Requested", not "sent" — settlement happens on-chain afterwards.
      app.toast(`Withdrawal requested — $${withdrawable.toFixed(2)} to ${wallet.slice(0, 10)}…`);
      app.refreshData();
      refresh();
    } else {
      app.toast(r.error ?? 'Withdrawal failed', true);
    }
  }, [app, refresh, wallet, withdrawable]);

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
          <button
            className="cassette"
            disabled={busy || !payout?.enabled || !wallet || withdrawable <= 0}
            title={
              !wallet ? 'Add a wallet address in Settings → Account first.'
                : !payout?.enabled ? (payout?.reason ?? 'Payouts are unavailable right now.')
                : withdrawable <= 0 ? 'Nothing withdrawable yet.'
                : `Send $${withdrawable.toFixed(2)} USDC to ${wallet} on ${payout.chain}`
            }
            onClick={withdraw}
          >{busy ? 'requesting…' : 'withdraw →'}</button>
        </div>
        {/* Say why it's unavailable rather than showing a dead button. */}
        {!payout?.enabled && (
          <div className="hint">{payout?.reason ?? 'Payouts are unavailable on this server right now.'}</div>
        )}
        {payout?.enabled && !wallet && (
          <div className="hint">Add a wallet address in Settings → Account to withdraw.</div>
        )}
        {payout?.enabled && wallet && (
          <div className="hint">
            Sent to {wallet} on {payout.chain}. Settlement is on-chain and takes a moment —
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
