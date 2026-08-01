import fs from 'fs';
import path from 'path';
import {
  QUERY_EXPANSION_VARIANTS,
  QUERY_SYNONYMS,
  SPELLCHECK_MIN_TERM_LENGTH,
  SYMSPELL_MAX_EDIT_DISTANCE,
  SYMSPELL_PREFIX_LENGTH,
} from './pipeline.constants.js';
import type { UnderstoodQuery } from './types.js';

interface PersistedDictionary {
  chunkCount: number;
  frequencies: Record<string, number>;
  chunkWords?: string[];
}

/** Merged English + chunk counts. Ranks candidates; never sources them. */
let frequencies = new Map<string, number>();
/** Words this node has actually indexed — the ONLY legal correction targets. */
let chunkVocabulary = new Set<string>();
/** Bundled English list. Protects real words from being rewritten; not a target. */
let englishWords = new Set<string>();

export function normalizeQuery(raw: string): string {
  return (raw
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+(?:[.\-][\p{L}\p{N}]+)*/gu) ?? [])
    .join(' ');
}

/** Configure the node-specific dictionary at startup and persist its compiled vocabulary. */
export function configureQueryVocabulary(opts: {
  words: Iterable<string>;
  chunkCount: number;
  dataDir: string;
  baseFrequencies?: Iterable<readonly [string, number]>;
}): void {
  const dictionaryPath = path.join(opts.dataDir, 'query-spelling-dictionary.json');
  let persisted: PersistedDictionary | undefined;
  try { persisted = JSON.parse(fs.readFileSync(dictionaryPath, 'utf8')) as PersistedDictionary; } catch { /* rebuild */ }

  const priorCount = persisted?.chunkCount ?? 0;
  const change = priorCount === 0 ? 1 : Math.abs(opts.chunkCount - priorCount) / priorCount;
  if (persisted?.chunkWords && change <= 0.10) {
    frequencies = new Map(Object.entries(persisted.frequencies));
    chunkVocabulary = new Set(persisted.chunkWords);
    englishWords = new Set([...frequencies.keys()].filter((word) => !chunkVocabulary.has(word)));
    return;
  }

  const next = new Map<string, number>();
  const english = new Set<string>();
  for (const [word, count] of opts.baseFrequencies ?? []) {
    const normalized = normalizeQuery(word);
    if (normalized && !normalized.includes(' ')) { next.set(normalized, count); english.add(normalized); }
  }
  const chunkWords = new Set<string>();
  for (const raw of opts.words) {
    for (const word of normalizeQuery(raw).split(' ')) {
      if (word) { next.set(word, (next.get(word) ?? 0) + 1); chunkWords.add(word); }
    }
  }
  frequencies = next;
  chunkVocabulary = chunkWords;
  englishWords = english;
  fs.mkdirSync(opts.dataDir, { recursive: true });
  fs.writeFileSync(dictionaryPath, JSON.stringify({
    chunkCount: opts.chunkCount,
    frequencies: Object.fromEntries(next),
    chunkWords: [...chunkWords],
  }));
}

export function loadBundledEnglishFrequencies(filePath: string): Array<readonly [string, number]> {
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).flatMap((line) => {
      const [word, count] = line.trim().split(/\s+/);
      const frequency = Number(count);
      return word && Number.isFinite(frequency) ? [[word, frequency] as const] : [];
    });
  } catch {
    return [];
  }
}

export function setQueryVocabularyForTests(entries: Iterable<readonly [string, number]>): void {
  frequencies = new Map(entries);
  chunkVocabulary = new Set(frequencies.keys());
  englishWords = new Set();
}

export function understandQuery(raw: string): UnderstoodQuery {
  const normalized = normalizeQuery(raw);
  const corrected = normalized.split(' ').map(correctTerm).join(' ');
  const variants = expandQuery(corrected);
  return { original: raw, normalized, corrected, variants };
}

// Corrections may only land on terms this node has indexed, and a term that is
// already a known word — an indexed product name or ordinary English — is never
// rewritten. Without the second guard the bundled English list turns "instgram"
// into "ingram" instead of leaving it for the chunk vocabulary to claim.
function correctTerm(term: string): string {
  if (term.length < SPELLCHECK_MIN_TERM_LENGTH) return term;
  if (chunkVocabulary.has(term) || englishWords.has(term)) return term;
  const prefix = term.slice(0, SYMSPELL_PREFIX_LENGTH);
  let best: { term: string; distance: number; frequency: number } | undefined;
  for (const candidate of chunkVocabulary) {
    if (Math.abs(candidate.length - term.length) > SYMSPELL_MAX_EDIT_DISTANCE) continue;
    if (prefix && candidate.slice(0, Math.max(1, prefix.length - SYMSPELL_MAX_EDIT_DISTANCE))[0] !== prefix[0]) continue;
    const distance = damerauLevenshtein(term, candidate, SYMSPELL_MAX_EDIT_DISTANCE);
    if (distance > SYMSPELL_MAX_EDIT_DISTANCE) continue;
    const frequency = frequencies.get(candidate) ?? 0;
    if (!best || distance < best.distance || (distance === best.distance && frequency > best.frequency)) {
      best = { term: candidate, distance, frequency };
    }
  }
  return best?.term ?? term;
}

function expandQuery(query: string): string[] {
  const out: string[] = [];
  const terms = query.split(' ');
  for (let i = 0; i < terms.length && out.length < QUERY_EXPANSION_VARIANTS; i++) {
    for (const synonym of QUERY_SYNONYMS[terms[i]] ?? []) {
      const variant = [...terms];
      variant[i] = synonym;
      out.push(variant.join(' '));
      if (out.length >= QUERY_EXPANSION_VARIANTS) break;
    }
  }
  return out;
}

function damerauLevenshtein(a: string, b: string, max: number): number {
  const rows = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = max + 1;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + cost);
      }
      rowMin = Math.min(rowMin, rows[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return rows[a.length][b.length];
}
