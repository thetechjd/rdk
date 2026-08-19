import { describe, it, expect, afterEach, vi } from 'vitest';
import { Redactor, redactForModel } from '../src/redaction/redact.js';
import { BUILTIN_PATTERNS, builtinCatalog } from '../src/redaction/patterns.js';
import { DISABLED_REDACTION_POLICY, type RedactionPolicy, type RedactionRule } from '../src/redaction/types.js';
import {
  getActiveRedactionPolicy,
  redactionIsActive,
  setActiveRedactionPolicy,
} from '../src/redaction/active-policy.js';
import { packageResultsForModel, packageResults } from '../src/query/serve.js';
import { REDACTION_NOTICE, RISK_SCORE_BLOCK_THRESHOLD } from '../src/query/pipeline.constants.js';
import type { RerankedCandidate } from '../src/query/types.js';

/** A fixed salt keeps token assertions reproducible across runs. */
const SALT = 'a'.repeat(64);

function policy(rules: RedactionRule[], enabled = true): RedactionPolicy {
  return { enabled, version: 'v1', rules, tokenSalt: SALT };
}

function builtins(...keys: string[]): RedactionRule[] {
  return keys.map((key) => ({
    ruleType: 'builtin' as const,
    builtinKey: key,
    tokenPrefix: BUILTIN_PATTERNS[key].tokenPrefix,
  }));
}

afterEach(() => {
  setActiveRedactionPolicy(null);
  vi.restoreAllMocks();
});

describe('built-in patterns', () => {
  it('tokenizes the design doc example', () => {
    const { content, redacted, tokenMap } = redactForModel(
      'Customer Jane Doe (SSN 123-45-6789) disputed invoice #4471',
      policy([
        ...builtins('ssn'),
        { ruleType: 'termlist', terms: ['Jane Doe'], tokenPrefix: 'PERSON' },
        { ruleType: 'regex', pattern: String.raw`invoice #\d+`, tokenPrefix: 'INVOICE' },
      ]),
    );

    expect(redacted).toBe(true);
    expect(content).not.toContain('123-45-6789');
    expect(content).not.toContain('Jane Doe');
    expect(content).toMatch(/^Customer \[PERSON_[0-9a-f]{6}] \(SSN \[SSN_[0-9a-f]{6}]\) disputed \[INVOICE_[0-9a-f]{6}]$/);
    expect([...tokenMap.values()].sort()).toEqual(['123-45-6789', 'Jane Doe', 'invoice #4471']);
  });

  it('catches each shipped builtin on a representative sample', () => {
    const samples: Array<[string, string, string]> = [
      ['ssn', 'ssn is 123-45-6789 here', '123-45-6789'],
      ['credit_card', 'card 4111 1111 1111 1111 charged', '4111 1111 1111 1111'],
      ['email', 'write to ada@example.co.uk today', 'ada@example.co.uk'],
      ['phone', 'call +1 415-555-0132 now', '+1 415-555-0132'],
      ['api_key', 'use sk-live_ABCDEFGHIJKLMNOP12 for auth', 'sk-live_ABCDEFGHIJKLMNOP12'],
      ['aws_access_key', 'key AKIAIOSFODNN7EXAMPLE rotated', 'AKIAIOSFODNN7EXAMPLE'],
      ['ip_address', 'host 192.168.10.4 responded', '192.168.10.4'],
      ['iban', 'send to GB82 WEST 1234 5698 7654 32 please', 'GB82 WEST 1234 5698 7654 32'],
      ['us_passport', 'passport no: X12345678 attached', 'X12345678'],
      ['date_of_birth', 'DOB: 1980-04-17 on file', '1980-04-17'],
    ];

    for (const [key, text, secret] of samples) {
      const result = redactForModel(text, policy(builtins(key)));
      expect(result.redacted, key).toBe(true);
      expect(result.content, key).not.toContain(secret);
      expect([...result.tokenMap.values()], key).toContain(secret);
    }
  });

  it('redacts a PEM private key block whole', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\nhQ==\n-----END RSA PRIVATE KEY-----';
    const result = redactForModel(`config:\n${pem}\ndone`, policy(builtins('private_key_block')));
    expect(result.content).toBe(`config:\n[PRIVATEKEY_${tokenDigest(result)}]\ndone`);
  });

  it('leaves the label in place when a pattern needed it only as context', () => {
    const { content } = redactForModel('DOB: 1980-04-17', policy(builtins('date_of_birth')));
    expect(content).toMatch(/^DOB: \[DOB_[0-9a-f]{6}]$/);
  });

  it('rejects out-of-range and zero-padded dotted quads', () => {
    expect(redactForModel('bound 10.0.0.256', policy(builtins('ip_address'))).redacted).toBe(false);
    expect(redactForModel('bound 010.0.0.1', policy(builtins('ip_address'))).redacted).toBe(false);
    expect(redactForModel('bound 10.0.0.1', policy(builtins('ip_address'))).redacted).toBe(true);
  });

  it('does not treat sixteen arbitrary digits as a card number', () => {
    expect(redactForModel('order 1234567812345678', policy(builtins('credit_card'))).redacted).toBe(false);
  });

  it('leaves the reserved placeholder SSNs alone', () => {
    expect(redactForModel('ssn 000-12-3456', policy(builtins('ssn'))).redacted).toBe(false);
    expect(redactForModel('ssn 123-45-0000', policy(builtins('ssn'))).redacted).toBe(false);
  });

  it('exposes a catalog for the admin UI without leaking internals', () => {
    const catalog = builtinCatalog();
    expect(catalog.length).toBe(Object.keys(BUILTIN_PATTERNS).length);
    expect(catalog.every((entry) => entry.label && entry.description && entry.tokenPrefix)).toBe(true);
  });
});

