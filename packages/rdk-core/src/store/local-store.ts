// packages/rdk-core/src/store/local-store.ts
// Single ~/.rdk/index.db file. Zero config. Created by rdk init.
// Uses sqlite-vec virtual table for ANN search (cosine similarity).

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';

export interface StoredChunk {
  id: string;
  title: string;
  content: string;
  summary?: string;
  domain?: string;
  categories: string[];
  isPublic: boolean;
  isEncrypted: boolean;
  // Local-only chunks are indexed for personal search but never synced to RDK
  // Central (e.g. knowledge saved from a network query). They are excluded from
  // every sync path and don't count against the plan's network chunk limit.
  isLocalOnly?: boolean;
  syncedAt?: Date;
  qualityScore: number;
  sourcePath?: string;
  sourceAdapter?: string;
  // ── Versioning (metadata lineage) ────────────────────────────────────────
  // Chunk ids are content hashes, so an edit mints a NEW chunk; these link the
  // versions. Superseded chunks stay stored (frozen, history intact) but are
  // excluded from search.
  /** Chunk id (content hash) of the prior version this chunk replaced. */
  supersedes?: string;
  /** Set when a newer version replaced this chunk (or it was retired). */
  supersededAt?: Date;
  /** 1-based version number within the document series. */
  version?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SearchResult extends StoredChunk {
  score: number; // cosine similarity 0-1
}

export interface TipQueueEntry {
  id: string;
  chunkId: string;
  providerNodeId: string;
  amountUsdc: number;
  chain: string;
  status: 'pending' | 'settled' | 'failed';
  txHash?: string;
  createdAt: Date;
  settledAt?: Date;
}

export class LocalStore {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? path.join(process.env.RDK_HOME ?? path.join(os.homedir(), '.rdk'), 'index.db');
    this.ensureDir();
    const nativeBinding = process.env.BETTER_SQLITE3_NATIVE_BINDING;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.db = new Database(this.dbPath, nativeBinding ? { nativeBinding } as any : undefined);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  private ensureDir() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        content       TEXT NOT NULL,
        summary       TEXT,
        domain        TEXT,
        categories    TEXT DEFAULT '[]',
        is_public     INTEGER DEFAULT 0,
        is_encrypted  INTEGER DEFAULT 0,
        local_only    INTEGER DEFAULT 0,
        synced_at     DATETIME,
        quality_score REAL DEFAULT 0.0,
        source_path   TEXT,
        source_adapter TEXT,
        supersedes    TEXT,
        superseded_at DATETIME,
        version       INTEGER DEFAULT 1,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id    TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        embedding   BLOB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_public ON chunks(is_public, domain);
      CREATE INDEX IF NOT EXISTS idx_chunks_synced ON chunks(synced_at, is_public);
      CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_path, source_adapter);
    `);

    // Migration: add is_encrypted column to existing databases
    try {
      this.db.exec(`ALTER TABLE chunks ADD COLUMN is_encrypted INTEGER DEFAULT 0`);
    } catch {
      // Column already exists — safe to ignore
    }

    // Migration: add local_only column to existing databases
    try {
      this.db.exec(`ALTER TABLE chunks ADD COLUMN local_only INTEGER DEFAULT 0`);
    } catch {
      // Column already exists — safe to ignore
    }

    // Migration: versioning columns (supersedes lineage) for existing databases
    for (const ddl of [
      `ALTER TABLE chunks ADD COLUMN supersedes TEXT`,
      `ALTER TABLE chunks ADD COLUMN superseded_at DATETIME`,
      `ALTER TABLE chunks ADD COLUMN version INTEGER DEFAULT 1`,
    ]) {
      try { this.db.exec(ddl); } catch { /* column already exists */ }
    }

    this.db.exec(`

      CREATE TABLE IF NOT EXISTS tip_queue (
        id               TEXT PRIMARY KEY,
        chunk_id         TEXT NOT NULL,
        provider_node_id TEXT NOT NULL,
        amount_usdc      REAL NOT NULL,
        chain            TEXT NOT NULL DEFAULT 'base',
        status           TEXT DEFAULT 'pending',
        tx_hash          TEXT,
        created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        settled_at       DATETIME
      );

