import { afterEach, describe, expect, it } from 'vitest';
import { isInteractive } from '../src/interactive.js';

const originalCi = process.env.CI;
const originalNonInteractive = process.env.RDK_NON_INTERACTIVE;

afterEach(() => {
  if (originalCi === undefined) delete process.env.CI; else process.env.CI = originalCi;
  if (originalNonInteractive === undefined) delete process.env.RDK_NON_INTERACTIVE;
  else process.env.RDK_NON_INTERACTIVE = originalNonInteractive;
});

describe('isInteractive', () => {
  it('is false in CI', () => {
    process.env.CI = 'true';
    expect(isInteractive()).toBe(false);
  });

  it('honors RDK_NON_INTERACTIVE', () => {
    process.env.RDK_NON_INTERACTIVE = '1';
    expect(isInteractive()).toBe(false);
  });
});
