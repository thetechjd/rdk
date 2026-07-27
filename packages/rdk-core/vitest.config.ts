import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Note: better-sqlite3 is a native addon that fails to self-register under
    // vitest, so LocalStore is exercised through its pure helpers
    // (groupChunkVersions, buildChunkTitle) rather than a live database. The
    // rest of the repo mocks @rdk/core for the same reason.
  },
});
