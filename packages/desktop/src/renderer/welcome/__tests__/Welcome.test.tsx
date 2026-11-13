import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { patient } from '@ordewell/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonCallResult, DaemonStatus, OrdewellBridge, RecentWorkspace, TerminalEvent, TerminalOpenResult, TerminalOpenSpec } from '../../../shared/bridge';
import { Welcome } from '../../Welcome';

vi.mock('../../views/terminal/xterm', async () => (await import('../../test/xtermMock')).fakeXtermModule());

type Route = (params?: Record<string, string>) => Promise<DaemonCallResult>;

const CONNECTED: DaemonStatus = { state: 'connected', port: 7878, owned: true, daemon: { version: '0.4.0', contract: 3 } };
const ok = (data: unknown): Promise<DaemonCallResult> => Promise.resolve({ ok: true, status: 200, data });

function recent(over: Partial<RecentWorkspace> = {}): RecentWorkspace {
  return {
    path: '/Users/me/code/acme',
    name: 'acme',
    displayPath: '~/code/acme',
    openedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    missing: false,
    ...over,
  };
}

interface Bridge {
  app: Record<string, ReturnType<typeof vi.fn>>;
  daemon: Record<string, ReturnType<typeof vi.fn>>;
  shell: Record<string, ReturnType<typeof vi.fn>>;
  terminal: {
    open: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    openLink: ReturnType<typeof vi.fn>;
  };
}

/**
 * The welcome window's slice of `window.ordewell`. Routes not given answer
 * 404, as a daemon would for a session nobody holds.
 */
function installBridge({ recents = [], routes = {}, platform = 'darwin' }: {
  recents?: RecentWorkspace[] | Promise<RecentWorkspace[]>;
  routes?: Record<string, Route>;
  platform?: string;
} = {}): Bridge & { changeRecents(next: RecentWorkspace[]): void } {
  let stored = recents;
  const recentsListeners = new Set<() => void>();
  const terminal: Bridge['terminal'] = {
    open: vi.fn(async (spec: TerminalOpenSpec, onEvent: (event: TerminalEvent) => void): Promise<TerminalOpenResult> => {
      void spec;
      void onEvent;
      return { ok: true, id: 7, cwd: '/home/me', shell: 'codex' };
    }),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    openLink: vi.fn(async () => ({ ok: true })),
  };
  const bridge: Bridge = {
    app: {
      info: vi.fn(() => Promise.resolve({ version: '0.4.0', contract: 3, platform, theme: 'dark' })),
      context: vi.fn(() => Promise.resolve({ kind: 'welcome' })),
      recentWorkspaces: vi.fn(() => Promise.resolve(stored)),
      openWorkspace: vi.fn(() => Promise.resolve(undefined)),
      forgetWorkspace: vi.fn(async (path: string) => {
        stored = (await stored).filter((entry) => entry.path !== path);
        return stored;
      }),
      unforgetWorkspace: vi.fn(() => Promise.resolve(recents)),
      rememberRecent: vi.fn(() => Promise.resolve()),
      openDroppedFolder: vi.fn(() => Promise.resolve({ ok: true })),
      onRecentsChange: vi.fn((cb: () => void) => { recentsListeners.add(cb); return () => { recentsListeners.delete(cb); }; }),
    },
    daemon: {
      call: vi.fn((route: string, params?: Record<string, string>) => {
        const handler = routes[route];
        return handler ? handler(params) : Promise.resolve({ ok: false, status: 404, error: 'HTTP 404' });
      }),
      retry: vi.fn(() => Promise.resolve({ ok: true })),
      restart: vi.fn(() => Promise.resolve({ ok: true })),
      start: vi.fn(() => Promise.resolve({ ok: true })),
    },
    shell: { openExternal: vi.fn(() => Promise.resolve()) },
    terminal,
  };
  Object.defineProperty(window, 'ordewell', { value: bridge as unknown as OrdewellBridge, configurable: true, writable: true });
  return {
    ...bridge,
    changeRecents(next) {
      stored = next;
      for (const cb of [...recentsListeners]) cb();
    },
  };
}

const RUNNERS = {
  runners: [
    { id: 'claude-code', enabled: true, version: '1.4.2', auth: { state: 'signed-in' } },
    {
      id: 'codex', enabled: true,
      auth: {
        state: 'signed-out', loginCommand: ['codex', 'login'],
        signIn: { runner: 'codex', label: 'Codex', login: ['codex', 'login'] },
      },
    },
  ],
};

