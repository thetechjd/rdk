import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalStore, type EmbeddingModel } from '@rdk/core';

import {
  createPartnerJobHandler, managedPartnerDir, type PartnerJobDeps,
} from '../src/ws/handlers/partner-job.js';
import type { RDKConfig } from '../src/config.js';
import { IS_CI, useNodeSqliteBinding } from './helpers/sqlite-binding.js';

const SQLITE = useNodeSqliteBinding();
if (!SQLITE && !IS_CI) console.warn('[rdk] SKIPPING partner-job store tests: no Node-ABI better-sqlite3 binding');
const suite = SQLITE || IS_CI ? describe : describe.skip;

/**
 * SPEC 02 Phase 5 items 3, 4, 5 and 8: the `command.partner_job` handler
 * against a real local store and a mocked Central (no network).
 */

const HOME = process.env.RDK_HOME!;
const DB = path.join(HOME, 'partner-test.db');
const REF = 'pub_01J9ZX4K7Q2M9XDABCDEFGHJKM';
const REF2 = 'pub_01J9ZX4K7Q2M9XDABCDEFGHJKN';

const MARKDOWN = [
  '---',
  'rdk_partner: parlayledger',
  `ref: ${REF}`,
  'type: pick',
  '---',
  '# Lakers vs Celtics: under 221.5',
  '',
  'Both teams are on the second night of a back to back with no rest. Pace drops',
  'measurably in that spot and both defences have held opponents under their',
  'season scoring average across the last eight road games. The pick is the under',
  'at minus one hundred and ten, one unit, captured at ParlayLedger server time.',
].join('\n');

const sha = (s: string) => `sha256:${crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')}`;

function publishPayload(overrides: Record<string, unknown> = {}) {
  return {
    ref: REF, filename: `${REF}.md`, markdown: MARKDOWN, contentHash: sha(MARKDOWN),
    categories: ['parlayledger', 'sports', 'basketball', 'nba', 'pick'],
    domain: 'sports-betting', visibility: 'public', pin: false, ...overrides,
  };
}

function job(jobType: string, payload: unknown, partnerId = 'parlayledger') {
  return { jobId: `job_${Math.random().toString(36).slice(2)}`, partnerId, jobType, payload, issuedAt: new Date().toISOString() };
}

/** Deterministic, content-dependent vectors so unrelated docs never dedup. */
const fakeModel: EmbeddingModel = {
  dimensions: 384,
  modelName: 'fake',
  async embed(text: string) {
    const v = new Float32Array(384);
    const h = crypto.createHash('sha512').update(text).digest();
    for (let i = 0; i < 384; i++) v[i] = (h[i % h.length] / 255) - 0.5 + (i % 7) * 0.01;
    return v;
  },
  async embedBatch(texts: string[]) { return Promise.all(texts.map((t) => this.embed(t))); },
};

let config: RDKConfig;
let syncBodies: Array<{ chunks: Array<Record<string, unknown>> }>;
let deletes: string[];
let syncMode: 'accept' | 'plan_limit';

function deps(): PartnerJobDeps {
  return {
    loadConfig: () => config,
    openStore: async () => new LocalStore(DB),
    embeddingModel: async () => fakeModel,
    deleteOnCentral: async (_c, _s, hash) => { deletes.push(hash); return true; },
    hostVersion: () => '1.15.0',
  };
}

function storeChunks(): ReturnType<LocalStore['getAllChunks']> {
  const s = new LocalStore(DB);
  try { return s.getAllChunks(); } finally { s.close(); }
}

beforeEach(() => {
  fs.rmSync(path.join(HOME, 'partners'), { recursive: true, force: true });
  fs.rmSync(path.join(HOME, 'logs'), { recursive: true, force: true });
  for (const f of fs.readdirSync(HOME)) if (f.startsWith('partner-test.db')) fs.rmSync(path.join(HOME, f));
  config = {
    nodeId: 'node-1', apiKey: 'rdk_live_x', centralApiUrl: 'https://central.test',
    plan: 'free', vaultAdapter: 'filesystem', vaultPath: '', domain: 'general',
    walletChain: 'base', mcpPort: 4242, createdAt: new Date().toISOString(),
    partners: {
      parlayledger: {
        name: 'ParlayLedger', linkId: 'lnk_01', enabled: true,
        allowedJobTypes: ['publish_doc', 'unpublish_doc', 'ping'], linkedAt: new Date().toISOString(),
      },
    },
  };
  syncBodies = [];
  deletes = [];
  syncMode = 'accept';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/v1/nodes/auth')) return new Response(JSON.stringify({ jwtToken: 'jwt' }));
    if (url.endsWith('/api/v1/chunks/sync')) {
      const body = JSON.parse(String(init?.body));
      syncBodies.push(body);
      const hashes = body.chunks.map((c: { chunkHash: string }) => c.chunkHash);
      if (syncMode === 'plan_limit') {
        return new Response(JSON.stringify({
          code: 'PLAN_LIMIT_REACHED', message: "You've reached your plan limit of 10 network chunks.",
        }), { status: 403 });
      }
      return new Response(JSON.stringify({ synced: hashes.length, acceptedHashes: hashes, errors: [] }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
});

afterEach(() => { vi.unstubAllGlobals(); });

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code });
}

