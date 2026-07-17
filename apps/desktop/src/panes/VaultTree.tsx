import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { VaultNode, VaultTree as VaultTreeData, VisibilityChoice } from '../../shared/ipc';
import { useApp } from '../store';

export function VaultTree() {
  const app = useApp();
  const [tree, setTree] = useState<VaultTreeData | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; node: VaultNode } | null>(null);
  const [naming, setNaming] = useState<{ parentRelPath: string } | null>(null);
  const [vaultMenu, setVaultMenu] = useState<{ x: number; y: number } | null>(null);
  const [indexing, setIndexing] = useState<{ paths: string[] } | null>(null);

  const load = useCallback(() => { window.rdk.getVaultTree().then(setTree); }, []);
  useEffect(() => { load(); }, [load, app.dataVersion]);

  // Indexing always asks for the visibility explicitly — LOCAL (cancel), PRIVATE, or PUBLIC.
  const askIndex = useCallback((paths: string[]) => {
    const clean = paths.filter(Boolean);
    if (clean.length) setIndexing({ paths: clean });
  }, []);

  const doIndex = useCallback(async (visibility: VisibilityChoice) => {
    const paths = indexing?.paths ?? [];
    setIndexing(null);
    if (!paths.length) return;
    app.toast(`Indexing ${paths.length} item(s) as ${visibility}…`);
    const r = await window.rdk.indexPaths(paths, visibility);
    app.toast(r.error ? r.error : `Indexed ${r.indexed} chunk(s) — ${visibility}`, !!r.error);
    app.refreshData();
    app.refreshStatus();
  }, [indexing, app]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    // Internal drag from the tree, or external files from the OS file manager.
    const internal = e.dataTransfer.getData('application/x-rdk-path');
    const paths = internal
      ? [internal]
      : Array.from(e.dataTransfer.files).map(f => window.rdkNative.pathForFile(f)).filter(Boolean);
    askIndex(paths);
  }, [askIndex]);

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

  // window.prompt() is a no-op in Electron, so new-note naming uses an in-app input.
  const newNote = useCallback((parentRelPath: string) => setNaming({ parentRelPath }), []);

  const submitNewNote = useCallback(async (rawName: string) => {
    const parentRelPath = naming?.parentRelPath ?? '';
    const name = rawName.trim();
    setNaming(null);
    if (!name) return;
    const r = await window.rdk.createFile(parentRelPath, name);
    if (!r.ok || !r.path) { app.toast(r.error ?? 'Could not create note', true); return; }
    app.refreshData();
    app.openFileForEdit(r.path, r.path.split(/[\\/]/).pop() || name);
  }, [naming, app]);

  return (
    <>
      <div className="pane-header">
        <span>Vault</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            className="vault-name-btn"
            title="Vault actions (open folder, change vault, re-index)"
            onClick={e => { e.stopPropagation(); setMenu(null); setVaultMenu({ x: e.clientX, y: e.clientY }); }}
          >
            {tree?.vaultName ?? 'no vault'} ▾
          </button>
          <button className="hdr-btn" title="New note in vault root" onClick={() => newNote('')}>+ note</button>
        </span>
      </div>
      <div
        className="pane-body"
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => { setMenu(null); setVaultMenu(null); }}
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

        <div className={`dropzone${dragOver ? ' over' : ''}`}>
          {dragOver ? 'drop to index (choose private/public)' : 'drag files here to index — or drop from your file manager'}
        </div>
      </div>

      <div className="tree-counts">
        <span className="c"><span className="dot private" /> private {tree?.counts.private ?? 0}</span>
        <span className="c"><span className="dot public" /> public {tree?.counts.public ?? 0}</span>
        <span className="c"><span className="dot local" /> local {tree?.counts.local ?? 0}</span>
      </div>

      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} app={app} newNote={newNote} />}
      {vaultMenu && <VaultMenu {...vaultMenu} root={tree?.root} onClose={() => setVaultMenu(null)} app={app} />}
      {naming && (
        <NamePrompt
          title={naming.parentRelPath ? `New note in ${naming.parentRelPath}` : 'New note'}
          defaultValue="untitled.md"
          onSubmit={submitNewNote}
          onClose={() => setNaming(null)}
        />
      )}
      {indexing && (
        <IndexChoice count={indexing.paths.length} onChoose={doIndex} onClose={() => setIndexing(null)} />
      )}
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
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('application/x-rdk-path', node.path);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      title="Drag onto the drop zone below to index (private/public), or right-click for options"
      onClick={() => onFileClick(node)}
      onContextMenu={e => { e.preventDefault(); onContext(e.clientX, e.clientY, node); }}
    >
      <span className={`dot ${node.state}`} />
      <span className="name">{node.name}</span>
    </div>
  );
}

