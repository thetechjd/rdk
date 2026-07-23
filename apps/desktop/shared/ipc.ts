// shared/ipc.ts
// The single source of truth for the main↔renderer contract. Both the preload
// bridge and the React UI import these types. Keeping every payload shape here
// is what lets the backend swap from the "@retrodeck/mcp spike" to a clean
// @rdk/node extraction later without touching a line of UI.

// ─────────────────────────────────────────────────────────────────────────────
// Domain types
// ─────────────────────────────────────────────────────────────────────────────

/** The canonical state model (mirrors @rdk/core visibility), applied everywhere
 *  a file/chunk appears. 'mixed' = a file whose chunks span more than one state
 *  — shown honestly instead of collapsing to 'public'. */
export type FileState = 'local' | 'private' | 'public' | 'mixed';

/** A node in the vault file tree. */
export interface VaultNode {
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the vault root (POSIX-normalized for display/keys). */
  relPath: string;
  type: 'file' | 'folder';
  /** Only for files. Folders aggregate their children's states in the UI. */
  state?: FileState;
  /** Chunk ids indexed from this file (files only). */
  chunkIds?: string[];
  children?: VaultNode[];
}

export interface VaultTree {
  root: string;
  vaultName: string;
  nodes: VaultNode[];
  counts: { local: number; private: number; public: number; mixed: number };
}

/** A chunk as surfaced to the inspector / content pane. */
/** One entry in a document's version history (Inspector "History" section). */
export interface VersionView {
  id: string;
  title: string;
  version: number;
  state: FileState;
  /** True when a newer version replaced this chunk (or it was retired). */
  superseded: boolean;
  createdAt: string;
}

export interface ChunkView {
  id: string;
  title: string;
  state: FileState;
  domain?: string;
  categories: string[];
  sourcePath?: string;
  isEncrypted: boolean;
  syncedAt?: string;
  qualityScore: number;
  createdAt: string;
  updatedAt: string;
  // Stats
  sizeTokens: number;
  retrievals: number;
  earnedUsdc: number;
}

/** Content for the content pane. `decrypted` is true when the app used the vault key. */
export interface ContentView {
  id: string;
  title: string;
  state: FileState;
  /** 'markdown' | 'text' — how the renderer should present `body`. */
  format: 'markdown' | 'text';
  body: string;
  decrypted: boolean;
  sourcePath?: string;
}

/** A query that retrieved a chunk — powers the inspector "RETRIEVED FOR" list. */
export interface RetrievedFor {
  queryText: string;
  count: number;
  lastAt: string;
  bestScore: number;
}

export type VisibilityChoice = 'private' | 'public';

// ─────────────────────────────────────────────────────────────────────────────
// Graph
// ─────────────────────────────────────────────────────────────────────────────

export type GraphNodeKind = 'file' | 'query';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  state?: FileState;        // file nodes only
  retrievals: number;       // drives node size
  sourcePath?: string;      // file nodes → click loads inspector
}

export type GraphEdgeKind = 'semantic' | 'retrieval';

