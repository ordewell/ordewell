import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { Landing } from '../Landing';
import { LeaseHost } from '../sessionLease';
import { resolveDefaultMode } from '../ModeResolver';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { Session } from '../createSession';
import type { IAiService } from '../AiService';
import type { IFileSystem, OwnSealedRuns, TaskShell, ToolOutcome } from '../../interfaces/IFileSystem';
import type { IApproval } from '../../interfaces/IApproval';
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
const closing: Session[] = [];
// What a closing child still saves may land a moment after its parent's `destroy`.
afterEach(async () => {
  await Promise.all(closing.splice(0).map((session) => session.gone));
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

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

/** Writes `a.txt`, and the check `c` waits for {@link release} each time it runs. */
function heldChecks() {
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

const DONE: Turn = async (tools) => {
  const reply = await tools.taskComplete!({ status: 'done', summary: 'Both files are written.', commit: { subject: 'Write a and b' } }, { signal: new AbortController().signal });
  if (reply.isError) throw new Error(reply.text);
};
const CALL_BLOCKED: Turn = async (tools) => {
  await tools.taskComplete!({ status: 'blocked', summary: 'Not now.', reason: 'Nothing is ready.' }, { signal: new AbortController().signal });
};

interface Tree {
  root: string;
  parent: Session;
  planner: ReturnType<typeof scriptedPlanner>;
}

interface TreeOptions { runner?: IRunner; tasks?: Task[]; tokens?: () => number; parallel?: number; offered?: boolean; runners?: string[]; fsAdapter?: IFileSystem; merges?: boolean; config?: Parameters<typeof fakeConfig>[0] }

function tree(turns: Turn[], { runner = writingRunner({ a: ['a.txt'], b: ['b.txt'] }), tasks = [delegated(), check()], tokens = () => 5_000_000, parallel = 3, offered = true, runners = ['claude-code'], fsAdapter, merges = false, config = {} }: TreeOptions = {}): Tree {
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
  closing.push(parent);
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

});

describe('a question (ADR-0056 M8)', () => {
  const quiet = () => ({ signal: new AbortController().signal });
  const asks = (question: string, replies: { text: string; isError?: boolean }[] = []): Turn => async (tools) => { replies.push(await tools.checkpoint!({ question }, quiet())); };
  const awaiting = (session: Session, id: string) => session.planTasks.find((t) => t.id === id);

  it('answers at once and parks the subplanner, and the answer opens its next turn', async () => {
    const replies: { text: string; isError?: boolean }[] = [];
    const heard: string[] = [];
    const HEAR = (turn: Turn): Turn => async (tools, text) => { heard.push(text); await turn(tools, text); };
    const { parent, planner } = tree([asks('Which one?', replies), HEAR(SUBMIT([childTask('a', 1)])), DONE]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(awaiting(parent, 'd')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint' }), { timeout: 20_000 });
    expect(replies).toEqual([{ text: expect.stringContaining('End your turn') }]);

    const asked = parent.escalations().find((e) => e.kind === 'checkpoint');
    expect(asked?.reason).toContain('#1');
    expect(asked?.reason).toContain('Which one?');
    expect(await parent.answerEscalation(asked!.id, 'reject', 'Use the first.')).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(heard[0]).toContain('Use the first.');
    expect(planner.requests).toHaveLength(1);
    parent.destroy();
  });

  it('carries the words of an approval to the subplanner, where a question wants an answer and not a yes', async () => {
    const heard: string[] = [];
    const HEAR = (turn: Turn): Turn => async (tools, text) => { heard.push(text); await turn(tools, text); };
    const { parent } = tree([asks('Which rounding?'), HEAR(SUBMIT([childTask('a', 1)])), DONE]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(awaiting(parent, 'd')?.awaitingReason).toBe('checkpoint'), { timeout: 20_000 });
    expect(await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve', reason: 'Round half away from zero.', raiseTokens: 100_000 }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(heard[0]).toContain('Round half away from zero.');
    expect(heard[0]).toContain('100000');
    expect(heard[0]).not.toContain('rejected');
    parent.destroy();
  });

  it('tells a subplanner its run merged into the delegated task\'s branch, never the user\'s', async () => {
    const { parent, planner } = tree([SUBMIT([childTask('a', 1)]), DONE]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(planner.asked[1]).toContain('merged into the delegated task\'s branch');
    parent.destroy();
  });

  it('takes one question at a time', async () => {
    const replies: { text: string; isError?: boolean }[] = [];
    const { parent } = tree([async (tools) => {
      replies.push(await tools.checkpoint!({ question: 'First?' }, quiet()));
      replies.push(await tools.checkpoint!({ question: 'Second?' }, quiet()));
    }]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(replies).toHaveLength(2), { timeout: 20_000 });
    expect(replies[1]).toMatchObject({ isError: true });
    expect(parent.escalations().find((e) => e.kind === 'checkpoint')?.reason).toContain('First?');
    parent.destroy();
  });

  it('never reminds a subplanner that waits on its answer, and ends with its time when nobody answers', async () => {
    const { parent, planner } = tree([asks('Which one?')], { tasks: [delegated({ budget: { tokens: 2_000_000, wallClockMs: 2500 } }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(awaiting(parent, 'd')?.awaitingReason).toBe('checkpoint'), { timeout: 20_000 });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(awaiting(parent, 'd')?.verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('ran out') });
    expect(planner.asked).toHaveLength(1);
    parent.destroy();
  });

  it('wakes an Act supervisor at the root, which answers it as any checkpoint', async () => {
    const { parent, planner } = tree([asks('Which one?'), SUBMIT([childTask('a', 1)]), DONE], { tokens: () => 5_000_000 });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(awaiting(parent, 'd')?.awaitingReason).toBe('checkpoint'), { timeout: 20_000 });
    expect(await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve' }, { kind: 'supervisor', level: 'act' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(planner.asked[1]).toContain('approved');
    parent.destroy();
  });
});

describe('a raise (ADR-0056 M5)', () => {
  const quiet = () => ({ signal: new AbortController().signal });
  const ASK: Turn = async (tools) => { await tools.checkpoint!({ question: 'I need 500000 more tokens.' }, quiet()); };
  const AWAIT: Turn = async () => undefined;
  const limitOf = async (session: Session, id: string) => {
    const tree = await session.ledger();
    return tree.numbers(tree.nodeOf(session.planState?.isolation?.run.tasks[id].childSession ?? '')!.path).limit;
  };
  const asking = (session: Session) => vi.waitFor(() => expect(session.planTasks.find((t) => t.id === 'd')?.awaitingReason).toBe('checkpoint'), { timeout: 20_000 });

  it('comes with an approval, from what the parent has left, and tells the subplanner', async () => {
    const { parent, planner } = tree([ASK, SUBMIT([childTask('a', 1)]), DONE]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await asking(parent);
    expect(await limitOf(parent, 'd')).toBe(2_000_000);
    const answered = await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve', raiseTokens: 500_000 }, { kind: 'user' });
    expect(answered).toMatchObject({ ok: true, message: expect.stringContaining('500000') });
    expect(await limitOf(parent, 'd')).toBe(2_500_000);
    await vi.waitFor(() => expect(planner.asked[1]).toContain('500000'), { timeout: 20_000 });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('is the same on the inbox\'s Approve', async () => {
    const { parent } = tree([ASK]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await asking(parent);
    const asked = parent.escalations().find((e) => e.kind === 'checkpoint')!;
    expect(await parent.answerEscalation(asked.id, 'approve', undefined, false, 300_000)).toMatchObject({ ok: true });
    expect(await limitOf(parent, 'd')).toBe(2_300_000);
    parent.destroy();
  });

  it('is refused past what the parent has left, and the question still waits', async () => {
    const { parent } = tree([ASK], { tokens: () => 2_100_000 });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await asking(parent);
    const answered = await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve', raiseTokens: 500_000 }, { kind: 'user' });
    expect(answered).toMatchObject({ ok: false, message: expect.stringContaining('refused this raise') });
    expect(await limitOf(parent, 'd')).toBe(2_000_000);
    expect(parent.awaitsCheckpoint('d')).toBe(true);
    parent.destroy();
  });

  it('goes only with an approval, and only to a delegated task', async () => {
    const { parent } = tree([ASK]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await asking(parent);
    expect(await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'reject', reason: 'no', raiseTokens: 500_000 }, { kind: 'user' })).toMatchObject({ ok: false, message: expect.stringContaining('approval') });
    expect(parent.awaitsCheckpoint('d')).toBe(true);
    parent.destroy();
  });

  describe('a child its budget stops while its question waits', () => {
    const stopped = async (session: Session) => {
      const tree = await session.ledger();
      tree.nodeOf(session.planState?.isolation?.run.tasks.d.childSession ?? '')!.stop('Level 1 refused this turn: a turn here needs 200000 tokens to start, and 14810 are left.');
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };

    it('keeps waiting, since the answer is what can give it room, and a raise carries it on', async () => {
      const { parent } = tree([ASK, SUBMIT([childTask('a', 1)]), DONE]);
      await parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await asking(parent);
      await stopped(parent);
      expect(parent.awaitsCheckpoint('d')).toBe(true);
      expect(await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve', raiseTokens: 500_000 }, { kind: 'user' })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
      parent.destroy();
    });

    it('tells the plan above that a child with everything finished owes only its report, and a Continue is what keeps its work', async () => {
      const { parent } = tree([SUBMIT([childTask('a', 1)]), ASK, AWAIT]);
      await parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await asking(parent);
      await stopped(parent);
      await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve' }, { kind: 'user' });
      await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
      const reason = parent.planTasks.find((t) => t.id === 'd')?.verdict?.reason ?? '';
      expect(reason).toContain('only its report is missing');
      expect(reason).toContain('Continue');
      expect(reason).not.toContain('..');
      parent.destroy();
    });

    it('ends blocked once an answer brings no room', async () => {
      const { parent } = tree([ASK, AWAIT]);
      await parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await asking(parent);
      await stopped(parent);
      await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve' }, { kind: 'user' });
      await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
      expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('refused this turn') });
      parent.destroy();
    });
  });

  describe('a start its budget refuses', () => {
    /** One tenth of a session past the reserve its subplanner keeps: a turn can start, and a task cannot. */
    const small = () => [delegated({ budget: { tokens: 220_000 } }), check()];

    it('wakes the subplanner, and a raise starts its run again', async () => {
      const { parent, planner } = tree([SUBMIT([childTask('a', 1)]), ASK, AWAIT, DONE], { tasks: small(), runner: writingRunner({ a: ['a.txt'] }) });
      await parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await asking(parent);
      expect(planner.asked[1]).toContain('could not start');
      expect(planner.asked[1]).not.toContain('are left..');
      expect(await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve', raiseTokens: 500_000 }, { kind: 'user' })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
      parent.destroy();
    });

    it('ends blocked when the subplanner\'s turn ends with no question, without a reminder', async () => {
      const { parent, planner } = tree([SUBMIT([childTask('a', 1)]), AWAIT], { tasks: small() });
      await parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
      expect(parent.planTasks.find((t) => t.id === 'd')?.verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('needs 200000 tokens') });
      expect(planner.asked).toHaveLength(2);
      parent.destroy();
    });

    it('ends blocked when the answer brings no room', async () => {
      const { parent } = tree([SUBMIT([childTask('a', 1)]), ASK, AWAIT], { tasks: small() });
      await parent.execute({ command: 'run_plan' }, { kind: 'user' });
      await asking(parent);
      await parent.execute({ command: 'answer_checkpoint', task: 'd', answer: 'reject', reason: 'None left.' }, { kind: 'user' });
      await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
      expect(parent.planTasks.find((t) => t.id === 'd')?.verdict?.reported).toBe('blocked');
      parent.destroy();
    });
  });
});

describe('two levels down (ADR-0056 M8, ADR-0055 D9, D14)', () => {
  const quiet = () => ({ signal: new AbortController().signal });
  const nestedChild = { id: 'e', order: 1, title: 'Deeper subtree', description: 'deeper', type: 'delegated', goal: 'Write a', budget: { tokens: 800_000 }, protectedPaths: ['tests/'], sliceType: 'AFK', dependencies: [] };
  const nestedCheck = { id: 'f', order: 2, title: 'Check the deeper subtree', description: 'check', type: 'ai', prompt: 'read it', readOnly: true, sliceType: 'AFK', autonomy: 'AFK', dependencies: ['e'] };

  /** A root whose subplanner and sub-subplanner each read their own turns. */
  function nested(outer: Turn[], inner: Turn[], { runner = writingRunner({ a: ['a.txt'] }), config = {} }: { runner?: IRunner; config?: Parameters<typeof fakeConfig>[0] } = {}) {
    const root = repo();
    const planners = { d: scriptedPlanner(outer), e: scriptedPlanner(inner) };
    const parent = makeSession({
      runner, isolation: isolation(), workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: 'session-root',
      config: fakeConfig({ maxParallelSessions: 3, ...config }),
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: 5_000_000 } }),
      delegationOffered: true,
      childDeps: (task) => ({ aiService: { reset: vi.fn(), ...planners[task.id as 'd' | 'e'].service } as unknown as IAiService, fsAdapter: { ...fakeFs(), getWorkspaceRoot: () => root } }),
    });
    parent.loadPlan({ ...planOf([delegated({ grants: ['delegate'] }), check()]), runners: ['claude-code'] }, 'the root goal', root, { sessionId: 'session-root' });
    return { root, parent, planners };
  }

  it('holds a child\'s own merge while its check has not passed, so its subplanner cannot say done', async () => {
    const replies: string[] = [];
    const inner = writingRunner({ a: ['a.txt'] });
    const runner: IRunner = {
      ...inner,
      spawn: vi.fn(async (opts) => {
        if (opts.taskId !== 'f') return inner.spawn(opts);
        const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
        setTimeout(() => session.reportComplete({ status: 'failed', summary: 'It does not hold.', reason: 'It does not hold.' }), 5);
        return session;
      }),
    };
    const { parent } = nested([
      SUBMIT([nestedChild, nestedCheck]),
      async (tools) => {
        const said = await tools.taskComplete!({ status: 'done', summary: 'Done.', commit: { subject: 'Write a' } }, quiet());
        replies.push(said.text);
        await tools.taskComplete!({ status: 'blocked', summary: 'Its check failed.', reason: 'Its check failed.' }, quiet());
      },
    ], [SUBMIT([childTask('a', 1)]), DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 40_000 });
    expect(replies[0]).toContain('Not done yet');
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict?.reported).toBe('blocked');
    parent.destroy();
  }, 60_000);

  it('repairs a child\'s delegated task in the mode its mandate gives, held to what its ancestors protect too', async () => {
    const held = heldTasks({ a: ['x.txt'], s: ['x.txt'] }, ['a', 's']);
    const repairs: { mode: string | undefined }[] = [];
    const heard: string[] = [];
    const runner: IRunner & { spawned: string[] } = {
      ...held.runner,
      spawn: vi.fn(async (opts) => {
        if (opts.taskId !== 'e') return held.runner.spawn(opts);
        repairs.push({ mode: opts.mode });
        const repair = new FakeRunnerSession('repair-e', 'e');
        setTimeout(() => {
          const [integration] = /ordewell\/[^\s`]+\/integration/.exec(opts.prompt) ?? [''];
          spawnSync('git', ['merge', '--no-edit', integration], { cwd: opts.cwd, env: env() });
          writeFileSync(join(opts.cwd, 'x.txt'), 'both\n');
          writeFileSync(join(opts.cwd, 'tests', 'guard.txt'), 'the root protects this\n');
          git(opts.cwd, 'add', '-A');
          git(opts.cwd, 'commit', '-q', '--no-edit');
          repair.reportComplete({ status: 'done', summary: 'Repaired.' });
        }, 5);
        return repair;
      }),
    };
    const { parent } = nested([
      SUBMIT([{ ...nestedChild, protectedPaths: ['docs/'] }, nestedCheck, { ...childTask('s', 3) }]),
      async (tools, text) => {
        heard.push(text);
        await tools.taskComplete!({ status: 'blocked', summary: 'It conflicts.', reason: 'It conflicts.' }, quiet());
      },
    ], [SUBMIT([childTask('a', 1)]), DONE], { runner, config: { conflictRepairAttempts: 1, autonomousMode: false } });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(held.runner.spawned).toEqual(expect.arrayContaining(['a', 's'])), { timeout: 30_000 });
    held.release('s');
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    held.release('a');
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 40_000 });
    expect(repairs).toEqual([{ mode: resolveDefaultMode(new RunnerRegistry().get('claude-code')?.manifest.modes, false) }]);
    expect(heard[0]).toContain('conflicts');
    parent.destroy();
  }, 60_000);

  it('wakes the subplanner on a conflict with no repair left: nobody below the root waits on a person', async () => {
    const held = heldTasks({ a: ['x.txt'], s: ['x.txt'] }, ['a', 's']);
    const heard: string[] = [];
    const { parent } = nested([
      SUBMIT([nestedChild, nestedCheck, { ...childTask('s', 3) }]),
      async (tools, text) => {
        heard.push(text);
        await tools.taskComplete!({ status: 'blocked', summary: 'It conflicts.', reason: 'It conflicts.' }, quiet());
      },
    ], [SUBMIT([childTask('a', 1)]), DONE], { runner: held.runner, config: { conflictRepairAttempts: 0 } });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(held.runner.spawned).toEqual(expect.arrayContaining(['a', 's'])), { timeout: 30_000 });
    held.release('s');
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    held.release('a');
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 40_000 });
    expect(heard[0]).toContain('conflicts');
    expect(parent.escalations().map((e) => e.kind)).not.toContain('checkpoint');
    parent.destroy();
  }, 60_000);

  it('wakes its parent subplanner, which answers it, and nothing of it reaches the user', async () => {
    let asked: string[] = [];
    let seen: string[] = [];
    const { parent, planners } = nested([
      SUBMIT([nestedChild, nestedCheck]),
      async (tools, text) => {
        seen = parent.escalations().map((e) => e.reason);
        expect(text).toContain('Which file?');
        const reply = await tools.answerCheckpoint!({ task: 'e', answer: 'reject', reason: 'a.txt', raiseTokens: undefined }, quiet());
        if (reply.isError) throw new Error(reply.text);
      },
      DONE,
    ], [
      async (tools) => { await tools.checkpoint!({ question: 'Which file?' }, quiet()); },
      async (tools, text) => { asked = [text]; await SUBMIT([childTask('a', 1)])(tools, text); },
      DONE,
    ]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 40_000 });
    expect(asked[0]).toContain('a.txt');
    expect(seen.join()).not.toContain('Which file?');
    expect(planners.d.asked.join()).toContain('Which file?');
    parent.destroy();
  }, 60_000);
});

describe('the merge hold (ADR-0055 D9)', () => {
  const readOnlyCheck = () => check({ taskMode: 'plan' });
  const changed = (root: string) => git(root, 'ls-tree', '-r', '--name-only', 'main').split('\n');

  /** A runner whose check waits until told how it ends. */
  function verdictOnCall() {
    const inner = writingRunner({ a: ['a.txt'], s: ['s.txt'] });
    const ends: Array<(pass: boolean) => void> = [];
    const runner: IRunner = {
      ...inner,
      spawn: vi.fn(async (opts) => {
        if (opts.taskId !== 'c') return inner.spawn(opts);
        const session = new FakeRunnerSession(`s-c-${ends.length}`, opts.taskId);
        ends.push((pass) => session.reportComplete(pass ? { status: 'done', summary: 'It holds.' } : { status: 'failed', summary: 'It does not.', reason: 'It does not.' }));
        return session;
      }),
    };
    return { runner, ends };
  }

  it('merges at the run\'s end once its check has passed, and not before', async () => {
    const { runner, ends } = verdictOnCall();
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner, tasks: [delegated(), readOnlyCheck()], merges: true });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(ends).toHaveLength(1), { timeout: 20_000 });
    expect(changed(root)).not.toContain('a.txt');
    ends[0](true);
    await vi.waitFor(() => expect(changed(root)).toContain('a.txt'), { timeout: 20_000 });
    parent.destroy();
  });

  it('holds past a failed check, and the user\'s Skip lets the next tick merge', async () => {
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner: failingCheck(), tasks: [delegated(), readOnlyCheck()], merges: true });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('failed'), { timeout: 20_000 });
    // By now the run has closed with its merge held: the Skip finds no run to end.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    expect(changed(root)).not.toContain('a.txt');
    expect(await parent.execute({ command: 'skip_task', task: 'c' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(changed(root)).toContain('a.txt'), { timeout: 20_000 });
    parent.destroy();
  });

  it('refuses a supervisor\'s Merge all naming the check, and leaves the user\'s, whose confirmation names it', async () => {
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner: failingCheck(), tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('failed'), { timeout: 20_000 });
    const refused = await parent.execute({ command: 'merge_all' }, { kind: 'supervisor', level: 'act' });
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining('Check the subtree') });

    const mergeOffered = () => parent.escalations().flatMap((e) => e.options.filter((o) => o.id === 'merge-all').map((o) => ({ id: e.id, confirm: o.confirm })))[0];
    await vi.waitFor(() => expect(mergeOffered()).toBeDefined(), { timeout: 20_000 });
    const offered = mergeOffered();
    expect(offered.confirm).toContain('Check the subtree');
    expect(await parent.answerEscalation(offered.id, 'merge-all')).toMatchObject({ ok: false, message: expect.stringContaining('explicit yes') });
    expect(changed(root)).not.toContain('a.txt');
    expect(await parent.answerEscalation(offered.id, 'merge-all', undefined, true)).toMatchObject({ ok: true });
    expect(changed(root)).toContain('a.txt');
    parent.destroy();
  });

  it('asks the user\'s own Merge all to confirm first, naming the check, and merges once told to', async () => {
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner: failingCheck(), tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('failed'), { timeout: 20_000 });

    const asked = await parent.execute({ command: 'merge_all' }, { kind: 'user' });
    expect(asked).toMatchObject({
      ok: false, outcome: 'refused',
      message: expect.stringContaining('This merges work no check has passed: #2 "Check the subtree" has not'),
      payload: { kind: 'merge_hold', checks: ['#2 "Check the subtree"'] },
    });
    expect(changed(root)).not.toContain('a.txt');

    expect(await parent.execute({ command: 'merge_all', pastChecks: true }, { kind: 'user' })).toMatchObject({ ok: true, payload: { kind: 'merge' } });
    expect(changed(root)).toContain('a.txt');
    parent.destroy();
  });

  it('never lets a supervisor or a planner past a check, whatever it carries', async () => {
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner: failingCheck(), tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('failed'), { timeout: 20_000 });
    expect(await parent.execute({ command: 'merge_all', pastChecks: true }, { kind: 'supervisor', level: 'act' })).toMatchObject({ ok: false, message: expect.stringContaining('Check the subtree') });
    expect(changed(root)).not.toContain('a.txt');
    parent.destroy();
  });

  it('is not held by a delegated task that has not landed: a sibling\'s work merges', async () => {
    const { root, parent } = tree([NOTHING_THEN_BLOCKED], {
      tasks: [delegated(), readOnlyCheck(), createTask({ id: 's', order: 3, title: 'Sibling', prompt: 'sibling' })],
      runner: writingRunner({ s: ['s.txt'] }),
      merges: true,
    });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(changed(root)).toContain('s.txt'), { timeout: 20_000 });
    expect(statusOf(parent, 'd')).toBe('failed');
    parent.destroy();
  });

  it('is not held by a read-only delegated task, which lands nothing', async () => {
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), DONE], {
      tasks: [delegated({ readOnly: true, protectedPaths: undefined }), check({ taskMode: 'plan', dependencies: ['d'] }), createTask({ id: 's', order: 3, title: 'Sibling', prompt: 'sibling' })],
      runner: writingRunner({ s: ['s.txt'], c: [] }),
      merges: true,
    });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(changed(root)).toContain('s.txt'), { timeout: 20_000 });
    parent.destroy();
  });
});

describe('a delegated task started alone (ADR-0055 D8, D9)', () => {
  const readOnlyCheck = (over: Partial<Task> = {}) => check({ taskMode: 'plan', ...over });

  it('starts its check by itself, and closes its run only after it', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), readOnlyCheck()] });
    expect(await parent.execute({ command: 'run_task', task: 'd' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('does the same after a fresh retry', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), CALL_BLOCKED, SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_task', task: 'd' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(statusOf(parent, 'c')).toBe('pending');
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('leaves a check that waits on more than its delegated task, and the run closes: nothing is moving towards it', async () => {
    const sibling = createTask({ id: 's', order: 3, title: 'Sibling', prompt: 'sibling' });
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), readOnlyCheck({ dependencies: ['d', 's'] }), sibling] });
    await parent.execute({ command: 'run_task', task: 'd' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    await vi.waitFor(() => expect(parent.isExecuting || parent.startsPending).toBe(false), { timeout: 20_000 });
    expect(statusOf(parent, 'c')).toBe('pending');
    parent.destroy();
  });

  it('starts nothing after a Stop that comes as its work lands', async () => {
    const land = Landing.prototype.landPassed;
    const landing = vi.spyOn(Landing.prototype, 'landPassed').mockImplementation(async function (this: Landing, ...args) {
      const landed = await land.apply(this, args);
      if (args[0].id === 'd') parent.stopExecution();
      return landed;
    });
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_task', task: 'd' }, { kind: 'user' });
    await vi.waitFor(() => expect(landing.mock.calls.some(([task]) => task.id === 'd')).toBe(true), { timeout: 20_000 });
    await vi.waitFor(() => expect(parent.isExecuting || parent.startsPending).toBe(false), { timeout: 20_000 });
    expect(statusOf(parent, 'c')).toBe('pending');
    landing.mockRestore();
    parent.destroy();
  });
});

describe('a new result is checked again (ADR-0055 D8)', () => {
  const readOnlyCheck = () => check({ taskMode: 'plan' });
  const task = (session: Session, id: string) => session.planTasks.find((t) => t.id === id);

  it('takes a passed check back with Mark not done, and its next run reads the new result', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE, SUBMIT([childTask('b', 1)]), DONE], { tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    const first = task(parent, 'c')?.verdict;
    expect(await parent.execute({ command: 'mark_not_done', task: 'd', confirmed: true }, { kind: 'user' })).toMatchObject({ ok: true });
    expect(statusOf(parent, 'c')).toBe('pending');
    expect(task(parent, 'c')?.verdict).toBeUndefined();
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    // Its check is the one thing a retry outside a run starts beside what it names.
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    expect(task(parent, 'c')?.verdict?.decidedAt).not.toBe(first?.decidedAt);
    parent.destroy();
  });

  it('takes a check the user skipped back too: a Skip let one result past, not the next', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner: failingCheck(), tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('failed'), { timeout: 20_000 });
    await parent.execute({ command: 'skip_task', task: 'c' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('skipped'));
    expect(await parent.execute({ command: 'mark_not_done', task: 'd', confirmed: true }, { kind: 'user' })).toMatchObject({ ok: true });
    expect(statusOf(parent, 'c')).toBe('pending');
    expect(task(parent, 'c')?.skipReason).toBeUndefined();
    parent.destroy();
  });

  it('takes a failed check back with a revert, and refuses a revert under a live one', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner: failingCheck(), tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('failed'), { timeout: 20_000 });
    expect(await parent.execute({ command: 'revert_task', task: 'd', confirmed: true }, { kind: 'user' })).toMatchObject({ ok: true });
    expect(statusOf(parent, 'd')).toBe('pending');
    expect(statusOf(parent, 'c')).toBe('pending');
    parent.destroy();
  });

  it('refuses to take a live check back, naming it', async () => {
    const { runner, release } = heldChecks();
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner, tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('in_progress'), { timeout: 20_000 });
    expect(await parent.execute({ command: 'mark_not_done', task: 'd', confirmed: true }, { kind: 'user' })).toMatchObject({ ok: false });
    expect(statusOf(parent, 'c')).toBe('in_progress');
    await release();
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  /** The user forced the check past its failed task: a start of that task now is the one that can meet a live check. */
  async function failedWithItsCheckLive(turns: Turn[]) {
    const { runner, release } = heldChecks();
    const made = tree(turns, { runner, tasks: [delegated(), readOnlyCheck()] });
    await made.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(made.parent, 'd')).toBe('failed'), { timeout: 20_000 });
    await made.parent.execute({ command: 'force_start', task: 'c' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(made.parent, 'c')).toBe('in_progress'), { timeout: 20_000 });
    return { ...made, release };
  }

  it('refuses a retry under a live check, naming it', async () => {
    const { parent, release } = await failedWithItsCheckLive([NOTHING_THEN_BLOCKED]);
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: false, message: expect.stringContaining('Check the subtree') });
    await release();
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('takes a check back at a force start\'s claim, which waits for a live one to end', async () => {
    const { parent, planner, release } = await failedWithItsCheckLive([NOTHING_THEN_BLOCKED, SUBMIT([childTask('a', 1)]), DONE]);
    await parent.execute({ command: 'force_start', task: 'd' }, { kind: 'user' });
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    expect(planner.requests).toHaveLength(1);
    await release();
    await vi.waitFor(() => expect(planner.requests).toHaveLength(2), { timeout: 20_000 });
    expect(statusOf(parent, 'c')).not.toBe('completed');
    parent.destroy();
  });

  it('takes a check back at Execute\'s fresh chance, which never calls retry', async () => {
    const { parent, planner } = tree([NOTHING_THEN_BLOCKED, SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), readOnlyCheck()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    await parent.execute({ command: 'skip_task', task: 'c' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('skipped'));
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    expect(planner.requests).toHaveLength(2);
    parent.destroy();
  });
});

describe('a landing that conflicts (ADR-0055 D14)', () => {
  const task = (session: Session, id: string) => session.planTasks.find((t) => t.id === id);
  const integrationOf = (session: Session) => session.planState?.isolation?.run.repos[0].integrationBranch ?? '';

  /**
   * `s` and the child's `a` both write `x.txt`, so whichever lands last conflicts.
   * The delegated task's repair merges the tip in by hand, as a repair's prompt
   * tells a runner to, and `edit` is what it does beside that.
   */
  function conflicted(session: () => Session, { edit, waitsFor }: { edit?: (cwd: string) => void; waitsFor?: () => boolean } = {}) {
    const held = heldTasks({ a: ['x.txt'], s: ['x.txt'] }, ['a', 's']);
    const repairs: { mode: string | undefined; cwd: string; prompt: string }[] = [];
    const runner: IRunner & { spawned: string[] } = {
      ...held.runner,
      spawn: vi.fn(async (opts) => {
        if (opts.taskId !== 'd') return held.runner.spawn(opts);
        repairs.push({ mode: opts.mode, cwd: opts.cwd, prompt: opts.prompt });
        const repair = new FakeRunnerSession(`repair-${repairs.length}`, 'd', 'native-repair');
        const finish = () => {
          if (waitsFor && !waitsFor()) {
            setTimeout(finish, 5);
            return;
          }
          spawnSync('git', ['merge', '--no-edit', integrationOf(session())], { cwd: opts.cwd, env: env() });
          writeFileSync(join(opts.cwd, 'x.txt'), 'both\n');
          edit?.(opts.cwd);
          git(opts.cwd, 'add', '-A');
          git(opts.cwd, 'commit', '-q', '--no-edit');
          repair.reportComplete({ status: 'done', summary: 'Repaired.' });
        };
        setTimeout(finish, 5);
        return repair;
      }),
    };
    return { runner, held, repairs };
  }

  const siblingFirst = async (parent: Session, held: ReturnType<typeof heldTasks>) => {
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(held.runner.spawned).toEqual(expect.arrayContaining(['a', 's'])), { timeout: 20_000 });
    held.release('s');
    await vi.waitFor(() => expect(statusOf(parent, 's')).toBe('completed'), { timeout: 20_000 });
    held.release('a');
  };
  const withSibling = () => [delegated(), check({ taskMode: 'plan' }), createTask({ id: 's', order: 3, title: 'Sibling', prompt: 'sibling' })];

  it.each([[false], [true]])('is repaired by a plain runner in the mode its autonomy gives, autonomous %s, in the kept worktree, and lands', async (autonomous) => {
    const on: { session?: Session } = {};
    const { runner, held, repairs } = conflicted(() => on.session!);
    const made = tree([SUBMIT([childTask('a', 1)]), DONE], { runner, tasks: withSibling(), config: { autonomousMode: autonomous, conflictRepairAttempts: 1 } });
    on.session = made.parent;
    await siblingFirst(made.parent, held);
    await vi.waitFor(() => expect(statusOf(made.parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(repairs).toHaveLength(1);
    expect(repairs[0].mode).toBe(resolveDefaultMode(new RunnerRegistry().get('claude-code')?.manifest.modes, autonomous));
    expect(repairs[0].mode).not.toBe('build');
    expect(repairs[0].prompt).toContain('tests/');
    expect(task(made.parent, 'd')?.taskMode).toBeUndefined();
    expect(made.planner.requests).toHaveLength(1);
    expect(git(made.root, 'show', `${integrationOf(made.parent)}:x.txt`)).toBe('both');
    // Its child's two names and its report outlast the repair, a plain runner with a session of its own.
    const child = made.parent.planState?.isolation?.run.tasks.d.childSession;
    expect(child).toBeDefined();
    expect(task(made.parent, 'd')?.runnerSessionId).toBe(child);
    expect(task(made.parent, 'd')?.handoff?.subtree?.counts.done).toBe(1);
    expect(task(made.parent, 'd')?.handoff?.summary).not.toBe('Repaired.');
    made.parent.destroy();
  });

  it('does not land a repair that changes a protected path, and waits on the user', async () => {
    const on: { session?: Session } = {};
    const { runner, held, repairs } = conflicted(() => on.session!, { edit: (cwd) => writeFileSync(join(cwd, 'tests', 'guard.txt'), 'the check reads nothing\n') });
    const made = tree([SUBMIT([childTask('a', 1)]), DONE], { runner, tasks: withSibling(), config: { conflictRepairAttempts: 1 } });
    on.session = made.parent;
    await siblingFirst(made.parent, held);
    await vi.waitFor(() => expect(task(made.parent, 'd')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'conflict' }), { timeout: 20_000 });
    expect(repairs).toHaveLength(1);
    expect(git(made.root, 'show', `${integrationOf(made.parent)}:tests/guard.txt`)).toBe('the check reads this');
    expect(task(made.parent, 'd')?.runnerSessionId).toBe(made.parent.planState?.isolation?.run.tasks.d.childSession);
    expect(task(made.parent, 'd')?.handoff?.subtree).toBeDefined();
    made.parent.destroy();
  });

  it('takes no check back: it goes on with the result its verdict judged', async () => {
    const on: { session?: Session } = {};
    const { runner, held, repairs } = conflicted(() => on.session!, { waitsFor: () => statusOf(on.session!, 'c') === 'skipped' });
    const made = tree([SUBMIT([childTask('a', 1)]), DONE], { runner, tasks: withSibling(), config: { conflictRepairAttempts: 1 } });
    on.session = made.parent;
    await siblingFirst(made.parent, held);
    await vi.waitFor(() => expect(repairs).toHaveLength(1), { timeout: 20_000 });
    await made.parent.execute({ command: 'skip_task', task: 'c' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(made.parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(statusOf(made.parent, 'c')).toBe('skipped');
    made.parent.destroy();
  });

  it('gives a resolver the mode its autonomy gives, as a delegated task has none to hand on', async () => {
    const on: { session?: Session } = {};
    const { runner, held } = conflicted(() => on.session!);
    const made = tree([SUBMIT([childTask('a', 1)]), DONE], { runner, tasks: withSibling(), config: { conflictRepairAttempts: 0, autonomousMode: false } });
    on.session = made.parent;
    await siblingFirst(made.parent, held);
    await vi.waitFor(() => expect(task(made.parent, 'd')?.awaitingReason).toBe('conflict'), { timeout: 20_000 });
    const asked = made.parent.escalations().find((e) => e.kind === 'conflict');
    expect(await made.parent.answerEscalation(asked!.id, 'resolve-conflict')).toMatchObject({ ok: true });
    const resolver = made.parent.planTasks.find((t) => t.title.startsWith('Resolve merge conflict'));
    expect(resolver?.taskMode).toBe(resolveDefaultMode(new RunnerRegistry().get('claude-code')?.manifest.modes, false));
    made.parent.destroy();
  });

  it('waits in the inbox once no repair is left, its work kept, and starts no new child', async () => {
    const on: { session?: Session } = {};
    const { runner, held, repairs } = conflicted(() => on.session!);
    const made = tree([SUBMIT([childTask('a', 1)]), DONE], { runner, tasks: withSibling(), config: { conflictRepairAttempts: 0 } });
    on.session = made.parent;
    await siblingFirst(made.parent, held);
    await vi.waitFor(() => expect(task(made.parent, 'd')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'conflict' }), { timeout: 20_000 });
    expect(repairs).toHaveLength(0);
    expect(made.planner.requests).toHaveLength(1);
    expect(made.parent.escalations().find((e) => e.kind === 'conflict')?.task?.id).toBe('d');
    made.parent.destroy();
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

describe('outward effects (ADR-0056 M9)', () => {
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
      taskShell: ({ cwd, writable, worktrees }) => ({
        run: () => Promise.reject(new Error('a script runs through hold')),
        hold: <T>(work: (runs: OwnSealedRuns) => Promise<T>) => work({ worktrees: worktrees?.length ? worktrees : [writable ?? cwd], touched: false, scratch: '', run }),
        end: () => undefined,
      }),
    };
    return { fsAdapter, ran };
  }
  const script = (commands: string[][]) => ({ id: 't', order: 2, title: 'Test it', description: 'test', type: 'script', sliceType: 'AFK', commands, dependencies: ['a'] });
  const effectGranted = () => [delegated({ grants: ['effect'] }), check()];

  it('runs a body the rules cover at every level in the child\'s checkout, with `effect`', async () => {
    const { fsAdapter, ran } = sealedFs();
    const { parent } = tree([SUBMIT([childTask('a', 1), script([['cat', 'a.txt']])]), DONE], { fsAdapter, tasks: effectGranted(), config: { effectAllowlist: ['cat a.txt'] } });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(ran).toHaveLength(0);
    parent.destroy();
  });

  it('seals a body the rules do not cover, `effect` or no', async () => {
    const { fsAdapter, ran } = sealedFs();
    const { parent } = tree([SUBMIT([childTask('a', 1), script([['ls']])]), DONE], { fsAdapter, tasks: effectGranted(), config: { effectAllowlist: ['cat a.txt'] } });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(ran).toHaveLength(1);
    parent.destroy();
  });

  it('refuses an edit that moves a covered body past the rules', async () => {
    const { fsAdapter } = sealedFs();
    const replies: { text: string; isError?: boolean }[] = [];
    const quiet = { signal: new AbortController().signal };
    const SUBMIT_THEN_EDIT: Turn = async (tools, text) => {
      await SUBMIT([childTask('a', 1), script([['cat', 'a.txt']])])(tools, text);
      replies.push(await tools.editPlan!({ ops: [{ op: 'update', taskId: 't', changes: { commands: [['ls']] } }] } as never, quiet));
      await tools.taskComplete!({ status: 'blocked', summary: 'Stopping here.', reason: 'Stopping here.' }, quiet);
    };
    const { parent } = tree([SUBMIT_THEN_EDIT], { fsAdapter, tasks: effectGranted(), config: { effectAllowlist: ['cat a.txt'] } });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(replies).toHaveLength(1), { timeout: 20_000 });
    expect(replies[0]).toMatchObject({ isError: true, text: expect.stringContaining('effect rules') });
    parent.destroy();
  });

  it('seals a script a subplanner adds with run_script, with no `effect`', async () => {
    const { fsAdapter, ran } = sealedFs();
    const RUN: Turn = async (tools) => {
      await tools.runScript!({ title: 'Look', commands: [['ls']] } as never, { signal: new AbortController().signal });
    };
    const { parent } = tree([RUN, NOTHING_THEN_BLOCKED], { fsAdapter });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(ran).toHaveLength(1), { timeout: 20_000 });
    parent.destroy();
  });

  it('refuses a child\'s script where nothing can seal it', async () => {
    const refused: string[] = [];
    const TRY: Turn = async (tools) => {
      const reply = await tools.submitPlan!({ tasks: [childTask('a', 1), script([['ls']])] as never }, { signal: new AbortController().signal });
      refused.push(reply.text);
    };
    const { parent } = tree([TRY, NOTHING_THEN_BLOCKED]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(refused).toHaveLength(1), { timeout: 20_000 });
    expect(refused[0]).toContain('no sandbox to seal');
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
  it('denies a runner\'s approval at once, and tells the next run update: nobody below the root may allow it', async () => {
    const asked = { session: null as FakeRunnerSession | null };
    const runner = writingRunner({ a: ['a.txt'] }, { asks: (session) => { asked.session ??= session; } });
    const { parent, planner } = tree([SUBMIT([childTask('a', 1)]), DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(asked.session?.answers[0]?.decision).toMatchObject({ decision: 'deny' });
    expect(planner.asked[1]).toContain('denied');
    parent.destroy();
  });

  it('refuses what its shell would ask, so it runs sealed: nobody could answer, and the turn would wait out the clock', async () => {
    const policies: IApproval[] = [];
    const fsAdapter = { ...fakeFs(), setApproval: (policy: IApproval) => { policies.push(policy); } };
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { fsAdapter });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });

    const subplanners = policies.at(-1)!;
    const asked = subplanners.request({ kind: 'shell_command', subject: 'sleep 90', scope: 'sleep' });
    expect(await Promise.race([asked, new Promise((resolve) => setTimeout(() => resolve('still waiting on a person'), 200))])).toBe(false);
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

describe('wall-clock time (ADR-0056 M3)', () => {
  /** A runner's own words for a limit that resets well past any test, read from the clock so the hour never matters. */
  const limitWords = () => {
    const at = new Date(Date.now() + 3 * 3_600_000);
    const hours = at.getUTCHours() % 12 || 12;
    return `You've hit your session limit · resets ${hours}:${String(at.getUTCMinutes()).padStart(2, '0')}${at.getUTCHours() < 12 ? 'am' : 'pm'} (UTC)`;
  };
  const shortly = () => new Promise((resolve) => { setTimeout(resolve, 3500); });

  it('stops while the tree is held on a usage limit found by a task, so its time does not run out', async () => {
    const spawned: string[] = [];
    const runner: IRunner = {
      spawn: vi.fn(async (opts) => {
        spawned.push(opts.taskId);
        const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
        setTimeout(() => {
          const said = limitWords();
          session.emitEvent({ type: 'error', message: said });
          session.emitOutput(`${said}\n`);
          session.emitTurnEnd('failed');
        }, 5);
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    const { parent, planner } = tree([SUBMIT([childTask('a', 1)])], { runner, tasks: [delegated({ budget: { tokens: 2_000_000, wallClockMs: 1500 } }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toContain('a'), { timeout: 20_000 });
    await shortly();
    expect(statusOf(parent, 'd')).toBe('in_progress');
    expect(planner.asked).toHaveLength(1);
    parent.destroy();
  });

  it('stops for a subplanner\'s own limit too, and sends it no reminder while it waits to resend', async () => {
    const { parent, planner } = tree([async () => undefined, async () => ({ kind: 'message', text: limitWords(), failed: true, researchLog: [] })], { tasks: [delegated({ budget: { tokens: 2_000_000, wallClockMs: 1500 } }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(planner.asked).toHaveLength(2), { timeout: 20_000 });
    await shortly();
    expect(parent.planTasks.find((t) => t.id === 'd')?.verdict?.reason).toBeUndefined();
    expect(statusOf(parent, 'd')).toBe('in_progress');
    expect(planner.asked).toHaveLength(2);
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
