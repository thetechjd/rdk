// packages/rdk-core/src/store/local-store.ts
// Single ~/.rdk/index.db file. Zero config. Created by rdk init.
// Uses sqlite-vec virtual table for ANN search (cosine similarity).

import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import { queryCache } from '../query/cache.js';

/** Bump when `migrateQueryPipelineV*` gains a step. Migrations are additive and
 *  idempotent; each runs only when the stored version is below it. */
const QUERY_PIPELINE_SCHEMA_VERSION = 2;

export interface StoredChunk {
  id: string;
  title: string;
  /** The title of the document this chunk came from (frontmatter/H1), as
   *  opposed to `title`, which is `<document> — <section>`. Undefined for rows
   *  indexed before this existed; consumers fall back to parsing `title`. */
  docTitle?: string;
  /** Hash of the complete source document version this search fragment indexes. */
  documentHash?: string;
  /** Stable position inside the document's hidden search index. */
  chunkIndex?: number;
  chunkCount?: number;
  documentTokens?: number;
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
  riskScore?: number;
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
  /**
   * Chunk id (content hash) of the PUBLISHED chunk this content came from, when
   * it was retrieved from another node rather than written here.
   *
   * Distinct from `supersedes`, which links versions of your own document. This
   * crosses nodes: it records that someone else's work seeded this one, so the
   * original author keeps a share of what a derivative earns. Editing a
   * retrieved file changes its hash and makes it genuinely new work — this is
   * the only thing that remembers where it started.
   */
  derivedFrom?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SearchResult extends StoredChunk {
  score: number; // cosine similarity 0-1
}

/** The authoritative user-facing object. Chunks are only an index over this. */
export interface StoredDocument {
  hash: string;
  title: string;
  content: string;
  isPublic: boolean;
  isEncrypted: boolean;
  sourcePath?: string;
  sourceAdapter?: string;
  version: number;
  tokenEstimate: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A document without its body — enough to list, name, and pin it. */
export interface DocumentSummary {
  hash: string;
  title: string;
  isPublic: boolean;
  isEncrypted: boolean;
  sourcePath?: string;
  version: number;
  /** Byte length of the stored content — ciphertext when encrypted, which is
   *  what Central would hold and bill for if this document were pinned. */
  sizeBytes: number;
  updatedAt: Date;
}

/** One version of a document — the chunks of a single indexing pass, rolled up. */
export interface DocumentVersion {
  version: number;
  chunkCount: number;
  chunkIds: string[];
  state: 'public' | 'private';
  superseded: boolean;
  createdAt: Date;
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
    this.initQueryPipeline();
  }