export interface GraphEdge {
  source: string;
  target: string;
  kind: GraphEdgeKind;
  weight: number;           // similarity (semantic) or score (retrieval)
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Query bar
// ─────────────────────────────────────────────────────────────────────────────

export interface QueryHit {
  chunkId: string;
  title: string;
  snippet: string;
  score: number;
  /** Which node served it; 'you' when it's your own knowledge. */
  sourceNode: string;
  isOwn: boolean;
  tipUsdc: number;
}

export interface QueryResponse {
  query: string;
  source: 'private' | 'network' | 'llm_fallback';
  hits: QueryHit[];
  tokenEstimate: number;
  tipsPaidUsdc: number;
  latencyMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Node lifecycle / status / account / earnings
// ─────────────────────────────────────────────────────────────────────────────

export interface NodeStatus {
  /** Node is serving public chunks (Express + WS heartbeat live). */
  serving: boolean;
  wsConnected: boolean;
  nodeId?: string;
  lastSyncAt?: string;
  chunkCount: number;
  publicChunks: number;
  privateChunks: number;
  unsyncedChunks: number;
  pendingTipsUsdc: number;
}

export interface Account {
  signedIn: boolean;
  email?: string;
  plan: string;
  balanceUsdc?: number;
  /** Balance reserved against credit; withdrawable = balance − creditLimit. */
  creditLimitUsd?: number;
  walletAddress?: string;
  nodeId?: string;
  centralApiUrl?: string;
  /** True when the RetroDeck session expired and the user must sign in again. */
  sessionExpired?: boolean;
}

/** A subscription plan as served by the RetroDeck API (never hardcoded). */
export interface Plan {
  id: string;
  name: string;
  priceMonthly: number;
  maxQueriesDay: number;
  maxChunks: number;
}

export type BillingInterval = 'monthly' | 'yearly';

/** Result of a native RetroDeck login. */
export interface LoginOutcome {
  ok: boolean;
  error?: string;
  emailVerified?: boolean;
  plan?: string;
  /** Whether this node got linked to the account (drives dashboard visibility). */
  linkStatus?: 'linked' | 'already-linked' | 'skipped' | 'failed';
  linkReason?: string;
}

export interface EarningsSummary {
  totalUsdc: number;
  byDocument: { title: string; chunkId: string; earnedUsdc: number; retrievals: number }[];
  overTime: { date: string; usdc: number }[];
}

export interface Preferences {
  defaultVisibility: VisibilityChoice;
  autoStartOnBoot: boolean;
  vaultPath?: string;
}

export interface McpInfo {
  configSnippet: string;
  connectedHosts: string[];
}

/** Whether a capability is wired to a real backend yet (spike honesty). */
export interface PlatformCapabilities {
  platform: NodeJS.Platform;
  serviceInstall: boolean;   // false → UI shows "not supported on this platform yet"
  autoStart: boolean;
  network: boolean;          // false → offline/local-only node
  unpublishSupported: boolean; // false → button disabled + tooltip (public is immutable)
  pinSupported: boolean;       // false → button disabled + tooltip
}

// ─────────────────────────────────────────────────────────────────────────────
// Live push events (main → renderer via webContents.send)
// ─────────────────────────────────────────────────────────────────────────────

export type PushEvent =
  | { type: 'status'; status: NodeStatus }
  | { type: 'sync-progress'; done: number; total: number; message?: string }
  | { type: 'vault-changed' }
  | { type: 'retrieval'; chunkId: string; queryText: string }
  | { type: 'tip-earned'; usdc: number; chunkId?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export const PUSH_CHANNEL = 'rdk:push' as const;

// ─────────────────────────────────────────────────────────────────────────────
// The invoke API surface — one method per capability. Mirrors the CLI surface.
// contextBridge exposes exactly this shape on window.rdk.
// ─────────────────────────────────────────────────────────────────────────────

export interface RdkApi {
  // Onboarding / setup
  isInitialized(): Promise<boolean>;
  getCapabilities(): Promise<PlatformCapabilities>;
  chooseVaultDirectory(): Promise<string | null>;
  initNode(opts: { email?: string; vaultPath: string; visibility: VisibilityChoice; autoStart: boolean }): Promise<{ ok: boolean; error?: string }>;

  // Vault
  getVaultTree(): Promise<VaultTree>;
  indexPaths(paths: string[], visibility: VisibilityChoice): Promise<{ indexed: number; error?: string }>;
  reindex(): Promise<{ ok: boolean; error?: string }>;
  setFolderPublic(relPath: string, isPublic: boolean): Promise<{ ok: boolean }>;
  revealInFileManager(path: string): Promise<void>;

  // Chunk actions
  getChunk(id: string): Promise<ChunkView | null>;
  readContent(id: string): Promise<ContentView | null>;      // decrypts private
  readFile(path: string): Promise<ContentView | null>;        // raw local file
  // Write a vault file to disk, then auto re-index it if it had private chunks
  // (public chunks are immutable and left untouched). Refuses paths outside the vault.
  writeFile(path: string, content: string): Promise<{ ok: boolean; error?: string; reindexed?: number }>;
  // Create a new note in the vault (parentRelPath is relative to the vault root, '' = root).
  createFile(parentRelPath: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  publishChunk(id: string): Promise<{ ok: boolean; error?: string }>;
  unpublishChunk(id: string): Promise<{ ok: boolean; error?: string }>; // retire: stops serving, history kept
  /** Version history of a document series (live + superseded), newest first. */
  getVersions(sourcePath: string): Promise<VersionView[]>;
  pinChunk(id: string, pinned: boolean): Promise<{ ok: boolean; error?: string }>; // may be unsupported
  deleteChunk(id: string): Promise<{ ok: boolean; error?: string }>;
  getRetrievedFor(id: string): Promise<RetrievedFor[]>;

  // Graph + query
  getGraphData(): Promise<GraphData>;
  query(q: string): Promise<QueryResponse>;

  // Node lifecycle
  getStatus(): Promise<NodeStatus>;
  startNode(): Promise<{ ok: boolean; error?: string }>;
  stopNode(): Promise<{ ok: boolean; error?: string }>;
  forceSync(): Promise<{ ok: boolean; error?: string }>;
  installService(): Promise<{ ok: boolean; error?: string }>;   // installs an OS auto-start service (runs `rdk mcp:serve`)
  uninstallService(): Promise<{ ok: boolean; error?: string }>;
  setAutoStart(enabled: boolean): Promise<{ ok: boolean; error?: string }>;

  // Account / earnings / mcp / prefs
  getAccount(): Promise<Account>;
  /**
   * Native email/password login against the RetroDeck API — captures both tokens,
   * resolves the plan, and links this node to the account. Same exchange as the
   * CLI's `rdk account:login`; tokens land in the shared ~/.rdk/config.json.
   */
  login(email: string, password: string): Promise<LoginOutcome>;
  /** Clears the RetroDeck session (the node's own identity/apiKey is untouched). */
  signOut(): Promise<{ ok: boolean }>;
  /** Browser handoff for account creation / password reset. */
  openSignup(): Promise<void>;
  openUpgrade(): Promise<void>;                          // browser handoff (dashboard billing)
  openTopUp(): Promise<void>;                            // browser handoff (dashboard balance)
  getEarnings(): Promise<EarningsSummary>;

  // ── Subscription (RetroDeck API) ──────────────────────────────────────────
  /** Live plans from the API — never hardcoded. */
  getPlans(): Promise<{ ok: boolean; plans?: Plan[]; error?: string }>;
  /**
   * Free applies immediately; paid returns a checkoutUrl which the main process
   * opens in the browser (the web checkout takes card OR crypto). Poll
   * verifySubscription() afterwards.
   */
  selectPlan(planId: string, interval?: BillingInterval): Promise<{ ok: boolean; checkoutUrl?: string | null; error?: string }>;
  verifySubscription(): Promise<{ paid: boolean; planId?: string; planName?: string }>;

  // ── Balance top-up (RetroDeck API) ────────────────────────────────────────
  /** Creates a checkout and opens it in the browser. Poll verifyTopup() after. */
  createTopup(amountUsd: number, method?: 'stripe' | 'cryptocadet'): Promise<{ ok: boolean; paymentId?: string; error?: string }>;
  /** Verifying is what CREDITS the balance (no async webhook). Safe to re-run. */
  verifyTopup(paymentRef?: string): Promise<{ completed: boolean; balanceUsdc?: number }>;
  getMcpInfo(): Promise<McpInfo>;
  getPreferences(): Promise<Preferences>;
  setPreferences(prefs: Partial<Preferences>): Promise<Preferences>;
  openExternal(url: string): Promise<void>;

  // Live events
  onPush(handler: (e: PushEvent) => void): () => void;   // returns unsubscribe
}

/** Channel names for ipcMain.handle / ipcRenderer.invoke. Keyed by RdkApi method. */
export type RdkChannel = Exclude<keyof RdkApi, 'onPush'>;

export const RDK_CHANNELS: RdkChannel[] = [
  'isInitialized', 'getCapabilities', 'chooseVaultDirectory', 'initNode',
  'getVaultTree', 'indexPaths', 'reindex', 'setFolderPublic', 'revealInFileManager',
  'getChunk', 'readContent', 'readFile', 'writeFile', 'createFile', 'publishChunk', 'unpublishChunk', 'pinChunk',
  'deleteChunk', 'getRetrievedFor', 'getVersions',
  'getGraphData', 'query',
  'getStatus', 'startNode', 'stopNode', 'forceSync', 'installService', 'uninstallService', 'setAutoStart',
  'getAccount', 'login', 'signOut', 'openSignup', 'openUpgrade', 'openTopUp', 'getEarnings',
  'getPlans', 'selectPlan', 'verifySubscription', 'createTopup', 'verifyTopup',
  'getMcpInfo', 'getPreferences', 'setPreferences', 'openExternal',
];
