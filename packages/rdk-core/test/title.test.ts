import { describe, it, expect } from 'vitest';
import { extractDocTitle, firstH1, frontmatterTitle } from '../src/title.js';

describe('extractDocTitle', () => {
  it('prefers a frontmatter title over the H1 and the fallback', () => {
    const raw = ['---', 'title: Canonical Name', 'tags: [a]', '---', '', '# Some Other Heading', '', 'body'].join('\n');
    expect(extractDocTitle(raw, 'file-stem')).toBe('Canonical Name');
  });

  it('falls back to the H1 — the case that produced "discord" instead of the real title', () => {
    const raw = [
      '# Discord Clone — Build-Ready Technical Specification',
      '',
      '**Status:** Architecture Frozen',
      '',
      '## 2. Overall Architecture',
    ].join('\n');
    expect(extractDocTitle(raw, 'discord')).toBe('Discord Clone — Build-Ready Technical Specification');
  });

  it('falls back to the caller-supplied name when the document declares nothing', () => {
    expect(extractDocTitle('just some prose\n\nmore prose', 'notes')).toBe('notes');
  });

  it('ignores headings inside fenced code', () => {
    const raw = ['```sh', '# not a heading', '```', '', '# Real Heading'].join('\n');
    expect(extractDocTitle(raw, 'x')).toBe('Real Heading');
  });

  it('ignores a # line inside frontmatter', () => {
    const raw = ['---', '# a yaml comment', 'tags: [a]', '---', '', 'body text'].join('\n');
    expect(extractDocTitle(raw, 'stem')).toBe('stem');
  });

  it('only treats level-1 headings as the document title', () => {
    expect(firstH1('## Section\n\n# Document')).toBe('Document');
  });

  it('strips quotes and closing hashes', () => {
    expect(frontmatterTitle('---\ntitle: "Quoted Name"\n---\n')).toBe('Quoted Name');
    expect(firstH1('# Closed Heading #')).toBe('Closed Heading');
  });

  it('treats an empty frontmatter title as absent', () => {
    const raw = ['---', 'title:  ', '---', '', '# H1 Wins'].join('\n');
    expect(extractDocTitle(raw, 'stem')).toBe('H1 Wins');
  });
});
