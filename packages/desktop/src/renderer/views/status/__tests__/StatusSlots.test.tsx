import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountLimitSnapshot } from '@ordewell/core';
import type { DaemonStatus } from '../../../../shared/bridge';
import { registerFrameCommands } from '../../../frame/commands';
import { Frame } from '../../../frame/Frame';
import { FrameProvider, FrameStore } from '../../../frame/store';
import { daemonHost, resetDaemonHosts } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan } from '../../../session/__tests__/fakeDaemon';
import { registerViews } from '../../index';
import { resetTaskViews } from '../../task/taskView';

vi.mock('../../../monaco', async () => (await import('../../../test/monacoMock')).fakeMonacoModule());

const WORKSPACE = '/work/acme';
const OWNED: DaemonStatus = { state: 'connected', port: 3742, owned: true, daemon: { version: '0.14.9', contract: 1 } };

const CODEX_LIMITS: AccountLimitSnapshot = {
  harness: 'codex',
  label: 'Codex',
  status: 'fresh',
  buckets: [{ id: 'codex', windows: [{ slot: 'primary', usedPercent: 24, durationMinutes: 300, resetsAt: null }] }],
  readAt: '2026-11-03T09:00:00.000Z',
};

let offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs) off();
  offs = [];
  resetDaemonHosts();
  resetTaskViews();
});

function mount(daemon: DaemonStatus): ReturnType<typeof fakeDaemon> {
  const fake = fakeDaemon({
    'sessions.load': ok({ ok: true, plan: surfacePlan([]), goal: 'Ship the parser' }),
    'runners.list': ok({ runners: [
      { id: 'claude-code', name: 'Claude Code', enabled: true, auth: { state: 'signed-in' } },
      { id: 'codex', name: 'Codex', enabled: true, auth: { state: 'signed-in' } },
    ] }),
    'models.list': ok({ models: [], providers: [], modelsByRunner: {}, modesByRunner: {}, orchestratorModel: '' }),
    'settings.get': ok({}),
  });
  const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
  offs.push(registerFrameCommands(store), registerViews(store.api));
  render(<FrameProvider value={store}><Frame daemon={daemon} /></FrameProvider>);
  return fake;
}

const row = (): HTMLElement => screen.getByRole('contentinfo');
const item = (): HTMLElement => {
  const found = row().querySelector('.frame-status-daemon');
  if (!(found instanceof HTMLElement)) throw new Error('no daemon item');
  return found;
};
/** What the row draws on its one line: everything but the daemon item's detail. */
function shown(): string {
  const copy = row().cloneNode(true) as HTMLElement;
  for (const detail of copy.querySelectorAll('[role="tooltip"]')) detail.remove();
  return copy.textContent ?? '';
}
/** The daemon item's detail, which opens while the item has focus or the pointer. */
function detail(): HTMLElement {
  act(() => item().focus());
  return screen.getByRole('tooltip');
}

describe('the status row', () => {
  it('shows the daemon alone while all is well: no runners, no lease and no usage', async () => {
    const fake = mount(OWNED);
    const host = daemonHost(WORKSPACE);
    await act(() => host.handle({ type: 'ready' }));
    await waitFor(() => expect(host.getSnapshot().state.runnersKnown).toBe(true));
    await act(() => host.open('s1'));
    act(() => fake.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'account_limits', limits: [CODEX_LIMITS], sessionId: 's1', stream: 'd1', revision: 1 }));
    // The limits did arrive: the planner's and runners' chats draw them, the row does not.
    expect(host.getSnapshot().state.accountLimits).toEqual([CODEX_LIMITS]);

    expect(shown()).toBe('Daemon v0.14.9 · :3742');
  });

  it('puts who started the daemon and the session\'s lease in the daemon item\'s detail, shown on focus or hover', async () => {
    mount(OWNED);
    await act(() => daemonHost(WORKSPACE).handle({ type: 'ready' }));
    expect(screen.queryByRole('tooltip')).toBeNull();

    expect(item()).toHaveAttribute('tabindex', '0');
    const shownDetail = detail();
    expect(item()).toHaveAttribute('aria-describedby', shownDetail.id);
    expect(shownDetail).toHaveTextContent('Daemon v0.14.9 on 127.0.0.1:3742, started by this app');
    expect(shownDetail).toHaveTextContent('Lease: this window');
    expect(shown()).toBe('Daemon v0.14.9 · :3742');

    act(() => item().blur());
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(item());
    expect(screen.getByRole('tooltip')).toHaveTextContent('started by this app');
    fireEvent.mouseLeave(item());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('says an attached daemon was started outside this app, in the detail only', async () => {
    mount({ ...OWNED, owned: false });
    expect(shown()).toBe('Daemon v0.14.9 · :3742');
    expect(detail()).toHaveTextContent('attached: started outside this app');
  });

  it('names a state that needs the user on the row itself', () => {
    mount({ state: 'mismatch', port: 3742, daemon: { version: '0.12.3', contract: 4 }, app: { version: '0.14.9', contract: 5 } });
    expect(shown()).toBe('Version mismatch on :3742');
    expect(detail()).toHaveTextContent('this app speaks v0.14.9, contract 5');
  });
});
