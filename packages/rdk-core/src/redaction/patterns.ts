// packages/rdk-core/src/redaction/patterns.ts
//
// The built-in pattern library an org admin toggles on and off. Deterministic
// and auditable by design — an enterprise has to be able to read this file and
// know exactly what will and will not be replaced. No model decides anything
// here; LLM-based semantic detection is explicitly out of scope for v1.
//
// Patterns are stored WITHOUT the global flag; the engine compiles its own
// copies so a shared lastIndex can never leak between calls.

/** A validator narrows a pattern that is necessarily loose on its own. */
export type BuiltinValidator = (match: string) => boolean;

export interface BuiltinPattern {
  /** Human label for the admin UI. */
  label: string;
  /** One-line description of what it catches — shown next to the toggle. */
  description: string;
  source: string;
  flags: string;
  tokenPrefix: string;
  /** Optional second gate. A match that fails it is left alone. */
  validate?: BuiltinValidator;
}

/** Luhn check — what actually separates a card number from 16 digits of noise. */
function luhn(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Rejects out-of-range and zero-padded quads.
 *
 * It cannot tell an address from a four-part version number - nothing can,
 * without context - so an org enabling this builtin is accepting that
 * "upgraded to 1.2.3.4" gets tokenized too.
 */
function ipv4(match: string): boolean {
  const octets = match.split('.');
  if (octets.length !== 4) return false;
  return octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    // A leading zero means it is formatting, not a dotted quad.
    if (octet.length > 1 && octet.startsWith('0')) return false;
    return Number(octet) <= 255;
  });
}

/** Rejects the reserved SSN forms, which are placeholders rather than real. */
function ssn(match: string): boolean {
  const [area, group, serial] = match.split('-');
  return area !== '000' && area !== '666' && !area.startsWith('9')
    && group !== '00' && serial !== '0000';
}

export const BUILTIN_PATTERNS: Readonly<Record<string, BuiltinPattern>> = Object.freeze({
  ssn: {
    label: 'US Social Security number',
    description: 'Nine digits in 123-45-6789 form, excluding the reserved ranges.',
    source: String.raw`\b\d{3}-\d{2}-\d{4}\b`,
    flags: '',
    tokenPrefix: 'SSN',
    validate: ssn,
  },
  credit_card: {
    label: 'Payment card number',
    description: '13–19 digit card numbers that pass a Luhn check, spaces or dashes allowed.',
    source: String.raw`\b\d(?:[ -]?\d){12,18}\b`,
    flags: '',
    tokenPrefix: 'CARD',
    validate: luhn,
  },
  email: {
    label: 'Email address',
    description: 'Any address of the form name@domain.tld.',
    source: String.raw`\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b`,
    flags: '',
    tokenPrefix: 'EMAIL',
  },
  phone: {
    label: 'Phone number',
    description: 'North-American-style numbers, with or without country code and separators.',
    source: String.raw`(?:\+?\d{1,2}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b`,
    flags: '',
    tokenPrefix: 'PHONE',
  },
  api_key: {
    label: 'API key or token',
    description: 'sk-/pk-/api_/key- prefixed secrets and long bearer-style tokens.',
    source: String.raw`\b(?:sk|pk|api|key|token|secret)[-_][A-Za-z0-9_-]{16,}\b`,
    flags: 'i',
    tokenPrefix: 'KEY',
  },
  aws_access_key: {
    label: 'AWS access key id',
    description: 'AKIA/ASIA/AGPA-prefixed 20-character AWS key identifiers.',
    source: String.raw`\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b`,
    flags: '',
    tokenPrefix: 'AWSKEY',
  },
  private_key_block: {
    label: 'Private key block',
    description: 'PEM-armoured private keys, header through footer.',
    source: String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`,
    flags: '',
    tokenPrefix: 'PRIVATEKEY',
  },
  ip_address: {
    label: 'IPv4 address',
    description: 'Dotted quads with valid octets. Four-part version numbers match too.',
    source: String.raw`\b(?:\d{1,3}\.){3}\d{1,3}\b`,
    flags: '',
    tokenPrefix: 'IP',
    validate: ipv4,
  },
  iban: {
    label: 'IBAN',
    description: 'International bank account numbers.',
    source: String.raw`\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b`,
    flags: '',
    tokenPrefix: 'IBAN',
  },
  us_passport: {
    label: 'US passport number',
    description: 'Nine-character passport numbers written next to the word "passport".',
    source: String.raw`\bpassport\s*(?:no\.?|number|#)?\s*:?\s*([A-Z]?\d{8,9})\b`,
    flags: 'i',
    tokenPrefix: 'PASSPORT',
  },
  date_of_birth: {
    label: 'Date of birth',
    description: 'Dates written next to "DOB" or "date of birth".',
    source: String.raw`\b(?:DOB|date of birth)\s*:?\s*(\d{1,4}[/-]\d{1,2}[/-]\d{1,4})\b`,
    flags: 'i',
    tokenPrefix: 'DOB',
  },
});

export type BuiltinKey = keyof typeof BUILTIN_PATTERNS;

/** The catalog the admin UI renders, without exposing regex internals it cannot use. */
export function builtinCatalog(): Array<{
  key: string;
  label: string;
  description: string;
  tokenPrefix: string;
  pattern: string;
}> {
  return Object.entries(BUILTIN_PATTERNS).map(([key, entry]) => ({
    key,
    label: entry.label,
    description: entry.description,
    tokenPrefix: entry.tokenPrefix,
    pattern: entry.source,
  }));
}
