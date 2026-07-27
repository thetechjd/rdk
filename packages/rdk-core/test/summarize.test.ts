import { describe, it, expect } from 'vitest';
import { extractiveSummary } from '../src/summarize.js';

describe('extractiveSummary', () => {
  it('produces a summary without an LLM — the gap that left every chunk with none', () => {
    const text = 'The gateway authenticates each node once at upgrade. Sessions are keyed by node id. A second connect kicks the first.';
    expect(extractiveSummary(text)).toBe(text);
  });

  it('prefixes the deepest heading as the topic', () => {
    const summary = extractiveSummary('Servers own channels.', { headings: ['Discord Clone', '2. Overall Architecture'] });
    expect(summary).toBe('2. Overall Architecture — Servers own channels.');
  });

  it('stops on a sentence boundary within the budget', () => {
    const text = 'First sentence here. Second sentence here. Third sentence here.';
    const summary = extractiveSummary(text, { maxChars: 45 });
    expect(summary).toBe('First sentence here. Second sentence here.');
  });

  it('truncates at a word boundary when the first sentence alone overflows', () => {
    const summary = extractiveSummary('averyverylongsentence that just keeps going and going without any punctuation at all', { maxChars: 30 });
    expect(summary.length).toBeLessThanOrEqual(31); // + the ellipsis
    expect(summary.endsWith('…')).toBe(true);
  });

  it('skips headings and bullet markers when picking the prose', () => {
    const summary = extractiveSummary('# Heading\n\n- first bullet\n- second bullet');
    expect(summary).toBe('first bullet second bullet');
  });

  it('returns empty for content with nothing to extract, so callers keep summary undefined', () => {
    expect(extractiveSummary('   \n\n  ')).toBe('');
  });
});
