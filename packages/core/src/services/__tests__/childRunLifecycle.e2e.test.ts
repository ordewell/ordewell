import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { LeaseHost } from '../sessionLease';
import { Subtree } from '../Subtree';
import { taskRowView } from '../../taskRow';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import type { Session, SessionDeps } from '../createSession';
import type { ConversationRequest, ConversationTurn, IAiService } from '../AiService';
import type { PlannerToolHandler } from '../mcp';
import type { IRunner } from '../../interfaces/IRunner';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { listChildSessions, listSessions, loadChildSession, loadSession, saveChildSession, saveSession } from '../../utils/sessionStore';
import { openTaskLog } from '../../utils/taskLogStore';
import { fakeFs, makeSession, type PlannerTurn as Turn } from './sessionTestKit';

/*
 * What ends a child and what brings it back, on real repositories (ADR-0055
 * D15, D16, D17, ADR-0056 M5, M10): a Stop is a tombstone first and reaches the
 * whole subtree, a restart starts nothing, a Continue reopens the child, and a
 * fresh attempt or a removal discards it.
 */

const env = () => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k];
  return e;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

function repo(): string {
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

interface Runner extends IRunner {
  spawned: string[];
  stopped: string[];
  /** Finishes what `held` keeps waiting. */
  release(taskId: string): void;
  /** Lets a stop `heldStops` keeps from resolving resolve. */
  letStop(taskId: string): void;
}

/** A runner that writes each task's files and reports done, but for the tasks named in `held`, which wait for {@link Runner.release}. */
function fakeRunner(files: Record<string, string[]>, { held = [], heldOnce = [], heldStops = [], usage = 0 }: { held?: string[]; heldOnce?: string[]; heldStops?: string[]; usage?: number } = {}): Runner {
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

const isolation = (): IWorktreeIsolation => createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) });
const planOf = (tasks: Task[]): LegacyPlanState => ({ tasks, runners: ['claude-code'], status: 'approved', generatedAt: '2026-11-01T10:00:00.000Z' } as unknown as LegacyPlanState);

const delegated = (over: Partial<Task> = {}) => createTask({
  id: 'd', order: 1, title: 'Delegated subtree', type: 'delegated', goal: 'Write a and b', budget: { tokens: 2_000_000 }, protectedPaths: ['tests/'], ...over,
});
const check = (over: Partial<Task> = {}) => createTask({ id: 'c', order: 2, title: 'Check the subtree', prompt: 'read it', dependencies: ['d'], ...over });

const SIGNAL = new AbortController().signal;

const SUBMIT = (tasks: unknown[]): Turn => async (tools) => {
  const reply = await tools.submitPlan!({ tasks: tasks as never }, { signal: SIGNAL });
  if (reply.isError) throw new Error(reply.text);
};

const childTask = (id: string, order: number, dependencies: string[] = []) => ({
  id, order, title: `Write ${id}`, description: id, type: 'ai', prompt: `write ${id}`, sliceType: 'AFK', autonomy: 'AFK', dependencies,
});

const DONE: Turn = async (tools) => {
  const reply = await tools.taskComplete!({ status: 'done', summary: 'It is written.', commit: { subject: 'Write it' } }, { signal: SIGNAL });
  if (reply.isError) throw new Error(reply.text);
};
const NOTHING: Turn = async () => undefined;
const BLOCKED: Turn = async (tools) => {
  await tools.taskComplete!({ status: 'blocked', summary: 'Not now.', reason: 'Nothing is ready.' }, { signal: SIGNAL });
};

