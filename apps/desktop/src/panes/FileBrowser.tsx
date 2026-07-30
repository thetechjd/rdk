import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import type { IndexedDoc, VaultNode, VisibilityChoice } from '../../shared/ipc';
import { useApp } from '../store';
import {
  filterTreeForLocation,
  locationForIndexedDoc,
  type ExplorerLocation,
} from './VaultTree';

interface BrowserLevel {
  name: string;
  nodes: VaultNode[];
}

export function FileBrowser({ location, title }: {
  location: ExplorerLocation;
  title: string;
}) {
  const app = useApp();
  const [rootNodes, setRootNodes] = useState<VaultNode[]>([]);
  const [docs, setDocs] = useState<IndexedDoc[]>([]);
  const [levels, setLevels] = useState<BrowserLevel[]>([]);
  const [dropOver, setDropOver] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([window.rdk.getVaultTree(), window.rdk.getIndexedDocuments()])
      .then(([tree, indexed]) => {
        if (!alive) return;
        const roots = filterTreeForLocation(tree.nodes, location);
        setRootNodes(roots);
        setDocs(indexed.filter(doc => !doc.inVault && locationForIndexedDoc(doc) === location));
        setLevels([]);
      });
    return () => { alive = false; };
  }, [location, app.dataVersion]);

  const currentNodes = levels.at(-1)?.nodes ?? rootNodes;
  const visibility: VisibilityChoice | undefined =
    location === 'public' || location === 'private' ? location : undefined;

  const openFile = useCallback((node: VaultNode) => {
    if (node.chunkIds?.length) {
      app.selectChunk(node.chunkIds[0]);
      app.openContentForChunk(node.chunkIds[0], node.name);
    } else {
      app.selectChunk(null);
      app.selectFile(node.path);
      app.openContentForFile(node.path, node.name);
    }
  }, [app]);

  const dropPaths = useCallback(async (event: DragEvent) => {
    event.preventDefault();
    setDropOver(false);
    if (!visibility) return;
    const internal = event.dataTransfer.getData('application/x-rdk-path');
    const paths = internal
      ? [internal]
      : Array.from(event.dataTransfer.files)
          .map(file => window.rdkNative.pathForFile(file))
          .filter(Boolean);
    if (!paths.length) return;
    app.toast(`Indexing ${paths.length} item(s) as ${visibility}…`);
    const result = await window.rdk.indexPaths(paths, visibility);
    app.toast(
      result.error ? result.error : `Indexed ${result.indexed} chunk(s) — ${visibility}`,
      !!result.error,
    );
    app.refreshData();
    app.refreshStatus();
  }, [app, visibility]);

  const count = useMemo(
    () => currentNodes.length + (levels.length === 0 ? docs.length : 0),
    [currentNodes, docs, levels],
  );

  return (
    <div
      className={`file-browser ${location}${dropOver ? ' drop-over' : ''}`}
      onDragOver={event => {
        if (!visibility) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropOver(true);
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropOver(false);
      }}
      onDrop={dropPaths}
    >
      <div className="browser-toolbar">
        <button
          className="browser-back"
          disabled={levels.length === 0}
          onClick={() => setLevels(previous => previous.slice(0, -1))}
          title="Back"
        >‹</button>
        <div className="browser-breadcrumbs">
          <button onClick={() => setLevels([])}>{title}</button>
          {levels.map((level, index) => (
            <span key={`${level.name}:${index}`}>
              <span className="browser-separator">›</span>
              <button onClick={() => setLevels(previous => previous.slice(0, index + 1))}>
                {level.name}
              </button>
            </span>
          ))}
        </div>
        <span className="browser-item-count">{count} item{count === 1 ? '' : 's'}</span>
      </div>

      <div className="browser-grid">
        {currentNodes.map(node => node.type === 'folder' ? (
          <button
            key={node.path}
            className="browser-item folder"
            onClick={() => setLevels(previous => [
              ...previous,
              { name: node.name, nodes: node.children ?? [] },
            ])}
            title={`Open ${node.name}`}
          >
            <span className="folder-sprite" aria-hidden="true"><span /></span>
            <span className="browser-item-name">{node.name}</span>
          </button>
        ) : (
          <button key={node.path} className="browser-item file" onClick={() => openFile(node)}>
            <span className="file-sprite" aria-hidden="true"><span /></span>
            <span className="browser-item-name">{node.name}</span>
            <span className={`dot ${node.state}`} />
          </button>
        ))}
        {levels.length === 0 && docs.map(doc => (
          <button
            key={doc.key}
            className="browser-item file"
            onClick={() => {
              app.selectChunk(doc.chunkIds[0]);
              app.openContentForChunk(doc.chunkIds[0], doc.title);
            }}
          >
            <span className="file-sprite" aria-hidden="true"><span /></span>
            <span className="browser-item-name">{doc.title}</span>
            <span className={`dot ${doc.state}`} />
          </button>
        ))}
        {count === 0 && (
          <div className="browser-empty">
            <span className="folder-sprite large" aria-hidden="true"><span /></span>
            <b>{title} is empty</b>
            <span>{visibility ? `Drop files here to index them as ${visibility}.` : 'Nothing has been saved here yet.'}</span>
          </div>
        )}
      </div>
      {dropOver && visibility && <div className="browser-drop-label">Index as {visibility}</div>}
    </div>
  );
}
