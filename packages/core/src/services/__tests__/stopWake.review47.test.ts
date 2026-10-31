import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { taskOf } from './sessionTestKit';
import { ctx, prose, settled, supervised, task, until, waitForInput, type Env } from './supervisorTestKit';

/**
 * ADR-0029: the user's Stop bounds the wake-ups, and a report turn it would
 * open. Nothing held at a Stop opens a turn or restarts anything until the user
 * starts work again, and none of it is lost: it waits on the plan for their
 * next message, and the tasks it was about say the same in the plan and the
 * inbox. A stop of one task leaves the run going, so it holds back only what
 * is about that task.
 */
beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-11T18:00:00Z'), toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A held failure's age is the cache's, not the connector's five minutes. */
const shortCache = (env: Env) => {
  (env.planner.aiService as unknown as { promptCacheTtlMs: () => number }).promptCacheTtlMs = () => 10;
};

const waiting = (env: Env) => (env.session.planState!.pendingTurns ?? []).map((t) => t.text).join('\n');

const running = async (level: 'watch' | 'act') => {
  const env = await supervised([task('t1', 1), task('t2', 2)], { settings: { supervisorLevel: level } });
  shortCache(env);
  await until(() => env.run.spawnedIds().includes('t1') && env.run.spawnedIds().includes('t2'));
  return env;
};

const passed = async () => {
  await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS + 1_000);
  await settled();
};

describe('a Stop stops the supervisor too (ADR-0029, ADR-0057 R4)', () => {
  it.each(['watch', 'act'] as const)('opens no turn at %s for a failure held when the user stopped the run, and keeps what it said', async (level) => {
    const env = await running(level);

    env.run.of('t1').reportComplete({ status: 'failed', summary: 'boom', reason: 'boom' });
    await settled();
    expect(env.planner.calls).toHaveLength(0);

    env.session.stopExecution();
    await passed();

    expect(env.planner.calls).toHaveLength(0);
    expect(waiting(env)).toContain('failed');
    expect(taskOf(env.session, 't1')!.status).toBe('failed');
    expect(env.session.escalations().map((e) => e.task?.title)).toContain('Task t1');
    env.session.destroy();
  });

  it('stands down through the seam too, for an event due at once', async () => {
    const env = await running('act');

    waitForInput(env.run.of('t1'));
    await settled();
    expect((await env.session.execute({ command: 'stop_run' }, { kind: 'user' })).ok).toBe(true);
    await passed();

    expect(env.planner.calls).toHaveLength(0);
    expect(waiting(env)).toContain('waiting for input');
    env.session.destroy();
  });

  it('opens no report turn at Off, and the user\'s next message carries the report', async () => {
    const env = await supervised([task('t1', 1, { research: true }), task('t2', 2)], { settings: { supervisorLevel: 'off' } });
    await until(() => env.run.spawnedIds().includes('t1') && env.run.spawnedIds().includes('t2'));

    env.run.of('t1').reportComplete({ status: 'done', summary: 'the findings' });
    await settled();
    env.session.stopExecution();
    await passed();

    expect(env.planner.calls).toHaveLength(0);
    expect(waiting(env)).toContain('the findings');

    void env.session.continueConversation('what did it find?').catch(() => {});
    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toContain('the findings');
    env.session.destroy();
  });

  it('holds what comes after the Stop too, and an input already waiting behind a turn', async () => {
    const env = await running('act');
    void env.session.continueConversation('how is it going?').catch(() => {});
    await until(() => env.planner.calls.length === 1);

    env.run.of('t1').reportComplete({ status: 'failed', summary: 'boom', reason: 'boom' });
    waitForInput(env.run.of('t2'));
    await passed();
    env.session.stopExecution();
    env.planner.calls[0].finish(prose('going well'));
    await passed();

    expect(env.planner.calls).toHaveLength(1);
    expect(waiting(env)).toContain('waiting for input');
    env.session.destroy();
  });

  it('holds a turn still open when the user stopped the run to nothing: it cannot start the run again', async () => {
    const env = await running('act');
    waitForInput(env.run.of('t1'));
    await passed();
    await until(() => env.planner.calls.length === 1);

    env.session.stopExecution();
    const tools = env.planner.tools();

    expect(await tools.runPlan!({}, ctx)).toMatchObject({ isError: true });
    expect(await tools.retryTask!({ task: '1', from: 'fresh' }, ctx)).toMatchObject({ isError: true, text: expect.stringContaining('supervisor') });
    expect(env.run.spawnedIds().filter((id) => id === 't1')).toHaveLength(1);
    env.session.destroy();
  });

  it('keeps standing through a reload of what it saved', async () => {
    const env = await running('act');

    env.session.stopExecution();
    await settled();

    expect(env.session.planState!.supervision?.wake?.stopped).toBe(true);
    env.session.destroy();
  });

  it('stands down for a Stop with nothing to stop, which still withdraws what was asked', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'act' }, execute: false });

    expect(await env.session.execute({ command: 'stop_run' }, { kind: 'user' })).toMatchObject({ ok: true, message: expect.stringContaining('nothing to stop') });

    expect(env.session.planState!.supervision?.wake?.stopped).toBe(true);
    env.session.destroy();
  });

  it('wakes again once the user starts the run, and what the Stop held goes with that turn', async () => {
    const env = await running('act');
    env.run.of('t1').reportComplete({ status: 'failed', summary: 'boom', reason: 'boom' });
    await settled();
    env.session.stopExecution();
    await passed();

    expect((await env.session.execute({ command: 'run_plan' }, { kind: 'user' })).ok).toBe(true);
    await until(() => env.run.spawnedIds().filter((id) => id === 't2').length === 2);
    expect(env.planner.calls).toHaveLength(0);
    expect(env.session.planState!.supervision?.wake?.stopped).toBeUndefined();

    waitForInput(env.run.of('t2'));
    await passed();
    await until(() => env.planner.calls.length === 1);

    expect(env.planner.calls[0].message).toContain('boom');
    expect(env.planner.calls[0].message).toContain('waiting for input');
    env.session.destroy();
  });

  it('ends with a user\'s retry of one task, which opens no run of its own', async () => {
    const env = await running('act');
    env.session.stopExecution();
    await settled();

    expect((await env.session.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, { kind: 'user' })).ok).toBe(true);

    expect(env.session.planState!.supervision?.wake?.stopped).toBeUndefined();
    env.session.destroy();
  });

  it('does not stand down for a supervisor\'s own stop, which it means to follow with a start', async () => {
    const env = await running('act');
    waitForInput(env.run.of('t1'));
    await passed();
    await until(() => env.planner.calls.length === 1);
    const tools = env.planner.tools();

    expect((await tools.stopRun!({}, ctx)).isError).toBeFalsy();

    expect(env.session.planState!.supervision?.wake?.stopped).toBeUndefined();
    expect((await tools.runPlan!({}, ctx)).isError).toBeFalsy();
    env.session.destroy();
  });
});

