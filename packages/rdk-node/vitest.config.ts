import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // `config.ts` captures RDK_HOME in a module-level const, so it must be set
    // before the module under test is imported — hence setupFiles, not a hook.
    setupFiles: ['./test/setup.ts'],
  },
});
