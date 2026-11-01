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
function writingRunner(files: Record<string, string[]>, { usage = 0 }: { usage?: number } = {}): IRunner & { spawned: string[] } {
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
        if (usage > 0) session.emitEvent({ type: 'usage', record: { source: 'claude-code', inputTokens: usage, outputTokens: 0 } } as never);
        session.reportComplete({ status: 'done', summary: 'Done.' });
      }, 5);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
}

/** As {@link writingRunner}, but the tasks named in `held` wait until {@link release}, and a Stop reaches each. */
function heldTasks(files: Record<string, string[]>, held: string[]) {
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

interface TreeOptions { runner?: IRunner; tasks?: Task[]; tokens?: number; parallel?: number; offered?: boolean; runners?: string[] }

function tree(turns: Turn[], { runner = writingRunner({ a: ['a.txt'], b: ['b.txt'] }), tasks = [delegated(), check()], tokens = 5_000_000, parallel = 3, offered = true, runners = ['claude-code'] }: TreeOptions = {}): Tree {
  const root = repo();
  const planner = scriptedPlanner(turns);
  const parent = makeSession({
    runner, isolation: isolation(), workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: 'session-root',
    config: fakeConfig({ maxParallelSessions: parallel }),
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: tokens } }),
    delegationOffered: offered,
    childDeps: () => ({ aiService: { reset: vi.fn(), ...planner.service } as unknown as IAiService, fsAdapter: { ...fakeFs(), getWorkspaceRoot: () => root } }),
  });
  parent.loadPlan({ ...planOf(tasks), runners }, 'the root goal', root, { sessionId: 'session-root' });
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

  it('runs while its sibling runs, its check after it, and only the root\'s Merge all reaches the user\'s branch', async () => {
    const held = heldTasks({ a: ['a.txt'], b: ['b.txt'], s: ['s.txt'] }, ['s']);
    const { root, parent } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), DONE], {
      runner: held.runner,
      tasks: [delegated(), createTask({ id: 's', order: 2, title: 'Sibling', prompt: 'sibling' }), check({ order: 3 })],
    });
    const main = git(root, 'rev-parse', 'main');

    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(held.runner.spawned).toEqual(expect.arrayContaining(['s', 'a', 'b'])), { timeout: 20_000 });
    // The child finished beside a sibling that is still at work.
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(statusOf(parent, 's')).toBe('in_progress');
    held.release('s');
    await vi.waitFor(() => expect(parent.planTasks.map((t) => t.status)).toEqual(['completed', 'completed', 'completed']), { timeout: 20_000 });
    expect(held.runner.spawned.indexOf('c')).toBeGreaterThan(held.runner.spawned.indexOf('b'));

    expect(git(root, 'rev-parse', 'main')).toBe(main);
    expect(await parent.execute({ command: 'merge_all' }, { kind: 'user' })).toMatchObject({ ok: true, payload: { kind: 'merge', result: { outcome: 'merged' } } });
    for (const file of ['a.txt', 'b.txt', 's.txt']) expect(existsSync(join(root, file))).toBe(true);
    parent.destroy();
  });

  it('holds no slot: a parent at its limit leaves room for the child it waits on (D18)', async () => {
    const held = heldTasks({ a: ['a.txt'], s: ['s.txt'] }, ['s']);
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], {
      runner: held.runner,
      parallel: 1,
      tasks: [delegated(), check(), createTask({ id: 's', order: 3, title: 'Sibling', prompt: 'sibling' })],
    });

    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('in_progress'));
    await vi.waitFor(() => expect(held.runner.spawned).toContain('s'));
    // A sibling holds the one slot, the delegated task runs beside it and holds none, and its subplanner's turn waits in the queue.
    held.release('s');
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('starts while its parent\'s only slot is held by nothing else, its child\'s tasks taking it one at a time', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), DONE], { parallel: 1 });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });
});

