import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FrameApi } from '../../../frame/api';
import { DaemonHost } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';
import { selectedTask, selectTask } from '../../../session/selection';
import { runTask as changesRunTask, runView, worktree } from '../../changes/__tests__/fixtures';
import { PlanGraph } from '../PlanGraph';

// jsdom has no ResizeObserver or matchMedia; it measures every card at zero, so no edge is drawn and the cards and keys stand alone.
beforeAll(() => {
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { ResizeObserver: Observer });
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

const PLAN = surfacePlan([
  surfaceTask({ id: 'a', order: 1, title: 'Read the spec', status: 'completed' }),
  surfaceTask({ id: 'b', order: 2, title: 'Parse the config', dependencies: ['a'] }),
  surfaceTask({ id: 'c', order: 3, title: 'Write the docs', dependencies: ['a'] }),
]);

let hosts: DaemonHost[] = [];
afterEach(() => {
  for (const host of hosts) host.dispose();
  hosts = [];
});

function frameApi(): FrameApi {
  return {
    openTab: vi.fn(),
    announce: vi.fn(),
    showBanner: vi.fn(() => () => undefined),
    registerCommand: vi.fn(() => () => undefined),
    setPrimaryAction: vi.fn(),
  } as unknown as FrameApi;
}

async function openedHost(plan = PLAN) {
  const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan, goal: 'Ship the parser' }) });
  const host = new DaemonHost('/work/acme');
  hosts.push(host);
  await act(() => host.open('s1'));
  await act(async () => { daemon.push('s1', { type: 'connected', sessionId: 's1' }); });
  return { host, daemon };
}

const face = (name: RegExp) => screen.getByRole('button', { name });