interface TreeOptions {
  runner?: IRunner;
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
function stoppablePlanner(turns: Turn[], { sessionless = false } = {}) {
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

function tree(turns: Turn[], { runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }), tasks = [delegated(), check()], tokens = () => 5_000_000, root = repo(), leaseHost = new LeaseHost(), plan, sessionId = 'session-root', rootTurns, notifications, parallel = 3, sessionless }: TreeOptions = {}) {
  const planner = stoppablePlanner(turns, { sessionless });
  const parent = makeSession({
    runner, isolation: isolation(), workspaceRoot: () => root, saveSession, openTaskLog, leaseHost, sessionId,
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

const statusOf = (session: Session, id: string) => session.planTasks.find((t) => t.id === id)?.status;
const taskOf = (session: Session, id: string) => session.planTasks.find((t) => t.id === id)!;

describe('a Stop (ADR-0055 D16)', () => {
  it('reaches a live planner turn, and resolves only once the subtree has gone', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { held: ['a'], heldStops: ['a'] });
    let turnStopped = false;
    // A turn that hangs with its run going, until it is stopped.
    const LIVE: Turn = async (tools) => {
      await SUBMIT([childTask('a', 1)])(tools, '');
      await tools.runPlan!({}, { signal: SIGNAL });
      await new Promise<void>(() => undefined);
    };
    const { parent } = tree([LIVE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'));

    parent.stopExecution();
    const gone = parent.stopSubtree().then(() => { turnStopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The runner has not gone, so neither has the subtree: there is no timeout of its own.
    expect(turnStopped).toBe(false);
    expect(runner.stopped).toContain('a');
    runner.letStop('a');
    await gone;
    expect(statusOf(parent, 'd')).toBe('pending');
    parent.destroy();
  });
});

const worktrees = (root: string) => git(root, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
const branches = (root: string) => git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');
const childIdOf = (session: Session, id: string) => session.planState?.isolation?.run.tasks[id]?.childSession;
const worktreesOf = (root: string, sessionRun: string | undefined) => worktrees(root).filter((dir) => sessionRun && dir.includes(sessionRun));

/** The child's run, as its saved file names it. */
function childRunId(root: string, childSession: string): string | undefined {
  return loadChildSession({ baseDir: root, rootSessionId: 'session-root', sessionId: childSession })?.plan.isolation?.run.id;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a Stop, read below it', () => {
  it('refuses what a turn still winding down asks to start, at the claim', async () => {
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }, { held: ['a'] });
    let reply: { text: string; isError?: boolean } | undefined;
    let go = () => undefined as void;
    const past = new Promise<void>((resolve) => { go = resolve; });
    const WINDING: Turn = async (tools) => {
      await SUBMIT([childTask('a', 1), childTask('b', 2)])(tools, '');
      await tools.runTask!({ task: 'a' }, { signal: SIGNAL });
      await past;
      reply = await tools.runTask!({ task: 'b' }, { signal: SIGNAL });
    };
    const { parent } = tree([WINDING], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'));
    parent.stopExecution();
    go();
    await parent.stopSubtree();
    await vi.waitFor(() => expect(reply).toBeDefined());
    expect(runner.spawned).not.toContain('b');
    expect(reply?.isError).toBeTruthy();
    parent.destroy();
  });

  it('reaches every level: a grandchild\'s runner stops with its root, and its budget comes back', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { held: ['a'] });
    const nested = [
      { id: 'n', order: 1, title: 'Nested', description: 'n', type: 'delegated', goal: 'Write a', budget: { tokens: 800_000 }, protectedPaths: ['tests/'], sliceType: 'AFK', assignedRunner: 'claude-code', dependencies: [] },
      { id: 'nc', order: 2, title: 'Check nested', description: 'nc', type: 'ai', prompt: 'read it', readOnly: true, sliceType: 'AFK', autonomy: 'AFK', dependencies: ['n'] },
    ];
    const { parent } = tree([SUBMIT(nested), SUBMIT([childTask('a', 1)])], { runner, tasks: [delegated({ grants: ['delegate'] }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'), { timeout: 20_000 });

    parent.stopExecution();
    await parent.stopSubtree();
    expect(runner.stopped).toContain('a');
    const ledger = await parent.ledger();
    expect(ledger.numbers('root').committed).toBe(0);
    parent.destroy();
  });

  it('closes a child that was opening as the Stop came, so its budget comes back', async () => {
    const root = repo();
    const planner = stoppablePlanner([]);
    let built = false;
    const parent: Session = makeSession({
      runner: fakeRunner({}), isolation: isolation(), workspaceRoot: () => root, saveSession, openTaskLog, leaseHost: new LeaseHost(), sessionId: 'session-root',
      config: fakeConfig({ maxParallelSessions: 3 }),
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: 5_000_000 } }),
      delegationOffered: true,
      childDeps: () => {
        // As it is built: the carve has taken, and nothing has started.
        parent.stopExecution();
        built = true;
        return { aiService: planner.service(), fsAdapter: { ...fakeFs(), getWorkspaceRoot: () => root } };
      },
    });
    parent.loadPlan(planOf([delegated(), check()]), 'the root goal', root, { sessionId: 'session-root' });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(built).toBe(true));
    await parent.stopSubtree();
    await wait(50);
    expect((await parent.ledger()).numbers('root').committed).toBe(0);
    expect(planner.asked).toEqual([]);
    parent.destroy();
  });
});

describe('a budget stop (ADR-0056 M5)', () => {
  it('does what a Stop does, a live turn included, and ends the task blocked with a derived report', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { usage: 3_000_000 });
    const LIVE: Turn = async (tools) => {
      await SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])])(tools, '');
      await tools.runPlan!({}, { signal: SIGNAL });
      await new Promise<void>(() => undefined);
    };
    const { parent } = tree([LIVE], { runner, tasks: [delegated({ budget: { tokens: 400_000 } }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(taskOf(parent, 'd').verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('out of budget') });
    expect(taskOf(parent, 'd').handoff?.summary).toContain('"Write a"');
    expect(runner.spawned).not.toContain('b');
    parent.destroy();
  });
});

