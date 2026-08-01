export interface UnderstoodQuery {
  original: string;
  normalized: string;
  corrected: string;
  variants: string[];
}

export interface Candidate {
  chunkId: string;
  title: string;
  text: string;
  summary?: string;
  rrfScore: number;
  riskScore: number;
  createdAt: Date;
  retrievalCount: number;
  tipCount: number;
  nodeId?: string;
}

export interface RerankedCandidate extends Candidate {
  /** Raw model output, kept as-is for logs and debugging. */
  rerankScore: number;
  /** rerankScore min-max normalized across the candidate pool. Set by
   *  scoreCandidates; this is what the composite score actually uses. */
  rerankNormalized?: number;
  authorityScore?: number;
  freshnessScore?: number;
  finalScore?: number;
}
