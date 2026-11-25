import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonStatus } from '../../../shared/bridge';
import { fakeDaemon } from '../../session/__tests__/fakeDaemon';
import { resetDaemonHosts } from '../../session/DaemonHost';
import { register as registerConnection } from '../../views/connection/ConnectionBanners';
import { registerFrameCommands } from '../commands';
import { DAEMON_WAIT_CARD_DELAY_MS } from '../DaemonWait';
import { Frame } from '../Frame';
import { FrameProvider, FrameStore } from '../store';

const PORT = 3742;
const STARTING: DaemonStatus = { state: 'connecting', port: PORT, starting: true, logPath: '/home/me/.ordewell/server.log' };
const LOOKING: DaemonStatus = { state: 'connecting', port: PORT };
const CONNECTED: DaemonStatus = { state: 'connected', port: PORT, owned: true, daemon: { version: '0.14.12', contract: 4 } };
const AWAY: DaemonStatus = { state: 'reconnecting', port: PORT, attempt: 1, canStart: false };

const WAIT_LINE = "Starting Ordewell's daemon on port 3742…";
const LOG_LINE = 'Still waiting for the daemon on port 3742 to answer. Its log: /home/me/.ordewell/server.log';

let offs: Array<() => void> = [];
let daemon: ReturnType<typeof fakeDaemon>;

beforeEach(() => {
  vi.useFakeTimers();
  daemon = fakeDaemon();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1512 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 982 });
});
afterEach(() => {
  for (const off of offs) off();
  offs = [];
  resetDaemonHosts();
  vi.useRealTimers();
});

/**
 * A project window as the app draws it: the frame, its commands, a planner
 * tab with a control in it, and the connection banners, which hold the frame
 * read-only while the daemon is away. `status` is what main last pushed.
 */
function mount(status: DaemonStatus): { rerender(next: DaemonStatus): void; store: FrameStore } {
  daemon.setStatus(status);
  const store = new FrameStore({ workspace: '/work/acme', platform: 'win32', viewport: { width: 1512, height: 982 } });
  const { api } = store;
  offs.push(
    registerFrameCommands(store),
    api.registerTabKind({ kind: 'planner', render: () => <textarea aria-label="Message the planner" /> }),
    api.registerSidebar({ activity: 'sessions', id: 'sessions', title: 'Sessions', render: () => <p>Session list</p> }),
    api.registerPanel({ region: 'plan', id: 'plan', title: 'Plan', render: () => <p>The task list</p> }),
    registerConnection(api),
  );
  const view = render(<FrameProvider value={store}><Frame daemon={status} /></FrameProvider>);
  return {
    store,
    rerender(next) {
      act(() => daemon.setStatus(next));
      view.rerender(<FrameProvider value={store}><Frame daemon={next} /></FrameProvider>);
    },
  };
}

const body = (): HTMLElement => document.querySelector('.frame-body') as HTMLElement;
const card = (): HTMLElement | null => document.querySelector('.frame-wait-card');
const advance = (ms: number): void => { act(() => { vi.advanceTimersByTime(ms); }); };

describe('the wait for the daemon over a project window', () => {
  it('shows nothing extra before a short delay, so a fast start is only the dimmed frame', async () => {
    mount(STARTING);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    advance(DAEMON_WAIT_CARD_DELAY_MS - 1);
    expect(card()).toBeNull();
    expect(screen.queryByText(WAIT_LINE)).toBeNull();
    // Busy and inert from the start: what can be used does not wait on the card.
    expect(body()).toHaveAttribute('aria-busy', 'true');
    expect(body()).toHaveAttribute('inert');
  });

  it('names what it waits for after the delay, in core\'s words, with a quiet progress mark and no action', async () => {
    mount(STARTING);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    advance(DAEMON_WAIT_CARD_DELAY_MS);
    const shown = card();
    expect(shown).not.toBeNull();
    expect(shown).toHaveAttribute('role', 'status');
    expect(shown).toHaveTextContent(WAIT_LINE);
    expect(shown?.querySelector('.ow-loading-mark')).toHaveAttribute('aria-hidden', 'true');
    expect(within(shown as HTMLElement).queryAllByRole('button')).toEqual([]);
    expect(shown).not.toHaveTextContent('Its log');
    expect(body()).toHaveAttribute('inert');
    expect(body()).toHaveAttribute('aria-busy', 'true');
  });

  it('says where the log is once the wait is as long as the terminal\'s, and only then', async () => {
    mount(STARTING);
    advance(4_999);
    expect(card()).not.toHaveTextContent('Its log');
    advance(1);
    expect(card()).toHaveTextContent(WAIT_LINE);
    expect(screen.getByText(LOG_LINE)).toBeInTheDocument();
  });

  it('names a daemon it looks for, rather than one it starts, as connecting', () => {
    mount(LOOKING);
    advance(DAEMON_WAIT_CARD_DELAY_MS);
    expect(card()).toHaveTextContent("Connecting to Ordewell's daemon on port 3742…");
  });

  it('goes once the daemon is connected, and the frame is usable again', async () => {
    const win = mount(STARTING);
    advance(6_000);
    expect(screen.getByText(LOG_LINE)).toBeInTheDocument();
    win.rerender(CONNECTED);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(card()).toBeNull();
    expect(body()).not.toHaveAttribute('aria-busy');
    expect(body()).not.toHaveAttribute('inert');
  });

  it('never shows for a start that answers before the delay', async () => {
    const win = mount(STARTING);
    advance(DAEMON_WAIT_CARD_DELAY_MS - 100);
    win.rerender(CONNECTED);
    advance(10_000);
    expect(card()).toBeNull();
  });

  it('leaves a reconnect to its banner: no card, and the frame is not called busy', async () => {
    mount(AWAY);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    advance(10_000);
    expect(card()).toBeNull();
    expect(body()).not.toHaveAttribute('aria-busy');
    expect(screen.getByRole('region', { name: 'Reconnecting to the daemon…' })).toBeInTheDocument();
  });

  it('starts its count again for a later wait', () => {
    const win = mount(STARTING);
    advance(6_000);
    win.rerender(CONNECTED);
    win.rerender(STARTING);
    advance(DAEMON_WAIT_CARD_DELAY_MS);
    expect(card()).toHaveTextContent(WAIT_LINE);
    expect(screen.queryByText(LOG_LINE)).toBeNull();
  });

  it('changes nothing that can be used while it waits: the title bar works as before, the body not at all', async () => {
    const { store } = mount(STARTING);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    advance(DAEMON_WAIT_CARD_DELAY_MS);
    expect(store.getSnapshot().readOnly).toBe(true);
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'New window' })).toBeInTheDocument();
  });
});
