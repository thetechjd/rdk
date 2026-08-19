// packages/rdk-core/src/redaction/types.ts
//
// The shape of an org's model-facing redaction policy, as it travels from the
// RetroDeck API to a node and as the engine consumes it.
//
// See REDACTION_00_DESIGN.md. The policy is NOT sensitive — it is pattern
// definitions and term lists — which is why it can be synced. The token→value
// map produced by applying it IS sensitive, and never leaves the node.

export type RedactionRuleType = 'builtin' | 'regex' | 'termlist';

export interface RedactionRule {
  /** Server-assigned id. Absent for rules constructed in tests or previews. */
  id?: string;
  ruleType: RedactionRuleType;
  /** Key into BUILTIN_PATTERNS. Required when ruleType is 'builtin'. */
  builtinKey?: string;
  /** Regex source, no delimiters and no flags. Required when ruleType is 'regex'. */
  pattern?: string;
  /** Literal terms/phrases, matched case-insensitively. Required for 'termlist'. */
  terms?: string[];
  /** Replacement token prefix, e.g. 'SSN' → tokens look like [SSN_b2e1]. */
  tokenPrefix: string;
  enabled?: boolean;
}

export interface RedactionPolicy {
  enabled: boolean;
  /**
   * Opaque version stamp, bumped by the API whenever the rule set changes.
   * Nodes refetch when it moves, and it is part of the query cache key — without
   * that, a response redacted under the old policy would keep being served.
   */
  version: string;
  rules: RedactionRule[];
  /**
   * Node-local HMAC key for token derivation, hex.
   *
   * Tokens are a keyed hash of the raw value, not a plain one: a truncated
   * unkeyed hash of a 9-digit SSN is trivially brute-forced by anyone holding
   * the token, which would defeat the entire point. This key is generated once
   * per node, stored at ~/.rdk/redaction-salt, and NEVER synced or served.
   *
   * Absent means "derive an ephemeral per-process key" — still safe, but tokens
   * are then stable only within the lifetime of the process.
   */
  tokenSalt?: string;
}

/** The policy in force when an org has set none. Redacts nothing. */
export const DISABLED_REDACTION_POLICY: RedactionPolicy = Object.freeze({
  enabled: false,
  version: 'none',
  rules: [],
}) as RedactionPolicy;

export interface RedactionResult {
  /** Tokenized content. This — and only this — is safe to put in model context. */
  content: string;
  /** True when at least one span was replaced. */
  redacted: boolean;
  /**
   * token → raw value, for THIS redaction. STAYS ON THE NODE: never included in
   * a model response, never synced to Central, never logged.
   */
  tokenMap: Map<string, string>;
}
