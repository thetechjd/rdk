// packages/rdk-core/src/chunker.ts
// Semantic chunking: splits on paragraph/section boundaries,
// then merges small and splits large chunks.
// Target: 512 tokens per chunk, 64-token overlap.

import { estimateTokens } from './cleaner.js';

export interface Chunk {
  index: number;
  text: string;
  tokenEstimate: number;
  headings: string[]; // h1-h6 context above this chunk
}

export interface ChunkOptions {
  strategy?: 'semantic' | 'fixed' | 'sentence';
  maxChunkTokens?: number;
  overlapTokens?: number;
}

/** Split text into semantically coherent chunks */
export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const {
    strategy = 'semantic',
    maxChunkTokens = 512,
    overlapTokens = 64,
  } = opts;

  if (strategy === 'fixed') return fixedChunk(text, maxChunkTokens, overlapTokens);
  if (strategy === 'sentence') return sentenceChunk(text, maxChunkTokens, overlapTokens);
  return semanticChunk(text, maxChunkTokens, overlapTokens);
}

function semanticChunk(text: string, maxTokens: number, overlapTokens: number): Chunk[] {
  // Split on paragraph boundaries (double newline) and markdown headings
  const paragraphRe = /\n{2,}|(?=^#{1,6}\s)/m;
  const paragraphs = text.split(paragraphRe).map(p => p.trim()).filter(Boolean);

  const chunks: Chunk[] = [];
  let buffer = '';
  let headings: string[] = [];
  let chunkIndex = 0;

  for (const para of paragraphs) {
    // Track headings for context
    const headingMatch = /^(#{1,6})\s+(.+)/.exec(para);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const heading = headingMatch[2];
      // Pop headings at same or deeper level
      headings = headings.filter((_, i) => i < level - 1);
      headings[level - 1] = heading;
    }

    const combined = buffer ? `${buffer}\n\n${para}` : para;
    const tokens = estimateTokens(combined);

    if (tokens > maxTokens && buffer) {
      // Flush current buffer as a chunk
      chunks.push({
        index: chunkIndex++,
        text: buffer.trim(),
        tokenEstimate: estimateTokens(buffer),
        headings: [...headings],
      });

      // Overlap: take last N chars of buffer as start of next chunk
      const overlapChars = overlapTokens * 4;
      const overlap = buffer.length > overlapChars
        ? buffer.slice(-overlapChars)
        : buffer;
      buffer = overlap + '\n\n' + para;
    } else {
      buffer = combined;
    }
  }

  if (buffer.trim()) {
    chunks.push({
      index: chunkIndex,
      text: buffer.trim(),
      tokenEstimate: estimateTokens(buffer),
      headings: [...headings],
    });
  }

  // Split any remaining oversized chunks using fixed strategy
  const result: Chunk[] = [];
  let idx = 0;
  for (const chunk of chunks) {
    if (chunk.tokenEstimate > maxTokens * 1.5) {
      const sub = fixedChunk(chunk.text, maxTokens, overlapTokens);
      for (const s of sub) {
        result.push({ ...s, index: idx++, headings: chunk.headings });
      }
    } else {
      result.push({ ...chunk, index: idx++ });
    }
  }

  return result;
}

function fixedChunk(text: string, maxTokens: number, overlapTokens: number): Chunk[] {
  const maxChars = maxTokens * 4;
  const overlapChars = overlapTokens * 4;
  const chunks: Chunk[] = [];
  let start = 0;
  let idx = 0;

  while (start < text.length) {
    const end = Math.min(start + maxChars, text.length);
    const slice = text.slice(start, end);
    chunks.push({
      index: idx++,
      text: slice,
      tokenEstimate: estimateTokens(slice),
      headings: [],
    });
    if (end === text.length) break;
    start = end - overlapChars;
  }

  return chunks;
}

function sentenceChunk(text: string, maxTokens: number, overlapTokens: number): Chunk[] {
  // Split on sentence boundaries
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const chunks: Chunk[] = [];
  let buffer = '';
  let idx = 0;

  for (const sentence of sentences) {
    const combined = buffer ? `${buffer} ${sentence}` : sentence;
    if (estimateTokens(combined) > maxTokens && buffer) {
      chunks.push({ index: idx++, text: buffer.trim(), tokenEstimate: estimateTokens(buffer), headings: [] });
      // Overlap: last sentence as start of next
      buffer = sentence;
    } else {
      buffer = combined;
    }
  }
  if (buffer.trim()) {
    chunks.push({ index: idx, text: buffer.trim(), tokenEstimate: estimateTokens(buffer), headings: [] });
  }
  return chunks;
}
