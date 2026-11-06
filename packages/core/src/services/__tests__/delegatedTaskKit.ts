// Fixtures and helpers shared by the delegatedTask.e2e files (one file until it was split so CI's shards balance).

import { expect, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { LeaseHost } from '../sessionLease';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { Session } from '../createSession';
import type { IAiService } from '../AiService';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import type { IRunner } from '../../interfaces/IRunner';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-delegated-')));
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

/** Writes each task's files in the worktree it was handed, then reports done; a task with none reports done at once. */
export function writingRunner(files: Record<string, string[]>, { usage = 0, asks }: { usage?: number; asks?: (session: FakeRunnerSession) => void } = {}): IRunner & { spawned: string[] } {
  const spawned: string[] = [];
  return {
    spawned,
    spawn: vi.fn(async (opts) => {
      spawned.push(opts.taskId);
      const session = new FakeRunnerSession(`s-${opts.taskId}-${spawned.length}`, opts.taskId);
      const finish = () => {
        for (const file of files[opts.taskId] ?? []) {
          mkdirSync(dirname(join(opts.cwd, file)), { recursive: true });
          writeFileSync(join(opts.cwd, file), `written by ${opts.taskId}\n`);
        }
        if (usage > 0) session.emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: usage, outputTokens: 0 } } as never);
        session.reportComplete({ status: 'done', summary: 'Done.' });
      };
      setTimeout(() => {
        if (!asks) { finish(); return; }
        // It goes on only once it is answered: an attempt's end denies what it left open, which would prove nothing.
        asks(session);
        session.requestPermission('perm-1', 'Bash', { command: 'rm -rf /' });
        const answered = setInterval(() => {
          if (session.answers.length === 0) return;
          clearInterval(answered);
          finish();
        }, 5);
      }, 5);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
}

/** As {@link writingRunner}, but the tasks named in `held` wait until {@link release}, and a Stop reaches each. */
export function heldTasks(files: Record<string, string[]>, held: string[]) {
  const spawned: string[] = [];
  const stopped: string[] = [];
  const waiting = new Map<string, () => void>();
  const byId = new Map<string, string>();
  const runner: IRunner & { spawned: string[] } = {
    spawned,
    spawn: vi.fn(async (opts) => {
      spawned.push(opts.taskId);
      const session = new FakeRunnerSession(`s-${opts.taskId}-${spawned.length}`, opts.taskId);
      byId.set(session.id, opts.taskId);
      const finish = () => {
        for (const file of files[opts.taskId] ?? []) writeFileSync(join(opts.cwd, file), `written by ${opts.taskId}\n`);
        session.reportComplete({ status: 'done', summary: 'Done.' });
      };
      if (held.includes(opts.taskId)) waiting.set(opts.taskId, finish);
      else setTimeout(finish, 5);
      return session;
    }),
    stop: vi.fn(async (id: string) => { stopped.push(byId.get(id) ?? id); }),
    stopAll: vi.fn(),
    activeCount: 0,
  };
  return { runner, stopped, release: (taskId: string) => waiting.get(taskId)?.() };
}

export const isolation = (): IWorktreeIsolation => createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) });
export const planOf = (tasks: Task[]): LegacyPlanState => ({ tasks, runners: ['claude-code'], status: 'approved', generatedAt: '2026-11-01T10:00:00.000Z' } as unknown as LegacyPlanState);

export const delegated = (over: Partial<Task> = {}) => createTask({
  id: 'd', order: 1, title: 'Delegated subtree', type: 'delegated', goal: 'Write a and b', budget: { tokens: 2_000_000 }, protectedPaths: ['tests/'], ...over,
});
export const check = (over: Partial<Task> = {}) => createTask({ id: 'c', order: 2, title: 'Check the subtree', prompt: 'read it', dependencies: ['d'], ...over });

export const SUBMIT = (tasks: unknown[]): Turn => async (tools) => {
  const reply = await tools.submitPlan!({ tasks: tasks as never }, { signal: new AbortController().signal });
  if (reply.isError) throw new Error(reply.text);
};

