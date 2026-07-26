import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Spawning the fake CryptoCadet binary is slower than an in-process stub.
    testTimeout: 20_000,
  },
});
