// electron/node-service.ts
//
// THE SEAM. Every IPC handler goes through this class; the React UI never sees
// @rdk/core, @retrodeck/mcp, SQLite, or HTTP directly. Today it calls @rdk/core
// primitives (index/query/graph — real, pure-core) and reaches @retrodeck/mcp /
// RetroDeck HTTP for network/serve/account (the "spike"). When @rdk/node is
// extracted, only the bodies here change — the RdkApi contract stays fixed.

import fs from 'fs';
import path from 'path';
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
  GraphEdge, GraphNode, LoginOutcome, McpInfo, NodeStatus, Plan, PlatformCapabilities,
  Preferences, QueryResponse, RetrievedFor, VaultNode, VaultTree, VisibilityChoice,
} from '../shared/ipc';

const IGNORE_DIRS = new Set(['.git', '.obsidian', 'node_modules', '.trash', '.rdk']);
const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.mdx']);
/** Semantic-edge threshold + fan-out cap, to keep the graph legible. */
const SEMANTIC_MIN_SIM = 0.55;
const SEMANTIC_MAX_EDGES_PER_NODE = 4;

export class NodeService {
  private store: LocalStore | null = null;
  private config: RDKConfig | null = null;
  private embedder: EmbeddingModel = new LocalEmbeddingModel();
  private embedderReady: boolean | null = null;
  private router: RDKRouter | null = null;
  private serving = false;
  /** Background sync loop (from @rdk/node) — runs while the node is "serving". */
  private syncService: SyncService | null = null;

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

  private getIndexer(visibility: VisibilityChoice): RDKIndexer {
    const cfg = this.getConfig();
    return new RDKIndexer({
      embeddingModel: this.embedder,
      localStore: this.getStore(),
      domain: cfg?.domain ?? 'general',
      syncToNetwork: !!cfg?.centralApiUrl && !!cfg?.apiKey && visibility === 'public',
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
          // Prefer a sourcePath match; fall back to a name match for chunks indexed
          // WITHOUT a sourcePath (older adapters dropped it), so their private content
          // still links to the file and opens decrypted instead of showing as "local".
          const baseName = path.basename(e.name, path.extname(e.name)).toLowerCase();
          const chunks =
            chunksByPath.get(abs) ?? chunksByPath.get(relPath) ?? orphansByName.get(baseName) ?? [];
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
   * Fallback index for chunks stored WITHOUT a sourcePath (an older adapter bug orphaned
   * them from their files). Keyed by the document name — the chunk title up to the first
   * " — " section separator, lowercased — which equals the source note's base file name.
   * Lets getVaultTree still link these to their on-disk file so private content displays
   * decrypted instead of the file falling back to a raw, "local" read.
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
    const indexer = this.getIndexer(visibility);
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

  private toChunkView(c: StoredChunk): ChunkView {
    const retrievals = this.getStore().getRetrievalCounts()[c.id] ?? 0;
    return {
      id: c.id,
      title: c.title,
      state: c.isPublic ? 'public' : c.isLocalOnly ? 'local' : 'private',
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
      reindexed = (await this.indexPaths([abs], visibility, {
        supersedes: (stalePublic[0] ?? stalePrivate[0])?.id,
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
      { ...c, content, isPublic: true, isEncrypted: false, syncedAt: undefined },
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

  /** Version history of a document series (live + superseded), newest first. */
  getVersions(sourcePath: string): import('../shared/ipc').VersionView[] {
    return this.getStore().getVersions(sourcePath).map((c) => ({
      id: c.id,
      title: c.title,
      version: c.version ?? 1,
      state: c.isPublic ? 'public' as const : 'private' as const,
      superseded: !!c.supersededAt,
      createdAt: c.createdAt.toISOString(),
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
    return {
      query: q,
      source: result.source,
      hits,
      tokenEstimate: result.tokenEstimate,
      tipsPaidUsdc: result.tipsPaid.reduce((s, t) => s + t.amountUsdc, 0),
      latencyMs: result.latencyMs,
    };
  }

  // ── node lifecycle / status ─────────────────────────────────────────────────

  getStatus(): NodeStatus {
    const stats = this.getStore().getStats();
    const cfg = this.getConfig();
    return {
      serving: this.serving,
      wsConnected: this.serving && !!cfg?.apiKey,
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
    const cfg = this.getConfig();
    if (!cfg?.apiKey || !cfg.centralApiUrl) {
      return { ok: false, error: 'Sign in first (Settings → Account) to serve on the network.' };
    }
    try {
      // Start the shared @rdk/node background sync loop (pushes public + private
      // chunk embeddings/metadata to Central). Peer chunk-serving over HTTP is a
      // follow-up; the core "serving" behavior for the desktop is staying synced.
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
      this.serving = true;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async stopNode(): Promise<{ ok: boolean }> {
    try { this.syncService?.stop(); } catch { /* ignore */ }
    this.syncService = null;
    this.serving = false;
    return { ok: true };
  }

  async forceSync(): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.getConfig();
    if (!cfg?.centralApiUrl || !cfg.apiKey) return { ok: false, error: 'Not signed in.' };
    try {
      const store = this.getStore();
      const unsynced = [...store.getUnsyncedPublicChunks(200), ...store.getUnsyncedEncryptedChunks(200)];
      if (unsynced.length === 0) return { ok: true };
      const payload = unsynced.map(c => {
        const embedding = store.getEmbedding(c.id);
        return {
          chunkHash: c.id, title: c.title, summary: c.summary, domain: c.domain,
          categories: c.categories, embedding: embedding ? Array.from(embedding) : [],
          isPublic: c.isPublic, isEncrypted: c.isEncrypted,
          content: c.isEncrypted ? c.content : undefined, freshnessAt: new Date().toISOString(),
        };
      }).filter(c => c.embedding.length > 0);
      const res = await fetch(`${cfg.centralApiUrl}/api/v1/chunks/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ chunks: payload }),
      });
      if (!res.ok) return { ok: false, error: `Sync failed: HTTP ${res.status}` };
      unsynced.forEach(c => store.markSynced(c.id));
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

    try {
      // Self-heal: credit any top-up that completed but was never verified
      // (crediting happens on verification — there's no async Stripe webhook).
      await retrodeck.verifyTopup().catch(() => undefined);
      const [me, bal] = await Promise.all([
        retrodeck.getMe().catch(() => null),
        retrodeck.getBalance().catch(() => null),
      ]);
      return {
        ...base,
        email: me?.email ?? base.email,
        plan: me?.planId ?? base.plan,
        balanceUsdc: bal?.balanceUsdc,
        creditLimitUsd: bal?.creditLimitUsd,
      };
    } catch (e) {
      // Refresh token rejected → the user genuinely has to sign in again.
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

  async selectPlan(planId: string, interval?: BillingInterval): Promise<{ ok: boolean; checkoutUrl?: string | null; error?: string }> {
    try {
      const { checkoutUrl } = await retrodeck.selectPlan(planId, interval);
      if (checkoutUrl) await shell.openExternal(checkoutUrl); // paid → web checkout (card or crypto)
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
