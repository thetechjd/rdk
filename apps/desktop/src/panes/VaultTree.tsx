import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { FileState, IndexedDoc, VaultNode, VaultTree as VaultTreeData, VisibilityChoice } from '../../shared/ipc';
import { useApp } from '../store';

export type ExplorerLocation = 'public' | 'private' | 'local' | 'retrieved';

const LOCATIONS: Array<{
  id: ExplorerLocation;
  label: string;
  icon: string;
  description: string;
  dropVisibility?: VisibilityChoice;
}> = [
  { id: 'public', label: 'Public', icon: '◎', description: 'Published for anyone to retrieve', dropVisibility: 'public' },
  { id: 'private', label: 'Private', icon: '◆', description: 'Encrypted on the network', dropVisibility: 'private' },
  { id: 'local', label: 'Local', icon: '⌂', description: 'Only on this device' },
  { id: 'retrieved', label: 'Retrieved', icon: '⇣', description: 'Documents saved from queries' },
];

const virtualKey = (location: ExplorerLocation) => `location:${location}`;

export function VaultTree() {
  const app = useApp();
  const [tree, setTree] = useState<VaultTreeData | null>(null);
  const [indexedDocs, setIndexedDocs] = useState<IndexedDoc[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(
    new Set(LOCATIONS.map(location => virtualKey(location.id))),
  );
  const [dragOver, setDragOver] = useState(false);
  const [locationDragOver, setLocationDragOver] = useState<ExplorerLocation | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; node: VaultNode } | null>(null);
  const [naming, setNaming] = useState<{ parentRelPath: string } | null>(null);
  const [vaultMenu, setVaultMenu] = useState<{ x: number; y: number } | null>(null);
  const [indexing, setIndexing] = useState<{ paths: string[] } | null>(null);

  const [pinnedHashes, setPinnedHashes] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    window.rdk.getVaultTree().then(setTree);
    window.rdk.getIndexedDocuments().then(setIndexedDocs).catch(() => setIndexedDocs([]));
  }, []);
  useEffect(() => { load(); }, [load, app.dataVersion]);

  // Pin state lives on Central, not in the local store, so it is fetched
  // separately and refreshed whenever the data version bumps (i.e. after a pin).
  useEffect(() => {
    const hashes = [...new Set(indexedDocs.map(d => d.documentHash).filter((h): h is string => !!h))];
    if (hashes.length === 0) { setPinnedHashes(new Set()); return; }
    let alive = true;
    window.rdk.pinnedDocuments(hashes)
      .then(pinned => { if (alive) setPinnedHashes(new Set(pinned)); })
      .catch(() => { /* offline: leave pins unmarked rather than blanking the tree */ });
    return () => { alive = false; };
  }, [indexedDocs, app.dataVersion]);

  // Pinned is a CROSS-CUTTING view, not a fifth mutually-exclusive state: a
  // pinned document is still public or private and still lives in its own
  // folder. So this lists alongside those rather than partitioning with them.
  const pinnedDocs = indexedDocs.filter(d => d.documentHash && pinnedHashes.has(d.documentHash));

  // Documents the node has indexed that AREN'T files in the vault folder — the
  // private/public network content the on-disk tree can't show (a page indexed
  // from a URL, docs synced before the vault path changed, saved results).
  const networkDocs = indexedDocs.filter(d => !d.inVault && d.chunkIds.length > 0);

  const nodesByLocation = Object.fromEntries(
    LOCATIONS.map(location => [
      location.id,
      filterTreeForLocation(tree?.nodes ?? [], location.id),
    ]),
  ) as Record<ExplorerLocation, VaultNode[]>;
  const docsByLocation = Object.fromEntries(
    LOCATIONS.map(location => [
      location.id,
      networkDocs.filter(doc => locationForIndexedDoc(doc) === location.id),
    ]),
  ) as Record<ExplorerLocation, IndexedDoc[]>;

  const openDoc = useCallback((doc: IndexedDoc) => {
    app.selectChunk(doc.chunkIds[0]);
    app.openContentForChunk(doc.chunkIds[0], doc.title);
  }, [app]);

  // Footer counter = every document by state, matching what's actually listed:
  // on-disk vault files (tree.counts) PLUS the indexed docs that aren't files in
  // the folder (networkDocs). Without the latter, private/public content indexed
  // from a URL or a former vault path was invisible to the count even though it's
  // shown above. networkDocs are exactly the docs NOT in the tree, so adding them
  // to tree.counts can't double-count.
  const counts = (() => {
    const c = { local: 0, private: 0, public: 0, mixed: 0, ...(tree?.counts ?? {}) };
    for (const d of networkDocs) {
      if (d.state === 'private' || d.state === 'public' || d.state === 'mixed') c[d.state]++;
      else c.local++; // local-only indexed doc
    }
    return c;
  })();

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

  const pathsFromDrop = useCallback((e: React.DragEvent): string[] => {
    const internal = e.dataTransfer.getData('application/x-rdk-path');
    return internal
      ? [internal]
      : Array.from(e.dataTransfer.files)
          .map(file => window.rdkNative.pathForFile(file))
          .filter(Boolean);
  }, []);

  const onLocationDrop = useCallback(async (
    e: React.DragEvent,
    visibility?: VisibilityChoice,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setLocationDragOver(null);
    if (!visibility) return;
    const paths = pathsFromDrop(e);
    if (!paths.length) return;
    app.toast(`Indexing ${paths.length} item(s) as ${visibility}…`);
    const result = await window.rdk.indexPaths(paths, visibility);
    app.toast(
      result.error ? result.error : `Indexed ${result.indexed} chunk(s) — ${visibility}`,
      !!result.error,
    );
    app.refreshData();
    app.refreshStatus();
  }, [app, pathsFromDrop]);

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
        <div className="file-explorer" aria-label="Knowledge file explorer">
          {/* Pinned sits above the state folders and does not partition with
              them — a pinned document is still public or private and still
              appears in its own folder below. This is a shortcut to the
              documents you are paying rent to keep answerable. */}
          {pinnedDocs.length > 0 && (() => {
            const pinnedKey = 'location:pinned';
            const isOpen = expanded.has(pinnedKey);
            return (
              <section className="explorer-location pinned" key="pinned">
                <button
                  className="explorer-location-head"
                  onClick={() => toggle(pinnedKey)}
                  title="Kept available on the network even while this node is offline. Billed monthly per MB."
                  aria-expanded={isOpen}
                >
                  <span className="location-chevron">{isOpen ? '⌄' : '›'}</span>
                  <span className="location-icon">⚲</span>
                  <span className="location-label">Pinned</span>
                  <span className="location-count">{pinnedDocs.length}</span>
                </button>
                {isOpen && (
                  <div className="explorer-location-content">
                    {pinnedDocs.map(doc => (
                      <div
                        key={doc.key}
                        className={`indexed-row${doc.chunkIds[0] === app.selectedChunkId ? ' selected' : ''}`}
                        onClick={() => openDoc(doc)}
                        title={`${doc.title} — pinned (${doc.state}); available while this node is offline`}
                      >
                        <span className={`dot ${doc.state}`} />
                        <span className="name">{doc.title}</span>
                        <span className="pin-badge" aria-label="pinned">⚲</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })()}
          {LOCATIONS.map(location => {
            const locationKey = virtualKey(location.id);
            const isOpen = expanded.has(locationKey);
            const nodes = nodesByLocation[location.id];
            const docs = docsByLocation[location.id];
            const itemCount = countFiles(nodes) + docs.length;
            const acceptsDrop = !!location.dropVisibility;
            return (
              <section
                className={`explorer-location ${location.id}${locationDragOver === location.id ? ' drop-over' : ''}`}
                key={location.id}
                onDragOver={e => {
                  if (!acceptsDrop) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = 'copy';
                  setLocationDragOver(location.id);
                }}
                onDragLeave={e => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setLocationDragOver(null);
                }}
                onDrop={e => onLocationDrop(e, location.dropVisibility)}
              >
                <button
                  className="explorer-location-head"
                  onClick={() => {
                    if (!isOpen) toggle(locationKey);
                    app.openLocation(location.id, location.label);
                  }}
                  title={`${location.description}${acceptsDrop ? ` — drop files here to index as ${location.id}` : ''}`}
                  aria-expanded={isOpen}
                >
                  <span className="location-chevron">{isOpen ? '⌄' : '›'}</span>
                  <span className="location-icon">{location.icon}</span>
                  <span className="location-label">{location.label}</span>
                  {acceptsDrop && <span className="location-drop-hint">drop to index</span>}
                  <span className="location-count">{itemCount}</span>
                </button>
                {isOpen && (
                  <div className="explorer-location-content">
                    {nodes.map(node => (
                      <TreeRow key={node.path} node={node} depth={0} expanded={expanded} toggle={toggle}
                        onFileClick={onFileClick} selectedChunk={app.selectedChunkId} selectedFile={app.selectedFilePath}
                        pinnedHashes={pinnedHashes}
                        onContext={(x, y, item) => setMenu({ x, y, node: item })} />
                    ))}
                    {docs.map(doc => (
                      <div
                        key={doc.key}
                        className={`indexed-row${doc.chunkIds[0] === app.selectedChunkId ? ' selected' : ''}`}
                        onClick={() => openDoc(doc)}
                        title={`${doc.title} — ${doc.chunkCount} chunk${doc.chunkCount === 1 ? '' : 's'} (${doc.state})`}
                      >
                        <span className={`dot ${doc.state}`} />
                        <span className="name">{doc.title}</span>
                        {doc.documentHash && pinnedHashes.has(doc.documentHash) && (
                          <span className="pin-badge" title="Pinned — stays available while this node is offline">⚲</span>
                        )}
                        <span className="ct">{doc.chunkCount}</span>
                      </div>
                    ))}
                    {itemCount === 0 && (
                      <div className="explorer-empty">
                        {acceptsDrop ? `Drop files here to index as ${location.label.toLowerCase()}.` : 'No files here yet.'}
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        <div className={`dropzone${dragOver ? ' over' : ''}`}>
          {dragOver ? 'drop to index (choose private/public)' : 'drag files here to index — or drop from your file manager'}
        </div>
      </div>

      {/* Counts DOCUMENTS by state — vault files plus indexed network content,
          matching the lists above. This is a per-document tally, not chunk
          totals; the chunk count (matching `rdk status`) is in the status bar. */}
      <div className="tree-counts" title="Documents by state — vault files plus indexed network content. The chunk total (matching rdk status) is in the status bar.">
        <span className="c"><span className="dot private" /> private {counts.private}</span>
        <span className="c"><span className="dot public" /> public {counts.public}</span>
        <span className="c"><span className="dot local" /> local {counts.local}</span>
        {counts.mixed > 0 && (
          <span className="c"><span className="dot mixed" /> mixed {counts.mixed}</span>
        )}
        <span className="c muted">docs</span>
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

/** Retrieved is an origin, not a visibility. It gets its own location even when
 * the saved copy is currently local/private/public. */
export function isRetrievedPath(filePath?: string): boolean {
  return !!filePath && filePath
    .replace(/\\/g, '/')
    .split('/')
    .some(part => part.toLowerCase() === 'retrieved');
}

export function locationForState(state?: FileState): Exclude<ExplorerLocation, 'retrieved'> {
  if (state === 'public') return 'public';
  // A mixed document is not wholly public, so keep it in the conservative
  // Private location until the user resolves its visibility.
  if (state === 'private' || state === 'mixed') return 'private';
  return 'local';
}

export function locationForIndexedDoc(doc: IndexedDoc): ExplorerLocation {
  return isRetrievedPath(doc.sourcePath) ? 'retrieved' : locationForState(doc.state);
}

export function filterTreeForLocation(nodes: VaultNode[], location: ExplorerLocation): VaultNode[] {
  const filterNode = (node: VaultNode): VaultNode | null => {
    if (node.type === 'file') {
      const actual = isRetrievedPath(node.relPath)
        ? 'retrieved'
        : locationForState(node.state);
      return actual === location ? node : null;
    }
    const children = (node.children ?? [])
      .map(filterNode)
      .filter((child): child is VaultNode => child !== null);
    return children.length ? { ...node, children } : null;
  };
  const filtered = nodes.map(filterNode).filter((node): node is VaultNode => node !== null);
  // The physical vault/Retrieved directory is represented by the permanent
  // virtual root, so promote its children instead of showing a second,
  // easy-to-miss disclosure row named Retrieved underneath it.
  if (location === 'retrieved') {
    return filtered.flatMap(node =>
      node.type === 'folder' && node.relPath.toLowerCase() === 'retrieved'
        ? (node.children ?? [])
        : [node]);
  }
  return filtered;
}

function countFiles(nodes: VaultNode[]): number {
  return nodes.reduce(
    (total, node) => total + (node.type === 'file' ? 1 : countFiles(node.children ?? [])),
    0,
  );
}

function TreeRow({ node, depth, expanded, toggle, onFileClick, selectedChunk, selectedFile, pinnedHashes, onContext }: {
  node: VaultNode; depth: number; expanded: Set<string>; toggle: (p: string) => void;
  onFileClick: (n: VaultNode) => void; selectedChunk: string | null; selectedFile: string | null;
  pinnedHashes: Set<string>;
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
            onFileClick={onFileClick} selectedChunk={selectedChunk} selectedFile={selectedFile}
            pinnedHashes={pinnedHashes} onContext={onContext} />
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
      {node.documentHash && pinnedHashes.has(node.documentHash) && (
        <span className="pin-badge" title="Pinned — stays available while this node is offline">⚲</span>
      )}
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
  const chunkIds = node.chunkIds ?? [];

  // File-level actions act on ALL of the file's chunks (previously only chunkIds[0],
  // which silently left a multi-chunk file half-published / half-deleted).
  const publishAll = async () => {
    for (const id of chunkIds) {
      const r = await window.rdk.publishChunk(id);
      if (!r.ok) return r;
    }
    return { ok: true };
  };
  const deleteAll = async () => {
    for (const id of chunkIds) {
      const r = await window.rdk.deleteChunk(id);
      if (!r.ok) return r;
    }
    return { ok: true };
  };

  return (
    <div className="ctx-menu" ref={ref} style={{ left: x, top: y }}>
      <div className="ctx-item" onClick={() => run(() => window.rdk.indexPaths([node.path], 'private'), 'Indexed — private')}>index as <span className="state-private">private</span></div>
      <div className="ctx-item" onClick={() => run(() => window.rdk.indexPaths([node.path], 'public'), 'Indexed — public')}>index as <span className="state-public">public</span></div>
      {indexed && !isPublic && chunkIds.length > 0 && (
        <div className="ctx-item" onClick={() => run(publishAll, `Published (${chunkIds.length} chunk${chunkIds.length > 1 ? 's' : ''})`)}>publish</div>
      )}
      <div className="ctx-sep" />
      <div className="ctx-item" onClick={() => { onClose(); window.rdk.revealInFileManager(node.path); }}>reveal in file manager</div>
      {indexed && chunkIds.length > 0 && (
        <div className="ctx-item danger" onClick={() => run(deleteAll, 'Deleted from index')}>delete from index</div>
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
