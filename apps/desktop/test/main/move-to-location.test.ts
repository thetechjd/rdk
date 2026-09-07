import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test' },
}));

/**
 * Dragging a file from one Explorer folder to another has to MOVE it.
 *
 * Retrieved is a real directory and `isRetrievedPath` gives it priority over
 * visibility when the tree decides where to draw a file. So the old handler —
 * which only re-indexed — left a published document sitting in the folder the
 * user had just dragged it out of, with nothing to show the drag had done
 * anything at all. These tests pin the move itself: the file lands in the new
 * folder, and the chunks indexed from it follow the file rather than orphaning
 * at the path it left.
 */

interface TestService {
  moveToLocation(
    sourcePath: string,
    target: 'public' | 'private' | 'retrieved',
  ): Promise<{ ok: boolean; path?: string; indexed?: number; error?: string }>;
  getStore(): unknown;
  getConfig(): unknown;
  indexPaths(paths: string[], visibility: string): Promise<{ indexed: number; error?: string }>;
}

let vault: string;
let repointed: Array<{ from: string; to: string }>;
let indexed: Array<{ paths: string[]; visibility: string }>;

async function service(): Promise<TestService> {
  const { NodeService } = await import('../../electron/node-service.js');
  const svc = new NodeService() as unknown as TestService;
  svc.getConfig = () => ({ nodeId: 'node-me', vaultPath: vault });
  svc.getStore = () => ({
    updateSourcePath: (from: string, to: string) => { repointed.push({ from, to }); return 1; },
  });
  svc.indexPaths = async (paths: string[], visibility: string) => {
    indexed.push({ paths, visibility });
    return { indexed: 3 };
  };
  return svc;
}

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'rdk-move-'));
  fs.mkdirSync(path.join(vault, 'retrieved'), { recursive: true });
  repointed = [];
  indexed = [];
});

afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
});

describe('moving a file between Explorer locations', () => {
  it('moves a retrieved document out of the folder and publishes it', async () => {
    const from = path.join(vault, 'retrieved', 'trello.md');
    fs.writeFileSync(from, '# Trello\n\nbody', 'utf-8');

    const result = await (await service()).moveToLocation(from, 'public');

    expect(result.ok).toBe(true);
    // The whole point: it is no longer in Retrieved, so the tree can draw it
    // under Public instead of the folder claiming it back.
    expect(result.path).toBe(path.join(vault, 'trello.md'));
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readFileSync(result.path!, 'utf-8')).toBe('# Trello\n\nbody');
    expect(repointed).toEqual([{ from, to: result.path }]);
    expect(indexed).toEqual([{ paths: [result.path], visibility: 'public' }]);
  });

  it('files a document into Retrieved without touching its visibility', async () => {
    const from = path.join(vault, 'notes.md');
    fs.writeFileSync(from, 'body', 'utf-8');

    const result = await (await service()).moveToLocation(from, 'retrieved');

    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(vault, 'retrieved', 'notes.md'));
    expect(repointed).toHaveLength(1);
    // Retrieved says nothing about who may read a document, so re-indexing it
    // at some visibility would be inventing an instruction the user never gave.
    expect(indexed).toEqual([]);
  });

  it('changes visibility in place for a file that is not in Retrieved', async () => {
    fs.mkdirSync(path.join(vault, 'Projects'));
    const from = path.join(vault, 'Projects', 'spec.md');
    fs.writeFileSync(from, 'body', 'utf-8');

    const result = await (await service()).moveToLocation(from, 'private');

    // Public and Private are states, not folders — a file already filed under
    // Projects/ should not be dragged out of it just to change visibility.
    expect(result.path).toBe(from);
    expect(fs.existsSync(from)).toBe(true);
    expect(repointed).toEqual([]);
    expect(indexed).toEqual([{ paths: [from], visibility: 'private' }]);
  });

  it('keeps both files when the destination name is taken', async () => {
    const from = path.join(vault, 'retrieved', 'spec.md');
    fs.writeFileSync(from, 'incoming', 'utf-8');
    fs.writeFileSync(path.join(vault, 'spec.md'), 'existing', 'utf-8');

    const result = await (await service()).moveToLocation(from, 'public');

    expect(result.path).toBe(path.join(vault, 'spec (2).md'));
    expect(fs.readFileSync(path.join(vault, 'spec.md'), 'utf-8')).toBe('existing');
    expect(fs.readFileSync(result.path!, 'utf-8')).toBe('incoming');
  });

  it('refuses to move a file that is outside the vault', async () => {
    const outside = path.join(os.tmpdir(), 'rdk-outside.md');
    fs.writeFileSync(outside, 'body', 'utf-8');
    try {
      const result = await (await service()).moveToLocation(outside, 'public');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/outside the vault/i);
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});
