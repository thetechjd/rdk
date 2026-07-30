import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loginMock } = vi.hoisted(() => ({ loginMock: vi.fn() }));

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0-test') },
}));

vi.mock('@rdk/node/retrodeck-client', async importOriginal => {
  const actual = await importOriginal<typeof import('@rdk/node/retrodeck-client')>();
  return { ...actual, login: loginMock };
});

import { loadConfig } from '@rdk/node/config';
import { NodeService } from '../../electron/node-service';

describe('first-run account setup', () => {
  beforeEach(() => {
    loginMock.mockReset();
    loginMock.mockResolvedValue({
      ok: true,
      plan: 'pro',
      emailVerified: true,
      session: {
        accessToken: 'first-access',
        refreshToken: 'first-refresh',
        userId: 'user-first',
        apiBase: 'https://api.retrodeck.ai',
      },
    });
  });

  it('finishes sign-in before a vault config exists, then persists it during init', async () => {
    const service = new NodeService();

    await expect(service.login('first@example.com', 'password')).resolves.toMatchObject({
      ok: true,
      plan: 'pro',
    });
    expect(loginMock).toHaveBeenCalledWith(
      'first@example.com',
      'password',
      { persist: false },
    );

    await service.initNode({
      vaultPath: '/tmp/first-vault',
      visibility: 'private',
      autoStart: true,
    });

    expect(loadConfig()).toMatchObject({
      ownerEmail: 'first@example.com',
      retrodeckAccessToken: 'first-access',
      retrodeckRefreshToken: 'first-refresh',
      retrodeckUserId: 'user-first',
      retrodeckApiUrl: 'https://api.retrodeck.ai',
      centralApiUrl: 'https://rdk.retrodeck.ai',
      plan: 'pro',
      emailVerified: true,
    });
  });
});
