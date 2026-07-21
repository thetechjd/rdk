// packages/rdk-core/src/models/embedding.ts
// Local embedding model — no API key needed, runs entirely on-device.
// @xenova/transformers is NOT installed at npm install time.
// It is downloaded on first use via: rdk init (or rdk install:model).
// Model weights cache to ~/.rdk/models/ (~23MB, downloaded once).

import path from 'path';
import os from 'os';

export interface EmbeddingModel {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dimensions: number;
  readonly modelName: string;
}

let _pipeline: unknown = null;

async function getPipeline() {
  if (_pipeline) return _pipeline;

  let transformers: typeof import('@xenova/transformers');
  try {
    transformers = await import('@xenova/transformers');
  } catch (err) {
    // Surface the REAL cause. This catch fires on a native/module load failure
    // (e.g. onnxruntime-node binary, ABI, a not-yet-resolved dev module graph),
    // which is usually NOT "not installed". Log the full error; keep the install
    // hint for the genuinely-missing case.
    console.error('[rdk] embedding runtime failed to load (@xenova/transformers):', err);
    throw new Error(
      '\n  Embedding model runtime failed to load.\n' +
      `  Underlying error: ${(err as Error)?.message ?? String(err)}\n` +
      '  If it is not installed:  rdk install:model  (or: npm install -g @xenova/transformers)\n'
    );
  }

  const { pipeline, env } = transformers;
  env.allowLocalModels = true;
  // Suppress download progress output — MCP protocol requires clean stdout
  process.env.TRANSFORMERS_VERBOSITY = 'error';

  const bundled = process.env.RDK_MODELS_DIR;
  if (bundled) {
    // A build shipped the model on disk (the desktop app sets RDK_MODELS_DIR to its
    // bundled resources/models). Load it locally and NEVER reach for HuggingFace, so
    // a fresh install embeds offline with no ~23MB download. transformers resolves
    // `${localModelPath}/Xenova/all-MiniLM-L6-v2`.
    env.localModelPath = bundled;
    env.allowRemoteModels = false;
  } else {
    // No bundled model (e.g. the plain CLI): download once to the shared cache.
    env.cacheDir = path.join(os.homedir(), '.rdk', 'models'); // shared across instances — models are 23MB, no reason to duplicate
  }

  _pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    quantized: true,
    progress_callback: () => {},
  });

  return _pipeline;
}

export class LocalEmbeddingModel implements EmbeddingModel {
  readonly dimensions = 384;
  readonly modelName = 'all-MiniLM-L6-v2';

  async embed(text: string): Promise<Float32Array> {
    const pipe = await getPipeline() as (texts: string[], opts: Record<string, unknown>) => Promise<{ data: Float32Array }>;
    const output = await pipe([text.slice(0, 2048)], {
      pooling: 'mean',
      normalize: true,
    });
    return new Float32Array(output.data.slice(0, this.dimensions));
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    const batchSize = 32;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const embeddings = await Promise.all(batch.map(t => this.embed(t)));
      results.push(...embeddings);
    }
    return results;
  }

  /** Check if the embedding runtime can be loaded, without throwing. */
  static async isAvailable(): Promise<boolean> {
    try {
      await import('@xenova/transformers');
      return true;
    } catch (err) {
      // Never swallow this silently: it's the sole signal behind the app's
      // "Embedding model unavailable" gate. Without the log, the true cause
      // (native binary / ABI / a cold dev module graph) is invisible.
      console.error('[rdk] isAvailable(): embedding runtime failed to load:', err);
      return false;
    }
  }
}

export const embeddingModel = new LocalEmbeddingModel();