  private initQueryPipeline(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        component TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      );
    `);
    const row = this.db.prepare(
      `SELECT version FROM schema_versions WHERE component = 'query_pipeline'`,
    ).get() as { version: number } | undefined;
    const version = row?.version ?? 0;
    if (version >= QUERY_PIPELINE_SCHEMA_VERSION) return;

    if (version < 1) this.migrateQueryPipelineV1();
    if (version < 2) this.migrateQueryPipelineV2();

    this.db.prepare(`
      INSERT INTO schema_versions(component, version) VALUES ('query_pipeline', ?)
      ON CONFLICT(component) DO UPDATE SET version = excluded.version
    `).run(QUERY_PIPELINE_SCHEMA_VERSION);
  }

  private migrateQueryPipelineV1(): void {
    try { this.db.exec(`ALTER TABLE chunks ADD COLUMN risk_score REAL DEFAULT 0`); } catch { /* exists */ }
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        title, doc_title, content, summary,
        content='chunks', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, title, doc_title, content, summary)
        VALUES (new.rowid, new.title, new.doc_title, new.content, new.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, title, doc_title, content, summary)
        VALUES ('delete', old.rowid, old.title, old.doc_title, old.content, old.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_fts_update AFTER UPDATE OF title, doc_title, content, summary ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, title, doc_title, content, summary)
        VALUES ('delete', old.rowid, old.title, old.doc_title, old.content, old.summary);
        INSERT INTO chunks_fts(rowid, title, doc_title, content, summary)
        VALUES (new.rowid, new.title, new.doc_title, new.content, new.summary);
      END;
      CREATE TABLE IF NOT EXISTS chunk_minhash (
        chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        signature BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS index_rate_buckets (
        node_id TEXT PRIMARY KEY,
        tokens REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild');
    `);
  }

  /** v2: indexes backing the composite-score authority lookups and the
   *  domain-filtered retrieval legs. */
  private migrateQueryPipelineV2(): void {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tip_queue_chunk ON tip_queue(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_domain_live ON chunks(domain, superseded_at);
    `);
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
        doc_title     TEXT,
        document_hash TEXT,
        chunk_index   INTEGER,
        chunk_count   INTEGER,
        document_tokens INTEGER,
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
        derived_from  TEXT,
        version       INTEGER DEFAULT 1,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id    TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        embedding   BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        hash           TEXT PRIMARY KEY,
        title          TEXT NOT NULL,
        content        TEXT NOT NULL,
        is_public      INTEGER DEFAULT 0,
        is_encrypted   INTEGER DEFAULT 0,
        source_path    TEXT,
        source_adapter TEXT,
        version        INTEGER DEFAULT 1,
        token_estimate INTEGER DEFAULT 0,
        created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
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

    // Migration: versioning columns (supersedes lineage) + the document title
    // for existing databases
    for (const ddl of [
      `ALTER TABLE chunks ADD COLUMN supersedes TEXT`,
      `ALTER TABLE chunks ADD COLUMN superseded_at DATETIME`,
      `ALTER TABLE chunks ADD COLUMN version INTEGER DEFAULT 1`,
      `ALTER TABLE chunks ADD COLUMN doc_title TEXT`,
      `ALTER TABLE chunks ADD COLUMN derived_from TEXT`,
      `ALTER TABLE chunks ADD COLUMN document_hash TEXT`,
      `ALTER TABLE chunks ADD COLUMN chunk_index INTEGER`,
      `ALTER TABLE chunks ADD COLUMN chunk_count INTEGER`,
      `ALTER TABLE chunks ADD COLUMN document_tokens INTEGER`,
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
      // `synced_at` is cleared whenever VISIBILITY changes, because that is the
      // one edit Central must be told about and cannot infer.
      //
      // It was previously absent from this statement entirely, so a caller
      // passing `syncedAt: undefined` to mean "re-queue this" was silently
      // ignored. Publishing a chunk therefore flipped it to public LOCALLY and
      // left synced_at set — and since the sync only picks up rows with
      // synced_at IS NULL, the promotion never reached Central. The desktop
      // showed the file as public forever while the network still held it as
      // private, so nobody could retrieve it and the owner had no way to tell.
      //
      // In SQLite the right-hand side of SET sees the row's OLD values, so this
      // compares old visibility against the new one being written.
      this.db.prepare(`
        UPDATE chunks SET
          title = ?, doc_title = ?, document_hash = ?, chunk_index = ?, chunk_count = ?,
          document_tokens = ?, content = ?, summary = ?, domain = ?, categories = ?,
          is_public = ?, is_encrypted = ?, local_only = ?, quality_score = ?, source_path = ?,
          source_adapter = ?, supersedes = ?, version = ?, derived_from = ?, updated_at = ?,
          synced_at = CASE
            WHEN is_public <> ? OR is_encrypted <> ? OR local_only <> ? THEN NULL
            ELSE synced_at
          END
        WHERE id = ?
      `).run(
        chunk.title, chunk.docTitle ?? null, chunk.documentHash ?? null,
        chunk.chunkIndex ?? null, chunk.chunkCount ?? null, chunk.documentTokens ?? null,
        chunk.content, chunk.summary ?? null, chunk.domain ?? null,
        JSON.stringify(chunk.categories), chunk.isPublic ? 1 : 0,
        chunk.isEncrypted ? 1 : 0, chunk.isLocalOnly ? 1 : 0, chunk.qualityScore, chunk.sourcePath ?? null,
        chunk.sourceAdapter ?? null, chunk.supersedes ?? null, chunk.version ?? 1,
        chunk.derivedFrom ?? null, now,
        // the CASE comparands — the NEW visibility
        chunk.isPublic ? 1 : 0, chunk.isEncrypted ? 1 : 0, chunk.isLocalOnly ? 1 : 0,
        id,
      );
    } else {
      this.db.prepare(`
        INSERT INTO chunks (id, title, doc_title, content, summary, domain, categories,
          document_hash, chunk_index, chunk_count, document_tokens,
          is_public, is_encrypted, local_only, quality_score, source_path, source_adapter,
          supersedes, version, derived_from, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, chunk.title, chunk.docTitle ?? null, chunk.content, chunk.summary ?? null,
        chunk.domain ?? null, JSON.stringify(chunk.categories), chunk.documentHash ?? null,
        chunk.chunkIndex ?? null, chunk.chunkCount ?? null, chunk.documentTokens ?? null,
        chunk.isPublic ? 1 : 0, chunk.isEncrypted ? 1 : 0, chunk.isLocalOnly ? 1 : 0, chunk.qualityScore,
        chunk.sourcePath ?? null, chunk.sourceAdapter ?? null,
        chunk.supersedes ?? null, chunk.version ?? 1, chunk.derivedFrom ?? null, now, now,
      );
    }

    // Store embedding as raw blob (Float32Array → Buffer)
    const embeddingBuffer = Buffer.from(embedding.buffer);
    this.db.prepare(`
      INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)
    `).run(id, embeddingBuffer);

    return id;
  }

  saveDocument(doc: Omit<StoredDocument, 'createdAt' | 'updatedAt'>): string {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO documents (
        hash, title, content, is_public, is_encrypted, source_path,
        source_adapter, version, token_estimate, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        is_public = excluded.is_public,
        is_encrypted = excluded.is_encrypted,
        source_path = excluded.source_path,
        source_adapter = excluded.source_adapter,
        version = excluded.version,
        token_estimate = excluded.token_estimate,
        updated_at = excluded.updated_at
    `).run(
      doc.hash, doc.title, doc.content, doc.isPublic ? 1 : 0,
      doc.isEncrypted ? 1 : 0, doc.sourcePath ?? null, doc.sourceAdapter ?? null,
      doc.version, doc.tokenEstimate, now, now,
    );
    return doc.hash;
  }

  getDocument(hash: string): StoredDocument | null {
    const row = this.db.prepare('SELECT * FROM documents WHERE hash = ?').get(hash) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      hash: row.hash as string,
      title: row.title as string,
      content: row.content as string,
      isPublic: row.is_public === 1,
      isEncrypted: row.is_encrypted === 1,
      sourcePath: row.source_path as string | undefined,
      sourceAdapter: row.source_adapter as string | undefined,
      version: (row.version as number) ?? 1,
      tokenEstimate: (row.token_estimate as number) ?? 0,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  /** Indexed documents, most recently updated first. Content is deliberately
   *  omitted — callers listing documents want to name them, not load them. */
  listDocuments(limit = 200): DocumentSummary[] {
    const rows = this.db.prepare(`
      SELECT hash, title, is_public, is_encrypted, source_path, version,
             LENGTH(content) AS size_bytes, updated_at
      FROM documents
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.rowToDocumentSummary(row));
  }

  /**
   * Resolve what a user typed to indexed documents.
   *
   * Accepts a document hash (or unambiguous prefix), a source path, or a
   * filename/title fragment, because someone pinning a note types its name far
   * more often than its sha256. Returns every match so the caller can refuse to
   * guess when a fragment is ambiguous.
   */
  findDocuments(target: string): DocumentSummary[] {
    const needle = target.trim();
    if (!needle) return [];
    const rows = this.db.prepare(`
      SELECT hash, title, is_public, is_encrypted, source_path, version,
             LENGTH(content) AS size_bytes, updated_at
      FROM documents
      WHERE hash = ?
         OR hash LIKE ? || '%'
         OR source_path = ?
         OR source_path LIKE '%' || ?
         OR title LIKE '%' || ? || '%'
      ORDER BY updated_at DESC
    `).all(needle, needle, needle, needle, needle) as Record<string, unknown>[];
    return rows.map((row) => this.rowToDocumentSummary(row));
  }

  private rowToDocumentSummary(row: Record<string, unknown>): DocumentSummary {
    return {
      hash: row.hash as string,
      title: row.title as string,
      isPublic: row.is_public === 1,
      isEncrypted: row.is_encrypted === 1,
      sourcePath: (row.source_path as string) ?? undefined,
      version: (row.version as number) ?? 1,
      sizeBytes: (row.size_bytes as number) ?? 0,
      updatedAt: new Date(row.updated_at as string),
    };
  }

  getChunk(id: string): StoredChunk | null {
    const row = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToChunk(row);
  }

  /**
   * The lineage already recorded for a file, if any.
   *
   * Editing a retrieved document mints new content hashes — that is precisely
   * what makes the result the editor's own work — so the new chunks would
   * otherwise lose all trace of what they grew out of, and the original author
   * would silently stop being credited on the first edit. The file path is the
   * only thing that survives a re-chunk, so lineage is carried across on it.
   */
  getDerivedFromForSource(sourcePath: string): string | undefined {
    const row = this.db.prepare(`
      SELECT derived_from FROM chunks
      WHERE source_path = ? AND derived_from IS NOT NULL
      ORDER BY created_at ASC LIMIT 1
    `).get(sourcePath) as { derived_from: string } | undefined;
    return row?.derived_from;
  }

  /** Absolute path of the SQLite file this store is operating on. */
  getDatabasePath(): string {
    return this.dbPath;
  }

  /** Deletes a chunk; returns whether a row actually existed and was removed. */
  deleteChunk(id: string): boolean {
    const result = this.db.prepare('DELETE FROM chunks WHERE id = ?').run(id);
    if (result.changes > 0) queryCache.clear();
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

  /** One entry per VERSION of a document, newest first.
   *
   *  `getVersions` returns chunks, and a document is many chunks — so callers
   *  that wanted a version history got N identical-looking rows per version
   *  (five chunks of an unedited note read as five "v1" entries). Grouping is
   *  the caller's real intent, so it belongs here rather than in each UI. */
  getDocumentVersions(sourcePath: string, sourceAdapter?: string): DocumentVersion[] {
    return groupChunkVersions(this.getVersions(sourcePath, sourceAdapter));
  }

  /** Highest version number in a document series (0 when none indexed yet). */
  getLatestVersion(sourcePath: string): number {
    const row = this.db.prepare(
      `SELECT MAX(version) AS v FROM chunks WHERE source_path = ?`,
    ).get(sourcePath) as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  /** Fill in metadata that didn't exist when a chunk was first indexed, and
   *  re-queue it for sync so Central picks the new values up. Only writes the
   *  fields provided; never touches content or embeddings. */
  backfillMetadata(id: string, fields: { summary?: string; docTitle?: string }): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.summary !== undefined) { sets.push('summary = ?'); params.push(fields.summary); }
    if (fields.docTitle !== undefined) { sets.push('doc_title = ?'); params.push(fields.docTitle); }
    if (sets.length === 0) return false;
    params.push(id);
    const result = this.db.prepare(
      `UPDATE chunks SET ${sets.join(', ')}, synced_at = NULL WHERE id = ?`,
    ).run(...params as never[]);
    return result.changes > 0;
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
        AND superseded_at IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToChunk(r));
  }

  // ── Vector Search ──────────────────────────────────────────────

  search(queryEmbedding: Float32Array, topK = 5, privateOnly = true, domain?: string): SearchResult[] {
    // Pure JS cosine similarity — no sqlite-vec dependency needed.
    // Superseded chunks (an edit replaced them, or they were retired) never
    // appear in search — only the live version of a document answers.
    const conditions = ['c.superseded_at IS NULL'];
    if (privateOnly) conditions.push('c.is_public = 0');
    if (domain) conditions.push('c.domain = ?');
    const rows = this.db.prepare(`
      SELECT c.*, e.embedding
      FROM chunks c
      JOIN chunk_embeddings e ON e.chunk_id = c.id
      WHERE ${conditions.join(' AND ')}
    `).all(...(domain ? [domain] : [])) as (Record<string, unknown> & { embedding: Buffer })[];

    const scored = rows.map(row => {
      const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const similarity = cosineSimilarity(queryEmbedding, stored);
      return { row, similarity };
    });

    scored.sort((a, b) => b.similarity - a.similarity);

    const results: SearchResult[] = [];
    const seenDocuments = new Set<string>();
    for (const { row, similarity } of scored) {
      const chunk = this.rowToChunk(row);
      const identity = chunk.documentHash ?? chunk.id;
      if (seenDocuments.has(identity)) continue;
      seenDocuments.add(identity);

      const document = chunk.documentHash ? this.getDocument(chunk.documentHash) : null;
      results.push({
        ...chunk,
        ...(document
          ? {
              title: document.title,
              docTitle: document.title,
              content: document.content,
              isPublic: document.isPublic,
              isEncrypted: document.isEncrypted,
              riskScore: this.getDocumentRisk(chunk.documentHash!),
            }
          : {}),
        score: similarity,
      });
      if (results.length >= topK) break;
    }
    return results;
  }

  getEmbedding(chunkId: string): Float32Array | null {
    const row = this.db.prepare('SELECT embedding FROM chunk_embeddings WHERE chunk_id = ?').get(chunkId) as { embedding: Buffer } | undefined;
    if (!row) return null;
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  }

  lexicalSearch(query: string, topK: number, domain?: string): Array<StoredChunk & { lexicalScore: number }> {
    const terms = query.match(/[\p{L}\p{N}.\-]+/gu) ?? [];
    if (terms.length === 0) return [];
    const ftsQuery = terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
    const rows = this.db.prepare(`
      SELECT c.*, bm25(chunks_fts) AS lexical_rank
      FROM chunks_fts
      JOIN chunks c ON c.rowid = chunks_fts.rowid
      WHERE chunks_fts MATCH ? AND c.superseded_at IS NULL${domain ? ' AND c.domain = ?' : ''}
      ORDER BY lexical_rank ASC
      LIMIT ?
    `).all(...(domain ? [ftsQuery, domain, topK] : [ftsQuery, topK])) as Record<string, unknown>[];
    const results: Array<StoredChunk & { lexicalScore: number }> = [];
    const seenDocuments = new Set<string>();
    for (const row of rows) {
      const chunk = this.rowToChunk(row);
      const identity = chunk.documentHash ?? chunk.id;
      if (seenDocuments.has(identity)) continue;
      seenDocuments.add(identity);
      const document = chunk.documentHash ? this.getDocument(chunk.documentHash) : null;
      results.push({
        ...chunk,
        ...(document ? { title: document.title, docTitle: document.title, content: document.content } : {}),
        riskScore: chunk.documentHash ? this.getDocumentRisk(chunk.documentHash) : chunk.riskScore,
        lexicalScore: 1 / (1 + Math.max(0, Number(row.lexical_rank))),
      });
      if (results.length >= topK) break;
    }
    return results;
  }

  getDocumentRisk(documentHash: string): number {
    const row = this.db.prepare(`SELECT MAX(risk_score) AS risk FROM chunks WHERE document_hash = ?`)
      .get(documentHash) as { risk: number | null } | undefined;
    return Number(row?.risk ?? 0);
  }

  getVocabulary(): { words: string[]; chunkCount: number } {
    const rows = this.db.prepare(`
      SELECT title, doc_title, summary FROM chunks WHERE superseded_at IS NULL
    `).all() as Array<{ title: string; doc_title: string | null; summary: string | null }>;
    const words = rows.flatMap((row) => [row.title, row.doc_title ?? '', row.summary ?? '']);
    return { words, chunkCount: rows.length };
  }

  /** Authority inputs for one chunk: total retrieval edges and non-failed tips.
   *  Two indexed COUNT(*)s — the composite score needs both counts, not the
   *  per-query grouping `getRetrievalsForChunk` returns. */
  getAuthorityCounts(chunkId: string): { retrievalCount: number; tipCount: number } {
    const retrievals = this.db.prepare(
      `SELECT COUNT(*) AS n FROM retrieval_edges WHERE chunk_id = ?`,
    ).get(chunkId) as { n: number } | undefined;
    const tips = this.db.prepare(
      `SELECT COUNT(*) AS n FROM tip_queue WHERE chunk_id = ? AND status != 'failed'`,
    ).get(chunkId) as { n: number } | undefined;
    return { retrievalCount: Number(retrievals?.n ?? 0), tipCount: Number(tips?.n ?? 0) };
  }

  /** Writes only the summary. Deliberately leaves synced_at alone: a backfill is
   *  not an edit, and re-queueing every chunk would push private content's
   *  freshly-written summary at Central on the next sync. */
  setChunkSummary(id: string, summary: string): void {
    this.db.prepare(`UPDATE chunks SET summary = ? WHERE id = ?`).run(summary, id);
    queryCache.clear();
  }

  /** Live chunks with no usable summary, for the backfill script. */
  getChunksMissingSummary(): Array<{ id: string; content: string; isEncrypted: boolean; title: string }> {
    return this.db.prepare(`
      SELECT id, content, is_encrypted, title FROM chunks
      WHERE superseded_at IS NULL AND (summary IS NULL OR trim(summary) = '')
    `).all().map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: r.id as string,
        content: r.content as string,
        isEncrypted: Boolean(r.is_encrypted),
        title: r.title as string,
      };
    });
  }

  setChunkRisk(id: string, riskScore: number): void {
    this.db.prepare(`UPDATE chunks SET risk_score = ? WHERE id = ?`).run(riskScore, id);
  }

  setChunkMinHash(id: string, signature: Uint32Array): void {
    this.db.prepare(`INSERT OR REPLACE INTO chunk_minhash(chunk_id, signature) VALUES (?, ?)`)
      .run(id, Buffer.from(signature.buffer, signature.byteOffset, signature.byteLength));
  }

  /** Carries document_hash and source_path so dedup can tell a genuine duplicate
   *  from a node re-indexing its own file — an edit mints new chunk ids, so
   *  without lineage the new version looks like a duplicate of the old one. */
  getDedupCandidates(): Array<{
    chunkId: string;
    signature: Uint32Array;
    embedding: Float32Array;
    documentHash?: string;
    sourcePath?: string;
  }> {
    const rows = this.db.prepare(`
      SELECT m.chunk_id, m.signature, e.embedding, c.document_hash, c.source_path
      FROM chunk_minhash m
      JOIN chunk_embeddings e ON e.chunk_id = m.chunk_id
      JOIN chunks c ON c.id = m.chunk_id
    `).all() as Array<{
      chunk_id: string; signature: Buffer; embedding: Buffer;
      document_hash: string | null; source_path: string | null;
    }>;
    return rows.map((row) => ({
      chunkId: row.chunk_id,
      signature: new Uint32Array(row.signature.buffer, row.signature.byteOffset, row.signature.byteLength / 4),
      embedding: new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4),
      ...(row.document_hash ? { documentHash: row.document_hash } : {}),
      ...(row.source_path ? { sourcePath: row.source_path } : {}),
    }));
  }

  getIndexRateState(nodeId: string): { tokens: number; updatedAt: number } | undefined {
    const row = this.db.prepare(`SELECT tokens, updated_at FROM index_rate_buckets WHERE node_id = ?`)
      .get(nodeId) as { tokens: number; updated_at: number } | undefined;
    return row ? { tokens: row.tokens, updatedAt: row.updated_at } : undefined;
  }

  setIndexRateState(nodeId: string, state: { tokens: number; updatedAt: number }): void {
    this.db.prepare(`
      INSERT INTO index_rate_buckets(node_id, tokens, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at
    `).run(nodeId, state.tokens, state.updatedAt);
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
    // Counts reflect LIVE chunks only. Superseded rows (an edit replaced them, or
    // they were retired/unpublished) are kept for version history (getVersions)
    // but never counted as active — otherwise every edit inflates the totals and
    // the local count drifts above what the network actually stores (central
    // hard-deletes replaced private chunks, leaving no ghost). `superseded_at`
    // is the same live/dead boundary that `search()` already applies.
    const live = 'superseded_at IS NULL';
    const total = (this.db.prepare(`SELECT COUNT(*) as n FROM chunks WHERE ${live}`).get() as { n: number }).n;
    const pub = (this.db.prepare(`SELECT COUNT(*) as n FROM chunks WHERE is_public = 1 AND local_only = 0 AND ${live}`).get() as { n: number }).n;
    const local = (this.db.prepare(`SELECT COUNT(*) as n FROM chunks WHERE local_only = 1 AND ${live}`).get() as { n: number }).n;
    const unsynced = (this.db.prepare(`SELECT COUNT(*) as n FROM chunks WHERE is_public = 1 AND synced_at IS NULL AND local_only = 0 AND ${live}`).get() as { n: number }).n;
    // Any non-local chunk (private or public) not yet pushed to RDK Central.
    const pending = (this.db.prepare(`SELECT COUNT(*) as n FROM chunks WHERE synced_at IS NULL AND local_only = 0 AND ${live}`).get() as { n: number }).n;
    const synced = (this.db.prepare(`SELECT COUNT(*) as n FROM chunks WHERE synced_at IS NOT NULL AND local_only = 0 AND ${live}`).get() as { n: number }).n;
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
      // Rows indexed before doc_title existed fall back to the historical
      // convention: everything before the first ' — ' section separator.
      docTitle: ((row.doc_title as string | null) ?? undefined)
        ?? docTitleFromChunkTitle(row.title as string),
      documentHash: (row.document_hash as string | null) ?? undefined,
      chunkIndex: (row.chunk_index as number | null) ?? undefined,
      chunkCount: (row.chunk_count as number | null) ?? undefined,
      documentTokens: (row.document_tokens as number | null) ?? undefined,
      content: row.content as string,
      summary: row.summary as string | undefined,
      domain: row.domain as string | undefined,
      categories: JSON.parse((row.categories as string) || '[]') as string[],
      isPublic: (row.is_public as number) === 1,
      isEncrypted: (row.is_encrypted as number) === 1,
      isLocalOnly: (row.local_only as number) === 1,
      syncedAt: row.synced_at ? new Date(row.synced_at as string) : undefined,
      qualityScore: row.quality_score as number,
      riskScore: Number(row.risk_score ?? 0),
      sourcePath: row.source_path as string | undefined,
      sourceAdapter: row.source_adapter as string | undefined,
      supersedes: (row.supersedes as string | null) ?? undefined,
      supersededAt: row.superseded_at ? new Date(row.superseded_at as string) : undefined,
      version: (row.version as number | null) ?? 1,
      derivedFrom: (row.derived_from as string | null) ?? undefined,
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
        AND superseded_at IS NULL
      ORDER BY created_at DESC
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
        AND superseded_at IS NULL
      -- A just-published document must not sit behind years of private import
      -- backlog. Public first, newest first makes "index and sync" refer to the
      -- document the user just acted on.
      ORDER BY is_public DESC, created_at DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToChunk(r));
  }

  /** Clear sync state so the next sync re-sends every chunk (rdk vault:sync --force). */
  resetSyncState(): number {
    // Local-only chunks are never synced — leave them out of the re-sync.
    return this.db.prepare('UPDATE chunks SET synced_at = NULL WHERE local_only = 0').run().changes;
  }

  /**
   * chunk ids (= content hashes) of LIVE synced chunks (excludes local-only and
   * superseded). The reconcile path checks these against central; superseded
   * rows are intentionally left out so a replaced version is never resurrected.
   */
  getSyncedChunkIds(): string[] {
    return this.getSyncedChunks().map(c => c.id);
  }

  /**
   * The same set, with the visibility this machine believes each chunk has.
   * Reconcile compares this against Central: a chunk can exist on both sides and
   * still be unqueryable because Central thinks it is private, which is exactly
   * the failure an id-only check cannot see.
   */
  getSyncedChunks(): { id: string; isPublic: boolean; documentHash?: string }[] {
    const rows = this.db.prepare(
      'SELECT id, is_public, document_hash FROM chunks WHERE synced_at IS NOT NULL AND local_only = 0 AND superseded_at IS NULL',
    ).all() as { id: string; is_public: number; document_hash: string | null }[];
    return rows.map(r => ({
      id: r.id,
      isPublic: r.is_public === 1,
      ...(r.document_hash ? { documentHash: r.document_hash } : {}),
    }));
  }

  /**
   * Clear synced_at on specific chunks so the next sync re-pushes them. Used by
   * the reconcile/repair path (rdk vault:sync --verify) when central no longer
   * has a chunk the local index believed was synced.
   */
  markUnsynced(ids: string[]): number {
    if (!ids.length) return 0;
    const stmt = this.db.prepare('UPDATE chunks SET synced_at = NULL WHERE id = ?');
    const tx = this.db.transaction((batch: string[]) => {
      let n = 0;
      for (const id of batch) n += stmt.run(id).changes;
      return n;
    });
    return tx(ids);
  }

  close() {
    this.db.close();
  }
}

