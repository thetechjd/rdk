import { useEffect, useRef, useState } from 'react';
import type { QueryResponse } from '../shared/ipc';
import { useApp } from './store';

export function QueryBar() {
  const app = useApp();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<QueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const run = async () => {
    if (!q.trim()) return;
    setLoading(true);
    const r = await window.rdk.query(q.trim());
    setRes(r);
    setLoading(false);
  };

  const openHit = (chunkId: string, title: string, isOwn: boolean) => {
    if (isOwn) { app.selectChunk(chunkId); app.openContentForChunk(chunkId, title); }
    app.setPaletteOpen(false);
  };

  return (
    <div className="palette-overlay" onMouseDown={e => { if (e.target === e.currentTarget) app.setPaletteOpen(false); }}>
      <div className="palette">
        <input
          ref={inputRef}
          placeholder="Query the RDK network…"
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') run(); }}
        />
        {loading && <div className="palette-meta-bar"><span className="spin">◴</span> querying network…</div>}
        {res && !loading && (
          <>
            <div className="palette-results">
              {res.hits.length === 0 && (
                <div className="palette-hit"><div className="snippet">No matches. {res.source === 'llm_fallback' ? 'Nothing in the network answered this — an LLM would handle it.' : ''}</div></div>
              )}
              {res.hits.map((h, i) => (
                <div key={i} className="palette-hit" onClick={() => openHit(h.chunkId, h.title, h.isOwn)}>
                  <div className="title">
                    <span>{h.title}</span>
                    <span style={{ color: 'var(--muted)' }}>{(h.score * 100).toFixed(0)}%</span>
                  </div>
                  <div className="snippet">{h.snippet}</div>
                  <div className="meta">
                    <span>{h.isOwn ? <span className="own-badge">◆ your knowledge</span> : `node ${h.sourceNode.slice(0, 10)}`}</span>
                    {h.tipUsdc > 0 && <span style={{ color: 'var(--cassette)' }}>tip ${h.tipUsdc.toFixed(3)}</span>}
                  </div>
                </div>
              ))}
            </div>
            <div className="palette-meta-bar">
              <span>source: {res.source}</span>
              <span>{res.hits.length} hits</span>
              <span>~{res.tokenEstimate} tok</span>
              {res.tipsPaidUsdc > 0 && <span style={{ color: 'var(--cassette)' }}>tips ${res.tipsPaidUsdc.toFixed(3)}</span>}
              <span>{res.latencyMs}ms</span>
            </div>
          </>
        )}
        {!res && !loading && (
          <div className="palette-meta-bar">↵ to search · esc to close · your own knowledge is checked first, then the network</div>
        )}
      </div>
    </div>
  );
}
