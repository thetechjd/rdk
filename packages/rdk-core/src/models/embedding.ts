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
  } catch {
    throw new Error(
      '\n  Embedding model not installed.\n' +
      '  Run: npm install -g @xenova/transformers\n' +
      '  Or:  rdk install:model\n'
    );
  }

  const { pipeline, env } = transformers;
  env.cacheDir = path.join(os.homedir(), '.rdk', 'models');
  // Disable the remote model check for faster cold start after first download
  env.allowLocalModels = true;

  _pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    quantized: true,
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

  /** Check if transformers is installed without throwing */
  static async isAvailable(): Promise<boolean> {
    try {
      await import('@xenova/transformers');
      return true;
    } catch {
      return false;
    }
  }
}

export const embeddingModel = new LocalEmbeddingModel();