describe('a refused carve (ADR-0056 M5)', () => {
  it('leaves no name of a child that never existed', async () => {
    const { parent } = tree([], { tasks: [delegated({ budget: { tokens: 9_000_000 } }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(childIdOf(parent, 'd')).toBeUndefined();
    expect(taskOf(parent, 'd').runnerSessionId).toBeUndefined();
    parent.destroy();
  });
});

describe('a fresh attempt (ADR-0055 D15)', () => {
  /** A child that ends blocked with its task's worktree in place: there is a run of its own to discard. */
  async function blockedChild(over: TreeOptions = {}) {
    const runner = over.runner ?? fakeRunner({ a: ['a.txt'] });
    const built = tree([SUBMIT([childTask('a', 1)]), BLOCKED, SUBMIT([childTask('a', 1)]), DONE], { runner, ...over });
    await built.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(built.parent, 'd')).toBe('failed'), { timeout: 20_000 });
    const child = childIdOf(built.parent, 'd')!;
    return { ...built, child, run: childRunId(built.root, child)! };
  }

  /** A child stopped with a task at work: its own run stands, worktree and integration branch, as one that finished and merged does not. */
  async function stoppedChild(over: TreeOptions = {}) {
    const runner = fakeRunner({ a: ['a.txt'] }, { heldOnce: ['a'] });
    const built = tree([SUBMIT([childTask('a', 1)]), SUBMIT([childTask('a', 1)]), DONE], { runner, ...over });
    await built.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'), { timeout: 20_000 });
    built.parent.stopExecution();
    await built.parent.stopSubtree();
    const child = childIdOf(built.parent, 'd')!;
    const run = childRunId(built.root, child)!;
    expect(worktreesOf(built.root, run)).not.toEqual([]);
    expect(integrationOf(built.root, run)).not.toEqual([]);
    return { ...built, child, run };
  }

  const integrationOf = (root: string, run: string) => branches(root).filter((name) => name.includes(run) && name.endsWith('integration'));

  const expectStartedOver = (root: string, parent: Session, child: string, run: string) => {
    expect(childIdOf(parent, 'd')).not.toBe(child);
    expect(worktreesOf(root, run)).toEqual([]);
    expect(integrationOf(root, run)).toEqual([]);
    // Its state stays, under the root.
    expect(loadChildSession({ baseDir: root, rootSessionId: 'session-root', sessionId: child })).not.toBeNull();
  };

  it('discards the old child on a fresh retry, and starts a new one on what is left of the budget', async () => {
    const { root, parent, child, run } = await blockedChild({ runner: fakeRunner({ a: ['a.txt'] }, { usage: 300_000 }) });
    const spent = (await parent.ledger()).spentOn('root', 'd');
    expect(spent).toBeGreaterThan(0);
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expectStartedOver(root, parent, child, run);
    const ledger = await parent.ledger();
    expect(ledger.numbers('root').committed).toBe(0);
    parent.destroy();
  });

  it('discards it on Execute', async () => {
    const { root, parent, child, run } = await stoppedChild();
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expectStartedOver(root, parent, child, run);
    parent.destroy();
  });

  it('discards it on a force start', async () => {
    const { root, parent, child, run } = await stoppedChild();
    expect(await parent.execute({ command: 'force_start', task: 'd' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expectStartedOver(root, parent, child, run);
    parent.destroy();
  });

  it('never mints budget: a task that spent it all has nothing to start a child on', async () => {
    const { parent, planner } = await blockedChild({ runner: fakeRunner({ a: ['a.txt'] }, { usage: 2_100_000 }) });
    const asked = planner.asked.length;
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(taskOf(parent, 'd').verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('has spent its budget') }), { timeout: 20_000 });
    expect(planner.asked).toHaveLength(asked);
    parent.destroy();
  });

  it('discards it as the task is removed, and its budget is back', async () => {
    const { root, parent, child, run } = await stoppedChild({ tasks: [delegated(), check({ dependencies: [] })] });
    await parent.removeTask('d');
    await vi.waitFor(() => expect(worktreesOf(root, run)).toEqual([]));
    await vi.waitFor(() => expect(integrationOf(root, run)).toEqual([]));
    expect(loadChildSession({ baseDir: root, rootSessionId: 'session-root', sessionId: child })).not.toBeNull();
    expect((await parent.ledger()).numbers('root').committed).toBe(0);
    parent.destroy();
  });

  it('discards it as a planner\'s edit takes the task out between runs', async () => {
    const REMOVE: Turn = async (tools) => {
      const reply = await tools.editPlan!({ ops: [{ op: 'remove', taskId: 'd' }] }, { signal: SIGNAL });
      if (reply.isError) throw new Error(reply.text);
    };
    const { root, parent, run } = await stoppedChild({ tasks: [delegated(), check({ dependencies: [] })], rootTurns: [REMOVE] });
    await parent.continueConversation('drop that task');
    expect(statusOf(parent, 'd')).toBeUndefined();
    await vi.waitFor(() => expect(worktreesOf(root, run)).toEqual([]));
    await vi.waitFor(() => expect(integrationOf(root, run)).toEqual([]));
    parent.destroy();
  });

  it('goes with the run\'s own discard, which nothing else names it to', async () => {
    const { root, parent, run } = await stoppedChild();
    await parent.discardRun();
    expect(worktreesOf(root, run)).toEqual([]);
    expect(integrationOf(root, run)).toEqual([]);
    expect(taskOf(parent, 'd').runnerSessionId).toBeUndefined();
    parent.destroy();
  });

  it('waits for a child still stopping: it cannot be discarded under what is winding down', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { heldOnce: ['a'], heldStops: ['a'] });
    const { root, parent } = tree([SUBMIT([childTask('a', 1)]), SUBMIT([childTask('a', 1)]), DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'), { timeout: 20_000 });
    const child = childIdOf(parent, 'd')!;
    const run = childRunId(root, child)!;
    parent.stopExecution();
    const fresh = parent.execute({ command: 'force_start', task: 'd' }, { kind: 'user' });
    await wait(100);
    expect(worktreesOf(root, run)).not.toEqual([]);
    runner.letStop('a');
    await fresh;
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expectStartedOver(root, parent, child, run);
    parent.destroy();
  });
});

describe('a Continue (ADR-0055 D17)', () => {
  it('reopens the child a Stop left, with what it had landed, and acts as Execute there', async () => {
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }, { held: ['b'] });
    const { root, parent, planner } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), NOTHING, DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('b'), { timeout: 20_000 });
    const child = childIdOf(parent, 'd')!;
    const run = childRunId(root, child)!;

    parent.stopExecution();
    await parent.stopSubtree();
    expect(statusOf(parent, 'd')).toBe('pending');
    expect(taskOf(parent, 'd').runnerSessionId).toBe(child);
    // The Stop left the child's worktrees, which only a discard takes.
    expect(branches(root).filter((name) => name.includes(run))).not.toEqual([]);

    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'go on' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(runner.spawned.filter((id) => id === 'b')).toHaveLength(2), { timeout: 20_000 });
    expect(childIdOf(parent, 'd')).toBe(child);
    expect(runner.spawned.filter((id) => id === 'a')).toHaveLength(1);
    runner.release('b');
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(planner.asked.join('\n')).toContain('go on');
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
    parent.destroy();
  });

  it('says on a Stop that a Continue keeps a child\'s work and running the plan starts it over', async () => {
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }, { held: ['b'] });
    const { parent } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])])], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('b'), { timeout: 20_000 });

    const stopped = await parent.execute({ command: 'stop_run' }, { kind: 'user' });

    expect(stopped.message).toContain('Continue');
    expect(stopped.message).toContain('starts its child over');
    expect(stopped.message).not.toContain('Run the plan or a task to start again');
    await parent.stopSubtree();
    parent.destroy();
  });

  it('says the same in what it tells a surface as it stops the task: Mark complete and Retry are not what keeps a child', async () => {
    const told: string[] = [];
    const say = (message: string) => { told.push(message); };
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }, { held: ['b'] });
    const { parent } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])])], { runner, notifications: { info: say, warn: say, error: say, confirm: vi.fn().mockResolvedValue(undefined) } });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('b'), { timeout: 20_000 });

    await parent.execute({ command: 'stop_run' }, { kind: 'user' });

    const said = told.find((line) => line.startsWith('Stopped'));
    expect(said).toContain('Continue keeps what its child landed');
    expect(said).not.toContain('Mark complete');
    await parent.stopSubtree();
    parent.destroy();
  });

  it('gives the subplanner its turn where nothing is left to run, so a child that only owes its report can file it', async () => {
    const runner = fakeRunner({ a: ['a.txt'] });
    const { root, parent, planner } = tree([SUBMIT([childTask('a', 1)]), BLOCKED, DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });

    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'file your report' }, { kind: 'user' })).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(planner.asked.join('\n')).toContain('file your report');
    expect(runner.spawned.filter((id) => id === 'a')).toHaveLength(1);
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).toContain('a.txt');
    parent.destroy();
  });

  it('reopens in the same run while a Stop has yet to take the record off active, or the child\'s landed work is left behind', async () => {
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }, { held: ['b'] });
    const { root, parent } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), NOTHING, DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('b'), { timeout: 20_000 });
    const before = parent.planState?.isolation?.run.id;
    parent.stopExecution();
    await parent.stopSubtree();
    // As a Continue finds it when the Stop's keep has not run yet.
    const record = parent.planState?.isolation?.run.tasks.d;
    await vi.waitFor(() => expect(record?.status).toBe('kept'));
    record!.status = 'active';

    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'go on' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(runner.spawned.filter((id) => id === 'b')).toHaveLength(2), { timeout: 20_000 });
    expect(parent.planState?.isolation?.run.id).toBe(before);
    runner.release('b');
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
    parent.destroy();
  });

  it('refuses a child whose worktree has moved, rather than lose what it landed', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { held: ['a'] });
    const errors = vi.fn();
    const { root, parent, planner } = tree([SUBMIT([childTask('a', 1)])], { runner, notifications: { info: vi.fn(), warn: vi.fn(), error: errors, confirm: vi.fn().mockResolvedValue(undefined) } });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'), { timeout: 20_000 });
    parent.stopExecution();
    await parent.stopSubtree();
    const place = { baseDir: root, rootSessionId: 'session-root', sessionId: childIdOf(parent, 'd')! };
    const saved = loadChildSession(place)!;
    saved.plan.isolation!.run.workspaceRoot = join(root, 'somewhere-else');
    saveChildSession(saved.plan, saved.meta.goal, place);
    const asked = planner.asked.length;

    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'go on' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(taskOf(parent, 'd').verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('has moved') }), { timeout: 20_000 });
    expect(planner.asked).toHaveLength(asked);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.stringContaining('has moved')), { timeout: 20_000 });
    parent.destroy();
  });

  it('is refused once its work has landed', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'go on' }, { kind: 'user' })).toMatchObject({ ok: false, message: expect.stringContaining('has landed') });
    parent.destroy();
  });

  it('spends what is left of its stated budget when nothing raised it', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { usage: 1_500_000, held: [] });
    const { parent } = tree([SUBMIT([childTask('a', 1)]), BLOCKED, DONE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    const carves = vi.spyOn(await parent.ledger(), 'carve');
    await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'finish' }, { kind: 'user' });
    await vi.waitFor(() => expect(carves).toHaveBeenCalled(), { timeout: 20_000 });
    expect(carves.mock.calls[0][2].tokens).toBe(500_000);
    parent.destroy();
  });

  /** A child stopped at its only task, then raised by `raise`, whose usage comes as that task ends. */
  async function raisedThenBlocked(raise: number, usage: number) {
    const runner = fakeRunner({ a: ['a.txt'] }, { usage, held: ['a'] });
    const built = tree([SUBMIT([childTask('a', 1)]), BLOCKED, DONE], { runner });
    await built.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'), { timeout: 20_000 });
    expect(await built.parent.raiseChild('d', raise)).toBeNull();
    runner.release('a');
    await vi.waitFor(() => expect(statusOf(built.parent, 'd')).toBe('failed'), { timeout: 20_000 });
    return built;
  }

  it('re-carves its stated budget and every raise, less what it spent: a raise is the task\'s, and outlives its child', async () => {
    const { parent } = await raisedThenBlocked(1_000_000, 2_500_000);
    const carves = vi.spyOn(await parent.ledger(), 'carve');
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'finish' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(carves).toHaveBeenCalled(), { timeout: 20_000 });
    expect(carves.mock.calls[0][2].tokens).toBe(500_000);
    parent.destroy();
  });

  it('names what the tree granted when that is spent too', async () => {
    const { parent } = await raisedThenBlocked(500_000, 2_600_000);
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(taskOf(parent, 'd').verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('its budget of 2500000 tokens') }), { timeout: 20_000 });
    parent.destroy();
  });

  it('runs on the time left: a Continue gets no fresh clock', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), BLOCKED, DONE], { tasks: [delegated({ budget: { tokens: 2_000_000, wallClockMs: 3_600_000 } }), check()] });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    const spent = taskOf(parent, 'd').attemptUsage?.at(-1)?.wallTimeMs ?? 0;
    expect(spent).toBeGreaterThan(0);
    const carves = vi.spyOn(await parent.ledger(), 'carve');
    await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'finish' }, { kind: 'user' });
    await vi.waitFor(() => expect(carves).toHaveBeenCalled(), { timeout: 20_000 });
    expect(carves.mock.calls[0][2].wallClockMs).toBe(3_600_000 - spent);
    parent.destroy();
  });
});