function managedFiles(): string[] {
  try { return fs.readdirSync(managedPartnerDir('parlayledger')); } catch { return []; }
}

suite('publish_doc', () => {
  it('writes the file, indexes it public with external refs, and is idempotent on replay', async () => {
    const handler = createPartnerJobHandler(deps());
    const result = await handler(job('publish_doc', publishPayload())) as {
      ref: string; contentHash: string; chunkHashes: string[]; chunkIds: string[]; indexedAt: string;
    };

    const file = path.join(managedPartnerDir('parlayledger'), `${REF}.md`);
    expect(fs.readFileSync(file, 'utf8')).toBe(MARKDOWN); // byte for byte
    expect(result.ref).toBe(REF);
    expect(result.contentHash).toBe(sha(MARKDOWN));
    expect(result.chunkHashes.length).toBeGreaterThan(0);
    expect(result.chunkIds).toEqual(result.chunkHashes);
    expect(Number.isNaN(Date.parse(result.indexedAt))).toBe(false);

    const chunks = storeChunks();
    expect(chunks.map((c) => c.id).sort()).toEqual([...result.chunkHashes].sort());
    for (const c of chunks) {
      expect(c.isPublic).toBe(true);
      expect(c.externalPartner).toBe('parlayledger');
      expect(c.externalRef).toBe(REF);
      expect(c.sourceAdapter).toBe('partner:parlayledger');
      expect(c.sourcePath).toBe(file);
      expect(c.domain).toBe('sports-betting');
      expect(c.categories).toEqual(publishPayload().categories);
      expect(c.syncedAt).toBeTruthy();
    }
    // The sync payload carries the external ref on every chunk (00A C3).
    const synced = syncBodies.flatMap((b) => b.chunks);
    expect(synced.length).toBe(result.chunkHashes.length);
    for (const c of synced) {
      expect(c).toMatchObject({ externalPartner: 'parlayledger', externalRef: REF, isPublic: true });
      expect(c).not.toHaveProperty('content');
    }

    // Replay: same result, nothing re-indexed or re-synced.
    const replay = await handler(job('publish_doc', publishPayload())) as typeof result;
    expect(replay.chunkHashes).toEqual(result.chunkHashes);
    expect(replay.contentHash).toBe(result.contentHash);
    expect(syncBodies.length).toBe(1);
    expect(storeChunks().length).toBe(chunks.length);
  });

  it.each([
    ['content_hash_mismatch', publishPayload({ contentHash: `sha256:${'0'.repeat(64)}` })],
    ['doc_too_large', (() => { const md = `# Big\n\n${'x'.repeat(33_000)}`; return publishPayload({ markdown: md, contentHash: sha(md) }); })()],
    ['invalid_filename', publishPayload({ filename: '../../x.md' })],
    ['invalid_filename', publishPayload({ filename: `${REF2}.md` })],
    ['pinning_unavailable', publishPayload({ pin: true })],
    ['invalid_payload', publishPayload({ ref: '../../etc/passwd' })],
    ['invalid_payload', publishPayload({ visibility: 'private' })],
  ])('rejects %s and writes nothing', async (code, payload) => {
    const handler = createPartnerJobHandler(deps());
    await expectCode(handler(job('publish_doc', payload)), code);
    expect(managedFiles()).toEqual([]);
    expect(fs.existsSync(path.resolve(managedPartnerDir('parlayledger'), '../../x.md'))).toBe(false);
    expect(storeChunks()).toEqual([]);
    expect(syncBodies).toEqual([]);
  });

  it('rejects a disabled partner, an unlinked partner and a disallowed job type, writing nothing', async () => {
    const handler = createPartnerJobHandler(deps());
    config.partners!.parlayledger.enabled = false;
    await expectCode(handler(job('publish_doc', publishPayload())), 'partner_disabled');
    config.partners!.parlayledger.enabled = true;

    await expectCode(handler(job('publish_doc', publishPayload(), 'otherapp')), 'partner_not_linked');
    await expectCode(handler(job('publish_doc', publishPayload(), '__proto__')), 'partner_not_linked');

    config.partners!.parlayledger.allowedJobTypes = ['ping'];
    await expectCode(handler(job('publish_doc', publishPayload())), 'job_type_not_allowed');
    config.partners!.parlayledger.allowedJobTypes = ['publish_doc', 'unpublish_doc', 'ping', 'read_vault'];
    await expectCode(handler(job('read_vault', {})), 'job_type_not_allowed');

    expect(managedFiles()).toEqual([]);
    expect(storeChunks()).toEqual([]);
  });

  it('maps a Central plan-limit rejection to plan_limit_reached and rolls back', async () => {
    syncMode = 'plan_limit';
    const handler = createPartnerJobHandler(deps());
    await expectCode(handler(job('publish_doc', publishPayload())), 'plan_limit_reached');
    expect(managedFiles()).toEqual([]);
    expect(storeChunks()).toEqual([]);
  });
});

