// packages/rdk-node/src/node-controller.ts
//
// The headless node runtime — the piece the RDKNode split (mcp/node.ts) and the
// desktop app both want: it wires @rdk/core primitives (store, router, indexer,
// embeddings) to the moved network runtime (SyncService, startHttpServer, WS
// client) behind one UI-agnostic lifecycle. Everything returns STRUCTURED objects
// (never MCP text or console output); diagnostics go through an injectable logger.

import {
  LocalStore,
  RDKRouter,
  RDKIndexer,
  LocalEmbeddingModel,
  keyFromHex,
  type EmbeddingModel,
  type Document,
  type QueryResult,
  type VaultKey,
} from '@rdk/core';
import { loadConfigOrNull, type RDKConfig } from './config.js';
import { SyncService } from './sync-service.js';
import { startHttpServer } from './http-server.js';
import { getWsClient } from './ws/client.js';

export type NodeLogger = (level: 'info' | 'warn' | 'error', message: string) => void;

export interface NodeControllerOptions {
  /** Overrides the on-disk config (tests / embedded hosts). Defaults to ~/.rdk/config.json. */
  config?: RDKConfig;
  /** Structured diagnostics sink. Defaults to console.error. */
  logger?: NodeLogger;
  /** Custom embedding model (defaults to the on-device MiniLM). */
  embeddingModel?: EmbeddingModel;
  /** Point at a specific index.db (tests). Defaults to ~/.rdk/index.db. */
  store?: LocalStore;
}

export interface NodeRuntimeStatus {
  initialized: boolean;
  serving: boolean;
  wsConnected: boolean;
  httpPort: number | null;
  nodeId?: string;
  online: boolean; // has central creds (not a local-only node)
  chunks: ReturnType<LocalStore['getStats']>;
  pendingTipsUsdc: number;
  lastSyncAt?: string;
}

/**
 * Compose the node runtime. Call `init()` once, then `start()`/`stop()`.
 * `query`/`indexDocuments`/`syncNow` are usable after `init()` without `start()`.
 */
export class NodeController {
  private readonly log: NodeLogger;
  private readonly embedder: EmbeddingModel;
  private config: RDKConfig | null;
  private store: LocalStore | null;
  private router: RDKRouter | null = null;
  private indexer: RDKIndexer | null = null;
  private sync: SyncService | null = null;
  private httpPort: number | null = null;
  private serving = false;
  private lastSyncAt?: string;

