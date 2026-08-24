import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modelEgress } from '../src/model-egress.js';

/**
 * Which CLI invocations count as feeding a model.
 *
 * `rdk query` is the one surface that is genuinely both a human tool and, per
 * docs/coding-agents.md, the documented fallback an agent shells out to. Getting
 * this predicate wrong in the permissive direction hands an org's private
 * content to a model in the clear, so the cases are pinned here rather than left
 * to a reading of the expression.
 *
 * These assert `forModel` — the routing decision — not the redacted text. With
 * no org policy installed there is nothing to redact, and the decision is the
 * part that has to be right whether or not a policy exists today.
 */
describe('model-facing egress detection', () => {
  const original = {
    stdout: process.stdout.isTTY,
    stdin: process.stdin.isTTY,
    ci: process.env.CI,
    nonInteractive: process.env.RDK_NON_INTERACTIVE,
  };

  /** Pretend a person is sitting at a terminal watching this run. */
  function humanAtATerminal(): void {
    process.stdout.isTTY = true;
    process.stdin.isTTY = true;
    delete process.env.CI;
    delete process.env.RDK_NON_INTERACTIVE;
  }

  beforeEach(humanAtATerminal);

  afterEach(() => {
    process.stdout.isTTY = original.stdout;
    process.stdin.isTTY = original.stdin;
    if (original.ci === undefined) delete process.env.CI;
    else process.env.CI = original.ci;
    if (original.nonInteractive === undefined) delete process.env.RDK_NON_INTERACTIVE;
    else process.env.RDK_NON_INTERACTIVE = original.nonInteractive;
  });

  it('leaves a human at an interactive terminal alone', () => {
    expect(modelEgress().forModel).toBe(false);
  });

  it('treats --json as machine-consumed', () => {
    expect(modelEgress({ json: true }).forModel).toBe(true);
  });

  it('honours an explicit --for-model', () => {
    expect(modelEgress({ forModel: true }).forModel).toBe(true);
  });

  it('treats piped output as model-facing', () => {
    process.stdout.isTTY = false;
    expect(modelEgress().forModel).toBe(true);
  });

  it('treats a closed stdin as model-facing', () => {
    // A harness commonly runs the command with stdin detached; nobody can be
    // answering the picker, so nobody is reading the output either.
    process.stdin.isTTY = false;
    expect(modelEgress().forModel).toBe(true);
  });

  // The two that regressed when isInteractive() arrived and this file still
  // checked stdout alone. Both describe an agent that allocated a pty, which is
  // the most model-facing caller there is and the one a bare TTY check waves
  // through. docs/coding-agents.md tells agents to set exactly these.
  it('redacts under RDK_NON_INTERACTIVE even with a pty attached', () => {
    process.env.RDK_NON_INTERACTIVE = '1';
    expect(modelEgress().forModel).toBe(true);
  });

  it('redacts under CI even with a pty attached', () => {
    process.env.CI = 'true';
    expect(modelEgress().forModel).toBe(true);
  });
});
