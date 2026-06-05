// packages/rdk-core/src/cleaner.ts
// Strips HTML, normalizes whitespace, removes basic PII patterns.

export interface CleanOptions {
  stripHtml?: boolean;
  normWhitespace?: boolean;
  removePii?: boolean;
  maxLength?: number;
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
const PHONE_RE = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CC_RE = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;

export function cleanText(input: string, opts: CleanOptions = {}): string {
  const {
    stripHtml = true,
    normWhitespace = true,
    removePii = true,
    maxLength = 1_000_000,
  } = opts;

  let text = input;

  if (stripHtml) {
    // Remove script/style blocks entirely
    text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    // Convert block elements to newlines
    text = text.replace(/<(?:p|div|br|h[1-6]|li|tr|blockquote)[^>]*>/gi, '\n');
    // Strip remaining tags
    text = text.replace(/<[^>]+>/g, ' ');
    // Decode common HTML entities
    text = text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }

  if (removePii) {
    text = text.replace(EMAIL_RE, '[email]');
    text = text.replace(PHONE_RE, '[phone]');
    text = text.replace(SSN_RE, '[ssn]');
    text = text.replace(CC_RE, '[card]');
  }

  if (normWhitespace) {
    // Collapse multiple newlines to double
    text = text.replace(/\n{3,}/g, '\n\n');
    // Collapse multiple spaces
    text = text.replace(/[ \t]+/g, ' ');
    // Trim each line
    text = text
      .split('\n')
      .map(l => l.trim())
      .join('\n')
      .trim();
  }

  if (maxLength && text.length > maxLength) {
    text = text.slice(0, maxLength);
  }

  return text;
}

/** Estimate token count (rough: 1 token ≈ 4 chars) */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
