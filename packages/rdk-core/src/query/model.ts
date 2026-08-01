import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  RERANK_FALLBACK_MODEL,
  RERANK_MODEL_ID,
  RERANK_MODEL_SHA256,
  RERANK_RUNTIME,
} from './pipeline.constants.js';
import type { RerankModel } from './rerank.js';

/** Weight files worth hashing — the rest of a model dir is small metadata. */
const VERIFIABLE_MODEL_FILE = /\.(onnx|onnx_data|bin|model|safetensors)$/;

/** Marks a rerank failure as "model could not load" rather than "model was slow". */
export const RERANK_MODEL_LOAD_FAILURE = 'RERANK_MODEL_LOAD_FAILURE';

interface RerankTensor { dims: number[]; data: Float32Array }
interface LoadedReranker {
  tokenizer: (text: string[], options: Record<string, unknown>) => unknown;
  model: (inputs: unknown) => Promise<{ logits: RerankTensor }>;
}

/** Task 10: rerank scores are sigmoid-normalized to 0..1. */
function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

/** Probability of the "relevant" label for two-logit cross-encoders. */
function softmaxPositive(logits: number[]): number {
  const max = Math.max(...logits);
  const exponentials = logits.map((value) => Math.exp(value - max));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return total > 0 ? exponentials[exponentials.length - 1] / total : 0;
}

/**
 * Verifies downloaded rerank model files against their pinned digests.
 *
 * Fails closed: a file whose digest is pinned and does not match throws, so a
 * tampered or truncated weight file can never be loaded. A file with no pinned
 * digest is reported with its computed value so it can be pinned, and counted as
 * unverified — it is not silently accepted as good.
 */
export function verifyRerankModelFiles(
  modelDir: string,
  expected: Readonly<Record<string, string>> = RERANK_MODEL_SHA256,
): { verified: string[]; unpinned: Array<{ file: string; sha256: string }> } {
  const verified: string[] = [];
  const unpinned: Array<{ file: string; sha256: string }> = [];

  for (const file of walkFiles(modelDir)) {
    if (!VERIFIABLE_MODEL_FILE.test(file)) continue;
    const relative = path.relative(modelDir, file).split(path.sep).join('/');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const pinned = expected[relative];
    if (pinned === undefined) { unpinned.push({ file: relative, sha256: digest }); continue; }
    if (pinned !== digest) {
      throw new Error(
        `Rerank model file failed SHA256 verification: ${relative} expected ${pinned}, got ${digest}`,
      );
    }
    verified.push(relative);
  }
  return { verified, unpinned };
}

function walkFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
}

export class LocalOnnxRerankModel implements RerankModel {
  private pipelinePromise?: Promise<unknown>;

  constructor(private dataDir = path.join(process.env.RDK_HOME ?? path.join(os.homedir(), '.rdk'), 'models')) {}

  /** Load the weights now so the first real query does not pay for it. */
  async warm(): Promise<void> {
    await this.pipeline();
  }

  async score(pairs: Array<{ query: string; text: string }>): Promise<number[]> {
    if (pairs.length === 0) return [];
    const { tokenizer, model } = await this.pipeline() as LoadedReranker;

    // A cross-encoder scores the query and the chunk as ONE sequence pair, so
    // both go through the tokenizer together via text_pair. The {text,text_pair}
    // object form is the Python API and silently throws here.
    const inputs = tokenizer(
      pairs.map((pair) => pair.query),
      {
        text_pair: pairs.map((pair) => pair.text.slice(0, 8192)),
        padding: true,
        truncation: true,   // clamps to the model's max sequence length
      },
    );

    const { logits } = await model(inputs);
    const [rows, columns] = logits.dims as [number, number];
    const data = logits.data as Float32Array;

    return Array.from({ length: rows }, (_, row) => {
      if (columns === 1) return sigmoid(data[row]);            // bge-reranker: one relevance logit
      const slice = Array.from(data.slice(row * columns, (row + 1) * columns));
      return softmaxPositive(slice);                            // two-label cross-encoders
    });
  }

  private pipeline(): Promise<unknown> {
    if (!this.pipelinePromise) this.pipelinePromise = this.loadPipeline();
    return this.pipelinePromise;
  }

