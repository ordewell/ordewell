import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import http from 'http';
import type { AddressInfo } from 'net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Hono } from 'hono';
import WebSocket from 'ws';
import {
  createSession, createTask, createWorktreeIsolation, DAEMON_SUBPROTOCOL, LeaseHost, ModelResolver, openTaskLog, RUN_SETTINGS_DEFAULTS, RunnerRegistry, saveSession,
  type ChildListResponse, type ChildMessageResponse, type ChildPlanResponse, type ChildTaskControlResponse, type ChildTreeFrame, type ErrorBody, type IRunner, type LegacyPlanState, type RunSnapshotFrame, type Session, type SessionDeps, type SessionFrame, type Task, type TaskLogAttemptsResponse,
} from '@ordewell/core';
import { fakeConfig, fakeFileSystem, FakeRunnerSession } from '@ordewell/core/testing';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { childrenRoute } from '../../routes/children';
import { createWsHandler } from '../stream';

/*
 * A delegated tree through the daemon's own doors (ADR-0055 D20): a real pool
 * and real sockets over a real Session on a real repository, with the planners
 * scripted and the task runner faked. What a surface may do to a child plan is
 * exactly what these requests can do.
 */

const WAIT = { timeout: 20_000 };
const ROOT = 'session-root';

type Tools = {
  submitPlan?(args: unknown, extra: { signal: AbortSignal }): Promise<{ isError?: boolean; text: string }>;
  taskComplete?(args: unknown, extra: { signal: AbortSignal }): Promise<{ isError?: boolean; text: string }>;
  checkpoint?(args: unknown, extra: { signal: AbortSignal }): Promise<{ isError?: boolean; text: string }>;
};
type Turn = (tools: Tools) => Promise<void>;

function planner(turns: Turn[]) {
  const asked: string[] = [];
  let tools: Tools | undefined;
  const next = async (text: string) => {
    asked.push(text);
    const turn = turns.shift();
    if (turn && tools) await turn(tools);
    return { kind: 'message', text: 'Done with this turn.', researchLog: [] };
  };
  const service = {
    reset() {},
    hasActiveConversation: () => tools !== undefined,
    plannerToolsAttached: () => true,
    restart() {},
    startConversation: async (req: { goal: string; initialMessage?: string; plannerTools?: { handler: Tools } }) => {
      tools = req.plannerTools?.handler;
      return next(req.initialMessage ?? req.goal);
    },
    continueConversation: (text: string) => next(text),
  };
  return { asked, service: service as unknown as NonNullable<SessionDeps['aiService']> };
}

const signal = () => ({ signal: new AbortController().signal });
const SUBMIT = (tasks: unknown[]): Turn => async (tools) => {
  const reply = await tools.submitPlan!({ tasks }, signal());
  if (reply.isError) throw new Error(reply.text);
};
const DONE: Turn = async (tools) => {
  const reply = await tools.taskComplete!({ status: 'done', summary: 'All written.', commit: { subject: 'Write it' } }, signal());
  if (reply.isError) throw new Error(reply.text);
};
const REPLY: Turn = async () => undefined;

const aiTask = (id: string, order: number, dependencies: string[] = []) => ({
  id, order, title: `Write ${id}`, description: id, type: 'ai', prompt: `write ${id}`, sliceType: 'AFK', autonomy: 'AFK', dependencies,
});
const nested = (id: string, order: number) => ({
  id, order, title: `Nested ${id}`, description: id, type: 'delegated', goal: `Reach ${id}`, budget: { tokens: 800_000 }, protectedPaths: ['tests/'], sliceType: 'AFK', dependencies: [],
});
const delegated = (over: Partial<Task> = {}) => createTask({
  id: 'd', order: 1, title: 'Delegated subtree', type: 'delegated', goal: 'Write a', budget: { tokens: 2_000_000 }, protectedPaths: ['tests/'], grants: ['delegate'], ...over,
});

const env = () => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k];
  return e;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-child-socket-')));
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

