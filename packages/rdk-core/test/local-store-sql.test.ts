import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

/**
 * The SQL added by query_pipeline v2 — the domain predicates on the retrieval
 * legs, the migration itself, and getAuthorityCounts — is only exercised by a
 * real database. Every other store test in this package stubs LocalStore out
 * because the hoisted better-sqlite3 binding is compiled for Electron
 * (NODE_MODULE_VERSION 136) and will not load in the vitest runner (127).
 *
 * Rather than rebuild the shared module — which would break the desktop app's
 * binding — this finds a binding that does load. The ordinary resolution path is
 * tried FIRST: on a plain `pnpm install` (including CI, which runs Node 22 with
 * no electron-rebuild) the default copy is already correct, and only a machine
 * set up for Electron work needs the fallbacks below.
 *
 * When nothing usable is found the suite skips locally so Electron dev setups
 * are not blocked, but FAILS in CI — a skipped suite still reports green, and
 * this is the only test covering the v2 migration and the domain predicates.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

const nodeRequire = createRequire(import.meta.url);

/** Opening a real in-memory database is the only honest ABI check. */
function opens(nativeBinding?: string): boolean {
  try {
    const Database = nodeRequire('better-sqlite3');
    const db = nativeBinding ? new Database(':memory:', { nativeBinding }) : new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** `undefined` binding means the default copy works and needs no override. */
function findUsableBinding(): { usable: boolean; binding?: string } {
  if (opens()) return { usable: true };

  const fallbacks = [
    process.env.BETTER_SQLITE3_NATIVE_BINDING,
    path.resolve(HERE, '../../rdk-cli/dist/node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
    path.join(os.homedir(), '.rdk/node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of fallbacks) {
    if (fs.existsSync(candidate) && opens(candidate)) return { usable: true, binding: candidate };
  }
  return { usable: false };
}

const IS_CI = Boolean(process.env.CI) && process.env.CI !== 'false' && process.env.CI !== '0';
const choice = findUsableBinding();
const MISSING_BINDING =
  'No Node-ABI better-sqlite3 binding found, so the query_pipeline v2 SQL — the migration, ' +
  'the domain predicates and getAuthorityCounts — is UNVERIFIED. Run `pnpm install` for this ' +
  'Node version, or set BETTER_SQLITE3_NATIVE_BINDING to a compatible build.';

if (!choice.usable && !IS_CI) console.warn(`[rdk] SKIPPING local-store SQL tests: ${MISSING_BINDING}`);

// Runs only in CI, where a silent skip would let green mean "never executed".
describe('local store SQL prerequisites', () => {
  it.skipIf(!IS_CI)('CI has a Node-ABI better-sqlite3 binding', () => {
    expect(choice.usable, MISSING_BINDING).toBe(true);
  });
});

const dirs: string[] = [];

function newStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-store-'));
  dirs.push(dir);
  return path.join(dir, 'index.db');
}

function chunkRow(overrides: Record<string, unknown>) {
  return {
    id: 'chunk-a',
    title: 'Wallet architecture',
    content: 'Non custodial EVM wallet transaction signing and key storage.',
    categories: [],
    isPublic: true,
    isEncrypted: false,
    qualityScore: 1,
    ...overrides,
  } as never;
}

describe.skipIf(!choice.usable)('local store query_pipeline SQL', () => {
  let LocalStore: typeof import('../src/store/local-store.js').LocalStore;
  let Database: typeof import('better-sqlite3');

  beforeAll(async () => {
    // Clear a stale or broken override, or LocalStore would prefer it over the
    // default copy this run already proved works.
    if (choice.binding) process.env.BETTER_SQLITE3_NATIVE_BINDING = choice.binding;
    else delete process.env.BETTER_SQLITE3_NATIVE_BINDING;
    ({ LocalStore } = await import('../src/store/local-store.js'));
    Database = (await import('better-sqlite3')).default;
  });

  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  function raw(dbPath: string) {
    return choice.binding
      ? new Database(dbPath, { nativeBinding: choice.binding } as never)
      : new Database(dbPath);
  }

  it('applies migration v2 and is idempotent across reopens', () => {
    const dbPath = newStorePath();
    new LocalStore(dbPath);
    new LocalStore(dbPath); // reopen must not throw or duplicate anything

    const db = raw(dbPath);
    const version = db.prepare(
      `SELECT version FROM schema_versions WHERE component = 'query_pipeline'`,
    ).get() as { version: number };
    expect(version.version).toBe(2);

    const indexes = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_tip_queue_chunk','idx_chunks_domain_live')`,
    ).all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name).sort()).toEqual(['idx_chunks_domain_live', 'idx_tip_queue_chunk']);
    db.close();
  });

  it('upgrades a v1 database in place without rebuilding it', () => {
    const dbPath = newStorePath();
    new LocalStore(dbPath);

    // Rewind to the v1 world: version 1, no v2 indexes.
    const db = raw(dbPath);
    db.exec(`
      DROP INDEX IF EXISTS idx_tip_queue_chunk;
      DROP INDEX IF EXISTS idx_chunks_domain_live;
      UPDATE schema_versions SET version = 1 WHERE component = 'query_pipeline';
    `);
    db.close();

    new LocalStore(dbPath);

    const after = raw(dbPath);
    expect((after.prepare(
      `SELECT version FROM schema_versions WHERE component = 'query_pipeline'`,
    ).get() as { version: number }).version).toBe(2);
    expect(after.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_tip_queue_chunk'`,
    ).get()).toEqual({ n: 1 });
    after.close();
  });

  it('counts retrievals and non-failed tips for authority', () => {
    const dbPath = newStorePath();
    const store = new LocalStore(dbPath);
    store.saveChunk(chunkRow({ id: 'chunk-a' }), new Float32Array([1, 0, 0]));

    const db = raw(dbPath);
    for (const id of ['r1', 'r2', 'r3']) {
      db.prepare(`INSERT INTO retrieval_edges (id, query_id, query_text, chunk_id) VALUES (?, ?, ?, ?)`)
        .run(id, `q-${id}`, 'wallet', 'chunk-a');
    }
    const tip = `INSERT INTO tip_queue (id, chunk_id, provider_node_id, amount_usdc, chain, status) VALUES (?, ?, 'node-1', 0.01, 'base', ?)`;
    db.prepare(tip).run('t1', 'chunk-a', 'pending');
    db.prepare(tip).run('t2', 'chunk-a', 'settled');
    db.prepare(tip).run('t3', 'chunk-a', 'failed');   // must not confer authority
    db.close();

    expect(store.getAuthorityCounts('chunk-a')).toEqual({ retrievalCount: 3, tipCount: 2 });
    expect(store.getAuthorityCounts('missing')).toEqual({ retrievalCount: 0, tipCount: 0 });
  });

  it('scopes both retrieval legs to the requested domain', () => {
    const store = new LocalStore(newStorePath());
    store.saveChunk(chunkRow({ id: 'eng-1', domain: 'engineering' }), new Float32Array([1, 0, 0]));
    store.saveChunk(chunkRow({ id: 'fin-1', domain: 'fintech' }), new Float32Array([1, 0, 0]));

    const lexicalAll = store.lexicalSearch('wallet', 10).map((row) => row.id);
    expect(lexicalAll.sort()).toEqual(['eng-1', 'fin-1']);
    expect(store.lexicalSearch('wallet', 10, 'fintech').map((row) => row.id)).toEqual(['fin-1']);

    const vectorAll = store.search(new Float32Array([1, 0, 0]), 10, false).map((row) => row.id);
    expect(vectorAll.sort()).toEqual(['eng-1', 'fin-1']);
    expect(store.search(new Float32Array([1, 0, 0]), 10, false, 'fintech').map((row) => row.id)).toEqual(['fin-1']);
  });
});