describe('a reopened child, read from above (ADR-0057 R1)', () => {
  const reopened = new Subtree({
    here: 'root',
    tasks: () => [{ ...delegated(), runnerSessionId: 'child' }],
    nodes: () => [{ path: 'root/1', sessionId: 'child', taskId: 'd' }, { path: 'root/2', sessionId: 'child', taskId: 'd' }],
    plan: () => [delegated()],
    logs: () => ({ attempts: () => [], events: () => [] }),
  });

  it('counts its one plan once, though a Continue opened it a second node', () => {
    expect(reopened.plans().map((plan) => plan.node)).toEqual(['root/2']);
  });

  it('still reads what a reference pinned against its first node', () => {
    expect(reopened.planAt('root/1')?.node).toBe('root/1');
  });
});

describe('a delegated task started alone, on a Continue (ADR-0055 D8)', () => {
  it('starts its check by itself once the child reports', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), BLOCKED, DONE], { tasks: [delegated(), check({ taskMode: 'plan' })] });
    await parent.execute({ command: 'run_task', task: 'd' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'finish' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'c')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('asks for what the user has not approved, and says so rather than read as finished', async () => {
    const { parent } = tree([SUBMIT([childTask('a', 1)]), DONE], { tasks: [delegated(), check({ taskMode: 'plan' })] });
    Object.assign(parent.planState!, { approved: false, approvedTasks: [] });
    await parent.execute({ command: 'run_task', task: 'd' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    await vi.waitFor(() => expect(parent.escalations().find((e) => e.task?.id === 'c')).toMatchObject({ kind: 'unapproved', reason: expect.stringContaining('Its delegated task has ended') }), { timeout: 20_000 });
    expect(statusOf(parent, 'c')).toBe('pending');
    expect(parent.startsPending).toBe(true);
    parent.stopExecution();
    expect(parent.startsPending).toBe(false);
    parent.destroy();
  });
});

describe('a crash in the middle of a child run (ADR-0055 D17)', () => {
  /** The disk at this instant, as a process that died here left it. */
  function crashImage(root: string): string {
    const image = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-crash-image-')));
    roots.push(image);
    cpSync(join(root, '.ordewell', 'sessions'), image, { recursive: true });
    return image;
  }

  /** Put the disk back, and open a new process's Session on it. */
  function restart(root: string, image: string, turns: Turn[], runner: IRunner) {
    rmSync(join(root, '.ordewell', 'sessions'), { recursive: true, force: true });
    // Held by a process that is gone: this test's is not, so the file goes as a dead host's would be taken over.
    cpSync(image, join(root, '.ordewell', 'sessions'), { recursive: true, filter: (from) => !from.endsWith('lease.json') });
    const plan = loadSession('session-root', root)!.plan;
    return tree(turns, { root, plan, runner, leaseHost: new LeaseHost() });
  }

  async function midRun() {
    const first = fakeRunner({ a: ['a.txt'] }, { held: ['b'] });
    const dead = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])])], { runner: first });
    await dead.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(first.spawned).toContain('b'), { timeout: 20_000 });
    await wait(50);
    const image = crashImage(dead.root);
    const child = childIdOf(dead.parent, 'd')!;
    dead.parent.destroy();
    await dead.parent.gone;
    return { root: dead.root, image, child };
  }

  it('starts nothing on load, and lists the task, failed, naming its child', async () => {
    const { root, image, child } = await midRun();
    const runner = fakeRunner({ b: ['b.txt'] });
    const { parent, planner } = restart(root, image, [], runner);
    await wait(100);
    expect(runner.spawned).toEqual([]);
    expect(planner.asked).toEqual([]);
    expect(taskOf(parent, 'd')).toMatchObject({ status: 'failed', runnerSessionId: child });
    expect(parent.escalations().map((e) => e.task?.id)).toContain('d');
    // Its worktree is the child's code root, so the adoption's prune left it.
    await vi.waitFor(() => expect(parent.planState?.isolation?.run.tasks.d.status).toBe('kept'));
    parent.destroy();
  });

  it('says it lost a parked question, in the row and the inbox, and a Continue keeps the child', async () => {
    const ASK: Turn = async (tools) => { await tools.checkpoint!({ question: 'Which schema?' }, { signal: SIGNAL }); };
    const dead = tree([SUBMIT([childTask('a', 1)]), ASK], { runner: fakeRunner({ a: ['a.txt'] }) });
    await dead.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(taskOf(dead.parent, 'd')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint', parkedQuestion: 'Which schema?' }), { timeout: 20_000 });
    await wait(50);
    const image = crashImage(dead.root);
    const child = childIdOf(dead.parent, 'd')!;
    dead.parent.destroy();
    await dead.parent.gone;

    const { parent, planner } = restart(dead.root, image, [DONE], fakeRunner({}));
    expect(taskOf(parent, 'd')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'question-lost', runnerSessionId: child });
    expect(taskRowView(taskOf(parent, 'd')).awaiting).toBe('Question lost in a restart');
    const listed = parent.escalations().find((e) => e.task?.id === 'd')!;
    expect(listed.reason).toContain('Which schema?');
    expect(listed.reason).toContain('Ordewell stopped before anyone answered it');
    expect(listed.options.map((o) => o.id)).toContain('continue');
    expect(planner.asked).toEqual([]);

    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'Use the first.' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(taskOf(parent, 'd').parkedQuestion).toBeUndefined();
    expect(childIdOf(parent, 'd')).toBe(child);
    parent.destroy();
  });

  it('comes back on a Continue: the child\'s interrupted task runs again, and its work lands', async () => {
    const { root, image, child } = await midRun();
    const runner = fakeRunner({ b: ['b.txt'] });
    const { parent, planner } = restart(root, image, [NOTHING, DONE], runner);
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'pick it up' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(runner.spawned).toEqual(['b']);
    expect(childIdOf(parent, 'd') ?? child).toBe(child);
    expect(planner.asked.join('\n')).toContain('pick it up');
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
    expect((await parent.ledger()).numbers('root').committed).toBe(0);
    parent.destroy();
  });

  it('starts over on a fresh retry instead: the child it left goes, and the budget it held comes back', async () => {
    const { root, image, child } = await midRun();
    const run = childRunId(root, child)!;
    const runner = fakeRunner({ a: ['a.txt'] });
    const { parent } = restart(root, image, [SUBMIT([childTask('a', 1)]), DONE], runner);
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(worktreesOf(root, run)).toEqual([]);
    expect((await parent.ledger()).numbers('root').committed).toBe(0);
    parent.destroy();
  });
});

