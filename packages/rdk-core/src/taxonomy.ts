// packages/rdk-core/src/taxonomy.ts
// Two-level taxonomy: domain (set by operator) + categories (auto-assigned per chunk).

export const TAXONOMY: Record<string, string[]> = {
  fintech:      ['compliance', 'regulation', 'payments', 'crypto', 'banking', 'risk', 'audit', 'kyc', 'aml'],
  legal:        ['contracts', 'ip', 'employment', 'litigation', 'corporate', 'privacy', 'gdpr', 'terms'],
  healthcare:   ['clinical', 'billing', 'hipaa', 'pharma', 'research', 'patient-care', 'diagnostics'],
  engineering:  ['architecture', 'devops', 'security', 'api-design', 'databases', 'ai-ml', 'frontend', 'backend'],
  ecommerce:    ['inventory', 'fulfillment', 'pricing', 'customer-service', 'analytics', 'logistics'],
  marketing:    ['content', 'seo', 'aeo', 'social', 'email', 'paid-media', 'analytics', 'branding'],
  education:    ['curriculum', 'assessment', 'pedagogy', 'research', 'stem', 'humanities'],
  research:     ['methodology', 'data-analysis', 'literature-review', 'experiment', 'publication'],
  operations:   ['project-management', 'process', 'hr', 'finance', 'supply-chain', 'quality'],
  general:      ['reference', 'how-to', 'faq', 'documentation', 'guide', 'tutorial'],
};

export type DomainKey = keyof typeof TAXONOMY;

/** Keyword-based zero-shot categorizer. No LLM call required for basic tagging. */
export function categorizeChunk(text: string, domain: string): string[] {
  const lower = text.toLowerCase();
  const domainCategories = TAXONOMY[domain] ?? TAXONOMY['general'];
  const matched: string[] = [];

  for (const category of domainCategories) {
    // Simple keyword heuristic — check if category keyword or related terms appear
    const keywords = getCategoryKeywords(category);
    const hits = keywords.filter(kw => lower.includes(kw));
    if (hits.length > 0) {
      matched.push(category);
    }
  }

  // Cross-domain detection: always check engineering if code patterns exist
  if (domain !== 'engineering' && hasCodePatterns(lower)) {
    matched.push('engineering');
  }

  return matched.length > 0 ? matched : ['general'];
}

function hasCodePatterns(text: string): boolean {
  return /```|function\s+\w+|const\s+\w+|class\s+\w+|import\s+\w+|SELECT\s+\w+/i.test(text);
}

function getCategoryKeywords(category: string): string[] {
  const KEYWORDS: Record<string, string[]> = {
    compliance:       ['compliance', 'regulation', 'regulatory', 'sox', 'pci', 'iso 27001'],
    regulation:       ['regulation', 'regulatory', 'statute', 'rule', 'mandate'],
    payments:         ['payment', 'transaction', 'transfer', 'settlement', 'invoice'],
    crypto:           ['crypto', 'blockchain', 'defi', 'token', 'wallet', 'ethereum', 'solana', 'bitcoin'],
    banking:          ['bank', 'financial institution', 'lending', 'deposit', 'credit'],
    risk:             ['risk', 'exposure', 'mitigation', 'hedge', 'volatility'],
    audit:            ['audit', 'review', 'assessment', 'inspection', 'evaluation'],
    kyc:              ['kyc', 'know your customer', 'identity verification', 'onboarding'],
    aml:              ['aml', 'anti-money laundering', 'sanctions', 'ofac'],
    contracts:        ['contract', 'agreement', 'clause', 'obligation', 'breach'],
    ip:               ['patent', 'trademark', 'copyright', 'intellectual property', 'license'],
    employment:       ['employee', 'employer', 'hr', 'termination', 'compensation', 'benefits'],
    litigation:       ['lawsuit', 'court', 'litigation', 'arbitration', 'dispute'],
    corporate:        ['corporation', 'shareholder', 'board', 'governance', 'merger'],
    privacy:          ['privacy', 'data protection', 'personal data', 'consent', 'right to erasure'],
    gdpr:             ['gdpr', 'ccpa', 'dpa', 'data subject', 'controller', 'processor'],
    architecture:     ['architecture', 'system design', 'microservice', 'monolith', 'scalability'],
    devops:           ['devops', 'ci/cd', 'deployment', 'docker', 'kubernetes', 'pipeline'],
    security:         ['security', 'vulnerability', 'authentication', 'authorization', 'encryption'],
    'api-design':     ['api', 'rest', 'graphql', 'endpoint', 'openapi', 'swagger'],
    databases:        ['database', 'sql', 'postgres', 'mysql', 'redis', 'nosql', 'query'],
    'ai-ml':          ['machine learning', 'neural network', 'training', 'model', 'inference', 'llm', 'embedding'],
    content:          ['content', 'blog', 'article', 'copy', 'editorial'],
    seo:              ['seo', 'search engine', 'keyword', 'backlink', 'ranking', 'serp'],
    aeo:              ['aeo', 'answer engine', 'ai overview', 'cited by ai', 'llm citation'],
    social:           ['social media', 'instagram', 'twitter', 'linkedin', 'engagement'],
    email:            ['email', 'newsletter', 'campaign', 'open rate', 'click rate'],
    'paid-media':     ['ppc', 'ads', 'google ads', 'meta ads', 'cpc', 'cpm', 'roas'],
    analytics:        ['analytics', 'metrics', 'kpi', 'dashboard', 'report', 'conversion'],
    branding:         ['brand', 'identity', 'logo', 'positioning', 'messaging'],
    reference:        ['reference', 'definition', 'overview', 'introduction'],
    'how-to':         ['how to', 'step by step', 'guide', 'tutorial', 'walkthrough'],
    faq:              ['faq', 'frequently asked', 'question', 'answer'],
    documentation:    ['documentation', 'docs', 'readme', 'specification', 'changelog'],
    guide:            ['guide', 'manual', 'instructions', 'best practices'],
    tutorial:         ['tutorial', 'learn', 'example', 'exercise', 'practice'],
  };

  return KEYWORDS[category] ?? [category];
}

/** Score information density (proxy for quality) */
export function scoreInformationDensity(text: string): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;

  // Count words that are "informative" (longer than 4 chars, not stop words)
  const STOP_WORDS = new Set(['this', 'that', 'with', 'have', 'from', 'they', 'been', 'were', 'their', 'what', 'when', 'will', 'your', 'which', 'there', 'about', 'into', 'some', 'also', 'more']);
  const informative = words.filter(w => w.length > 4 && !STOP_WORDS.has(w.toLowerCase()));
  const density = informative.length / words.length;

  // Also penalize very short chunks
  const lengthPenalty = Math.min(words.length / 50, 1); // full score at 50+ words

  return Math.round(density * lengthPenalty * 100) / 100;
}
