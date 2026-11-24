import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { ExecutionActor } from '../../models/Execution';
import type { Session } from '../createSession';
import { fakeConfig, FakeRunnerSession, removeDir } from '../../testing';
import { closeSessions, fakeNotification, makeSession } from './sessionTestKit';

/**
 * A start held because configuration an earlier task landed differs from
 * where its run started (ADR-0028), seen from every caller that could start
 * it again once the user's branch holds that configuration: only a start the
 * user makes themselves begins a run from their branch, and so gets past the
 * hold. A model's call, or anything with no person acting, leaves it held.
 */

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const roots: string[] = [];
afterEach(async () => {
  await closeSessions();
  while (roots.length) await removeDir(roots.pop()!);
});

function repo(): string {
  // Native, as git names a path: on Windows the JS realpath keeps the 8.3 short name of the temp folder.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ordewell-held-config-')));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

const HOOK = '.claude/settings.json';
const SUPERVISOR: ExecutionActor = { kind: 'supervisor', level: 'act' };
const USER: ExecutionActor = { kind: 'user' };

const HELD = 'Task "Check the hook" is on hold: ';

/**
 * t1 lands a SessionStart hook; t2, after it, is held at its start. The
 * runner records, at each spawn, which task it is and whether the hook is
 * where the runner starts. `holdT1` keeps t1 running until {@link release};
 * `ops` adds t3, an ops task after t1, whose merge gate merges t1's work.
 */
async function heldStart({ mergeAtGatesAutomatically = false, holdT1 = false, run = true, ops = false } = {}) {
  const root = repo();
  const spawned: string[] = [];
  const hookAtSpawn: boolean[] = [];
  const finish = new Map<string, () => void>();
  let ids = 0;
  const runner: IRunner = {
    spawn: vi.fn(async (opts) => {
      spawned.push(opts.taskId);
      hookAtSpawn.push(existsSync(join(opts.cwd!, HOOK)));
      const session = new FakeRunnerSession(`s${hookAtSpawn.length}`, opts.taskId);
      const done = () => {
        const file = opts.taskId === 't1' ? HOOK : `${opts.taskId}.txt`;
        mkdirSync(dirname(join(opts.cwd!, file)), { recursive: true });
        writeFileSync(join(opts.cwd!, file), opts.taskId === 't1' ? '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo started"}]}]}}\n' : 'checked\n');
        session.reportComplete({ status: 'done', summary: 'Done.' });
      };
      if (holdT1 && opts.taskId === 't1') finish.set('t1', done);
      else setTimeout(done, 5);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
  const config = fakeConfig({ worktreeIsolation: true, autonomousMode: true });
  const notifications = fakeNotification();
  const told = () => [notifications.info, notifications.warn, notifications.error].flatMap((say) => vi.mocked(say).mock.calls.map(([line]) => String(line)));
  const session = makeSession({
    runner,
    config,
    notifications,
    isolation: createWorktreeIsolation({ config, resolvePath: async () => process.env.PATH ?? '', mintRunId: () => `run${++ids}` }),
    workspaceRoot: () => root,
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', mergeAtGatesAutomatically } }),
  });
  const now = new Date().toISOString();
  const plan: LegacyPlanState = {
    tasks: [
      createTask({ id: 't1', order: 1, title: 'Add a hook', prompt: 'add the hook', assignedRunner: 'claude-code', taskMode: 'acceptEdits' }),
      createTask({ id: 't2', order: 2, title: 'Check the hook', prompt: 'check it', assignedRunner: 'claude-code', taskMode: 'acceptEdits', dependencies: ['t1'] }),
      ...(ops ? [createTask({ id: 't3', order: 3, title: 'Run the hook', prompt: 'run it', assignedRunner: 'claude-code', taskMode: 'acceptEdits', ops: true, dependencies: ['t1'] })] : []),
    ],
    generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now,
  };
  session.loadPlan(plan, 'goal', root, { persist: false });
  const holdOf = () => session.runSnapshot().tasks.find((t) => t.id === 't2')?.holdReason ?? null;
  if (run) {
    expect(await session.execute({ command: 'run_plan' }, USER)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(holdOf()).toContain(HOOK), { timeout: 20_000 });
  }
  const holds = () => told().filter((line) => line.startsWith(HELD)).length;
  return { root, session, runner, spawned, hookAtSpawn, holdOf, told, holds, release: (id: string) => finish.get(id)?.(), runId: () => session.planState?.isolation?.run.id };
}

/**
 * t1 and t2 started on their own, no scheduled run, with merging at gates
 * automatic: t2 is held once t1 lands, which settles the run, and its close
 * merges what landed and then keeps the run or clears it up.
 */
async function heldAtRunEnd() {
  const held = await heldStart({ mergeAtGatesAutomatically: true, holdT1: true, run: false });
  const { root, session, runner, holdOf, told, release } = held;
  await ok(session, { command: 'run_task', task: 't1' }, USER);
  await vi.waitFor(() => expect(runner.spawn).toHaveBeenCalledTimes(1), { timeout: 20_000 });
  await ok(session, { command: 'force_start', task: 't2' }, USER);
  release('t1');
  await vi.waitFor(() => expect(holdOf()).toContain(HOOK), { timeout: 20_000 });
  await vi.waitFor(() => expect(told()).toContain('Everything this run landed is merged into your branch already.'), { timeout: 20_000 });
  await vi.waitFor(() => expect(told().some((line) => line.startsWith('The run is not cleared up')) || session.planState?.isolation === undefined).toBe(true), { timeout: 20_000 });
  expect(existsSync(join(root, HOOK))).toBe(true);
  return held;
}

type Held = Awaited<ReturnType<typeof heldStart>>;

/** t2 started again by `start`, once that start has ended: held again, or run to the end. */
async function startsAgain({ session, spawned, holds }: Held, start: () => Promise<void>) {
  const before = holds();
  await start();
  await vi.waitFor(() => expect(holds() > before || spawned.includes('t2')).toBe(true), { timeout: 20_000 });
  if (spawned.includes('t2')) await vi.waitFor(() => expect(session.planTasks.find((t) => t.id === 't2')?.status).toBe('completed'), { timeout: 20_000 });
}

async function ok(session: Session, command: Parameters<Session['execute']>[0], actor: ExecutionActor) {
  const outcome = await session.execute(command, actor);
  expect(outcome, outcome.message).toMatchObject({ ok: true });
}

describe.skipIf(!hasGit)('a start held for configuration the run landed, once the user\'s branch holds it (ADR-0028)', () => {
  describe('a model\'s start leaves it held, as it is in the run it was held in', () => {
    it('the supervisor\'s Merge all, Stop and run_task', async () => {
      const held = await heldStart();
      const { session, hookAtSpawn, runner } = held;

      await ok(session, { command: 'merge_all' }, SUPERVISOR);
      await ok(session, { command: 'stop_run' }, SUPERVISOR);
      await startsAgain(held, () => ok(session, { command: 'run_task', task: 't2' }, SUPERVISOR));

      expect({ spawns: vi.mocked(runner.spawn).mock.calls.length, hookAtSpawn }).toEqual({ spawns: 1, hookAtSpawn: [false] });
    });

    it('the supervisor\'s Stop, Merge all, which keeps the run the held start is in, and run_task', async () => {
      const held = await heldStart();
      const { session, hookAtSpawn, runner, runId } = held;
      const run = runId();

      await ok(session, { command: 'stop_run' }, SUPERVISOR);
      await ok(session, { command: 'merge_all' }, SUPERVISOR);
      expect(runId()).toBe(run);
      await startsAgain(held, () => ok(session, { command: 'run_task', task: 't2' }, SUPERVISOR));

      expect({ spawns: vi.mocked(runner.spawn).mock.calls.length, hookAtSpawn }).toEqual({ spawns: 1, hookAtSpawn: [false] });
      expect(runId()).toBe(run);
    });

    it('the supervisor\'s run_plan after the user\'s Merge all and Stop', async () => {
      const held = await heldStart();
      const { session, hookAtSpawn, runner } = held;

      await ok(session, { command: 'merge_all' }, USER);
      await ok(session, { command: 'stop_run' }, USER);
      await startsAgain(held, () => ok(session, { command: 'run_plan' }, SUPERVISOR));

      expect({ spawns: vi.mocked(runner.spawn).mock.calls.length, hookAtSpawn }).toEqual({ spawns: 1, hookAtSpawn: [false] });
    });

    it('a planner turn\'s Stop and run_task after the user\'s Merge all', async () => {
      const held = await heldStart();
      const { session, hookAtSpawn, runner } = held;
      const planner: ExecutionActor = { kind: 'planner-turn' };

      await ok(session, { command: 'merge_all' }, USER);
      await ok(session, { command: 'stop_run' }, planner);
      await startsAgain(held, () => ok(session, { command: 'run_task', task: 't2' }, planner));

      expect({ spawns: vi.mocked(runner.spawn).mock.calls.length, hookAtSpawn }).toEqual({ spawns: 1, hookAtSpawn: [false] });
    });

    it('autorun\'s run_plan after the user\'s Merge all and Stop', async () => {
      const held = await heldStart();
      const { session, hookAtSpawn, runner } = held;

      await ok(session, { command: 'merge_all' }, USER);
      await ok(session, { command: 'stop_run' }, USER);
      await startsAgain(held, () => ok(session, { command: 'run_plan' }, { kind: 'autorun' }));

      expect({ spawns: vi.mocked(runner.spawn).mock.calls.length, hookAtSpawn }).toEqual({ spawns: 1, hookAtSpawn: [false] });
    });

    it('the supervisor\'s run_task after automatic merging at the run\'s end, which keeps the run the held start is in', async () => {
      const held = await heldAtRunEnd();
      const { session, hookAtSpawn, runner, runId } = held;
      expect(runId()).toBe('run1');

      await startsAgain(held, () => ok(session, { command: 'run_task', task: 't2' }, SUPERVISOR));

      expect({ spawns: vi.mocked(runner.spawn).mock.calls.length, hookAtSpawn }).toEqual({ spawns: 1, hookAtSpawn: [false] });
      expect(runId()).toBe('run1');
    });

    it('the supervisor\'s Stop and run_task after automatic merging at an ops task\'s gate', async () => {
      const held = await heldStart({ mergeAtGatesAutomatically: true, ops: true });
      const { root, session, spawned } = held;
      await vi.waitFor(() => expect(existsSync(join(root, HOOK))).toBe(true), { timeout: 20_000 });

      await ok(session, { command: 'stop_run' }, SUPERVISOR);
      await startsAgain(held, () => ok(session, { command: 'run_task', task: 't2' }, SUPERVISOR));

      expect(spawned.filter((id) => id === 't2')).toEqual([]);
      expect(held.runId()).toBe('run1');
    });
  });

  describe('the user\'s own start begins a run from their branch, which holds the configuration', () => {
    it.each([
      ['Start now', { command: 'run_task', task: 't2' }],
      ['Retry', { command: 'retry_task', task: 't2', from: 'fresh' }],
      ['Run', { command: 'run_plan' }],
    ] as const)('%s, after their Merge all and Stop', async (_control, command) => {
      const held = await heldStart();
      const { root, session, hookAtSpawn, runner, runId } = held;
      const run = runId();

      await ok(session, { command: 'merge_all' }, USER);
      await ok(session, { command: 'stop_run' }, USER);
      const head = git(root, 'rev-parse', 'HEAD');
      await startsAgain(held, () => ok(session, command, USER));

      expect({ spawns: vi.mocked(runner.spawn).mock.calls.length, hookAtSpawn }).toEqual({ spawns: 2, hookAtSpawn: [false, true] });
      expect(runId()).not.toBe(run);
      expect(session.planState?.isolation?.run.repos[0].baseRef).toBe(head);
      expect(git(root, 'branch', '--list', `ordewell/${run}/*`)).toBe('');
    });

    it('Start now after automatic merging at the run\'s end', async () => {
      const held = await heldAtRunEnd();
      const { session, hookAtSpawn, runner } = held;

      await startsAgain(held, () => ok(session, { command: 'run_task', task: 't2' }, USER));

      expect({ spawns: vi.mocked(runner.spawn).mock.calls.length, hookAtSpawn }).toEqual({ spawns: 2, hookAtSpawn: [false, true] });
    });
  });
});