describe('a Continue below a Continue (ADR-0055 D15, D17)', () => {
  const NESTED = [
    { id: 'n', order: 1, title: 'Nested', description: 'n', type: 'delegated', goal: 'Write a and b', budget: { tokens: 800_000 }, protectedPaths: ['tests/'], sliceType: 'AFK', assignedRunner: 'claude-code', dependencies: [] },
    { id: 'nc', order: 2, title: 'Check nested', description: 'nc', type: 'ai', prompt: 'read it', readOnly: true, sliceType: 'AFK', autonomy: 'AFK', dependencies: ['n'] },
  ];
  /** Whichever subplanner it reaches ends, once it may: levels wake in no fixed order, and a report too soon is refused. */
  const REPORT: Turn = async (tools) => { await tools.taskComplete!({ status: 'done', summary: 'It is written.', commit: { subject: 'Write it' } }, { signal: SIGNAL }); };
  const reports = (count: number): Turn[] => Array.from({ length: count }, () => REPORT);
  const childPlan = (root: string, sessionId: string) => loadChildSession({ baseDir: root, rootSessionId: 'session-root', sessionId })?.plan;

  function imageOf(root: string): string {
    const image = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-crash-image-')));
    roots.push(image);
    cpSync(join(root, '.ordewell', 'sessions'), image, { recursive: true });
    return image;
  }

  function restarted(root: string, image: string, turns: Turn[], runner: IRunner, { parallel, sessionless }: Pick<TreeOptions, 'parallel' | 'sessionless'> = {}) {
    rmSync(join(root, '.ordewell', 'sessions'), { recursive: true, force: true });
    cpSync(image, join(root, '.ordewell', 'sessions'), { recursive: true, filter: (from) => !from.endsWith('lease.json') });
    return tree(turns, { root, plan: loadSession('session-root', root)!.plan, runner, leaseHost: new LeaseHost(), parallel, sessionless });
  }

  const nestedTree = (turns: Turn[], runner: IRunner, over: Pick<TreeOptions, 'sessionless'> = {}) => tree([SUBMIT(NESTED), ...turns], { runner, tasks: [delegated({ grants: ['delegate'] }), check()], ...over });
  const grandchildOf = (root: string, child: string) => childPlan(root, child)!.tasks.find((t) => t.id === 'n')!;

  /** The process dies here, as `tree.parent` runs. */
  async function crashed({ root, parent }: ReturnType<typeof tree>) {
    await wait(50);
    const image = imageOf(root);
    const child = childIdOf(parent, 'd')!;
    parent.destroy();
    await parent.gone;
    return { root, image, child, grandchild: grandchildOf(root, child).runnerSessionId! };
  }

  async function midGrandchild(usage = 0, tasks = [childTask('a', 1), childTask('b', 2, ['a'])], over: Pick<TreeOptions, 'sessionless'> & { before?: (parent: Session) => Promise<unknown> } = {}) {
    const held = tasks.slice(1).map((t) => t.id);
    const first = fakeRunner({ a: ['a.txt'] }, { held, usage });
    const dead = nestedTree([SUBMIT(tasks)], first, over);
    await dead.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(first.spawned).toEqual(expect.arrayContaining(held)), { timeout: 20_000 });
    await over.before?.(dead.parent);
    return crashed(dead);
  }

  const goOn = (parent: Session) => parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'pick it up' }, { kind: 'user' });
  const workers = (runner: Runner) => runner.spawned.filter((id) => id !== 'c' && id !== 'nc');

  it('takes each subplanner\'s native session up again, and leaves the transcript whole for a harness that refuses', async () => {
    const first = fakeRunner({ a: ['a.txt'] }, { held: ['a'] });
    const dead = nestedTree([SUBMIT([childTask('a', 1)])], first);
    await dead.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(first.spawned).toContain('a'), { timeout: 20_000 });
    const before = [...dead.planner.natives];
    const { root, image } = await crashed(dead);

    const { parent, planner } = restarted(root, image, reports(8), fakeRunner({ a: ['a.txt'] }));
    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(planner.requests.map((request) => request.resume?.session.sessionId).sort()).toEqual([...before].sort());
    for (const request of planner.requests) expect(request.priorHistory?.length).toBeGreaterThan(0);
    parent.destroy();
  });

  it('keeps a grandchild\'s work: what it finished does not run again, and its run lands', async () => {
    const { root, image, child, grandchild } = await midGrandchild();
    const runner = fakeRunner({ b: ['b.txt'] });
    const { parent } = restarted(root, image, reports(8), runner);
    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(workers(runner)).toEqual(['b']);
    expect(grandchildOf(root, child).runnerSessionId).toBe(grandchild);
    const integration = parent.planState?.isolation?.run.repos[0].integrationBranch ?? '';
    expect(git(root, 'ls-tree', '-r', '--name-only', integration).split('\n')).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
    expect((await parent.ledger()).numbers('root').committed).toBe(0);
    parent.destroy();
  });

  it('never mints budget at any depth: a grandchild reopens on what its task has left, and each token counts once', async () => {
    const { root, image } = await midGrandchild(300_000);
    const { parent } = restarted(root, image, reports(8), fakeRunner({ b: ['b.txt'] }));
    const ledger = await parent.ledger();
    const carves = vi.spyOn(ledger, 'carve');
    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(carves.mock.calls.map(([, , request]) => request.tokens)).toEqual([2_000_000 - 300_000, 800_000 - 300_000]);
    expect(ledger.spentOn('root', 'd')).toBe(300_000);
    parent.destroy();
  });

  it('goes on after a Stop in the same process: the grandchild the Stop reached reopens', async () => {
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }, { heldOnce: ['b'] });
    const { root, parent } = nestedTree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), ...reports(8)], runner);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('b'), { timeout: 20_000 });
    parent.stopExecution();
    await parent.stopSubtree();
    const child = childIdOf(parent, 'd')!;
    const grandchild = grandchildOf(root, child).runnerSessionId;
    expect(grandchild).toBeTruthy();

    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(workers(runner)).toEqual(['a', 'b', 'b']);
    expect(grandchildOf(root, child).runnerSessionId).toBe(grandchild);
    parent.destroy();
  });

  it('keeps a question a restart lost: its subplanner hears it again, and what it finished stands', async () => {
    const ASK: Turn = async (tools) => { await tools.checkpoint!({ question: 'Which schema?' }, { signal: SIGNAL }); };
    const first = fakeRunner({ a: ['a.txt'] });
    const dead = nestedTree([SUBMIT([childTask('a', 1)]), ASK], first);
    await dead.parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(grandchildOf(dead.root, childIdOf(dead.parent, 'd')!)).toMatchObject({ status: 'awaiting_user', parkedQuestion: 'Which schema?' }), { timeout: 20_000 });
    const { root, image, child, grandchild } = await crashed(dead);

    const runner = fakeRunner({});
    const { parent, planner } = restarted(root, image, reports(8), runner);
    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(planner.asked.join('\n')).toContain('Which schema?'), { timeout: 20_000 });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(workers(runner)).toEqual([]);
    expect(grandchildOf(root, child).runnerSessionId).toBe(grandchild);
    parent.destroy();
  });

  it('starts a grandchild over only when asked: a fresh retry takes the subtree, and what it spent stays spent', async () => {
    const { root, image, child, grandchild } = await midGrandchild(300_000);
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] });
    const { parent, planner } = restarted(root, image, [SUBMIT(NESTED), SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])]), ...reports(8)], runner);
    const ledger = await parent.ledger();
    const carves = vi.spyOn(ledger, 'carve');
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'fresh' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(workers(runner)).toEqual(['a', 'b']);
    // A new child is a new session: nothing of the old one rides along (ADR-0008).
    for (const request of planner.requests) expect(request.resume).toBeUndefined();
    expect(taskOf(parent, 'd').runnerSessionId).not.toBe(child);
    expect(grandchildOf(root, taskOf(parent, 'd').runnerSessionId!).runnerSessionId).not.toBe(grandchild);
    expect(carves.mock.calls.map(([, , request]) => request.tokens)).toEqual([2_000_000 - 300_000, 800_000]);
    expect(ledger.spentOn('root', 'd')).toBe(300_000);
    parent.destroy();
  });

  it('holds the tree\'s one Parallel limit as it goes on: no reopened level brings slots of its own', async () => {
    const { root, image } = await midGrandchild(0, [childTask('a', 1), childTask('b', 2, ['a']), childTask('e', 3, ['a'])]);
    const runner = fakeRunner({ b: ['b.txt'], e: ['e.txt'] }, { heldOnce: ['b', 'e'] });
    const { parent } = restarted(root, image, reports(8), runner, { parallel: 1 });
    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(workers(runner).length).toBeGreaterThan(0), { timeout: 20_000 });
    await wait(150);
    expect(workers(runner)).toHaveLength(1);
    runner.release(workers(runner)[0]);
    await vi.waitFor(() => expect(workers(runner)).toHaveLength(2), { timeout: 20_000 });
    runner.release(workers(runner)[1]);
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });

  it('rebuilds a subplanner whose harness keeps no session from its transcript, its plan, the board and its references', async () => {
    const pin = (parent: Session) => parent.postOnBoard({ type: 'pin', title: 'Keep the v1 routes' });
    const { root, image } = await midGrandchild(0, undefined, { sessionless: true, before: pin });
    const read: string[] = [];
    const READING: Turn = async (tools, text) => {
      for (const task of ['board', 'a']) read.push((await tools.readTask!({ task }, { signal: SIGNAL })).text);
      await REPORT(tools, text);
    };
    const { parent, planner } = restarted(root, image, Array.from({ length: 8 }, () => READING), fakeRunner({ b: ['b.txt'] }), { sessionless: true });

    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    expect(planner.requests).toHaveLength(2);
    for (const request of planner.requests) {
      expect(request.resume).toBeUndefined();
      expect(request.priorHistory?.length).toBeGreaterThan(0);
      expect(request.initialMessage).toContain('pick it up');
      expect(request.initialMessage).toContain('Keep the v1 routes');
    }
    expect(planner.requests.map((request) => request.initialMessage).join('\n')).toContain('Write a');
    expect(read.join('\n')).toContain('Keep the v1 routes');
    expect(read.join('\n')).toContain('Done.');
    parent.destroy();
  });

  it('tells a grandchild\'s subplanner a pin once, though its message passes through every level', async () => {
    const { root, image } = await midGrandchild(0, undefined, { before: (parent) => parent.postOnBoard({ type: 'pin', title: 'Keep the v1 routes' }) });
    const { parent, planner } = restarted(root, image, reports(8), fakeRunner({ b: ['b.txt'] }));

    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    for (const request of planner.requests) expect(request.initialMessage?.split('Keep the v1 routes')).toHaveLength(2);
    parent.destroy();
  });

  it('leaves a grandchild it cannot reopen as it stands, and tells its subplanner why', async () => {
    const { root, image, child, grandchild } = await midGrandchild();
    const runner = fakeRunner({ b: ['b.txt'] });
    const { parent, planner } = restarted(root, image, [BLOCKED, ...reports(8)], runner);
    const saved = loadChildSession({ baseDir: root, rootSessionId: 'session-root', sessionId: child })!;
    Object.assign(saved.plan.tasks.find((t) => t.id === 'n')!, { assignedRunner: 'codex', runnerSessionOwner: 'claude-code' });
    saved.plan.runners = ['claude-code', 'codex'];
    saveChildSession(saved.plan, saved.meta.goal, { baseDir: root, rootSessionId: 'session-root', sessionId: child });

    expect(await goOn(parent)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(planner.asked.join('\n')).toContain('its saved session belongs to claude-code'), { timeout: 20_000 });
    await vi.waitFor(() => expect(parent.isExecuting).toBe(false), { timeout: 20_000 });
    expect(workers(runner)).toEqual([]);
    expect(grandchildOf(root, child).runnerSessionId).toBe(grandchild);
    parent.destroy();
  });
});

