import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { LeaseHost } from '../sessionLease';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { Session } from '../createSession';
import type { IAiService } from '../AiService';
import type { IFileSystem, OwnSealedRuns, TaskShell, ToolOutcome } from '../../interfaces/IFileSystem';
import type { IRunner } from '../../interfaces/IRunner';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { PlannerToolHandler } from '../mcp';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { saveSession } from '../../utils/sessionStore';
import { openTaskLog } from '../../utils/taskLogStore';
import { fakeFs, makeSession, scriptedPlanner, type PlannerTurn as Turn } from './sessionTestKit';

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
// What a closing child still saves may land a moment after its parent's `destroy`.
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

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

/** Writes each task's files in the worktree it was handed, then reports done; a task with none reports done at once. */
function writingRunner(files: Record<string, string[]>, { usage = 0, asks }: { usage?: number; asks?: (session: FakeRunnerSession) => void } = {}): IRunner & { spawned: string[] } {
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

const NOTHING_THEN_BLOCKED: Turn = async (tools) => {
  await tools.taskComplete!({ status: 'blocked', summary: 'Not now.', reason: 'Nothing is ready.' }, { signal: new AbortController().signal });
};

/** Writes `a.txt` and passes every task but the check, which fails. */
function failingCheck(): IRunner {
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

const DONE: Turn = async (tools) => {
  const reply = await tools.taskComplete!({ status: 'done', summary: 'Both files are written.', commit: { subject: 'Write a and b' } }, { signal: new AbortController().signal });
  if (reply.isError) throw new Error(reply.text);
};

interface Tree {
  root: string;
  parent: Session;
  planner: ReturnType<typeof scriptedPlanner>;
}

interface TreeOptions { runner?: IRunner; tasks?: Task[]; tokens?: () => number; parallel?: number; offered?: boolean; runners?: string[]; fsAdapter?: IFileSystem }

function tree(turns: Turn[], { runner = writingRunner({ a: ['a.txt'], b: ['b.txt'] }), tasks = [delegated(), check()], tokens = () => 5_000_000, parallel = 3, offered = true, runners = ['claude-code'], fsAdapter }: TreeOptions = {}): Tree {
  const root = repo();
  const planner = scriptedPlanner(turns);
  const parent = makeSession({
    runner, isolation: isolation(), workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: 'session-root',
    config: fakeConfig({ maxParallelSessions: parallel }),
    ...(fsAdapter ? { fsAdapter } : {}),
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: tokens() } }),
    delegationOffered: offered,
    childDeps: () => ({ aiService: { reset: vi.fn(), ...planner.service } as unknown as IAiService, fsAdapter: fsAdapter ?? { ...fakeFs(), getWorkspaceRoot: () => root } }),
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

  it('refuses a done from a child that skipped everything: skipped work can end a child, but never all of it', async () => {
    const signal = new AbortController().signal;
    const SKIP: Turn = async (tools) => { await tools.skipTask!({ task: 'a', reason: 'It cannot be done.' }, { signal }); };
    const inner = writingRunner({});
    const failing: IRunner = {
      ...inner,
      spawn: vi.fn(async (opts) => {
        const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
        setTimeout(() => session.reportComplete({ status: 'failed', summary: 'It failed.', reason: 'It failed.' }), 5);
        return session;
      }),
    };
    const { parent } = tree([SUBMIT([childTask('a', 1)]), SKIP, SAYS_DONE, CALL({ status: 'blocked', summary: 'Nothing could be done.' })], { runner: failing });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(REPLIES[0]).toMatchObject({ isError: true, text: expect.stringContaining('no task of the child plan completed') });
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

describe('a landing that conflicts', () => {
  it('waits on the user, its work kept, and starts no new child: a repair is a runner\'s (D14)', async () => {
    const held = heldTasks({ a: ['x.txt'], s: ['x.txt'] }, ['a', 's']);
    const { parent, planner } = tree([SUBMIT([childTask('a', 1)]), DONE], {
      runner: held.runner,
      tasks: [delegated(), check(), createTask({ id: 's', order: 3, title: 'Sibling', prompt: 'sibling' })],
    });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(held.runner.spawned).toEqual(expect.arrayContaining(['a', 's'])), { timeout: 20_000 });
    held.release('s');
    await vi.waitFor(() => expect(statusOf(parent, 's')).toBe('completed'), { timeout: 20_000 });
    held.release('a');
    await vi.waitFor(() => expect(parent.planTasks.find((t) => t.id === 'd')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'conflict' }), { timeout: 20_000 });
    expect(planner.requests).toHaveLength(1);
    parent.destroy();
  });
});

describe('a sealed script (ADR-0055 D8, ADR-0056 M9)', () => {
  /** A shell that runs what it is handed in `sh`, and keeps what it ran: a real seal is the sandbox's own suite. */
  function sealedFs() {
    const ran: { script: string; cwd: string }[] = [];
    const run = async (script: string, cwd: string): Promise<ToolOutcome> => {
      ran.push({ script, cwd });
      const result = spawnSync('sh', ['-c', script], { cwd, encoding: 'utf8' });
      return { success: result.status === 0, output: `${result.stdout}${result.stderr}`, truncated: false };
    };
    const fsAdapter: IFileSystem = {
      ...fakeFs(),
      canSeal: async () => true,
      taskShell: ({ cwd, writable, worktrees }) => {
        const shell: TaskShell = {
          run: () => Promise.reject(new Error('a script runs through hold')),
          hold: <T>(work: (runs: OwnSealedRuns) => Promise<T>) => work({ worktrees: worktrees?.length ? worktrees : [writable ?? cwd], touched: false, scratch: '', run }),
          end: () => undefined,
        };
        return shell;
      },
    };
    return { fsAdapter, ran };
  }
  const script = (over: Partial<Task> = {}) => createTask({ id: 'c', order: 2, title: 'Run the suite', type: 'script', commands: [['cat', 'a.txt']], readOnly: true, dependencies: ['d'], ...over });

  it('runs sealed in a worktree cut from the integration tip, past no merge gate, and lands nothing', async () => {
    const { fsAdapter, ran } = sealedFs();
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), script()], fsAdapter });
    const main = git(root, 'rev-parse', 'main');
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });

    expect(ran[0].cwd).not.toBe(root);
    expect(git(root, 'rev-parse', 'main')).toBe(main);
    expect(existsSync(ran[0].cwd)).toBe(false);
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).toEqual(['README.md', 'a.txt', 'tests/guard.txt']);
    parent.destroy();
  });

  it('fails on its exit status, and its dependents are held', async () => {
    const { fsAdapter } = sealedFs();
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), script({ commands: [['cat', 'no-such-file']] }), createTask({ id: 'n', order: 3, title: 'After', prompt: 'after', dependencies: ['c'] })], fsAdapter });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('failed'), { timeout: 20_000 });
    expect(parent.planTasks.find((t) => t.id === 'c')?.verdict?.reported).toBe('failed');
    expect(statusOf(parent, 'n')).not.toBe('in_progress');
    parent.destroy();
  });

  it('fails at its start where the host has no sealed shell, and never sits ready', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), script()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(parent.escalations().map((e) => e.reason).join()).toContain('must run sealed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('is what a child\'s own script task is, with no `effect` to run otherwise', async () => {
    const { fsAdapter, ran } = sealedFs();
    const script = { id: 't', order: 2, title: 'Test it', description: 'test', type: 'script', sliceType: 'AFK', commands: [['cat', 'a.txt']], dependencies: ['a'] };
    const { parent } = tree([SUBMIT([childTask('a', 1), script]), DONE], { fsAdapter });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(ran).toHaveLength(1);
    parent.destroy();
  });
});

