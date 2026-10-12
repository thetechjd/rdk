// packages/rdk-cli/src/commands/api-serve.ts
// `rdk api:serve`: a localhost-only query API for a partner's query node
// (SPEC 02 Phase 4, RDK_PL_00A C5).
//
// ParlayLedger runs an ordinary RDK node next to its API and asks it network
// questions over 127.0.0.1. Each request runs the existing two-phase flow:
//   1. preview (free metadata, with the partner filters), then
//   2. one selection per result, walking in score order and adding each
//      preview tip to a running total; once the next one would exceed
//      `maxTipUsdc`, it and the rest come back with `skippedReason: 'tip_cap'`.
// Tips are settled by Central from the node's RetroDeck credits. This process
// never opens the WebSocket session (run `rdk mcp:serve` alongside it).

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';

export const DEFAULT_API_PORT = 7841;
export const API_HOST = '127.0.0.1';
/** SPEC 00 section 9. */
export const QUERY_TIP_CAP_USDC = 0.25;
export const QUERY_TOPK = 8;
const MAX_BODY_BYTES = 64 * 1024;
const MIN_TOKEN_LENGTH = 16;

export class ApiServeError extends Error {}

export interface ApiNetworkChunk {
  chunkId: string;
  nodeId: string;
  title: string;
  summary?: string;
  content?: string;
  contentEncrypted?: string | null;
  score: number;
  tipAmountUsdc: number;
  isOwn?: boolean;
  isEncrypted?: boolean;
  available?: boolean;
  categories?: string[];
  externalRef?: { partner: string; ref: string } | null;
  attestation?: { kind: string; status: string; record: unknown; signedAt: string } | null;
  publisherRecord?: unknown;
}

export interface QueryFilters {
  externalPartner?: string;
  attestedStatus?: string[];
  categories?: string[];
}

export interface PrivateHit {
  chunkId: string;
  title: string;
  summary?: string;
  content: string;
  score: number;
  categories: string[];
  externalRef: { partner: string; ref: string } | null;
}

/** Everything the server needs from the node, injectable for tests. */
export interface ApiServeDeps {
  nodeId: string;
  embed(text: string): Promise<Float32Array>;
  network(
    queryText: string,
    embedding: Float32Array,
    opts: { previewOnly: boolean; selectedChunkId?: string; filters?: QueryFilters; topK: number },
  ): Promise<{ results: ApiNetworkChunk[]; queryId?: string }>;
  privateSearch(embedding: Float32Array, topK: number, filters?: QueryFilters): Promise<PrivateHit[]>;
  wsConnected(): boolean;
  walletBalanceUsdc(): Promise<number | null>;
  log?(line: string): void;
}

// ── Startup checks ───────────────────────────────────────────────────────────

/** Only 127.0.0.1. Any other host (0.0.0.0 included) is refused. */
export function resolveHost(host?: string): string {
  if (host === undefined || host === API_HOST) return API_HOST;
  throw new ApiServeError(`Refusing to bind to ${host}: rdk api:serve only listens on ${API_HOST}.`);
}

/** Read the bearer token; the file must be private (no group/other bits). */
export function readTokenFile(tokenFile: string | undefined): string {
  if (!tokenFile) throw new ApiServeError('A token file is required: rdk api:serve --token-file <path>');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(tokenFile);
  } catch {
    throw new ApiServeError(`Token file not found: ${tokenFile}`);
  }
  if (!stat.isFile()) throw new ApiServeError(`Token file is not a regular file: ${tokenFile}`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new ApiServeError(
      `Token file ${tokenFile} is readable by other users (mode ${(stat.mode & 0o777).toString(8)}). Run: chmod 600 ${tokenFile}`,
    );
  }
  const token = fs.readFileSync(tokenFile, 'utf-8').trim();
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ApiServeError(`Token in ${tokenFile} must be at least ${MIN_TOKEN_LENGTH} characters.`);
  }
  return token;
}

// ── Request validation ───────────────────────────────────────────────────────

