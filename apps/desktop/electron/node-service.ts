// electron/node-service.ts
//
// THE SEAM. Every IPC handler goes through this class; the React UI never sees
// @rdk/core, @retrodeck/mcp, SQLite, or HTTP directly. Today it calls @rdk/core
// primitives (index/query/graph — real, pure-core) and reaches @retrodeck/mcp /
// RetroDeck HTTP for network/serve/account (the "spike"). When @rdk/node is
// extracted, only the bodies here change — the RdkApi contract stays fixed.

import fs from 'fs';
import path from 'path';
import {
  LocalStore,
  RDKRouter,
  RDKIndexer,
  LocalEmbeddingModel,
  cosineSimilarity,
  keyFromHex,
  decrypt,
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
import {
  autoStartSupported,
  serviceInstallSupported,
} from './platform';
import type {
  Account, ChunkView, ContentView, EarningsSummary, FileState, GraphData, GraphEdge,
  GraphNode, McpInfo, NodeStatus, PlatformCapabilities, Preferences, QueryResponse,
  RetrievedFor, VaultNode, VaultTree, VisibilityChoice,
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
    if (this.embedderReady === null) this.embedderReady = await LocalEmbeddingModel.isAvailable();
    return this.embedderReady ?? false;
  }

  private getRouter(): RDKRouter {
    if (!this.router) {
      const cfg = this.getConfig();
      this.router = new RDKRouter({
        localStore: this.getStore(),
        embeddingModel: this.embedder,
        centralApiUrl: cfg?.centralApiUrl,
        centralApiKey: cfg?.apiKey,
        domain: cfg?.domain,
        vaultKey: this.vaultKey(),
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
      unpublishSupported: false, // public chunks are immutable by design (see report §7)
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
    const publicFolders = cfg?.publicFolders ?? [];
    const counts = { local: 0, private: 0, public: 0 };

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
          const chunks = chunksByPath.get(abs) ?? chunksByPath.get(relPath) ?? [];
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
      const arr = map.get(c.sourcePath) ?? [];
      arr.push(c);
      map.set(c.sourcePath, arr);
    }
    return map;
  }

  async indexPaths(paths: string[], visibility: VisibilityChoice): Promise<{ indexed: number; error?: string }> {
    if (!(await this.embedderAvailable())) {
      return { indexed: 0, error: 'Embedding model not installed. Install it from Settings → Node.' };
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
        });
        indexed += res.chunksIndexed;
        errors.push(...res.errors);
      } catch (e) {
        errors.push(`${path.basename(file)}: ${(e as Error).message}`);
      }
    }
    return { indexed, error: errors.length ? errors.slice(0, 3).join('; ') : undefined };
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
      state: c.isPublic ? 'public' : 'private',
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

  // Public chunks are immutable by design; no unpublish path exists (report §7).
  unpublishChunk(): { ok: boolean; error?: string } {
    return { ok: false, error: 'Public chunks are immutable and cannot be unpublished.' };
  }

  // No pin concept exists in core/central yet (report §7).
  pinChunk(): { ok: boolean; error?: string } {
    return { ok: false, error: 'Pinning is not supported yet.' };
  }

  async reindex(): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.getConfig();
    if (!cfg?.vaultPath) return { ok: false, error: 'No vault configured.' };
    const res = await this.indexPaths([cfg.vaultPath], 'private');
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
      nodes.push({
        id: c.id,
        kind: 'file',
        label: c.title,
        state: c.isPublic ? 'public' : 'private',
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
      return {
        chunkId,
        title: (c as { title: string }).title,
        snippet: content.slice(0, 240),
        score: (c as { score: number }).score,
        sourceNode: isNetwork ? providerNode : 'you',
        isOwn: !isNetwork || providerNode === nodeId,
        tipUsdc: isNetwork ? (c as { tipAmountUsdc?: number }).tipAmountUsdc ?? 0 : 0,
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

  // ── account / earnings / mcp / prefs (spike: config + RetroDeck HTTP) ─────────

  async getAccount(): Promise<Account> {
    const cfg = this.getConfig();
    const signedIn = !!cfg?.retrodeckAccessToken;
    let balanceUsdc: number | undefined;
    if (signedIn && cfg?.centralApiUrl) {
      balanceUsdc = await this.fetchJson<{ balanceUsdc: number }>(
        `${cfg.centralApiUrl}/api/v1/balances/me`, cfg.retrodeckAccessToken,
      ).then(r => r?.balanceUsdc).catch(() => undefined);
    }
    return {
      signedIn,
      email: cfg?.retrodeckUserId,
      plan: cfg?.plan ?? 'free',
      balanceUsdc,
      walletAddress: cfg?.walletAddress,
      nodeId: cfg?.nodeId,
      centralApiUrl: cfg?.centralApiUrl,
    };
  }

  async getEarnings(): Promise<EarningsSummary> {
    const cfg = this.getConfig();
    const empty: EarningsSummary = { totalUsdc: 0, byDocument: [], overTime: [] };
    if (!cfg?.centralApiUrl || !cfg.retrodeckAccessToken) return empty;
    const data = await this.fetchJson<EarningsSummary>(
      `${cfg.centralApiUrl}/api/v1/tips/earnings`, cfg.retrodeckAccessToken,
    ).catch(() => null);
    return data ?? empty;
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
      defaultVisibility: (cfg?.publicFolders?.length ? 'public' : 'private') as VisibilityChoice,
      autoStartOnBoot: false,
      vaultPath: cfg?.vaultPath,
    };
  }

  setPreferences(prefs: Partial<Preferences>): Preferences {
    if (prefs.vaultPath && configExists()) updateConfig({ vaultPath: prefs.vaultPath });
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

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function fileState(chunks: StoredChunk[], relPath: string, publicFolders: string[]): FileState {
  if (chunks.length === 0) return 'local';
  if (chunks.some(c => c.isPublic)) return 'public';
  // designated-public folder but not yet published → still private once indexed
  void relPath; void publicFolders;
  return 'private';
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
