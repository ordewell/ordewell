import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IsolationHandoff } from '@ordewell/core';
import { registerFrameCommands } from '../../../frame/commands';
import { Frame } from '../../../frame/Frame';
import { FrameProvider, FrameStore } from '../../../frame/store';
import { daemonHost, resetDaemonHosts } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';
import { registerViews } from '../../index';
import { resetTaskViews } from '../../task/taskView';
import { runTask } from '../../changes/__tests__/fixtures';

// Monaco needs a browser; these views never open a file.
vi.mock('../../../monaco', async () => (await import('../../../test/monacoMock')).fakeMonacoModule());

beforeAll(() => {
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { ResizeObserver: Observer });
  Element.prototype.scrollIntoView = () => {};
});

const WORKSPACE = '/work/acme';
const CONNECTED = { state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } } as const;
const PLAN = surfacePlan([
  surfaceTask({ id: 't1', order: 1, title: 'Add a greeting module' }),
  surfaceTask({ id: 't2', order: 2, title: 'Add a farewell module' }),
], 'approved');
const LANDED: IsolationHandoff = {
  repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: '4f2a91c0ffee0000', baseBranch: 'main', landed: [] }],
  landed: [{ taskId: 't1', order: 1, title: 'Add a greeting module' }],
};

let offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs) off();
  offs = [];
  resetDaemonHosts();
  resetTaskViews();
});

/** A stopped run with #1 done and #2 still to do, and whatever has landed from it. */
async function mount(handoff: IsolationHandoff | null) {
  const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan: PLAN, goal: 'Greet and say goodbye' }) });
  const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
  offs.push(registerFrameCommands(store), registerViews(store.api));
  const host = daemonHost(WORKSPACE);
  render(<FrameProvider value={store}><Frame daemon={CONNECTED} /></FrameProvider>);
  await act(() => host.open('s1'));
  const tasks = [
    runTask({ id: 't1', order: 1, title: 'Add a greeting module', status: 'completed' }),
    runTask({ id: 't2', order: 2, title: 'Add a farewell module', status: 'pending' }),
  ];
  await act(async () => {
    daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: { tasks, runMerge: null, handoff, mergeResult: null }, stream: 'd1', seq: 0 });
  });
  return { daemon, store };
}

const title = () => within(screen.getByRole('banner'));
function moreActions(): string[] {
  fireEvent.click(title().getByRole('button', { name: 'More actions' }));
  const items = within(screen.getByRole('menu', { name: 'More actions' })).getAllByRole('menuitem').map((item) => item.textContent ?? '');
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  return items;
}
const enabled = (store: FrameStore) => store.enabledCommands().map((command) => command.id);

describe('the title bar while the daemon is away (W15)', () => {
  it('keeps the primary in its place but disabled, and offers none of the session\'s actions', async () => {
    const { daemon, store } = await mount(LANDED);
    expect(title().getByRole('button', { name: 'Run' })).toBeEnabled();
    expect(moreActions()).toEqual(expect.arrayContaining(['Review & Merge all', 'Discard run', 'Reset layout']));

    act(() => daemon.setStatus({ state: 'reconnecting', port: 3700, attempt: 1, canStart: false }));
    expect(store.getSnapshot().readOnly).toBe(true);
    expect(title().getByRole('button', { name: 'Run' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true });
    expect(daemon.calls('plans.execute')).toEqual([]);
    const items = moreActions();
    expect(items).toContain('Reset layout');
    expect(items).not.toContain('Review & Merge all');
    expect(items).not.toContain('Discard run');
    const sessions = ['primary.run', 'plan.run', 'plan.mergeAll', 'plan.discardRun', 'changes.mergeAll'];
    expect(enabled(store).filter((id) => sessions.includes(id))).toEqual([]);
    expect(enabled(store)).toContain('layout.reset');

    act(() => daemon.setStatus(CONNECTED));
    expect(title().getByRole('button', { name: 'Run' })).toBeEnabled();
  });
});

describe('Merge all (design.md, W13)', () => {
  it('is not offered while nothing has landed', async () => {
    const { store } = await mount(null);
    expect(moreActions().some((item) => /Merge all/.test(item))).toBe(false);
    expect(enabled(store)).not.toContain('changes.mergeAll');
  });

  it('is offered once a task has landed, by the plan in the ⋯ menu and by the palette', async () => {
    const { store } = await mount(LANDED);
    const items = moreActions();
    expect(items.filter((item) => /Merge all/.test(item))).toEqual(['Review & Merge all']);
    expect(enabled(store)).toContain('changes.mergeAll');
  });
});
