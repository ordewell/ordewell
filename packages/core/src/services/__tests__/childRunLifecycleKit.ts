// Fixtures and helpers shared by the childRunLifecycle.e2e files (one file until it was split so CI's shards balance).

import { vi } from 'vitest';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { LeaseHost } from '../sessionLease';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { Session, SessionDeps } from '../createSession';
import type { ConversationRequest, ConversationTurn, IAiService } from '../AiService';
import type { PlannerToolHandler } from '../mcp';
import type { IRunner } from '../../interfaces/IRunner';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { loadChildSession, saveSession } from '../../utils/sessionStore';
import { openTaskLog } from '../../utils/taskLogStore';
import { fakeFs, makeSession, type PlannerTurn as Turn } from './sessionTestKit';

export const env = () => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k];
  return e;
};
export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export const roots: string[] = [];

export function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-child-run-')));
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

export interface Runner extends IRunner {
  spawned: string[];
  stopped: string[];
  /** Finishes what `held` keeps waiting. */
  release(taskId: string): void;
  /** Lets a stop `heldStops` keeps from resolving resolve. */
  letStop(taskId: string): void;
}

/** A runner that writes each task's files and reports done, but for the tasks named in `held`, which wait for {@link Runner.release}. */
export function fakeRunner(files: Record<string, string[]>, { held = [], heldOnce = [], heldStops = [], usage = 0 }: { held?: string[]; heldOnce?: string[]; heldStops?: string[]; usage?: number } = {}): Runner {
  const spawned: string[] = [];
  const stopped: string[] = [];
  const waiting = new Map<string, () => void>();
  const byId = new Map<string, string>();
  const stops = new Map<string, { gone: Promise<void>; go: () => void }>();
  return {
    spawned,
    stopped,
    release: (taskId) => waiting.get(taskId)?.(),
    letStop: (taskId) => stops.get(taskId)?.go(),
    spawn: vi.fn(async (opts) => {
      spawned.push(opts.taskId);
      const session = new FakeRunnerSession(`s-${opts.taskId}-${spawned.length}`, opts.taskId);
      byId.set(session.id, opts.taskId);
      const finish = () => {
        for (const file of files[opts.taskId] ?? []) {
          mkdirSync(dirname(join(opts.cwd, file)), { recursive: true });
          writeFileSync(join(opts.cwd, file), `written by ${opts.taskId}\n`);
        }
        if (usage > 0) session.emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: usage, outputTokens: 0 } } as never);
        session.reportComplete({ status: 'done', summary: 'Done.' });
      };
      if (held.includes(opts.taskId) || (heldOnce.includes(opts.taskId) && spawned.filter((id) => id === opts.taskId).length === 1)) waiting.set(opts.taskId, finish);
      else setTimeout(finish, 5);
      return session;
    }),
    stop: vi.fn(async (id: string) => {
      const taskId = byId.get(id) ?? id;
      stopped.push(taskId);
      if (!heldStops.includes(taskId)) return;
      if (!stops.has(taskId)) {
        let go = () => undefined as void;
        const gone = new Promise<void>((resolve) => { go = resolve; });
        stops.set(taskId, { gone, go });
      }
      await stops.get(taskId)?.gone;
    }),
    stopAll: vi.fn(),
    activeCount: 0,
  };
}

export const isolation = (): IWorktreeIsolation => createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) });

/** What a run changes in git: the calls `leasedIsolation` waits out as a Session closes. */
export const CHANGES = new Set(['stash', 'startRun', 'prepare', 'reopen', 'integrate', 'revert', 'release', 'handoff', 'pruneOrphans', 'mergeIntoCheckedOut', 'discard', 'sweep']);

/** Real git, telling each change to the run as it goes in, each held back until `before` resolves. */
export function watchedIsolation(changing: (change: string, ended: Promise<unknown>) => void, before: (change: string, args: unknown[]) => Promise<void> | void = () => undefined): IWorktreeIsolation {
  return new Proxy(isolation(), {
    get(target, key, receiver) {
      const member = Reflect.get(target, key, receiver) as unknown;
      const change = String(key);
      if (typeof member !== 'function' || !CHANGES.has(change)) return member;
      return (...args: unknown[]) => {
        const ended = Promise.resolve(before(change, args)).then(() => member.apply(target, args) as unknown);
        changing(change, ended);
        return ended;
      };
    },
  });
}

export const planOf = (tasks: Task[]): LegacyPlanState => ({ tasks, runners: ['claude-code'], status: 'approved', generatedAt: '2026-11-01T10:00:00.000Z' } as unknown as LegacyPlanState);

export const delegated = (over: Partial<Task> = {}) => createTask({
  id: 'd', order: 1, title: 'Delegated subtree', type: 'delegated', goal: 'Write a and b', budget: { tokens: 2_000_000 }, protectedPaths: ['tests/'], ...over,
});
export const check = (over: Partial<Task> = {}) => createTask({ id: 'c', order: 2, title: 'Check the subtree', prompt: 'read it', dependencies: ['d'], ...over });

export const SIGNAL: AbortSignal = new AbortController().signal;