  constructor(private readonly opts: NodeControllerOptions = {}) {
    this.log = opts.logger ?? ((lvl, m) => console.error(`[node:${lvl}] ${m}`));
    this.embedder = opts.embeddingModel ?? new LocalEmbeddingModel();
    this.config = opts.config ?? loadConfigOrNull();
    this.store = opts.store ?? null;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  init(): void {
    const store = this.getStore();
    const cfg = this.config;
    this.router = new RDKRouter({
      localStore: store,
      embeddingModel: this.embedder,
      centralApiUrl: cfg?.centralApiUrl,
      centralApiKey: cfg?.apiKey,
      domain: cfg?.domain,
      vaultKey: this.vaultKey(),
      sharedVaultKeys: this.sharedVaultKeys(),
    });
    this.indexer = new RDKIndexer({
      embeddingModel: this.embedder,
      localStore: store,
      domain: cfg?.domain ?? 'general',
      syncToNetwork: this.online(),
      centralApiUrl: cfg?.centralApiUrl,
      centralApiKey: cfg?.apiKey,
      vaultKey: this.vaultKey(),
    });
    this.log('info', 'node runtime initialized');
  }

  /**
   * Begin serving: bind the discovery/chunk HTTP server, open the WS control
   * channel, and start the background sync loop. Safe to call when offline
   * (local-only node) — it just skips the network pieces.
   */
  async start(): Promise<NodeRuntimeStatus> {
    if (!this.router) this.init();
    const cfg = this.config;

    if (this.online() && cfg) {
      try {
        this.httpPort = await startHttpServer(
          { nodeId: cfg.nodeId, domain: cfg.domain, mcpPort: cfg.mcpPort },
          this.getStore(),
        );
      } catch (e) {
        this.log('warn', `http server failed to start: ${(e as Error).message}`);
      }

      const ws = getWsClient();
      if (ws) {
        void ws.connect();
        ws.on('disconnected', () => this.log('warn', 'RDK Central disconnected'));
      }

      this.sync = new SyncService(
        {
          enabled: cfg.autoSync ?? true,
          intervalMinutes: cfg.syncIntervalMinutes ?? 5,
          centralApiUrl: cfg.centralApiUrl,
          centralApiKey: cfg.apiKey,
          log: (m) => this.log('info', m),
        },
        this.getStore(),
      );
      this.sync.start();
    }

    this.serving = true;
    this.log('info', this.online() ? 'node serving' : 'node started (local-only)');
    return this.getStatus();
  }

  async stop(): Promise<void> {
    this.sync?.stop();
    this.sync = null;
    getWsClient()?.disconnect();
    this.serving = false;
    // Note: startHttpServer does not currently return a server handle to close;
    // the port is released on process exit. Tracked for a future close() addition.
    this.httpPort = null;
    this.log('info', 'node stopped');
  }

  // ── operations ───────────────────────────────────────────────────────────────

  async query(userQuery: string): Promise<QueryResult> {
    if (!this.router) this.init();
    return this.router!.query(userQuery);
  }

  async indexDocuments(docs: Document[]): Promise<{ chunksIndexed: number; errors: string[] }> {
    if (!this.indexer) this.init();
    let chunksIndexed = 0;
    const errors: string[] = [];
    for (const doc of docs) {
      const res = await this.indexer!.indexDocument(doc);
      chunksIndexed += res.chunksIndexed;
      errors.push(...res.errors);
    }
    return { chunksIndexed, errors };
  }

  async syncNow(): Promise<{ synced: number; errors: number }> {
    const cfg = this.config;
    if (!this.online() || !cfg) return { synced: 0, errors: 0 };
    const svc = this.sync ?? new SyncService(
      { enabled: true, intervalMinutes: 0, centralApiUrl: cfg.centralApiUrl, centralApiKey: cfg.apiKey, log: (m) => this.log('info', m) },
      this.getStore(),
    );
    const result = await svc.syncOnce();
    this.lastSyncAt = new Date().toISOString();
    return result;
  }

  getStatus(): NodeRuntimeStatus {
    const store = this.getStore();
    const cfg = this.config;
    const ws = this.online() ? getWsClient() : null;
    return {
      initialized: !!this.router,
      serving: this.serving,
      wsConnected: !!ws?.isConnected(),
      httpPort: this.httpPort,
      nodeId: cfg?.nodeId,
      online: this.online(),
      chunks: store.getStats(),
      pendingTipsUsdc: store.getPendingTipTotal(),
      lastSyncAt: this.lastSyncAt,
    };
  }

  /** Direct access to the underlying store (graph data, reads) for host UIs. */
  getLocalStore(): LocalStore {
    return this.getStore();
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private getStore(): LocalStore {
    if (!this.store) this.store = new LocalStore();
    return this.store;
  }

  /** A node is "online" when it has central credentials (not a local-* offline node). */
  private online(): boolean {
    const cfg = this.config;
    return !!cfg?.centralApiUrl && !!cfg.apiKey && !cfg.nodeId?.startsWith('local-');
  }

  private vaultKey(): VaultKey | undefined {
    return this.config?.vaultKeyHex ? keyFromHex(this.config.vaultKeyHex) : undefined;
  }

  private sharedVaultKeys(): Record<string, VaultKey> | undefined {
    const shared = this.config?.sharedVaultKeys;
    if (!shared) return undefined;
    const out: Record<string, VaultKey> = {};
    for (const [nodeId, hex] of Object.entries(shared)) out[nodeId] = keyFromHex(hex);
    return out;
  }
}
