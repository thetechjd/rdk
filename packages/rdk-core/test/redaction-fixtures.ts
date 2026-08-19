// SHARED REDACTION FIXTURES - keep byte-identical with
// RetroDeckDocker/retrodeck-docker/apps/api/test/unit/redaction-fixtures.ts
//
// The node enforces the org policy; the API mirrors the engine so the admin's
// preview can show what the node will do. An admin who cannot trust the preview
// cannot trust the policy, so the two implementations have to agree exactly -
// and "exactly" has to mean something checkable. These fixtures are that check:
// both sides run them against a fixed salt and assert the same output strings.
//
// If you change the engine or the pattern library, change it in both repos and
// run this suite in both. A divergence here is a divergence a customer would
// eventually find as "the preview lied to me".

export interface RedactionFixture {
  name: string;
  rules: Array<{
    ruleType: 'builtin' | 'regex' | 'termlist';
    builtinKey?: string;
    pattern?: string;
    terms?: string[];
    tokenPrefix: string;
  }>;
  input: string;
  output: string;
}

/** Fixed so token digests are reproducible on both sides. */
export const FIXTURE_SALT = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

const builtin = (key: string, tokenPrefix: string) => ({ ruleType: 'builtin' as const, builtinKey: key, tokenPrefix });

export const REDACTION_FIXTURES: RedactionFixture[] = [
  {
    name: 'ssn',
    rules: [builtin('ssn', 'SSN')],
    input: 'Customer SSN 123-45-6789 on file.',
    output: 'Customer SSN [SSN_f25a1f] on file.',
  },
  {
    name: 'email repeated stays one token',
    rules: [builtin('email', 'EMAIL')],
    input: 'ada@example.com wrote; reply to ada@example.com.',
    output: '[EMAIL_726a04] wrote; reply to [EMAIL_726a04].',
  },
  {
    name: 'luhn-valid card, phone rule present',
    rules: [builtin('phone', 'PHONE'), builtin('credit_card', 'CARD')],
    input: 'card 4111 1111 1111 1111 charged',
    output: 'card [CARD_57085d] charged',
  },
  {
    name: 'non-luhn digits are left alone',
    rules: [builtin('credit_card', 'CARD')],
    input: 'order 1234567812345678',
    output: 'order 1234567812345678',
  },
  {
    name: 'capture group keeps its label',
    rules: [builtin('date_of_birth', 'DOB')],
    input: 'DOB: 1980-04-17',
    output: 'DOB: [DOB_e058de]',
  },
  {
    name: 'custom regex',
    rules: [{ ruleType: 'regex', pattern: 'ACME-\\d+', tokenPrefix: 'TICKET' }],
    input: 'see ACME-4471 and ACME-4471',
    output: 'see [TICKET_056364] and [TICKET_056364]',
  },
  {
    name: 'term list, longest wins, case-insensitive',
    rules: [{ ruleType: 'termlist', terms: ['Northstar', 'Project Northstar'], tokenPrefix: 'INTERNAL' }],
    input: 'project northstar is Project Northstar',
    output: '[INTERNAL_673d57] is [INTERNAL_673d57]',
  },
  {
    name: 'term list does not match inside a longer word',
    rules: [{ ruleType: 'termlist', terms: ['Northstar'], tokenPrefix: 'INTERNAL' }],
    input: 'the northstarter tool',
    output: 'the northstarter tool',
  },
  {
    name: 'several rules over one document',
    rules: [
      builtin('ssn', 'SSN'),
      builtin('email', 'EMAIL'),
      { ruleType: 'termlist', terms: ['Jane Doe'], tokenPrefix: 'PERSON' },
    ],
    input: 'Jane Doe (jane@acme.co, SSN 123-45-6789) called about Jane Doe.',
    output: '[PERSON_b3c3f5] ([EMAIL_8d6417], SSN [SSN_f25a1f]) called about [PERSON_b3c3f5].',
  },
];
