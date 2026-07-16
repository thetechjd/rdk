import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Node-only modules (@rdk/core, @rdk/node, native better-sqlite3, @xenova) are
// externalized — require()'d at runtime from node_modules, not bundled. @rdk/core
// and @rdk/node ship as CommonJS with `export *` re-exports that rollup can't
// statically analyze, so they must stay external. For a distributable, packaging
// uses `pnpm deploy` (see scripts/package.sh) so those workspace deps land in the
// app as real directories instead of out-of-app pnpm symlinks.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ include: ['@xenova/transformers'] })],
    build: {
      lib: { entry: resolve(__dirname, 'electron/main.ts') },
      outDir: 'out/main',
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