describe('a user\'s stop of one task (ADR-0029)', () => {
  it.each(['watch', 'act'] as const)('opens no turn at %s for what was held about it, and the rest of the run still wakes it', async (level) => {
    const env = await running(level);

    waitForInput(env.run.of('t1'));
    await settled();
    expect((await env.session.execute({ command: 'stop_task', task: 't1' }, { kind: 'user' })).ok).toBe(true);
    await passed();

    expect(env.planner.calls).toHaveLength(0);
    expect(waiting(env)).toContain('task #1 "Task t1" is waiting for input');

    waitForInput(env.run.of('t2'));
    await passed();
    await until(() => env.planner.calls.length === 1);

    expect(env.planner.calls[0].message).toContain('task #2 "Task t2" is waiting for input');
    expect(env.planner.calls[0].message).toContain('task #1 "Task t1" is waiting for input');
    env.session.destroy();
  });

  it('keeps a supervisor from starting it, until the user does', async () => {
    const env = await running('act');
    await env.session.execute({ command: 'stop_task', task: 't1' }, { kind: 'user' });
    waitForInput(env.run.of('t2'));
    await passed();
    await until(() => env.planner.calls.length === 1);
    const tools = env.planner.tools();

    expect(await tools.retryTask!({ task: '1', from: 'fresh' }, ctx)).toMatchObject({ isError: true, text: expect.stringContaining('the user stopped') });
    expect(env.run.spawnedIds().filter((id) => id === 't1')).toHaveLength(1);

    expect((await env.session.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, { kind: 'user' })).ok).toBe(true);
    expect(env.session.planState!.supervision?.guards?.stopped).toBeUndefined();
    env.session.destroy();
  });

  it('leaves a task the supervisor stopped its own to start again', async () => {
    const env = await running('act');
    waitForInput(env.run.of('t1'));
    await passed();
    await until(() => env.planner.calls.length === 1);
    const tools = env.planner.tools();

    await tools.stopTask!({ task: '1' }, ctx);

    expect(env.session.planState!.supervision?.guards?.stopped).toBeUndefined();
    expect((await tools.retryTask!({ task: '1', from: 'fresh' }, ctx)).isError).toBeFalsy();
    env.session.destroy();
  });
});
