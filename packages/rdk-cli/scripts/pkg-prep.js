#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

fs.mkdirSync('dist/node_modules', { recursive: true });

// ── 1. Copy better-sqlite3 (dereference pnpm symlinks) ──────────────────────
const sqliteSrc = fs.realpathSync('node_modules/better-sqlite3');
fs.cpSync(sqliteSrc, 'dist/node_modules/better-sqlite3', { recursive: true, dereference: true, force: true });
console.log('[pkg:prep] copied better-sqlite3 from', sqliteSrc);

// ── 2. Rebuild better-sqlite3 native addon for Node.js 20 (ABI 115) ─────────
let nodeBin;
if (process.version.startsWith('v20.')) {
  nodeBin = process.execPath;
} else {
  const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', '.nvm');
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  if (fs.existsSync(versionsDir)) {
    const v20s = fs.readdirSync(versionsDir).filter(v => v.startsWith('v20.')).sort().reverse();
    if (v20s.length > 0) nodeBin = path.join(versionsDir, v20s[0], 'bin', 'node');
  }
}
if (!nodeBin) throw new Error('Node.js 20.x not found. Install via nvm: nvm install 20');

const npxBin = path.join(path.dirname(nodeBin), process.platform === 'win32' ? 'npx.cmd' : 'npx');
console.log(`[pkg:prep] rebuilding better-sqlite3 with ${execSync(`"${nodeBin}" --version`).toString().trim()}`);
try {
  execSync(`"${npxBin}" node-gyp rebuild --release`, {
    cwd: 'dist/node_modules/better-sqlite3',
    stdio: 'inherit',
  });
  console.log('[pkg:prep] better-sqlite3 rebuilt for node20 (ABI 115)');
} catch (e) {
  // On Windows, better-sqlite3 is compiled for Windows natively — the rebuild
  // may fail if build tools are unavailable, but the copied .node still works.
  console.warn('[pkg:prep] WARNING: better-sqlite3 rebuild failed:', e.message.split('\n')[0]);
  console.warn('[pkg:prep] Continuing with pre-compiled .node file — verify ABI matches pkg target.');
}

// ── 3. Copy workspace packages into dist/node_modules/ ──────────────────────
// pkg on Windows cannot follow pnpm symlinks/junctions. We copy directly from
// the package directory using the known monorepo layout (../../../packages/<name>).
// Only dist/ + package.json are needed — transitive npm deps resolve normally.
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const workspacePkgs = [
  { name: '@retrodeck/mcp',                dir: 'rdk-mcp' },
  { name: '@retrodeck/x402',               dir: 'rdk-x402' },
  { name: '@retrodeck/adapter-filesystem', dir: 'rdk-adapter-filesystem' },
  { name: '@retrodeck/adapter-obsidian',   dir: 'rdk-adapter-obsidian' },
];

for (const { name, dir } of workspacePkgs) {
  const srcDir = path.join(repoRoot, 'packages', dir);
  const distSrc = path.join(srcDir, 'dist');

  if (!fs.existsSync(distSrc)) {
    console.warn(`[pkg:prep] WARNING: ${name} has no dist/ — skipping (run: pnpm --filter ${name} build)`);
    continue;
  }

  const destBase = path.join('dist', 'node_modules', ...name.split('/'));
  fs.mkdirSync(destBase, { recursive: true });
  fs.cpSync(distSrc, path.join(destBase, 'dist'), { recursive: true, dereference: true, force: true });
  fs.copyFileSync(path.join(srcDir, 'package.json'), path.join(destBase, 'package.json'));
  console.log(`[pkg:prep] copied ${name}`);
}
