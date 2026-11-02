import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { vi } from 'vitest';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { LeaseHost } from '../sessionLease';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { Session, SessionDeps } from '../createSession';
import type { IAiService } from '../AiService';
import type { IRunner } from '../../interfaces/IRunner';
import type { IConfig } from '../../interfaces/IConfig';
import type { PlannerToolHandler } from '../mcp';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { saveSession } from '../../utils/sessionStore';
import { openTaskLog } from '../../utils/taskLogStore';
import { treeEventLogFile } from '../../utils/treeEventLog';
import type { NodePath, TreeEvent } from '../../models/TreeEvent';
import { fakeFs, makeSession, sealingFs, scriptedPlanner, type PlannerTurn as Turn } from './sessionTestKit';

/** One real repository, one root Session and a scripted subplanner: a delegated task as a test drives it. */

const env = () => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k];
  return e;
};
export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const roots: string[] = [];
const closing: Session[] = [];

/** Call from `afterEach`: a Session's `destroy` returns with its release of a worktree still in git, and `gone` is what says it ended. */
export async function removeRepos(): Promise<void> {
  await Promise.all(closing.splice(0).map((session) => session.gone));
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function repo(): string {
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

/** A workspace that is a folder of its repository, committed so that its worktree has it. */
function workspaceIn(root: string, folder: string): string {
  const workspace = join(root, folder);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'README.md'), 'a package\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'a package');
  return workspace;
}

export interface WorkerReport { status?: 'done' | 'blocked' | 'failed'; summary?: string; reason?: string; findings?: { severity: 'blocker' | 'major' | 'minor' | 'info'; title: string; detail?: string }[] }

/** Writes each task's files in the worktree it was handed, then reports as `reports` says; `usage` tokens are reported first. */
export function writingRunner(files: Record<string, string[]>, { usage = 0, reports = {} }: { usage?: number; reports?: Record<string, WorkerReport> } = {}): IRunner & { spawned: string[] } {
  const spawned: string[] = [];
  return {
    spawned,
    spawn: vi.fn(async (opts) => {
      spawned.push(opts.taskId);
      const session = new FakeRunnerSession(`s-${opts.taskId}-${spawned.length}`, opts.taskId);
      setTimeout(() => {
        for (const file of files[opts.taskId] ?? []) {
          mkdirSync(dirname(join(opts.cwd, file)), { recursive: true });
          writeFileSync(join(opts.cwd, file), `written by ${opts.taskId}\n`);
        }
        if (usage > 0) session.emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'opus', inputTokens: usage, outputTokens: 0 } } as never);
        session.reportComplete({ status: 'done', summary: 'Done.', ...reports[opts.taskId] } as never);
      }, 5);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
}

export const delegated = (over: Partial<Task> = {}) => createTask({
  id: 'd', order: 1, title: 'Delegated subtree', type: 'delegated', goal: 'Write a and b', budget: { tokens: 2_000_000 }, protectedPaths: ['tests/'], ...over,
});
export const check = (over: Partial<Task> = {}) => createTask({ id: 'c', order: 2, title: 'Check the subtree', prompt: 'read it', dependencies: ['d'], ...over });

export const childTask = (id: string, order: number, dependencies: string[] = []) => ({
  id, order, title: `Write ${id}`, description: id, type: 'ai', prompt: `write ${id}`, sliceType: 'AFK', autonomy: 'AFK', dependencies,
});

export const SUBMIT = (tasks: unknown[]): Turn => async (tools) => {
  const reply = await tools.submitPlan!({ tasks: tasks as never }, { signal: new AbortController().signal });
  if (reply.isError) throw new Error(reply.text);
};

/** The call a subplanner ends with, its reply kept in `replies`. */
export const CALL = (report: Parameters<NonNullable<PlannerToolHandler['taskComplete']>>[0], replies: { text: string; isError?: boolean }[] = []): Turn => async (tools) => {
  replies.push(await tools.taskComplete!(report, { signal: new AbortController().signal }));
};

export const DONE = CALL({ status: 'done', summary: 'Both files are written.', commit: { subject: 'Write a and b' } });

export interface Tree {
  root: string;
  parent: Session;
  planner: ReturnType<typeof scriptedPlanner>;
  /** The subplanners `below` scripted, by their task's id. */
  lower: Record<string, ReturnType<typeof scriptedPlanner>>;
  /** The root's config, which a test may change under a running child. */
  config: IConfig;
}

export interface TreeOptions {
  /** The workspace is this folder of the repository, not its root. */
  folder?: string;
  runner?: IRunner;
  tasks?: Task[];
  settings?: Partial<ReturnType<SessionDeps['settings']>>;
  /** Turns of the subplanner of a task further down, by that task's id: `turns` are the first level's. */
  below?: Record<string, Turn[]>;
  /** The root's Parallel limit, which holds across the tree (ADR-0055 D18). */
  parallel?: number;
  /** The root's config, when a test changes a live setting under a running child. */
  config?: IConfig;
  /** What runs script tasks, as a test watches what a child's script was given. */
  scriptRunner?: IRunner;
  /** Whether a child can seal a script. */
  seals?: boolean;
  /** Turns of the root's own planner, as a test talks to it with a child running. */
  rootTurns?: Turn[];
}

export function tree(turns: Turn[], { runner = writingRunner({ a: ['a.txt'], b: ['b.txt'] }), tasks = [delegated(), check()], settings = {}, below = {}, parallel = 3, config, scriptRunner, seals = false, rootTurns, folder }: TreeOptions = {}): Tree {
  const root = folder ? workspaceIn(repo(), folder) : repo();
  const rootConfig = config ?? fakeConfig({ maxParallelSessions: parallel });
  const planner = scriptedPlanner(turns);
  const lower = Object.fromEntries(Object.entries(below).map(([id, script]) => [id, scriptedPlanner(script)]));
  const isolation = createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) });
  const parent = makeSession({
    ...(rootTurns ? { aiService: { reset: vi.fn(), ...scriptedPlanner(rootTurns).service } as unknown as IAiService } : {}),
    runner, scriptRunner, isolation, workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: 'session-root',
    config: rootConfig,
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: 5_000_000 }, ...settings }),
    delegationOffered: true,
    childDeps: (task) => ({ aiService: { reset: vi.fn(), ...(lower[task.id] ?? planner).service } as unknown as IAiService, fsAdapter: { ...fakeFs(), ...(seals ? sealingFs() : {}), getWorkspaceRoot: () => root } }),
  });
  const plan = { tasks, runners: ['claude-code'], status: 'approved', generatedAt: '2026-11-01T10:00:00.000Z' } as unknown as LegacyPlanState;
  parent.loadPlan(plan, 'the root goal', root, { sessionId: 'session-root' });
  closing.push(parent);
  return { root, parent, planner, lower, config: rootConfig };
}

export const taskOf = (session: Session, id: string) => session.planTasks.find((t) => t.id === id);

/**
 * Where `taskId`'s child sits in the tree. Siblings open at once, so the number a
 * node gets is whichever claims the tree first, not the task's order: ask the log.
 */
export function nodeOfTask(root: string, taskId: string, rootSessionId = 'session-root'): NodePath {
  const opened = readFileSync(treeEventLogFile(rootSessionId, root), 'utf8').trim().split('\n')
    .flatMap((line) => JSON.parse(line) as TreeEvent[])
    .find((event) => event.kind === 'node_opened' && event.taskId === taskId);
  if (!opened) throw new Error(`no node was opened for ${taskId}`);
  return opened.node;
}
