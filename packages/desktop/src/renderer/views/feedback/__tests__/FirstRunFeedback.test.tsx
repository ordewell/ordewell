import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExecutionSummary } from '@ordewell/core';
import { registerFrameCommands } from '../../../frame/commands';
import { Frame } from '../../../frame/Frame';
import { FrameProvider, FrameStore } from '../../../frame/store';
import { daemonHost, resetDaemonHosts } from '../../../session/DaemonHost';
import { fakeDaemon, ok, surfacePlan, surfaceTask } from '../../../session/__tests__/fakeDaemon';
import { registerViews } from '../../index';
import { resetTaskViews } from '../../task/taskView';

vi.mock('../../../monaco', async () => (await import('../../../test/monacoMock')).fakeMonacoModule());

beforeAll(() => {
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, { ResizeObserver: Observer });
  Element.prototype.scrollIntoView = () => {};
});

const WORKSPACE = '/work/acme';
const CONNECTED = { state: 'connected', port: 3700, owned: true, daemon: { version: '0.12.3', contract: 1 } } as const;
const PLAN = surfacePlan([
  surfaceTask({ id: 't1', order: 1, title: 'Add a greeting module', status: 'completed' }),
  surfaceTask({ id: 't2', order: 2, title: 'Add a farewell module', status: 'completed' }),
], 'approved');
const PASSED: ExecutionSummary = { total: 2, completed: 2, failed: 0, blocked: 0, skipped: 0 };

const TITLE = 'How did it go?';
const BODY = 'Ordewell is open source and built in the open, and feedback from a first run is what it needs most.';

let offs: Array<() => void> = [];
afterEach(() => {
  for (const off of offs) off();
  offs = [];
  resetDaemonHosts();
  resetTaskViews();
});

/**
 * A window on session s1, with main's side of the bridge: `claim` stands for
 * core's machine-wide record, owed once and then never again.
 */
async function mount() {
  const daemon = fakeDaemon({ 'sessions.load': ok({ ok: true, plan: PLAN, goal: 'Greet and say goodbye' }) });
  let owed = true;
  const claim = vi.fn(async (_summary: ExecutionSummary) => {
    const shown = owed;
    owed = false;
    return shown;
  });
  const openExternal = vi.fn(async () => ({ ok: true }));
  Object.assign(window.ordewell, {
    feedback: { claim },
    shell: { openExternal, openInEditor: vi.fn(), reveal: vi.fn() },
  });
  const store = new FrameStore({ workspace: WORKSPACE, platform: 'linux' });
  offs.push(registerFrameCommands(store), registerViews(store.api));
  const host = daemonHost(WORKSPACE);
  render(<FrameProvider value={store}><Frame daemon={CONNECTED} /></FrameProvider>);
  await act(() => host.open('s1'));
  let seq = 0;
  const hear = async (frame: Record<string, unknown>): Promise<void> => {
    await act(async () => { daemon.push('s1', { ...frame, stream: 'd1', seq: ++seq }); });
  };
  await act(async () => { daemon.push('s1', { type: 'connected', sessionId: 's1' }); });
  return { claim, openExternal, hear };
}

const banner = (): Promise<HTMLElement> => screen.findByRole('region', { name: TITLE });

describe('the first-run feedback notice in the desktop app (ADR-0075)', () => {
  it('is a banner once a run\'s end stands with every task passed, with its two actions and a dismiss', async () => {
    const { claim, hear } = await mount();
    await hear({ type: 'run_concluded', summary: PASSED });
    const shown = await banner();
    expect(claim).toHaveBeenCalledWith(PASSED);
    expect(shown).toHaveTextContent(BODY);
    expect(within(shown).getAllByRole('button').map((b) => b.textContent)).toEqual(['Tell us how it went', 'Star on GitHub', 'Dismiss']);
  });

  it.each<[string, string]>([
    ['Tell us how it went', 'https://github.com/ordewell/ordewell/discussions/115'],
    ['Star on GitHub', 'https://github.com/ordewell/ordewell'],
  ])('opens a browser only when %s is pressed, and closes', async (label, url) => {
    const { openExternal, hear } = await mount();
    await hear({ type: 'run_concluded', summary: PASSED });
    const shown = await banner();
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(within(shown).getByRole('button', { name: label }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(url));
    expect(openExternal).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('region', { name: TITLE })).toBeNull());
  });

  it('closes on Dismiss, opening nothing', async () => {
    const { openExternal, hear } = await mount();
    await hear({ type: 'run_concluded', summary: PASSED });
    fireEvent.click(within(await banner()).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: TITLE })).toBeNull());
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('takes no focus from what the person is doing', async () => {
    const { hear } = await mount();
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    elsewhere.focus();
    await hear({ type: 'run_concluded', summary: PASSED });
    await banner();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it.each<[string, ExecutionSummary]>([
    ['a task failed', { total: 2, completed: 1, failed: 1, blocked: 0, skipped: 0 }],
    ['a failure blocked the rest', { total: 2, completed: 0, failed: 1, blocked: 1, skipped: 0 }],
    ['a task was skipped', { total: 2, completed: 1, failed: 0, blocked: 0, skipped: 1 }],
  ])('is not shown, and main is not asked, when %s', async (_, summary) => {
    const { claim, hear } = await mount();
    await hear({ type: 'run_concluded', summary });
    expect(claim).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: TITLE })).toBeNull();
  });

  it('waits for the end to stand: a closing turn after the first end may still continue the run', async () => {
    const { claim, hear } = await mount();
    await hear({ type: 'execution_complete', summary: PASSED });
    expect(claim).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: TITLE })).toBeNull();
  });

  it('is not shown again at the next passed run, once main says the machine has had it', async () => {
    const { claim, hear } = await mount();
    await hear({ type: 'run_concluded', summary: PASSED });
    fireEvent.click(within(await banner()).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: TITLE })).toBeNull());
    await hear({ type: 'run_concluded', summary: PASSED });
    await waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('region', { name: TITLE })).toBeNull();
  });
});
