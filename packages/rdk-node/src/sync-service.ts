// packages/rdk-node/src/sync-service.ts
// Background sync loop: every N minutes, push unsynced chunks' embedding+metadata
// to RDK Central (only content stays on-node). Moved here from @retrodeck/mcp so
// the CLI, MCP, and desktop share one implementation. UI-agnostic: output goes
// through an injectable `log` callback (defaults to console.error, which is what
// mcp:serve needs — stdout there is JSON-RPC).

import { LocalStore } from '@rdk/core';

export interface SyncConfig {
  enabled: boolean;
  intervalMinutes: number;
  centralApiUrl: string;
  centralApiKey: string;
  /** Progress/diagnostic sink. Defaults to console.error. */
  log?: (message: string) => void;
  /** Called after a sync attempt completes without throwing. */
  onComplete?: (result: { synced: number; errors: number }) => void;
}

/** Response shape of POST /api/v1/chunks/sync (fields optional for old centrals). */
interface SyncResponse {
  synced: number;
  skipped?: number;
  errors?: string[];
  acceptedHashes?: string[];
  limitReached?: boolean;
}

/**
 * The chunk_hashes central actually persisted for a batch. Prefers the explicit
 * `acceptedHashes` list; falls back (old central) to "everything not named in an
 * errors[] entry", whose format is "<hash>: <reason>".
 */
function acceptedFrom(result: SyncResponse, batchHashes: string[]): Set<string> {
  if (Array.isArray(result.acceptedHashes)) return new Set(result.acceptedHashes);
  const failed = new Set(
    (result.errors ?? [])
      .map((e) => e.split(':')[0]?.trim())
      .filter((h): h is string => !!h),
  );
  return new Set(batchHashes.filter((h) => !failed.has(h)));
}

