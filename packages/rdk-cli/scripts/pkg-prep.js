#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 1. Copy better-sqlite3 (dereference pnpm symlinks)
fs.mkdirSync('dist/node_modules', { recursive: true });
const src = fs.realpathSync('node_modules/better-sqlite3');
fs.cpSync(src, 'dist/node_modules/better-sqlite3', { recursive: true, dereference: true, force: true });
console.log('[pkg:prep] copied better-sqlite3 from', src);

// 2. Find a Node.js 20.x binary to rebuild the native addon with the right ABI
//    (pkg embeds Node 20; the .node file must match ABI 115)
const current = process.version; // e.g. 'v20.20.0'
let nodeBin;

if (current.startsWith('v20.')) {
  nodeBin = process.execPath;
} else {
  // Try nvm directory (local dev machines)
  const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME || '', '.nvm');
  const versionsDir = path.join(nvmDir, 'versions', 'node');
  if (fs.existsSync(versionsDir)) {
    const v20s = fs.readdirSync(versionsDir)
      .filter(v => v.startsWith('v20.'))
      .sort()
      .reverse();
    if (v20s.length > 0) {
      nodeBin = path.join(versionsDir, v20s[0], 'bin', 'node');
    }
  }
}

if (!nodeBin) {
  throw new Error(
    'Node.js 20.x not found. Install it via nvm: nvm install 20\n' +
    'The pkg binary embeds Node.js 20 — better-sqlite3 must be compiled against it.'
  );
}

const npxBin = path.join(path.dirname(nodeBin), 'npx');
const nodeVersion = execSync(`"${nodeBin}" --version`).toString().trim();
console.log(`[pkg:prep] rebuilding better-sqlite3 with ${nodeVersion} (${nodeBin})`);

execSync(`"${npxBin}" node-gyp rebuild --release`, {
  cwd: 'dist/node_modules/better-sqlite3',
  stdio: 'inherit',
});

console.log('[pkg:prep] better-sqlite3 rebuilt for node20 (ABI 115)');