// Explicit LOCAL / PRIVATE / PUBLIC choice when indexing (files are the source of
// truth; the three states are distinct — see the glossary).
function IndexChoice({ count, onChoose, onClose }: {
  count: number; onChoose: (v: VisibilityChoice) => void; onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="index-choice">
        <div className="ic-head">Index {count} item{count > 1 ? 's' : ''} to the network as…</div>
        <button className="ic-opt" onClick={() => onChoose('private')}>
          <span className="dot private" />
          <span className="ic-text">
            <b className="state-private">private</b>
            <small>Encrypted and indexed on the network. Only you (and team members you share your vault key with) can read it.</small>
          </span>
        </button>
        <button className="ic-opt" onClick={() => onChoose('public')}>
          <span className="dot public" />
          <span className="ic-text">
            <b className="state-public">public</b>
            <small>Plaintext on the network. Anyone can read it and it earns tips when retrieved. Immutable once published.</small>
          </span>
        </button>
        <div className="ic-foot">
          <span className="hint">Cancel keeps it <b className="state-local">local</b> — on your machine only, not indexed.</span>
          <button className="ghost" onClick={onClose}>cancel</button>
        </div>
      </div>
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
      <div className="ctx-item" onClick={() => run(() => window.rdk.indexPaths([node.path], 'private'), 'Indexed — private')}>index as <span className="state-private">private</span></div>
      <div className="ctx-item" onClick={() => run(() => window.rdk.indexPaths([node.path], 'public'), 'Indexed — public')}>index as <span className="state-public">public</span></div>
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

// Actions for the vault itself (the header vault-name button).
function VaultMenu({ x, y, root, onClose, app }: {
  x: number; y: number; root?: string; onClose: () => void; app: ReturnType<typeof useApp>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [onClose]);

  const changeVault = async () => {
    onClose();
    const dir = await window.rdk.chooseVaultDirectory();
    if (!dir) return;
    await window.rdk.setPreferences({ vaultPath: dir });
    app.refreshData();
    app.refreshStatus();
    app.toast('Vault changed');
  };
  const reindex = async () => {
    onClose();
    app.toast('Re-indexing vault…');
    const r = await window.rdk.reindex();
    app.toast(r.ok ? 'Re-indexed' : (r.error ?? 'Re-index failed'), !r.ok);
    app.refreshData();
    app.refreshStatus();
  };

  return (
    <div className="ctx-menu" ref={ref} style={{ left: x, top: y }}>
      <div className="ctx-item" onClick={() => { onClose(); if (root) window.rdk.revealInFileManager(root); }}>open vault folder</div>
      <div className="ctx-item" onClick={changeVault}>change vault…</div>
      <div className="ctx-sep" />
      <div className="ctx-item" onClick={reindex}>re-index vault</div>
    </div>
  );
}

// In-app text prompt (Electron doesn't support window.prompt).
function NamePrompt({ title, defaultValue, onSubmit, onClose }: {
  title: string; defaultValue: string; onSubmit: (name: string) => void; onClose: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    // select the base name (before the extension) for quick renaming
    const dot = defaultValue.lastIndexOf('.');
    ref.current?.setSelectionRange(0, dot > 0 ? dot : defaultValue.length);
  }, [defaultValue]);

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="name-prompt">
        <div className="np-title">{title}</div>
        <input
          ref={ref}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onSubmit(value);
            if (e.key === 'Escape') onClose();
          }}
          placeholder="untitled.md"
        />
        <div className="np-actions">
          <button className="ghost" onClick={onClose}>cancel</button>
          <button className="primary" onClick={() => onSubmit(value)}>create</button>
        </div>
      </div>
    </div>
  );
}
