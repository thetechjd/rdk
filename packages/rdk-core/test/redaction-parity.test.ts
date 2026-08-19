import { describe, it, expect } from 'vitest';
import { Redactor } from '../src/redaction/redact.js';
import { FIXTURE_SALT, REDACTION_FIXTURES } from './redaction-fixtures.js';
import type { RedactionRule } from '../src/redaction/types.js';

/**
 * The node half of the engine-parity check.
 *
 * The API mirrors this engine so the admin's policy preview can show what a
 * node will actually do. Both repos run these same fixtures against the same
 * salt; a divergence means the preview has started lying to the admin.
 */
describe('redaction engine parity fixtures', () => {
  for (const fixture of REDACTION_FIXTURES) {
    it(fixture.name, () => {
      const redactor = new Redactor({
        enabled: true,
        version: 'fixtures',
        rules: fixture.rules as RedactionRule[],
        tokenSalt: FIXTURE_SALT,
      });
      expect(redactor.redact(fixture.input).content).toBe(fixture.output);
    });
  }
});