// ── Utility ────────────────────────────────────────────────────────────────

/**
 * Roll a document's chunks up into one entry per version, newest first.
 *
 * A document is many chunks and every chunk of one indexing pass carries the
 * same version number, so listing chunks as "history" showed N identical rows
 * per version — five chunks of an unedited note read as five separate "v1"
 * entries.
 */
export function groupChunkVersions(chunks: readonly StoredChunk[]): DocumentVersion[] {
  const byVersion = new Map<number, StoredChunk[]>();
  for (const chunk of chunks) {
    const version = chunk.version ?? 1;
    const group = byVersion.get(version) ?? [];
    group.push(chunk);
    byVersion.set(version, group);
  }

  return [...byVersion.entries()]
    .map(([version, group]) => ({
      version,
      chunkCount: group.length,
      chunkIds: group.map(c => c.id),
      // Public if ANY chunk is: promoting a document promotes its chunks, and a
      // partially-promoted document should read as public rather than quietly
      // claim to be private.
      state: group.some(c => c.isPublic) ? ('public' as const) : ('private' as const),
      // Superseded only once EVERY chunk has been replaced — while any chunk
      // still answers queries, the version is still live.
      superseded: group.every(c => !!c.supersededAt),
      createdAt: group.reduce(
        (earliest, c) => (c.createdAt < earliest ? c.createdAt : earliest),
        group[0].createdAt,
      ),
    }))
    .sort((a, b) => b.version - a.version);
}

/**
 * Legacy recovery of a document title from a composite chunk title
 * (`<document> — <section>`). Lossy — it truncates any document title that
 * itself contains ' — ' — which is exactly why `doc_title` exists. Only for
 * rows written before that column; never for new writes.
 */
export function docTitleFromChunkTitle(title: string): string | undefined {
  const head = title.split(' — ')[0]?.trim();
  return head || undefined;
}

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