describe('a revocation (ADR-0056 M10)', () => {
  it('lets what is in flight finish, starts nothing, no turn included, and ends the child blocked', async () => {
    let tokens = 5_000_000;
    const runner = fakeRunner({ a: ['a.txt'] }, { held: ['a'] });
    const { parent, planner } = tree([SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])])], { runner, tokens: () => tokens });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'));
    tokens = 0;
    parent.applyRunSettings({ delegationTokens: 0 });
    const asked = planner.asked.length;
    // What would open a turn is refused, and the check that follows cuts nothing short.
    await parent.execute({ command: 'message_task', task: 'd', text: 'one more thing' }, { kind: 'user' });
    await wait(50);
    expect(planner.asked).toHaveLength(asked);
    expect(runner.stopped).toEqual([]);
    runner.release('a');
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(taskOf(parent, 'd').verdict).toMatchObject({ reported: 'blocked', reason: expect.stringContaining('withdrawn') });
    expect(runner.spawned).not.toContain('b');
    expect(planner.asked).toHaveLength(asked);
    expect(taskOf(parent, 'd').handoff?.summary).toContain('"Write a"');
    parent.destroy();
  });
});

describe('a parent going (ADR-0055 D13)', () => {
  it('keeps the tree\'s lease until its child has stopped', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { held: ['a'], heldStops: ['a'] });
    const { root, parent } = tree([SUBMIT([childTask('a', 1)])], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'));
    const held = () => existsSync(join(root, '.ordewell', 'sessions', 'session-root', 'lease.json'));
    expect(held()).toBe(true);
    parent.destroy();
    await wait(50);
    expect(held()).toBe(true);
    runner.letStop('a');
    await parent.gone;
    expect(held()).toBe(false);
    // The log is closed behind the child's own close, so a restart reads its budget back.
    await vi.waitFor(() => expect(readFileSync(join(root, '.ordewell', 'sessions', 'session-root', 'tree-events.jsonl'), 'utf8')).toContain('node_closed'));
  });
});

