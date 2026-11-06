// Fixtures and helpers shared by the childNavigation.e2e files (one file until it was split so CI's shards balance).

import { vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { LeaseHost } from '../sessionLease';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { SessionMessage } from '../SessionMessage';
import type { IAiService } from '../AiService';
import type { IRunner } from '../../interfaces/IRunner';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { saveSession } from '../../utils/sessionStore';
import { openTaskLog } from '../../utils/taskLogStore';
import { fakeFs, makeSession, scriptedPlanner, type PlannerTurn as Turn } from './sessionTestKit';

export const env = () => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k];
  return e;
};
export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export const roots: string[] = [];

export function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-navigate-')));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'tests', 'guard.txt'), 'the check reads this\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

/** The tasks named in `held` wait until {@link release}; the rest write their file and report done. */
export function heldTasks(held: string[], writes: Record<string, string> = {}) {
  const spawned: string[] = [];
  const waiting = new Map<string, () => void>();
  const sessions = new Map<string, FakeRunnerSession>();
  const runner: IRunner & { spawned: string[] } = {
    spawned,
    spawn: vi.fn(async (opts) => {
      spawned.push(opts.taskId);
      const session = new FakeRunnerSession(`s-${opts.taskId}-${spawned.length}`, opts.taskId);
      sessions.set(opts.taskId, session);
      const finish = () => {
        writeFileSync(join(opts.cwd, writes[opts.taskId] ?? `${opts.taskId}.txt`), `written by ${opts.taskId}\n`);
        session.reportComplete({ status: 'done', summary: 'Done.' });
      };
      if (held.includes(opts.taskId)) waiting.set(opts.taskId, finish);
      else setTimeout(finish, 5);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
  return { runner, sessions, release: (taskId: string) => waiting.get(taskId)?.() };
}

export const isolation = () => createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) });
export const planOf = (tasks: Task[]): LegacyPlanState => ({ tasks, runners: ['claude-code'], status: 'approved', generatedAt: '2026-11-01T10:00:00.000Z' } as unknown as LegacyPlanState);

export const delegated = (over: Partial<Task> = {}) => createTask({
  id: 'd', order: 1, title: 'Delegated subtree', type: 'delegated', goal: 'Write a', budget: { tokens: 2_000_000 }, protectedPaths: ['tests/'], ...over,
});
export const childTask = (id: string, order: number, dependencies: string[] = []) => ({
  id, order, title: `Write ${id}`, description: id, type: 'ai', prompt: `write ${id}`, sliceType: 'AFK', autonomy: 'AFK', dependencies,
});
export const nestedTask = (id: string, order: number) => ({
  id, order, title: `Nested ${id}`, description: id, type: 'delegated', goal: `Reach ${id}`, budget: { tokens: 800_000 }, protectedPaths: ['tests/'], sliceType: 'AFK', dependencies: [],
});
export const nestedCheck = (id: string, order: number, of: string) => ({ ...childTask(id, order, [of]), title: `Check ${of}`, readOnly: true });

export const SUBMIT = (tasks: unknown[]): Turn => async (tools) => {
  const reply = await tools.submitPlan!({ tasks: tasks as never }, { signal: new AbortController().signal });
  if (reply.isError) throw new Error(reply.text);
};
export const DONE: Turn = async (tools) => {
  const reply = await tools.taskComplete!({ status: 'done', summary: 'All written.', commit: { subject: 'Write it' } }, { signal: new AbortController().signal });
  if (reply.isError) throw new Error(reply.text);
};

export const REPLY: Turn = async () => undefined;

export interface TreeOptions { runner: IRunner; tasks?: Task[]; parallel?: number }

/** A root over delegated tasks, each child's planner reading its task's own turns: `{ d: [...], n: [...] }`. */
export function tree(turns: Record<string, Turn[]>, { runner, tasks = [delegated({ grants: ['delegate'] })], parallel = 3 }: TreeOptions) {
  const root = repo();
  const planners = Object.fromEntries(Object.entries(turns).map(([id, script]) => [id, scriptedPlanner(script)]));
  const frames: SessionMessage[] = [];
  const parent = makeSession({
    runner, isolation: isolation(), workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: 'session-root', broadcast: (frame) => frames.push(frame),
    config: fakeConfig({ maxParallelSessions: parallel }),
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: 5_000_000, mergeAtGatesAutomatically: false } }),
    delegationOffered: true,
    childDeps: (task) => ({ aiService: { reset: vi.fn(), ...planners[task.id].service } as unknown as IAiService, fsAdapter: { ...fakeFs(), getWorkspaceRoot: () => root } }),
  });
  parent.loadPlan(planOf(tasks), 'the root goal', root, { sessionId: 'session-root' });
  return { root, parent, planners, frames };
}

export const WAIT = { timeout: 20_000 };

export function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