suite('unpublish_doc', () => {
  it('removes the chunks, the documents row and the file, and is idempotent', async () => {
    const handler = createPartnerJobHandler(deps());
    const published = await handler(job('publish_doc', publishPayload())) as { chunkHashes: string[] };
    const docHash = sha(MARKDOWN).slice('sha256:'.length);
    {
      const s = new LocalStore(DB);
      expect(s.getDocument(docHash)).not.toBeNull();
      s.close();
    }

    const removed = await handler(job('unpublish_doc', { ref: REF })) as { ref: string; removedChunkHashes: string[] };
    expect(removed.ref).toBe(REF);
    expect(removed.removedChunkHashes.sort()).toEqual([...published.chunkHashes].sort());
    expect(deletes.sort()).toEqual([...published.chunkHashes].sort()); // deleted on Central too
    expect(storeChunks()).toEqual([]);
    const s = new LocalStore(DB);
    expect(s.getDocument(docHash)).toBeNull(); // fetch_document can no longer serve it
    s.close();
    expect(managedFiles()).toEqual([]);

    const again = await handler(job('unpublish_doc', { ref: REF }));
    expect(again).toEqual({ ref: REF, alreadyRemoved: true });
  });

  it('rejects a malformed ref', async () => {
    const handler = createPartnerJobHandler(deps());
    await expectCode(handler(job('unpublish_doc', { ref: '../config' })), 'invalid_payload');
  });
});

suite('ping', () => {
  it('reports the injected host version, serving, public chunks and partner docs', async () => {
    const handler = createPartnerJobHandler(deps());
    await handler(job('publish_doc', publishPayload()));
    const pong = await handler(job('ping', {})) as Record<string, unknown>;
    expect(pong).toMatchObject({ cliVersion: '1.15.0', serving: true, partnerDocs: 1 });
    expect(pong.publicChunks).toBeGreaterThan(0);
  });
});

suite('partner-jobs.log', () => {
  it('logs one JSON line per job and never the markdown body', async () => {
    const handler = createPartnerJobHandler(deps());
    await handler(job('publish_doc', publishPayload()));
    await handler(job('publish_doc', publishPayload({ contentHash: `sha256:${'1'.repeat(64)}` }))).catch(() => {});
    await handler(job('unpublish_doc', { ref: REF }));
    await handler(job('ping', {}));

    const log = fs.readFileSync(path.join(HOME, 'logs', 'partner-jobs.log'), 'utf8');
    const lines = log.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ partnerId: 'parlayledger', jobType: 'publish_doc', ref: REF, ok: true, code: null });
    expect(lines[1]).toMatchObject({ ok: false, code: 'content_hash_mismatch' });
    for (const l of lines) expect(Object.keys(l).sort()).toEqual(['at', 'code', 'jobId', 'jobType', 'ok', 'partnerId', 'ref']);
    expect(log).not.toContain('back to back');
    expect(log).not.toContain('Lakers');
    expect(log).not.toContain('rdk_partner');
  });
});