describe('a subplanner that fails its restart (ADR-0056 M8)', () => {
  it('ends the child failed, its tasks stopped first', async () => {
    const inner = fakeRunner({});
    const failing: IRunner = {
      ...inner,
      spawn: vi.fn(async (opts) => {
        const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
        setTimeout(() => session.reportComplete({ status: 'failed', summary: 'It failed.', reason: 'It failed.' }), 5);
        return session;
      }),
    };
    const BOOM: Turn = async () => { throw new Error('the planner is gone'); };
    const { parent } = tree([SUBMIT([childTask('a', 1)]), BOOM, BOOM], { runner: failing });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(taskOf(parent, 'd').verdict).toMatchObject({ reported: 'failed', reason: expect.stringContaining('could not restart') });
    parent.destroy();
  });

  it('is picked up by a Continue, Act again', async () => {
    const inner = fakeRunner({ a: ['a.txt'] });
    let spawns = 0;
    const failingOnce: IRunner = {
      ...inner,
      spawn: vi.fn(async (opts) => {
        spawns += 1;
        if (spawns > 1) return inner.spawn(opts);
        const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
        setTimeout(() => session.reportComplete({ status: 'failed', summary: 'It failed.', reason: 'It failed.' }), 5);
        return session;
      }),
    };
    const BOOM: Turn = async () => { throw new Error('the planner is gone'); };
    const { parent } = tree([SUBMIT([childTask('a', 1)]), BOOM, BOOM, NOTHING, DONE], { runner: failingOnce });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('failed'), { timeout: 20_000 });
    expect(await parent.execute({ command: 'retry_task', task: 'd', from: 'session', message: 'try again' }, { kind: 'user' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    parent.destroy();
  });
});

const rowOf = (session: Session, id: string) => session.runSnapshot().tasks.find((task) => task.id === id)?.delegation;

describe('a delegated task\'s row (ADR-0055 D16, D20)', () => {
  it('says where its child\'s tasks stand and what is left of its budget, while the child runs', async () => {
    const runner = fakeRunner({ a: ['a.txt'], b: ['b.txt'] }, { held: ['a', 'b'], usage: 100_000 });
    const LIVE: Turn = async (tools) => {
      await SUBMIT([childTask('a', 1), childTask('b', 2, ['a'])])(tools, '');
      await tools.runPlan!({}, { signal: SIGNAL });
      await new Promise<void>(() => undefined);
    };
    const { parent } = tree([LIVE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'));
    await vi.waitFor(() => expect(rowOf(parent, 'd')?.tasks).toEqual({ completed: 0, running: 1, waiting: 0, pending: 1, failed: 0, skipped: 0 }));
    expect(rowOf(parent, 'd')?.tokens).toEqual({ budget: 2_000_000, left: 2_000_000 });
    expect(rowOf(parent, 'd')?.stopping).toBeUndefined();
    runner.release('a');
    await vi.waitFor(() => expect(rowOf(parent, 'd')?.tasks).toMatchObject({ completed: 1, running: 1 }));
    // What the first task spent is no longer left.
    expect(rowOf(parent, 'd')?.tokens?.left).toBe(1_900_000);
    await parent.stopSubtree();
    parent.destroy();
  });

  it('says no budget for a task that ran until the ledger is open: a restart has not read what it spent', async () => {
    const { parent } = tree([], { tasks: [{ ...delegated(), attempted: true }, check()] });
    expect(rowOf(parent, 'd')?.tokens).toBeUndefined();
    parent.destroy();
    const fresh = tree([]).parent;
    expect(rowOf(fresh, 'd')?.tokens).toEqual({ budget: 2_000_000, left: 2_000_000 });
    fresh.destroy();
  });

  it('counts a raise in what it says the task was given, or a raised child reads as over a budget it is well within', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { held: ['a'], usage: 100_000 });
    const LIVE: Turn = async (tools) => {
      await SUBMIT([childTask('a', 1)])(tools, '');
      await tools.runPlan!({}, { signal: SIGNAL });
      await new Promise<void>(() => undefined);
    };
    const { parent } = tree([LIVE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'));

    expect(await parent.raiseChild('d', 500_000)).toBeNull();

    expect(rowOf(parent, 'd')?.tokens).toEqual({ budget: 2_500_000, left: 2_500_000 });
    await parent.stopSubtree();
    parent.destroy();
  });

  it('is stopping from a Stop until the subtree has gone, and not after', async () => {
    const runner = fakeRunner({ a: ['a.txt'] }, { held: ['a'], heldStops: ['a'] });
    const LIVE: Turn = async (tools) => {
      await SUBMIT([childTask('a', 1)])(tools, '');
      await tools.runPlan!({}, { signal: SIGNAL });
      await new Promise<void>(() => undefined);
    };
    const { parent } = tree([LIVE], { runner });
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawned).toContain('a'));
    expect(rowOf(parent, 'd')?.stopping).toBeUndefined();

    parent.stopExecution();
    const gone = parent.stopSubtree();
    await wait(50);
    // The task already reads as not started, though its child is still winding down.
    expect(statusOf(parent, 'd')).toBe('pending');
    expect(rowOf(parent, 'd')?.stopping).toBe(true);

    runner.letStop('a');
    await gone;
    await vi.waitFor(() => expect(rowOf(parent, 'd')?.stopping).toBeUndefined());
    parent.destroy();
  });

  it('offers no child session to open, while the child runs and after it has ended (ADR-0055 D11)', async () => {
    const { parent, root } = tree([SUBMIT([childTask('a', 1)]), DONE]);
    await parent.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(statusOf(parent, 'd')).toBe('completed'), { timeout: 20_000 });
    const child = childIdOf(parent, 'd');
    expect(child).toBeDefined();
    // The child's file exists, under its root, and is nobody's session to open.
    expect(loadChildSession({ baseDir: root, rootSessionId: 'session-root', sessionId: child! })).not.toBeNull();
    expect(listSessions(root).map((meta) => meta.id)).not.toContain(child);
    expect(listChildSessions('session-root', root)).toContain(child);
    parent.destroy();
  });

  it('says nothing of delegation on a flat plan\'s tasks', async () => {
    const { parent } = tree([], { tasks: [createTask({ id: 'f', order: 1, title: 'Flat', prompt: 'x' })] });
    expect(rowOf(parent, 'f')).toBeUndefined();
    parent.destroy();
  });
});