      CREATE TABLE IF NOT EXISTS query_log (
        id               TEXT PRIMARY KEY,
        query_text       TEXT,
        source           TEXT,
        matched_chunk_id TEXT,
        latency_ms       INTEGER,
        created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Many-to-many retrieval edges: one query_log row → N chunks it actually
      -- retrieved (query_log keeps only the single best match, for back-compat).
      -- Powers the desktop graph's query→chunk edges and the "RETRIEVED FOR" panel.
      CREATE TABLE IF NOT EXISTS retrieval_edges (
        id          TEXT PRIMARY KEY,
        query_id    TEXT NOT NULL,
        query_text  TEXT,
        chunk_id    TEXT NOT NULL,
        rank        INTEGER,
        score       REAL,
        source      TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_retrieval_chunk ON retrieval_edges(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_retrieval_query ON retrieval_edges(query_id);
    `);
  }

  // ── Chunk Storage ──────────────────────────────────────────────

  saveChunk(chunk: Omit<StoredChunk, 'createdAt' | 'updatedAt'>, embedding: Float32Array): string {
    const id = chunk.id || crypto.createHash('sha256').update(chunk.content).digest('hex');
    const now = new Date().toISOString();

    const existing = this.db.prepare('SELECT id FROM chunks WHERE id = ?').get(id) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE chunks SET
          title = ?, content = ?, summary = ?, domain = ?, categories = ?,
          is_public = ?, is_encrypted = ?, local_only = ?, quality_score = ?, source_path = ?,
          source_adapter = ?, supersedes = ?, version = ?, updated_at = ?
        WHERE id = ?
      `).run(
        chunk.title, chunk.content, chunk.summary ?? null, chunk.domain ?? null,
        JSON.stringify(chunk.categories), chunk.isPublic ? 1 : 0,
        chunk.isEncrypted ? 1 : 0, chunk.isLocalOnly ? 1 : 0, chunk.qualityScore, chunk.sourcePath ?? null,
        chunk.sourceAdapter ?? null, chunk.supersedes ?? null, chunk.version ?? 1, now, id,
      );
    } else {
      this.db.prepare(`
        INSERT INTO chunks (id, title, content, summary, domain, categories,
          is_public, is_encrypted, local_only, quality_score, source_path, source_adapter,
          supersedes, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, chunk.title, chunk.content, chunk.summary ?? null,
        chunk.domain ?? null, JSON.stringify(chunk.categories),
        chunk.isPublic ? 1 : 0, chunk.isEncrypted ? 1 : 0, chunk.isLocalOnly ? 1 : 0, chunk.qualityScore,
        chunk.sourcePath ?? null, chunk.sourceAdapter ?? null,
        chunk.supersedes ?? null, chunk.version ?? 1, now, now,
      );
    }

    // Store embedding as raw blob (Float32Array → Buffer)
    const embeddingBuffer = Buffer.from(embedding.buffer);
    this.db.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)
    `).run(id, embeddingBuffer);

    return id;
  }

  getChunk(id: string): StoredChunk | null {
    const row = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToChunk(row);
  }

  /** Absolute path of the SQLite file this store is operating on. */
  getDatabasePath(): string {
    return this.dbPath;
  }

  /** Deletes a chunk; returns whether a row actually existed and was removed. */
  deleteChunk(id: string): boolean {
    const result = this.db.prepare('DELETE FROM chunks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /** Mark a chunk as superseded (replaced by a newer version, or retired).
   *  The row stays — frozen, excluded from search, history intact. */
  markSuperseded(id: string): boolean {
    const result = this.db.prepare(
      `UPDATE chunks SET superseded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND superseded_at IS NULL`,
    ).run(id);
    return result.changes > 0;
  }

  /** All versions of a document series (live + superseded), newest first.
   *  The series key is the source file; falls back to nothing for chunks
   *  indexed without a sourcePath. */
  getVersions(sourcePath: string, sourceAdapter?: string): StoredChunk[] {
    const rows = (sourceAdapter
      ? this.db.prepare(
          `SELECT * FROM chunks WHERE source_path = ? AND source_adapter = ?
           ORDER BY version DESC, created_at DESC`,
        ).all(sourcePath, sourceAdapter)
      : this.db.prepare(
          `SELECT * FROM chunks WHERE source_path = ?
           ORDER BY version DESC, created_at DESC`,
        ).all(sourcePath)) as Record<string, unknown>[];
    return rows.map(r => this.rowToChunk(r));
  }

  /** Highest version number in a document series (0 when none indexed yet). */
  getLatestVersion(sourcePath: string): number {
    const row = this.db.prepare(
      `SELECT MAX(version) AS v FROM chunks WHERE source_path = ?`,
    ).get(sourcePath) as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  markSynced(id: string): void {
    this.db.prepare('UPDATE chunks SET synced_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  markAllPublic(): number {
    const result = this.db.prepare(
      'UPDATE chunks SET is_public = 1, synced_at = NULL WHERE is_public = 0',
    ).run();
    return result.changes;
  }

  getUnsyncedPublicChunks(limit = 100): StoredChunk[] {
    const rows = this.db.prepare(`
      SELECT * FROM chunks
      WHERE is_public = 1 AND synced_at IS NULL AND local_only = 0
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToChunk(r));
  }

  // ── Vector Search ──────────────────────────────────────────────

  search(queryEmbedding: Float32Array, topK = 5, privateOnly = true): SearchResult[] {
    // Pure JS cosine similarity — no sqlite-vec dependency needed.
    // Superseded chunks (an edit replaced them, or they were retired) never
    // appear in search — only the live version of a document answers.
    const filter = privateOnly
      ? 'WHERE c.is_public = 0 AND c.superseded_at IS NULL'
      : 'WHERE c.superseded_at IS NULL';
    const rows = this.db.prepare(`
      SELECT c.*, e.embedding
      FROM chunks c
      JOIN chunk_embeddings e ON e.chunk_id = c.id
      ${filter}
    `).all() as (Record<string, unknown> & { embedding: Buffer })[];

    const scored = rows.map(row => {
      const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const similarity = cosineSimilarity(queryEmbedding, stored);
      return { row, similarity };
    });

    scored.sort((a, b) => b.similarity - a.similarity);

    return scored.slice(0, topK).map(({ row, similarity }) => ({
      ...this.rowToChunk(row),
      score: similarity,
    }));
  }

  getEmbedding(chunkId: string): Float32Array | null {
    const row = this.db.prepare('SELECT embedding FROM chunk_embeddings WHERE chunk_id = ?').get(chunkId) as { embedding: Buffer } | undefined;
    if (!row) return null;
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  }

  /** All chunks (no embeddings). For the desktop graph / vault views. */
  getAllChunks(): StoredChunk[] {
    const rows = this.db.prepare('SELECT * FROM chunks ORDER BY created_at ASC').all() as Record<string, unknown>[];
    return rows.map(r => this.rowToChunk(r));
  }

  /** All embeddings keyed by chunk id — for pairwise semantic-similarity edges. */
  getAllEmbeddings(): { chunkId: string; embedding: Float32Array }[] {
    const rows = this.db.prepare('SELECT chunk_id, embedding FROM chunk_embeddings').all() as { chunk_id: string; embedding: Buffer }[];
    return rows.map(r => ({
      chunkId: r.chunk_id,
      embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
    }));
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): { totalChunks: number; publicChunks: number; privateChunks: number; localChunks: number; unsyncedChunks: number; pendingChunks: number; syncedChunks: number } {
    const total = (this.db.prepare('SELECT COUNT(*) as n FROM chunks').get() as { n: number }).n;
    const pub = (this.db.prepare('SELECT COUNT(*) as n FROM chunks WHERE is_public = 1 AND local_only = 0').get() as { n: number }).n;
    const local = (this.db.prepare('SELECT COUNT(*) as n FROM chunks WHERE local_only = 1').get() as { n: number }).n;
    const unsynced = (this.db.prepare('SELECT COUNT(*) as n FROM chunks WHERE is_public = 1 AND synced_at IS NULL AND local_only = 0').get() as { n: number }).n;
    // Any non-local chunk (private or public) not yet pushed to RDK Central.
    const pending = (this.db.prepare('SELECT COUNT(*) as n FROM chunks WHERE synced_at IS NULL AND local_only = 0').get() as { n: number }).n;
    const synced = (this.db.prepare('SELECT COUNT(*) as n FROM chunks WHERE synced_at IS NOT NULL AND local_only = 0').get() as { n: number }).n;
    // private = on-network private chunks (exclude local-only, counted separately)
    return { totalChunks: total, publicChunks: pub, privateChunks: total - pub - local, localChunks: local, unsyncedChunks: unsynced, pendingChunks: pending, syncedChunks: synced };
  }

  // ── Tip Queue ──────────────────────────────────────────────────

  enqueueTip(tip: Omit<TipQueueEntry, 'id' | 'status' | 'createdAt'>): string {
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO tip_queue (id, chunk_id, provider_node_id, amount_usdc, chain, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, tip.chunkId, tip.providerNodeId, tip.amountUsdc, tip.chain, new Date().toISOString());
    return id;
  }

  getPendingTips(): TipQueueEntry[] {
    const rows = this.db.prepare('SELECT * FROM tip_queue WHERE status = ?').all('pending') as Record<string, unknown>[];
    return rows.map(r => this.rowToTip(r));
  }

  settleTip(id: string, txHash: string): void {
    this.db.prepare(`
      UPDATE tip_queue SET status = 'settled', tx_hash = ?, settled_at = ? WHERE id = ?
    `).run(txHash, new Date().toISOString(), id);
  }

  failTip(id: string): void {
    this.db.prepare("UPDATE tip_queue SET status = 'failed' WHERE id = ?").run(id);
  }

  getPendingTipTotal(): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(amount_usdc), 0) as total FROM tip_queue WHERE status = 'pending'").get() as { total: number };
    return row.total;
  }

  // ── Query Log ──────────────────────────────────────────────────

  /**
   * Record a query. `matchedChunkId` (top hit) is kept in query_log for
   * back-compat; the full ranked set (via `matchedChunks`) is written to
   * retrieval_edges so the desktop graph can draw every query→chunk edge and the
   * inspector can list what a chunk was retrieved for. Returns the query id.
   */
  logQuery(entry: {
    queryText: string;
    source: string;
    matchedChunkId?: string;
    matchedChunks?: { id: string; score: number }[];
    latencyMs: number;
  }): string {
    const queryId = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO query_log (id, query_text, source, matched_chunk_id, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      queryId, entry.queryText, entry.source,
      entry.matchedChunkId ?? entry.matchedChunks?.[0]?.id ?? null, entry.latencyMs, now,
    );

    const edges = entry.matchedChunks
      ?? (entry.matchedChunkId ? [{ id: entry.matchedChunkId, score: 1 }] : []);
    if (edges.length > 0) {
      const insert = this.db.prepare(`
        INSERT INTO retrieval_edges (id, query_id, query_text, chunk_id, rank, score, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const tx = this.db.transaction((rows: { id: string; score: number }[]) => {
        rows.forEach((r, i) =>
          insert.run(crypto.randomUUID(), queryId, entry.queryText, r.id, i, r.score, entry.source, now));
      });
      tx(edges);
    }
    return queryId;
  }

  /** Recent queries this node issued (newest first) — graph query nodes / activity. */
  getQueryLog(limit = 100): {
    id: string; queryText: string; source: string; matchedChunkId?: string; latencyMs: number; createdAt: Date;
  }[] {
    const rows = this.db.prepare(`
      SELECT id, query_text, source, matched_chunk_id, latency_ms, created_at
      FROM query_log ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      queryText: (r.query_text as string) ?? '',
      source: (r.source as string) ?? '',
      matchedChunkId: (r.matched_chunk_id as string) ?? undefined,
      latencyMs: (r.latency_ms as number) ?? 0,
      createdAt: new Date(r.created_at as string),
    }));
  }

  /** Distinct queries that retrieved a given chunk (inspector "RETRIEVED FOR"). */
  getRetrievalsForChunk(chunkId: string, limit = 50): {
    queryText: string; count: number; lastAt: Date; bestScore: number;
  }[] {
    const rows = this.db.prepare(`
      SELECT query_text, COUNT(*) AS count, MAX(created_at) AS last_at, MAX(score) AS best_score
      FROM retrieval_edges WHERE chunk_id = ?
      GROUP BY query_text ORDER BY last_at DESC LIMIT ?
    `).all(chunkId, limit) as Record<string, unknown>[];
    return rows.map(r => ({
      queryText: (r.query_text as string) ?? '',
      count: (r.count as number) ?? 0,
      lastAt: new Date(r.last_at as string),
      bestScore: (r.best_score as number) ?? 0,
    }));
  }

  /** All retrieval edges (query_id → chunk_id) for building the graph. */
  getRetrievalEdges(limit = 2000): {
    queryId: string; queryText: string; chunkId: string; rank: number; score: number; source: string;
  }[] {
    const rows = this.db.prepare(`
      SELECT query_id, query_text, chunk_id, rank, score, source
      FROM retrieval_edges ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map(r => ({
      queryId: r.query_id as string,
      queryText: (r.query_text as string) ?? '',
      chunkId: r.chunk_id as string,
      rank: (r.rank as number) ?? 0,
      score: (r.score as number) ?? 0,
      source: (r.source as string) ?? '',
    }));
  }

  /** Retrieval count per chunk — used to size graph nodes. */
  getRetrievalCounts(): Record<string, number> {
    const rows = this.db.prepare(`
      SELECT chunk_id, COUNT(*) AS n FROM retrieval_edges GROUP BY chunk_id
    `).all() as { chunk_id: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.chunk_id] = r.n;
    return out;
  }

  // ── Helpers ────────────────────────────────────────────────────

  private rowToChunk(row: Record<string, unknown>): StoredChunk {
    return {
      id: row.id as string,
      title: row.title as string,
      content: row.content as string,
      summary: row.summary as string | undefined,
      domain: row.domain as string | undefined,
      categories: JSON.parse((row.categories as string) || '[]') as string[],
      isPublic: (row.is_public as number) === 1,
      isEncrypted: (row.is_encrypted as number) === 1,
      isLocalOnly: (row.local_only as number) === 1,
      syncedAt: row.synced_at ? new Date(row.synced_at as string) : undefined,
      qualityScore: row.quality_score as number,
      sourcePath: row.source_path as string | undefined,
      sourceAdapter: row.source_adapter as string | undefined,
      supersedes: (row.supersedes as string | null) ?? undefined,
      supersededAt: row.superseded_at ? new Date(row.superseded_at as string) : undefined,
      version: (row.version as number | null) ?? 1,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  private rowToTip(row: Record<string, unknown>): TipQueueEntry {
    return {
      id: row.id as string,
      chunkId: row.chunk_id as string,
      providerNodeId: row.provider_node_id as string,
      amountUsdc: row.amount_usdc as number,
      chain: row.chain as string,
      status: row.status as 'pending' | 'settled' | 'failed',
      txHash: row.tx_hash as string | undefined,
      createdAt: new Date(row.created_at as string),
      settledAt: row.settled_at ? new Date(row.settled_at as string) : undefined,
    };
  }

  getSourcePaths(): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT source_path FROM chunks WHERE source_path IS NOT NULL',
    ).all() as { source_path: string }[];
    return rows.map(r => r.source_path);
  }

  getAllPrivateEncryptedChunks(): StoredChunk[] {
    const rows = this.db.prepare(`
      SELECT * FROM chunks WHERE is_public = 0 AND is_encrypted = 1
    `).all() as Record<string, unknown>[];
    return rows.map(r => this.rowToChunk(r));
  }

  updateChunkContent(id: string, newContent: string): void {
    this.db.prepare(`
      UPDATE chunks SET content = ?, updated_at = ? WHERE id = ?
    `).run(newContent, new Date().toISOString(), id);
  }

  getUnsyncedEncryptedChunks(limit = 100): StoredChunk[] {
    const rows = this.db.prepare(`
      SELECT * FROM chunks
      WHERE is_public = 0 AND is_encrypted = 1 AND synced_at IS NULL AND local_only = 0
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToChunk(r));
  }

  /**
   * All locally-indexed chunks not yet pushed to RDK Central — PUBLIC and
   * PRIVATE alike. Both must sync their embedding + metadata (only the content
   * body stays on the node); private chunks without their embedding on Central
   * are invisible to cross-node/team search.
   */
  getUnsyncedChunks(limit = 100): StoredChunk[] {
    const rows = this.db.prepare(`
      SELECT * FROM chunks
      WHERE synced_at IS NULL AND local_only = 0
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToChunk(r));
  }

  /** Clear sync state so the next sync re-sends every chunk (rdk vault:sync --force). */
  resetSyncState(): number {
    // Local-only chunks are never synced — leave them out of the re-sync.
    return this.db.prepare('UPDATE chunks SET synced_at = NULL WHERE local_only = 0').run().changes;
  }

  close() {
    this.db.close();
  }
}

// ── Utility ────────────────────────────────────────────────────────────────

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
