// packages/rdk-node/src/ws/handlers/partner-job.ts
// `command.partner_job`: work a linked partner app (ParlayLedger) asked this
// node to do, relayed by Central over the node's own WebSocket (RDK_PL_00A C2).
//
// The partner never reaches the node directly and never reads anything from it.
// It can only ask for three things: write-and-publish one document into its own
// managed folder, remove one of those documents, or ping. Everything else on
// the node (the vault, visibility, wallet, plan, keys, config) is out of reach.
//
// Failures throw a PartnerJobError whose `.code` the WS client forwards as the
// reply's `error.code`; Central treats `rate_limited`/`node_busy` as transient
// (re-queue) and every other code as terminal.

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { EmbeddingModel, LocalStore, StoredChunk } from '@rdk/core';
import { loadConfig, type RDKConfig } from '../../config.js';
import { getHostVersion } from '../host-info.js';
import { pushChunkDeleted, pushChunkIndexed } from '../events.js';
import type {
  PartnerJobCommand, PartnerJobErrorCode, PingResult, PublishDocPayload, PublishDocResult,
  UnpublishDocPayload, UnpublishDocResult,
} from '../protocol.js';

/** SPEC 00 section 9: Central and the node both enforce it. */
export const DOC_MAX_BYTES = 32_768;
export const SUPPORTED_PARTNER_JOB_TYPES = ['publish_doc', 'unpublish_doc', 'ping'] as const;

const REF_PATTERN = /^pub_[0-9A-HJKMNP-TV-Z]{26}$/;
const FILENAME_PATTERN = /^pub_[0-9A-HJKMNP-TV-Z]{26}\.md$/;
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PARTNER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class PartnerJobError extends Error {
  constructor(readonly code: PartnerJobErrorCode, message: string) {
    super(message);
    this.name = 'PartnerJobError';
  }
}

/** Seams for tests and for hosts that already hold these resources. */
export interface PartnerJobDeps {
  loadConfig(): RDKConfig;
  openStore(): Promise<LocalStore>;
  embeddingModel(): Promise<EmbeddingModel>;
  /** Delete a chunk on Central. Best effort: false when it could not. */
  deleteOnCentral(config: RDKConfig, store: LocalStore, chunkHash: string): Promise<boolean>;
  hostVersion(): string | null;
}

let cachedModel: Promise<EmbeddingModel> | null = null;

export const defaultPartnerJobDeps: PartnerJobDeps = {
  loadConfig,
  async openStore() {
    const { LocalStore } = await import('@rdk/core');
    return new LocalStore();
  },
  embeddingModel() {
    // Loading the model costs seconds; a node serving a backfill keeps one.
    if (!cachedModel) {
      cachedModel = import('@rdk/core')
        .then(({ LocalEmbeddingModel }) => new LocalEmbeddingModel() as EmbeddingModel)
        .catch((e) => { cachedModel = null; throw e; });
    }
    return cachedModel;
  },
  async deleteOnCentral(config, store, chunkHash) {
    const { SyncService } = await import('../../sync-service.js');
    const sync = new SyncService({
      enabled: false, intervalMinutes: 0, centralApiUrl: config.centralApiUrl,
      centralApiKey: config.apiKey, log: () => {},
    }, store);
    return sync.deleteOnCentral(chunkHash);
  },
  hostVersion: getHostVersion,
};

// ── Paths and logging ────────────────────────────────────────────────────────

function rdkHome(): string {
  // Same resolution as @rdk/core's partnerDocsRoot() and LocalStore.
  return process.env.RDK_HOME ?? path.join(os.homedir(), '.rdk');
}

/** `<RDK_HOME>/partners/<partnerId>` (the only folder a partner job touches). */
export function managedPartnerDir(partnerId: string): string {
  if (!PARTNER_ID_PATTERN.test(partnerId)) {
    throw new PartnerJobError('partner_not_linked', `Unknown partner: ${partnerId}`);
  }
  return path.resolve(rdkHome(), 'partners', partnerId);
}

export function ensureManagedPartnerDir(partnerId: string): string {
  const dir = managedPartnerDir(partnerId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on filesystems without modes */ }
  return dir;
}

