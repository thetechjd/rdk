import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  configureQueryVocabulary,
  loadBundledEnglishFrequencies,
  setQueryVocabularyForTests,
  understandQuery,
} from '../src/query/understand.js';

describe('query understanding', () => {
  it('keeps the in-memory vocabulary when its cache directory is unwritable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-dict-readonly-'));
    const file = path.join(root, 'file');
    fs.writeFileSync(file, 'not a directory');
    try {
      expect(() => configureQueryVocabulary({ words: ['instagram'], chunkCount: 1, dataDir: file })).not.toThrow();
      expect(understandQuery('instgram').corrected).toBe('instagram');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  beforeEach(() => setQueryVocabularyForTests([['instagram', 100], ['clone', 80]]));

  it('corrects instgram when instagram exists in the indexed vocabulary', () => {
    expect(understandQuery('instgram clone').corrected).toBe('instagram clone');
  });

  it('does not correct an indexed product term verbatim', () => {
    setQueryVocabularyForTests([['instgram', 1], ['instagram', 100], ['clone', 80]]);
    expect(understandQuery('instgram clone').corrected).toBe('instgram clone');
  });

  it('preserves dots and hyphens inside package and domain tokens', () => {
    expect(understandQuery('  Express.js / foo-bar! ').normalized).toBe('express.js foo-bar');
  });

  it('never corrects toward a bundled English word the node has not indexed', () => {
    // The 82k list contains "ingram", one edit from "instgram". Only the chunk
    // vocabulary may supply a correction, so "instagram" wins and, when the node
    // has indexed nothing, the term is left exactly as typed.
    const english = loadBundledEnglishFrequencies(
      path.join(__dirname, '..', 'assets', 'frequency_dictionary_en_82_765.txt'),
    );
    expect(english.length).toBeGreaterThan(80_000);

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-dict-'));
    configureQueryVocabulary({ words: [], chunkCount: 0, dataDir, baseFrequencies: english });
    expect(understandQuery('instgram').corrected).toBe('instgram');

    configureQueryVocabulary({
      words: ['Instagram clone architecture'],
      chunkCount: 1,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-dict-')),
      baseFrequencies: english,
    });
    expect(understandQuery('instgram').corrected).toBe('instagram');
    // An ordinary English word is a real word: it is never rewritten.
    expect(understandQuery('architecture').corrected).toBe('architecture');
  });
});