export interface QueryRequest {
  q: string;
  topK: number;
  tiers: Array<'network' | 'private'>;
  filters?: QueryFilters;
  maxTipUsdc: number;
  requestId: string | null;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 32 && v.every((x) => typeof x === 'string' && x.length <= 128);

/** Returns the parsed request, or a message explaining what is wrong. */
export function parseQueryRequest(body: unknown): QueryRequest | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'body must be a JSON object';
  const b = body as Record<string, unknown>;
  if (typeof b.q !== 'string' || !b.q.trim() || b.q.length > 2000) return 'q must be a non-empty string (max 2000 chars)';
  let topK = QUERY_TOPK;
  if (b.topK !== undefined) {
    if (typeof b.topK !== 'number' || !Number.isInteger(b.topK) || b.topK < 1 || b.topK > 20) return 'topK must be an integer from 1 to 20';
    topK = b.topK;
  }
  let tiers: QueryRequest['tiers'] = ['network'];
  if (b.tiers !== undefined) {
    if (!isStringArray(b.tiers) || b.tiers.length === 0
      || !b.tiers.every((x) => x === 'network' || x === 'private')) return "tiers must be a non-empty subset of ['network', 'private']";
    tiers = [...new Set(b.tiers)] as QueryRequest['tiers'];
  }
  let filters: QueryFilters | undefined;
  if (b.filters !== undefined && b.filters !== null) {
    if (typeof b.filters !== 'object' || Array.isArray(b.filters)) return 'filters must be an object';
    const f = b.filters as Record<string, unknown>;
    filters = {};
    if (f.externalPartner !== undefined) {
      if (typeof f.externalPartner !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(f.externalPartner)) return 'filters.externalPartner must be a partner id';
      filters.externalPartner = f.externalPartner;
    }
    if (f.attestedStatus !== undefined) {
      if (!isStringArray(f.attestedStatus)) return 'filters.attestedStatus must be an array of strings';
      filters.attestedStatus = f.attestedStatus;
    }
    if (f.categories !== undefined) {
      if (!isStringArray(f.categories)) return 'filters.categories must be an array of strings';
      filters.categories = f.categories;
    }
  }
  let maxTipUsdc = QUERY_TIP_CAP_USDC;
  if (b.maxTipUsdc !== undefined) {
    if (typeof b.maxTipUsdc !== 'number' || !Number.isFinite(b.maxTipUsdc) || b.maxTipUsdc < 0 || b.maxTipUsdc > 100) return 'maxTipUsdc must be a number from 0 to 100';
    maxTipUsdc = b.maxTipUsdc;
  }
  let requestId: string | null = null;
  if (b.requestId !== undefined) {
    if (typeof b.requestId !== 'string' || b.requestId.length > 128) return 'requestId must be a string (max 128 chars)';
    requestId = b.requestId;
  }
  return { q: b.q, topK, tiers, filters, maxTipUsdc, requestId };
}

// ── Query execution ──────────────────────────────────────────────────────────

export interface ApiResult {
  chunkId: string;
  nodeId: string;
  title: string;
  summary: string | null;
  content: string | null;
  score: number;
  tipPaidUsdc: number;
  categories: string[];
  externalRef: { partner: string; ref: string } | null;
  attestation: ApiNetworkChunk['attestation'];
  publisherRecord: unknown;
  skippedReason: string | null;
}

class QueryHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly partial?: object) {
    super(message);
  }
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

function toResult(c: ApiNetworkChunk, extra: Partial<ApiResult>): ApiResult {
  return {
    chunkId: c.chunkId,
    nodeId: c.nodeId,
    title: c.title,
    summary: c.summary ?? null,
    content: null,
    score: c.score,
    tipPaidUsdc: 0,
    categories: c.categories ?? [],
    externalRef: c.externalRef ?? null,
    attestation: c.attestation ?? null,
    publisherRecord: c.publisherRecord ?? null,
    skippedReason: null,
    ...extra,
  };
}

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown })?.status;
  return typeof s === 'number' ? s : undefined;
}

