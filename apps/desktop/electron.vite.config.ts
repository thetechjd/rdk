import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Native/node-only modules must NOT be bundled into the main process — they are
// require()'d at runtime from node_modules (rebuilt for Electron's ABI). This is
// what makes better-sqlite3 + @rdk/core work.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ include: ['@retrodeck/mcp', '@xenova/transformers'] })],
    build: {
      lib: { entry: resolve(__dirname, 'electron/main.ts') },
      outDir: 'out/main',
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ include: ['@retrodeck/mcp', '@xenova/transformers'] })],
    build: {
      lib: { entry: resolve(__dirname, 'electron/preload.ts') },
      outDir: 'out/preload',
    },
  },
  renderer: {
    root: '.',
    resolve: {
      alias: { '@': resolve(__dirname, 'src'), '@shared': resolve(__dirname, 'shared') },
    },
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'index.html') },
    },
  },
});
