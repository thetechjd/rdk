import { useEffect, useState } from 'react';
import { marked } from 'marked';
import type { ContentView } from '../../shared/ipc';
import type { Tab } from '../store';

marked.setOptions({ gfm: true, breaks: false });

export function ContentPane({ tab }: { tab: Tab }) {
  const [content, setContent] = useState<ContentView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const p = tab.chunkId ? window.rdk.readContent(tab.chunkId) : window.rdk.readFile(tab.filePath!);
    p.then(c => { if (alive) { setContent(c); setLoading(false); } });
    return () => { alive = false; };
  }, [tab.chunkId, tab.filePath]);

  if (loading) return <div className="empty">loading…</div>;
  if (!content) return <div className="empty">Could not read this item.</div>;

  const html =
    content.format === 'markdown'
      ? (marked.parse(content.body) as string)
      : `<pre>${escapeHtml(content.body)}</pre>`;

  return (
    <div className="content">
      {content.decrypted && <div className="decrypt-note">◆ decrypted locally with your vault key</div>}
      {content.state === 'private' && !content.decrypted && (
        <div className="decrypt-note" style={{ color: 'var(--muted)' }}>encrypted — no key available</div>
      )}
      <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}