/** Refs of the managed documents currently on disk for a partner. */
export function listManagedRefs(partnerId: string): string[] {
  let dir: string;
  try { dir = managedPartnerDir(partnerId); } catch { return []; }
  try {
    return fs.readdirSync(dir)
      .filter((name) => FILENAME_PATTERN.test(name))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

function logJob(entry: {
  jobId: string | null; partnerId: string | null; jobType: string | null;
  ref: string | null; ok: boolean; code: string | null;
}): void {
  // One JSON line per job. Never the markdown body: refs and codes only.
  try {
    const dir = path.join(rdkHome(), 'logs');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      path.join(dir, 'partner-jobs.log'),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
      { mode: 0o600 },
    );
  } catch { /* logging must never fail a job */ }
}

const short = (v: unknown): string | null =>
  typeof v === 'string' ? v.slice(0, 80) : null;

// ── Validation ───────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

function invalid(message: string): never {
  throw new PartnerJobError('invalid_payload', message);
}

/** SPEC 01 Phase 4 publish_doc schema. Filename rules are checked later on
 *  their own so a bad filename reports `invalid_filename`, not this. */
function validatePublishPayload(p: unknown): PublishDocPayload {
  if (!isObject(p)) invalid('payload must be an object');
  if (typeof p.ref !== 'string' || !REF_PATTERN.test(p.ref)) invalid('ref must be pub_<ULID>');
  if (typeof p.filename !== 'string') invalid('filename must be a string');
  if (typeof p.markdown !== 'string' || p.markdown.length === 0) invalid('markdown must be a non-empty string');
  if (typeof p.contentHash !== 'string' || !CONTENT_HASH_PATTERN.test(p.contentHash)) {
    invalid('contentHash must be sha256:<64 hex>');
  }
  if (!isStringArray(p.categories) || p.categories.length > 32) invalid('categories must be an array of strings');
  if (typeof p.domain !== 'string' || !p.domain.trim() || p.domain.length > 64) invalid('domain must be a string');
  if (p.visibility !== 'public') invalid("visibility must be 'public'");
  if (typeof p.pin !== 'boolean') invalid('pin must be a boolean');
  return p as unknown as PublishDocPayload;
}

function validateUnpublishPayload(p: unknown): UnpublishDocPayload {
  if (!isObject(p)) invalid('payload must be an object');
  if (typeof p.ref !== 'string' || !REF_PATTERN.test(p.ref)) invalid('ref must be pub_<ULID>');
  return { ref: p.ref };
}

// ── Handler ──────────────────────────────────────────────────────────────────

const sha256Hex = (buf: Buffer | string): string =>
  crypto.createHash('sha256').update(buf).digest('hex');

/** Chunks indexed from this managed file, live versions only. */
function liveChunksFor(store: LocalStore, filePath: string, partnerId: string): StoredChunk[] {
  return store.getVersions(filePath, `partner:${partnerId}`).filter((c) => !c.supersededAt);
}

function orderedHashes(chunks: StoredChunk[]): string[] {
  return [...chunks]
    .sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0))
    .map((c) => c.id);
}

