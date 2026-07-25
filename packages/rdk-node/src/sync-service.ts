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
    if (this.syncing) return { synced: 0, errors: 0 };
    this.syncing = true;

    let synced = 0;
    let errors = 0;

    try {
      // Public AND private chunks sync (embedding + metadata); only content stays on-node.
      const unsynced = this.store.getUnsyncedChunks(100);
      if (unsynced.length === 0) return { synced: 0, errors: 0 };

      this.log(`[sync] ${unsynced.length} unsynced chunk(s) found`);

      const jwt = await this.getJwt();

      const payload = [];
      for (const chunk of unsynced) {
        const embedding = this.store.getEmbedding(chunk.id);
        if (!embedding) continue;
        payload.push({
          chunkHash: chunk.id,
          title: chunk.title,                                  // sent for public AND private
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
    } finally {
      this.syncing = false;
    }

    return { synced, errors };
  }

  /**
   * Reconcile local sync state against central: ask which locally-"synced"
   * chunks central still actually stores, and clear `synced_at` on the ones it
   * doesn't (hard-deleted on re-index, lost, or owned by a since-orphaned node).
   * Cleared chunks re-push on the next sync. Returns how many were re-queued.
   *
   * This is the repair path for `rdk vault:sync --verify`; it fixes the "status
   * says N synced but central only has M" drift at its source.
   */
  async verify(): Promise<{ checked: number; missing: number }> {
    const hashes = this.store.getSyncedChunkIds();
    if (hashes.length === 0) return { checked: 0, missing: 0 };

    const jwt = await this.getJwt();
    const existing = new Set<string>();
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
      const { existing: present } = await res.json() as { existing: string[] };
      for (const h of present) existing.add(h);
    }

    const missing = hashes.filter((h) => !existing.has(h));
    if (missing.length) this.store.markUnsynced(missing);
    this.log(`[sync] verify: ${hashes.length} checked, ${missing.length} missing → re-queued`);
    return { checked: hashes.length, missing: missing.length };
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
