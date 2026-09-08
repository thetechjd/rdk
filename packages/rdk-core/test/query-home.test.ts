import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { QueryPipeline } from '../src/query/pipeline.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('query vocabulary home directory', () => {
  it.each([undefined, '/tmp/rdk-custom-home'])('uses the OS home without HOME and honors RDK_HOME=%s', override => {
    vi.stubEnv('HOME', undefined);
    vi.stubEnv('RDK_HOME', override);
    vi.spyOn(os, 'homedir').mockReturnValue('/tmp/windows-user-profile');
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('no cache'); });
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    new QueryPipeline({ getVocabulary: () => ({ words: [], chunkCount: 0 }) } as any, {} as any, {} as any);
    expect(mkdir).toHaveBeenCalledWith(override ?? path.join('/tmp/windows-user-profile', '.rdk'), { recursive: true });
  });
});
