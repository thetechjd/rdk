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
  rerankScore: number;
  authorityScore?: number;
  freshnessScore?: number;
  finalScore?: number;
}
