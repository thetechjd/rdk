import { afterAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { verifyRerankModelFiles } from '../src/query/model.js';
import { RERANK_MODEL_ID, RERANK_MODEL_SHA256 } from '../src/query/pipeline.constants.js';

const dirs: string[] = [];

function modelDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-model-'));
  dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

describe('rerank model integrity verification', () => {
  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a weight file matching its pinned digest', () => {
    const dir = modelDir({ 'onnx/model_quantized.onnx': 'weights' });
    const result = verifyRerankModelFiles(dir, { 'onnx/model_quantized.onnx': sha256('weights') });
    expect(result.verified).toEqual(['onnx/model_quantized.onnx']);
    expect(result.unpinned).toEqual([]);
  });

  it('throws when a pinned weight file has been altered', () => {
    const dir = modelDir({ 'onnx/model_quantized.onnx': 'tampered' });
    expect(() => verifyRerankModelFiles(dir, { 'onnx/model_quantized.onnx': sha256('weights') }))
      .toThrow(/failed SHA256 verification/);
  });

  it('reports unpinned weight files rather than trusting them', () => {
    const dir = modelDir({ 'onnx/model_quantized.onnx': 'weights' });
    const result = verifyRerankModelFiles(dir, {});
    expect(result.verified).toEqual([]);
    expect(result.unpinned).toEqual([{ file: 'onnx/model_quantized.onnx', sha256: sha256('weights') }]);
  });

  it('pins a digest for the weight file the configured model actually loads', () => {
    // LocalOnnxRerankModel passes `quantized: true`, so transformers.js requests
    // onnx/model_quantized.onnx. Re-pointing RERANK_MODEL_ID without re-pinning
    // would leave the weights unverified; this fails the build instead.
    expect(RERANK_MODEL_ID).toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(RERANK_MODEL_SHA256['onnx/model_quantized.onnx']).toMatch(/^[0-9a-f]{64}$/);
    for (const [file, digest] of Object.entries(RERANK_MODEL_SHA256)) {
      expect(digest, `${file} must be a sha256 hex digest`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('ignores metadata files and a missing model directory', () => {
    const dir = modelDir({ 'config.json': '{}', 'tokenizer.json': '{}' });
    expect(verifyRerankModelFiles(dir, {})).toEqual({ verified: [], unpinned: [] });
    expect(verifyRerankModelFiles(path.join(dir, 'absent'), {})).toEqual({ verified: [], unpinned: [] });
  });
});
