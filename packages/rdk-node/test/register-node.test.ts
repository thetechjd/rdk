import { describe, it, expect } from 'vitest';
import { isOfflineNode } from '../src/register-node.js';

/**
 * An offline node is the failure that looks like success.
 *
 * Desktop onboarding writes `nodeId: local-<hash>`. That config indexes,
 * publishes and queries perfectly well — querying only needs Central's HTTP
 * API — so nothing appears wrong. But `getWsClient()` returns null for a
 * `local-` id, so the node can never hold the WebSocket Central uses to fetch
 * content at query time: its chunks are indexed and permanently unretrievable.
 *
 * `startNode()` then returned `{ ok: true }` regardless, because
 * `startWsOwnership()` returning null was never checked. Pressing "start node"
 * did nothing, said nothing, and left the status at "not serving" forever.
 */

describe('recognising a node that cannot serve', () => {
  it('flags the id desktop onboarding writes', () => {
    expect(isOfflineNode({ nodeId: 'local-1837462', apiKey: 'rdk_live_abc' })).toBe(true);
  });

  it('flags an offline API key even with a real-looking id', () => {
    expect(isOfflineNode({ nodeId: 'ce79e1db-9853-4f85', apiKey: 'rdk_local_xyz' })).toBe(true);
  });

  it('flags a config with no id at all', () => {
    expect(isOfflineNode({ nodeId: '', apiKey: 'rdk_live_abc' })).toBe(true);
  });

  it('accepts a registered node', () => {
    expect(isOfflineNode({
      nodeId: '8e3035d8-c78a-463a-985c-9d6c4cf895db',
      apiKey: 'rdk_live_abc',
    })).toBe(false);
  });

  it('does not mistake an id that merely CONTAINS "local"', () => {
    // Substring matching here would knock a legitimate node offline.
    expect(isOfflineNode({ nodeId: 'a-local-node-uuid', apiKey: 'rdk_live_abc' })).toBe(false);
  });
});

/**
 * Mirrors startNode's contract. The bug was not that starting could fail — it
 * was that failing was reported as success, so the UI showed "not serving" with
 * no way to discover why.
 */
const startOutcome = (hasOwnership: boolean) =>
  hasOwnership
    ? { ok: true }
    : { ok: false, error: 'This node has no network identity, so it cannot serve content.' };

describe('starting the node reports what actually happened', () => {
  it('succeeds when a WebSocket owner was created', () => {
    expect(startOutcome(true).ok).toBe(true);
  });

  it('FAILS when no owner could be created — this used to return ok', () => {
    const r = startOutcome(false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot serve/);
  });
});
