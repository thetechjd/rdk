import { describe, it, expect } from 'vitest';
import { groupChunkVersions, type StoredChunk } from '../src/store/local-store.js';

function chunk(over: Partial<StoredChunk> & { id: string }): StoredChunk {
  return {
    title: 'doc — section',
    content: 'body',
    categories: [],
    isPublic: true,
    isEncrypted: false,
    qualityScore: 0,
    version: 1,
    createdAt: new Date('2026-07-27T10:00:00Z'),
    updatedAt: new Date('2026-07-27T10:00:00Z'),
    ...over,
  } as StoredChunk;
}

describe('groupChunkVersions', () => {
  it('collapses one version of a multi-chunk document into a single entry', () => {
    // The reported bug: five chunks of an unedited document rendered as five
    // identical "v1 · public · live" history rows.
    const versions = groupChunkVersions(['a', 'b', 'c', 'd', 'e'].map(id => chunk({ id })));

    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].chunkCount).toBe(5);
    expect(versions[0].superseded).toBe(false);
    expect(versions[0].state).toBe('public');
  });

  it('returns one entry per version, newest first', () => {
    const versions = groupChunkVersions([
      chunk({ id: 'v2a', version: 2 }),
      chunk({ id: 'v2b', version: 2 }),
      chunk({ id: 'v1a', version: 1, supersededAt: new Date('2026-07-27T11:00:00Z') }),
      chunk({ id: 'v1b', version: 1, supersededAt: new Date('2026-07-27T11:00:00Z') }),
      chunk({ id: 'v1c', version: 1, supersededAt: new Date('2026-07-27T11:00:00Z') }),
    ]);

    expect(versions.map(v => v.version)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({ chunkCount: 2, superseded: false });
    expect(versions[1]).toMatchObject({ chunkCount: 3, superseded: true });
  });

  it('treats a version as live while any of its chunks still answers', () => {
    const versions = groupChunkVersions([
      chunk({ id: 'a', supersededAt: new Date('2026-07-27T11:00:00Z') }),
      chunk({ id: 'b' }), // not superseded
    ]);
    expect(versions[0].superseded).toBe(false);
  });

  it('reads as public when any chunk is public', () => {
    const versions = groupChunkVersions([
      chunk({ id: 'a', isPublic: false }),
      chunk({ id: 'b', isPublic: true }),
    ]);
    expect(versions[0].state).toBe('public');
  });

  it('reads as private only when every chunk is private', () => {
    const versions = groupChunkVersions([
      chunk({ id: 'a', isPublic: false }),
      chunk({ id: 'b', isPublic: false }),
    ]);
    expect(versions[0].state).toBe('private');
  });

  it('dates a version from its earliest chunk', () => {
    const versions = groupChunkVersions([
      chunk({ id: 'late', createdAt: new Date('2026-07-27T10:00:05Z') }),
      chunk({ id: 'early', createdAt: new Date('2026-07-27T10:00:01Z') }),
    ]);
    expect(versions[0].createdAt.toISOString()).toBe('2026-07-27T10:00:01.000Z');
  });

  it('defaults a missing version number to 1 rather than dropping the chunk', () => {
    const versions = groupChunkVersions([chunk({ id: 'a', version: undefined })]);
    expect(versions[0]).toMatchObject({ version: 1, chunkCount: 1 });
  });

  it('returns nothing for a document with no chunks', () => {
    expect(groupChunkVersions([])).toEqual([]);
  });
});
