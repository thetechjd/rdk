import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test' },
}));

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('desktop local query documents', () => {
  it('deduplicates matching chunks and points the editor at the complete source file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-query-document-'));
    temporary.push(dir);
    const filePath = path.join(dir, 'Slack clone.md');
    fs.writeFileSync(filePath, '# Slack clone\n\nComplete specification.\n');

    const { NodeService } = await import('../../electron/node-service.js');
    const service = new NodeService() as unknown as {
      query(q: string): Promise<{
        hits: Array<{ title: string; filePath?: string; chunkId: string; score: number }>;
      }>;
      embedderAvailable(): Promise<boolean>;
      getConfig(): { nodeId: string };
      getRouter(): { query(q: string): Promise<unknown> };
    };

    service.embedderAvailable = async () => true;
    service.getConfig = () => ({ nodeId: 'node-me' });
    service.getRouter = () => ({
      query: async () => ({
        source: 'private',
        chunks: [
          {
            id: 'section-1',
            title: 'Slack clone — 1. Architecture',
            docTitle: 'Slack clone',
            sourcePath: filePath,
            content: 'Architecture fragment.',
            score: 0.92,
          },
          {
            id: 'section-2',
            title: 'Slack clone — 2. Authentication',
            docTitle: 'Slack clone',
            sourcePath: filePath,
            content: 'Authentication fragment.',
            score: 0.84,
          },
        ],
        tokenEstimate: 100,
        tipsPaid: [],
        latencyMs: 4,
      }),
    });

    const result = await service.query('slack clone');

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({
      title: 'Slack clone',
      filePath,
      chunkId: 'section-1',
      score: 0.92,
    });
  }, 15_000);
});