describe('the verdict (ADR-0055 D6)', () => {
  const REPLIES: { text: string; isError?: boolean }[] = [];
  afterEach(() => { REPLIES.length = 0; });

  const CALL = (report: Parameters<NonNullable<PlannerToolHandler['taskComplete']>>[0]): Turn => async (tools) => {
    REPLIES.push(await tools.taskComplete!(report, { signal: new AbortController().signal }));
  };
  const SAYS_DONE = CALL({ status: 'done', summary: 'It is done.' });
  const NOTHING: Turn = async () => undefined;

  it('refuses a done while its plan still runs, naming what is unfinished, and leaves the attempt open', async () => {
    const held = heldTasks({ a: ['a.txt'] }, ['a']);
    const signal = new AbortController().signal;
    const EARLY: Turn = async (tools) => {
      await tools.submitPlan!({ tasks: [childTask('a', 1)] as never }, { signal });
      await tools.runPlan!({}, { signal });
      REPLIES.push(await tools.taskComplete!({ status: 'done', summary: 'It is done.' }, { signal }));
      held.release('a');
    };
    const { parent } = tree([EARLY, DONE], { runner: held.runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(REPLIES[0]).toMatchObject({ isError: true, text: expect.stringContaining('Not done yet: its run has not settled') });
    expect(REPLIES[0].text).toContain('"Write a" is in_progress');
    parent.destroy();
  });

  it('refuses a done with no plan, and takes the second turn\'s report', async () => {
    const { parent } = tree([SAYS_DONE, CALL({ status: 'blocked', summary: 'Nothing to do.', reason: 'The work is already there.' })]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(REPLIES[0]).toMatchObject({ isError: true, text: expect.stringContaining('the child plan holds no tasks') });
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ outcome: 'fail', reported: 'blocked', reason: expect.stringContaining('The work is already there') });
    parent.destroy();
  });

  it('refuses a done from a child that changed nothing on the branch', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), SAYS_DONE, CALL({ status: 'blocked', summary: 'No change was needed.' })], { runner: writingRunner({}) });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(REPLIES[0]).toMatchObject({ isError: true, text: expect.stringContaining('has not changed since its base') });
    parent.destroy();
  });

  it('fails the verdict when the branch touched a protected path, naming it, and lands nothing', async () => {
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), SAYS_DONE], { runner: writingRunner({ a: ['a.txt', 'tests/guard.txt'] }) });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(REPLIES[0].isError).toBeFalsy();
    const { verdict } = parent.planTasks.find((t) => t.id === 'd')!;
    expect(verdict).toMatchObject({ outcome: 'fail', reported: 'failed', reason: expect.stringContaining('tests/guard.txt') });
    expect(verdict?.reason).not.toContain('a.txt,');
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? 'main';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).not.toContain('a.txt');
    expect(statusOf(parent, 'c')).not.toBe('completed');
    parent.destroy();
  });

  it('reminds a subplanner once when a turn ends with nothing running, and fails it on the second, with a derived report', async () => {
    const { parent, planner } = tree([NOTHING, NOTHING]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(planner.asked).toHaveLength(2);
    expect(planner.asked[1]).toContain('A second turn that ends like this fails the delegated task');
    const task = parent.planTasks.find((t) => t.id === 'd')!;
    expect(task.verdict).toMatchObject({ outcome: 'fail', reported: 'failed', reason: expect.stringContaining('ended a second turn') });
    expect(task.handoff?.summary).toContain('ended a second turn');
    parent.destroy();
  });

  it('ends blocked, naming the level, for a budget that cannot be carved', async () => {
    const { parent } = tree([], { tasks: [delegated({ budget: { tokens: 9_000_000 } }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('Level 0 refused limits.tokens') });
    parent.destroy();
  });

  it('ends blocked where the build does not offer delegation, whatever the plan holds', async () => {
    const { parent } = tree([], { offered: false });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('delegation is off here') });
    parent.destroy();
  });

  it('never starts on a runner that drives no harness: an API planner cannot be delegated to (D5)', async () => {
    const runner = writingRunner({});
    const { parent, planner } = tree([], { runner, tasks: [delegated({ assignedRunner: 'cursor' }), check()], runners: ['claude-code', 'cursor'] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('pending'));
    expect(planner.asked).toEqual([]);
    expect(parent.escalations().map((e) => e.reason).join()).toContain('no structured connector');
    parent.destroy();
  });

  it('takes a read-only delegated task\'s report with no change, and lands nothing', async () => {
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), SAYS_DONE], { runner: writingRunner({}), tasks: [delegated({ readOnly: true, protectedPaths: undefined }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? 'main';
    expect(git(root, 'rev-parse', integration)).toBe(git(root, 'rev-parse', 'main'));
    parent.destroy();
  });

  it('refuses an ops task in the child\'s plan as it is written, and the subplanner goes on', async () => {
    const refused: string[] = [];
    const OPS: Turn = async (tools) => {
      const reply = await tools.submitPlan!({ tasks: [{ ...childTask('o', 1), ops: true }] as never }, { signal: new AbortController().signal });
      if (reply.isError) refused.push(reply.text);
    };
    const { parent } = tree([OPS, CALL({ status: 'failed', summary: 'It needs an ops task.' })]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(refused[0]).toContain('none runs below the root');
    parent.destroy();
  });

  it('answers a checkpoint that a question cannot go up yet, and leaves the attempt to end', async () => {
    const answers: { text: string; isError?: boolean }[] = [];
    const ASK: Turn = async (tools) => { answers.push(await tools.checkpoint!({ question: 'Which one?' }, { signal: new AbortController().signal })); };
    const { parent } = tree([ASK, CALL({ status: 'blocked', summary: 'I need to know which one.' })]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(answers[0]).toMatchObject({ isError: true, text: expect.stringContaining('status "blocked"') });
    parent.destroy();
  });
});

describe('a Stop', () => {
  it('ends a child\'s run with its parent\'s, and leaves nothing running', async () => {
    const held = heldTasks({ a: ['a.txt'] }, ['a']);
    const { parent } = tree([SUBMIT([childTask('a', 1)])], { runner: held.runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(held.runner.spawned).toContain('a'));
    parent.stopExecution();
    await vi.waitFor(() => expect(held.stopped).toContain('a'));
    expect(parent.isExecuting).toBe(false);
    parent.destroy();
  });
});

describe('a budget', () => {
  it('ends a child blocked when it runs out, with a report nobody wrote', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)])], {
      runner: writingRunner({ a: ['a.txt'] }, { usage: 3_000_000 }),
      tasks: [delegated({ budget: { tokens: 400_000 } }), check()],
    });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ reported: 'blocked' });
    parent.destroy();
  });
});