function heldTasks(held: string[]) {
  const spawned: string[] = [];
  const sessions = new Map<string, FakeRunnerSession>();
  const waiting = new Map<string, () => void>();
  const runner: IRunner = {
    spawn: vi.fn(async (opts) => {
      spawned.push(opts.taskId);
      const session = new FakeRunnerSession(`s-${opts.taskId}-${spawned.length}`, opts.taskId);
      sessions.set(opts.taskId, session);
      const finish = () => {
        writeFileSync(join(opts.cwd, `${opts.taskId}.txt`), `written by ${opts.taskId}\n`);
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
  return { runner, spawned, sessions, release: (taskId: string) => waiting.get(taskId)?.() };
}

interface Socket {
  frames: unknown[];
  closed: Promise<number>;
  close(): void;
  saw(type: string): Promise<void>;
}

function open(port: number, path: string): Socket {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, [DAEMON_SUBPROTOCOL]);
  const frames: unknown[] = [];
  socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
  return {
    frames,
    closed: new Promise((resolve) => { socket.on('close', (code) => resolve(code)); }),
    close: () => socket.close(),
    saw: (type) => vi.waitFor(() => expect(frames.map((frame) => (frame as { type: string }).type)).toContain(type), WAIT),
  };
}

const ofType = <T>(frames: unknown[], type: string): T[] => frames.filter((frame) => (frame as { type: string }).type === type) as T[];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

interface DaemonOptions { held?: string[]; parallel?: number; tasks?: Task[] }

/** The daemon around one delegating root, which `pool` holds under {@link ROOT}. */
async function daemon(turns: Record<string, Turn[]>, { held = ['a'], parallel = 3, tasks = [delegated()] }: DaemonOptions = {}) {
  const workspace = repo();
  const planners = Object.fromEntries(Object.entries(turns).map(([id, script]) => [id, planner(script)]));
  const { runner, spawned, sessions, release } = heldTasks(held);
  const pool = new OrchestratorPool({ accountLimitCollectors: () => [] });
  const internals = pool as unknown as {
    broadcast(id: string, message: unknown): void;
    registerSession(id: string, workspace: string, session: Session): void;
  };
  const config = fakeConfig({ maxParallelSessions: parallel, autonomousMode: true });
  const registry = new RunnerRegistry();
  const build = () => createSession({
    config, registry, runner,
    notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
    workspaceRoot: () => workspace,
    fsAdapter: fakeFileSystem(),
    broadcast: (message) => internals.broadcast(ROOT, message),
    onNotice: (notice) => internals.broadcast(ROOT, notice),
    modelResolver: new ModelResolver(registry, config, { execImpl: async () => ({ stdout: '' }) }),
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: 5_000_000, mergeAtGatesAutomatically: false } }),
    sessionId: ROOT,
    saveSession, openTaskLog,
    isolation: createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) }),
    leaseHost: new LeaseHost(),
    delegationOffered: true,
    childDeps: (task) => ({ aiService: planners[task.id].service, fsAdapter: { ...fakeFileSystem(), getWorkspaceRoot: () => workspace } }),
  });
  const plan = { tasks, runners: ['claude-code'], status: 'approved', generatedAt: '2026-11-01T10:00:00.000Z' } as unknown as LegacyPlanState;
  const session = build();
  session.loadPlan(plan, 'the root goal', workspace, { sessionId: ROOT });
  internals.registerSession(ROOT, workspace, session);

  const app = new Hono().route('/api/sessions', childrenRoute(pool));
  const server = http.createServer();
  server.on('upgrade', createWsHandler(pool));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const sockets: Socket[] = [];
  const connect = (path: string) => {
    const socket = open(port, path);
    sockets.push(socket);
    return socket;
  };
  cleanups.push(async () => {
    for (const socket of sockets) socket.close();
    const live = pool.hasSession(ROOT) ? pool.session(ROOT) : session;
    pool.destroyAll();
    await live.gone;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const list = async () => (await (await app.request(`/api/sessions/${ROOT}/children`)).json()) as ChildListResponse;
  const running = async (count: number) => {
    await vi.waitFor(async () => expect((await list()).children).toHaveLength(count), WAIT);
    return (await list()).children;
  };
  const parked = (childId: string) => vi.waitFor(async () => {
    expect((await list()).children.find((child) => child.sessionId === childId)?.state).toBe('parked');
  }, WAIT);
  const post = (path: string, body: unknown) => app.request(`/api/sessions/${ROOT}/children/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const message = (childId: string, body: unknown) => post(`${childId}/message`, body);
  return { app, pool, session, planners, spawned, sessions, release, connect, list, running, parked, post, message, workspace };
}

describe('navigating a tree over the daemon', () => {
  it('lists a nested tree, and tells the root\'s socket as it grows', async () => {
    const { app, session, spawned, connect, running } = await daemon({
      d: [SUBMIT([nested('n', 1), { ...aiTask('c', 2, ['n']), title: 'Check n', readOnly: true }]), DONE],
      n: [SUBMIT([aiTask('a', 1)]), DONE],
    });
    const root = connect(`/ws/session/${ROOT}`);
    await root.saw('account_limits');
    expect(ofType(root.frames, 'child_tree')).toEqual([]);

    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toContain('a'), WAIT);
    const children = await running(2);

    expect(children.map((child) => [child.taskId, child.depth, child.parent === ROOT])).toEqual([['d', 1, true], ['n', 2, false]]);
    const nestedChild = children[1];
    expect(nestedChild.parent).toBe(children[0].sessionId);
    await vi.waitFor(() => expect(ofType<ChildTreeFrame>(root.frames, 'child_tree').at(-1)?.children.map((child) => child.taskId)).toEqual(['d', 'n']), WAIT);

    const view = await (await app.request(`/api/sessions/${ROOT}/children/${nestedChild.sessionId}`)).json() as ChildPlanResponse;
    expect(view.child.sessionId).toBe(nestedChild.sessionId);
    expect(view.plan?.tasks.map((task) => task.id)).toEqual(['a']);
    expect(view.position.stream).toEqual(expect.any(String));
  });

  it('greets a later root socket with the tree as it stands', async () => {
    const { session, spawned, connect, running } = await daemon({ d: [SUBMIT([aiTask('a', 1)]), DONE] });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toContain('a'), WAIT);
    const [child] = await running(1);

    const root = connect(`/ws/session/${ROOT}`);
    await root.saw('child_tree');

    expect(ofType<ChildTreeFrame>(root.frames, 'child_tree')[0]).toMatchObject({ sessionId: ROOT, children: [{ sessionId: child.sessionId }] });
    expect(root.frames.findIndex((f) => (f as { type: string }).type === 'child_tree')).toBeGreaterThan(root.frames.findIndex((f) => (f as { type: string }).type === 'account_limits'));
  });
});

describe('a child\'s socket', () => {
  it('opens on a snapshot, then numbers the child\'s own frames, which the root\'s socket never gets', async () => {
    const { session, spawned, connect, running, release, parked, message } = await daemon({ d: [SUBMIT([aiTask('a', 1)]), REPLY, DONE] });
    const root = connect(`/ws/session/${ROOT}`);
    await root.saw('account_limits');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toContain('a'), WAIT);
    const [child] = await running(1);
    await parked(child.sessionId);

    const socket = connect(`/ws/session/${ROOT}/child/${child.sessionId}`);
    await socket.saw('run_snapshot');
    expect(socket.frames[0]).toEqual({ type: 'connected', sessionId: child.sessionId });
    const snapshot = socket.frames[1] as RunSnapshotFrame;
    expect(snapshot).toMatchObject({ type: 'run_snapshot', sessionId: child.sessionId, approvals: [] });
    expect(snapshot.view.tasks.map((task) => task.id)).toEqual(['a']);

    const answer = await message(child.sessionId, { message: 'use the blue one' });
    await socket.saw('planner_turn_started');

    expect(await answer.json()).toEqual({ status: 'woken' });
    const stamped = socket.frames.slice(2) as SessionFrame[];
    expect(stamped.every((frame) => frame.stream === snapshot.stream)).toBe(true);
    expect(stamped.map((frame) => frame.seq)).toEqual(stamped.map((_, index) => snapshot.seq! + index + 1));
    expect(JSON.stringify(root.frames)).not.toContain('use the blue one');
    release('a');
  });

  it('hands two sockets the same numbered frames', async () => {
    const { session, spawned, connect, running, parked, message, release } = await daemon({ d: [SUBMIT([aiTask('a', 1)]), REPLY, DONE] });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toContain('a'), WAIT);
    const [child] = await running(1);
    await parked(child.sessionId);
    const first = connect(`/ws/session/${ROOT}/child/${child.sessionId}`);
    const second = connect(`/ws/session/${ROOT}/child/${child.sessionId}`);
    await Promise.all([first.saw('run_snapshot'), second.saw('run_snapshot')]);

    await message(child.sessionId, { message: 'both of you' });
    await Promise.all([first.saw('planner_turn_ended'), second.saw('planner_turn_ended')]);

    const seqs = (socket: Socket) => ofType<SessionFrame>(socket.frames, 'planner_turn_ended').map((frame) => frame.seq);
    expect(seqs(first)).toEqual(seqs(second));
    release('a');
  });

  it('picks up after a reconnection with what it missed in the transcript, numbers still rising', async () => {
    const { app, session, spawned, connect, running, parked, message, release, planners } = await daemon({ d: [SUBMIT([aiTask('a', 1)]), REPLY, REPLY, REPLY, DONE] });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toContain('a'), WAIT);
    const [child] = await running(1);
    await parked(child.sessionId);
    const path = `/ws/session/${ROOT}/child/${child.sessionId}`;

    const before = connect(path);
    await before.saw('run_snapshot');
    await message(child.sessionId, { message: 'first' });
    await before.saw('planner_turn_ended');
    await parked(child.sessionId);
    const seen = Math.max(...before.frames.map((frame) => (frame as { seq?: number }).seq ?? 0));
    before.close();
    await before.closed;

    await message(child.sessionId, { message: 'said while nobody watched' });
    await vi.waitFor(() => expect(planners.d.asked.join('\n')).toContain('said while nobody watched'), WAIT);
    await parked(child.sessionId);

    const after = connect(path);
    await after.saw('run_snapshot');
    const snapshot = after.frames[1] as RunSnapshotFrame;
    expect(snapshot.stream).toBe((before.frames[1] as RunSnapshotFrame).stream);
    expect(snapshot.seq).toBeGreaterThanOrEqual(seen);
    const view = await (await app.request(`/api/sessions/${ROOT}/children/${child.sessionId}`)).json() as ChildPlanResponse;
    expect(view.plan?.conversationHistory?.map((entry) => entry.content)).toContain('said while nobody watched');
    expect(view.position.seq).toBeGreaterThanOrEqual(snapshot.seq!);

    await message(child.sessionId, { message: 'second' });
    await after.saw('planner_turn_started');

    expect(ofType<SessionFrame>(after.frames, 'planner_turn_started')[0].seq).toBeGreaterThan(seen);
    release('a');
  });

  it('closes when its root is replaced, so a surface reconnects', async () => {
    const { pool, session, spawned, connect, running } = await daemon({ d: [SUBMIT([aiTask('a', 1)]), DONE] });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toContain('a'), WAIT);
    const [child] = await running(1);
    const path = `/ws/session/${ROOT}/child/${child.sessionId}`;
    const socket = connect(path);
    await socket.saw('run_snapshot');

    pool.destroy(ROOT);

    expect(await socket.closed).toBe(1012);
    expect(await connect(path).closed).toBe(4404);
  });

  it('closes for good when its root is closed', async () => {
    const { pool, session, spawned, connect, running } = await daemon({ d: [SUBMIT([aiTask('a', 1)]), DONE] });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toContain('a'), WAIT);
    const [child] = await running(1);
    const socket = connect(`/ws/session/${ROOT}/child/${child.sessionId}`);
    await socket.saw('run_snapshot');

    await pool.close(ROOT);

    expect(await socket.closed).toBe(1001);
  });
});

describe('a person\'s message over the daemon', () => {
  it('wakes a parked subplanner, queues under a full tree, and reads no more than the words', async () => {
    const { session, spawned, running, parked, message, planners, release } = await daemon({ d: [SUBMIT([aiTask('a', 1)]), REPLY, DONE] }, { parallel: 1 });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toContain('a'), WAIT);
    const [child] = await running(1);
    await parked(child.sessionId);
    const limit = session.planTasks[0].budget?.tokens;

    const answer = await message(child.sessionId, { message: 'use the blue one', raiseTokens: 9_000_000, grants: ['effect'], approve: true });

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ status: 'queued' });
    expect(session.planTasks[0].budget?.tokens).toBe(limit);
    release('a');
    await vi.waitFor(() => expect(planners.d.asked.join('\n')).toContain('use the blue one'), WAIT);
    await vi.waitFor(() => expect(session.planTasks[0].status).toBe('completed'), WAIT);
  });

  it('takes two messages sent at once to one child, the first opening a turn and the second behind it', async () => {
    let letGo = () => {};
    const held = new Promise<void>((resolve) => { letGo = resolve; });
    const { session, spawned, running, parked, message, planners, release } = await daemon({ d: [SUBMIT([aiTask('a', 1)]), () => held, REPLY, DONE] });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toContain('a'), WAIT);
    const [child] = await running(1);
    await parked(child.sessionId);

    const answers = await Promise.all([message(child.sessionId, { message: 'one' }), message(child.sessionId, { message: 'two' })]);

    const statuses = await Promise.all(answers.map(async (answer) => (await answer.json() as ChildMessageResponse).status));
    expect(statuses.sort()).toEqual(['queued', 'woken']);
    letGo();
    await vi.waitFor(() => expect(planners.d.asked.at(-1)).toContain('two'), WAIT);
    release('a');
  });

  it('tells the child\'s socket when the turn a message opened fails, and nobody else', async () => {
    const { session, spawned, connect, running, parked, message, release } = await daemon({ d: [SUBMIT([aiTask('a', 1)]), async () => { throw new Error('the model went away'); }, DONE] });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toContain('a'), WAIT);
    const [child] = await running(1);
    await parked(child.sessionId);
    const rootSocket = connect(`/ws/session/${ROOT}`);
    await rootSocket.saw('run_snapshot');
    const childSocket = connect(`/ws/session/${ROOT}/child/${child.sessionId}`);
    await childSocket.saw('run_snapshot');

    expect(await (await message(child.sessionId, { message: 'are you there' })).json()).toEqual({ status: 'woken' });

    await childSocket.saw('notice');
    expect(ofType<{ message: string }>(childSocket.frames, 'notice')[0].message).toContain('the model went away');
    await parked(child.sessionId);
    expect(ofType<{ message: string }>(rootSocket.frames, 'notice').map((notice) => notice.message).join('\n')).not.toContain('the model went away');
    release('a');
  });

  it('answers a message with no words as the request\'s fault', async () => {
    const { session, spawned, running, parked, message, release } = await daemon({ d: [SUBMIT([aiTask('a', 1)]), DONE] });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toContain('a'), WAIT);
    const [child] = await running(1);
    await parked(child.sessionId);

    expect((await message(child.sessionId, { message: '   ' })).status).toBe(400);
    expect((await message(child.sessionId, { message: 7 })).status).toBe(400);
    release('a');
  });

  it('leaves a finished child view-only, still readable, its log included', async () => {
    const { app, session, running, message } = await daemon({ d: [SUBMIT([aiTask('a', 1)]), DONE] }, { held: [] });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(session.planTasks[0].status).toBe('completed'), WAIT);
    const [child] = await running(1);
    await vi.waitFor(async () => expect((await (await app.request(`/api/sessions/${ROOT}/children`)).json() as ChildListResponse).children[0].state).toBe('ended'), WAIT);

    const refused = await message(child.sessionId, { message: 'hello?' });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'child_view_only' } satisfies Partial<ErrorBody>);
    const view = await (await app.request(`/api/sessions/${ROOT}/children/${child.sessionId}`)).json() as ChildPlanResponse;
    expect(view.child.state).toBe('ended');
    expect(view.plan?.tasks.map((task) => [task.id, task.status])).toEqual([['a', 'completed']]);
    const log = await (await app.request(`/api/sessions/${ROOT}/children/${child.sessionId}/tasks/a/log`)).json() as TaskLogAttemptsResponse;
    expect(log.attempts).toEqual([1]);
    expect(log.position?.stream).toEqual(expect.any(String));
  });
});

describe('a person\'s task controls over the daemon', () => {
  const QUESTION = 'May I drop the table?';

  const started = async (turns: Record<string, Turn[]>, options?: DaemonOptions) => {
    const made = await daemon(turns, options);
    await made.session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(made.spawned).toContain((options?.held ?? ['a'])[0]), WAIT);
    return made;
  };
  type Made = Awaited<ReturnType<typeof started>>;
  const childAt = async ({ running }: Made, depth: number, count = depth) => (await running(count)).find((child) => child.depth === depth)!;
  const view = async ({ app }: Made, childId: string) => await (await app.request(`/api/sessions/${ROOT}/children/${childId}`)).json() as ChildPlanResponse;
  /** The way a surface comes to answer: the list says who waits, the child's view says what it asked. */
  const waiting = async (made: Made, childId: string, taskId = 'a') => {
    await vi.waitFor(async () => expect((await made.list()).children.find((child) => child.sessionId === childId)?.checkpoints).toEqual([taskId]), WAIT);
    return (await view(made, childId)).run.tasks.find((task) => task.id === taskId)!.checkpoint!;
  };
  const refused = async (answer: Response, status: number, code: ErrorBody['code']) => {
    expect(answer.status).toBe(status);
    expect(await answer.json()).toMatchObject({ code, error: expect.any(String) });
  };

  it('answers a child runner\'s checkpoint by the words a person read, and the runner goes on', async () => {
    const made = await started({ d: [SUBMIT([aiTask('a', 1)]), REPLY, DONE] });
    const child = await childAt(made, 1);
    await made.parked(child.sessionId);
    const rootSocket = made.connect(`/ws/session/${ROOT}`);
    await rootSocket.saw('run_snapshot');
    const childSocket = made.connect(`/ws/session/${ROOT}/child/${child.sessionId}`);
    await childSocket.saw('run_snapshot');
    const answer = made.sessions.get('a')!.callCheckpoint(QUESTION);

    const question = await waiting(made, child.sessionId);
    const told = () => ofType<ChildTreeFrame>(rootSocket.frames, 'child_tree').at(-1)?.children[0].checkpoints;
    await vi.waitFor(() => expect(told()).toEqual(['a']), WAIT);
    const done = await made.post(`${child.sessionId}/tasks/a/checkpoint/approve`, { question });

    expect(question).toBe(QUESTION);
    expect(done.status).toBe(200);
    expect(await done.json() as ChildTaskControlResponse).toEqual({ message: expect.any(String) });
    await expect(answer).resolves.toMatchObject({ kind: 'continue' });
    expect((await view(made, child.sessionId)).run.tasks[0].status).toBe('in_progress');
    await vi.waitFor(() => expect(told()).toBeUndefined(), WAIT);

    await childSocket.saw('execution_action');
    const answered = (socket: Socket) => ofType<{ record: { command: string; actor: string; person?: true } }>(socket.frames, 'execution_action').map((frame) => frame.record).filter((record) => record.command === 'answer_checkpoint');
    expect(answered(childSocket)).toEqual([expect.objectContaining({ actor: 'subplanner', person: true })]);
    expect(answered(rootSocket)).toEqual([]);
    made.release('a');
    await vi.waitFor(() => expect(made.session.planTasks[0].status).toBe('completed'), WAIT);
  });

  it('reads a long question whole, so what a person read is what it answers', async () => {
    const made = await started({ d: [SUBMIT([aiTask('a', 1)]), REPLY, DONE] });
    const child = await childAt(made, 1);
    await made.parked(child.sessionId);
    const long = `First line, ${'with more to weigh '.repeat(20)}\nand a second line.`;
    const answer = made.sessions.get('a')!.callCheckpoint(long);

    const question = await waiting(made, child.sessionId);
    expect(question).toBe(long);
    expect((await made.post(`${child.sessionId}/tasks/a/checkpoint/approve`, { question })).status).toBe(200);
    await expect(answer).resolves.toMatchObject({ kind: 'continue' });
    made.release('a');
  });

  it('tells a runner why, and asks a rejection for its reason, leaving it waiting', async () => {
    const made = await started({ d: [SUBMIT([aiTask('a', 1)]), REPLY, DONE] });
    const child = await childAt(made, 1);
    await made.parked(child.sessionId);
    const answer = made.sessions.get('a')!.callCheckpoint(QUESTION);
    const question = await waiting(made, child.sessionId);

    await refused(await made.post(`${child.sessionId}/tasks/a/checkpoint/reject`, { question }), 400, 'refused');
    await refused(await made.post(`${child.sessionId}/tasks/a/checkpoint/reject`, { question, reason: '   ' }), 400, 'refused');
    expect(await waiting(made, child.sessionId)).toBe(QUESTION);

    const done = await made.post(`${child.sessionId}/tasks/a/checkpoint/reject`, { question, reason: 'Keep the table.' });

    expect(done.status).toBe(200);
    await expect(answer).resolves.toEqual({ kind: 'rejected', reason: 'Keep the table.' });
    made.release('a');
  });

  it('refuses an answer to a question that is no longer the one waiting', async () => {
    const made = await started({ d: [SUBMIT([aiTask('a', 1)]), REPLY, DONE] });
    const child = await childAt(made, 1);
    await made.parked(child.sessionId);

    await refused(await made.post(`${child.sessionId}/tasks/a/checkpoint/approve`, { question: 'Anything?' }), 409, 'checkpoint_not_waiting');

    const first = made.sessions.get('a')!.callCheckpoint('First?');
    await waiting(made, child.sessionId);
    expect((await made.post(`${child.sessionId}/tasks/a/checkpoint/approve`, { question: 'First?' })).status).toBe(200);
    await first;
    await refused(await made.post(`${child.sessionId}/tasks/a/checkpoint/approve`, { question: 'First?' }), 409, 'checkpoint_not_waiting');

    const second = made.sessions.get('a')!.callCheckpoint('Second?');
    await waiting(made, child.sessionId);
    await refused(await made.post(`${child.sessionId}/tasks/a/checkpoint/approve`, { question: 'First?' }), 409, 'checkpoint_not_waiting');
    expect(await waiting(made, child.sessionId)).toBe('Second?');
    expect((await made.post(`${child.sessionId}/tasks/a/checkpoint/approve`, { question: 'Second?' })).status).toBe(200);
    await second;
    made.release('a');
  });

  it('messages the runner named, which a message at a checkpoint may not stand in for', async () => {
    const made = await started({ d: [SUBMIT([aiTask('a', 1), aiTask('b', 2)]), REPLY, DONE] }, { held: ['a', 'b'] });
    const child = await childAt(made, 1);
    await made.parked(child.sessionId);
    await vi.waitFor(() => expect(made.spawned).toContain('b'), WAIT);

    const sent = await made.post(`${child.sessionId}/tasks/b/message`, { message: 'Mind the migrations.' });

    expect(sent.status).toBe(200);
    expect(await sent.json() as ChildTaskControlResponse).toEqual({ message: expect.any(String), id: expect.any(String) });
    const reached = (taskId: string) => {
      const session = made.sessions.get(taskId)!;
      return [...session.delivered, ...session.messages.map((message) => message.text)];
    };
    expect(reached('b').join()).toContain('Mind the migrations.');
    expect(reached('a')).toEqual([]);

    const answer = made.sessions.get('a')!.callCheckpoint(QUESTION);
    const question = await waiting(made, child.sessionId);
    await refused(await made.post(`${child.sessionId}/tasks/a/message`, { message: 'yes' }), 409, 'child_refused');
    expect(reached('a')).toEqual([]);

    await made.post(`${child.sessionId}/tasks/a/checkpoint/approve`, { question });
    await answer;
    made.release('a');
    made.release('b');
  });

  it('refuses aloud what only the plan above can give, and a body that says nothing', async () => {
    const made = await started({ d: [SUBMIT([aiTask('a', 1)]), REPLY, DONE] });
    const child = await childAt(made, 1);
    await made.parked(child.sessionId);
    const limit = made.session.planTasks[0].budget?.tokens;
    const answer = made.sessions.get('a')!.callCheckpoint(QUESTION);
    const question = await waiting(made, child.sessionId);

    for (const body of [{ question, raiseTokens: 9_000_000 }, { question, force: true }, {}, { question: 7 }, { question: '  ' }]) {
      await refused(await made.post(`${child.sessionId}/tasks/a/checkpoint/approve`, body), 400, 'refused');
    }
    for (const body of [{ message: 'go', force: true }, { message: 'go', raiseTokens: 1 }, {}, { message: '   ' }, { message: 7 }]) {
      await refused(await made.post(`${child.sessionId}/tasks/a/message`, body), 400, 'refused');
    }
    await refused(await made.app.request(`/api/sessions/${ROOT}/children/${child.sessionId}/tasks/a/message`, { method: 'POST', body: 'not json' }), 400, 'refused');

    expect(made.session.planTasks[0].budget?.tokens).toBe(limit);
    expect(await waiting(made, child.sessionId)).toBe(QUESTION);
    expect((await made.post(`${child.sessionId}/tasks/a/checkpoint/approve`, { question })).status).toBe(200);
    await answer;
    made.release('a');
  });

  it('reaches a task at depth two through the plan that holds it, and no other', async () => {
    const made = await started({
      d: [SUBMIT([nested('n', 1), { ...aiTask('c', 2, ['n']), title: 'Check n', readOnly: true }]), DONE],
      n: [SUBMIT([aiTask('a', 1)]), REPLY, DONE],
    });
    const above = await childAt(made, 1, 2);
    const deep = await childAt(made, 2);
    await made.parked(deep.sessionId);
    const answer = made.sessions.get('a')!.callCheckpoint('Deep?');
    const question = await waiting(made, deep.sessionId);

    await refused(await made.post(`${above.sessionId}/tasks/a/checkpoint/approve`, { question }), 404, 'child_task_not_found');
    await refused(await made.post(`${above.sessionId}/tasks/a/message`, { message: 'hello' }), 404, 'child_task_not_found');

    expect((await made.post(`${deep.sessionId}/tasks/a/checkpoint/approve`, { question })).status).toBe(200);
    await expect(answer).resolves.toMatchObject({ kind: 'continue' });
    made.release('a');
  });

  it('answers a depth-two subplanner\'s question on the delegated task waiting for it in its parent', async () => {
    const asks: Turn = async (tools) => { await tools.checkpoint!({ question: 'Which file?' }, signal()); };
    const made = await started({
      d: [SUBMIT([nested('n', 1), { ...aiTask('c', 2, ['n']), title: 'Check n', readOnly: true }]), REPLY, DONE],
      n: [SUBMIT([aiTask('a', 1)]), asks, REPLY, DONE],
    });
    const above = await childAt(made, 1, 2);
    const deep = await childAt(made, 2);
    await made.parked(deep.sessionId);
    expect((await made.message(deep.sessionId, { message: 'ask above' })).status).toBe(200);
    const question = await waiting(made, above.sessionId, 'n');

    await refused(await made.post(`${deep.sessionId}/tasks/n/checkpoint/approve`, { question }), 404, 'child_task_not_found');
    expect((await made.post(`${above.sessionId}/tasks/n/checkpoint/reject`, { question, reason: 'Use a.txt.' })).status).toBe(200);

    await vi.waitFor(() => expect(made.planners.n.asked.join('\n')).toContain('Use a.txt.'), WAIT);
    made.release('a');
  });

  it('leaves a depth-one subplanner\'s question with the root, never answering it from the child', async () => {
    const asks: Turn = async (tools) => { await tools.checkpoint!({ question: 'Which way?' }, signal()); };
    const made = await started({ d: [SUBMIT([aiTask('a', 1)]), asks, REPLY, DONE] });
    const child = await childAt(made, 1);
    await made.parked(child.sessionId);
    await made.message(child.sessionId, { message: 'ask above' });
    await vi.waitFor(() => expect(made.session.escalations().find((e) => e.kind === 'checkpoint')).toBeDefined(), WAIT);

    await refused(await made.post(`${child.sessionId}/tasks/d/checkpoint/approve`, { question: 'Which way?' }), 404, 'child_task_not_found');
    await refused(await made.post(`${child.sessionId}/tasks/d/message`, { message: 'left' }), 404, 'child_task_not_found');

    expect(made.session.escalations().find((e) => e.kind === 'checkpoint')).toBeDefined();
    expect((await made.list()).children[0].checkpoints).toBeUndefined();
    await made.session.execute({ command: 'answer_checkpoint', task: 'd', answer: 'approve', reason: 'left' }, { kind: 'user' });
    await vi.waitFor(() => expect(made.planners.d.asked.join('\n')).toContain('The plan above answered your question: approved'), WAIT);
    made.release('a');
  });

  it('names nothing outside the tree or the plan: a stranger\'s id, the root\'s, a reference that only the root resolves', async () => {
    const made = await started({ d: [SUBMIT([aiTask('a', 1)]), REPLY, DONE] });
    const child = await childAt(made, 1);
    await made.parked(child.sessionId);
    const answer = made.sessions.get('a')!.callCheckpoint(QUESTION);
    const question = await waiting(made, child.sessionId);

    for (const id of ['session-other', ROOT, '..%2Fsession-other']) {
      await refused(await made.post(`${id}/tasks/a/message`, { message: 'hi' }), 404, 'child_not_found');
      await refused(await made.post(`${id}/tasks/a/checkpoint/approve`, { question }), 404, 'child_not_found');
    }
    for (const task of ['missing', '%231', 'Write%20a', '..%2Fa']) {
      await refused(await made.post(`${child.sessionId}/tasks/${task}/checkpoint/approve`, { question }), 404, 'child_task_not_found');
    }

    expect(await waiting(made, child.sessionId)).toBe(QUESTION);
    expect((await made.post(`${child.sessionId}/tasks/a/checkpoint/approve`, { question })).status).toBe(200);
    await answer;
    made.release('a');
  });

  it('refuses a task with no runner left, and leaves a finished plan to read', async () => {
    const made = await started({ d: [SUBMIT([aiTask('a', 1), aiTask('b', 2, ['a'])]), REPLY, DONE] }, { held: ['b'] });
    const child = await childAt(made, 1);
    await vi.waitFor(async () => expect((await view(made, child.sessionId)).run.tasks.find((task) => task.id === 'a')?.status).toBe('completed'), WAIT);

    await refused(await made.post(`${child.sessionId}/tasks/a/message`, { message: 'one more thing' }), 409, 'child_refused');
    await refused(await made.post(`${child.sessionId}/tasks/a/checkpoint/approve`, { question: 'Any?' }), 409, 'checkpoint_not_waiting');

    made.release('b');
    await vi.waitFor(async () => expect((await made.list()).children[0].state).toBe('ended'), WAIT);
    await refused(await made.post(`${child.sessionId}/tasks/b/message`, { message: 'too late' }), 409, 'child_view_only');
    await refused(await made.post(`${child.sessionId}/tasks/b/checkpoint/approve`, { question: 'Any?' }), 409, 'child_view_only');
    expect((await view(made, child.sessionId)).child.state).toBe('ended');
  });

  it('refuses once Stop halts the tree, and the runner hears its question withdrawn', async () => {
    const made = await started({ d: [SUBMIT([aiTask('a', 1)]), REPLY, DONE] });
    const child = await childAt(made, 1);
    await made.parked(child.sessionId);
    const answer = made.sessions.get('a')!.callCheckpoint(QUESTION);
    const question = await waiting(made, child.sessionId);

    await made.session.execute({ command: 'stop_run' }, { kind: 'user' });

    const late = await made.post(`${child.sessionId}/tasks/a/checkpoint/approve`, { question });
    expect(late.status).toBe(409);
    expect(['child_refused', 'child_view_only']).toContain((await late.json() as ErrorBody).code);
    await expect(answer).resolves.toMatchObject({ kind: 'withdrawn' });
  });
});

describe('the boundary of a tree', () => {
  it('names nothing outside it, by request or by socket, and reads nothing for it', async () => {
    const { app, session, spawned, connect, running, message, release } = await daemon({ d: [SUBMIT([aiTask('a', 1)]), DONE] });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toContain('a'), WAIT);
    await running(1);

    for (const id of ['session-other', ROOT, '..%2Fsession-other', 'root%2F1']) {
      const view = await app.request(`/api/sessions/${ROOT}/children/${id}`);
      expect(view.status).toBe(404);
      expect(await view.json()).toMatchObject({ code: 'child_not_found' });
      expect((await app.request(`/api/sessions/${ROOT}/children/${id}/tasks/a/log`)).status).toBe(404);
      expect((await message(id, { message: 'hi' })).status).toBe(404);
    }

    const stray = connect(`/ws/session/${ROOT}/child/session-other`);
    expect(await stray.closed).toBe(4404);
    expect(stray.frames).toEqual([]);
    release('a');
  });

  it('keeps one tree\'s child out of reach through a root that is not its own, or that is not loaded', async () => {
    const { app, pool, session, spawned, connect, running, workspace, release } = await daemon({ d: [SUBMIT([aiTask('a', 1)]), DONE] });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toContain('a'), WAIT);
    const [child] = await running(1);
    const flat = saveSession({ status: 'approved', runners: ['claude-code'], generatedAt: '2026-11-01T10:00:00.000Z', lastUpdated: '2026-11-01T10:00:00.000Z', tasks: [] }, 'a flat goal', workspace, 'session-flat');
    pool.adoptSavedSession(flat.id, workspace);

    expect((await app.request(`/api/sessions/${flat.id}/children`)).status).toBe(200);
    expect(await (await app.request(`/api/sessions/${flat.id}/children`)).json()).toEqual({ children: [] });
    expect((await app.request(`/api/sessions/${flat.id}/children/${child.sessionId}`)).status).toBe(404);
    expect(await (await app.request('/api/sessions/session-unloaded/children')).json()).toMatchObject({ code: 'session_not_found' });
    const control = (path: string, body: unknown) => app.request(path, { method: 'POST', body: JSON.stringify(body) });
    expect(await (await control(`/api/sessions/session-unloaded/children/${child.sessionId}/tasks/a/message`, { message: 'Hi.' })).json()).toMatchObject({ code: 'session_not_found' });
    expect(await (await control(`/api/sessions/session-unloaded/children/${child.sessionId}/tasks/a/checkpoint/approve`, { question: 'Why?' })).json()).toMatchObject({ code: 'session_not_found' });
    expect(await (await control(`/api/sessions/${flat.id}/children/${child.sessionId}/tasks/a/message`, { message: 'Hi.' })).json()).toMatchObject({ code: 'child_not_found' });
    const stray = connect(`/ws/session/${flat.id}/child/${child.sessionId}`);
    expect(await stray.closed).toBe(4404);
    release('a');
  });

  it('reads no log through a task id that climbs out of the child', async () => {
    const { app, session, spawned, running, release } = await daemon({ d: [SUBMIT([aiTask('a', 1)]), DONE] });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned).toContain('a'), WAIT);
    const [child] = await running(1);

    const climbed = await app.request(`/api/sessions/${ROOT}/children/${child.sessionId}/tasks/..%2F..%2F${ROOT}%2Ftasks%2Fd/log`);

    expect(await climbed.json()).toMatchObject({ attempts: [] });
    release('a');
  });
});

describe('two children and one slot', () => {
  it('keeps each message to its own child, and every turn under the limit', async () => {
    const { session, spawned, running, parked, message, planners, release } = await daemon({
      x: [SUBMIT([aiTask('p', 1)]), REPLY, DONE],
      y: [SUBMIT([aiTask('q', 1)]), REPLY, DONE],
    }, { held: ['p', 'q'], parallel: 2, tasks: [delegated({ id: 'x', order: 1, goal: 'Write x' }), delegated({ id: 'y', order: 2, goal: 'Write y' })] });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(spawned.sort()).toEqual(['p', 'q']), WAIT);
    const children = await running(2);
    await Promise.all(children.map((child) => parked(child.sessionId)));
    const idOf = (taskId: string) => children.find((child) => child.taskId === taskId)!.sessionId;

    const [toX, toY] = await Promise.all([
      message(idOf('x'), { message: 'to x' }),
      message(idOf('y'), { message: 'to y' }),
    ]);
    expect(await toX.json()).toEqual({ status: 'queued' });
    expect(await toY.json()).toEqual({ status: 'queued' });

    release('p');
    await vi.waitFor(() => expect(planners.x.asked.join('\n')).toContain('to x'), WAIT);
    expect(planners.y.asked.join('\n')).not.toContain('to x');
    release('q');
    await vi.waitFor(() => expect(planners.y.asked.join('\n')).toContain('to y'), WAIT);
    expect(planners.x.asked.join('\n')).not.toContain('to y');
    await vi.waitFor(() => expect(session.planTasks.map((task) => task.status)).toEqual(['completed', 'completed']), WAIT);
  });
});