describe('custom rules', () => {
  it('applies admin regex rules', () => {
    const result = redactForModel(
      'ticket ACME-4471 and ACME-9 are open',
      policy([{ ruleType: 'regex', pattern: String.raw`ACME-\d+`, tokenPrefix: 'TICKET' }]),
    );
    expect(result.content).not.toMatch(/ACME-\d/);
    expect(result.tokenMap.size).toBe(2);
  });

  it('matches term lists case-insensitively but not inside longer words', () => {
    const rules: RedactionRule[] = [{ ruleType: 'termlist', terms: ['Northstar'], tokenPrefix: 'INTERNAL' }];
    expect(redactForModel('project northstar ships', policy(rules)).redacted).toBe(true);
    expect(redactForModel('the northstarter tool', policy(rules)).redacted).toBe(false);
  });

  it('prefers the longest term when terms nest', () => {
    const result = redactForModel(
      'Project Northstar is internal',
      policy([{ ruleType: 'termlist', terms: ['Northstar', 'Project Northstar'], tokenPrefix: 'INTERNAL' }]),
    );
    expect([...result.tokenMap.values()]).toEqual(['Project Northstar']);
  });

  it('handles terms whose edges are not word characters', () => {
    const result = redactForModel(
      'ping @acme-ops about it',
      policy([{ ruleType: 'termlist', terms: ['@acme-ops'], tokenPrefix: 'TEAM' }]),
    );
    expect(result.redacted).toBe(true);
  });

  it('skips a rule that cannot compile instead of dropping the whole policy', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = redactForModel(
      'ssn 123-45-6789',
      policy([{ ruleType: 'regex', pattern: '([unclosed', tokenPrefix: 'BAD' }, ...builtins('ssn')]),
    );
    expect(result.redacted).toBe(true);
    expect(result.content).not.toContain('123-45-6789');
    expect(stderr).toHaveBeenCalled();
  });

  it('ignores rules the admin disabled', () => {
    const rules: RedactionRule[] = [{ ...builtins('ssn')[0], enabled: false }];
    expect(redactForModel('ssn 123-45-6789', policy(rules)).redacted).toBe(false);
  });

  it('does not hang on a pattern that can match empty', () => {
    const result = redactForModel(
      'aaa',
      policy([{ ruleType: 'regex', pattern: 'a*', tokenPrefix: 'X' }]),
    );
    expect(result.redacted).toBe(true);
  });
});

