// Fixtures shared by the heldConfigStart e2e files: a start held because configuration an earlier task landed differs from where its run started (ADR-0028), on real git.

import { expect, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { ExecutionActor } from '../../models/Execution';
import type { Session } from '../createSession';
import { fakeConfig, FakeRunnerSession, removeDir } from '../../testing';
import { closeSessions, fakeNotification, makeSession } from './sessionTestKit';

export const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

export function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Whether `ref` names a commit in `root`. */
export function refExists(root: string, ref: string): boolean {
  try { git(root, 'rev-parse', '--verify', '-q', `${ref}^{commit}`); return true; } catch { return false; }
}

const roots: string[] = [];

/** For each e2e file's `afterEach`. */
export async function cleanUp(): Promise<void> {
  await closeSessions();
  while (roots.length) await removeDir(roots.pop()!);
}

/** A fresh repository whose first commit holds a README and `files`. */
export function repo(files: readonly string[] = []): string {
  // Native, as git names a path: on Windows the JS realpath keeps the 8.3 short name of the temp folder.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ordewell-held-config-')));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '{}\n');
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

export const HOOK = '.claude/settings.json';
const HOOK_BODY = '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo started"}]}]}}\n';
export const SUPERVISOR: ExecutionActor = { kind: 'supervisor', level: 'act' };
export const USER: ExecutionActor = { kind: 'user' };
export const PLANNER: ExecutionActor = { kind: 'planner-turn' };

/**
 * One task of a plan {@link heldPlan} builds: `hook` lands the configuration,
 * `ops` works in the checkout and writes nothing; `writes` names the file it
 * writes instead, ops or not, and `removes` one it deletes.
 */
export interface HeldTask {
  id: string;
  title: string;
  dependencies?: string[];
  hook?: true;
  ops?: true;
  writes?: string;
  removes?: string;
}

/**
 * A session over a fresh repository whose runner records, at each spawn, which
 * task it is and whether the hook is where the runner starts. A `hook` task
 * writes the hook, an ops task nothing, any other task `<id>.txt`, which says
 * which attempt wrote it. The tasks in `hold` keep running until
 * {@link HeldPlan.release}, and those in `holdOnce` only at their first spawn;
 * the others finish at once. A start held for configuration never reaches the
 * runner, so it records no spawn. `autonomous` runs it in Full, where a
 * model's start goes unasked; its tasks' mode, `acceptEdits`, is not one
 * Claude Code offers for Full, so their starts are checked there too (ADR-0028).
 */
export function heldPlan(tasks: readonly HeldTask[], { hold = [], holdOnce = [], mergeAtGatesAutomatically = false, autonomous = false, mode = 'acceptEdits', files = [] }: {
  hold?: readonly string[]; holdOnce?: readonly string[]; mergeAtGatesAutomatically?: boolean; autonomous?: boolean;
  /** The mode every task runs in. */
  mode?: string;
  /** What the repository's first commit holds besides its README. */
  files?: readonly string[];
} = {}) {
  const root = repo(files);
  const spawned: string[] = [];
  const hookAtSpawn: boolean[] = [];
  const cwds: string[] = [];
  const finish = new Map<string, () => void>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let ids = 0;
  const runner: IRunner = {
    spawn: vi.fn(async (opts) => {
      spawned.push(opts.taskId);
      cwds.push(opts.cwd!);
      hookAtSpawn.push(existsSync(join(opts.cwd!, HOOK)));
      const attempt = spawned.filter((id) => id === opts.taskId).length;
      const session = new FakeRunnerSession(`s${spawned.length}`, opts.taskId);
      const spec = byId.get(opts.taskId);
      const done = () => {
        if (spec?.removes) rmSync(join(opts.cwd!, spec.removes), { force: true });
        if (spec?.writes) {
          mkdirSync(dirname(join(opts.cwd!, spec.writes)), { recursive: true });
          writeFileSync(join(opts.cwd!, spec.writes), '{}\n');
        } else if (!spec?.ops && !spec?.removes) {
          const file = spec?.hook ? HOOK : `${opts.taskId}.txt`;
          mkdirSync(dirname(join(opts.cwd!, file)), { recursive: true });
          writeFileSync(join(opts.cwd!, file), spec?.hook ? HOOK_BODY : `${opts.taskId} attempt ${attempt}\n`);
        }
        session.reportComplete({ status: 'done', summary: 'Done.' });
      };
      if (hold.includes(opts.taskId) || (holdOnce.includes(opts.taskId) && attempt === 1)) finish.set(opts.taskId, done);
      else setTimeout(done, 5);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
  // Guarded unless asked, where a start is held for configuration whatever its runner's mode (ADR-0028).
  const config = fakeConfig({ worktreeIsolation: true, autonomousMode: autonomous });
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
    tasks: tasks.map((t, i): Task => createTask({
      id: t.id, order: i + 1, title: t.title, prompt: t.title, assignedRunner: 'claude-code', taskMode: mode,
      ...(t.dependencies ? { dependencies: t.dependencies } : {}), ...(t.ops ? { ops: true } : {}),
    })),
    generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now,
  };
  session.loadPlan(plan, 'goal', root, { persist: false });
  const titleOf = (id: string) => byId.get(id)?.title ?? id;
  const holdOf = (id: string) => session.runSnapshot().tasks.find((t) => t.id === id)?.holdReason ?? null;
  const holds = (id: string) => told().filter((line) => line.startsWith(`Task "${titleOf(id)}" is on hold: `)).length;
  const statusOf = (id: string) => session.planTasks.find((t) => t.id === id)?.status;
  const spawns = (id: string) => spawned.filter((s) => s === id).length;
  /** Whether the hook was where `id`'s runner started, at each of its spawns. */
  const hookFor = (id: string) => spawned.flatMap((s, i) => (s === id ? [hookAtSpawn[i]] : []));
  /** The cwd of `id`'s last spawn. */
  const lastCwd = (id: string) => cwds[spawned.lastIndexOf(id)];
  return {
    root, session, runner, spawned, hookAtSpawn, holdOf, told, holds, statusOf, spawns, hookFor, lastCwd,
    release: (id: string) => finish.get(id)?.(),
    runId: () => session.planState?.isolation?.run.id,
    records: () => Object.fromEntries(Object.entries(session.planState?.isolation?.run.tasks ?? {}).map(([id, r]) => [id, r.status])),
    /** What `file` holds on `ref`, or null where it holds none. */
    fileOn: (ref: string, file: string) => { try { return git(root, 'show', `${ref}:${file}`); } catch { return null; } },
    inCheckout: (file: string) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : null),
  };
}

export type HeldPlan = ReturnType<typeof heldPlan>;

export async function ok(session: Session, command: Parameters<Session['execute']>[0], actor: ExecutionActor): Promise<void> {
  const outcome = await session.execute(command, actor);
  expect(outcome, outcome.message).toMatchObject({ ok: true });
}

/** `id` started again by `start`, once that start has ended: held again, or run to the end. */
export async function startsAgain(held: HeldPlan, id: string, start: () => Promise<void>): Promise<void> {
  const before = held.holds(id);
  const spawnsBefore = held.spawns(id);
  await start();
  await vi.waitFor(() => expect(held.holds(id) > before || held.spawns(id) > spawnsBefore).toBe(true), { timeout: 20_000 });
  if (held.spawns(id) > spawnsBefore) await vi.waitFor(() => expect(held.statusOf(id)).toBe('completed'), { timeout: 20_000 });
}
