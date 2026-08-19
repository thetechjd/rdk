// packages/rdk-core/src/query/serve.ts
//
// The last thing that runs before retrieved content becomes model context.
//
// That makes it the model-facing egress choke point, so org redaction is applied
// HERE rather than at each caller: anything that packages results for a model
// inherits it. The policy argument defaults to the node's active policy, so
// skipping redaction requires passing DISABLED_REDACTION_POLICY on purpose.
//
// Human-facing reads (dashboard, desktop content view, `rdk vault:search`) do
// not go through this function and must never be routed through it - they are
// entitled to the full document. See REDACTION_00_DESIGN.md.

import {
  CHUNK_CLOSE_MARKER,
  CHUNK_OPEN_MARKER,
  ELEVATED_RISK_NOTICE,
  REDACTION_NOTICE,
  RESULT_ENVELOPE_HEADER,
  RISK_SCORE_BLOCK_THRESHOLD,
  RISK_SCORE_FLAG_THRESHOLD,
} from './pipeline.constants.js';
import { getActiveRedactionPolicy } from '../redaction/active-policy.js';
import { Redactor } from '../redaction/redact.js';
import type { RedactionPolicy } from '../redaction/types.js';
import type { RerankedCandidate } from './types.js';

export interface PackagedResults {
  /** The envelope that enters the model's context. Already redacted. */
  text: string;
  /** True when at least one span was replaced under the org policy. */
  redacted: boolean;
  /** Distinct values replaced. Safe to log; the values themselves are not. */
  redactedCount: number;
  /**
   * token -> raw value for this response. STAYS ON THE NODE: it is returned so
   * an authorized human on this machine can resolve a token a model referenced.
   * It must never be serialized into a model response or synced to Central.
   */
  tokenMap: ReadonlyMap<string, string>;
}

/**
 * Package results for a model, applying the org's redaction policy.
 *
 * One `Redactor` covers the whole response, which is what makes a token mean the
 * same thing in chunk 1 and chunk 4 - the referential consistency the design
 * calls for.
 */
export function packageResultsForModel(
  results: RerankedCandidate[],
  policy: RedactionPolicy = getActiveRedactionPolicy(),
): PackagedResults {
  const redactor = new Redactor(policy);
  const chunks = results
    .filter((result) => result.riskScore < RISK_SCORE_BLOCK_THRESHOLD)
    .map((result) => {
      const open = CHUNK_OPEN_MARKER
        .replace('{ID}', result.chunkId)
        .replace('{RISK}', result.riskScore.toFixed(3));
      const close = CHUNK_CLOSE_MARKER.replace('{ID}', result.chunkId);
      const notice = result.riskScore >= RISK_SCORE_FLAG_THRESHOLD ? `\n${ELEVATED_RISK_NOTICE}` : '';
      return `${open}${notice}\n${redactor.redact(result.text).content}\n${close}`;
    });

  const redacted = redactor.redactedCount > 0;
  // The notice sits with the envelope header, before any data: a model that
  // meets a token first and the explanation last is the one that guesses.
  const header = redacted ? `${RESULT_ENVELOPE_HEADER}\n\n${REDACTION_NOTICE}` : RESULT_ENVELOPE_HEADER;

  return {
    text: [header, ...chunks].join('\n\n'),
    redacted,
    redactedCount: redactor.redactedCount,
    tokenMap: redactor.tokenMap,
  };
}

/** Text-only form, for callers that do not need the token map. */
export function packageResults(
  results: RerankedCandidate[],
  policy: RedactionPolicy = getActiveRedactionPolicy(),
): string {
  return packageResultsForModel(results, policy).text;
}
