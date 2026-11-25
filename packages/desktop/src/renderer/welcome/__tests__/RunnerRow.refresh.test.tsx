import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonStatus, OrdewellBridge } from '../../../shared/bridge';
import { RunnerRow } from '../RunnerRow';

// The terminal itself is LoginDialog's to test; here the row only has to re-read
// the agents when that dialog says one signed in.
vi.mock('../LoginDialog', () => ({
  LoginDialog: ({ label, setsUp, onSignedIn, onClose }: { label: string; setsUp?: boolean; onSignedIn(): void; onClose(): void }) => (
    <div role="dialog" aria-label={setsUp ? `Set up ${label}` : `Sign in to ${label}`}>
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

  it('says a Cline with no key Ordewell can hand it needs one, and offers its setup, never a Log in (ADR-0060)', async () => {
    // The row the daemon really sends for a Cline whose hook found no key.
    const keyless = { runner: 'cline', label: 'Cline', login: ['cline', 'auth'], needsKey: true };
    const call = vi.fn(async () => ({
      ok: true,
      status: 200,
      data: {
        runners: [{
          id: 'cline', name: 'Cline', enabled: true,
          auth: { state: 'signed-out', detail: 'no provider key', loginCommand: ['cline', 'auth'], signIn: keyless },
          readiness: { kind: 'blocked', why: 'no-credential', signIn: keyless },
        }],
      },
    }));
    Object.defineProperty(window, 'ordewell', {
      configurable: true,
      value: { daemon: { call }, shell: { openExternal: vi.fn() } } as unknown as OrdewellBridge,
    });

    render(<RunnerRow status={CONNECTED} />);
    const card = await waitFor(() => {
      const found = document.querySelector('[data-runner="cline"]');
      expect(found).toHaveTextContent('API key needed');
      return found as HTMLElement;
    });
    expect(card).not.toHaveTextContent('Signed out');
    expect(card).toHaveTextContent('Set it up with the Set up Cline button, or run cline auth, and choose an API provider and enter its key; an account sign-in alone is not enough.');
    expect(screen.queryByRole('button', { name: 'Log in' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Set up Cline' }));
    expect(screen.getByRole('dialog', { name: 'Set up Cline' })).toBeInTheDocument();
  });
});
