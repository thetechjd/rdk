import { INJECTION_PATTERNS, RISK_SCORE_BLOCK_THRESHOLD } from '../query/pipeline.constants.js';

const compiled = INJECTION_PATTERNS.map((source) => new RegExp(source, 'i'));

export function scanChunk(text: string): number {
  const matches = compiled.map((pattern) => pattern.test(text));
  const fraction = matches.filter(Boolean).length / INJECTION_PATTERNS.length;
  const weighted = Math.min(1, fraction * 3);
  const commandExecutionMatch = matches.slice(7, 12).some(Boolean);
  return commandExecutionMatch ? Math.max(RISK_SCORE_BLOCK_THRESHOLD, weighted) : weighted;
}