function writeAtomically(dir: string, filename: string, bytes: Buffer): void {
  const tmp = path.join(dir, `.${filename}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, path.join(dir, filename));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/** Remove every trace of one managed document: Central rows, chunks, the
 *  documents row and the file. Shared by unpublish_doc and `rdk partners
 *  remove --delete-docs`. */
export async function removeManagedDocument(
  partnerId: string,
  ref: string,
  deps: PartnerJobDeps = defaultPartnerJobDeps,
): Promise<UnpublishDocResult> {
  const filePath = path.join(managedPartnerDir(partnerId), `${ref}.md`);
  const config = deps.loadConfig();
  const store = await deps.openStore();
  try {
    const chunks = store.getVersions(filePath, `partner:${partnerId}`);
    const fileExists = fs.existsSync(filePath);
    if (!fileExists && chunks.length === 0) return { ref, alreadyRemoved: true };

    const documentHashes = new Set(chunks.map((c) => c.documentHash).filter((h): h is string => !!h));
    if (fileExists) documentHashes.add(sha256Hex(fs.readFileSync(filePath)));

    const removed: string[] = [];
    for (const chunk of chunks) {
      // Central retires public rows (earnings history kept). Best effort, like
      // `rdk delete`: an unreachable Central must not leave the file serving.
      await deps.deleteOnCentral(config, store, chunk.id);
      store.deleteChunk(chunk.id);
      pushChunkDeleted(chunk.id);
      removed.push(chunk.id);
    }
    // Without this, fetch_document keeps serving the full text by hash.
    for (const hash of documentHashes) store.deleteDocument(hash);
    if (fileExists) fs.unlinkSync(filePath);
    return { ref, removedChunkHashes: removed };
  } finally {
    store.close();
  }
}

async function publishDoc(
  partnerId: string,
  payload: PublishDocPayload,
  config: RDKConfig,
  deps: PartnerJobDeps,
): Promise<PublishDocResult> {
  const bytes = Buffer.from(payload.markdown, 'utf8');
  const hex = sha256Hex(bytes);
  const contentHash = `sha256:${hex}`;

  // 1-4: nothing is written until every check passes.
  if (payload.contentHash !== contentHash) {
    throw new PartnerJobError('content_hash_mismatch', 'contentHash does not match the markdown bytes');
  }
  if (bytes.length > DOC_MAX_BYTES) {
    throw new PartnerJobError('doc_too_large', `Document is ${bytes.length} bytes; the limit is ${DOC_MAX_BYTES}`);
  }
  const dir = managedPartnerDir(partnerId);
  if (payload.filename !== `${payload.ref}.md` || !FILENAME_PATTERN.test(payload.filename)) {
    throw new PartnerJobError('invalid_filename', 'filename must be <ref>.md');
  }
  const filePath = path.resolve(dir, payload.filename);
  if (path.dirname(filePath) !== dir) {
    throw new PartnerJobError('invalid_filename', 'filename resolves outside the managed folder');
  }
  if (payload.pin === true) {
    throw new PartnerJobError('pinning_unavailable', 'Pinning partner documents is not available');
  }

  const store = await deps.openStore();
  try {
    // 5. Idempotency: same bytes on disk and every chunk already on Central.
    const current = liveChunksFor(store, filePath, partnerId).filter((c) => c.documentHash === hex);
    const onDisk = fs.existsSync(filePath) && sha256Hex(fs.readFileSync(filePath)) === hex;
    if (onDisk && current.length > 0 && current.every((c) => !!c.syncedAt)) {
      const hashes = orderedHashes(current);
      const indexedAt = current.reduce((min, c) => (c.createdAt < min ? c.createdAt : min), current[0].createdAt);
      return { ref: payload.ref, contentHash, chunkHashes: hashes, chunkIds: hashes, indexedAt: indexedAt.toISOString() };
    }

    // 6. Write atomically.
    ensureManagedPartnerDir(partnerId);
    writeAtomically(dir, payload.filename, bytes);

    // 7. Index as public, tagged with the partner reference on every chunk.
    const { RDKIndexer, keyFromHex } = await import('@rdk/core');
    const indexer = new RDKIndexer({
      embeddingModel: await deps.embeddingModel(),
      localStore: store,
      domain: payload.domain,
      syncToNetwork: true,
      centralApiUrl: config.centralApiUrl,
      centralApiKey: config.apiKey,
      vaultKey: config.vaultKeyHex ? keyFromHex(config.vaultKeyHex) : undefined,
      nodeId: config.nodeId,
      onChunkIndexed: pushChunkIndexed,
    });
    const result = await indexer.indexDocument({
      content: payload.markdown,
      title: payload.ref,
      sourcePath: filePath,
      sourceAdapter: `partner:${partnerId}`,
      domain: payload.domain,
      categories: payload.categories,
      isPublic: true,
      externalPartner: partnerId,
      externalRef: payload.ref,
    });

    // 8. Map failures.
    const errors = result.errors.join('; ');
    if (/Index rate limit exceeded/i.test(errors)) {
      if (liveChunksFor(store, filePath, partnerId).length === 0) {
        try { fs.unlinkSync(filePath); } catch { /* already gone */ }
      }
      throw new PartnerJobError('rate_limited', 'Index rate limit reached on this node; retry later');
    }
    if (/PLAN_LIMIT_REACHED/.test(errors)) {
      await rollback(store, config, deps, filePath, partnerId, hex);
      throw new PartnerJobError('plan_limit_reached', "This account's plan chunk limit is reached");
    }
    if (result.chunksIndexed === 0 && liveChunksFor(store, filePath, partnerId).every((c) => c.documentHash !== hex)) {
      // Too short to index, or a near-duplicate of content this node already
      // holds. Retrying cannot change either.
      await rollback(store, config, deps, filePath, partnerId, hex);
      throw new PartnerJobError('invalid_payload', `Document was not indexed: ${errors || 'no indexable content'}`);
    }

    // 9. Every chunk of this version must have reached Central.
    const indexed = liveChunksFor(store, filePath, partnerId).filter((c) => c.documentHash === hex);
    if (errors || indexed.length === 0 || indexed.some((c) => !c.syncedAt)) {
      throw new PartnerJobError('node_busy', `Indexed locally but not yet synced to the network: ${errors || 'pending'}`);
    }

    // A replaced version of the same ref (publications are immutable, so this
    // is a repair path) must not keep answering queries with the old text.
    const stale = store.getVersions(filePath, `partner:${partnerId}`).filter((c) => c.documentHash !== hex);
    for (const chunk of stale) {
      await deps.deleteOnCentral(config, store, chunk.id);
      store.deleteChunk(chunk.id);
      pushChunkDeleted(chunk.id);
      if (chunk.documentHash) store.deleteDocument(chunk.documentHash);
    }

    const hashes = orderedHashes(indexed);
    return { ref: payload.ref, contentHash, chunkHashes: hashes, chunkIds: hashes, indexedAt: new Date().toISOString() };
  } finally {
    store.close();
  }
}

/** Undo a publish that failed for good: nothing of it may linger to be synced
 *  later behind the partner's back. */
async function rollback(
  store: LocalStore, config: RDKConfig, deps: PartnerJobDeps,
  filePath: string, partnerId: string, documentHash: string,
): Promise<void> {
  for (const chunk of store.getVersions(filePath, `partner:${partnerId}`)) {
    if (chunk.documentHash !== documentHash) continue;
    if (chunk.syncedAt) await deps.deleteOnCentral(config, store, chunk.id);
    store.deleteChunk(chunk.id);
  }
  store.deleteDocument(documentHash);
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}

async function ping(partnerId: string, deps: PartnerJobDeps): Promise<PingResult> {
  const store = await deps.openStore();
  try {
    return {
      cliVersion: deps.hostVersion(),
      // This handler only runs while a WS session to Central is up.
      serving: true,
      publicChunks: store.getStats().publicChunks,
      partnerDocs: listManagedRefs(partnerId).length,
    };
  } finally {
    store.close();
  }
}

/** Build the handler. Tests inject deps; the handler map uses the defaults. */
export function createPartnerJobHandler(deps: PartnerJobDeps = defaultPartnerJobDeps) {
  // Central delivers one job at a time per node, but more than one local
  // process can hold a session. Serialize within this process regardless.
  let queue: Promise<unknown> = Promise.resolve();

  return function partnerJobHandler(data: unknown): Promise<unknown> {
    const run = queue.then(() => runJob(data, deps));
    queue = run.catch(() => undefined);
    return run;
  };
}

async function runJob(data: unknown, deps: PartnerJobDeps): Promise<unknown> {
  const cmd = (isObject(data) ? data : {}) as Partial<PartnerJobCommand>;
  const payload = isObject(cmd.payload) ? cmd.payload : undefined;
  const entry = {
    jobId: short(cmd.jobId),
    partnerId: short(cmd.partnerId),
    jobType: short(cmd.jobType),
    ref: payload && typeof payload.ref === 'string' && REF_PATTERN.test(payload.ref) ? payload.ref : null,
  };
  try {
    const result = await gateAndRun(cmd, deps);
    logJob({ ...entry, ok: true, code: null });
    return result;
  } catch (e) {
    const err = e instanceof PartnerJobError
      ? e
      : new PartnerJobError('node_busy', (e as Error)?.message ?? String(e));
    logJob({ ...entry, ok: false, code: err.code });
    throw err;
  }
}

async function gateAndRun(cmd: Partial<PartnerJobCommand>, deps: PartnerJobDeps): Promise<unknown> {
  const config = deps.loadConfig();
  const partnerId = cmd.partnerId;

  // 1. Linked
  const partners = config.partners ?? {};
  if (typeof partnerId !== 'string' || !PARTNER_ID_PATTERN.test(partnerId)
    || !Object.prototype.hasOwnProperty.call(partners, partnerId)) {
    throw new PartnerJobError('partner_not_linked', `This node is not linked to partner ${String(partnerId)}`);
  }
  const link = partners[partnerId];
  // 2. Enabled
  if (link.enabled !== true) {
    throw new PartnerJobError('partner_disabled', `Partner jobs for ${partnerId} are disabled on this node`);
  }
  // 3. Allowed (by the link, and by this node's own implementation)
  const jobType = cmd.jobType;
  if (typeof jobType !== 'string'
    || !(SUPPORTED_PARTNER_JOB_TYPES as readonly string[]).includes(jobType)
    || !Array.isArray(link.allowedJobTypes) || !link.allowedJobTypes.includes(jobType)) {
    throw new PartnerJobError('job_type_not_allowed', `Job type ${String(jobType)} is not allowed`);
  }

  // 4. Payload, then run.
  switch (jobType) {
    case 'publish_doc':
      return publishDoc(partnerId, validatePublishPayload(cmd.payload), config, deps);
    case 'unpublish_doc':
      return removeManagedDocument(partnerId, validateUnpublishPayload(cmd.payload).ref, deps);
    case 'ping':
      if (cmd.payload !== undefined && cmd.payload !== null && !isObject(cmd.payload)) invalid('payload must be an object');
      return ping(partnerId, deps);
  }
  throw new PartnerJobError('job_type_not_allowed', `Job type ${jobType} is not allowed`);
}

export const partnerJobHandler = createPartnerJobHandler();