const KEYED_RUNNERS = {
  runners: [
    ...RUNNERS.runners,
    {
      id: 'gemini-cli', enabled: true,
      auth: { state: 'signed-out', signIn: { runner: 'gemini-cli', label: 'Gemini CLI', key: { provider: 'google', label: 'Google Gemini' } } },
    },
  ],
};

function section(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name });
  const found = heading.closest('section');
  if (!found) throw new Error(`no section for ${name}`);
  return found;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Welcome: the hero and the footer', () => {
  it('draws the wordmark, Open folder with its shortcut, the hints and the app version', async () => {
    installBridge();
    render(<Welcome status={CONNECTED} />);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    const open = screen.getByRole('button', { name: /Open folder…/ });
    // The shortcut is named only once the platform is known.
    expect(open).not.toHaveAttribute('aria-keyshortcuts');
    expect(await screen.findByText('Ordewell 0.4.0')).toBeInTheDocument();
    expect(open).toHaveAttribute('aria-keyshortcuts', 'Meta+O');
    expect(screen.getByText('Open project')).toBeInTheDocument();
    expect(screen.getByText('⌘Q')).toBeInTheDocument();
  });

  it('opens a folder on ⌘O on macOS, and not on Ctrl+O', async () => {
    const bridge = installBridge();
    render(<Welcome status={CONNECTED} />);
    await screen.findByText('Ordewell 0.4.0', {}, { timeout: patient(10_000) });
    fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
    expect(bridge.app.openWorkspace).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'o', metaKey: true });
    expect(bridge.app.openWorkspace).toHaveBeenCalledWith(undefined);
  });

  it('arms ⌘O in the same commit that names it, not one effect later', async () => {
    const bridge = installBridge();
    render(<Welcome status={CONNECTED} />);
    const open = screen.getByRole('button', { name: /Open folder…/ });
    // A MutationObserver runs right after React's commit and before its passive
    // effects: the earliest moment a user could press the key the button names.
    const calls = await new Promise<number[]>((resolve) => {
      const observer = new MutationObserver(() => {
        if (open.getAttribute('aria-keyshortcuts') !== 'Meta+O') return;
        observer.disconnect();
        fireEvent.keyDown(window, { key: 'o', ctrlKey: true });
        const afterCtrl = bridge.app.openWorkspace.mock.calls.length;
        fireEvent.keyDown(window, { key: 'o', metaKey: true });
        resolve([afterCtrl, bridge.app.openWorkspace.mock.calls.length]);
      });
      observer.observe(open, { attributes: true });
    });
    expect(calls).toEqual([0, 1]);
  });

  it('uses Ctrl+O on Linux and shows Ctrl+Q to quit', async () => {
    const bridge = installBridge({ platform: 'linux' });
    render(<Welcome status={CONNECTED} />);
    await screen.findByText('Ordewell 0.4.0');
    expect(screen.getByText('Ctrl+Q')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'O', ctrlKey: true });
    expect(bridge.app.openWorkspace).toHaveBeenCalledTimes(1);
  });

  it('says the daemon is connecting before main has a status, then its port and version', async () => {
    installBridge();
    const { rerender } = render(<Welcome status={undefined} />);
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByText('daemon: connecting …')).toBeInTheDocument();
    expect(within(footer).queryByRole('button', { name: 'Retry' })).toBeNull();
    rerender(<Welcome status={CONNECTED} />);
    expect(within(footer).getByText('daemon :7878 · owned · 0.4.0')).toBeInTheDocument();
  });

  it('offers Retry in the footer when the daemon failed', async () => {
    const bridge = installBridge();
    render(<Welcome status={{ state: 'failed', port: 7878, message: 'exited', logPath: '/tmp/d.log' }} />);
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByText('Daemon failed')).toBeInTheDocument();
    fireEvent.click(within(footer).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(bridge.daemon.retry).toHaveBeenCalled());
  });
});

