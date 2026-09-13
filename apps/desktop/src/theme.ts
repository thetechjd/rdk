// src/theme.ts — light/dark colour theme for the renderer (Settings → prefs).
// Kept in localStorage rather than the node config: it is a per-window display
// choice with no meaning to the CLI or node, and a synchronous read lets
// main.tsx apply it before the first paint instead of flashing the dark theme.

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'rdk.theme';

export function loadTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* still applied for this session */ }
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}
