import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Settings → prefs → theme. The choice is applied as <html data-theme>, which
 * every token in theme.css keys off, and saved so main.tsx can apply it before
 * the next launch's first paint.
 */

vi.mock('../../src/store', () => ({
  useApp: () => ({
    account: null, status: null, caps: null,
    toast: vi.fn(), settingsOpen: true, setSettingsOpen: vi.fn(),
    refreshStatus: vi.fn(), refreshAccount: vi.fn(),
  }),
}));
vi.mock('../../src/LoginForm', () => ({ LoginForm: () => null }));

const { Settings } = await import('../../src/Settings');
const { loadTheme } = await import('../../src/theme');

async function openPrefs() {
  render(<Settings />);
  await userEvent.click(screen.getByText('prefs'));
}

describe('Settings · theme', () => {
  beforeEach(() => {
    (window as unknown as { rdk: Record<string, unknown> }).rdk = {
      getPreferences: vi.fn(async () => ({ defaultVisibility: 'private' })),
      getStatus: vi.fn(async () => ({})),
    };
  });

  afterEach(() => {
    delete document.documentElement.dataset.theme;
    localStorage.clear();
  });

  it('defaults to dark', async () => {
    await openPrefs();
    expect(loadTheme()).toBe('dark');
    expect(screen.getByRole('button', { name: 'dark' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches to light, applies it, and remembers it', async () => {
    await openPrefs();
    await userEvent.click(screen.getByRole('button', { name: 'light' }));

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(loadTheme()).toBe('light');
    expect(screen.getByRole('button', { name: 'light' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the theme already applied at boot', async () => {
    document.documentElement.dataset.theme = 'light';
    await openPrefs();
    expect(screen.getByRole('button', { name: 'light' })).toHaveAttribute('aria-pressed', 'true');
  });
});
