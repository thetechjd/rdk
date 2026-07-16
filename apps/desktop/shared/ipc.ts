// shared/ipc.ts
// The single source of truth for the main↔renderer contract. Both the preload
// bridge and the React UI import these types. Keeping every payload shape here
// is what lets the backend swap from the "@retrodeck/mcp spike" to a clean
// @rdk/node extraction later without touching a line of UI.

// ─────────────────────────────────────────────────────────────────────────────
// Domain types
// ─────────────────────────────────────────────────────────────────────────────

/** The three-state color model, applied everywhere a file/chunk appears. */
export type FileState = 'local' | 'private' | 'public';

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
  counts: { local: number; private: number; public: number };
}

/** A chunk as surfaced to the inspector / content pane. */
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
  walletAddress?: string;
  nodeId?: string;
  centralApiUrl?: string;
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
  publishChunk(id: string): Promise<{ ok: boolean; error?: string }>;
  unpublishChunk(id: string): Promise<{ ok: boolean; error?: string }>; // may be unsupported
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
  installService(): Promise<{ ok: boolean; error?: string }>;
  uninstallService(): Promise<{ ok: boolean; error?: string }>;
  setAutoStart(enabled: boolean): Promise<{ ok: boolean; error?: string }>;

  // Account / earnings / mcp / prefs
  getAccount(): Promise<Account>;
  signIn(): Promise<{ ok: boolean; error?: string }>;   // browser handoff
  signOut(): Promise<{ ok: boolean }>;
  openUpgrade(): Promise<void>;                          // browser handoff
  openTopUp(): Promise<void>;                            // browser handoff
  getEarnings(): Promise<EarningsSummary>;
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
  'getChunk', 'readContent', 'readFile', 'publishChunk', 'unpublishChunk', 'pinChunk',
  'deleteChunk', 'getRetrievedFor',
  'getGraphData', 'query',
  'getStatus', 'startNode', 'stopNode', 'forceSync', 'installService', 'uninstallService', 'setAutoStart',
  'getAccount', 'signIn', 'signOut', 'openUpgrade', 'openTopUp', 'getEarnings',
  'getMcpInfo', 'getPreferences', 'setPreferences', 'openExternal',
];
