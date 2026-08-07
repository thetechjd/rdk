import React, { useEffect, useState } from 'react';
import type { ChunkView, RetrievedFor, VersionView } from '../../shared/ipc';
import { useApp } from '../store';

export function Inspector() {
  const app = useApp();
  const id = app.selectedChunkId;
  const [chunk, setChunk] = useState<ChunkView | null>(null);
  const [retrieved, setRetrieved] = useState<RetrievedFor[]>([]);
  const [versions, setVersions] = useState<VersionView[]>([]);
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) { setChunk(null); setRetrieved([]); setVersions([]); return; }
    let alive = true;
    setPinned(false);
    window.rdk.getChunk(id).then(c => {
      if (!alive) return;
      setChunk(c);
      if (c?.sourcePath) window.rdk.getVersions(c.sourcePath).then(v => alive && setVersions(v));
      else setVersions([]);
      // Pin state lives on Central, not in the local store, so it is fetched
      // per selection rather than carried on the chunk.
      if (c?.documentHash) {
        window.rdk.pinnedDocuments([c.documentHash])
          .then(hashes => alive && setPinned(hashes.includes(c.documentHash!)));
      }
    });
    window.rdk.getRetrievedFor(id).then(r => alive && setRetrieved(r));
    return () => { alive = false; };
  }, [id, app.dataVersion]);

  const caps = app.caps;

  async function act(fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (r.ok) { app.toast(okMsg); app.refreshData(); app.refreshStatus(); }
    else app.toast(r.error ?? 'Action failed', true);
  }

  return (
    <>
      <div className="pane-header">Inspector</div>
      <div className="pane-body">
        {!chunk ? (
          <div className="empty">Select a file or graph node to inspect it.</div>
        ) : (
          <div className="inspector">
            <div className={`visibility state-${chunk.state}`}>
              <span className={`dot ${chunk.state}`} /> {chunk.state}
            </div>
            <div className="filename">{chunk.title}</div>

            <div className="stat-grid">
              <Stat label="chunks" value={chunk.docChunkCount} />
              <Stat label="retrievals" value={chunk.retrievals} />
              <Stat label="earned" value={`$${chunk.earnedUsdc.toFixed(2)}`} earn />
              <Stat label="size" value={`${chunk.sizeTokens} tok`} />
            </div>

            <div>
              <div className="section-label" style={{ marginBottom: 8 }}>Retrieved for</div>
              {retrieved.length === 0 ? (
                <div className="hint">No retrievals yet.</div>
              ) : (
                <div className="retrieved-list">
                  {retrieved.map((r, i) => (
                    <div key={i} className="retrieved-item">
                      <span className="q">"{r.queryText}"</span>
                      <span className="n">×{r.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* More than one VERSION — an unedited document has exactly one, however
                many chunks it split into. */}
            {versions.length > 1 && (
              <div>
                <div className="section-label" style={{ marginBottom: 8 }}>History</div>
                <div className="retrieved-list">
                  {versions.map((v) => (
                    <div key={v.version} className="retrieved-item" style={{ cursor: 'pointer', opacity: v.superseded ? 0.6 : 1 }}
                      title={v.superseded ? 'Superseded — frozen, viewable read-only' : 'Live version'}
                      onClick={() => app.openContentForChunk(v.chunkId, `${chunk.title} (v${v.version})`)}>
                      <span className="q">v{v.version} · {v.state}{v.superseded ? ' · superseded' : ' · live'}</span>
                      <span className="n">
                        {v.chunkCount} chunk{v.chunkCount === 1 ? '' : 's'} · {new Date(v.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="inspector-actions">
              {chunk.state === 'private' && (
                <button className="cassette" disabled={busy}
                  onClick={() => act(() => window.rdk.publishChunk(chunk.id), 'Published')}>publish</button>
              )}
              <button
                disabled={busy || !caps?.unpublishSupported || chunk.state !== 'public'}
                title={chunk.state === 'public'
                  ? 'Retire: stop serving this from the network (earnings history is kept; copies already saved elsewhere cannot be recalled)'
                  : 'Only public chunks can be unpublished'}
                onClick={() => act(() => window.rdk.unpublishChunk(chunk.id), 'Unpublished (retired from the network)')}>unpublish</button>
              <button
                className={pinned ? 'cassette' : ''}
                disabled={busy || !caps?.pinSupported || !chunk.documentHash}
                title={
                  !caps?.pinSupported
                    ? 'Pinning needs a node connected to the network'
                    : !chunk.documentHash
                      ? 'Indexed before RDK recorded documents — re-index this file to pin it'
                      : pinned
                        ? 'Stop renting storage for this document. Your copy is untouched.'
                        : 'Keep this document answerable while this node is offline. Billed monthly per MB.'
                }
                onClick={() => act(
                  async () => {
                    const r = await window.rdk.pinDocument(chunk.documentHash!, !pinned);
                    if (r.ok) setPinned(!pinned);
                    return r;
                  },
                  pinned ? 'Unpinned' : 'Pinned — stays available while this node is offline',
                )}>{pinned ? 'unpin' : 'pin'}</button>
              <button className="ghost" disabled={busy} style={{ color: 'var(--danger)' }}
                onClick={() => act(async () => window.rdk.deleteChunk(chunk.id), 'Deleted from index')}>delete</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function Stat({ label, value, earn }: { label: string; value: React.ReactNode; earn?: boolean }) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <span className={`value${earn ? ' earn' : ''}`}>{value}</span>
    </div>
  );
}
