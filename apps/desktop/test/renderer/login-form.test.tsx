import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoginForm } from '../../src/LoginForm';
import { AppProvider } from '../../src/store';

function api(login: () => Promise<never>) {
  (window as unknown as { rdk: Record<string, unknown> }).rdk = {
    login,
    getStatus: vi.fn().mockResolvedValue(null),
    getAccount: vi.fn().mockResolvedValue(null),
    getCapabilities: vi.fn().mockResolvedValue(null),
    onPush: vi.fn(() => () => {}),
  };
}

describe('native sign-in failure handling', () => {
  it('leaves the busy state and explains an IPC rejection instead of hanging forever', async () => {
    api(vi.fn().mockRejectedValue(new Error('main process failed')));
    render(<AppProvider><LoginForm /></AppProvider>);

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'me@example.com' } });
    fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'sign in' }));

    await waitFor(() => expect(screen.getByText(/could not finish signing in/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'sign in' })).toBeEnabled();
  });
});
