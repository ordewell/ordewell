import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonStatus, OrdewellBridge } from '../../../shared/bridge';
import { RunnerRow } from '../RunnerRow';

// The terminal itself is LoginDialog's to test; here the row only has to re-read
// the agents when that dialog says one signed in.
vi.mock('../LoginDialog', () => ({
  LoginDialog: ({ label, onSignedIn, onClose }: { label: string; onSignedIn(): void; onClose(): void }) => (
    <div role="dialog" aria-label={`Sign in to ${label}`}>
      <button type="button" onClick={onSignedIn}>finished</button>
      <button type="button" onClick={onClose}>close</button>
    </div>
  ),
}));

const CONNECTED: DaemonStatus = { state: 'connected', port: 7878, owned: true, daemon: { version: '0.4.0', contract: 3 } };

afterEach(() => { vi.restoreAllMocks(); });

describe('the welcome runner row', () => {
  it('re-reads the agents when a login says it finished, and draws the new verdict', async () => {
    let reads = 0;
    const call = vi.fn(async () => {
      reads += 1;
      return {
        ok: true,
        status: 200,
        data: {
          runners: [{
            id: 'codex', enabled: true,
            auth: { state: reads >= 2 ? 'signed-in' : 'signed-out', signIn: { runner: 'codex', label: 'Codex', login: ['codex', 'login'] } },
          }],
        },
      };
    });
    Object.defineProperty(window, 'ordewell', {
      configurable: true,
      value: { daemon: { call }, shell: { openExternal: vi.fn() } } as unknown as OrdewellBridge,
    });

    render(<RunnerRow status={CONNECTED} />);
    expect(await screen.findByText('Signed out')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    fireEvent.click(screen.getByRole('button', { name: 'finished' }));

    await waitFor(() => expect(document.querySelector('[data-runner="codex"]')).toHaveAttribute('data-state', 'signed-in'));
    expect(reads).toBeGreaterThanOrEqual(2);
  });
});
