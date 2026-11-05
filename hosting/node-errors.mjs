// Why a node host operation failed, as a short code that is safe to log and to
// return to the publisher. Error messages can carry provider responses, keys or
// document text, so they never leave the process: only the code does.
const REASONS = [
  [/file was not found locally|Embedding model runtime failed|embedding model/i, 'embedding_model_missing'],
  [/Index rate limit exceeded/i, 'rate_limited'],
  [/Shared node registration failed: HTTP (\d{3})/, (m) => `registration_http_${m[1]}`],
  [/Shared node registration/i, 'registration_failed'],
  [/Support publication HTTP (\d{3})/, (m) => `publisher_http_${m[1]}`],
  [/different node or unsafe visibility/, 'claim_rejected'],
  [/must be private and encrypted/, 'document_not_private'],
  [/RDK metadata sync failed/, 'metadata_sync_failed'],
  [/invalid scope/, 'invalid_scope'],
  [/invalid publisher/, 'invalid_publisher'],
  [/ensure the node first/, 'node_not_ensured'],
  [/node capacity reached/, 'capacity_reached'],
  [/node busy/, 'queue_full'],
  [/node timeout/, 'node_timeout'],
  [/node stopped/, 'node_stopped'],
  [/body too large/, 'body_too_large'],
  [/JSON/, 'invalid_json'],
  [/unsupported/, 'unsupported'],
  [/\bpin/i, 'pin_failed'],
  [/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed|aborted|timed? ?out/i, 'network'],
];
export function failureReason(error) {
  const message = String(error?.message ?? error ?? '');
  for (const [pattern, reason] of REASONS) {
    const match = message.match(pattern);
    if (match) return typeof reason === 'function' ? reason(match) : reason;
  }
  return 'unknown';
}

// The embedding model every node indexes with. It is vendored in this repo
// (apps/desktop/build/models, also what the desktop app bundles), so a host
// needs no download. The node loads it from disk only (RDK_MODELS_DIR).
export const MODEL_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'].map((f) => `Xenova/all-MiniLM-L6-v2/${f}`);