describe('tokenization properties', () => {
  it('gives the same value the same token across chunks of one response', () => {
    const redactor = new Redactor(policy(builtins('email')));
    const first = redactor.redact('ping ada@example.com');
    const second = redactor.redact('ada@example.com replied');
    const token = /\[EMAIL_[0-9a-f]+]/.exec(first.content)![0];
    expect(second.content).toContain(token);
    expect(redactor.redactedCount).toBe(1);
  });

  it('gives different values different tokens', () => {
    const result = redactForModel('ada@example.com and bob@example.com', policy(builtins('email')));
    const tokens = [...result.tokenMap.keys()];
    expect(new Set(tokens).size).toBe(2);
  });

  it('is stable across processes when the node salt is stable', () => {
    const a = redactForModel('ada@example.com', policy(builtins('email'))).content;
    const b = redactForModel('ada@example.com', policy(builtins('email'))).content;
    expect(a).toBe(b);
  });

  it('is NOT stable across nodes with different salts, so tokens are not a global handle', () => {
    const other: RedactionPolicy = { ...policy(builtins('email')), tokenSalt: 'b'.repeat(64) };
    expect(redactForModel('ada@example.com', policy(builtins('email'))).content)
      .not.toBe(redactForModel('ada@example.com', other).content);
  });

  it('does not derive tokens from an unkeyed hash of the value', () => {
    // A token an attacker could reproduce from the value alone would make a
    // nine-digit SSN recoverable by brute force. Two different salts producing
    // two different tokens is what rules that out.
    const digestOf = (salt: string) =>
      redactForModel('123-45-6789', { enabled: true, version: 'v', rules: builtins('ssn'), tokenSalt: salt }).content;
    expect(digestOf('c'.repeat(64))).not.toBe(digestOf('d'.repeat(64)));
  });

  it('resolves overlapping matches without corrupting the text', () => {
    // The card number contains ten digits a phone pattern is happy to claim.
    const result = redactForModel(
      'card 4111111111111111 on file',
      policy(builtins('phone', 'credit_card')),
    );
    expect(result.content).toMatch(/^card \[CARD_[0-9a-f]{6}] on file$/);
  });

  it('never lets one rule match inside a token another rule inserted', () => {
    const result = redactForModel(
      'ada@example.com',
      policy([
        ...builtins('email'),
        { ruleType: 'regex', pattern: '[A-Z]+_[0-9a-f]+', tokenPrefix: 'GREEDY' },
      ]),
    );
    expect(result.content).not.toContain('GREEDY');
  });
});

describe('policy gating', () => {
  it('returns content untouched when the policy is disabled', () => {
    const result = redactForModel('ssn 123-45-6789', policy(builtins('ssn'), false));
    expect(result).toEqual({ content: 'ssn 123-45-6789', redacted: false, tokenMap: new Map() });
  });

  it('returns content untouched under the default disabled policy', () => {
    expect(redactForModel('ssn 123-45-6789').redacted).toBe(false);
    expect(new Redactor(DISABLED_REDACTION_POLICY).active).toBe(false);
  });

  it('reports whether the installed policy would change anything', () => {
    expect(redactionIsActive()).toBe(false);
    setActiveRedactionPolicy(policy(builtins('ssn')));
    expect(redactionIsActive()).toBe(true);
    expect(getActiveRedactionPolicy().version).toBe('v1');
    setActiveRedactionPolicy(policy([{ ...builtins('ssn')[0], enabled: false }]));
    expect(redactionIsActive()).toBe(false);
  });
});

describe('the model-facing egress', () => {
  const candidate = (id: string, text: string, riskScore = 0): RerankedCandidate => ({
    chunkId: id,
    title: id,
    text,
    rrfScore: 1,
    riskScore,
    createdAt: new Date('2026-01-01'),
    retrievalCount: 0,
    tipCount: 0,
    rerankScore: 1,
  });

  it('applies the node policy WITHOUT being asked - a new caller inherits it', () => {
    setActiveRedactionPolicy(policy(builtins('ssn')));
    const text = packageResults([candidate('c1', 'ssn 123-45-6789')]);
    expect(text).not.toContain('123-45-6789');
  });

  it('tells the model that redaction happened', () => {
    setActiveRedactionPolicy(policy(builtins('ssn')));
    const packaged = packageResultsForModel([candidate('c1', 'ssn 123-45-6789')]);
    expect(packaged.redacted).toBe(true);
    expect(packaged.text).toContain(REDACTION_NOTICE);
  });

  it('stays silent about redaction when nothing was redacted', () => {
    setActiveRedactionPolicy(policy(builtins('ssn')));
    const packaged = packageResultsForModel([candidate('c1', 'nothing sensitive here')]);
    expect(packaged.redacted).toBe(false);
    expect(packaged.text).not.toContain(REDACTION_NOTICE);
  });

  it('keeps one token meaning one value across every chunk of the response', () => {
    setActiveRedactionPolicy(policy(builtins('email')));
    const packaged = packageResultsForModel([
      candidate('c1', 'owner ada@example.com'),
      candidate('c2', 'ada@example.com approved it'),
    ]);
    const token = /\[EMAIL_[0-9a-f]+]/.exec(packaged.text)![0];
    expect(packaged.text.split(token).length - 1).toBe(2);
    expect(packaged.redactedCount).toBe(1);
  });

  it('hands the token map back to the node and never puts it in the text', () => {
    setActiveRedactionPolicy(policy(builtins('email')));
    const packaged = packageResultsForModel([candidate('c1', 'ada@example.com')]);
    expect([...packaged.tokenMap.values()]).toEqual(['ada@example.com']);
    expect(packaged.text).not.toContain('ada@example.com');
  });

  it('still drops blocked chunks, and never redacts one into visibility', () => {
    setActiveRedactionPolicy(policy(builtins('ssn')));
    const packaged = packageResultsForModel([
      candidate('safe', 'ssn 123-45-6789'),
      candidate('blocked', 'ssn 987-65-4321', RISK_SCORE_BLOCK_THRESHOLD),
    ]);
    expect(packaged.text).toContain('chunk_id=safe');
    expect(packaged.text).not.toContain('chunk_id=blocked');
    expect(packaged.text).not.toContain('987-65-4321');
  });

  it('can be opted out of, but only by passing the disabled policy explicitly', () => {
    setActiveRedactionPolicy(policy(builtins('ssn')));
    expect(packageResults([candidate('c1', 'ssn 123-45-6789')], DISABLED_REDACTION_POLICY))
      .toContain('123-45-6789');
  });
});

