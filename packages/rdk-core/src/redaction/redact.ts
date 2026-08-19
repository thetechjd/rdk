// packages/rdk-core/src/redaction/redact.ts
//
// The redaction engine. This is the choke point every model-facing egress path
// runs content through - see REDACTION_00_DESIGN.md, decision 6.
//
// The rule it enforces: full content stays on the node for humans; content
// crossing into a MODEL's context has its sensitive spans replaced with stable,
// opaque tokens. Never the other way round - this is not index-time redaction
// and it must never be applied to a human-facing read.
//
// Three properties the implementation exists to guarantee:
//
//  1. CONSISTENT - the same raw value always becomes the same token, across
//     every chunk of one response and across sessions on one node, so a model
//     can follow "[PERSON_a8f3]" as a reference without ever learning who it is.
//  2. NON-INVERTIBLE - the token is a keyed hash. An unkeyed truncated hash of
//     an SSN is a nine-digit brute force, i.e. no protection at all.
//  3. DETERMINISTIC - pure pattern matching, no model in the loop. An auditor
//     can read patterns.ts plus the org's rules and know the exact output.

import crypto from 'crypto';
import { BUILTIN_PATTERNS } from './patterns.js';
import {
  DISABLED_REDACTION_POLICY,
  type RedactionPolicy,
  type RedactionResult,
  type RedactionRule,
} from './types.js';

/** Longest regex source an admin-authored rule may carry. */
const MAX_PATTERN_LENGTH = 2000;
/** Terms per term-list rule. Beyond this the alternation stops being sane. */
const MAX_TERMS_PER_RULE = 2000;
/** Per-rule match ceiling. A pathological rule degrades, it does not hang. */
const MAX_MATCHES_PER_RULE = 20_000;
/** Hex digits of the keyed digest used in a token, widened only on collision. */
const TOKEN_DIGEST_WIDTHS = [6, 10, 16, 32] as const;

interface CompiledRule {
  regex: RegExp;
  tokenPrefix: string;
  validate?: (match: string) => boolean;
  /**
   * True when the rule matched without regard to case, so its tokens must be
   * keyed without regard to case too. Otherwise "Jane Doe" and "jane doe" read
   * to the model as two different people - which is exactly the confusion
   * consistent tokenization exists to prevent.
   */
  caseInsensitive: boolean;
  /** Rules earlier in the policy win a tie against a later one. */
  order: number;
}

interface Span {
  start: number;
  end: number;
  value: string;
  tokenPrefix: string;
  caseInsensitive: boolean;
  order: number;
}

/**
 * A redactor whose token map is shared across every call.
 *
 * One response is one redactor: that is what makes "[PERSON_a8f3]" mean the same
 * person in chunk 1 and chunk 4. Build it once per model-facing response, not
 * once per chunk.
 */
export class Redactor {
  private readonly rules: CompiledRule[];
  private readonly salt: Buffer;
  /** token -> raw value. On-node only. Never serialized into a model response. */
  private readonly tokens = new Map<string, string>();
  private readonly valueToToken = new Map<string, string>();

  constructor(private readonly policy: RedactionPolicy = DISABLED_REDACTION_POLICY) {
    this.rules = policy.enabled ? compileRules(policy.rules) : [];
    this.salt = policy.tokenSalt ? Buffer.from(policy.tokenSalt, 'hex') : crypto.randomBytes(32);
  }

  /** False when this redactor would never change anything - lets callers skip work. */
  get active(): boolean {
    return this.rules.length > 0;
  }

  get version(): string {
    return this.policy.version;
  }

  /** token -> raw value seen so far. Read by humans on this node; never served. */
  get tokenMap(): ReadonlyMap<string, string> {
    return this.tokens;
  }

  /** Distinct values replaced so far - safe to log, unlike the values themselves. */
  get redactedCount(): number {
    return this.tokens.size;
  }