describe('what a model may not do to a check (ADR-0055 D8)', () => {
  it('refuses a supervisor\'s skip of a failed check, and leaves the user\'s', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner: failingCheck(), tasks: [delegated(), check({ taskMode: 'plan' })] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('failed'), { timeout: 20_000 });
    const refused = await parent.execute({ command: 'skip_task', task: 'c', reason: 'it is fine' }, { kind: 'supervisor', level: 'act' });
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining('a model does not skip it') });
    expect(await parent.execute({ command: 'skip_task', task: 'c' }, { kind: 'user' })).toMatchObject({ ok: true });
    parent.destroy();
  });
});

describe('what ends a child with nobody to ask (ADR-0056 M3, M8, M10)', () => {
  it('denies a runner\'s approval at once: nobody below the root may allow it', async () => {
    const asked = { session: null as FakeRunnerSession | null };
    const runner = writingRunner({ a: ['a.txt'] }, { asks: (session) => { asked.session = session; } });
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(asked.session?.answers[0]?.decision).toMatchObject({ decision: 'deny' });
    parent.destroy();
  });

  it('stops only what it started: a child\'s end leaves its parent\'s sibling running', async () => {
    const held = heldTasks({ a: ['a.txt'], s: ['s.txt'] }, ['a', 's']);
    const { parent } = tree([SUBMIT([childTask('a', 1)])], {
      runner: held.runner,
      tasks: [delegated({ budget: { tokens: 2_000_000, wallClockMs: 2500 } }), check(), createTask({ id: 's', order: 3, title: 'Sibling', prompt: 'sibling' })],
    });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    // A run's own start clears what is live, with nothing to stop yet.
    vi.mocked(held.runner.stopAll).mockClear();
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect([...new Set(held.stopped)]).toEqual(['a']);
    expect(held.runner.stopAll).not.toHaveBeenCalled();
    expect(statusOf(parent, 's')).toBe('in_progress');
    held.release('s');
    await vi.waitFor(() => expect(statusOf(parent, 's')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('ends blocked when its time runs out, its run stopped first', async () => {
    const held = heldTasks({ a: ['a.txt'] }, ['a']);
    const { parent } = tree([SUBMIT([childTask('a', 1)])], { runner: held.runner, tasks: [delegated({ budget: { tokens: 2_000_000, wallClockMs: 2500 } }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(held.runner.spawned).toContain('a'));
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('ran out') });
    expect(held.stopped).toContain('a');
    parent.destroy();
  });

  it('ends blocked once delegation is turned off above it, its work in flight finished', async () => {
    let tokens = 5_000_000;
    const held = heldTasks({ a: ['a.txt'] }, ['a']);
    const { parent } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])])], { runner: held.runner, tokens: () => tokens });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(held.runner.spawned).toContain('a'));
    tokens = 0;
    parent.applyRunSettings({ delegationTokens: 0 });
    held.release('a');
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('withdrawn') });
    expect(held.runner.spawned).not.toContain('b');
    parent.destroy();
  });
});

describe('a child\'s budget', () => {
  it('comes back when it closes, for the next carve', async () => {
    const turns = [SUBMIT([childTask('a', 1)]), DONE, SUBMIT([{ ...childTask('b', 1), id: 'b' }]), DONE];
    const { parent } = tree(turns, {
      tokens: () => 3_000_000,
      tasks: [delegated({ budget: { tokens: 2_500_000 } }), check(), delegated({ id: 'e', order: 3, dependencies: ['c'], budget: { tokens: 2_500_000 } }), check({ id: 'f', order: 4, dependencies: ['e'] })],
    });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'f')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('starts over on a fresh retry, in a new child', async () => {
    const { parent, planner } = tree([NOTHING_THEN_BLOCKED, SUBMIT([childTask('a', 1)]), DONE]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    const first = parent.planState?.isolation?.run.tasks.d.childSession;
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(planner.requests).toHaveLength(2);
    expect(parent.planState?.isolation?.run.tasks.d.childSession).not.toBe(first);
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
