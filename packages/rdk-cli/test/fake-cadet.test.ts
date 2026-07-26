import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { installFakeCadet, type CadetScenario, type FakeCadet } from './helpers/fake-cadet';

let cadet: FakeCadet | undefined;

afterEach(() => {
  cadet?.cleanup();
  cadet = undefined;
});

function run(args: string[]) {
  const r = spawnSync('cryptocadet', args, { encoding: 'utf8', shell: process.platform === 'win32' });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    json: (() => {
      try {
        return JSON.parse(r.stdout ?? '');
      } catch {
        return null;
      }
    })(),
  };
}

/**
 * Verifies the fake CryptoCadet binary itself.
 *
 * This is the harness every CLI crypto test will stand on, and its whole value is
 * reproducing the real CLI's surprising conventions. If the fake drifts from them,
 * the tests built on it will pass while production breaks — so the conventions get
 * asserted here directly.
 */
describe('fake cryptocadet binary', () => {
  it('is discoverable on PATH and reports a version RDK accepts', () => {
    cadet = installFakeCadet();

    const r = run(['--version']);
    expect(r.status).toBe(0);
    // MIN_CRYPTOCADET in src/commands/cryptocadet.ts — anything older is rejected
    // because it predates the `checkout` verb.
    expect(r.json).toEqual({ version: '0.2.1' });
  });

  it('is absent from PATH under the `missing` scenario', () => {
    cadet = installFakeCadet({ scenario: 'missing' });

    const r = spawnSync('cryptocadet', ['--version'], { encoding: 'utf8' });
    expect(r.error).toBeDefined();
    expect((r.error as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  it('reports uninitialized via exit 1 on policy:show, then initializes', () => {
    cadet = installFakeCadet();

    expect(run(['policy:show']).status).toBe(1);

    expect(run(['init', '--json', '--chain', 'testnet']).status).toBe(0);

    const policy = run(['policy:show']);
    expect(policy.status).toBe(0);
    // The 0.50 USDC human-confirm threshold is what makes ESCALATE the default
    // outcome for any realistic top-up.
    expect(policy.json.requireHumanAboveTx['0x036cbd53842c5426634e7929541ec2318f3dcf7e']).toBe('500000');
  });

  it.each<[CadetScenario, string]>([
    ['confirmed', 'CONFIRMED'],
    ['pending', 'PENDING'],
    ['duplicate', 'DUPLICATE'],
    ['escalate', 'ESCALATE'],
    ['refused', 'REFUSED'],
    ['failed', 'FAILED'],
  ])('checkout in scenario %s reports %s at EXIT CODE 0', (scenario, status) => {
    cadet = installFakeCadet({ scenario, initialized: true });

    const r = run(['checkout', '--quote-file', '/tmp/q.json', '--allowlist-recipient', '--json']);

    // The single most important property of this contract: a business failure is
    // NOT a non-zero exit. Anything branching on `status !== 0` silently treats a
    // REFUSED payment as a crash, or worse, an ESCALATE as a success.
    expect(r.status).toBe(0);
    expect(r.json.status).toBe(status);
  });

  it('flips ESCALATE to CONFIRMED once --approve is passed', () => {
    cadet = installFakeCadet({ scenario: 'escalate', initialized: true });

    expect(run(['checkout', '--quote-file', '/tmp/q.json']).json.status).toBe('ESCALATE');
    expect(run(['checkout', '--quote-file', '/tmp/q.json', '--approve']).json.status).toBe('CONFIRMED');
  });

  it('exits 1 with an empty stdout for a genuine error', () => {
    cadet = installFakeCadet({ initialized: true });

    const r = run(['subs:grant', '--token', '0xabc']); // missing --collector/--cap
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });

  it('returns the grant receipt echoing the collector and cap it was given', () => {
    cadet = installFakeCadet({ initialized: true });

    const r = run([
      'subs:grant',
      '--token', '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      '--collector', '0x00000000000000000000000000000000000000b2',
      '--cap', '1164000000',
    ]);

    expect(r.status).toBe(0);
    expect(r.json).toMatchObject({
      collector: '0x00000000000000000000000000000000000000b2',
      cap: '1164000000',
    });
  });

  it('records every invocation in order so call sequencing can be asserted', () => {
    cadet = installFakeCadet({ initialized: true, agentAddress: '0x2222222222222222222222222222222222222222' });

    run(['wallet:show', '--json']);
    run(['topup:request', '0x036cbd53842c5426634e7929541ec2318f3dcf7e=25000000']);
    run(['checkout', '--quote-file', '/tmp/q.json']);

    // Fund BEFORE minting/paying the quote — quotes carry a ~5 min TTL while
    // funding is a slow human action. src/commands/cryptocadet.ts:6-9 documents
    // this ordering as deliberate; Phase 2 asserts RDK preserves it.
    expect(cadet.calls().map((c) => c.argv[0])).toEqual([
      'wallet:show',
      'topup:request',
      'checkout',
    ]);
    expect(cadet.callsTo('checkout')).toHaveLength(1);
  });

  it('reports the agent wallet address RDK threads into activate-crypto', () => {
    cadet = installFakeCadet({ initialized: true, agentAddress: '0x3333333333333333333333333333333333333333' });

    const r = run(['wallet:show', '--json']);
    expect(r.json.agentAddress).toBe('0x3333333333333333333333333333333333333333');
    expect(r.json.tokens[0].symbol).toBe('USDC');
  });
});
