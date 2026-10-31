import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskOf } from './sessionTestKit';
import { NOW, settled, supervised, task, until } from './supervisorTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import { UNLEASED, type LeaseHost, type SessionHeld } from '../sessionLease';

/**
 * Round 7 of the reload, loop and autorun review, on the round-6 fix
 * (f4dfc99d). F1, F2 and F3 of that round hold (see
 * reloadLoopAutorun.round6.review.test.ts). What the F3 fix left open is the
 * same dormant carry on the routes that end a run without going through
 * `stop_run`: a discard does not end it, so the retry that passes starts the
 * check again although the user gave the run up (ADR-0013; ADR-0045 L5, L7).
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => { vi.useRealTimers(); });

const USER = { kind: 'user' as const };
const loop = () => [task('check', 1, { loop: { body: ['fix'], maxRounds: 3 } }), task('fix', 2, { dependencies: ['check'] })];

/** A hand-started check that failed, whose body failed too: the loop is carried, with nothing at work. */
async function dormant(tasks = loop()) {
  const isolation = new FakeWorktreeIsolation();
  const env = await supervised(tasks, { execute: false, settings: { supervisorLevel: 'off' }, isolation, config: { worktreeIsolation: true } });
  return { env, isolation };
}

async function failCheckAndBody(env: Awaited<ReturnType<typeof dormant>>['env']) {
  expect((await env.session.execute({ command: 'run_task', task: 'check' }, USER)).ok).toBe(true);
  await until(() => env.run.spawnedIds().includes('check'));
  env.run.of('check').reportComplete({ status: 'failed', summary: 'Found it.', reason: 'Found it.' });
  await until(() => env.run.spawnedIds().includes('fix'));
  env.run.of('fix').reportComplete({ status: 'failed', summary: 'No.', reason: 'No.' });
  await until(() => taskOf(env.session, 'fix')?.status === 'failed');
  await settled();
}

/** The retry that passes must not run a check after the run it belonged to was given up. */
async function retryBody(env: Awaited<ReturnType<typeof dormant>>['env']) {
  expect((await env.session.execute({ command: 'retry_task', task: 'fix', from: 'fresh' }, USER)).ok).toBe(true);
  await until(() => env.run.spawnedIds().filter((id) => id === 'fix').length === 2);
  env.run.of('fix').reportComplete({ status: 'done', summary: 'fixed' });
  await settled(); await settled(); await settled();
  return env.run.spawnedIds();
}

describe('a run given up with a dormant carried loop', () => {
  it('does not start the loop\'s check again when the body is retried', async () => {
    const { env } = await dormant();
    await failCheckAndBody(env);
    // F3: a dormant carry is a run to stop, and its Stop ends it (round 6).
    expect(env.session.startsPending).toBe(false);

    await env.session.discardRun();

    const spawned = await retryBody(env);
    // ADR-0013: a discard gives the whole run up. ADR-0045 L5: what a Stop ends
    // does not come back; nothing of the loop may start by itself after it.
    expect(spawned.filter((id) => id === 'check')).toHaveLength(1);
    env.session.destroy();
  });

  it('does not do so through the handoff that offers the discard, with landed work', async () => {
    const { env } = await dormant([task('t0', 1), ...loop()]);
    // A first task lands by hand, so the handoff the discard is pressed on is there.
    expect((await env.session.execute({ command: 'run_task', task: 't0' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().includes('t0'));
    env.run.of('t0').reportComplete({ status: 'done', summary: 'done' });
    await until(() => taskOf(env.session, 't0')?.status === 'completed');
    await settled();
    await failCheckAndBody(env);
    expect(env.session.isolationView()?.handoff?.landed.map((t) => t.taskId)).toEqual(['t0']);

    await env.session.discardRun();

    const spawned = await retryBody(env);
    expect(spawned.filter((id) => id === 'check')).toHaveLength(1);
    env.session.destroy();
  });
});

describe('the other routes that end a run with a dormant carried loop', () => {
  /** A dormant carry beside a landed task, so the run has a handoff to clean up or merge. */
  async function dormantWithLanded() {
    const { env, isolation } = await dormant([task('t0', 1), ...loop()]);
    expect((await env.session.execute({ command: 'run_task', task: 't0' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().includes('t0'));
    env.run.of('t0').reportComplete({ status: 'done', summary: 'done' });
    await until(() => taskOf(env.session, 't0')?.status === 'completed');
    await settled();
    await failCheckAndBody(env);
    return { env, isolation };
  }

  it('ends it with a clean-up, which keeps the integration branch but ends the run', async () => {
    const { env } = await dormantWithLanded();

    await env.session.cleanupRun();

    const spawned = await retryBody(env);
    expect(spawned.filter((id) => id === 'check')).toHaveLength(1);
    env.session.destroy();
  });

  it('ends it when the host loses the session, which a Stop is owed for though nothing moves', async () => {
    let lose: (held: SessionHeld) => void = () => undefined;
    const isolation = new FakeWorktreeIsolation();
    const env = await supervised(loop(), {
      execute: false, settings: { supervisorLevel: 'off' }, isolation, config: { worktreeIsolation: true },
      leaseHost: { lease: (onLost) => { lose = onLost; return UNLEASED; } } as LeaseHost,
    });
    await failCheckAndBody(env);
    const now = new Date(NOW).toISOString();

    lose({ holder: { hostId: 'other', pid: 1, since: now, heartbeatAt: now, runnerGroups: [] } });

    expect(env.messages.some((m) => m.type === 'execution_stopped')).toBe(true);
    const spawned = await retryBody(env);
    expect(spawned.filter((id) => id === 'check')).toHaveLength(1);
    env.session.destroy();
  });

  it('leaves it standing through a Merge all the run goes on after (ADR-0020), so the retry resumes the loop', async () => {
    const { env } = await dormantWithLanded();

    expect((await env.session.execute({ command: 'merge_all' }, USER)).ok).toBe(true);
    await settled();
    // The failed tasks hold work that has not landed, so the run stands and nothing ended it.
    expect(env.session.isolationView()).not.toBeNull();

    const spawned = await retryBody(env);
    expect(spawned.filter((id) => id === 'check')).toHaveLength(2);
    env.session.destroy();
  });

  it('leaves it standing through a discard git refuses, as the run is still there', async () => {
    const { env, isolation } = await dormantWithLanded();
    isolation.discardError = new Error('git would not');

    await expect(env.session.discardRun()).rejects.toThrow('git would not');
    isolation.discardError = null;

    const spawned = await retryBody(env);
    expect(spawned.filter((id) => id === 'check')).toHaveLength(2);
    env.session.destroy();
  });
});