export const SUBMIT = (tasks: unknown[]): Turn => async (tools) => {
  const reply = await tools.submitPlan!({ tasks: tasks as never }, { signal: SIGNAL });
  if (reply.isError) throw new Error(reply.text);
};

export const childTask = (id: string, order: number, dependencies: string[] = []) => ({
  id, order, title: `Write ${id}`, description: id, type: 'ai', prompt: `write ${id}`, sliceType: 'AFK', autonomy: 'AFK', dependencies,
});

export const DONE: Turn = async (tools) => {
  const reply = await tools.taskComplete!({ status: 'done', summary: 'It is written.', commit: { subject: 'Write it' } }, { signal: SIGNAL });
  if (reply.isError) throw new Error(reply.text);
};
export const NOTHING: Turn = async () => undefined;
export const BLOCKED: Turn = async (tools) => {
  await tools.taskComplete!({ status: 'blocked', summary: 'Not now.', reason: 'Nothing is ready.' }, { signal: SIGNAL });
};

export interface TreeOptions {
  runner?: IRunner;
  isolated?: IWorktreeIsolation;
  tasks?: Task[];
  tokens?: () => number;
  /** The root's repository, for a second Session over the same files. */
  root?: string;
  leaseHost?: LeaseHost;
  plan?: LegacyPlanState;
  sessionId?: string;
  /** What the root's own planner does, for a test of its edits. */
  rootTurns?: Turn[];
  notifications?: SessionDeps['notifications'];
  /** The root's Parallel limit, which holds across the tree (ADR-0055 D18). */
  parallel?: number;
  /** Its subplanners' harness keeps no session, as an API planner does. */
  sessionless?: boolean;
}

/**
 * A scripted planner, one service per child as a real Session builds one, so a
 * reopened child starts on its own token. A stop of the turn in flight ends it.
 */
export function stoppablePlanner(turns: Turn[], { sessionless = false } = {}) {
  const asked: string[] = [];
  const requests: ConversationRequest[] = [];
  const natives: string[] = [];
  const service = () => {
    let handler: PlannerToolHandler | undefined;
    const native = `native-${randomUUID()}`;
    const next = async (text: string, signal: AbortSignal | undefined): Promise<ConversationTurn> => {
      asked.push(text);
      const turn = turns.shift();
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true });
        (turn && handler ? turn(handler, text) : Promise.resolve()).then(() => resolve(), reject);
      });
      return { kind: 'message', text: 'Done with this turn.', researchLog: [] };
    };
    return {
      reset: vi.fn(),
      hasActiveConversation: () => handler !== undefined,
      plannerToolsAttached: () => true,
      restart: () => undefined,
      ...(sessionless ? {} : { nativeSession: () => (handler ? { runner: 'claude-code', sessionId: native, cwd: '/worktree' } : null) }),
      startConversation: async (req: ConversationRequest) => {
        requests.push(req);
        handler = req.plannerTools?.handler;
        natives.push(native);
        return next(req.initialMessage ?? req.goal, req.signal);
      },
      continueConversation: (text: string, _progress?: unknown, signal?: AbortSignal) => next(text, signal),
    } as unknown as IAiService;
  };
  return { asked, requests, natives, service };
}

export function tree(turns: Turn[], { runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }), isolated = isolation(), tasks = [delegated(), check()], tokens = () => 5_000_000, root = repo(), leaseHost = new LeaseHost(), plan, sessionId = 'session-root', rootTurns, notifications, parallel = 3, sessionless }: TreeOptions = {}) {
  const planner = stoppablePlanner(turns, { sessionless });
  const parent = makeSession({
    runner, isolation: isolated, workspaceRoot: () => root, saveSession, openTaskLog, leaseHost, sessionId,
    ...(rootTurns ? { aiService: stoppablePlanner(rootTurns).service() } : {}),
    ...(notifications ? { notifications } : {}),
    config: fakeConfig({ maxParallelSessions: parallel }),
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: tokens() } }),
    delegationOffered: true,
    childDeps: () => ({ aiService: planner.service(), fsAdapter: { ...fakeFs(), canSeal: async () => true, getWorkspaceRoot: () => root } }),
  });
  parent.loadPlan(plan ?? planOf(tasks), 'the root goal', root, { sessionId });
  return { root, parent, planner };
}

export const statusOf = (session: Session, id: string) => session.planTasks.find((t) => t.id === id)?.status;
export const taskOf = (session: Session, id: string) => session.planTasks.find((t) => t.id === id)!;

export const worktrees = (root: string) => git(root, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
export const branches = (root: string) => git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');
export const childIdOf = (session: Session, id: string) => session.planState?.isolation?.run.tasks[id]?.childSession;
export const worktreesOf = (root: string, sessionRun: string | undefined) => worktrees(root).filter((dir) => sessionRun && dir.includes(sessionRun));

/** The child's run, as its saved file names it. */
export function childRunId(root: string, childSession: string): string | undefined {
  return loadChildSession({ baseDir: root, rootSessionId: 'session-root', sessionId: childSession })?.plan.isolation?.run.id;
}

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const rowOf = (session: Session, id: string) => session.runSnapshot().tasks.find((task) => task.id === id)?.delegation;
