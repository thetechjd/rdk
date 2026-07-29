// electron/node-service.ts
//
// THE SEAM. Every IPC handler goes through this class; the React UI never sees
// @rdk/core, @retrodeck/mcp, SQLite, or HTTP directly. Today it calls @rdk/core
// primitives (index/query/graph — real, pure-core) and reaches @retrodeck/mcp /
// RetroDeck HTTP for network/serve/account (the "spike"). When @rdk/node is
// extracted, only the bodies here change — the RdkApi contract stays fixed.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import {
  LocalStore,
  RDKRouter,
  RDKIndexer,
  LocalEmbeddingModel,
  cosineSimilarity,
  keyFromHex,
  decrypt,
  fileState as computeFileState,
  type VaultKey,
  type StoredChunk,
  type EmbeddingModel,
  type NetworkChunk,
  type RetrievedDocument,
} from '@rdk/core';
import {
  loadConfigOrNull,
  loadConfig,
  saveConfig,
  updateConfig,
  configExists,
  rdkDir,
  type RDKConfig,
} from '@rdk/node/config';
import { SyncService } from '@rdk/node/sync-service';
import { startWsOwnership, type WsOwnership } from '@rdk/node/ws/ownership';
import { ensureServableNode } from '@rdk/node/register-node';
import { wsConnectionHeldByOther } from '@rdk/node/ws/ws-lock';
// RetroDeck API — account/plans/balance/top-up/subscription. A different service
// (and token) from RDK Central; see the note above getAccount().
import * as retrodeck from '@rdk/node/retrodeck-client';
import { shell } from 'electron';
import {
  autoStartSupported,
  serviceInstallSupported,
} from './platform';
import type {
  Account, BillingInterval, ChunkView, ContentView, EarningsSummary, FileState, GraphData,
  GraphEdge, GraphNode, IndexedDoc, LoginOutcome, McpInfo, NodeStatus, Plan, PlatformCapabilities,
  Preferences, QueryDocument, QueryResponse, RetrievedFor, VaultNode, VaultTree, VisibilityChoice,
} from '../shared/ipc';

const IGNORE_DIRS = new Set(['.git', '.obsidian', 'node_modules', '.trash', '.rdk']);
const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.mdx']);
/** Semantic-edge threshold + fan-out cap, to keep the graph legible. */
const SEMANTIC_MIN_SIM = 0.55;
const SEMANTIC_MAX_EDGES_PER_NODE = 4;

/** A retrieved document's body without provenance frontmatter — what we index. */
function documentBody(doc: RetrievedDocument): string {
  const out = [`# ${doc.name}`, ''];
  for (const s of doc.sections) {
    if (s.heading && s.heading !== doc.name) out.push(`## ${s.heading}`, '');
    out.push(s.content.trim(), '');
  }
  return out.join('\n');
}

export class NodeService {
  private store: LocalStore | null = null;
  private config: RDKConfig | null = null;
  private embedder: EmbeddingModel = new LocalEmbeddingModel();
  private embedderReady: boolean | null = null;
  private router: RDKRouter | null = null;
  private serving = false;
  /** Background sync loop (from @rdk/node) — runs while the node is "serving". */
  private syncService: SyncService | null = null;
  /** The Central WebSocket. Syncing embeddings is not enough to be "serving":
   *  content stays on this machine, so Central can only answer a query with our
   *  chunks while this socket is up. Without it our content is silently skipped
   *  and our own documents come back unfindable. */
  private wsOwnership: WsOwnership | null = null;

  // ── lifecycle / lazy wiring ────────────────────────────────────────────────

  private getStore(): LocalStore {
    if (!this.store) this.store = new LocalStore();
    return this.store;
  }

  private getConfig(): RDKConfig | null {
    if (this.config === null && configExists()) this.config = loadConfigOrNull();
    return this.config;
  }

  private vaultKey(): VaultKey | undefined {
    const cfg = this.getConfig();
    return cfg?.vaultKeyHex ? keyFromHex(cfg.vaultKeyHex) : undefined;
  }

  private async embedderAvailable(): Promise<boolean> {
    // Only ever CACHE a positive result. A transient false — e.g. the graph view
    // probes this on a cold `pnpm dev` start before the @xenova module graph is
    // resolved — must not stick for the whole process lifetime, or indexing stays
    // dead-gated until a manual restart. Re-check on every miss instead.
    if (this.embedderReady === true) return true;
    this.embedderReady = await LocalEmbeddingModel.isAvailable();
    return this.embedderReady;
  }

  private getRouter(): RDKRouter {
    if (!this.router) {
      const cfg = this.getConfig();
      // sharedVaultKeys: team-encrypted network content decrypts with the owning
      // node's shared key (parity with the CLI/node-controller construction).
      const sharedVaultKeys = Object.fromEntries(
        Object.entries(cfg?.sharedVaultKeys ?? {}).map(([nodeId, hex]) => [nodeId, keyFromHex(hex)]),
      );
      this.router = new RDKRouter({
        localStore: this.getStore(),
        embeddingModel: this.embedder,
        centralApiUrl: cfg?.centralApiUrl,
        centralApiKey: cfg?.apiKey,
        nodeId: cfg?.nodeId, // lets the router skip tipping the user's own chunks
        domain: cfg?.domain,
        vaultKey: this.vaultKey(),
        sharedVaultKeys,
      });
    }
    return this.router;
  }

  private getIndexer(): RDKIndexer {
    const cfg = this.getConfig();
    return new RDKIndexer({
      embeddingModel: this.embedder,
      localStore: this.getStore(),
      domain: cfg?.domain ?? 'general',
      // Private chunks sync encrypted metadata/embeddings just like the CLI.
      // Desktop visibility choices are both network states; local-only content
      // is created through the separate local indexing path.
      syncToNetwork: !!cfg?.centralApiUrl && !!cfg?.apiKey,
      centralApiUrl: cfg?.centralApiUrl,
      centralApiKey: cfg?.apiKey,
      vaultKey: this.vaultKey(),
    });
  }

  // ── setup / capabilities ────────────────────────────────────────────────────

  isInitialized(): boolean {
    return configExists();
  }

  getCapabilities(): PlatformCapabilities {
    const cfg = this.getConfig();
    return {
      platform: process.platform,
      serviceInstall: serviceInstallSupported(),
      autoStart: autoStartSupported(),
      network: !!cfg?.centralApiUrl && !!cfg?.apiKey,
      unpublishSupported: true, // unpublish = retire: stop serving from now on (versioned model)
      pinSupported: false,       // no pin concept exists in core/central yet
    };
  }