export async function runQuery(req: QueryRequest, deps: ApiServeDeps): Promise<{
  requestId: string | null; queryId: string | null; tipSpentUsdc: number; results: ApiResult[];
}> {
  const embedding = await deps.embed(req.q);
  const results: ApiResult[] = [];
  let queryId: string | null = null;
  let tipSpent = 0;

  if (req.tiers.includes('private')) {
    // This node's own vault: free, no Central involved.
    for (const hit of await deps.privateSearch(embedding, req.topK, req.filters)) {
      results.push({
        chunkId: hit.chunkId, nodeId: deps.nodeId, title: hit.title, summary: hit.summary ?? null,
        content: hit.content, score: hit.score, tipPaidUsdc: 0, categories: hit.categories,
        externalRef: hit.externalRef, attestation: null, publisherRecord: null, skippedReason: null,
      });
    }
  }

  if (!req.tiers.includes('network')) {
    return { requestId: req.requestId, queryId, tipSpentUsdc: 0, results };
  }

  // Phase 1: the free catalog.
  let preview: ApiNetworkChunk[];
  try {
    const r = await deps.network(req.q, embedding, { previewOnly: true, filters: req.filters, topK: req.topK });
    queryId = r.queryId ?? null;
    preview = r.results
      .filter((c) => c.available !== false)
      .sort((a, b) => b.score - a.score)
      .slice(0, req.topK);
  } catch (e) {
    throw new QueryHttpError(503, 'central_unreachable', (e as Error).message);
  }

  // Phase 2: retrieve in score order under the tip ceiling.
  let committed = 0; // running total of PREVIEW tips (00A C5)
  let capped = false;
  for (let i = 0; i < preview.length; i++) {
    const c = preview[i];
    if (capped) { results.push(toResult(c, { skippedReason: 'tip_cap' })); continue; }
    if (c.isEncrypted) { results.push(toResult(c, { skippedReason: 'encrypted' })); continue; }
    const tip = c.isOwn ? 0 : Math.max(0, c.tipAmountUsdc ?? 0);
    if (committed + tip > req.maxTipUsdc + 1e-9) {
      capped = true;
      results.push(toResult(c, { skippedReason: 'tip_cap' }));
      continue;
    }
    committed += tip;

    let selected: ApiNetworkChunk | undefined;
    try {
      const r = await deps.network(req.q, embedding, {
        previewOnly: false, selectedChunkId: c.chunkId, filters: req.filters, topK: req.topK,
      });
      selected = r.results.find((x) => x.chunkId === c.chunkId);
    } catch (e) {
      if (statusOf(e) === 402) {
        // Out of credit: return what was fetched; nothing further is charged.
        for (const rest of preview.slice(i)) results.push(toResult(rest, { skippedReason: 'wallet_insufficient' }));
        throw new QueryHttpError(402, 'wallet_insufficient', (e as Error).message, {
          requestId: req.requestId, queryId, tipSpentUsdc: round6(tipSpent), results,
        });
      }
      throw new QueryHttpError(503, 'central_unreachable', (e as Error).message, {
        requestId: req.requestId, queryId, tipSpentUsdc: round6(tipSpent), results,
      });
    }

    if (!selected || selected.available === false) {
      results.push(toResult(c, { skippedReason: 'unavailable' }));
      continue;
    }
    const content = selected.contentEncrypted
      ?? (selected.content && selected.content !== selected.summary ? selected.content : null);
    const paid = selected.isOwn ? 0 : Math.max(0, selected.tipAmountUsdc ?? 0);
    tipSpent += paid;
    results.push(toResult({ ...c, ...selected }, {
      content,
      tipPaidUsdc: round6(paid),
      skippedReason: content === null ? 'unavailable' : null,
    }));
  }

  return { requestId: req.requestId, queryId, tipSpentUsdc: round6(tipSpent), results };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1].trim()).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new QueryHttpError(422, 'invalid_request', 'body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

export function createApiRequestHandler(token: string, deps: ApiServeDeps) {
  const log = deps.log ?? (() => {});
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const started = Date.now();
    const url = (req.url ?? '/').split('?')[0];
    const done = (status: number, body: unknown) => {
      sendJson(res, status, body);
      // Never the query text: method, path, status, latency.
      log(`${req.method} ${url} ${status} ${Date.now() - started}ms`);
    };
    try {
      if (!tokenMatches(req.headers.authorization, token)) return done(401, { error: 'unauthorized' });

      if (url === '/v1/health') {
        if (req.method !== 'GET') return done(405, { error: 'method_not_allowed' });
        const walletBalanceUsdc = await deps.walletBalanceUsdc().catch(() => null);
        return done(200, { ok: true, nodeId: deps.nodeId, wsConnected: deps.wsConnected(), walletBalanceUsdc });
      }

      if (url === '/v1/query') {
        if (req.method !== 'POST') return done(405, { error: 'method_not_allowed' });
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch (e) {
          if (e instanceof QueryHttpError) throw e;
          return done(422, { error: 'invalid_request', message: 'body must be valid JSON' });
        }
        const parsed = parseQueryRequest(body);
        if (typeof parsed === 'string') return done(422, { error: 'invalid_request', message: parsed });
        return done(200, await runQuery(parsed, deps));
      }

      return done(404, { error: 'not_found' });
    } catch (e) {
      if (e instanceof QueryHttpError) {
        return done(e.status, { error: e.code, message: e.message, ...(e.partial ?? {}) });
      }
      return done(503, { error: 'central_unreachable', message: (e as Error).message });
    }
  };
}

