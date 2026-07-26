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