  redact(content: string): RedactionResult {
    if (!this.active || !content) {
      return { content, redacted: false, tokenMap: new Map() };
    }

    const spans = resolveOverlaps(this.rules.flatMap((rule) => matchRule(rule, content)));
    if (spans.length === 0) return { content, redacted: false, tokenMap: new Map() };

    const local = new Map<string, string>();
    const pieces: string[] = [];
    let cursor = 0;
    for (const span of spans) {
      const token = this.tokenFor(span.tokenPrefix, span.value, span.caseInsensitive);
      pieces.push(content.slice(cursor, span.start), token);
      local.set(token, span.value);
      cursor = span.end;
    }
    pieces.push(content.slice(cursor));

    return { content: pieces.join(''), redacted: true, tokenMap: local };
  }

  /**
   * The same value always resolves to the same token. Widening on collision
   * matters: two different values sharing one token would silently tell the
   * model that two people are one person.
   */
  private tokenFor(prefix: string, value: string, caseInsensitive: boolean): string {
    // The KEY is folded for case-insensitive rules so casing variants collapse
    // to one token; the MAP still records the value as it appeared, so a human
    // resolving the token sees the real text.
    const key = `${prefix} ${caseInsensitive ? value.toLowerCase() : value}`;
    const existing = this.valueToToken.get(key);
    if (existing) return existing;

    const digest = crypto.createHmac('sha256', this.salt).update(key).digest('hex');
    for (const width of TOKEN_DIGEST_WIDTHS) {
      const token = `[${prefix}_${digest.slice(0, width)}]`;
      const claimed = this.tokens.get(token);
      if (claimed === undefined || claimed === value) {
        this.tokens.set(token, value);
        this.valueToToken.set(key, token);
        return token;
      }
    }
    // Four widths of SHA-256 all colliding is not reachable in practice; a
    // counter suffix keeps the guarantee total rather than nearly total.
    const token = `[${prefix}_${digest}_${this.tokens.size}]`;
    this.tokens.set(token, value);
    this.valueToToken.set(key, token);
    return token;
  }
}

/**
 * Redact one string under a policy. Convenience wrapper - when a response has
 * more than one piece of content, build a single `Redactor` instead so tokens
 * stay consistent across the pieces.
 */
export function redactForModel(
  content: string,
  policy: RedactionPolicy = DISABLED_REDACTION_POLICY,
): RedactionResult {
  return new Redactor(policy).redact(content);
}

// -- compilation -------------------------------------------------------------

/**
 * Turn policy rules into regexes, skipping any that cannot compile.
 *
 * Skipping is deliberate: one malformed admin regex must not take the whole
 * policy offline and hand a model unredacted content. The skip is loud.
 */
function compileRules(rules: readonly RedactionRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  rules.forEach((rule, order) => {
    if (rule.enabled === false) return;
    try {
      const entry = compileRule(rule, order);
      if (entry) compiled.push(entry);
    } catch (error) {
      console.error(
        `[rdk] redaction rule ${rule.id ?? rule.tokenPrefix} skipped - ${(error as Error).message}`,
      );
    }
  });
  return compiled;
}

function compileRule(rule: RedactionRule, order: number): CompiledRule | null {
  const tokenPrefix = normalizeTokenPrefix(rule.tokenPrefix);

  if (rule.ruleType === 'builtin') {
    const builtin = rule.builtinKey ? BUILTIN_PATTERNS[rule.builtinKey] : undefined;
    if (!builtin) throw new Error(`unknown builtin '${rule.builtinKey}'`);
    return {
      regex: new RegExp(builtin.source, `${builtin.flags}g`),
      tokenPrefix: tokenPrefix || builtin.tokenPrefix,
      validate: builtin.validate,
      caseInsensitive: builtin.flags.includes('i'),
      order,
    };
  }

  if (rule.ruleType === 'regex') {
    const source = rule.pattern ?? '';
    if (!source) throw new Error('regex rule has no pattern');
    if (source.length > MAX_PATTERN_LENGTH) {
      throw new Error(`pattern longer than ${MAX_PATTERN_LENGTH} characters`);
    }
    if (!tokenPrefix) throw new Error('regex rule has no usable token prefix');
    return { regex: new RegExp(source, 'g'), tokenPrefix, caseInsensitive: false, order };
  }

  if (rule.ruleType === 'termlist') {
    const terms = (rule.terms ?? [])
      .map((term) => term.trim())
      .filter((term) => term.length > 0)
      .slice(0, MAX_TERMS_PER_RULE)
      // Longest first so "Project Northstar" wins over "Northstar".
      .sort((a, b) => b.length - a.length);
    if (terms.length === 0) return null;
    if (!tokenPrefix) throw new Error('term-list rule has no usable token prefix');
    return { regex: new RegExp(terms.map(termPattern).join('|'), 'giu'), tokenPrefix, caseInsensitive: true, order };
  }

  throw new Error(`unknown rule type '${String(rule.ruleType)}'`);
}

