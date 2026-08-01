import { afterEach, describe, expect, it, vi } from 'vitest';
import { rerankCandidates } from '../src/query/rerank.js';
import { RERANK_MODEL_LOAD_FAILURE } from '../src/query/model.js';
import { RERANK_TIMEOUT_MS } from '../src/query/pipeline.constants.js';

const CANDIDATES = [
  { chunkId: 'first', title: 'first', text: 'first', rrfScore: 2, riskScore: 0, createdAt: new Date(), retrievalCount: 0, tipCount: 0 },
  { chunkId: 'second', title: 'second', text: 'second', rrfScore: 1, riskScore: 0, createdAt: new Date(), retrievalCount: 0, tipCount: 0 },
];

describe('rerank timeout', () => {
  // Restore real timers even when an assertion throws first, so fake timers
  // cannot leak into the tests that follow.
  afterEach(() => vi.useRealTimers());

  it('falls back to RRF order without failing the query', async () => {
    vi.useFakeTimers();
    const pending = rerankCandidates(
      { original: 'q', normalized: 'q', corrected: 'q', variants: [] },
      [
        { chunkId: 'first', title: 'first', text: 'first', rrfScore: 2, riskScore: 0, createdAt: new Date(), retrievalCount: 0, tipCount: 0 },
        { chunkId: 'second', title: 'second', text: 'second', rrfScore: 1, riskScore: 0, createdAt: new Date(), retrievalCount: 0, tipCount: 0 },
      ],
      { score: () => new Promise(() => undefined) },
    );
    // Track the constant rather than a literal, so raising the budget cannot
    // leave this test advancing past a threshold it no longer reaches.
    await vi.advanceTimersByTimeAsync(RERANK_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject([{ chunkId: 'first' }, { chunkId: 'second' }]);
  });

  it('yields between batches so the timeout budget is enforceable', async () => {
    // Local inference resolves synchronously-settled promises. Without an
    // explicit yield the batch loop never leaves the microtask queue, so a
    // pending timer cannot run and RERANK_TIMEOUT_MS can never fire. A macrotask
    // queued before the call must get a turn before reranking finishes.
    const many = Array.from({ length: 40 }, (_, i) => ({
      chunkId: `c${i}`, title: `t${i}`, text: `t${i}`, rrfScore: 1 / (i + 1),
      riskScore: 0, createdAt: new Date(), retrievalCount: 0, tipCount: 0,
    }));

    // Counting batches when a queued macrotask runs is deterministic; racing a
    // setTimeout against setImmediate is not, since their relative order is
    // undefined outside an I/O callback.
    let batches = 0;
    let batchesWhenProbeRan = -1;
    setImmediate(() => { batchesWhenProbeRan = batches; });

    await rerankCandidates(
      { original: 'q', normalized: 'q', corrected: 'q', variants: [] },
      many,
      { score: async (batch) => { batches += 1; return batch.map(() => 0.5); } },
    );

    expect(batches).toBe(3);                        // 40 candidates, batch size 16
    expect(batchesWhenProbeRan).toBeGreaterThanOrEqual(1);
    expect(batchesWhenProbeRan).toBeLessThan(3);    // ran mid-run, not after everything
  });

  it('ranks on the summary when one exists, so network and local compete fairly', async () => {
    // Network candidates only ever carry a summary, because fetching a body
    // settles a tip. Ranking local chunks on their full text would score the two
    // on different amounts of content.
    const seen: string[] = [];
    await rerankCandidates(
      { original: 'q', normalized: 'q', corrected: 'q', variants: [] },
      [
        { ...CANDIDATES[0], text: 'FULL BODY TEXT', summary: 'the summary' },
        { ...CANDIDATES[1], text: 'body with no summary', summary: undefined },
        { ...CANDIDATES[1], chunkId: 'blank', text: 'body behind blank summary', summary: '   ' },
      ],
      { score: async (batch) => { seen.push(...batch.map((p) => p.text)); return batch.map(() => 0.5); } },
    );

    expect(seen[0]).toBe('the summary');
    expect(seen[1]).toBe('body with no summary');   // no summary -> full text
    expect(seen[2]).toBe('body behind blank summary'); // whitespace-only is not a summary
  });

  it('never scores an empty document', async () => {
    // Central holds no summary for private chunks, and node.ts maps a network
    // candidate to `text: chunk.summary ?? ''`. Scoring that empty string is a
    // guaranteed ~0 the chunk can never recover from, so the title stands in.
    const seen: string[] = [];
    await rerankCandidates(
      { original: 'q', normalized: 'q', corrected: 'q', variants: [] },
      [{ ...CANDIDATES[0], title: 'Wallet architecture', text: '', summary: undefined }],
      { score: async (batch) => { seen.push(...batch.map((p) => p.text)); return batch.map(() => 0.5); } },
    );

    expect(seen).toEqual(['Wallet architecture']);
  });

  it('reports an unloadable model as an error, not a routine warning', async () => {
    // A model that cannot load means the rerank weight is silently inert on
    // every query — the failure mode that let a model with no ONNX weights ship.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await rerankCandidates(
      { original: 'q', normalized: 'q', corrected: 'q', variants: [] },
      CANDIDATES,
      { score: () => Promise.reject(new Error(`${RERANK_MODEL_LOAD_FAILURE}: no onnx weights`)) },
    );

    expect(result).toMatchObject([{ chunkId: 'first' }, { chunkId: 'second' }]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('rerank DISABLED'));
    expect(warn).not.toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });
});