describe('human paths are never redacted', () => {
  /**
   * The design's whole premise is that the data is sensitive to the MODEL, not
   * to the team: a teammate is trusted with the full document and must keep
   * seeing it whole. So the guarantee runs in BOTH directions, and the second
   * direction is the one a careless change breaks silently - nobody notices
   * that a human read started returning tokens until someone complains their
   * own notes are unreadable.
   *
   * These lock the divergence in place at the engine level. The desktop's real
   * read paths are covered against a live policy in
   * apps/desktop/test/main/redaction-human-reads.test.ts.
   */
  const AGGRESSIVE = policy([
    ...builtins('ssn', 'email', 'phone', 'credit_card', 'ip_address', 'api_key'),
    { ruleType: 'termlist', terms: ['Jane Doe', 'Project Northstar'], tokenPrefix: 'INTERNAL' },
    { ruleType: 'regex', pattern: String.raw`ACME-\d+`, tokenPrefix: 'TICKET' },
  ]);

  const DOCUMENT =
    'Jane Doe (jane@acme.co, SSN 123-45-6789) filed ACME-4471 about Project Northstar. ' +
    'Card 4111 1111 1111 1111, host 10.4.2.19, key sk-live_ABCDEFGHIJKLMNOP12.';

  it('leaves stored content untouched — redaction is a serving transform, not a mutation', () => {
    setActiveRedactionPolicy(AGGRESSIVE);
    const stored = DOCUMENT;
    redactForModel(stored, AGGRESSIVE);
    // The engine returns a new string and never writes through to its input.
    // A human read of the same value has to still see every original span.
    expect(stored).toBe(DOCUMENT);
    expect(stored).toContain('123-45-6789');
    expect(stored).toContain('Jane Doe');
  });

  it('redacts the SAME content on the model path, so the two genuinely diverge', () => {
    setActiveRedactionPolicy(AGGRESSIVE);
    const forModel = packageResultsForModel([{
      chunkId: 'c1',
      title: 'Case notes',
      text: DOCUMENT,
      rrfScore: 1,
      riskScore: 0,
      createdAt: new Date('2026-01-01'),
      retrievalCount: 0,
      tipCount: 0,
      rerankScore: 1,
    }]);

    expect(forModel.redacted).toBe(true);
    for (const secret of [
      '123-45-6789', 'Jane Doe', 'jane@acme.co', 'ACME-4471',
      'Project Northstar', '4111 1111 1111 1111', '10.4.2.19', 'sk-live_ABCDEFGHIJKLMNOP12',
    ]) {
      expect(forModel.text, secret).not.toContain(secret);
    }
    // ...while the human-side value is the untouched original.
    expect(DOCUMENT).toContain('123-45-6789');
  });
});

/** Pulls the digest out of a single-token result so PEM assertions stay exact. */
function tokenDigest(result: { tokenMap: Map<string, string> }): string {
  return /_([0-9a-f]+)]$/.exec([...result.tokenMap.keys()][0])![1];
}
