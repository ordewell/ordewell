import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalEvent, TerminalOpenResult, TerminalOpenSpec } from '../../../../shared/bridge';
import { registerFrameCommands } from '../../../frame/commands';
import { Frame } from '../../../frame/Frame';
import { FrameProvider, FrameStore } from '../../../frame/store';
import { CONNECTED, installBridge } from '../../../test/explorerHarness';
import { terms } from '../../../test/xtermMock';
import { registerViews } from '../../index';
import { terminalStoreFor } from '../terminalStore';

vi.mock('../xterm', async () => (await import('../../../test/xtermMock')).fakeXtermModule());


function run(states: { t3: string; t4: string }): unknown {
  return {
    meta: { id: 's1' },
    run: {
      tasks: [
        { id: 't3', order: 3, title: 'Add the parser', isolation: { state: states.t3, branch: 'b3', worktree: 'w3', repos: ['.'] } },
        { id: 't4', order: 4, title: 'Wire the CLI', isolation: { state: states.t4, branch: 'b4', worktree: 'w4', repos: ['.'] } },
      ],
      handoff: { repos: [{ path: '.', integrationBranch: 'ordewell/s1', landed: [] }], landed: [] },
    },
  };
}

interface Pty { id: number; spec: TerminalOpenSpec; emit(event: TerminalEvent): void }

interface World {
  ptys: Pty[];
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  openLink: ReturnType<typeof vi.fn>;
  word: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  clipboard: { readText: ReturnType<typeof vi.fn>; writeText: ReturnType<typeof vi.fn> };
  session: { t3: string; t4: string };
  /** What the daemon's session stream pushes. */
  stream(): void;
  openResult: TerminalOpenResult | undefined;
}

/** The daemon with one session whose task 3 is running and task 4 is done, and a terminal bridge that records. */
function world(): World {
  const w: World = {
    ptys: [], write: vi.fn(async () => undefined), resize: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    openLink: vi.fn(async () => ({ ok: true })), word: vi.fn(async () => undefined), open: vi.fn(),
    clipboard: { readText: vi.fn(async () => ({ ok: true, text: 'from the clipboard' })), writeText: vi.fn(async () => ({ ok: true })) },
    session: { t3: 'active', t4: 'integrated' },
    stream: () => undefined, openResult: undefined,
  };
  installBridge({
    'git.repos': () => ({ repos: [{ repo: '.', branch: 'main', detached: false }] }),
    'sessions.list': () => [{ id: 's1', goal: 'Ship it', status: 'running', taskCount: 2, updatedAt: '2026-11-03T09:00:00.000Z' }],
    'sessions.get': () => run(w.session),
  });
  const bridge = (window as unknown as { ordewell: { daemon: Record<string, unknown>; terminal?: unknown; clipboard?: unknown } }).ordewell;
  const listeners: Array<() => void> = [];
  bridge.daemon.subscribe = vi.fn((_session: string, cb: () => void) => { listeners.push(cb); return () => { listeners.splice(listeners.indexOf(cb), 1); }; });
  w.stream = () => { for (const cb of [...listeners]) cb(); };
  w.open.mockImplementation(async (spec: TerminalOpenSpec, onEvent: (event: TerminalEvent) => void): Promise<TerminalOpenResult> => {
    if (w.openResult) return w.openResult;
    const id = w.ptys.length + 1;
    w.ptys.push({ id, spec, emit: onEvent });
    return { ok: true, id, cwd: '/work/acme', shell: 'zsh' };
  });
  bridge.terminal = { open: w.open, write: w.write, resize: w.resize, close: w.close, openLink: w.openLink, word: w.word };
  bridge.clipboard = w.clipboard;
  return w;
}

let store: FrameStore;
let offs: Array<() => void> = [];
beforeEach(() => { offs = []; terms.length = 0; });
afterEach(() => { for (const off of offs) off(); vi.restoreAllMocks(); });

async function mount(platform = 'linux'): Promise<void> {
  store = new FrameStore({ workspace: '/work/acme', platform });
  offs.push(registerFrameCommands(store), registerViews(store.api));
  render(<FrameProvider value={store}><Frame daemon={CONNECTED} /></FrameProvider>);
}

const toggle = (): void => { act(() => store.api.runCommand('terminal.toggle')); };
const panel = (): HTMLElement => screen.getByRole('region', { name: 'Terminal' });

async function openPanel(): Promise<void> {
  await mount();
  toggle();
  await screen.findByRole('tab', { name: /zsh/ });
}

async function openMenu(): Promise<HTMLElement> {
  fireEvent.click(within(panel()).getByRole('button', { name: 'Open a terminal in another scope' }));
  return screen.findByRole('menu');
}