export class SyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private jwtToken?: string;
  private jwtExpiry = 0;
  private readonly log: (message: string) => void;

  constructor(private config: SyncConfig, private store: LocalStore) {
    this.log = config.log ?? ((m) => console.error(m));
  }

  start(): void {
    if (!this.config.enabled) {
      this.log('[sync] auto-sync disabled');
      return;
    }
    this.log(`[sync] starting — every ${this.config.intervalMinutes} minutes`);
    this.syncOnce().catch(e => this.log(`[sync] initial sync failed: ${e}`));
    this.timer = setInterval(
      () => this.syncOnce().catch(e => this.log(`[sync] error: ${e}`)),
      this.config.intervalMinutes * 60 * 1000,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log('[sync] stopped');
  }

  async syncOnce(): Promise<{ synced: number; errors: number }> {
    // Do not pretend a concurrent request synced zero chunks. Indexing often
    // lands while the startup sync is still running; queue one pass behind it
    // so the newly-created rows are pushed before the indexing call completes.
    if (this.syncing) {
      while (this.syncing) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      return this.syncOnce();
    }
    this.syncing = true;

    let synced = 0;
    let errors = 0;
    let failed = false;

    try {
      // Public AND private chunks sync (embedding + metadata); only content stays on-node.
      let unsynced = this.store.getUnsyncedChunks(100);
      if (unsynced.length === 0) {
        // "Nothing to push" is precisely the state drift hides in: a chunk that
        // is marked synced here but stored with the wrong visibility on Central
        // looks like a healthy, idle vault. Reconcile occasionally so a publish
        // that failed to propagate repairs itself, instead of the user having to
        // be told to run `vault:sync --force`. Anything found is re-queued and
        // pushed on the next tick.
        await this.reconcileIfDue();
        // Reconciliation may have discovered metadata drift (notably missing
        // documentHash) and re-queued rows. Push those repairs in this same
        // cycle; waiting for the next timer leaves retrieval fragmented.
        unsynced = this.store.getUnsyncedChunks(100);
        if (unsynced.length === 0) return { synced: 0, errors: 0 };
      }

      this.log(`[sync] ${unsynced.length} unsynced chunk(s) found`);

      const jwt = await this.getJwt();

      const payload = [];
      for (const chunk of unsynced) {
        const embedding = this.store.getEmbedding(chunk.id);
        if (!embedding) continue;
        payload.push({
          chunkHash: chunk.id,
          title: chunk.title,                                  // sent for public AND private
          docTitle: chunk.docTitle,
          documentHash: chunk.documentHash,
          chunkIndex: chunk.chunkIndex,
          chunkCount: chunk.chunkCount,
          documentTokens: chunk.documentTokens,
          summary: chunk.isPublic ? chunk.summary : undefined, // private summary stays on-node
          domain: chunk.domain,
          categories: chunk.categories,
          embedding: Array.from(embedding),
          isPublic: chunk.isPublic,
          isEncrypted: !chunk.isPublic,  // derived boolean (private ⟺ encrypted) — never a SQLite int
          freshnessAt: chunk.updatedAt.toISOString(),
          chunkTokens: Math.ceil(chunk.content.length / 4),
          // Version-series metadata: source doc key + lineage. Old centrals
          // ignore unknown fields; new centrals record the series.
          sourcePath: chunk.sourcePath,
          sourceAdapter: chunk.sourceAdapter,
          supersedesHash: chunk.supersedes,
          // Cross-node lineage: this content grew out of someone else's
          // published document. Central splits the tip along this chain, which
          // is how seeding a topic is rewarded without favouring incumbents in
          // ranking. See StoredChunk.derivedFrom.
          derivedFromHash: chunk.derivedFrom,
          version: chunk.version ?? 1,
        });
      }

      if (payload.length === 0) return { synced: 0, errors: 0 };

      const batchSize = 50;
      for (let i = 0; i < payload.length; i += batchSize) {
        const batch = payload.slice(i, i + batchSize);
        try {
          const res = await fetch(`${this.config.centralApiUrl}/api/v1/chunks/sync`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${jwt}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ chunks: batch }),
            signal: AbortSignal.timeout(30_000),
          });

          if (res.ok) {
            const result = await res.json() as SyncResponse;
            synced += result.synced;
            errors += (result.errors?.length ?? 0);
            // Mark synced ONLY the chunks central actually persisted. Skipped
            // chunks (plan limit, bad embedding, DB error) stay pending so they
            // re-push next cycle — never falsely flagged synced on a 200.
            const accepted = acceptedFrom(result, batch.map(c => c.chunkHash));
            for (const chunk of batch) {
              if (accepted.has(chunk.chunkHash)) this.store.markSynced(chunk.chunkHash);
            }
            // Link version lineage only for chunks that actually synced. Freeze
            // the old row on central (idempotent; the new row just synced here).
            for (const chunk of batch) {
              if (chunk.supersedesHash && accepted.has(chunk.chunkHash)) {
                await this.supersedeOnCentral(chunk.supersedesHash, chunk.chunkHash, jwt);
              }
            }
            this.log(`[sync] batch synced: ${accepted.size} chunk(s)` +
              (accepted.size < batch.length ? ` (${batch.length - accepted.size} left pending)` : ''));
          } else {
            const errorText = await res.text();
            this.log(`[sync] batch failed: HTTP ${res.status} — ${errorText}`);
            errors += batch.length;
          }
        } catch (e) {
          this.log(`[sync] batch request failed: ${(e as Error).message}`);
          errors += batch.length;
        }
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.syncing = false;
      if (!failed) this.config.onComplete?.({ synced, errors });
    }

    return { synced, errors };
  }

  /** Reconcile at most once an hour — it scans the whole synced set. */
  private lastReconcile = 0;
  private static readonly RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

  private async reconcileIfDue(): Promise<void> {
    const now = Date.now();
    if (now - this.lastReconcile < SyncService.RECONCILE_INTERVAL_MS) return;
    this.lastReconcile = now;
    try {
      await this.verify();
    } catch (e) {
      // An old Central without /chunks/exists throws here. Reconcile is a
      // repair path, not a precondition — never let it break normal sync.
      this.log(`[sync] reconcile skipped: ${(e as Error).message}`);
    }
  }

  /**
   * Reconcile local sync state against central: ask which locally-"synced"
   * chunks central still actually stores, and clear `synced_at` on the ones it
   * doesn't (hard-deleted on re-index, lost, or owned by a since-orphaned node)
   * — plus the ones it stores with the WRONG VISIBILITY, which is what a publish
   * that never propagated looks like. Both clear `synced_at` and re-push next
   * sync. Returns how many of each were re-queued.
   *
   * This is the repair path for `rdk vault:sync --verify`; it fixes the "status
   * says N synced but central only has M" drift at its source.
   */
  async verify(): Promise<{ checked: number; missing: number; drifted: number }> {
    const local = this.store.getSyncedChunks();
    const hashes = local.map((c) => c.id);
    if (hashes.length === 0) return { checked: 0, missing: 0, drifted: 0 };

    const jwt = await this.getJwt();
    const existing = new Set<string>();
    /** Central's visibility per hash — absent on old centrals, which omit `chunks`. */
    const remoteMetadata = new Map<string, { isPublic: boolean; documentHash?: string }>();
    const batchSize = 200;
    for (let i = 0; i < hashes.length; i += batchSize) {
      const batch = hashes.slice(i, i + batchSize);
      const res = await fetch(`${this.config.centralApiUrl}/api/v1/chunks/exists`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: batch }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        // Old central without the /exists endpoint → cannot verify; do NOT
        // re-queue everything (that would be a needless full re-sync).
        throw new Error(`verify unsupported by central (HTTP ${res.status})`);
      }
      const { existing: present, chunks } = await res.json() as {
        existing: string[];
        chunks?: { chunkHash: string; isPublic: boolean; documentHash?: string }[];
      };
      for (const h of present) existing.add(h);
      for (const c of chunks ?? []) remoteMetadata.set(c.chunkHash, c);
    }

    const missing = hashes.filter((h) => !existing.has(h));

    // Visibility drift: present on both sides, but Central is serving it with
    // the wrong visibility. This is what a failed publish looks like — the chunk
    // is public here and private there, so it never answers a query and nothing
    // reports an error. Re-queueing pushes the current visibility, which is why
    // publishing now self-heals instead of needing `vault:sync --force`.
    const drifted = local
      .filter((c) => {
        const remote = remoteMetadata.get(c.id);
        return !!remote && (
          remote.isPublic !== c.isPublic
          // This is the exact drift that turned a complete document into five
          // unordered fragments: SyncService used to omit documentHash even
          // though the local index had it.
          || (!!c.documentHash && remote.documentHash !== c.documentHash)
        );
      })
      .map((c) => c.id);

    const repush = [...new Set([...missing, ...drifted])];
    if (repush.length) this.store.markUnsynced(repush);
    this.log(
      `[sync] verify: ${hashes.length} checked, ${missing.length} missing, ` +
      `${drifted.length} visibility drift → ${repush.length} re-queued`,
    );
    return { checked: hashes.length, missing: missing.length, drifted: drifted.length };
  }

  getStatus(): { enabled: boolean; intervalMinutes: number; running: boolean } {
    return {
      enabled: this.config.enabled,
      intervalMinutes: this.config.intervalMinutes,
      running: this.timer !== null,
    };
  }

  /** Link old→new version on central (idempotent; no-op on old centrals). */
  private async supersedeOnCentral(oldHash: string, newHash: string, jwt: string): Promise<void> {
    try {
      await fetch(`${this.config.centralApiUrl}/api/v1/chunks/${oldHash}/supersede`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ newChunkHash: newHash }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      this.log(`[sync] supersede link failed for ${oldHash.slice(0, 8)}…: ${(e as Error).message}`);
    }
  }

  /**
   * Delete a chunk on central (public rows retire server-side, keeping earnings
   * history). Used when an edit replaces private chunks, so their central rows
   * don't orphan. Best-effort: returns false on failure.
   */
  async deleteOnCentral(chunkHash: string): Promise<boolean> {
    try {
      const jwt = await this.getJwt();
      const res = await fetch(`${this.config.centralApiUrl}/api/v1/chunks/${chunkHash}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwt}` },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch (e) {
      this.log(`[sync] central delete failed for ${chunkHash.slice(0, 8)}…: ${(e as Error).message}`);
      return false;
    }
  }

  private async getJwt(): Promise<string> {
    if (this.jwtToken && Date.now() < this.jwtExpiry) return this.jwtToken;
    const res = await fetch(`${this.config.centralApiUrl}/api/v1/nodes/auth`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.centralApiKey}` },
    });
    if (!res.ok) throw new Error(`Auth failed: HTTP ${res.status}`);
    const { jwtToken } = await res.json() as { jwtToken: string };
    this.jwtToken = jwtToken;
    this.jwtExpiry = Date.now() + 55 * 60 * 1000;
    return jwtToken;
  }
}
