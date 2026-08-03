import crypto from 'crypto';
import {
  DEDUP_EMBEDDING_COSINE_THRESHOLD,
  DEDUP_JACCARD_THRESHOLD,
  MINHASH_PERMUTATIONS,
} from '../query/pipeline.constants.js';

export function minHash(text: string): Uint32Array {
  const shingles = wordShingles(text);
  const signature = new Uint32Array(MINHASH_PERMUTATIONS);
  signature.fill(0xffffffff);
  for (const shingle of shingles) {
    for (let seed = 0; seed < MINHASH_PERMUTATIONS; seed++) {
      const value = hash32(`${seed}:${shingle}`);
      if (value < signature[seed]) signature[seed] = value;
    }
  }
  return signature;
}

export function estimatedJaccard(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let equal = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) equal++;
  return equal / a.length;
}

export function dedupCosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

export function assertNotDuplicate(input: {
  chunkId?: string;
  text: string;
  embedding: Float32Array;
  /** Lineage of the incoming chunk — see the exclusions below. */
  documentHash?: string;
  sourcePath?: string;
  existing: Array<{
    chunkId: string;
    signature: Uint32Array;
    embedding: Float32Array;
    documentHash?: string;
    sourcePath?: string;
  }>;
}): void {
  const signature = minHash(input.text);
  for (const candidate of input.existing) {
    if (candidate.chunkId === input.chunkId) continue;
    // Dedup stops the same CONTENT being indexed twice; it must not stop a node
    // re-indexing its own file. Editing a document mints new chunk ids, so
    // without these the new version is rejected as a near-duplicate of the very
    // version it replaces — and the edit can never be indexed or synced.
    if (input.documentHash && candidate.documentHash === input.documentHash) continue;
    if (input.sourcePath && candidate.sourcePath === input.sourcePath) continue;
    const jaccard = estimatedJaccard(signature, candidate.signature);
    const cosine = dedupCosineSimilarity(input.embedding, candidate.embedding);
    if (jaccard >= DEDUP_JACCARD_THRESHOLD || cosine >= DEDUP_EMBEDDING_COSINE_THRESHOLD) {
      throw new Error(`Near-duplicate chunk rejected (matches ${candidate.chunkId}; jaccard=${jaccard.toFixed(3)}, cosine=${cosine.toFixed(3)})`);
    }
  }
}

function wordShingles(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length < 3) return words.length ? [words.join(' ')] : [];
  return words.slice(0, -2).map((_, i) => words.slice(i, i + 3).join(' '));
}

function hash32(value: string): number {
  return crypto.createHash('sha256').update(value).digest().readUInt32BE(0);
}
