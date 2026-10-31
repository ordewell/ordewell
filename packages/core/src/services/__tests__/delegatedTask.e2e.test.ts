import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { LeaseHost } from '../sessionLease';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { Session } from '../createSession';
import type { ConversationRequest, ConversationTurn, IAiService } from '../AiService';
import type { IRunner } from '../../interfaces/IRunner';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { PlannerToolHandler } from '../mcp';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { saveSession } from '../../utils/sessionStore';
import { openTaskLog } from '../../utils/taskLogStore';
import { fakeFs, makeSession } from './sessionTestKit';

/*
 * A delegated task end to end, on real repositories (ADR-0055): a root plan
 * hands a goal to a child plan, its landed work comes back through the delegated
 * task's branch, and only the root touches the user's branch.
 */

const env = () => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k];
  return e;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

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

type Turn = (tools: PlannerToolHandler, text: string) => Promise<unknown>;

/** A subplanner with no process: each of its turns calls the tools a harness planner would, in order. */
function scriptedPlanner(turns: Turn[]): { service: Partial<IAiService>; requests: ConversationRequest[]; asked: string[] } {
  const requests: ConversationRequest[] = [];
  const asked: string[] = [];
  let handler: PlannerToolHandler | undefined;
  const next = async (text: string): Promise<ConversationTurn> => {
    asked.push(text);
    const turn = turns.shift();
    if (turn && handler) await turn(handler, text);
    return { kind: 'message', text: 'Done with this turn.', researchLog: [] };
  };
  return {
    requests,
    asked,
    service: {
      hasActiveConversation: () => handler !== undefined,
      plannerToolsAttached: () => true,
      restart: () => undefined,
      startConversation: async (req) => {
        requests.push(req);
        handler = req.plannerTools?.handler;
        return next(req.initialMessage ?? req.goal);
      },
      continueConversation: (text) => next(text),
    },
  };
}

/** Writes each task's files in the worktree it was handed, then reports done; a task with none reports done at once. */
function writingRunner(files: Record<string, string[]>): IRunner & { spawned: string[] } {
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
        session.reportComplete({ status: 'done', summary: 'Done.' });
      }, 5);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
}

const isolation = (): IWorktreeIsolation => createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) });
const planOf = (tasks: Task[]): LegacyPlanState => ({ tasks, runners: ['claude-code'], status: 'approved', generatedAt: '2026-11-01T10:00:00.000Z' } as unknown as LegacyPlanState);

const delegated = (over: Partial<Task> = {}) => createTask({
  id: 'd', order: 1, title: 'Delegated subtree', type: 'delegated', goal: 'Write a and b', budget: { tokens: 2_000_000 }, protectedPaths: ['tests/'], ...over,
});
const check = (over: Partial<Task> = {}) => createTask({ id: 'c', order: 2, title: 'Check the subtree', prompt: 'read it', dependencies: ['d'], ...over });

const SUBMIT = (tasks: unknown[]): Turn => async (tools) => {
  const reply = await tools.submitPlan!({ tasks: tasks as never }, { signal: new AbortController().signal });
  if (reply.isError) throw new Error(reply.text);
};

const childTask = (id: string, order: number, dependencies: string[] = []) => ({
  id, order, title: `Write ${id}`, description: id, type: 'ai', prompt: `write ${id}`, sliceType: 'AFK', autonomy: 'AFK', dependencies,
});

const DONE: Turn = async (tools) => {
  const reply = await tools.taskComplete!({ status: 'done', summary: 'Both files are written.', commit: { subject: 'Write a and b' } }, { signal: new AbortController().signal });
  if (reply.isError) throw new Error(reply.text);
};

interface Tree {
  root: string;
  parent: Session;
  planner: ReturnType<typeof scriptedPlanner>;
}

function tree(turns: Turn[], { runner = writingRunner({ a: ['a.txt'], b: ['b.txt'] }), tasks = [delegated(), check()], tokens = 5_000_000 }: { runner?: IRunner; tasks?: Task[]; tokens?: number } = {}): Tree {
  const root = repo();
  const planner = scriptedPlanner(turns);
  const parent = makeSession({
    runner, isolation: isolation(), workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: 'session-root',
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: tokens } }),
    delegationOffered: true,
    childDeps: () => ({ aiService: { reset: vi.fn(), ...planner.service } as unknown as IAiService, fsAdapter: { ...fakeFs(), getWorkspaceRoot: () => root } }),
  });
  parent.loadPlan(planOf(tasks), 'the root goal', root, { sessionId: 'session-root' });
  return { root, parent, planner };
}

const statusOf = (session: Session, id: string) => session.planTasks.find((t) => t.id === id)?.status;

describe('a delegated task', () => {
  it('plans and runs a child plan, and lands its work like any task', async () => {
    const { root, parent, planner } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), DONE]);
    const main = git(root, 'rev-parse', 'main');

    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });

    // The subplanner got the goal, on its token's tools.
    expect(planner.requests[0].plannerTools).toMatchObject({ subplanner: true });
    expect(planner.asked[0]).toContain('Write a and b');
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).toEqual(['README.md', 'a.txt', 'b.txt', 'tests/guard.txt']);
    expect(git(root, 'log', '-1', '--format=%s', integration)).toBe('Merge: Write a and b');
    // Only the root touches the user's branch.
    expect(git(root, 'rev-parse', 'main')).toBe(main);
    expect(existsSync(join(root, 'a.txt'))).toBe(false);
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ outcome: 'pass', reported: 'done' });
    parent.destroy();
  });
});