/**
 * Anchor a literal term on word boundaries only where one exists.
 *
 * A bare \b around "C++" or "@acme" never matches, because the boundary is
 * asserted against a non-word character. Deciding per end keeps symbol-bearing
 * codenames working without letting "cat" match inside "concatenate".
 */
function termPattern(term: string): string {
  const escaped = escapeRegex(term);
  const left = /^[\p{L}\p{N}_]/u.test(term) ? String.raw`\b` : '';
  const right = /[\p{L}\p{N}_]$/u.test(term) ? String.raw`\b` : '';
  return `${left}${escaped}${right}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Tokens are read by humans in logs; keep the prefix to a predictable shape. */
export function normalizeTokenPrefix(prefix: string): string {
  return (prefix ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 30);
}

// -- matching ----------------------------------------------------------------

/**
 * Every match of one rule, as spans over the ORIGINAL content.
 *
 * Matching against the original rather than against the partially-rewritten
 * string is what stops a later rule from matching inside a token an earlier
 * rule just inserted, and what makes the result independent of rule order
 * except where spans genuinely overlap.
 */
function matchRule(rule: CompiledRule, content: string): Span[] {
  const spans: Span[] = [];
  rule.regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  let guard = 0;

  while ((match = rule.regex.exec(content)) !== null) {
    if (++guard > MAX_MATCHES_PER_RULE) {
      console.error(
        `[rdk] redaction rule ${rule.tokenPrefix} hit the ${MAX_MATCHES_PER_RULE}-match ceiling; ` +
        'the remainder of this content was not scanned by it',
      );
      break;
    }

    // A zero-width match would loop forever and redact nothing.
    if (match[0].length === 0) {
      rule.regex.lastIndex += 1;
      continue;
    }

    // A capture group means the pattern needed context to find the value but
    // only the value should be replaced - "DOB: 1980-01-01" keeps its label.
    const captured = match.length > 1 ? match[1] : undefined;
    let start = match.index;
    let value = match[0];
    if (captured !== undefined && captured.length > 0) {
      const offset = match[0].lastIndexOf(captured);
      if (offset >= 0) {
        start = match.index + offset;
        value = captured;
      }
    }

    if (rule.validate && !rule.validate(value)) continue;
    spans.push({
      start,
      end: start + value.length,
      value,
      tokenPrefix: rule.tokenPrefix,
      caseInsensitive: rule.caseInsensitive,
      order: rule.order,
    });
  }

  return spans;
}

/**
 * Pick a non-overlapping set: leftmost first, then longest, then the rule the
 * admin listed first. Overlaps are real - a Luhn-valid card number contains
 * something a phone pattern likes - and replacing both would corrupt the text.
 */
function resolveOverlaps(spans: Span[]): Span[] {
  spans.sort((a, b) =>
    a.start - b.start
    || (b.end - b.start) - (a.end - a.start)
    || a.order - b.order,
  );
  const kept: Span[] = [];
  let boundary = -1;
  for (const span of spans) {
    if (span.start < boundary) continue;
    kept.push(span);
    boundary = span.end;
  }
  return kept;
}
