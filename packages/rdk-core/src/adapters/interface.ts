// packages/rdk-core/src/adapters/interface.ts

export interface AdapterConfig {
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface IndexOptions {
  syncToNetwork?: boolean;
  isPublic?: boolean;
  domain?: string;
}

export interface RetrievedChunk {
  id: string;
  title: string;
  content: string;
  summary?: string;
  domain?: string;
  categories: string[];
  score: number;
  sourcePath?: string;
  sourceAdapter?: string;
}

export interface FileChange {
  path: string;
  type: 'added' | 'modified' | 'deleted';
}

export interface IndexResult {
  chunksIndexed: number;
  chunksSkipped: number;
  filesProcessed: number;
  errors: string[];
  categories: string[][];
}

export interface VaultMetadata {
  adapterName: string;
  vaultPath: string;
  documentCount: number;
  lastIndexed?: Date;
}

export interface VaultAdapter {
  name: string;
  description: string;

  /** Initialize connection to vault */
  connect(config: AdapterConfig): Promise<void>;

  /** Full index — run on init or force reindex */
  indexAll(options: IndexOptions): Promise<IndexResult>;

  /** Incremental index — only changed files since last run */
  indexChanged(since: Date, options: IndexOptions): Promise<IndexResult>;

  /** Semantic search within private vault */
  search(embedding: Float32Array, topK: number): Promise<RetrievedChunk[]>;

  /** Watch for changes (returns unsubscribe function) */
  watch(callback: (changes: FileChange[]) => void): () => void;

  /** Get metadata about the vault */
  getMetadata(): VaultMetadata;
}
