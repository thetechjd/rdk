import { useApp } from './store';

function ago(iso?: string): string {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function StatusBar() {
  const { status, account } = useApp();
  return (
    <div className="statusbar">
      <span className="item">
        <span className={`dot ${status?.serving ? 'public' : 'local'}`} />
        {status?.serving ? 'serving' : 'not serving'}
      </span>
      <span className="item">synced {ago(status?.lastSyncAt)}</span>
      <span className="item">{status?.chunkCount ?? 0} chunks</span>
      {status && status.unsyncedChunks > 0 && (
        <span className="item" style={{ color: 'var(--cassette)' }}>{status.unsyncedChunks} unsynced</span>
      )}
      <span className="spacer" />
      <span className="item balance">
        ${(account?.balanceUsdc ?? status?.pendingTipsUsdc ?? 0).toFixed(2)} USDC
      </span>
      <span className="item plan">{account?.plan ?? 'free'}</span>
    </div>
  );
}
