import { useCallback, useEffect, useState } from 'react';
import { marked } from 'marked';
import type { ContentView } from '../../shared/ipc';
import { useApp, type Tab } from '../store';

marked.setOptions({ gfm: true, breaks: false });

export function ContentPane({ tab }: { tab: Tab }) {
  const app = useApp();
  const [tabContent, setTabContent] = useState<ContentView | null>(null);
  const [loading, setLoading] = useState(true);
  // When editing (or after a save) the pane shows the full source FILE, not the
  // tab's chunk excerpt — editing is always file-based (files are source of truth).
  const [fileView, setFileView] = useState<ContentView | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const display = fileView ?? tabContent;
  const editablePath = display?.sourcePath; // present ⟺ a real local file backs this content

  // Load the tab's content; reset any edit/file-view state on tab change.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setFileView(null);
    setEditing(false);
    const p = tab.chunkId ? window.rdk.readContent(tab.chunkId) : window.rdk.readFile(tab.filePath!);
    p.then(c => { if (alive) { setTabContent(c); setLoading(false); } });
    return () => { alive = false; };
  }, [tab.chunkId, tab.filePath]);

  const startEdit = useCallback(async () => {
    const p = (fileView ?? tabContent)?.sourcePath;
    if (!p) return;
    const file = await window.rdk.readFile(p);
    if (!file) { app.toast('Could not open the file for editing', true); return; }
    setFileView(file);
    setDraft(file.body);
    setEditing(true);
  }, [fileView, tabContent, app]);

  // "New note" (and any openFileForEdit call) drops us straight into edit mode.
  useEffect(() => {
    if (tab.filePath && app.pendingEditPath === tab.filePath && !editing) {
      app.clearPendingEdit();
      void startEdit();
    }
  }, [tab.filePath, app.pendingEditPath, editing, app, startEdit]);

  const save = useCallback(async () => {
    if (!editablePath) return;
    setSaving(true);
    const r = await window.rdk.writeFile(editablePath, draft);
    setSaving(false);
    if (!r.ok) { app.toast(r.error ?? 'Save failed', true); return; }
    const fresh = await window.rdk.readFile(editablePath);
    setFileView(fresh);
    setEditing(false);
    app.toast(r.reindexed ? `Saved · re-indexed ${r.reindexed} chunk(s)` : 'Saved');
    app.refreshData();
    app.refreshStatus();
  }, [editablePath, draft, app]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
    if (e.key === 'Escape') { setEditing(false); setFileView(null); }
  };

  if (loading) return <div className="empty">loading…</div>;
  if (!display) return <div className="empty">Could not read this item.</div>;

  if (editing) {
    return (
      <div className="content editor">
        <div className="editor-bar">
          <span className="editor-path">editing {display.title}</span>
          <span style={{ flex: 1 }} />
          <button className="ghost" disabled={saving} onClick={() => { setEditing(false); setFileView(null); }}>cancel</button>
          <button className="primary" disabled={saving} onClick={() => void save()}>{saving ? 'saving…' : 'save'}</button>
        </div>
        <textarea
          className="editor-area"
          value={draft}
          spellCheck={false}
          autoFocus
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="editor-hint">
          ⌘/Ctrl+S save · Esc cancel{display.state === 'public' ? ' · the published (public) chunk stays immutable' : ''}
        </div>
      </div>
    );
  }

  const html =
    display.format === 'markdown'
      ? (marked.parse(display.body) as string)
      : `<pre>${escapeHtml(display.body)}</pre>`;

  return (
    <div className="content">
      <div className="content-bar">
        {display.decrypted && <span className="decrypt-note">◆ decrypted locally with your vault key</span>}
        {display.state === 'private' && !display.decrypted && (
          <span className="decrypt-note" style={{ color: 'var(--muted)' }}>encrypted — no key available</span>
        )}
        <span style={{ flex: 1 }} />
        {editablePath && <button onClick={() => void startEdit()} title="Edit this file">edit</button>}
      </div>
      <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}
