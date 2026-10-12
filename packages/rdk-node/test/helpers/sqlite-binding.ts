import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * A better-sqlite3 binding that loads under this Node (see the long note in
 * rdk-core/test/local-store-sql.test.ts): a workspace set up for Electron work
 * has the hoisted binding compiled for Electron's ABI, so try the default first
 * and fall back to known Node-ABI copies via BETTER_SQLITE3_NATIVE_BINDING,
 * which LocalStore honours. Call before the first LocalStore is opened.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

function opens(nativeBinding?: string): boolean {
  try {
    const coreRequire = createRequire(path.resolve(HERE, '../../../rdk-core/package.json'));
    const Database = coreRequire('better-sqlite3');
    const db = nativeBinding ? new Database(':memory:', { nativeBinding }) : new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

export const IS_CI = Boolean(process.env.CI) && process.env.CI !== 'false' && process.env.CI !== '0';

export function useNodeSqliteBinding(): boolean {
  if (opens()) { delete process.env.BETTER_SQLITE3_NATIVE_BINDING; return true; }
  const candidates = [
    process.env.BETTER_SQLITE3_NATIVE_BINDING,
    path.resolve(HERE, '../../../rdk-cli/dist/node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
    path.join(os.homedir(), '.rdk/node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    if (fs.existsSync(c) && opens(c)) { process.env.BETTER_SQLITE3_NATIVE_BINDING = c; return true; }
  }
  return false;
}