/** Start listening on 127.0.0.1. Resolves with the server once bound. */
export async function startApiServer(opts: {
  port?: number; host?: string; token: string; deps: ApiServeDeps;
}): Promise<http.Server> {
  const host = resolveHost(opts.host);
  const handler = createApiRequestHandler(opts.token, opts.deps);
  const server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULT_API_PORT, host, () => { server.off('error', reject); resolve(); });
  });
  return server;
}

// ── Command ──────────────────────────────────────────────────────────────────

/** `rdk api:serve --port 7841 --token-file <path>` */
export async function apiServe(opts: { port?: number; tokenFile?: string; host?: string }): Promise<http.Server | null> {
  let token: string;
  try {
    resolveHost(opts.host);
    token = readTokenFile(opts.tokenFile);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return null;
  }

  const { requireDeps } = await import('../require-dep.js');
  if (!await requireDeps(['@xenova/transformers'], { label: 'Embedding model', yes: true })) {
    process.exitCode = 1;
    return null;
  }
  const { loadConfig } = await import('../config.js');
  const { LocalStore, LocalEmbeddingModel, RDKRouter, keyFromHex, decrypt } = await import('@rdk/core');
  const { listWsPresence } = await import('@rdk/node/ws/ws-presence');
  const config = loadConfig();
  const store = new LocalStore();
  const model = new LocalEmbeddingModel();
  const vaultKey = config.vaultKeyHex ? keyFromHex(config.vaultKeyHex) : undefined;
  // `domain: undefined`: a partner query must never inherit this node's domain.
  const router = new RDKRouter({
    localStore: store, embeddingModel: model, centralApiUrl: config.centralApiUrl,
    centralApiKey: config.apiKey, nodeId: config.nodeId, domain: undefined,
  });

  const deps: ApiServeDeps = {
    nodeId: config.nodeId,
    embed: (text) => model.embed(text),
    network: async (q, embedding, o) => {
      const r = await router.networkSearch(q, embedding, {
        networkPreviewOnly: o.previewOnly,
        selectedNetworkChunkId: o.selectedChunkId,
        networkFilters: o.filters && Object.keys(o.filters).length ? o.filters : undefined,
        topK: o.topK,
      });
      return { results: r.results as ApiNetworkChunk[], queryId: r.queryId };
    },
    privateSearch: async (embedding, topK, filters) => {
      // Attestations live on Central; local chunks never carry one.
      if (filters?.attestedStatus?.length) return [];
      return store.search(embedding, Math.max(20, topK * 4), false)
        .filter((c) => !filters?.externalPartner || c.externalPartner === filters.externalPartner)
        .filter((c) => !filters?.categories?.length || filters.categories.every((cat) => c.categories.includes(cat)))
        .slice(0, topK)
        .map((c) => {
          let content = c.content;
          if (c.isEncrypted) {
            try { content = vaultKey ? decrypt(c.content, vaultKey) : ''; } catch { content = ''; }
          }
          return {
            chunkId: c.id, title: c.title, summary: c.summary, content, score: c.score, categories: c.categories,
            externalRef: c.externalPartner && c.externalRef ? { partner: c.externalPartner, ref: c.externalRef } : null,
          };
        });
    },
    // A sibling `rdk mcp:serve` (or the desktop app) holding the session.
    wsConnected: () => listWsPresence().some((p) => p.connected),
    walletBalanceUsdc: async () => {
      const { getBalance } = await import('@rdk/node/retrodeck-client');
      const b = await getBalance().catch(() => null);
      return b ? b.balanceUsdc : null;
    },
    log: (line) => console.error(`[rdk api] ${line}`),
  };

  let server: http.Server;
  try {
    server = await startApiServer({ port: opts.port, host: opts.host, token, deps });
  } catch (e) {
    console.error(`Could not start rdk api:serve: ${(e as Error).message}`);
    store.close();
    process.exitCode = 1;
    return null;
  }
  const { port } = server.address() as AddressInfo;
  console.error(`RDK query API listening on http://${API_HOST}:${port} (node ${config.nodeId})`);
  console.error('Keep `rdk mcp:serve` running alongside it so this node stays online.');

  const shutdown = () => { server.close(); store.close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}
