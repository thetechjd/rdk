// packages/rdk-cli/src/ws/handlers/vault-list.ts
// Returns LOCAL vault file metadata. Used by the dashboard to surface file count
// and (in V3.5) the Personal Knowledge Map.

import fs from 'fs';
import path from 'path';
import { loadConfig } from '../../config.js';

interface VaultFile {
  path: string;
  size: number;
  modifiedAt: string;
  indexed: boolean;
}

function walkVault(dir: string): Array<{ relativePath: string; absolutePath: string; size: number; modifiedAt: Date }> {
  const results: Array<{ relativePath: string; absolutePath: string; size: number; modifiedAt: Date }> = [];
  if (!fs.existsSync(dir)) return results;

  const walk = (current: string) => {
    try {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
        } else if (/\.(md|txt|mdx)$/.test(entry.name)) {
          const stat = fs.statSync(abs);
          results.push({ relativePath: path.relative(dir, abs), absolutePath: abs, size: stat.size, modifiedAt: stat.mtime });
        }
      }
    } catch {
      // Skip unreadable directories
    }
  };

  walk(dir);
  return results;
}

export async function vaultListHandler(_data: unknown): Promise<{ files: VaultFile[]; totalCount: number }> {
  const { LocalStore } = await import('@rdk/core');
  const config = loadConfig();

  if (!config.vaultPath || config.vaultAdapter === 'notion') {
    return { files: [], totalCount: 0 };
  }

  const store = new LocalStore();
  const indexedPaths = new Set(store.getSourcePaths());
  store.close();

  const rawFiles = walkVault(config.vaultPath);

  const files: VaultFile[] = rawFiles.map(f => ({
    path: f.relativePath,
    size: f.size,
    modifiedAt: f.modifiedAt.toISOString(),
    indexed: indexedPaths.has(f.absolutePath),
  }));

  return {
    files: files.slice(0, 1000),
    totalCount: rawFiles.length,
  };
}