describe('PlanGraph', () => {
  it('draws a node for each task, named by order, title and status', async () => {
    const { host } = await openedHost();
    render(<PlanGraph host={host} api={frameApi()} onCannotDraw={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /^#1 Read the spec, / })).toBeInTheDocument();
    expect(face(/^#2 Parse the config, /)).toBeInTheDocument();
    expect(face(/^#3 Write the docs, /)).toBeInTheDocument();
  });

  it('marks the node the List selected, and moves the mark when the selection moves', async () => {
    const { host } = await openedHost();
    render(<PlanGraph host={host} api={frameApi()} onCannotDraw={vi.fn()} />);
    await screen.findByRole('button', { name: /^#2 / });
    expect(document.querySelector('[aria-current="true"]')).toBeNull();

    act(() => selectTask(host, 'b'));
    expect(face(/^#2 /)).toHaveAttribute('aria-current', 'true');

    act(() => selectTask(host, 'c'));
    expect(face(/^#2 /)).not.toHaveAttribute('aria-current');
    expect(face(/^#3 /)).toHaveAttribute('aria-current', 'true');
  });

  it('selects on click and shows the task in the plan panel, opening no tab', async () => {
    const { host } = await openedHost();
    const api = frameApi();
    const navigator = { openTask: vi.fn(), openFile: vi.fn(), showPlan: vi.fn() };
    host.setNavigator(navigator);
    render(<PlanGraph host={host} api={api} onCannotDraw={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^#3 / }));

    expect(selectedTask(host)).toBe('c');
    expect(navigator.showPlan).toHaveBeenCalledTimes(1);
    expect(api.openTab).not.toHaveBeenCalled();
    expect(navigator.openTask).not.toHaveBeenCalled();
  });

  it('shows the task with Enter and follows the one edge there is with an arrow key', async () => {
    const { host } = await openedHost();
    render(<PlanGraph host={host} api={frameApi()} onCannotDraw={vi.fn()} />);
    const reveal = vi.spyOn(host, 'revealTask');
    const open = vi.spyOn(host, 'openTask');

    fireEvent.keyDown(await screen.findByRole('button', { name: /^#2 / }), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(face(/^#1 /));
    fireEvent.keyDown(face(/^#2 /), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(face(/^#3 /));

    fireEvent.keyDown(face(/^#1 /), { key: 'Enter' });
    expect(reveal).toHaveBeenCalledWith('a');
    expect(selectedTask(host)).toBe('a');
    expect(open).not.toHaveBeenCalled();
  });

  it('asks which dependent to go to when there are several, then goes there', async () => {
    const { host } = await openedHost();
    render(<PlanGraph host={host} api={frameApi()} onCannotDraw={vi.fn()} />);

    fireEvent.keyDown(await screen.findByRole('button', { name: /^#1 / }), { key: 'ArrowRight' });
    const menu = await screen.findByRole('menu', { name: 'Dependents of #1' });
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('Parse the config'), expect.stringContaining('Write the docs'),
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: /Write the docs/ }));
    expect(menu).not.toBeInTheDocument();
    expect(document.activeElement).toBe(face(/^#3 /));
  });

  it('opens a task on Chat from its card', async () => {
    const plan = surfacePlan([
      surfaceTask({ id: 'r', order: 1, title: 'Running', type: 'ai', assignedRunner: 'claude-code', status: 'in_progress', attempted: true }),
    ]);
    const { host } = await openedHost(plan);
    const open = vi.spyOn(host, 'openTask');
    render(<PlanGraph host={host} api={frameApi()} onCannotDraw={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open chat for #1 Running' }));
    expect(open).toHaveBeenCalledWith('r', 'chat');
  });

  it('draws a column per stage and steps between them from the strip', async () => {
    const { host } = await openedHost();
    render(<PlanGraph host={host} api={frameApi()} onCannotDraw={vi.fn()} />);
    await screen.findByRole('button', { name: /^#1 / });
    expect(screen.getAllByRole('row').map((r) => r.getAttribute('aria-label'))).toEqual(['Stage 1', 'Stage 2']);
    expect(screen.getByRole('button', { name: /^Stage 2, .*0 of 2 done/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous stage' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next stage' })).toBeInTheDocument();
  });

  it('offers Stop, Retry and Skip where each applies, by the same host messages the List posts', async () => {
    const plan = surfacePlan([
      surfaceTask({ id: 'f', order: 1, title: 'Broken', type: 'ai', assignedRunner: 'claude-code', status: 'failed' }),
    ]);
    const { host } = await openedHost(plan);
    const handle = vi.spyOn(host, 'handle');
    render(<PlanGraph host={host} api={frameApi()} onCannotDraw={vi.fn()} />);

    fireEvent.keyDown(await screen.findByRole('button', { name: /^#1 / }), { key: 'ContextMenu' });
    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /Retry/ }));
    expect(handle).toHaveBeenCalledWith({ type: 'sendSystemCommand', command: 'retry', taskId: 'f' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens a task\'s whole change on its tab\'s Changes view from Open diff', async () => {
    const plan = surfacePlan([surfaceTask({ id: 'w', order: 1, title: 'Isolated', type: 'ai', assignedRunner: 'claude-code', status: 'completed' })]);
    const { host, daemon } = await openedHost(plan);
    const isolated = changesRunTask({ id: 'w', order: 1, title: 'Isolated', status: 'completed', isolation: worktree('integrated') });
    await act(async () => { daemon.push('s1', { type: 'run_snapshot', sessionId: 's1', view: runView([isolated]), stream: 'd1', seq: 0 }); });
    const open = vi.spyOn(host, 'openTask');
    const api = frameApi();
    render(<PlanGraph host={host} api={api} onCannotDraw={vi.fn()} />);

    fireEvent.keyDown(await screen.findByRole('button', { name: /^#1 / }), { key: 'ContextMenu' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Open diff/ }));
    expect(open).toHaveBeenCalledWith('w', 'changes');
    expect(api.openTab).not.toHaveBeenCalled();
    expect(selectedTask(host)).toBe('w');
  });

  it('shows no peek for a card the pointer left before the delay, across a render in between', async () => {
    const { host } = await openedHost();
    render(<PlanGraph host={host} api={frameApi()} onCannotDraw={vi.fn()} />);
    const card = (await screen.findByRole('button', { name: /^#2 / })).closest('.graph-card');
    if (!card) throw new Error('no card');
    vi.useFakeTimers();
    try {
      fireEvent.mouseEnter(card);
      act(() => selectTask(host, 'c'));
      fireEvent.mouseLeave(card);
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says a loop of dependencies cannot be drawn instead of drawing it', async () => {
    const plan = surfacePlan([
      surfaceTask({ id: 'a', order: 1, title: 'One', dependencies: ['b'] }),
      surfaceTask({ id: 'b', order: 2, title: 'Two', dependencies: ['a'] }),
    ]);
    const { host } = await openedHost(plan);
    const onCannotDraw = vi.fn();
    render(<PlanGraph host={host} api={frameApi()} onCannotDraw={onCannotDraw} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/depend on each other/);
    expect(onCannotDraw).toHaveBeenCalledWith(expect.stringContaining('#1, #2'));
  });
});
