// Minimal type stub for @xenova/transformers.
// The real package is an optional runtime dependency installed on demand via `rdk network:join`.
// This stub satisfies the TypeScript compiler without requiring the package to be present at build time.
declare module '@xenova/transformers' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function pipeline(task: string, model?: string, options?: Record<string, unknown>): Promise<any>;
  // Cross-encoder reranking needs the tokenizer and model directly: the
  // text-classification pipeline cannot express a (query, chunk) sequence pair.
  export const AutoTokenizer: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from_pretrained(model: string, options?: Record<string, unknown>): Promise<any>;
  };
  export const AutoModelForSequenceClassification: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from_pretrained(model: string, options?: Record<string, unknown>): Promise<any>;
  };
  export const env: {
    cacheDir: string;
    localModelPath: string;
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
  };
}
