import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_GRAPH_TAB } from '../../../frame/api';
import { registerFrameCommands } from '../../../frame/commands';
import { Frame } from '../../../frame/Frame';
import { FrameProvider, FrameStore } from '../../../frame/store';
import { daemonHost, resetDaemonHosts } from '../../../session/DaemonHost';
import { selectedTask } from '../../../session/selection';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';
import { registerViews } from '../../index';
import { resetTaskViews } from '../../task/taskView';

// Monaco needs a browser; these views never open a file.
vi.mock('../../../monaco', async () => (await import('../../../test/monacoMock')).fakeMonacoModule());

beforeAll(() => {
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { ResizeObserver: Observer });
  Object.assign(globalThis, { DOMMatrixReadOnly: class { m22 = 1; constructor(public transform?: string) {} } });
});

const WORKSPACE = '/work/acme';
const PLAN = surfacePlan([
  surfaceTask({ id: 't1', order: 1, title: 'Read the auth module' }),
  surfaceTask({ id: 't2', order: 2, title: 'Add SAML callback route', dependencies: ['t1'] }),
], 'running');

let offs: Array<() => void> = [];
let scrolled: HTMLElement[] = [];
beforeEach(() => {
  scrolled = [];
  // jsdom lays nothing out, so it has no scrollIntoView; the reveal's scroll is what the test reads.
  Element.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) { scrolled.push(this); };
});
afterEach(() => {
  for (const off of offs) off();
  offs = [];
  resetDaemonHosts();
  resetTaskViews();
});

async function mount(): Promise<FrameStore> {
  const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan: PLAN, goal: 'Add SSO login' }) });
  const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
  offs.push(registerFrameCommands(store), registerViews(store.api));
  const host = daemonHost(WORKSPACE);
  render(<FrameProvider value={store}><Frame daemon={{ state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } }} /></FrameProvider>);
  await act(() => host.open('s1'));
  await act(async () => {
    daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: { tasks: PLAN.tasks, runMerge: null, handoff: null, mergeResult: null }, stream: 'd1', seq: 0 });
  });
  return store;
}

const tabs = (store: FrameStore) => store.getSnapshot().layout.groups.flatMap((group) => group.tabs);
const graphNode = async (name: RegExp) => (await screen.findAllByRole('button', { name })).find((b) => b.classList.contains('graph-card-face'))!;
const listRow = (name: RegExp) => screen.queryAllByRole('button', { name }).find((b) => b.classList.contains('task-heading'));

async function clickInGraph(store: FrameStore): Promise<void> {
  act(() => store.api.openTab(PLAN_GRAPH_TAB));
  const before = tabs(store).length;
  fireEvent.click(await graphNode(/^#2 Add SAML callback route, /));
  expect(selectedTask(daemonHost(WORKSPACE))).toBe('t2');
  await waitFor(() => expect(listRow(/^#2 Add SAML callback route, /)).toHaveAttribute('aria-expanded', 'true'));
  await waitFor(() => expect(scrolled.map((el) => el.dataset.taskId)).toContain('t2'));
  // Only the card's Open chat opens a tab: the click opened none.
  expect(tabs(store)).toHaveLength(before);
  expect(tabs(store).some((tab) => tab.kind === 'task')).toBe(false);
}

describe('a task revealed from the graph', () => {
  it('docks the closed plan panel, opens its card there and scrolls to it', async () => {
    const store = await mount();
    act(() => store.dispatch({ type: 'togglePlan', open: false }));
    expect(listRow(/^#2 Add SAML callback route, /)).toBeUndefined();

    await clickInGraph(store);
    const { layout } = store.getSnapshot();
    expect(layout.planOpen).toBe(true);
    expect(layout.drawer).toBeUndefined();
    expect(listRow(/^#1 Read the auth module, /)).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the plan drawer when the window is too narrow to dock it', async () => {
    const store = await mount();
    act(() => store.dispatch({ type: 'viewport', viewport: { width: 760, height: 700 } }));
    expect(store.getSnapshot().layout.squeezed.plan).toBe(true);

    await clickInGraph(store);
    expect(store.getSnapshot().layout.drawer).toBe('plan');
  });
});
