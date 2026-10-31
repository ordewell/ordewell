import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FakeWorktreeIsolation } from '../../testing';
import * as sessionStore from '../../utils/sessionStore';
import type { ExecutionCommand } from '../ExecutionCommands';
import { LEASE_STALE_MS, LeaseHost, SessionHeldError } from '../sessionLease';
import { fakeConfig, makeSession, taskOf } from './sessionTestKit';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { heldPlanner, recordingRunner, plan, task, settled, until } from './supervisorTestKit';

const SESSION = 'session-shared';
const START = Date.parse('2026-10-24T01:40:00.000Z');
const HELD = 'open in another Ordewell host';

/**
 * A start refused because another host holds the session (ADR-0049, ADR-0055
 * D13) changes nothing. The isolation refuses too, but only once a run has
 * been refreshed: the execution log cleared and failed tasks readied as if the
 * run had begun, so the user is told the start was refused while the plan
 * silently lost the last run's record. A run without worktrees is never asked.
 */
describe('a held start is refused before anything changes', () => {
  let workspace: string;
  const hosts: LeaseHost[] = [];

  function host(options: ConstructorParameters<typeof LeaseHost>[0]): LeaseHost {
    const made = new LeaseHost(options);
    hosts.push(made);
    return made;
  }

  /** One host's Session on the plan, in the checkout: no isolated run record exists for the next Execute to continue. */
  function hostA() {
    const isolation = new FakeWorktreeIsolation();
    isolation.availability = { active: false, reason: 'not-git' };
    const run = recordingRunner();
    const session = makeSession({
      config: fakeConfig({ worktreeIsolation: true, maxParallelSessions: 3 }),
      saveSession: sessionStore.saveSession,
      leaseHost: host({ id: 'host-a', now: () => START }),
      isolation,
      runner: run.runner,
      aiService: heldPlanner().aiService,
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
      workspaceRoot: () => workspace,
    });
    session.loadPlan(plan([task('t1', 1), task('t2', 2)]), 'goal', workspace, { sessionId: SESSION });
    return { session, isolation, run };
  }

  async function afterAFailedRun() {
    const env = hostA();
    const { session, run } = env;
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await until(() => run.spawnedIds().length === 2);
    run.of('t1').reportComplete({ status: 'done', summary: 'did t1' });
    await settled();
    run.of('t2').emitExit(1);
    await settled();
    await until(() => taskOf(session, 't2')?.status === 'failed');
    return { ...env, state: () => ({ log: session.executionLog.length, tasks: session.planState?.tasks.map((t) => [t.id, t.status]) }) };
  }

  /** A host that judged the first gone takes the session, which the first has yet to hear. */
  function takeOver() {
    const saved = sessionStore.loadSession(SESSION, workspace)!;
    const second = makeSession({
      saveSession: sessionStore.saveSession,
      leaseHost: host({ id: 'host-b', alive: () => true, now: () => START + LEASE_STALE_MS + 1 }),
      workspaceRoot: () => workspace,
    });
    second.loadPlan(saved.plan, saved.meta.goal, workspace, { sessionId: SESSION });
    return second;
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: START, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-held-start-'));
  });

  afterEach(() => {
    for (const made of hosts.splice(0)) made.releaseAll();
    vi.useRealTimers();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('leaves the execution log and the failed task exactly as the last run left them', async () => {
    const { session, isolation, run, state } = await afterAFailedRun();
    const before = state();
    expect(before.log).toBe(2);

    const second = takeOver();
    isolation.availability = { active: true };
    const outcome = await session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(HELD);
    expect(run.spawnedIds()).toEqual(['t1', 't2']);
    expect(state()).toEqual(before);
    second.destroy();
    session.destroy();
  });

  it.each<[string, ExecutionCommand]>([
    ['a start of one task', { command: 'run_task', task: 't2' }],
    ['a fresh retry', { command: 'retry_task', task: 't2', from: 'fresh' }],
    ['a continue', { command: 'retry_task', task: 't2', from: 'session', message: 'go on' }],
    ['a force start', { command: 'force_start', task: 't2' }],
    ['a skip, which restarts a run that ended on a failure', { command: 'skip_task', task: 't2' }],
    ['a review sign-off', { command: 'approve_review' }],
  ])('refuses %s the same way', async (_, command) => {
    const { session, isolation, run, state } = await afterAFailedRun();
    const before = state();

    const second = takeOver();
    isolation.availability = { active: true };
    const outcome = await session.execute(command, { kind: 'user' });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(HELD);
    expect(run.spawnedIds()).toEqual(['t1', 't2']);
    expect(state()).toEqual(before);
    second.destroy();
    session.destroy();
  });

  it('refuses a run without worktrees, which no isolation call would stop', async () => {
    const { session, run, state } = await afterAFailedRun();
    const before = state();

    const second = takeOver();
    const outcome = await session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(outcome.ok).toBe(false);
    expect(run.spawnedIds()).toEqual(['t1', 't2']);
    expect(state()).toEqual(before);
    second.destroy();
    session.destroy();
  });

  it('adds no script task for a run_script it has to refuse', async () => {
    const { session, run, state } = await afterAFailedRun();
    const before = state();

    const second = takeOver();
    const outcome = await session.execute({ command: 'run_script', title: 'Check', commands: [['true']] }, { kind: 'planner-turn' });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(HELD);
    expect(run.spawnedIds()).toEqual(['t1', 't2']);
    expect(state()).toEqual(before);
    second.destroy();
    session.destroy();
  });

  it('refuses Run without isolation on a start a dirty tree parked', async () => {
    const { session, isolation, run } = hostA();
    isolation.availability = { active: false, reason: 'dirty', repos: ['.'] };
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    const second = takeOver();

    await expect(session.continueWithoutIsolation()).rejects.toBeInstanceOf(SessionHeldError);
    await settled();
    expect(run.spawnedIds()).toEqual([]);
    second.destroy();
    session.destroy();
  });
});
