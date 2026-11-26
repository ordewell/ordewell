import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FrameApi } from '../../../frame/api';
import { DaemonHost } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';
import { selectedTask } from '../../../session/selection';
import { PlanList } from '../PlanList';
import { PlanGraphTab, planProgress } from '../PlanTab';

beforeAll(() => {
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { ResizeObserver: Observer });
  Object.assign(globalThis, { DOMMatrixReadOnly: class { m22 = 1; constructor(public transform?: string) {} } });
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

let hosts: DaemonHost[] = [];
afterEach(() => { for (const host of hosts) host.dispose(); hosts = []; });

function frameApi() {
  const unregister = vi.fn();
  const api = { openTab: vi.fn(), announce: vi.fn(), showBanner: vi.fn(() => unregister) } as unknown as FrameApi;
  return { api, unregister };
}

async function openedHost(tasks: Parameters<typeof surfacePlan>[0]) {
  const plan = surfacePlan(tasks);
  const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan, goal: 'Ship the parser' }) });
  const host = new DaemonHost('/work/acme');
  hosts.push(host);
  await act(() => host.open('s1'));
  await act(async () => {
    daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: { tasks: plan.tasks, runMerge: null, handoff: null, mergeResult: null }, stream: 'd1', seq: 0 });
  });
  return host;
}

const TASKS = [
  surfaceTask({ id: 'a', order: 1, title: 'Read the spec' }),
  surfaceTask({ id: 'b', order: 2, title: 'Parse the config', dependencies: ['a'] }),
];