  async initNode(opts: { email?: string; vaultPath: string; visibility: VisibilityChoice; autoStart: boolean }): Promise<void> {
    // Spike onboarding: create a minimal local-only config if none exists. Real
    // account registration (browser handoff → Central) is wired via signIn().
    const existing = loadConfigOrNull();
    const cfg: RDKConfig = existing ?? {
      nodeId: `local-${Math.abs(hashString(opts.vaultPath + (opts.email ?? '')))}`,
      apiKey: '',
      centralApiUrl: process.env.RDK_API_URL ?? 'https://api.rdk.network',
      plan: 'free',
      vaultAdapter: 'obsidian',
      vaultPath: opts.vaultPath,
      domain: 'general',
      walletChain: 'base',
      mcpPort: 4242,
      createdAt: new Date().toISOString(),
      autoSync: true,
      syncIntervalMinutes: 5,
    };
    cfg.vaultPath = opts.vaultPath;
    saveConfig(cfg);
    this.config = loadConfig();
  }

  // ── vault tree ────────────────────────────────────────────────────────────

  getVaultTree(): VaultTree {
    const cfg = this.getConfig();
    const root = cfg?.vaultPath ?? '';
    const chunksByPath = this.chunksBySourcePath();
    const chunksBySourceBase = this.chunksBySourceBaseName();
    const orphansByName = this.orphanChunksByDocName();
    const publicFolders = cfg?.publicFolders ?? [];
    const counts = { local: 0, private: 0, public: 0, mixed: 0 };

    const walk = (dir: string): VaultNode[] => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const out: VaultNode[] = [];
      for (const e of entries) {
        if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
        const abs = path.join(dir, e.name);
        const relPath = toPosix(path.relative(root, abs));
        if (e.isDirectory()) {
          const children = walk(abs);
          if (children.length > 0) out.push({ name: e.name, path: abs, relPath, type: 'folder', children });
        } else if (TEXT_EXTS.has(path.extname(e.name).toLowerCase())) {
          // Resolve this file's chunks, most-specific match first:
          //  1. exact sourcePath (absolute, then vault-relative)
          //  2. sourcePath BASENAME — catches chunks whose stored sourcePath is a
          //     different-but-equivalent path (indexed from another machine/vault
          //     root, or a normalization mismatch). Without this, an indexed file
          //     like "Welcome to RDK.md" falls through and is mislabeled unindexed.
          //  3. doc-name of chunks stored WITHOUT any sourcePath (older adapters).
          const fileBaseFull = e.name.toLowerCase();                                   // "welcome to rdk.md"
          const baseName = path.basename(e.name, path.extname(e.name)).toLowerCase();  // "welcome to rdk"
          const chunks =
            chunksByPath.get(abs)
            ?? chunksByPath.get(relPath)
            ?? chunksBySourceBase.get(fileBaseFull)
            ?? orphansByName.get(baseName)
            ?? [];
          const state = fileState(chunks, relPath, publicFolders);
          counts[state]++;
          out.push({
            name: e.name, path: abs, relPath, type: 'file', state,
            chunkIds: chunks.map(c => c.id),
          });
        }
      }
      // folders first, then files, each alphabetical
      return out.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1);
    };

    const nodes = root && fs.existsSync(root) ? walk(root) : [];
    return { root, vaultName: root ? path.basename(root) : 'No vault', nodes, counts };
  }

  /**
   * Every document this node has indexed, grouped from its LIVE chunks — private
   * (encrypted on the network), public (plaintext, earning), and local-only
   * alike. Unlike getVaultTree (which walks on-disk files), this reads the store
   * directly, so content indexed from a URL or another machine (e.g. a Wikipedia
   * page, or docs synced before the vault folder changed) is visible in the
   * desktop instead of being hidden because there's no matching file on disk.
   */
  getIndexedDocuments(): IndexedDoc[] {
    const cfg = this.getConfig();
    const root = cfg?.vaultPath ? toPosix(cfg.vaultPath).replace(/\/+$/, '') : '';

    const byDoc = new Map<string, StoredChunk[]>();
    for (const c of this.getStore().getAllChunks()) {
      if (c.supersededAt) continue; // live versions only — matches the counts
      const key = (c.sourcePath && c.sourcePath.trim())
        || c.docTitle
        || c.id;
      const arr = byDoc.get(key) ?? [];
      arr.push(c);
      byDoc.set(key, arr);
    }

    const docs: IndexedDoc[] = [];
    for (const [key, chunks] of byDoc) {
      const sourcePath = chunks.find(c => c.sourcePath)?.sourcePath;
      const inVault = !!sourcePath && !!root && toPosix(sourcePath).startsWith(root + '/');
      docs.push({
        key,
        // The document's own title (its H1 / frontmatter). rowToChunk falls back
        // to the legacy ' — ' split for rows indexed before doc_title existed.
        title: chunks[0].docTitle || key,
        sourcePath,
        state: computeFileState(chunks),
        chunkCount: chunks.length,
        chunkIds: chunks.map(c => c.id),
        inVault,
      });
    }
    // Network/indexed-only docs first (the ones the tree can't show), then A–Z.
    return docs.sort((a, b) =>
      (Number(a.inVault) - Number(b.inVault)) || a.title.localeCompare(b.title));
  }

  private chunksBySourcePath(): Map<string, StoredChunk[]> {
    const map = new Map<string, StoredChunk[]>();
    for (const c of this.getStore().getAllChunks()) {
      if (!c.sourcePath) continue;
      if (c.supersededAt) continue; // old versions never drive the tree
      const arr = map.get(c.sourcePath) ?? [];
      arr.push(c);
      map.set(c.sourcePath, arr);
    }
    return map;
  }

  /**
   * Fallback index keyed by the BASENAME of a chunk's sourcePath (lowercased,
   * with extension). Links a file to its chunks when the stored sourcePath is a
   * valid-but-non-matching path (indexed from a different machine or vault root,
   * or a path-normalization mismatch) so it isn't mislabeled unindexed. Only
   * unambiguous basenames are kept — if two indexed files share a basename the
   * key is dropped, falling back to the exact-path match.
   */
  private chunksBySourceBaseName(): Map<string, StoredChunk[]> {
    const bySource = new Map<string, StoredChunk[]>(); // sourcePath → chunks
    for (const c of this.getStore().getAllChunks()) {
      if (!c.sourcePath || c.supersededAt) continue;
      const arr = bySource.get(c.sourcePath) ?? [];
      arr.push(c);
      bySource.set(c.sourcePath, arr);
    }
    const byBase = new Map<string, StoredChunk[]>();
    const ambiguous = new Set<string>();
    for (const [sourcePath, chunks] of bySource) {
      const base = path.basename(sourcePath).toLowerCase();
      if (byBase.has(base)) { ambiguous.add(base); continue; }
      byBase.set(base, chunks);
    }
    for (const base of ambiguous) byBase.delete(base);
    return byBase;
  }

  /**
   * Fallback index for chunks stored WITHOUT a sourcePath (an older adapter bug orphaned
   * them from their files). Keyed by the document name — the chunk title up to the first
   * " — " section separator, lowercased — which equals the source note's base file name.
   * Lets getVaultTree still link these to their on-disk file so private content displays
   * decrypted instead of the file falling back to a raw, "local" read.
   *
   * Deliberately still splits the title rather than using `docTitle`: these are
   * legacy rows whose title prefix IS the file stem, and this map matches against
   * on-disk file names. A doc title is the H1 — the wrong key for that job.
   */
  private orphanChunksByDocName(): Map<string, StoredChunk[]> {
    const map = new Map<string, StoredChunk[]>();
    for (const c of this.getStore().getAllChunks()) {
      if (c.sourcePath) continue;
      if (c.supersededAt) continue; // old versions never drive the tree
      const docName = c.title.split(' — ')[0].trim().toLowerCase();
      if (!docName) continue;
      const arr = map.get(docName) ?? [];
      arr.push(c);
      map.set(docName, arr);
    }
    return map;
  }

  async indexPaths(
    paths: string[],
    visibility: VisibilityChoice,
    versionCtx?: { supersedes?: string; version?: number },
  ): Promise<{ indexed: number; error?: string }> {
    if (!(await this.embedderAvailable())) {
      return { indexed: 0, error: 'Embedding model unavailable — the embedding runtime failed to load. This is usually a module/native-load error, not a network problem; check the terminal running the app for the underlying cause, then try again.' };
    }
    const indexer = this.getIndexer();
    const files = this.expandToFiles(paths);
    let indexed = 0;
    const errors: string[] = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const res = await indexer.indexDocument({
          content,
          title: path.basename(file, path.extname(file)),
          sourcePath: file,
          sourceAdapter: 'desktop',
          isPublic: visibility === 'public',
          supersedes: versionCtx?.supersedes,
          version: versionCtx?.version,
        });
        indexed += res.chunksIndexed;
        errors.push(...res.errors);
      } catch (e) {
        errors.push(`${path.basename(file)}: ${(e as Error).message}`);
      }
    }
    return { indexed, error: errors.length ? errors.slice(0, 3).join('; ') : undefined };
  }

  /** On-demand central client for delete/retire/supersede calls outside the
   *  serving sync loop (SyncService without a timer). Null when unlinked. */
  private centralClient(): SyncService | null {
    const cfg = this.getConfig();
    if (!cfg?.centralApiUrl || !cfg?.apiKey) return null;
    if (this.syncService) return this.syncService;
    return new SyncService(
      {
        enabled: false,
        intervalMinutes: 0,
        centralApiUrl: cfg.centralApiUrl,
        centralApiKey: cfg.apiKey,
        log: (m) => console.error(m),
      },
      this.getStore(),
    );
  }

  private expandToFiles(paths: string[]): string[] {
    const out: string[] = [];
    const visit = (p: string) => {
      let st: fs.Stats;
      try { st = fs.statSync(p); } catch { return; }
      if (st.isDirectory()) {
        if (IGNORE_DIRS.has(path.basename(p))) return;
        for (const name of fs.readdirSync(p)) {
          if (name.startsWith('.')) continue;
          visit(path.join(p, name));
        }
      } else if (TEXT_EXTS.has(path.extname(p).toLowerCase())) {
        out.push(p);
      }
    };
    paths.forEach(visit);
    return out;
  }

  setFolderPublic(relPath: string, isPublic: boolean): void {
    const cfg = this.getConfig();
    if (!cfg) return;
    const set = new Set(cfg.publicFolders ?? []);
    if (isPublic) set.add(relPath); else set.delete(relPath);
    updateConfig({ publicFolders: [...set] });
    this.config = loadConfigOrNull();
  }

  // ── chunk views / content ───────────────────────────────────────────────────

  getChunk(id: string): ChunkView | null {
    const c = this.getStore().getChunk(id);
    return c ? this.toChunkView(c) : null;
  }

  /** Live chunks belonging to the same source document as `c` (including `c`).
   *  Chunks indexed without a sourcePath can't be grouped, so they count as one. */
  private liveChunkCountForDocument(c: StoredChunk): number {
    if (!c.sourcePath) return 1;
    return this.getStore()
      .getVersions(c.sourcePath, c.sourceAdapter)
      .filter(sibling => !sibling.supersededAt).length || 1;
  }

  private toChunkView(c: StoredChunk): ChunkView {
    const retrievals = this.getStore().getRetrievalCounts()[c.id] ?? 0;
    return {
      id: c.id,
      title: c.title,
      docTitle: c.docTitle,
      state: c.isPublic ? 'public' : c.isLocalOnly ? 'local' : 'private',
      docChunkCount: this.liveChunkCountForDocument(c),
      domain: c.domain,
      categories: c.categories,
      sourcePath: c.sourcePath,
      isEncrypted: c.isEncrypted,
      syncedAt: c.syncedAt?.toISOString(),
      qualityScore: c.qualityScore,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      sizeTokens: Math.round(c.content.length / 4),
      retrievals,
      earnedUsdc: 0, // provider-side earnings live on Central; surfaced via getEarnings()
    };
  }

  readContent(id: string): ContentView | null {
    const c = this.getStore().getChunk(id);
    if (!c) return null;
    let body = c.content;
    let decrypted = false;
    if (c.isEncrypted) {
      const key = this.vaultKey();
      if (key) {
        try { body = decrypt(c.content, key); decrypted = true; }
        catch { body = '[encrypted — vault key could not decrypt this chunk]'; }
      } else {
        body = '[encrypted — no vault key available]';
      }
    }
    return {
      id: c.id, title: c.title, state: c.isPublic ? 'public' : 'private',
      format: 'markdown', body, decrypted, sourcePath: c.sourcePath,
    };
  }

  readFile(filePath: string): ContentView | null {
    try {
      const body = fs.readFileSync(filePath, 'utf-8');
      const ext = path.extname(filePath).toLowerCase();
      return {
        id: filePath, title: path.basename(filePath), state: 'local',
        format: ext === '.md' || ext === '.markdown' || ext === '.mdx' ? 'markdown' : 'text',
        body, decrypted: false, sourcePath: filePath,
      };
    } catch {
      return null;
    }
  }

  /**
   * Write a vault file to disk (files are the source of truth). If the file was
   * previously indexed privately, its stale private chunks are dropped and it's
   * re-indexed so private chunks + the graph track what was written. Public chunks
   * are immutable and left as-is. Refuses to write outside the vault.
   */
  async writeFile(filePath: string, content: string): Promise<{ ok: boolean; error?: string; reindexed?: number }> {
    const root = this.getConfig()?.vaultPath;
    const abs = path.resolve(filePath);
    if (!root || !isWithinVault(root, abs)) {
      return { ok: false, error: 'Refusing to write outside the vault.' };
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf-8');
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    // Versioned re-index: an edit mints NEW chunks (ids are content hashes).
    //  - old PRIVATE chunks: deleted locally AND on central (fixes the orphaned
    //    central rows the old flow left behind);
    //  - old PUBLIC chunks: superseded locally + RETIRED on central (frozen,
    //    excluded from queries, earnings history intact), and the new version
    //    re-publishes automatically — the user already expressed publish intent
    //    for this document.
    const store = this.getStore();
    const existing = store.getAllChunks().filter(c => c.sourcePath === abs && !c.supersededAt);
    const stalePrivate = existing.filter(c => !c.isPublic);
    const stalePublic = existing.filter(c => c.isPublic);
    let reindexed = 0;
    if (existing.length > 0 && (await this.embedderAvailable())) {
      const central = this.centralClient();
      for (const c of stalePrivate) {
        store.deleteChunk(c.id);
        if (!c.isLocalOnly) void central?.deleteOnCentral(c.id); // best-effort cleanup
      }
      for (const c of stalePublic) {
        store.markSuperseded(c.id);
        void central?.deleteOnCentral(c.id); // public rows retire server-side
      }
      const nextVersion = Math.max(...existing.map(c => c.version ?? 1)) + 1;
      const visibility: VisibilityChoice = stalePublic.length > 0 ? 'public' : 'private';
      // `supersedes` is a chunk-to-chunk pointer, so it's only meaningful when
      // the old version was a single chunk: an edit re-splits the document and
      // there's no honest 1:1 mapping between old and new chunks. Pointing every
      // new chunk at one arbitrary old chunk recorded a lineage that isn't real —
      // for multi-chunk documents, `sourcePath` + `version` carry the history.
      const priorChunk = existing.length === 1 ? existing[0].id : undefined;
      reindexed = (await this.indexPaths([abs], visibility, {
        supersedes: priorChunk,
        version: nextVersion,
      })).indexed;
    }
    return { ok: true, reindexed };
  }

  /** Create a new note in the vault. Returns its absolute path. */
  createFile(parentRelPath: string, name: string): { ok: boolean; path?: string; error?: string } {
    const root = this.getConfig()?.vaultPath;
    if (!root) return { ok: false, error: 'No vault configured.' };
    let base = (name || '').trim().replace(/[/\\:*?"<>|]/g, '-');
    if (!base) return { ok: false, error: 'Please provide a name.' };
    if (!/\.(md|markdown|txt|mdx)$/i.test(base)) base += '.md';
    const dir = path.resolve(root, parentRelPath || '');
    if (!isWithinVault(root, dir)) return { ok: false, error: 'Invalid location.' };
    const target = path.join(dir, base);
    if (fs.existsSync(target)) return { ok: false, error: 'A note with that name already exists here.' };
    try {
      fs.mkdirSync(dir, { recursive: true });
      const title = base.replace(/\.(md|markdown|txt|mdx)$/i, '');
      fs.writeFileSync(target, `# ${title}\n\n`, 'utf-8');
      return { ok: true, path: target };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  getRetrievedFor(id: string): RetrievedFor[] {
    return this.getStore().getRetrievalsForChunk(id).map(r => ({
      queryText: r.queryText, count: r.count, lastAt: r.lastAt.toISOString(), bestScore: r.bestScore,
    }));
  }

  deleteChunk(id: string): { ok: boolean } {
    this.getStore().deleteChunk(id);
    return { ok: true };
  }

  /** Promote a private chunk to public: decrypt locally, store as plaintext public,
   *  queue for sync. (Spike of ws/handlers/promote-public.ts.) */
  async publishChunk(id: string): Promise<{ ok: boolean; error?: string }> {
    const store = this.getStore();
    const c = store.getChunk(id);
    if (!c) return { ok: false, error: 'Chunk not found.' };
    if (c.isPublic) return { ok: true };
    let content = c.content;
    if (c.isEncrypted) {
      const key = this.vaultKey();
      if (!key) return { ok: false, error: 'No vault key available to decrypt before publishing.' };
      try { content = decrypt(c.content, key); }
      catch { return { ok: false, error: 'Could not decrypt chunk for publishing.' }; }
    }
    const embedding = store.getEmbedding(id);
    if (!embedding) return { ok: false, error: 'Missing embedding for chunk.' };
    store.saveChunk(
      {
        ...c,
        content,
        isPublic: true,
        isEncrypted: false,
        // Publishing IS the statement "this should reach the network", so it
        // has to clear local-only. Spreading `...c` alone kept local_only set
        // on anything saved from a query, and getUnsyncedChunks() skips those —
        // so publishing an improved retrieved document flipped it public
        // locally and never synced, with nothing reporting a problem. Same
        // silent failure as the synced_at bug, one field over.
        isLocalOnly: false,
        syncedAt: undefined,
      },
      embedding,
    );
    return this.forceSync();
  }

  /**
   * Unpublish = RETIRE: the chunk stops being served in queries from now on.
   * Locally it's frozen (superseded, out of search); on central the row is
   * retired (kept for earnings attribution, excluded from results). Honest
   * caveat: copies other nodes already saved are beyond recall — per-version
   * immutability is the real network boundary.
   */
  unpublishChunk(id: string): { ok: boolean; error?: string } {
    const store = this.getStore();
    const c = store.getChunk(id);
    if (!c) return { ok: false, error: 'Chunk not found.' };
    if (!c.isPublic) return { ok: true };
    store.markSuperseded(id);
    void this.centralClient()?.deleteOnCentral(id); // retires server-side (best-effort)
    return { ok: true };
  }

  /** Version history of a document series (live + superseded), newest first.
   *  One row per version — the store rolls the version's chunks up. */
  getVersions(sourcePath: string): import('../shared/ipc').VersionView[] {
    return this.getStore().getDocumentVersions(sourcePath).map((v) => ({
      version: v.version,
      chunkCount: v.chunkCount,
      chunkId: v.chunkIds[0],
      state: v.state,
      superseded: v.superseded,
      createdAt: v.createdAt.toISOString(),
    }));
  }

  // No pin concept exists in core/central yet (report §7).
  pinChunk(): { ok: boolean; error?: string } {
    return { ok: false, error: 'Pinning is not supported yet.' };
  }

  async reindex(): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.getConfig();
    if (!cfg?.vaultPath) return { ok: false, error: 'No vault configured.' };
    // Honors the persisted default-visibility preference (was hard-coded private).
    const visibility: VisibilityChoice = cfg.defaultVisibility === 'public' ? 'public' : 'private';
    const res = await this.indexPaths([cfg.vaultPath], visibility);
    return { ok: !res.error, error: res.error };
  }

  // ── graph ───────────────────────────────────────────────────────────────────

  getGraphData(): GraphData {
    const store = this.getStore();
    const chunks = store.getAllChunks();
    const retrievalCounts = store.getRetrievalCounts();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    for (const c of chunks) {
      if (c.supersededAt) continue; // old versions stay out of the live graph
      nodes.push({
        id: c.id,
        kind: 'file',
        label: c.title,
        state: c.isPublic ? 'public' : c.isLocalOnly ? 'local' : 'private',
        retrievals: retrievalCounts[c.id] ?? 0,
        sourcePath: c.sourcePath,
      });
    }

    // Semantic edges: pairwise cosine over stored embeddings, capped per node.
    const embs = store.getAllEmbeddings();
    for (let i = 0; i < embs.length; i++) {
      const sims: { j: number; sim: number }[] = [];
      for (let j = 0; j < embs.length; j++) {
        if (i === j) continue;
        const sim = cosineSimilarity(embs[i].embedding, embs[j].embedding);
        if (sim >= SEMANTIC_MIN_SIM) sims.push({ j, sim });
      }
      sims.sort((a, b) => b.sim - a.sim);
      for (const { j, sim } of sims.slice(0, SEMANTIC_MAX_EDGES_PER_NODE)) {
        if (i < j) edges.push({ source: embs[i].chunkId, target: embs[j].chunkId, kind: 'semantic', weight: sim });
      }
    }

    // Query nodes + retrieval edges from the local query log.
    const retrievalEdges = store.getRetrievalEdges();
    const chunkIds = new Set(chunks.map(c => c.id));
    const seenQueries = new Map<string, string>(); // queryId → node id
    for (const e of retrievalEdges) {
      if (!chunkIds.has(e.chunkId)) continue; // network-only chunk, not in local graph
      let qNodeId = seenQueries.get(e.queryId);
      if (!qNodeId) {
        qNodeId = `q:${e.queryId}`;
        seenQueries.set(e.queryId, qNodeId);
        nodes.push({ id: qNodeId, kind: 'query', label: e.queryText || '(query)', retrievals: 0 });
      }
      edges.push({ source: qNodeId, target: e.chunkId, kind: 'retrieval', weight: e.score });
    }

    return { nodes, edges };
  }

  // ── query ─────────────────────────────────────────────────────────────────

  async query(q: string): Promise<QueryResponse> {
    if (!(await this.embedderAvailable())) {
      return { query: q, source: 'llm_fallback', hits: [], tokenEstimate: 0, tipsPaidUsdc: 0, latencyMs: 0 };
    }
    const cfg = this.getConfig();
    const result = await this.getRouter().query(q);
    const nodeId = cfg?.nodeId;
    const hits = result.chunks.map((c) => {
      const isNetwork = 'chunkId' in c;
      const chunkId = isNetwork ? (c as { chunkId: string }).chunkId : (c as { id: string }).id;
      const providerNode = isNetwork ? (c as { nodeId: string }).nodeId : (nodeId ?? 'you');
      const content = (c as { content?: string }).content ?? (c as { summary?: string }).summary ?? '';
      // Own content is never charged/tipped: prefer central's account-level
      // isOwn flag (covers the user's OTHER linked nodes too), fall back to a
      // node-id comparison for older centrals.
      const isOwn = !isNetwork
        || (c as { isOwn?: boolean }).isOwn === true
        || providerNode === nodeId;
      return {
        chunkId,
        title: (c as { title: string }).title,
        snippet: content.slice(0, 240),
        score: (c as { score: number }).score,
        sourceNode: isNetwork ? providerNode : 'you',
        isOwn,
        tipUsdc: isOwn ? 0 : isNetwork ? (c as { tipAmountUsdc?: number }).tipAmountUsdc ?? 0 : 0,
      };
    });
    // Network results become documents, saved into the vault so the answer
    // outlives the query that fetched it. Previously the desktop fetched the
    // content, paid the tip, and then discarded it: clicking a network result
    // did nothing at all (openHit only acted on own content).
    const documents = result.source === 'network'
      ? await this.saveRetrievedDocuments(result.chunks as NetworkChunk[], q)
      : undefined;

    return {
      query: q,
      source: result.source,
      hits,
      documents,
      tokenEstimate: result.tokenEstimate,
      tipsPaidUsdc: result.tipsPaid.reduce((s, t) => s + t.amountUsdc, 0),
      latencyMs: result.latencyMs,
      lowConfidence: result.lowConfidence,
      networkError: result.networkError,
      networkMessage: result.networkMessage,
      unavailableCount: result.unavailableChunks?.length,
      unavailableReasons: result.unavailableChunks
        ? [...new Set(result.unavailableChunks.map((c) => c.reason ?? 'unknown'))]
        : undefined,
    };
  }

  /**
   * Group network chunks into documents, write each into the vault, and index
   * it for local search.
   *
   * Saved LOCAL-ONLY and never republished: chunk ids are content hashes and
   * Central stores each hash once, so a verbatim copy cannot be published — and
   * shouldn't be, since copying is not a contribution. Editing the file changes
   * its hash and makes it genuinely the editor's work, with `derivedFrom`
   * recording what seeded it so the original author keeps a share.
   *
   * Best-effort throughout: a query that succeeded and was paid for must not be
   * reported as a failure because a file could not be written.
   */
  private async saveRetrievedDocuments(chunks: NetworkChunk[], query: string): Promise<QueryDocument[]> {
    const { groupIntoDocuments } = await import('@rdk/core');
    const { saveRetrievedDocument } = await import('@rdk/node/save-retrieved');
    const cfg = this.getConfig();
    const docs = groupIntoDocuments(chunks);
    const out: QueryDocument[] = [];

    for (const doc of docs) {
      const isOwn = doc.isOwn || doc.originNodeId === cfg?.nodeId;
      let filePath: string | undefined;

      if (!isOwn && cfg?.vaultPath) {
        try {
          const saved = saveRetrievedDocument(doc, { vaultPath: cfg.vaultPath, query });
          filePath = saved.filePath;
          // Summaries are WRITTEN but never INDEXED. Indexing is what does the
          // damage — a summary in the local index answers future queries in
          // place of the real document and permanently shadows it. Refusing to
          // write it, which is what this did first, left the user clicking a
          // result that produced nothing at all.
          if (!saved.unchanged && !saved.summaryOnly) {
            await this.getIndexer().indexDocument({
              content: documentBody(doc),
              title: doc.name,
              docTitle: doc.name,
              sourcePath: saved.filePath,
              sourceAdapter: 'retrieved',
              domain: doc.domain,
              isPublic: false,
              localOnly: true,
              derivedFrom: doc.sections[0]?.chunkId,
            });
          }
        } catch (e) {
          console.error(`[query] could not save "${doc.name}": ${(e as Error).message}`);
        }
      }

      const bestSection = [...doc.sections].sort((a, b) => b.score - a.score)[0];
      const preview = bestSection?.content
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('#'))
        .slice(0, 3)
        .join(' ')
        .slice(0, 280) ?? '';

      out.push({
        name: doc.name,
        score: doc.score,
        sectionCount: doc.sections.length,
        isOwn,
        tipUsdc: isOwn ? 0 : doc.tipUsdc,
        originNode: doc.originNodeId,
        contentAvailable: doc.contentAvailable,
        preview,
        filePath,
      });
    }
    return out;
  }

  // ── node lifecycle / status ─────────────────────────────────────────────────

  getStatus(): NodeStatus {
    const stats = this.getStore().getStats();
    const cfg = this.getConfig();
    // Reachability comes from the socket's real state — never from an intent
    // flag. A fabricated "connected" is worse than an honest "not serving": it
    // tells the user their content is retrievable while Central skips every
    // chunk of it.
    const wsConnected = this.wsOwnership?.isConnected() ?? false;
    // An installed always-on service holding the socket counts as serving —
    // we deliberately don't open a competing one.
    const heldByService = !wsConnected && wsConnectionHeldByOther();
    return {
      serving: this.serving,
      wsConnected,
      contentServing: wsConnected || heldByService,
      nodeId: cfg?.nodeId,
      lastSyncAt: undefined,
      chunkCount: stats.totalChunks,
      publicChunks: stats.publicChunks,
      privateChunks: stats.privateChunks,
      unsyncedChunks: stats.unsyncedChunks,
      pendingTipsUsdc: this.getStore().getPendingTipTotal(),
    };
  }

  async startNode(): Promise<{ ok: boolean; error?: string }> {
    let cfg = this.getConfig();
    if (!cfg?.apiKey || !cfg.centralApiUrl) {
      return { ok: false, error: 'Sign in first (Settings → Account) to serve on the network.' };
    }
    try {
      // Desktop onboarding creates an OFFLINE node (`local-<hash>`), which can
      // index, publish and query but can never hold the WebSocket Central uses
      // to fetch content — so its chunks are indexed and unretrievable. The
      // only cure lived behind `rdk network:join`, a CLI command a desktop user
      // has no way to discover. Register here instead: nobody should have to
      // open a terminal to make the app they installed work.
      const ensured = await ensureServableNode({ displayName: `RDK desktop (${os.hostname()})` });
      if (ensured.status === 'blocked') return { ok: false, error: ensured.reason };
      if (ensured.status === 'registered') {
        this.config = loadConfigOrNull(); // nodeId AND apiKey both changed
        this.store?.close();
        this.store = null;
        cfg = this.getConfig();
        if (!cfg?.apiKey) return { ok: false, error: 'Registration did not persist — try again.' };
      }

      // Two halves, both required to actually serve:
      //  1. the sync loop pushes chunk embeddings + metadata to Central, and
      //  2. the WebSocket answers Central's content fetches at query time.
      // Content never leaves this machine until (2) hands it over, so a node with
      // only (1) running is indexed-but-unretrievable — its chunks show in the
      // dashboard and match nothing.
      this.syncService = new SyncService(
        {
          enabled: cfg.autoSync ?? true,
          intervalMinutes: cfg.syncIntervalMinutes ?? 5,
          centralApiUrl: cfg.centralApiUrl,
          centralApiKey: cfg.apiKey,
          log: () => {}, // diagnostics surface via getStatus / push events, not stderr
        },
        this.getStore(),
      );
      this.syncService.start();
      // Defers to an installed always-on service when one already holds the lock.
      this.wsOwnership = startWsOwnership();
      if (!this.wsOwnership) {
        // startWsOwnership returns null when this machine has no usable node
        // identity. Reporting ok here is what made "start node" appear to do
        // nothing: the button succeeded, the status stayed "not serving", and
        // there was no way to find out why.
        this.serving = false;
        return {
          ok: false,
          error: 'This node has no network identity, so it cannot serve content. '
            + 'Sign out and back in, then start the node again.',
        };
      }
      this.serving = true;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async stopNode(): Promise<{ ok: boolean }> {
    try { this.syncService?.stop(); } catch { /* ignore */ }
    try { this.wsOwnership?.stop(); } catch { /* ignore */ }
    this.syncService = null;
    this.wsOwnership = null;
    this.serving = false;
    return { ok: true };
  }

  async forceSync(): Promise<{ ok: boolean; error?: string }> {
    const client = this.centralClient();
    if (!client) return { ok: false, error: 'Not signed in.' };
    try {
      const result = await client.syncOnce();
      if (result.errors > 0) {
        return { ok: false, error: `Sync completed with ${result.errors} rejected chunk(s).` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ── account / billing / earnings ──────────────────────────────────────────
  // TWO backends, do not mix them up:
  //   RetroDeck API (retrodeckApiUrl + retrodeckAccessToken) → account, plans,
  //     balance, top-up, subscription. Handled by @rdk/node/retrodeck-client.
  //   RDK Central  (centralApiUrl + node apiKey)             → chunks, tips/earnings.

  async getAccount(): Promise<Account> {
    const cfg = this.getConfig();
    const signedIn = retrodeck.isLoggedIn();
    const base: Account = {
      signedIn,
      email: cfg?.retrodeckUserId,
      plan: cfg?.plan ?? 'free',
      walletAddress: cfg?.walletAddress,
      nodeId: cfg?.nodeId,
      centralApiUrl: cfg?.centralApiUrl,
    };
    if (!signedIn) return base;

    // Each call is individually caught so one failing endpoint doesn't blank the
    // whole Settings screen — but an expired session has to survive that, or the
    // user sees a signed-in UI with no balance and no way to understand why.
    // (This previously relied on an outer catch that nothing could ever reach,
    // which made `sessionExpired` — and the banner in Settings.tsx that renders
    // it — dead code.)
    let sessionExpired = false;
    const tolerate = <T>(fallback: T) => (e: unknown): T => {
      if (e instanceof retrodeck.RetrodeckAuthError) sessionExpired = true;
      return fallback;
    };

    try {
      // Self-heal: credit any top-up that completed but was never verified
      // (crediting happens on verification — there's no async Stripe webhook).
      await retrodeck.verifyTopup().catch(tolerate(undefined));
      const [me, bal] = await Promise.all([
        retrodeck.getMe().catch(tolerate(null)),
        retrodeck.getBalance().catch(tolerate(null)),
      ]);

      // Refresh token rejected → the user genuinely has to sign in again.
      if (sessionExpired) return { ...base, sessionExpired: true };

      return {
        ...base,
        email: me?.email ?? base.email,
        plan: me?.planId ?? base.plan,
        balanceUsdc: bal?.balanceUsdc,
        creditLimitUsd: bal?.creditLimitUsd,
        // The server's figure, not ours — see the note on Account.withdrawable.
        withdrawable: bal?.withdrawable,
        // Passed through untouched: the desktop must not decide for itself what
        // counts as "low", or it will disagree with the dashboard and the CLI.
        balanceStatus: bal?.balanceStatus,
      };
    } catch (e) {
      if (e instanceof retrodeck.RetrodeckAuthError) return { ...base, sessionExpired: true };
      return base;
    }
  }

  /** Native email/password login (same exchange as `rdk account:login`). */
  async login(email: string, password: string): Promise<LoginOutcome> {
    const r = await retrodeck.login(email, password);
    this.config = loadConfigOrNull(); // pick up the freshly persisted tokens/plan
    if (!r.ok) return { ok: false, error: r.error };
    return {
      ok: true,
      emailVerified: r.emailVerified,
      plan: r.plan,
      linkStatus: r.link?.status,
      linkReason: r.link?.reason,
    };
  }

  signOut(): { ok: boolean } {
    retrodeck.logout();
    this.config = loadConfigOrNull();
    return { ok: true };
  }

  /** RetroDeck dashboard origin (derived from the API host) for browser handoffs. */
  getDashboardUrl(): string {
    return retrodeck.dashboardUrl();
  }

  /** Earnings live on RDK Central and authenticate with the NODE apiKey. */
  async getEarnings(): Promise<EarningsSummary> {
    const cfg = this.getConfig();
    const empty: EarningsSummary = { totalUsdc: 0, byDocument: [], overTime: [] };
    if (!cfg?.centralApiUrl || !cfg.apiKey) return empty;
    const raw = await this.fetchJson<Record<string, unknown>>(
      `${cfg.centralApiUrl}/api/v1/tips/earnings`, cfg.apiKey,
    ).catch(() => null);
    if (!raw) return empty;

    const totalUsdc = Number(raw.totalUsdc ?? 0) || 0;
    // Shape tolerance: central actually returns { totalUsdc, pendingUsdc,
    // settledUsdc, tipHistory[] } — the pane's byDocument/overTime previously
    // came back undefined and crashed the renderer. Accept a native shape if a
    // future central sends it; otherwise derive both views from tipHistory.
    if (Array.isArray(raw.byDocument) && Array.isArray(raw.overTime)) {
      return { totalUsdc, byDocument: raw.byDocument, overTime: raw.overTime } as EarningsSummary;
    }
    const history = Array.isArray(raw.tipHistory) ? (raw.tipHistory as Array<Record<string, unknown>>) : [];
    const byChunk = new Map<string, EarningsSummary['byDocument'][number]>();
    const byDate = new Map<string, number>();
    for (const tip of history) {
      const chunkId = String(tip.chunk_id ?? tip.chunkId ?? 'unknown');
      const amount = Number(tip.amount_usdc ?? tip.amountUsdc ?? 0) || 0;
      const date = String(tip.created_at ?? tip.createdAt ?? '').slice(0, 10);
      const doc = byChunk.get(chunkId)
        ?? { title: `chunk ${chunkId.slice(0, 8)}…`, chunkId, earnedUsdc: 0, retrievals: 0 };
      doc.earnedUsdc += amount;
      doc.retrievals += 1;
      byChunk.set(chunkId, doc);
      if (date) byDate.set(date, (byDate.get(date) ?? 0) + amount);
    }
    return {
      totalUsdc,
      byDocument: [...byChunk.values()].sort((a, b) => b.earnedUsdc - a.earnedUsdc),
      overTime: [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, usdc]) => ({ date, usdc })),
    };
  }

  // ── Subscription ──────────────────────────────────────────────────────────

  async getPlans(): Promise<{ ok: boolean; plans?: Plan[]; error?: string }> {
    try {
      const plans = await retrodeck.getPlans();
      return {
        ok: true,
        plans: plans.map(p => ({
          id: p.id,
          name: p.name,
          priceMonthly: Number(p.price_monthly ?? 0),
          maxQueriesDay: Number(p.max_queries_day ?? 0),
          maxChunks: Number(p.max_chunks ?? 0),
        })),
      };
    } catch (e) {
      return { ok: false, error: this.authMessage(e) };
    }
  }

  async selectPlan(
    planId: string,
    interval?: BillingInterval,
    method: 'stripe' | 'cryptocadet' = 'stripe',
  ): Promise<{ ok: boolean; checkoutUrl?: string | null; error?: string }> {
    try {
      const { checkoutUrl } = await retrodeck.selectPlan(planId, interval, method);
      if (checkoutUrl) await shell.openExternal(checkoutUrl); // card → Stripe; crypto → hosted subscribe page
      else this.config = loadConfigOrNull();                  // free → applied immediately
      return { ok: true, checkoutUrl };
    } catch (e) {
      return { ok: false, error: this.authMessage(e) };
    }
  }

  async verifySubscription(): Promise<{ paid: boolean; planId?: string; planName?: string }> {
    try {
      const r = await retrodeck.verifySubscription();
      if (r.paid) this.config = loadConfigOrNull(); // plan persisted by the client
      return r;
    } catch {
      return { paid: false };
    }
  }

  // ── Withdrawals ───────────────────────────────────────────────────────────

  async getWithdrawalStatus(): Promise<{ enabled: boolean; chain: string; reason?: string }> {
    try {
      return await retrodeck.getWithdrawalStatus();
    } catch {
      // Unknown rather than "available" — better to hide the action than to
      // offer a withdrawal that debits and then can't settle.
      return { enabled: false, chain: 'unknown', reason: 'Could not reach the server.' };
    }
  }

  async requestWithdrawal(
    amountUsdc: number,
    walletAddress: string,
    walletChain: string,
  ): Promise<{ ok: boolean; withdrawalId?: string; chain?: string; error?: string }> {
    try {
      const r = await retrodeck.requestWithdrawal(amountUsdc, walletAddress, walletChain);
      return { ok: true, withdrawalId: r.withdrawalId, chain: r.chain };
    } catch (e) {
      return { ok: false, error: this.authMessage(e) };
    }
  }

  async getWithdrawals(): Promise<import('../shared/ipc').WithdrawalView[]> {
    try {
      return await retrodeck.getWithdrawals();
    } catch {
      return [];
    }
  }

  // ── Balance top-up ────────────────────────────────────────────────────────

  async createTopup(
    amountUsd: number,
    method: 'stripe' | 'cryptocadet' = 'stripe',
  ): Promise<{ ok: boolean; paymentId?: string; error?: string }> {
    try {
      const { checkoutUrl, paymentId } = await retrodeck.createTopup(amountUsd, method);
      if (!checkoutUrl) return { ok: false, error: 'No checkout URL returned.' };
      await shell.openExternal(checkoutUrl); // stripe card page, or the hosted crypto checkout
      return { ok: true, paymentId };
    } catch (e) {
      return { ok: false, error: this.authMessage(e) };
    }
  }

  async verifyTopup(paymentRef?: string): Promise<{ completed: boolean; balanceUsdc?: number }> {
    try {
      return await retrodeck.verifyTopup(paymentRef);
    } catch {
      return { completed: false };
    }
  }

  // ── Install as a background service (all OSes) ────────────────────────────
  // The desktop app can't itself run headless on boot (Electron GUI process), so
  // "install as service" installs an OS auto-start unit that runs `rdk mcp:serve`
  // — the same launchd/systemd/Task-Scheduler adapters the CLI ships, which are
  // implemented for macOS, Linux, and Windows. We drive them by invoking the
  // installed `rdk` CLI; if it isn't on PATH we say exactly how to get it.

  /** Resolve the `rdk` CLI on PATH, or null. */
  private findRdkBin(): string | null {
    const probe = process.platform === 'win32'
      ? spawnSync('where', ['rdk'], { stdio: 'ignore', shell: true }).status === 0
      : !spawnSync('rdk', ['--version'], { stdio: 'ignore' }).error;
    return probe ? 'rdk' : null;
  }

  /** Windows-safe spawn of the rdk CLI (npm shim is rdk.cmd). */
  private runRdk(args: string[]): { ok: boolean; error?: string } {
    const bin = this.findRdkBin();
    if (!bin) {
      return {
        ok: false,
        error: 'The rdk command-line tool is required to run RDK as a background service. Install it with: npm i -g @retrodeck/rdk (or: brew install thetechjd/rdk/rdk), then try again.',
      };
    }
    const r = process.platform === 'win32'
      ? spawnSync(bin, args.map(a => `"${a}"`), { stdio: 'pipe', shell: true, encoding: 'utf8', timeout: 120_000 })
      : spawnSync(bin, args, { stdio: 'pipe', encoding: 'utf8', timeout: 120_000 });
    if (r.status === 0) return { ok: true };
    const msg = (r.stderr || r.stdout || r.error?.message || 'unknown error').toString().trim().split('\n').slice(-3).join(' ');
    return { ok: false, error: `rdk ${args.join(' ')} failed: ${msg}` };
  }

  installService(): { ok: boolean; error?: string } {
    return this.runRdk(['service:install']);
  }

  uninstallService(): { ok: boolean; error?: string } {
    return this.runRdk(['service:uninstall', '--yes']);
  }

  private authMessage(e: unknown): string {
    return e instanceof retrodeck.RetrodeckAuthError
      ? 'Your RetroDeck session expired — sign in again.'
      : (e as Error).message;
  }

  getMcpInfo(): McpInfo {
    const cfg = this.getConfig();
    const snippet = JSON.stringify(
      {
        mcpServers: {
          rdk: { command: 'rdk', args: ['mcp:serve'], env: { RDK_HOME: rdkDir() } },
        },
      },
      null, 2,
    );
    return { configSnippet: snippet, connectedHosts: cfg?.nodeId ? ['Claude Desktop'] : [] };
  }

  getPreferences(): Preferences {
    const cfg = this.getConfig();
    return {
      // A REAL persisted preference now (was faked off publicFolders and never saved).
      defaultVisibility: (cfg?.defaultVisibility ?? 'private') as VisibilityChoice,
      autoStartOnBoot: false,
      vaultPath: cfg?.vaultPath,
    };
  }

  setPreferences(prefs: Partial<Preferences>): Preferences {
    if (configExists()) {
      const patch: Partial<RDKConfig> = {};
      if (prefs.vaultPath) patch.vaultPath = prefs.vaultPath;
      if (prefs.defaultVisibility === 'private' || prefs.defaultVisibility === 'public') {
        patch.defaultVisibility = prefs.defaultVisibility;
      }
      if (Object.keys(patch).length) updateConfig(patch);
    }
    this.config = loadConfigOrNull();
    return this.getPreferences();
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private async fetchJson<T>(url: string, token?: string): Promise<T | null> {
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) return null;
    return (await res.json()) as T;
  }
}

/** True when `abs` is the vault root or lives inside it — guards against path escape. */
function isWithinVault(root: string, abs: string): boolean {
  const r = path.resolve(root);
  return abs === r || abs.startsWith(r + path.sep);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

// Canonical aggregation (@rdk/core visibility): uniform → that state; a file
// whose chunks span states shows 'mixed' instead of collapsing to 'public';
// all-local_only chunks show 'local'.
function fileState(chunks: StoredChunk[], relPath: string, publicFolders: string[]): FileState {
  void relPath; void publicFolders; // folder defaults affect index-time choice, not display
  return computeFileState(chunks);
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