  private async loadPipeline(): Promise<unknown> {
    if (RERANK_RUNTIME !== 'onnx') throw new Error(`Unsupported rerank runtime: ${RERANK_RUNTIME}`);
    const transformers = await import('@xenova/transformers');
    transformers.env.cacheDir = this.dataDir;
    transformers.env.allowLocalModels = true;

    // `env` is process-wide and shared with the embedding model, which sets
    // allowRemoteModels = false whenever RDK_MODELS_DIR is set (every packaged
    // desktop build) so it can embed offline from its bundled copy. The
    // embedding model always loads first — the vector leg runs before rerank —
    // so without this the reranker inherits "no downloads", finds nothing
    // bundled, and degrades every desktop query to RRF forever. Re-enable
    // remote loading for this one load and restore it, so the embedding
    // model's offline guarantee is unaffected.
    const previousAllowRemote = transformers.env.allowRemoteModels;
    transformers.env.allowRemoteModels = true;

    console.error(`[rdk] downloading/verifying rerank model ${RERANK_MODEL_ID} on first use`);
    let loaded: LoadedReranker;
    try {
      const options = {
        quantized: true,
        progress_callback: (progress: { status?: string; file?: string; progress?: number }) => {
          if (progress.status === 'progress') {
            console.error(`[rdk] rerank model ${progress.file ?? ''} ${Math.round(progress.progress ?? 0)}%`);
          }
        },
      };
      const [tokenizer, model] = await Promise.all([
        transformers.AutoTokenizer.from_pretrained(RERANK_MODEL_ID, options),
        transformers.AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL_ID, options),
      ]);
      loaded = { tokenizer, model } as LoadedReranker;
    } catch (error) {
      // A model that cannot load is a misconfiguration, not the transient
      // slowness the RRF fallback exists for. Queries still succeed, but this
      // must be unmistakable in the log — the previous generic warning let a
      // model with no ONNX weights degrade every query to RRF unnoticed.
      console.error(
        `[rdk] RERANK MODEL UNAVAILABLE: ${RERANK_MODEL_ID} failed to load (${(error as Error).message}). ` +
        `Every query will fall back to RRF ordering and ignore the rerank weight until this is fixed.`,
      );
      throw new Error(`${RERANK_MODEL_LOAD_FAILURE}: ${RERANK_MODEL_ID}: ${(error as Error).message}`);
    } finally {
      transformers.env.allowRemoteModels = previousAllowRemote;
    }

    // Throws on a pinned-digest mismatch, so a bad weight file never gets used.
    const { verified, unpinned } = verifyRerankModelFiles(path.join(this.dataDir, RERANK_MODEL_ID));
    for (const entry of unpinned) {
      console.error(`[rdk] rerank model ${entry.file} is UNPINNED sha256=${entry.sha256}`);
    }
    if (unpinned.length > 0) {
      console.error(
        `[rdk] WARNING: ${unpinned.length} rerank model file(s) not integrity-checked — ` +
        `pin them in RERANK_MODEL_SHA256 to enforce verification`,
      );
    }
    if (verified.length > 0) console.error(`[rdk] rerank model: ${verified.length} file(s) verified`);
    return loaded;
  }
}

/** Explicit opt-in only: this implementation transmits candidate text to Anthropic. */
export class HaikuRerankModel implements RerankModel {
  readonly singleBatch = true;

  constructor(private apiKey: string) {}

  async score(pairs: Array<{ query: string; text: string }>): Promise<number[]> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: RERANK_FALLBACK_MODEL,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Score each reference from 0 to 10 for relevance to the query. Return only a JSON array of numbers in input order.\n${JSON.stringify(pairs)}`,
        }],
      }),
    });
    if (!response.ok) throw new Error(`Haiku rerank failed: HTTP ${response.status}`);
    const payload = await response.json() as { content?: Array<{ type: string; text?: string }> };
    const text = payload.content?.find((item) => item.type === 'text')?.text ?? '[]';
    const scores = JSON.parse(text) as number[];
    if (!Array.isArray(scores) || scores.length !== pairs.length) throw new Error('Haiku rerank returned invalid scores');
    return scores.map((score) => Math.max(0, Math.min(1, Number(score) / 10)));
  }
}
