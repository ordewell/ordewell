import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipboardReadResult, TerminalEvent, TerminalOpenResult, TerminalOpenSpec } from '../../../shared/bridge';
import { fakeDaemon, ok } from '../../session/__tests__/fakeDaemon';
import { terms } from '../../test/xtermMock';
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

// The dialog waits on a poll timer and on a chain of promises (dynamic import,
// terminal, daemon call). Testing Library's own findBy*/waitFor give up after a
// fixed 1s of wall clock, which a loaded machine overruns; vi.waitFor drives the
// faked timer itself, so the poll fires when the test says and never early or late.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const seen = (text: string | RegExp) => vi.waitFor(() => { expect(screen.getByText(text)).toBeInTheDocument(); });

describe('the launcher\'s login terminal', () => {
  it('runs the agent\'s login in home and says so when its own status command agrees', async () => {
    const w = world(true);
    const onSignedIn = vi.fn();
    render(<LoginDialog runner="codex" label="Codex" platform="darwin" pollMs={5} onClose={vi.fn()} onSignedIn={onSignedIn} />);

    await seen('Codex is signed in.');
    await vi.waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(w.open).toHaveBeenCalledWith(expect.objectContaining({ login: { runner: 'codex' } }), expect.any(Function));
    expect(screen.getByRole('dialog', { name: 'Sign in to Codex' })).toBeInTheDocument();
  });

  it('says why when the terminal cannot open, and when it closes before signing in', async () => {
    const w = world(false);
    w.open.mockResolvedValueOnce({ ok: false, message: 'Ordewell has no login to run for codex.' });
    const { unmount } = render(<LoginDialog runner="codex" label="Codex" platform="darwin" pollMs={5} onClose={vi.fn()} onSignedIn={vi.fn()} />);
    await seen(/Ordewell has no login to run for codex\./);
    // A failure is an alert that leads with its outcome; the agent's reason follows.
    expect(screen.getByRole('alert')).toHaveTextContent(/^Sign-in did not finish\. Ordewell has no login/);
    unmount();

    const second = world(false);
    render(<LoginDialog runner="codex" label="Codex" platform="darwin" pollMs={5} onClose={vi.fn()} onSignedIn={vi.fn()} />);
    await vi.waitFor(() => expect(second.events).toHaveLength(1));
    act(() => second.events[0]!({ kind: 'exit', exitCode: 1 }));
    await seen(/The terminal closed before sign-in finished\./);
  });

  it('pastes through the bridge, and says why a paste failed while the sign-in waits on', async () => {
    world(false);
    const readText = vi.fn(async (): Promise<ClipboardReadResult> => ({ ok: true, text: 'ABCD-1234' }));
    Object.assign(window.ordewell, { clipboard: { readText, writeText: vi.fn(async () => ({ ok: true })) } });
    render(<LoginDialog runner="codex" label="Codex" platform="darwin" pollMs={5} onClose={vi.fn()} onSignedIn={vi.fn()} />);
    await seen('Waiting for the sign-in to finish…');
    const term = terms[terms.length - 1]!;
    await expect(term.options.readClipboard()).resolves.toBe('ABCD-1234');

    readText.mockResolvedValueOnce({ ok: false, message: 'The clipboard could not be read: busy' });
    await expect(term.options.readClipboard()).rejects.toThrow('The clipboard could not be read: busy');
    act(() => term.options.onClipboardError('Could not paste', 'The clipboard could not be read: busy'));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not paste: The clipboard could not be read: busy');
    expect(screen.getByText('Waiting for the sign-in to finish…')).toBeInTheDocument();
  });
});
