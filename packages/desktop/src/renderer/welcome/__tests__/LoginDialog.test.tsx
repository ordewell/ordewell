import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalEvent, TerminalOpenResult, TerminalOpenSpec } from '../../../shared/bridge';
import { fakeDaemon, ok } from '../../session/__tests__/fakeDaemon';
import { LoginDialog } from '../LoginDialog';

vi.mock('../../views/terminal/xterm', async () => (await import('../../test/xtermMock')).fakeXtermModule());

function world(signedIn = false) {
  const daemon = fakeDaemon({
    'runners.list': ok({
      runners: [{
        id: 'codex', name: 'Codex', enabled: true,
        auth: { state: signedIn ? 'signed-in' : 'signed-out' },
      }],
    }),
  });
  const events: Array<(event: TerminalEvent) => void> = [];
  const open = vi.fn(async (_spec: TerminalOpenSpec, onEvent: (event: TerminalEvent) => void): Promise<TerminalOpenResult> => {
    events.push(onEvent);
    return { ok: true, id: 3, cwd: '/home/me', shell: 'codex' };
  });
  Object.assign(window.ordewell, {
    terminal: { open, write: vi.fn(async () => undefined), resize: vi.fn(async () => undefined), close: vi.fn(async () => undefined), openLink: vi.fn(async () => ({ ok: true })) },
  });
  return { daemon, open, events };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('the launcher\'s login terminal', () => {
  it('runs the agent\'s login in home and says so when its own status command agrees', async () => {
    const w = world(true);
    const onSignedIn = vi.fn();
    render(<LoginDialog runner="codex" label="Codex" platform="darwin" pollMs={5} onClose={vi.fn()} onSignedIn={onSignedIn} />);

    expect(await screen.findByText('Codex is signed in.')).toBeInTheDocument();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(w.open).toHaveBeenCalledWith(expect.objectContaining({ login: { runner: 'codex' } }), expect.any(Function));
    expect(screen.getByRole('dialog', { name: 'Sign in to Codex' })).toBeInTheDocument();
  });

  it('says why when the terminal cannot open, and when it closes before signing in', async () => {
    const w = world(false);
    w.open.mockResolvedValueOnce({ ok: false, message: 'Ordewell has no login to run for codex.' });
    const { unmount } = render(<LoginDialog runner="codex" label="Codex" platform="darwin" pollMs={5} onClose={vi.fn()} onSignedIn={vi.fn()} />);
    expect(await screen.findByText(/Ordewell has no login to run for codex\./)).toBeInTheDocument();
    // A failure is an alert that leads with its outcome; the agent's reason follows.
    expect(screen.getByRole('alert')).toHaveTextContent(/^Sign-in did not finish\. Ordewell has no login/);
    unmount();

    const second = world(false);
    render(<LoginDialog runner="codex" label="Codex" platform="darwin" pollMs={5} onClose={vi.fn()} onSignedIn={vi.fn()} />);
    await waitFor(() => expect(second.events).toHaveLength(1));
    act(() => second.events[0]!({ kind: 'exit', exitCode: 1 }));
    expect(await screen.findByText(/The terminal closed before sign-in finished\./)).toBeInTheDocument();
  });
});
