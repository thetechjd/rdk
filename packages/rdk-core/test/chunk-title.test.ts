import { describe, it, expect } from 'vitest';
import { buildChunkTitle, extractDocTitle } from '../src/title.js';
import { chunkText } from '../src/chunker.js';
import { cleanText } from '../src/cleaner.js';

const SPEC = [
  '# Discord Clone — Build-Ready Technical Specification',
  '',
  'Status: Architecture Frozen. Target: a production-ready real-time communication',
  'platform supporting servers, channels, direct messages and presence.',
  '',
  '## 2. Overall Architecture',
  '',
  'The gateway fans out events to connected clients over a persistent socket, while',
  'the REST API handles everything that is not latency sensitive.',
  '',
  '## 11. Attachments',
  '',
  'Uploads are signed client side and stored in object storage, with the metadata',
  'row written only after the upload is confirmed.',
].join('\n');

describe('buildChunkTitle', () => {
  it('names the section after the document', () => {
    expect(buildChunkTitle('Discord Clone — Build-Ready Technical Specification', ['Discord Clone — Build-Ready Technical Specification', '2. Overall Architecture']))
      .toBe('Discord Clone — Build-Ready Technical Specification — 2. Overall Architecture');
  });

  it('does not repeat the document title for a chunk sitting under the H1 alone', () => {
    expect(buildChunkTitle('My Doc', ['My Doc'])).toBe('My Doc');
  });

  it('handles a chunk with no headings at all', () => {
    expect(buildChunkTitle('My Doc', [])).toBe('My Doc');
  });

  it('ignores heading-level gaps (sparse headings array)', () => {
    // chunker indexes headings by depth, so H1 → H3 leaves a hole at index 1.
    const headings = ['Doc', undefined as unknown as string, 'Deep Section'];
    expect(buildChunkTitle('Doc', headings)).toBe('Doc — Deep Section');
  });
});

describe('end to end: document title flows into chunk titles', () => {
  it('titles every chunk after the document, not the file stem', () => {
    const docTitle = extractDocTitle(SPEC, 'discord'); // 'discord' = the file stem
    const titles = chunkText(cleanText(SPEC), { strategy: 'semantic', maxChunkTokens: 512, overlapTokens: 64 })
      .map(chunk => buildChunkTitle(docTitle, chunk.headings));

    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) {
      expect(title.startsWith('Discord Clone — Build-Ready Technical Specification')).toBe(true);
    }
    // The reported bug: the file stem standing in for the document's real name.
    expect(titles.some(t => t.startsWith('discord — '))).toBe(false);
  });
});
