import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FrameApi } from '../../../frame/api';
import { DaemonHost } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';
import { selectedTask, selectTask } from '../../../session/selection';
import { PlanGraph } from '../PlanGraph';

// jsdom draws no layout: React Flow measures with these, so they say "no size" and the nodes' own width and height stand.
beforeAll(() => {
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { ResizeObserver: Observer });
  Object.assign(globalThis, {
    DOMMatrixReadOnly: class { m22 = 1; constructor(public transform?: string) {} },
  });
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

  it('selects on click and opens the task as a preview tab, which the List then shows', async () => {
    const { host } = await openedHost();
    const api = frameApi();
    render(<PlanGraph host={host} api={api} onCannotDraw={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^#3 / }));

    expect(selectedTask(host)).toBe('c');
    expect(api.openTab).toHaveBeenCalledWith(expect.objectContaining({ kind: 'task', id: 'c' }), { preview: true });
  });

  it('opens the task with Enter and moves along the edges with the arrow keys', async () => {
    const { host } = await openedHost();
    render(<PlanGraph host={host} api={frameApi()} onCannotDraw={vi.fn()} />);
    const open = vi.spyOn(host, 'openTask');

    fireEvent.keyDown(await screen.findByRole('button', { name: /^#1 / }), { key: 'ArrowRight' });
    expect([face(/^#2 /), face(/^#3 /)]).toContain(document.activeElement);

    fireEvent.keyDown(face(/^#1 /), { key: 'Enter' });
    expect(open).toHaveBeenCalledWith('a', 'details');
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
