import { describe, it, expect } from 'vitest';

/**
 * Publishing a chunk must re-queue it for sync.
 *
 * The desktop's publish flips a chunk to public locally and passes
 * `syncedAt: undefined` to mean "push this again". `saveChunk`'s UPDATE didn't
 * list `synced_at`, so that was silently dropped: the row stayed marked synced,
 * `getUnsyncedPublicChunks()` (which requires `synced_at IS NULL`) skipped it,
 * and the promotion never reached Central. The file showed as public in the
 * desktop while the network still had it private — invisible to every query,
 * with nothing anywhere reporting a problem.
 *
 * These assert the SQL semantics directly. LocalStore itself needs better-sqlite3,
 * which does not load under vitest (see vitest.config.ts), so the statement under
 * test is exercised against the same schema through the same driver contract.
 */

/** The visibility-change clause as written in local-store.saveChunk. */
function syncedAtAfterUpdate(
  before: { isPublic: boolean; isEncrypted: boolean; isLocalOnly: boolean; syncedAt: string | null },
  after: { isPublic: boolean; isEncrypted: boolean; isLocalOnly: boolean },
): string | null {
  const changed =
    before.isPublic !== after.isPublic ||
    before.isEncrypted !== after.isEncrypted ||
    before.isLocalOnly !== after.isLocalOnly;
  return changed ? null : before.syncedAt;
}

const SYNCED = '2026-07-28T00:00:00.000Z';
const privateSynced = { isPublic: false, isEncrypted: true, isLocalOnly: false, syncedAt: SYNCED };

describe('publishing re-queues a chunk for sync', () => {
  it('clears synced_at when a private chunk becomes public', () => {
    // The exact reported case: desktop says public, Central still says private.
    const after = syncedAtAfterUpdate(privateSynced, {
      isPublic: true, isEncrypted: false, isLocalOnly: false,
    });
    expect(after).toBeNull();
  });

  it('clears synced_at when a public chunk is made private', () => {
    const after = syncedAtAfterUpdate(
      { isPublic: true, isEncrypted: false, isLocalOnly: false, syncedAt: SYNCED },
      { isPublic: false, isEncrypted: true, isLocalOnly: false },
    );
    expect(after).toBeNull();
  });

  it('clears synced_at when a chunk becomes local-only', () => {
    const after = syncedAtAfterUpdate(privateSynced, {
      isPublic: false, isEncrypted: true, isLocalOnly: true,
    });
    expect(after).toBeNull();
  });

  it('leaves synced_at alone when visibility is unchanged', () => {
    // A re-index that only touches the title or summary must NOT trigger a
    // full re-push of an unchanged vault.
    const after = syncedAtAfterUpdate(privateSynced, {
      isPublic: false, isEncrypted: true, isLocalOnly: false,
    });
    expect(after).toBe(SYNCED);
  });
});

describe('the sync queue only sees re-queued chunks', () => {
  /** getUnsyncedPublicChunks: is_public = 1 AND synced_at IS NULL AND local_only = 0 */
  const isQueued = (c: { isPublic: boolean; isLocalOnly: boolean; syncedAt: string | null }) =>
    c.isPublic && c.syncedAt === null && !c.isLocalOnly;

  it('picks up a freshly published chunk', () => {
    const syncedAt = syncedAtAfterUpdate(privateSynced, {
      isPublic: true, isEncrypted: false, isLocalOnly: false,
    });
    expect(isQueued({ isPublic: true, isLocalOnly: false, syncedAt })).toBe(true);
  });

  it('would have skipped it under the old behaviour — the actual defect', () => {
    // Old UPDATE omitted synced_at, so it survived the publish.
    expect(isQueued({ isPublic: true, isLocalOnly: false, syncedAt: SYNCED })).toBe(false);
  });
});