describe('the terminal panel', () => {
  it('is hidden until toggled, then opens a shell in the user\'s checkout', async () => {
    const w = world();
    await mount();
    expect(screen.queryByRole('region', { name: 'Terminal' })).not.toBeInTheDocument();
    expect(w.open).not.toHaveBeenCalled();

    toggle();
    const tab = await screen.findByRole('tab', { name: /zsh/ });
    expect(tab).toHaveTextContent('Your checkout');
    expect(w.open).toHaveBeenCalledTimes(1);
    expect(w.ptys[0]?.spec).toMatchObject({ repo: '.', scope: { kind: 'checkout' } });
  });

  it('describes the unavailable shortcut on macOS until the shell joins the word link (ADR-0069)', async () => {
    const w = world();
    await mount('darwin');
    toggle();
    await screen.findByRole('tab', { name: /zsh/ });
    expect(within(panel()).getByRole('tabpanel')).toHaveAccessibleDescription(/Option\+Left\/Right moves by words only at the prompt of macOS’s own zsh/);
    expect(within(panel()).getByText(/in this terminal it does nothing/)).toBeVisible();
    terms[0]!.options.onWord?.('left');
    expect(w.word).not.toHaveBeenCalled();

    act(() => w.ptys[0]?.emit({ kind: 'words' }));
    expect(within(panel()).queryByText(/in this terminal it does nothing/)).not.toBeInTheDocument();
    expect(within(panel()).getByRole('tabpanel')).not.toHaveAttribute('aria-describedby');
    expect(within(panel()).getByRole('tab', { name: /zsh/ })).toBeInTheDocument();
    terms[0]!.options.onWord?.('right');
    expect(w.word).toHaveBeenCalledWith(w.ptys[0]!.id, 'right');

    act(() => w.ptys[0]?.emit({ kind: 'exit', exitCode: 0 }));
    terms[0]!.options.onWord?.('left');
    expect(w.word).toHaveBeenCalledTimes(1);
  });

  it('opens the panel for a login and runs it in the checkout, ending when its process does', async () => {
    const w = world();
    await mount();
    const login = await terminalStoreFor(store.api).openLogin('codex', 'Codex');

    expect(await screen.findByRole('region', { name: 'Terminal' })).toBeVisible();
    expect(w.ptys[0]?.spec).toMatchObject({ repo: '.', scope: { kind: 'checkout' }, login: { runner: 'codex' } });
    expect(screen.getByRole('tab', { name: /Codex login/ })).toBeInTheDocument();

    act(() => w.ptys[0]?.emit({ kind: 'exit', exitCode: 0 }));
    await expect(login.ended).resolves.toBeUndefined();
  });

  it('shows the shell\'s output and sends what is typed to that shell', async () => {
    const w = world();
    await openPanel();
    act(() => w.ptys[0]?.emit({ kind: 'data', data: 'hello from zsh' }));
    expect(panel()).toHaveTextContent('hello from zsh');
    terms[0]?.type('ls\r');
    expect(w.write).toHaveBeenCalledWith(1, 'ls\r');
  });

  it('keeps the shell and its scrollback when the panel is hidden and shown again', async () => {
    const w = world();
    await openPanel();
    act(() => w.ptys[0]?.emit({ kind: 'data', data: 'build output' }));

    toggle();
    expect(screen.queryByRole('region', { name: 'Terminal' })).not.toBeInTheDocument();
    toggle();

    await screen.findByRole('tab', { name: /zsh/ });
    expect(w.open).toHaveBeenCalledTimes(1);
    expect(w.close).not.toHaveBeenCalled();
    expect(terms).toHaveLength(1);
    expect(terms[0]?.disposed).toBe(false);
    expect(panel()).toHaveTextContent('build output');
  });

  it('opens a link only with the modifier handling the terminal gives it, and only through the bridge', async () => {
    const w = world();
    await openPanel();
    terms[0]?.link('https://example.com/docs');
    expect(w.openLink).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('reaches the clipboard only through the bridge, and says when it could not', async () => {
    const w = world();
    await openPanel();
    const options = terms[0]?.options;
    if (!options) throw new Error('no terminal');

    await expect(options.readClipboard()).resolves.toBe('from the clipboard');
    await options.writeClipboard('selected');
    expect(w.clipboard.writeText).toHaveBeenCalledWith('selected');

    w.clipboard.readText.mockResolvedValueOnce({ ok: false, message: 'The clipboard could not be read: busy' });
    await expect(options.readClipboard()).rejects.toThrow('The clipboard could not be read: busy');
    act(() => options.onClipboardError('Could not paste', 'The clipboard could not be read: busy'));
    const banner = await screen.findByRole('region', { name: 'Could not paste' });
    expect(banner).toHaveTextContent('The clipboard could not be read: busy');
    expect(document.querySelector('.frame-live')).toHaveTextContent('Could not paste: The clipboard could not be read: busy');
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Could not paste' })).not.toBeInTheDocument());
  });

  it('tells the shell the grid when the panel is resized', async () => {
    const w = world();
    await openPanel();
    const host = panel().querySelector<HTMLElement>('.terminal-host');
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 900 });
    act(() => terminalStoreFor(store.api).fit());
    expect(w.resize).toHaveBeenCalledWith(1, 100, 30);
    w.resize.mockClear();
    act(() => terminalStoreFor(store.api).fit());
    expect(w.resize).not.toHaveBeenCalled();
  });

  it('closes a tab, ends its shell and drops its terminal', async () => {
    const w = world();
    await openPanel();
    fireEvent.click(within(panel()).getByRole('button', { name: 'New terminal in your checkout' }));
    await waitFor(() => expect(within(panel()).getAllByRole('tab')).toHaveLength(2));

    fireEvent.click(screen.getAllByRole('button', { name: /^Close zsh/ })[0] as HTMLElement);
    expect(w.close).toHaveBeenCalledWith(1);
    expect(terms[0]?.disposed).toBe(true);
    expect(within(panel()).getAllByRole('tab')).toHaveLength(1);
    expect(within(panel()).getByRole('tab', { selected: true })).toBeInTheDocument();
  });

  it('renames a tab, and puts the shell\'s name back on an empty one', async () => {
    await (async () => { world(); await openPanel(); })();
    fireEvent.doubleClick(screen.getByRole('tab', { name: /zsh/ }));
    const input = screen.getByRole('textbox', { name: 'Terminal name' });
    fireEvent.change(input, { target: { value: 'server' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('tab', { name: /server/ })).toHaveTextContent('Your checkout');

    fireEvent.keyDown(screen.getByRole('tab', { name: /server/ }), { key: 'F2' });
    const again = screen.getByRole('textbox', { name: 'Terminal name' });
    fireEvent.change(again, { target: { value: '   ' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    expect(screen.getByRole('tab', { name: /zsh/ })).toBeInTheDocument();
  });

  it('marks a tab whose process ended and keeps its output', async () => {
    const w = world();
    await openPanel();
    act(() => w.ptys[0]?.emit({ kind: 'data', data: 'last words' }));
    act(() => w.ptys[0]?.emit({ kind: 'exit', exitCode: 2 }));
    expect(panel()).toHaveTextContent('last words');
    expect(panel()).toHaveTextContent('Process exited with code 2.');
    const tab = screen.getByRole('tab', { name: /zsh/ });
    expect(tab).toHaveClass('terminal-tab-ended');
    // The state is a word on the tab, not a strike through its name.
    expect(within(tab).getByText('exited')).toBeInTheDocument();
  });

  it('says why a shell could not start', async () => {
    const w = world();
    w.openResult = { ok: false, message: 'Could not start /bin/zsh: spawn failed' };
    await mount();
    toggle();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start /bin/zsh: spawn failed');
  });
});

describe('where a terminal can open', () => {
  it('lists the checkout, the integration branch and each task worktree, and disables what the rule refuses with its reason', async () => {
    world();
    await openPanel();
    const menu = await openMenu();
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: /Task #3 worktree/ })).toBeInTheDocument());

    expect(within(menu).getByRole('menuitem', { name: /Your checkout/ })).toBeEnabled();
    const running = within(menu).getByRole('menuitem', { name: /Task #3 worktree/ });
    expect(running).toBeDisabled();
    expect(running).toHaveTextContent('Task #3 is running; a terminal in its worktree would race the agent. Open one when it stops.');
    expect(within(menu).getByRole('menuitem', { name: /Task #4 worktree/ })).toBeEnabled();
    const integration = within(menu).getByRole('menuitem', { name: /Integration branch/ });
    expect(integration).toBeDisabled();
    expect(integration).toHaveTextContent('no worktree');
  });

  it('opens in a task worktree once that task has stopped, labelled with it', async () => {
    const w = world();
    await openPanel();
    const menu = await openMenu();
    fireEvent.click(await within(menu).findByRole('menuitem', { name: /Task #4 worktree/ }));

    await waitFor(() => expect(w.ptys).toHaveLength(2));
    expect(w.ptys[1]?.spec).toMatchObject({ repo: '.', scope: { kind: 'task', sessionId: 's1', taskId: 't4' } });
    expect(await screen.findByRole('tab', { name: /Task #4 worktree/ })).toBeInTheDocument();
  });

  it('does not open in a worktree whose task is running, even if the page asks', async () => {
    const w = world();
    await openPanel();
    await openMenu();
    await waitFor(() => expect(screen.getByRole('menuitem', { name: /Task #3 worktree/ })).toBeInTheDocument());
    await act(async () => { await terminalStoreFor(store.api).open({ kind: 'task', sessionId: 's1', taskId: 't3' }, '.'); });
    expect(w.open).toHaveBeenCalledTimes(1);
  });

  it('names the task in a banner when it starts while a shell sits in its worktree, and does not kill the shell', async () => {
    const w = world();
    w.session = { t3: 'integrated', t4: 'integrated' };
    await openPanel();
    const menu = await openMenu();
    fireEvent.click(await within(menu).findByRole('menuitem', { name: /Task #3 worktree/ }));
    await screen.findByRole('tab', { name: /Task #3 worktree/ });
    expect(panel().querySelector('.terminal-banner')).toBeNull();

    w.session = { t3: 'active', t4: 'integrated' };
    w.stream();
    await waitFor(() => expect(panel().querySelector('.terminal-banner')).toHaveTextContent(/Task #3 is running in this worktree/));
    // The live region says it once, too.
    expect(document.querySelector('.frame-live')).toHaveTextContent(/Task #3 is running/);
    expect(w.close).not.toHaveBeenCalled();
    expect(terms.every((term) => !term.disposed)).toBe(true);
  });
});
