import {
  CHUNK_CLOSE_MARKER,
  CHUNK_OPEN_MARKER,
  ELEVATED_RISK_NOTICE,
  RESULT_ENVELOPE_HEADER,
  RISK_SCORE_BLOCK_THRESHOLD,
  RISK_SCORE_FLAG_THRESHOLD,
} from './pipeline.constants.js';
import type { RerankedCandidate } from './types.js';

export function packageResults(results: RerankedCandidate[]): string {
  const chunks = results.filter((result) => result.riskScore < RISK_SCORE_BLOCK_THRESHOLD).map((result) => {
    const open = CHUNK_OPEN_MARKER
      .replace('{ID}', result.chunkId)
      .replace('{RISK}', result.riskScore.toFixed(3));
    const close = CHUNK_CLOSE_MARKER.replace('{ID}', result.chunkId);
    const notice = result.riskScore >= RISK_SCORE_FLAG_THRESHOLD ? `\n${ELEVATED_RISK_NOTICE}` : '';
    return `${open}${notice}\n${result.text}\n${close}`;
  });
  return [RESULT_ENVELOPE_HEADER, ...chunks].join('\n\n');
}
