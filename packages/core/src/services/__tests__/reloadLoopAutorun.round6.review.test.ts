import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionMessage } from '../SessionMessage';
import { makeSession, taskOf, testWorkspace } from './sessionTestKit';
import { heldPlanner, NOW, recordingRunner, settled, supervised, task, until } from './supervisorTestKit';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { loadSession, saveSession } from '../../utils/sessionStore';
import { fakeConfig, FakeWorktreeIsolation } from '../../testing';

/**
 * Round 6 of the reload, loop and autorun review, on the round-5 fix
 * (fa831cc1). Its fix, its minors and the two open-run joins hold (see
 * reloadLoopAutorun.round5.review.test.ts); these four failed on the tree as it
 * stood (41fb23d1), and the rest here pin what their fix keeps:
 * - a Stop with a carried loop whose body failed leaves the loop to resume
 *   (ADR-0045 L7; pre-existing, not this fix's change);
 * - Execute on a scheduled run a dirty checkout parked begins a new run and
 *   readies its failure (ADR-0053; the join excludes runBlocked);
 * - a planner's run_plan after an ended-on-failure run, or after a reload,
 *   readies the failure (ADR-0053; the fix task's F1 left).
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => { vi.useRealTimers(); });

const USER = { kind: 'user' as const };
const PLANNER = { kind: 'planner-turn' as const };
const loop = () => [task('check', 1, { loop: { body: ['fix'], maxRounds: 3 } }), task('fix', 2, { dependencies: ['check'] })];

describe('a Stop between a carried loop\'s body failure and its retry', () => {
  it('ends the carry, so the retry that passes does not run the next round', async () => {
    const env = await supervised(loop(), { execute: false, settings: { supervisorLevel: 'off' } });
    expect((await env.session.execute({ command: 'run_task', task: 'check' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().includes('check'));
    env.run.of('check').reportComplete({ status: 'failed', summary: 'Found it.', reason: 'Found it.' });
    await until(() => env.run.spawnedIds().includes('fix'));
    env.run.of('fix').reportComplete({ status: 'failed', summary: 'No.', reason: 'No.' });
    await until(() => taskOf(env.session, 'fix')?.status === 'failed');
    await settled();

    const stopped = await env.session.execute({ command: 'stop_run' }, USER);
    await settled();
    expect(stopped.ok).toBe(true);

    expect((await env.session.execute({ command: 'retry_task', task: 'fix', from: 'fresh' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().filter((id) => id === 'fix').length === 2);
    env.run.of('fix').reportComplete({ status: 'done', summary: 'fixed' });
    await settled();
    await settled();

    // ADR-0045 L7: a retry that passes resumes the loop, unless a Stop came first.
    expect(env.run.spawnedIds().filter((id) => id === 'check')).toHaveLength(1);
    expect(taskOf(env.session, 'check')).toMatchObject({ status: 'failed' });
    expect(env.session.escalations().find((e) => e.task?.id === 'check')).toBeDefined();
    env.session.destroy();
  });

  it.each([['user', USER], ['planner', PLANNER]])('is a run to stop for the %s, and the Stop says what it ended', async (_who, actor) => {
    const env = await supervised(loop(), { execute: false, settings: { supervisorLevel: 'off' } });
    expect((await env.session.execute({ command: 'run_task', task: 'check' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().includes('check'));
    env.run.of('check').reportComplete({ status: 'failed', summary: 'Found it.', reason: 'Found it.' });
    await until(() => env.run.spawnedIds().includes('fix'));
    env.run.of('fix').reportComplete({ status: 'failed', summary: 'No.', reason: 'No.' });
    await until(() => taskOf(env.session, 'fix')?.status === 'failed');
    await settled();

    const stopped = await env.session.execute({ command: 'stop_run' }, actor);

    expect(stopped).toMatchObject({ ok: true, message: 'Stopped the loop carried on: nothing was running, and a retry that passes no longer resumes it. The plan is kept.' });
    // Ended now, so a second Stop finds nothing.
    expect((await env.session.execute({ command: 'stop_run' }, USER)).message).toBe('Nothing is running: there is nothing to stop.');
    env.session.destroy();
  });

  it('holds no override back: nothing of it moves a task on by itself (ADR-0029)', async () => {
    const env = await supervised(loop(), { execute: false, settings: { supervisorLevel: 'off' } });
    expect((await env.session.execute({ command: 'run_task', task: 'check' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().includes('check'));
    env.run.of('check').reportComplete({ status: 'failed', summary: 'Found it.', reason: 'Found it.' });
    await until(() => env.run.spawnedIds().includes('fix'));
    env.run.of('fix').reportComplete({ status: 'failed', summary: 'No.', reason: 'No.' });
    await until(() => taskOf(env.session, 'fix')?.status === 'failed');
    await settled();

    expect(env.session.startsPending).toBe(false);
    env.session.destroy();
  });
});

describe('Execute on a scheduled run a dirty checkout parked', () => {
  /** An ops task that failed in the checkout, and the change task after it, whose start the dirty tree turned away. */
  async function parked() {
    const isolation = new FakeWorktreeIsolation();
    isolation.availability = { active: false, reason: 'dirty' };
    const runner = recordingRunner();
    const messages: SessionMessage[] = [];
    const notices: string[] = [];
    const session = makeSession({
      runner: runner.runner, isolation, broadcast: (m) => messages.push(m), onNotice: (n) => notices.push(n.message),
      config: fakeConfig({ maxParallelSessions: 1 }), workspaceRoot: () => '/repo',
    });
    session.loadPlan({
      tasks: [task('o1', 1, { ops: true }), task('t2', 2)],
      generatedAt: NOW.toISOString(), lastUpdated: NOW.toISOString(), status: 'approved', runners: ['claude-code'],
    }, 'goal', '/repo');
    expect((await session.execute({ command: 'run_plan' }, USER)).ok).toBe(true);
    await until(() => runner.spawnedIds().includes('o1'));
    runner.of('o1').reportComplete({ status: 'failed', summary: 'No.', reason: 'No.' });
    await until(() => taskOf(session, 'o1')?.status === 'failed');
    await settled();
    // Its next task asks about isolation and parks the start: the run is scheduled, with a failure.
    expect(messages.filter((m) => m.type === 'isolation_blocked')).toHaveLength(1);
    return { isolation, runner, messages, notices, session };
  }

  it('keeps the failure of the ops task that ran before the block', async () => {
    const { runner, session } = await parked();

    expect((await session.execute({ command: 'run_plan' }, USER)).ok).toBe(true);
    await settled();

    // ADR-0053: a scheduled run keeps its failures, and Execute only approves what waits in it.
    expect(taskOf(session, 'o1')).toMatchObject({ status: 'failed' });
    expect(runner.spawnedIds().filter((id) => id === 'o1')).toHaveLength(1);
    session.destroy();
  });

  it('reads the checkout again and starts what it parked, once the tree is clean', async () => {
    const { isolation, runner, messages, session } = await parked();
    isolation.availability = { active: true };

    expect((await session.execute({ command: 'run_plan' }, USER)).ok).toBe(true);
    await until(() => runner.spawnedIds().includes('t2'));

    expect(taskOf(session, 'o1')).toMatchObject({ status: 'failed' });
    expect(runner.spawnedIds()).toEqual(['o1', 't2']);
    expect(messages.filter((m) => m.type === 'isolation_blocked')).toHaveLength(1);
    session.destroy();
  });

  it('turns it away again while the tree is dirty, says so, and Stash and continue still replays it', async () => {
    const { runner, messages, notices, session } = await parked();

    const again = await session.execute({ command: 'run_plan' }, USER);
    await settled();

    expect(again).toMatchObject({ ok: true, message: 'Nothing started: your checkout has uncommitted changes. Stash them, or run without isolation.' });
    expect(messages.filter((m) => m.type === 'isolation_blocked')).toHaveLength(2);
    expect(notices.filter((n) => n.includes('already running'))).toEqual([]);
    expect(runner.spawnedIds()).toEqual(['o1']);

    await session.continueWithStash();
    await until(() => runner.spawnedIds().includes('t2'));
    expect(taskOf(session, 'o1')).toMatchObject({ status: 'failed' });
    expect(runner.spawnedIds()).toEqual(['o1', 't2']);
    session.destroy();
  });

  it('is joined by a planner\'s run_plan too, which is told the run is still parked', async () => {
    const { runner, session } = await parked();

    const joined = await session.execute({ command: 'run_plan' }, PLANNER);
    await settled();

    expect(joined.ok).toBe(true);
    expect(joined.message).toContain('the run waits for them to stash them or run without isolation');
    expect(taskOf(session, 'o1')).toMatchObject({ status: 'failed' });
    expect(runner.spawnedIds()).toEqual(['o1']);
    session.destroy();
  });
});

