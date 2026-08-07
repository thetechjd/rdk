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
      <span className="item"
        title={status?.contentServing
          ? status?.wsConnected
            ? 'Connected to the network — your indexed content can be retrieved.'
            // Several RDK apps can serve the same node at once, so say which is,
            // rather than leaving "serving" unexplained while this window shows
            // no connection of its own.
            + (status?.alsoServedBy ? ` Also serving: ${status.alsoServedBy}.` : '')
            : `Your node is reachable through ${status?.alsoServedBy ?? 'another RDK app'} on this machine.`
          : 'Not connected — nothing you have indexed can be retrieved right now.'}>
        <span className={`dot ${status?.contentServing ? 'serving' : 'stopped'}`} />
        {status?.contentServing ? 'serving' : 'not serving'}
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
