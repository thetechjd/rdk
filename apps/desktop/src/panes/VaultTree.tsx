import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { VaultNode, VaultTree as VaultTreeData, VisibilityChoice } from '../../shared/ipc';
import { useApp } from '../store';

export function VaultTree() {
  const app = useApp();
  const [tree, setTree] = useState<VaultTreeData | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; node: VaultNode } | null>(null);

  const load = useCallback(() => { window.rdk.getVaultTree().then(setTree); }, []);
  useEffect(() => { load(); }, [load, app.dataVersion]);

  const indexDropped = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    const visibility: VisibilityChoice =
      // eslint-disable-next-line no-alert
      window.confirm(`Index ${paths.length} item(s) publicly (earn tips)?\n\nOK = PUBLIC · Cancel = PRIVATE (default)`)
        ? 'public' : 'private';
    app.toast(`Indexing ${paths.length} item(s)…`);
    const r = await window.rdk.indexPaths(paths, visibility);
    app.toast(r.error ? r.error : `Indexed ${r.indexed} chunk(s) ${visibility}`, !!r.error);
    app.refreshData();
    app.refreshStatus();
  }, [app]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const paths = Array.from(e.dataTransfer.files).map(f => window.rdkNative.pathForFile(f)).filter(Boolean);
    void indexDropped(paths);
  }, [indexDropped]);

  const onFileClick = (node: VaultNode) => {
    if (node.chunkIds && node.chunkIds.length > 0) {
      app.selectChunk(node.chunkIds[0]);
      app.openContentForChunk(node.chunkIds[0], node.name);
    } else {
      app.selectChunk(null);
      app.selectFile(node.path);
      app.openContentForFile(node.path, node.name);
    }
  };

  const toggle = (path: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const newNote = useCallback(async (parentRelPath: string) => {
    // eslint-disable-next-line no-alert
    const name = window.prompt('New note name', 'untitled.md');
    if (name === null || !name.trim()) return;
    const r = await window.rdk.createFile(parentRelPath, name.trim());
    if (!r.ok || !r.path) { app.toast(r.error ?? 'Could not create note', true); return; }
    app.refreshData();
    app.openFileForEdit(r.path, r.path.split(/[\\/]/).pop() || name.trim());
  }, [app]);

  return (
    <>
      <div className="pane-header">
        <span>Vault</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ textTransform: 'none', color: 'var(--phosphor-dim)' }}>{tree?.vaultName}</span>
          <button className="hdr-btn" title="New note in vault root" onClick={() => void newNote('')}>+ note</button>
        </span>
      </div>
      <div
        className="pane-body"
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => setMenu(null)}
      >
        <div className="tree">
          {tree?.nodes.length ? (
            tree.nodes.map(n => (
              <TreeRow key={n.path} node={n} depth={0} expanded={expanded} toggle={toggle}
                onFileClick={onFileClick} selectedChunk={app.selectedChunkId} selectedFile={app.selectedFilePath}
                onContext={(x, y, node) => setMenu({ x, y, node })} />
            ))
          ) : (
            <div className="empty">Vault is empty or not set.<br />Drop files below to index.</div>
          )}
        </div>

        <div className={`dropzone${dragOver ? ' over' : ''}`}>drop files to index</div>
      </div>

      <div className="tree-counts">
        <span className="c"><span className="dot private" /> private {tree?.counts.private ?? 0}</span>
        <span className="c"><span className="dot public" /> public {tree?.counts.public ?? 0}</span>
        <span className="c"><span className="dot local" /> local {tree?.counts.local ?? 0}</span>
      </div>

      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} app={app} newNote={newNote} />}
    </>
  );
}

function TreeRow({ node, depth, expanded, toggle, onFileClick, selectedChunk, selectedFile, onContext }: {
  node: VaultNode; depth: number; expanded: Set<string>; toggle: (p: string) => void;
  onFileClick: (n: VaultNode) => void; selectedChunk: string | null; selectedFile: string | null;
  onContext: (x: number, y: number, n: VaultNode) => void;
}) {
  const isOpen = expanded.has(node.path);
  const selected =
    node.type === 'file' &&
    ((node.chunkIds?.[0] && node.chunkIds[0] === selectedChunk) || node.path === selectedFile);

  if (node.type === 'folder') {
    return (
      <>
        <div className="tree-row folder" style={{ paddingLeft: 12 + depth * 12 }}
          onClick={() => toggle(node.path)}
          onContextMenu={e => { e.preventDefault(); onContext(e.clientX, e.clientY, node); }}>
          <span className="twisty">{isOpen ? '▾' : '▸'}</span>
          <span className="name">{node.name}</span>
        </div>
        {isOpen && node.children?.map(c => (
          <TreeRow key={c.path} node={c} depth={depth + 1} expanded={expanded} toggle={toggle}
            onFileClick={onFileClick} selectedChunk={selectedChunk} selectedFile={selectedFile} onContext={onContext} />
        ))}
      </>
    );
  }

  return (
    <div
      className={`tree-row${selected ? ' selected' : ''}`}
      style={{ paddingLeft: 12 + depth * 12 + 10 }}
      onClick={() => onFileClick(node)}
      onContextMenu={e => { e.preventDefault(); onContext(e.clientX, e.clientY, node); }}
    >
      <span className={`dot ${node.state}`} />
      <span className="name">{node.name}</span>
    </div>
  );
}

function ContextMenu({ x, y, node, onClose, app, newNote }: {
  x: number; y: number; node: VaultNode; onClose: () => void;
  app: ReturnType<typeof useApp>; newNote: (relPath: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [onClose]);

  const run = async (fn: () => Promise<{ ok?: boolean; indexed?: number; error?: string } | void>, msg: string) => {
    onClose();
    const r = await fn();
    const err = r && 'error' in r ? r.error : undefined;
    app.toast(err ?? msg, !!err);
    app.refreshData();
    app.refreshStatus();
  };

  if (node.type === 'folder') {
    return (
      <div className="ctx-menu" ref={ref} style={{ left: x, top: y }}>
        <div className="ctx-item" onClick={() => { onClose(); newNote(node.relPath); }}>new note here</div>
        <div className="ctx-sep" />
        <div className="ctx-item" onClick={() => { onClose(); window.rdk.revealInFileManager(node.path); }}>reveal in file manager</div>
      </div>
    );
  }

  const indexed = !!node.chunkIds?.length;
  const isPublic = node.state === 'public';
  const firstChunk = node.chunkIds?.[0];

  return (
    <div className="ctx-menu" ref={ref} style={{ left: x, top: y }}>
      <div className="ctx-item" onClick={() => run(() => window.rdk.indexPaths([node.path], 'private'), 'Indexed privately')}>index privately</div>
      <div className="ctx-item" onClick={() => run(() => window.rdk.indexPaths([node.path], 'public'), 'Indexed publicly')}>publish publicly</div>
      {indexed && !isPublic && firstChunk && (
        <div className="ctx-item" onClick={() => run(() => window.rdk.publishChunk(firstChunk), 'Published')}>publish this chunk</div>
      )}
      <div className="ctx-sep" />
      <div className="ctx-item" onClick={() => { onClose(); window.rdk.revealInFileManager(node.path); }}>reveal in file manager</div>
      {indexed && firstChunk && (
        <div className="ctx-item danger" onClick={() => run(async () => window.rdk.deleteChunk(firstChunk), 'Deleted from index')}>delete from index</div>
      )}
    </div>
  );
}
