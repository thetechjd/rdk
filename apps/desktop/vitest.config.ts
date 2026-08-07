import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        // Main-process / service layer. This is where ~80% of desktop payment
        // logic lives (electron/node-service.ts + @rdk/node's retrodeck-client);
        // the renderer only calls `window.rdk.*`.
        test: {
          name: 'main',
          environment: 'node',
          include: ['test/main/**/*.test.ts'],
          setupFiles: ['./test/main/setup.ts'],
          // These import electron/node-service INSIDE the test body — it has to
          // come after vi.mock('electron') — which drags in @rdk/core, @rdk/node
          // and better-sqlite3 on first use. That transform cost lands on the
          // first test's clock, and on a cold, loaded CI runner it exceeds the
          // 5s default: main has failed intermittently for several commits with
          // a timeout on whichever test happened to import first, while passing
          // every time it was run on its own.
          testTimeout: 30_000,
        },
      },
      {
        // Renderer components (Settings, StatusBar) under jsdom.
        plugins: [react() as never],
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['test/renderer/**/*.test.tsx'],
          setupFiles: ['./test/renderer/setup.ts'],
        },
      },
    ],
  },
});
