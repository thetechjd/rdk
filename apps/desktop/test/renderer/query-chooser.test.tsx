import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const openContentForFile = vi.fn();

vi.mock('../../src/store', () => ({
  useApp: () => ({
    openContentForFile,
    openContentForChunk: vi.fn(),
    selectChunk: vi.fn(),
    setPaletteOpen: vi.fn(),
    refreshData: vi.fn(),
    toast: vi.fn(),
  }),
}));

const { QueryBar } = await import('../../src/QueryBar');

describe('network query chooser', () => {
  it('never auto-opens even when exactly one document matches', async () => {
    window.rdk.query = vi.fn(async () => ({
      query: 'wechat clone',
      source: 'network',
      hits: [{
        chunkId: 'candidate-1',
        title: 'WeChat Clone',
        snippet: 'Complete build specification',
        score: 0.94,
        sourceNode: 'provider',
        isOwn: false,
        tipUsdc: 0,
      }],
      documents: [{
        name: 'WeChat Clone',
        score: 0.94,
        sectionCount: 1,
        isOwn: false,
        tipUsdc: 0,
        originNode: 'provider',
        contentAvailable: true,
        preview: 'Complete build specification',
        filePath: '/vault/Retrieved/WeChat Clone.md',
      }],
      tokenEstimate: 20,
      tipsPaidUsdc: 0,
      latencyMs: 5,
    }));

    render(<QueryBar />);
    await userEvent.type(screen.getByPlaceholderText(/query the rdk network/i), 'wechat clone{enter}');

    expect(await screen.findByText('WeChat Clone')).toBeInTheDocument();
    expect(openContentForFile).not.toHaveBeenCalled();
  });
});
