import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Renderer components only ever reach the main process through `window.rdk`
// (the preload bridge). Tests stub it per-case; this keeps the shape available
// so a component that reads it at module scope doesn't explode on import.
if (!(window as unknown as { rdk?: unknown }).rdk) {
  (window as unknown as { rdk: Record<string, unknown> }).rdk = {};
}
