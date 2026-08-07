import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Chunking and summarising a 120-section document is CPU-bound and takes
    // ~1.5s per test on a fast dev box — but 3.7s pinned to ONE core, against a
    // 5s default. CI runs four packages' suites concurrently on a 2-core runner,
    // and this repo's CI has been red since exactly the commit that added those
    // tests (dc04148), with no assertion failure to show for it. Timeouts are
    // the one failure mode that reports as "broken" while the code is fine.
    testTimeout: 30_000,
    // Note: better-sqlite3 is a native addon that fails to self-register under
    // vitest, so LocalStore is exercised through its pure helpers
    // (groupChunkVersions, buildChunkTitle) rather than a live database. The
    // rest of the repo mocks @rdk/core for the same reason.
  },
});
