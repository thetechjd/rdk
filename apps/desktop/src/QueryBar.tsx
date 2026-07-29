import { useEffect, useRef, useState } from 'react';
import type { QueryDocument, QueryResponse } from '../shared/ipc';
import { useApp } from './store';

/**
 * A successful query has to LAND somewhere.
 *
 * This used to render one row per chunk and ask the user to click one — but
 * clicking a network result did nothing at all (the handler only acted on own
 * content), so the content was fetched, the tip was paid, and it was thrown
 * away. And five rows were routinely five fragments of the SAME document, which
 * makes "choose one" an impossible question: a fragment shows too little to
 * judge, and choosing discards the rest of the answer.
 *
 * Now results are whole documents, saved into the vault as markdown. One match
 * opens straight away, because there is nothing to decide. Several open the
 * chooser — and each choice is a document with enough preview to tell them
 * apart. Wrong pick costs nothing: they are all already on disk.
 */
export function QueryBar() {
  const app = useApp();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<QueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const openDocument = (doc: QueryDocument) => {
    if (!doc.filePath) {
      app.toast(doc.contentAvailable
        ? `"${doc.name}" could not be saved to your vault`
        : `Only a summary of "${doc.name}" is available — its node isn't serving the content`, true);
      return;
    }
    app.openContentForFile(doc.filePath, doc.name);
    app.setPaletteOpen(false);
    app.refreshData(); // the vault gained a file
  };

  const run = async () => {
    if (!q.trim()) return;
    setLoading(true);
    setRes(null);
    const r = await window.rdk.query(q.trim());
    setLoading(false);

    // Exactly one document answered the question — opening a chooser with a
    // single entry is just an extra click before the only possible outcome.
    const docs = r.documents ?? [];
    if (docs.length === 1 && docs[0].filePath && docs[0].contentAvailable) { openDocument(docs[0]); return; }
    setRes(r);
  };

  const docs = res?.documents ?? [];

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
                <div className="palette-hit"><div className="snippet">
                  {/* A failed network call is not a miss — saying "no matches" for a
                      credit gate or a dead connection hides the real problem. */}
                  {res.networkError
                    ? `Couldn't search the network: ${res.networkError}`
                    : res.unavailableCount
                      ? (res.networkMessage
                        ?? `${res.unavailableCount} match(es) found, but their content could not be retrieved (${res.unavailableReasons?.join(', ') ?? 'unknown reason'}).`)
                      : `No matches. ${res.source === 'llm_fallback' ? 'Nothing in the network answered this — an LLM would handle it.' : ''}`}
                </div></div>
              )}

              {/* Matched but unretrievable, named and FIRST. Buried under five
                  loose matches, this reads as "the wrong answer" rather than
                  "the right answer exists and its owner is offline". */}
              {res.hits.length > 0 && !!res.unavailableCount && (
                <div className="palette-hit"><div className="snippet" style={{ color: 'var(--cassette)' }}>
                  {res.unavailableCount} match(es) could not be retrieved
                  {res.unavailableReasons?.includes('owner_offline')
                    ? ' — the node publishing them is not connected right now.'
                    : ` (${res.unavailableReasons?.join(', ') ?? 'unknown reason'}).`}
                </div></div>
              )}

              {res.hits.length > 0 && res.lowConfidence && (
                <div className="palette-hit"><div className="snippet" style={{ color: 'var(--cassette)' }}>
                  {res.source === 'private'
                    ? 'Nothing matched confidently — showing the closest things in your vault.'
                    : 'Loose matches — nothing scored as a strong match for this query.'}
                </div></div>
              )}

              {docs.length > 1 && (
                <div className="palette-hit"><div className="snippet">
                  {docs.length} documents matched — all saved to your vault. Open whichever fits;
                  the others stay on disk.
                </div></div>
              )}

              {/* Network results: whole documents, click to open as markdown. */}
              {docs.map((doc, i) => (
                <div key={`d${i}`} className="palette-hit" onClick={() => openDocument(doc)}>
                  <div className="title">
                    <span>{doc.name}</span>
                    <span style={{ color: 'var(--muted)' }}>{(doc.score * 100).toFixed(0)}%</span>
                  </div>
                  <div className="snippet">{doc.preview}</div>
                  <div className="meta">
                    <span>
                      {doc.isOwn
                        ? <span className="own-badge">◆ your knowledge</span>
                        : `node ${doc.originNode.slice(0, 10)}`}
                    </span>
                    <span>{doc.sectionCount} section{doc.sectionCount === 1 ? '' : 's'}</span>
                    {doc.tipUsdc > 0 && <span style={{ color: 'var(--cassette)' }}>tip ${doc.tipUsdc.toFixed(3)}</span>}
                    {!doc.contentAvailable
                      ? <span style={{ color: 'var(--cassette)' }}>summary only</span>
                      : !doc.filePath && !doc.isOwn
                        ? <span style={{ color: 'var(--cassette)' }}>not saved</span>
                        : null}
                  </div>
                </div>
              ))}

              {/* Local-vault results are already files the user owns — open in place. */}
              {docs.length === 0 && res.hits.map((h, i) => (
                <div
                  key={i}
                  className="palette-hit"
                  onClick={() => {
                    app.selectChunk(h.chunkId);
                    app.openContentForChunk(h.chunkId, h.title);
                    app.setPaletteOpen(false);
                  }}
                >
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
              <span>{docs.length > 0 ? `${docs.length} document${docs.length === 1 ? '' : 's'}` : `${res.hits.length} hits`}</span>
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
