import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FrameApi } from '../../../frame/api';
import { DaemonHost } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';
import { selectedTask } from '../../../session/selection';
import { PlanTab } from '../PlanTab';

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

describe('PlanTab', () => {
  it('shares one selection between the List and the Graph', async () => {
    const host = await openedHost(TASKS);
    const { api } = frameApi();
    render(<PlanTab host={host} api={api} />);

    // The graph's click selects; switching to the List keeps it, and the List's open card is that task.
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    fireEvent.click(await screen.findByRole('button', { name: /^#2 Parse the config, / }));
    expect(selectedTask(host)).toBe('b');

    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(await screen.findByText('Parse the config')).toBeInTheDocument();
    expect(selectedTask(host)).toBe('b');

    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    expect(await screen.findByRole('button', { name: /^#2 Parse the config, / })).toHaveAttribute('aria-current', 'true');
  });

  it('shows in the Graph the card the List opened', async () => {
    const host = await openedHost(TASKS);
    render(<PlanTab host={host} api={frameApi().api} />);

    fireEvent.click(await screen.findByText('Read the spec'));
    expect(selectedTask(host)).toBe('a');

    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    expect(await screen.findByRole('button', { name: /^#1 Read the spec, / })).toHaveAttribute('aria-current', 'true');
  });

  it('switches views with V, but not while typing', async () => {
    const host = await openedHost(TASKS);
    render(<PlanTab host={host} api={frameApi().api} />);
    const group = screen.getByRole('group', { name: 'Plan view' });

    fireEvent.keyDown(group, { key: 'v' });
    expect(screen.getByRole('button', { name: 'Graph' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(group, { key: 'v', metaKey: true });
    expect(screen.getByRole('button', { name: 'Graph' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(group, { key: 'v' });
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('falls back to the List with a banner when the plan has a dependency loop, and takes the banner down after', async () => {
    const host = await openedHost([
      surfaceTask({ id: 'a', order: 1, title: 'One', dependencies: ['b'] }),
      surfaceTask({ id: 'b', order: 2, title: 'Two', dependencies: ['a'] }),
    ]);
    const { api, unregister } = frameApi();
    const { unmount } = render(<PlanTab host={host} api={api} />);

    fireEvent.click(screen.getByRole('button', { name: 'Graph' }));
    await screen.findByRole('button', { name: 'List' });
    expect(api.showBanner).toHaveBeenCalledWith(expect.objectContaining({ id: 'plan.graph.cycle', tone: 'warning' }));
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');

    unmount();
    expect(unregister).toHaveBeenCalled();
  });
});
