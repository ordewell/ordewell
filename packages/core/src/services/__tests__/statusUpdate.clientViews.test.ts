import { afterEach, describe, it, expect, vi } from 'vitest';
import { makeSession, FakeRunnerSession } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { RunView, SessionMessage } from '../SessionMessage';
import { reduceRun } from '../runView';

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now, runSettings: { mergeAtGatesAutomatically: false } };
}

/** A surface folding the stream: it joins with a run snapshot, and a gap in what it heard sends it to read one again, as a stamped stream does. */
interface Client { view: RunView | null; deaf: boolean }

function setup() {
  const runners: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async (spawn: { taskId: string }) => {
      const r = new FakeRunnerSession(`s${runners.length + 1}`, spawn.taskId);
      runners.push(r);
      return r;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const clients: Client[] = [];
  const statusUpdates: Extract<SessionMessage, { type: 'status_update' }>[] = [];
  const session = makeSession({
    runner,
    isolation: new FakeWorktreeIsolation(),
    broadcast: (m) => {
      if (m.type === 'status_update') statusUpdates.push(m);
      for (const c of clients) if (c.view && !c.deaf) c.view = reduceRun(c.view, m);
    },
  });
  const join = (): Client => {
    const c: Client = { view: session.runSnapshot(), deaf: false };
    clients.push(c);
    return c;
  };
  const latest = (taskId: string) => [...runners].reverse().find((r) => r.taskId === taskId)!;
  const status = (id: string) => session.runSnapshot().tasks.find((t) => t.id === id)?.status;
  // Every client holds what a surface reading the run whole now would: the throttled update may be up to a second behind.
  const agree = () => vi.waitFor(() => {
    const whole = session.runSnapshot();
    for (const c of clients) expect(c.view).toEqual(whole);
  });
  return { session, clients, join, latest, status, agree, statusUpdates };
}

describe('a status update carries what moved', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('leaves every client folding the same run as one that read it whole, through starts, usage, settling, a retry, an edit, a late join and a gap', async () => {
    const env = setup();
    env.session.loadPlan(plan([
      task('t1', 1),
      task('t2', 2, { dependencies: ['t1'] }),
      task('t3', 3),
      task('t4', 4, { dependencies: ['t2'] }),
    ]), 'goal', '/repo', { persist: false });
    const early = env.join();
    const gapped = env.join();

    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect([env.status('t1'), env.status('t3')]).toEqual(['in_progress', 'in_progress']));
    for (let i = 0; i < 3; i++) {
      env.latest('t1').emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: 10 } });
      env.latest('t3').emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: 5 } });
    }
    await env.agree();
    expect(early.view?.tasks.find((t) => t.id === 't1')?.attemptUsage?.[0].totals.inputTokens).toBe(30);

    const late = env.join();
    gapped.deaf = true;
    env.latest('t1').reportComplete({ status: 'done', summary: 'One is done.' });
    env.latest('t3').reportComplete({ status: 'blocked', summary: '', reason: 'no registry' });
    await vi.waitFor(() => expect([env.status('t1'), env.status('t3')]).toEqual(['completed', 'failed']));
    // What it missed, it reads whole again.
    gapped.view = env.session.runSnapshot();
    gapped.deaf = false;
    await env.agree();
    expect(late.view?.tasks.find((t) => t.id === 't1')).toMatchObject({ status: 'completed', handoff: { summary: 'One is done.' }, verdict: { outcome: 'pass' } });
    expect(late.view?.tasks.find((t) => t.id === 't3')).toMatchObject({ status: 'failed', verdict: { outcome: 'fail' } });

    await env.session.execute({ command: 'retry_task', task: 't3', from: 'fresh' }, { kind: 'user' });
    await vi.waitFor(() => expect(env.status('t3')).toBe('in_progress'));
    env.latest('t3').emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: 7 } });
    await env.session.updateTask('t4', { title: 'Four, renamed' });
    await env.agree();
    expect(early.view?.tasks.find((t) => t.id === 't3')?.attemptUsage?.map((u) => u.totals.inputTokens)).toEqual([15, 7]);
    expect(early.view?.tasks.find((t) => t.id === 't4')?.title).toBe('Four, renamed');

    // Past the half minute a status update says the unsettled tasks again.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 31_000 });
    env.latest('t2').emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: 3 } });
    await env.agree();
    // And past a minute more, no settled task that has not moved since.
    vi.setSystemTime(Date.now() + 70_000);
    env.latest('t2').emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: 3 } });
    await env.agree();
    expect(env.statusUpdates.at(-1)?.tasks.map((t) => t.id)).toEqual(['t2', 't3', 't4']);
    env.latest('t3').reportComplete({ status: 'done', summary: 'Three, at last.' });
    await vi.waitFor(() => expect(env.status('t3')).toBe('completed'));
    env.latest('t2').reportComplete({ status: 'done', summary: 'Two.' });
    await vi.waitFor(() => expect(env.status('t4')).toBe('in_progress'));
    env.latest('t4').reportComplete({ status: 'done', summary: 'Four.' });
    await vi.waitFor(() => expect(env.status('t4')).toBe('completed'));
    await env.agree();
    expect(early.view?.tasks.map((t) => [t.id, t.status, t.handoff?.summary])).toEqual([
      ['t1', 'completed', 'One is done.'],
      ['t2', 'completed', 'Two.'],
      ['t3', 'completed', 'Three, at last.'],
      ['t4', 'completed', 'Four.'],
    ]);
    expect(env.clients.map((c) => c.view)).toEqual([early.view, early.view, early.view]);
  });
});