describe('a planner\'s run_plan after a run ended on a failure', () => {
  it('joins it and leaves the failure as it is', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { settings: { supervisorLevel: 'off' } });
    await until(() => env.run.spawnedIds().includes('t1'));
    env.run.of('t1').reportComplete({ status: 'failed', summary: 'No.', reason: 'No.' });
    await until(() => taskOf(env.session, 't1')?.status === 'failed');
    await settled();

    expect((await env.session.execute({ command: 'run_plan' }, PLANNER)).ok).toBe(true);
    await settled();

    // ADR-0053: the fresh chance is the user's to ask for; neither a planner's run_plan nor autorun asks.
    expect(taskOf(env.session, 't1')).toMatchObject({ status: 'failed' });
    expect(env.run.spawnedIds().filter((id) => id === 't1')).toHaveLength(1);
    env.session.destroy();
  });

  it('does not give a reloaded failure that chance either', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-round6-'));
    try {
      const before = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' } });
      await until(() => before.run.spawnedIds().includes('t1'));
      before.run.of('t1').reportComplete({ status: 'failed', summary: 'No.', reason: 'No.' });
      await until(() => taskOf(before.session, 't1')?.status === 'failed');
      await settled();
      saveSession(before.session.planState!, 'goal', dir, 'round6');
      before.session.destroy();

      const run = recordingRunner();
      const session = makeSession({ aiService: heldPlanner().aiService, runner: run.runner, settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }) });
      session.loadPlan(loadSession('round6', dir)!.plan, 'goal', testWorkspace, { persist: false });
      expect(taskOf(session, 't1')).toMatchObject({ status: 'failed' });

      expect((await session.execute({ command: 'run_plan' }, PLANNER)).ok).toBe(true);
      await settled();

      expect(taskOf(session, 't1')).toMatchObject({ status: 'failed' });
      expect(run.spawnedIds()).toEqual([]);
      session.destroy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tells the planner nothing could start and what would, where the run ends again', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { settings: { supervisorLevel: 'off' } });
    await until(() => env.run.spawnedIds().includes('t1'));
    env.run.of('t1').reportComplete({ status: 'failed', summary: 'No.', reason: 'No.' });
    await until(() => taskOf(env.session, 't1')?.status === 'failed');
    await settled();

    const joined = await env.session.execute({ command: 'run_plan' }, PLANNER);

    expect(joined.message).toMatch(/^Nothing could start\. .* failed and stays failed, and run_plan gives no fresh chance\. Start a new attempt with retry_task\.$/);
    env.session.destroy();
  });

  it('starts what is independent of the failure, with no run open, and says the failure stands', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2)], { execute: false, settings: { supervisorLevel: 'off', autorun: true }, config: { autonomousMode: true } });
    expect((await env.session.execute({ command: 'run_task', task: 't1' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().includes('t1'));
    env.run.of('t1').reportComplete({ status: 'failed', summary: 'No.', reason: 'No.' });
    await until(() => taskOf(env.session, 't1')?.status === 'failed');
    await settled();

    const begun = await env.session.execute({ command: 'run_plan' }, PLANNER);
    await until(() => env.run.spawnedIds().includes('t2'));

    expect(begun.message).toContain('failed and stays failed');
    expect(taskOf(env.session, 't1')).toMatchObject({ status: 'failed' });
    expect(env.run.spawnedIds()).toEqual(['t1', 't2']);
    env.session.destroy();
  });

  it('leaves the fresh chance to the user\'s Execute, which still gives it', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' } });
    await until(() => env.run.spawnedIds().includes('t1'));
    env.run.of('t1').reportComplete({ status: 'failed', summary: 'No.', reason: 'No.' });
    await until(() => taskOf(env.session, 't1')?.status === 'failed');
    await settled();
    expect((await env.session.execute({ command: 'run_plan' }, PLANNER)).ok).toBe(true);
    await settled();

    expect((await env.session.execute({ command: 'run_plan' }, USER)).ok).toBe(true);
    await until(() => env.run.spawnedIds().filter((id) => id === 't1').length === 2);

    expect(taskOf(env.session, 't1')).toMatchObject({ status: 'in_progress' });
    env.session.destroy();
  });
});