export const childTask = (id: string, order: number, dependencies: string[] = []) => ({
  id, order, title: `Write ${id}`, description: id, type: 'ai', prompt: `write ${id}`, sliceType: 'AFK', autonomy: 'AFK', dependencies,
});

export const NOTHING_THEN_BLOCKED: Turn = async (tools) => {
  await tools.taskComplete!({ status: 'blocked', summary: 'Not now.', reason: 'Nothing is ready.' }, { signal: new AbortController().signal });
};

/** Writes `a.txt` and passes every task but the check, which fails. */
export function failingCheck(): IRunner {
  const inner = writingRunner({ a: ['a.txt'] });
  return {
    ...inner,
    spawn: vi.fn(async (opts) => {
      if (opts.taskId !== 'c') return inner.spawn(opts);
      const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
      setTimeout(() => session.reportComplete({ status: 'failed', summary: 'It does not hold.', reason: 'It does not hold.' }), 5);
      return session;
    }),
  };
}

/** Writes `a.txt`, and the check `c` waits for {@link release} each time it runs. */
export function heldChecks() {
  const inner = writingRunner({ a: ['a.txt'] });
  const ends: Array<() => void> = [];
  const runner: IRunner = {
    ...inner,
    spawn: vi.fn(async (opts) => {
      if (opts.taskId !== 'c') return inner.spawn(opts);
      const session = new FakeRunnerSession(`s-c-${ends.length}`, opts.taskId);
      ends.push(() => session.reportComplete({ status: 'done', summary: 'It holds.' }));
      return session;
    }),
  };
  // In progress comes before its session: a release waits for the one it ends.
  return { runner, release: () => vi.waitFor(() => { expect(ends.length).toBeGreaterThan(0); ends.shift()?.(); }, { timeout: 20_000 }) };
}

export const DONE: Turn = async (tools) => {
  const reply = await tools.taskComplete!({ status: 'done', summary: 'Both files are written.', commit: { subject: 'Write a and b' } }, { signal: new AbortController().signal });
  if (reply.isError) throw new Error(reply.text);
};
export const CALL_BLOCKED: Turn = async (tools) => {
  await tools.taskComplete!({ status: 'blocked', summary: 'Not now.', reason: 'Nothing is ready.' }, { signal: new AbortController().signal });
};

export interface Tree {
  root: string;
  parent: Session;
  planner: ReturnType<typeof scriptedPlanner>;
}

export interface TreeOptions { runner?: IRunner; tasks?: Task[]; tokens?: () => number; parallel?: number; offered?: boolean; runners?: string[]; fsAdapter?: IFileSystem; merges?: boolean; config?: Parameters<typeof fakeConfig>[0] }

export function tree(turns: Turn[], { runner = writingRunner({ a: ['a.txt'], b: ['b.txt'] }), tasks = [delegated(), check()], tokens = () => 5_000_000, parallel = 3, offered = true, runners = ['claude-code'], fsAdapter, merges = false, config = {} }: TreeOptions = {}): Tree {
  const root = repo();
  const planner = scriptedPlanner(turns);
  const parent = makeSession({
    runner, isolation: isolation(), workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: 'session-root',
    config: fakeConfig({ maxParallelSessions: parallel, ...config }),
    ...(fsAdapter ? { fsAdapter } : {}),
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: tokens(), mergeAtGatesAutomatically: merges } }),
    delegationOffered: offered,
    childDeps: () => ({ aiService: { reset: vi.fn(), ...planner.service } as unknown as IAiService, fsAdapter: fsAdapter ?? { ...fakeFs(), getWorkspaceRoot: () => root } }),
  });
  parent.loadPlan({ ...planOf(tasks), runners }, 'the root goal', root, { sessionId: 'session-root' });
  return { root, parent, planner };
}

export const statusOf = (session: Session, id: string) => session.planTasks.find((t) => t.id === id)?.status;
