import { describe, expect, it, vi } from 'vitest';

// The desktop's IPC surface is typed, but the *runtime* allowlist is a hand-written
// array. A payment method added to `RdkApi` but forgotten in `RDK_CHANNELS` type-checks
// fine and then fails at runtime with "No handler registered" the first time a user
// clicks Upgrade. That gap is exactly what this asserts.
import { RDK_CHANNELS, type RdkChannel } from '../../shared/ipc';

// Never load real Electron in tests — it needs a display and spawns a browser process.
vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0-test') },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: class {},
}));

/** Every payment-related method the renderer invokes over IPC. */
const PAYMENT_CHANNELS: RdkChannel[] = [
  'getAccount',
  'getPlans',
  'selectPlan',
  'verifySubscription',
  'createTopup',
  'verifyTopup',
  'openUpgrade',
  'openTopUp',
  'getEarnings',
];

describe('desktop IPC contract', () => {
  it('exposes every payment channel in the runtime allowlist', () => {
    for (const channel of PAYMENT_CHANNELS) {
      expect(RDK_CHANNELS, `missing IPC channel: ${channel}`).toContain(channel);
    }
  });

  it('has no duplicate channel names', () => {
    expect(new Set(RDK_CHANNELS).size).toBe(RDK_CHANNELS.length);
  });

  it('keeps the subscription and top-up pairs together', () => {
    // Both flows are create-then-poll (there is no Stripe webhook). Shipping the
    // create half without the verify half strands the user's money as `pending`.
    expect(RDK_CHANNELS).toContain('selectPlan');
    expect(RDK_CHANNELS).toContain('verifySubscription');
    expect(RDK_CHANNELS).toContain('createTopup');
    expect(RDK_CHANNELS).toContain('verifyTopup');
  });
});