describe('the plan graph tab', () => {
  it('shares one selection with the plan panel\'s list', async () => {
    const host = await openedHost(TASKS);
    const { api } = frameApi();
    render(<><PlanList host={host} /><PlanGraphTab host={host} api={api} /></>);

    // The graph's node and the list's row share one name; the node is the one with a menu.
    const node = async (name: RegExp) => (await screen.findAllByRole('button', { name })).find((b) => b.classList.contains('graph-card-face'))!;
    const row = (name: RegExp) => screen.getAllByRole('button', { name }).find((b) => b.classList.contains('task-heading'))!;

    // The graph's click selects, and the list's open card is that task.
    fireEvent.click(await node(/^#2 Parse the config, /));
    expect(selectedTask(host)).toBe('b');
    expect(await node(/^#2 Parse the config, /)).toHaveAttribute('aria-current', 'true');
    await waitFor(() => expect(row(/^#2 Parse the config, /)).toHaveAttribute('aria-expanded', 'true'));

    fireEvent.click(row(/^#1 Read the spec, /));
    expect(selectedTask(host)).toBe('a');
    expect(await node(/^#1 Read the spec, /)).toHaveAttribute('aria-current', 'true');
  });

  it('puts up a banner when the plan has a dependency loop, and takes it down after', async () => {
    const host = await openedHost([
      surfaceTask({ id: 'a', order: 1, title: 'One', dependencies: ['b'] }),
      surfaceTask({ id: 'b', order: 2, title: 'Two', dependencies: ['a'] }),
    ]);
    const { api, unregister } = frameApi();
    const { unmount } = render(<PlanGraphTab host={host} api={api} />);

    await vi.waitFor(() => expect(api.showBanner).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan.graph.cycle', tone: 'warning' })));
    unmount();
    expect(unregister).toHaveBeenCalled();
  });
});

describe('planProgress', () => {
  it('counts each task by its status, settled ones as done', async () => {
    const host = await openedHost([
      surfaceTask({ id: 'a', order: 1, title: 'One', status: 'completed' }),
      surfaceTask({ id: 'b', order: 2, title: 'Two', status: 'failed' }),
      surfaceTask({ id: 'c', order: 3, title: 'Three' }),
    ]);
    expect(planProgress(host)).toEqual({ done: 1, total: 3, counts: { passed: 1, failed: 1, 'not-started': 1 } });
  });

  it('shows the live running status on a retried task', async () => {
    const plan = surfacePlan([surfaceTask({ id: 'a', order: 1, title: 'Retry me', status: 'failed' })]);
    const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan, goal: 'Ship' }) });
    const host = new DaemonHost('/work/acme');
    hosts.push(host);
    await act(() => host.open('s1'));
    await act(async () => daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: { tasks: plan.tasks, runMerge: null, handoff: null, mergeResult: null }, stream: 'd1', seq: 0 }));
    const { container } = render(<PlanList host={host} />);
    await act(async () => daemon.push('s1', { type: 'task_started', taskId: 'a', order: 1, title: 'Retry me', runner: 'claude-code', stream: 'd1', seq: 1 }));
    expect(planProgress(host)?.counts.running).toBe(1);
    expect(container.querySelector('[data-task-id="a"] [data-status="running"]')).not.toBeNull();
  });

  it('exposes a running child of a collapsed parent to the running filter', async () => {
    const host = await openedHost([surfaceTask({ id: 'parent', order: 1, title: 'Parent', subtasks: [
      surfaceTask({ id: 'child', order: 1, title: 'Child', status: 'in_progress' }),
    ] })]);
    const { container } = render(<div className="frame-plan" data-filter="running"><PlanList host={host} /></div>);
    expect(planProgress(host)?.counts.running).toBe(1);
    expect(container.querySelector('[data-task-id="parent"] [data-status="running"]')).not.toBeNull();
  });

  it('exposes a nested task that becomes running mid-run, reading the run not the plan', async () => {
    const plan = surfacePlan([surfaceTask({ id: 'parent', order: 1, title: 'Parent', subtasks: [
      surfaceTask({ id: 'child', order: 1, title: 'Child' }),
    ] })]);
    const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan, goal: 'Ship' }) });
    const host = new DaemonHost('/work/acme');
    hosts.push(host);
    await act(() => host.open('s1'));
    await act(async () => daemon.push('s1', { type: 'connected', sessionId: 's1' }, { type: 'run_snapshot', sessionId: 's1', view: { tasks: plan.tasks, runMerge: null, handoff: null, mergeResult: null }, stream: 'd1', seq: 0 }));
    const { container } = render(<div className="frame-plan" data-filter="running"><PlanList host={host} /></div>);
    expect(planProgress(host)?.counts.running ?? 0).toBe(0);
    // task_started moves the nested run entry but not the plan: the subtask card
    // must read the run's status so a started child is still exposed to :has().
    await act(async () => daemon.push('s1', { type: 'task_started', taskId: 'child', order: 1, title: 'Child', runner: 'claude-code', stream: 'd1', seq: 1 }));
    expect(planProgress(host)?.counts.running).toBe(1);
    expect(container.querySelector('[data-task-id="parent"] [data-status="running"]')).not.toBeNull();
  });

  it('keeps each nested status identifiable under the filter', async () => {
    const host = await openedHost([
      surfaceTask({ id: 'p', order: 1, title: 'Parent', status: 'in_progress', subtasks: [
        surfaceTask({ id: 'c1', order: 1, title: 'Running child', status: 'in_progress' }),
        surfaceTask({ id: 'c2', order: 2, title: 'Failed child', status: 'failed' }),
        surfaceTask({ id: 'c3', order: 3, title: 'Pending child' }),
      ] }),
    ]);
    const { container } = render(<div className="frame-plan" data-filter="running"><PlanList host={host} /></div>);
    expect(planProgress(host)?.counts.running).toBe(2);
    const parent = container.querySelector('[data-task-id="p"]')!;
    expect(parent.querySelectorAll('.task-row-subtasks-folded [data-status="running"]')).toHaveLength(1);
    expect(parent.querySelector('.task-row-subtasks-folded [data-status="failed"]')).not.toBeNull();
    expect(parent.querySelector('.task-row-subtasks-folded [data-status="not-started"]')).not.toBeNull();
  });

  it('keeps normal collapse with no filter and holds the child for the filter to reveal', async () => {
    const host = await openedHost([surfaceTask({ id: 'parent', order: 1, title: 'Parent', subtasks: [
      surfaceTask({ id: 'child', order: 1, title: 'Child', status: 'in_progress' }),
    ] })]);
    const view = (filter?: string) => <div className="frame-plan" data-filter={filter}><PlanList host={host} /></div>;
    const { container, rerender } = render(view());
    const parent = () => container.querySelector('[data-task-id="parent"]')!;
    // Unfiltered, a collapsed row still shows only its three lines: no open
    // card body. Its descendants sit in the folded block frame.css hides.
    expect(parent().querySelector('.task-card-body')).toBeNull();
    expect(parent().querySelector('.task-row-subtasks-folded [data-status="running"]')).not.toBeNull();
    // A rail count opens the plan with the filter set: that same block is what
    // :has() keeps the card for, and CSS now reveals it to the user.
    rerender(view('running'));
    expect(planProgress(host)?.counts.running).toBe(1);
    expect(parent().querySelector('.task-row-subtasks-folded [data-status="running"]')).not.toBeNull();
  });

  it('has nothing to say before there is a plan', () => {
    const host = new DaemonHost('/work/empty');
    hosts.push(host);
    expect(planProgress(host)).toBeUndefined();
  });
});
