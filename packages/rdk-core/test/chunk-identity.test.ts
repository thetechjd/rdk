import { describe, expect, it } from 'vitest';
import { chunkIdentity } from '../src/indexer.js';

describe('document-scoped search-window identity', () => {
  it('does not merge identical generic sections from unrelated documents', () => {
    const genericSection = '## Deployment\n\nRun the web client behind a CDN.';
    expect(chunkIdentity('metamask-document', genericSection))
      .not.toBe(chunkIdentity('slack-document', genericSection));
  });

  it('still deduplicates the same window from the same document version', () => {
    const text = '## Authentication\n\nUse signed wallet challenges.';
    expect(chunkIdentity('metamask-document', text))
      .toBe(chunkIdentity('metamask-document', text));
  });
});