describe('Welcome: recent projects', () => {
  it('shows skeleton cards while the store loads', () => {
    installBridge({ recents: new Promise(() => undefined) });
    render(<Welcome status={undefined} />);
    const recents = section('Recent projects');
    expect(recents).toHaveAttribute('aria-busy', 'true');
    expect(recents.querySelectorAll('.welcome-skeleton').length).toBeGreaterThan(0);
  });

  it('shows the empty card when nothing was opened yet', async () => {
    installBridge({ recents: [] });
    render(<Welcome status={CONNECTED} />);
    expect(await screen.findByText(/Open a folder to start/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Open folder…/ })).toHaveLength(1);
  });

  it('redraws when a project window opens or switches to a folder', async () => {
    const bridge = installBridge({ recents: [recent()] });
    render(<Welcome status={CONNECTED} />);
    expect(await within(section('Recent projects')).findByText('acme')).toBeInTheDocument();
    act(() => bridge.changeRecents([recent({ path: '/Users/me/code/billing', name: 'billing', displayPath: '~/code/billing' }), recent()]));
    expect(await within(section('Recent projects')).findByText('billing')).toBeInTheDocument();
  });

  it('shows an error banner with Retry when the store cannot be read', async () => {
    const bridge = installBridge();
    bridge.app.recentWorkspaces.mockRejectedValueOnce(new Error('EACCES: recents.json'));
    render(<Welcome status={CONNECTED} />);
    const alert = await within(section('Recent projects')).findByRole('alert');
    expect(alert).toHaveTextContent('The recent projects could not be read');
    expect(alert).toHaveTextContent('EACCES: recents.json');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Open a folder to start/)).toBeInTheDocument();
  });

  it('draws a card from the store, then its branch, last session and Needs you from the daemon', async () => {
    const bridge = installBridge({
      recents: [recent({ lastSession: { id: 's0', goal: 'old goal', status: 'completed', updatedAt: '2026-11-01T00:00:00Z' } })],
      routes: {
        'git.repos': () => ok({ repos: [{ repo: '.', branch: 'feature/tax' }] }),
        'sessions.list': () => ok([{ id: 's1', goal: 'Split tax lines', status: 'running', updatedAt: '2026-11-04T11:00:00Z', taskCount: 2 }]),
        'plans.escalations': () => ok({ escalations: [{ id: 'e1' }, { id: 'e2' }] }),
      },
    });
    render(<Welcome status={CONNECTED} />);
    const card = (await screen.findByRole('button', { name: 'acme' })).closest('li');
    if (!card) throw new Error('no card');
    expect(card).toHaveTextContent('~/code/acme');
    expect(card).toHaveTextContent('5 minutes ago');
    expect(await within(card).findByText('feature/tax')).toBeInTheDocument();
    expect(card).toHaveTextContent('Split tax lines');
    expect(within(card).getByLabelText('Needs you: 2')).toBeInTheDocument();
    await waitFor(() => expect(bridge.app.rememberRecent).toHaveBeenCalledWith('/Users/me/code/acme', expect.objectContaining({
      git: { kind: 'branch', name: 'feature/tax' },
      lastSession: expect.objectContaining({ id: 's1' }),
    })));

    fireEvent.click(card);
    expect(bridge.app.openWorkspace).toHaveBeenCalledWith('/Users/me/code/acme');
  });

  it("says Running for a session whose run is live, and stores only its saved status, which outlives the run", async () => {
    const bridge = installBridge({
      recents: [recent()],
      routes: {
        'git.repos': () => ok({ repos: [{ repo: '.', branch: 'main' }] }),
        // Saved Approved throughout its run: only `run` says it is at work now.
        'sessions.list': () => ok([{ id: 's1', goal: 'Split tax lines', status: 'approved', updatedAt: '2026-11-04T11:00:00Z', taskCount: 2, run: { live: true } }]),
        'plans.escalations': () => ok({ escalations: [] }),
      },
    });
    render(<Welcome status={CONNECTED} />);
    const card = (await screen.findByRole('button', { name: 'acme' })).closest('li');
    if (!card) throw new Error('no card');
    expect(await within(card).findByText('· Running')).toBeInTheDocument();
    await waitFor(() => expect(bridge.app.rememberRecent).toHaveBeenCalledWith('/Users/me/code/acme', expect.objectContaining({
      lastSession: { id: 's1', goal: 'Split tax lines', status: 'approved', updatedAt: '2026-11-04T11:00:00Z' },
    })));
  });

  it('keeps the stored lines and says live state is unavailable when the daemon is down', async () => {
    installBridge({ recents: [recent({ git: { kind: 'branch', name: 'main' }, lastSession: { id: 's0', goal: 'Stored goal', status: 'completed', updatedAt: '2026-11-01T00:00:00Z' } })] });
    render(<Welcome status={{ state: 'port-taken', port: 7878 }} />);
    const card = (await screen.findByRole('button', { name: 'acme' })).closest('li');
    if (!card) throw new Error('no card');
    expect(card).toHaveTextContent('main');
    expect(card).toHaveTextContent('Stored goal');
    expect(card).toHaveTextContent('Live state unavailable');
  });

  it('shows a missing folder that does not open, and forgets it', async () => {
    const bridge = installBridge({ recents: [recent({ missing: true, name: 'gone', path: '/x/gone', displayPath: '/x/gone' })] });
    render(<Welcome status={CONNECTED} />);
    const name = await screen.findByText('gone');
    const card = name.closest('li');
    if (!card) throw new Error('no card');
    expect(card).toHaveAttribute('data-state', 'missing');
    expect(card).toHaveTextContent('Folder not found');
    expect(within(card).queryByRole('button', { name: 'gone' })).toBeNull();
    fireEvent.click(card);
    expect(bridge.app.openWorkspace).not.toHaveBeenCalled();
    // A missing folder is never asked of the daemon.
    expect(bridge.daemon.call).not.toHaveBeenCalledWith('git.repos', expect.anything());

    fireEvent.click(within(card).getByRole('button', { name: 'Forget gone' }));
    await waitFor(() => expect(bridge.app.forgetWorkspace).toHaveBeenCalledWith('/x/gone'));
    expect(await screen.findByText(/Open a folder to start/)).toBeInTheDocument();
  });

  it('undoes a Forget from the toast', async () => {
    const entries = [recent(), recent({ path: '/Users/me/code/beta', name: 'beta', displayPath: '~/code/beta' })];
    const bridge = installBridge({ recents: entries });
    render(<Welcome status={undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Forget beta' }));
    const toast = await screen.findByText('Forgot beta.');
    expect(screen.queryByRole('button', { name: 'beta' })).toBeNull();
    fireEvent.click(within(toast.parentElement as HTMLElement).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(bridge.app.unforgetWorkspace).toHaveBeenCalledWith('/Users/me/code/beta'));
    expect(await screen.findByRole('button', { name: 'beta' })).toBeInTheDocument();
    expect(screen.queryByText('Forgot beta.')).toBeNull();
  });

  it('shows nine cards and the rest behind Show all', async () => {
    const many = Array.from({ length: 11 }, (_, index) => recent({ path: `/p/${index}`, name: `proj-${index}`, displayPath: `/p/${index}` }));
    installBridge({ recents: many });
    render(<Welcome status={undefined} />);
    await screen.findByRole('button', { name: 'proj-0' });
    expect(screen.queryByRole('button', { name: 'proj-10' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all (11)' }));
    expect(screen.getByRole('button', { name: 'proj-10' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show fewer' })).toBeInTheDocument();
  });
});

describe('Welcome: dropping a folder', () => {
  function drop(target: HTMLElement, files: File[]): void {
    const list = Object.assign([...files], { item: (index: number) => files[index] ?? null });
    fireEvent.dragEnter(target, { dataTransfer: { types: ['Files'], files: list } });
    expect(document.querySelector('.welcome-drop')).not.toBeNull();
    fireEvent.drop(target, { dataTransfer: { types: ['Files'], files: list } });
  }

  it('hands one dropped item to main and toasts its refusal', async () => {
    const bridge = installBridge();
    bridge.app.openDroppedFolder.mockResolvedValueOnce({ ok: false, message: 'Not a folder: notes.txt' });
    const { container } = render(<Welcome status={CONNECTED} />);
    const file = new File(['x'], 'notes.txt');
    drop(container.firstElementChild as HTMLElement, [file]);
    expect(document.querySelector('.welcome-drop')).toBeNull();
    expect(await screen.findByText('Not a folder: notes.txt')).toBeInTheDocument();
    expect(bridge.app.openDroppedFolder).toHaveBeenCalledWith(file);
  });

  it('refuses more than one item without asking main', async () => {
    const bridge = installBridge();
    const { container } = render(<Welcome status={CONNECTED} />);
    drop(container.firstElementChild as HTMLElement, [new File(['a'], 'a'), new File(['b'], 'b')]);
    expect(await screen.findByText('Drop one folder.')).toBeInTheDocument();
    expect(bridge.app.openDroppedFolder).not.toHaveBeenCalled();
  });
});

describe('Welcome: runners', () => {
  it('draws a card per known runner with its state, version and sign-in command', async () => {
    installBridge({ routes: { 'runners.list': () => ok(RUNNERS) } });
    render(<Welcome status={CONNECTED} />);
    const runners = section('Runners');
    const claude = await within(runners).findByText('Signed in');
    expect(claude.closest('li')).toHaveTextContent('version 1.4.2');
    const codex = runners.querySelector('[data-runner="codex"]');
    expect(codex).toHaveTextContent('Signed out');
    expect(codex).toHaveTextContent('codex login');
    const opencode = runners.querySelector('[data-runner="opencode"]');
    expect(opencode).toHaveAttribute('data-state', 'missing');
    expect(opencode).toHaveTextContent('Install OpenCode, then Retry.');
  });

  it('words a signed-out agent as core does and offers its own Log in', async () => {
    installBridge({ routes: { 'runners.list': () => ok(RUNNERS) } });
    render(<Welcome status={CONNECTED} />);
    const codex = (await screen.findByText('Signed out')).closest('li') as HTMLElement;
    expect(codex).toHaveTextContent('Sign in with /login codex, or run codex login.');
    expect(within(codex).getByRole('button', { name: 'Log in' })).toBeInTheDocument();
  });

  it('opens the key entry for an agent whose way in is a key', async () => {
    installBridge({ routes: { 'runners.list': () => ok(KEYED_RUNNERS) } });
    render(<Welcome status={CONNECTED} />);
    const gemini = (await screen.findByText('Run /key and choose Google Gemini to hand it a key.')).closest('li') as HTMLElement;
    expect(gemini).toHaveTextContent('Gemini CLI');
    fireEvent.click(within(gemini).getByRole('button', { name: 'Set API key…' }));
    expect(await screen.findByRole('dialog', { name: 'API key for Google Gemini' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists every runner core ships when none is installed, each with its install page', async () => {
    installBridge({ routes: { 'runners.list': () => ok({ runners: [] }) } });
    render(<Welcome status={CONNECTED} />);
    const runners = section('Runners');
    await waitFor(() => expect(runners.querySelectorAll('[data-runner]')).toHaveLength(8));
    for (const name of ['Claude Code', 'Codex', 'OpenCode', 'GitHub Copilot CLI', 'Qwen Code', 'Cline', 'Gemini CLI', 'Cursor']) {
      expect(within(runners).getByTitle(name)).toBeInTheDocument();
    }
    expect(within(runners).getAllByRole('button', { name: 'Docs' })).toHaveLength(8);
  });

  it('shows skeleton runners until the daemon connects', () => {
    const bridge = installBridge({ routes: { 'runners.list': () => ok(RUNNERS) } });
    render(<Welcome status={{ state: 'connecting', port: 7878 }} />);
    const runners = section('Runners');
    expect(runners).toHaveAttribute('aria-busy', 'true');
    expect(runners.querySelectorAll('.welcome-skeleton').length).toBeGreaterThan(0);
    expect(bridge.daemon.call).not.toHaveBeenCalledWith('runners.list');
  });

  it('turns a failed list into the error banner, and Retry asks again', async () => {
    let answer: DaemonCallResult = { ok: false, status: 500, error: 'HTTP 500', data: { error: 'probe crashed' } };
    installBridge({ routes: { 'runners.list': () => Promise.resolve(answer) } });
    render(<Welcome status={CONNECTED} />);
    const alert = await within(section('Runners')).findByRole('alert');
    expect(alert).toHaveTextContent('The daemon did not list its runners');
    expect(alert).toHaveTextContent('probe crashed');
    expect(alert).toHaveTextContent('GET /api/runners · status 500');
    answer = { ok: true, status: 200, data: RUNNERS };
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await within(section('Runners')).findByText('Signed in')).toBeInTheDocument();
  });

  it('never stays checking: a list that does not come times out into the error banner', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    installBridge({ routes: { 'runners.list': () => new Promise(() => undefined) } });
    render(<Welcome status={CONNECTED} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByText('Loading runners …')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(13_000); });
    const alert = within(section('Runners')).getByRole('alert');
    expect(alert).toHaveTextContent('did not answer within 15 seconds');
    expect(alert).toHaveTextContent('no response');
  });

  it('says so when every runner is off', async () => {
    installBridge({ routes: { 'runners.list': () => ok({ runners: KNOWN_OFF }) } });
    render(<Welcome status={CONNECTED} />);
    expect(await screen.findByText('No runners are on. Turn one on in Settings.')).toBeInTheDocument();
  });

  it("shows the daemon's own card, with its actions, when the handshake failed", async () => {
    const bridge = installBridge();
    render(<Welcome status={{ state: 'mismatch', port: 7878, daemon: { version: '0.3.0', contract: 2 }, app: { version: '0.4.0', contract: 3 } }} />);
    const alert = within(section('Runners')).getByRole('alert');
    expect(alert).toHaveTextContent('The running daemon is another version');
    fireEvent.click(within(alert).getByRole('button', { name: 'Restart daemon' }));
    await waitFor(() => expect(bridge.daemon.restart).toHaveBeenCalled());
    expect(bridge.daemon.call).not.toHaveBeenCalledWith('runners.list');
  });
});

const KNOWN_OFF = ['claude-code', 'codex', 'opencode', 'copilot-cli', 'qwen-code', 'cline', 'gemini-cli', 'cursor-agent'].map((id) => ({ id, enabled: false }));
