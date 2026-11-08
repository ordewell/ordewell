import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSession, createTask, createWorktreeIsolation, LeaseHost, ModelResolver, openTaskLog, RUN_SETTINGS_DEFAULTS, RunnerRegistry, saveSession,
  type IRunner, type LegacyPlanState, type Session, type SessionDeps,
} from '@ordewell/core';
import { fakeConfig, fakeFileSystem, FakeRunnerSession } from '@ordewell/core/testing';
import { stripAnsi } from '../ansi';
import type { Key } from '../keys';
import { composerView } from '../layout';
import { render } from '../render';
import { rootFrame } from '../state';
import { liveDaemon, type LiveDaemon, type Tui } from './liveDaemon';

/*
 * A person walking a delegated tree (ADR-0055 D20): real keys through the
 * reducer and its effects, a real client, the real daemon's routes and sockets
 * over a real Session on a real repository. Only the planners' turns and the
 * task runner are scripted. These pin what the reducer's tests take on trust:
 * what the daemon sends, in what order, and which route accepts what is sent.
 */

const WAIT = { timeout: 20_000 };
const ROOT = 'session-root';
const QUESTION = 'May I drop the table?';

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
const ASKS = (question: string): Turn => async (tools) => { await tools.checkpoint!({ question }, signal()); };

const aiTask = (id: string, order: number, dependencies: string[] = []) => ({
  id, order, title: `Write ${id}`, description: id, type: 'ai', prompt: `write ${id}`, sliceType: 'AFK', autonomy: 'AFK', dependencies,
});
const nested = (id: string, order: number) => ({
  id, order, title: `Nested ${id}`, description: id, type: 'delegated', goal: `Reach ${id}`, budget: { tokens: 800_000 }, protectedPaths: ['tests/'], sliceType: 'AFK', dependencies: [],
});
const check = (order: number, dependencies: string[]) => ({ ...aiTask('c', order, dependencies), title: 'Check it', readOnly: true });
const delegated = () => createTask({ id: 'd', order: 1, title: 'Delegated subtree', type: 'delegated', goal: 'Write a', budget: { tokens: 2_000_000 }, protectedPaths: ['tests/'], grants: ['delegate'] });

function repo(root: string): void {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[name];
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
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

let live: { daemon: LiveDaemon; session: Session; tui: Tui } | undefined;

afterEach(async () => {
  if (!live) return;
  const { daemon, session } = live;
  live = undefined;
  daemon.pool.destroyAll();
  await session.gone;
  await daemon.close();
});

/** A delegating root on the daemon, run to where `held`'s first task is with its runner, and a TUI on it. */
async function tree(turns: Record<string, Turn[]>, held: string[] = ['a']) {
  const daemon = await liveDaemon();
  const workspace = daemon.workspace;
  repo(workspace);
  const planners = Object.fromEntries(Object.entries(turns).map(([id, script]) => [id, planner(script)]));
  const runners = heldTasks(held);
  const internals = daemon.pool as unknown as {
    broadcast(id: string, workspace: string, message: unknown): void;
    registerSession(id: string, workspace: string, session: Session): void;
  };
  const config = fakeConfig({ maxParallelSessions: 3, autonomousMode: true });
  const registry = new RunnerRegistry();
  const session = createSession({
    config, registry, runner: runners.runner,
    notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
    workspaceRoot: () => workspace,
    fsAdapter: fakeFileSystem(),
    broadcast: (message) => internals.broadcast(ROOT, workspace, message),
    onNotice: (notice) => internals.broadcast(ROOT, workspace, notice),
    modelResolver: new ModelResolver(registry, config, { execImpl: async () => ({ stdout: '' }) }),
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', delegationTokens: 5_000_000, mergeAtGatesAutomatically: false } }),
    sessionId: ROOT,
    saveSession, openTaskLog,
    isolation: createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) }),
    leaseHost: new LeaseHost(),
    delegationOffered: true,
    childDeps: (task) => ({ aiService: planners[task.id].service, fsAdapter: { ...fakeFileSystem(), getWorkspaceRoot: () => workspace } }),
  });
  const plan = { tasks: [delegated()], runners: ['claude-code'], status: 'approved', generatedAt: '2026-11-01T10:00:00.000Z' } as unknown as LegacyPlanState;
  session.loadPlan(plan, 'the root goal', workspace, { sessionId: ROOT });
  internals.registerSession(ROOT, workspace, session);

  const tui = daemon.tui({ wholeLoop: true });
  live = { daemon, session, tui };
  await tui.run({ type: 'loadSession', sessionId: ROOT });
  await session.execute({ command: 'run_plan' }, { kind: 'user' });
  if (held.length > 0) await vi.waitFor(() => expect(runners.spawned).toContain(held[0]), WAIT);
  return { daemon, session, tui, planners, ...runners };
}

/** Not awaited, as the app's loop does not await: a Continue's request lasts as long as the turn it starts. */
const press = (tui: Tui, name: Key['name'], char?: string) => { void tui.act({ type: 'key', key: { name, ...(char ? { char } : {}) } }); };
const typed = (tui: Tui, text: string) => { for (const char of text) press(tui, 'char', char); };
const screen = (tui: Tui) => stripAnsi(render(tui.state(), { tip: false }).join('\n'));
const taskIds = (tui: Tui) => tui.state().tasks.map((task) => task.id);
const entryOf = (tui: Tui, taskId: string) => rootFrame(tui.state()).childTree.find((child) => child.taskId === taskId);
const seesOnScreen = (tui: Tui, text: string) => vi.waitFor(() => expect(screen(tui)).toContain(text), WAIT);

const focus = (tui: Tui, pane: 'chat' | 'plan') => { if (tui.state().focus !== pane) press(tui, 'tab'); };

/** Enter on the plan's selected task, which lands in that task's plan or chat. */
const enterSelected = (tui: Tui) => {
  focus(tui, 'plan');
  press(tui, 'enter');
};

async function openSubplanner(tui: Tui, taskId = 'd') {
  await vi.waitFor(() => expect(entryOf(tui, taskId)).toBeDefined(), WAIT);
  enterSelected(tui);
  await vi.waitFor(() => {
    expect(tui.state().child?.entry.taskId).toBe(taskId);
    expect(tui.state().child?.reading).toBe(false);
  }, WAIT);
}

const parked = (tui: Tui, taskId = 'd') => vi.waitFor(() => expect(entryOf(tui, taskId)?.state).toBe('parked'), WAIT);

describe('walking a delegated tree over the real daemon', () => {
  it('goes down plan by plan and comes back up one at a time', async () => {
    const { tui, release } = await tree({
      d: [SUBMIT([nested('n', 1), check(2, ['n'])]), DONE],
      n: [SUBMIT([aiTask('a', 1)]), DONE],
    });
    await vi.waitFor(() => expect(rootFrame(tui.state()).childTree.map((child) => child.taskId)).toEqual(['d', 'n']), WAIT);

    await openSubplanner(tui, 'd');
    await vi.waitFor(() => expect(taskIds(tui)).toEqual(['n', 'c']), WAIT);
    expect(screen(tui)).toContain('the root goal › Delegated subtree');

    await openSubplanner(tui, 'n');
    await vi.waitFor(() => expect(taskIds(tui)).toEqual(['a']), WAIT);
    expect(screen(tui)).toContain('Delegated subtree › Nested n');
    expect(tui.state().child?.entry.depth).toBe(2);

    press(tui, 'escape');
    expect(tui.state().child?.entry.taskId).toBe('d');
    expect(taskIds(tui)).toEqual(['n', 'c']);

    focus(tui, 'chat');
    press(tui, 'escape');
    expect(tui.state().child).toBeNull();
    expect(tui.state().sessionId).toBe(ROOT);
    expect(taskIds(tui)).toEqual(['d']);
    release('a');
  });

  it('speaks to the subplanner on screen and shows its reply there, never on the root', async () => {
    const { tui, planners, release } = await tree({ d: [SUBMIT([aiTask('a', 1)]), REPLY, DONE] });
    await parked(tui);
    await openSubplanner(tui);

    focus(tui, 'chat');
    typed(tui, 'useblue');
    press(tui, 'enter');

    await vi.waitFor(() => expect(planners.d.asked.join('\n')).toContain('useblue'), WAIT);
    await seesOnScreen(tui, 'Done with this turn.');
    expect(screen(tui)).toContain('useblue');
    press(tui, 'escape');
    expect(screen(tui)).not.toContain('useblue');
    release('a');
  });

  it('finds the conversation again when the subplanner is left and reopened', async () => {
    const { tui, planners, release } = await tree({ d: [SUBMIT([aiTask('a', 1)]), REPLY, DONE] });
    await parked(tui);
    await openSubplanner(tui);
    focus(tui, 'chat');
    typed(tui, 'useblue');
    press(tui, 'enter');
    await vi.waitFor(() => expect(planners.d.asked.join('\n')).toContain('useblue'), WAIT);
    await seesOnScreen(tui, 'Done with this turn.');

    press(tui, 'escape');
    expect(tui.state().child).toBeNull();
    await openSubplanner(tui);

    await seesOnScreen(tui, 'useblue');
    expect(taskIds(tui)).toEqual(['a']);
    release('a');
  });

  it('keeps the root current beneath a child, across a dropped socket too', async () => {
    const { tui, daemon, session, release } = await tree({ d: [SUBMIT([aiTask('a', 1)]), DONE] });
    await parked(tui);
    await openSubplanner(tui);

    daemon.dropSockets();
    await vi.waitFor(() => expect(tui.state().child?.lost).toBe(false), WAIT);
    release('a');
    await vi.waitFor(() => expect(session.planTasks[0].status).toBe('completed'), WAIT);
    await vi.waitFor(() => expect(tui.state().child?.entry.state).toBe('ended'), WAIT);
    await vi.waitFor(() => expect(tui.state().child?.parent.run.handoff).toBeDefined(), WAIT);

    // The handoff pops up only when its frame lands live; one the socket's
    // snapshot brings back is held on the root quietly.
    if (tui.state().overlay) press(tui, 'escape');
    focus(tui, 'chat');
    press(tui, 'escape');

    await vi.waitFor(() => expect(tui.state().tasks[0]?.status).toBe('completed'), WAIT);
    expect(tui.state().sessionId).toBe(ROOT);
  });

  it('shows a child runner\'s question on its chat and answers it on the child\'s route', async () => {
    const { tui, sessions, release, session } = await tree({ d: [SUBMIT([aiTask('a', 1)]), REPLY, DONE] });
    await parked(tui);
    const answer = sessions.get('a')!.callCheckpoint(QUESTION);
    await vi.waitFor(() => expect(entryOf(tui, 'd')?.checkpoints).toEqual(['a']), WAIT);

    await openSubplanner(tui);
    enterSelected(tui);
    await seesOnScreen(tui, QUESTION);
    expect(tui.state().taskView?.taskId).toBe('a');

    press(tui, 'ctrl-y');

    await expect(answer).resolves.toMatchObject({ kind: 'continue' });
    await vi.waitFor(() => expect(screen(tui)).not.toContain('Task 1 asks'), WAIT);
    await vi.waitFor(() => expect(entryOf(tui, 'd')?.checkpoints).toBeUndefined(), WAIT);
    release('a');
    await vi.waitFor(() => expect(session.planTasks[0].status).toBe('completed'), WAIT);
  });

  it('answers a depth-one subplanner\'s question on the root\'s task, from the subplanner\'s screen', async () => {
    const { tui, planners, release } = await tree({ d: [SUBMIT([aiTask('a', 1)]), ASKS('Which way?'), REPLY, DONE] });
    await parked(tui);
    await openSubplanner(tui);

    focus(tui, 'chat');
    typed(tui, 'ask');
    press(tui, 'enter');
    await seesOnScreen(tui, 'Subplanner asks');
    expect(screen(tui)).toContain('Which way?');
    expect(screen(tui)).toContain('raise');

    press(tui, 'ctrl-y');

    await vi.waitFor(() => expect(planners.d.asked.join('\n')).toContain('The plan above answered your question: approved'), WAIT);
    await vi.waitFor(() => expect(screen(tui)).not.toContain('Subplanner asks'), WAIT);
    expect(tui.state().child?.entry.taskId).toBe('d');
    release('a');
  });

  it('answers a depth-two subplanner\'s question through the plan above it, with no raise', async () => {
    const { tui, planners, release } = await tree({
      d: [SUBMIT([nested('n', 1), check(2, ['n'])]), REPLY, DONE],
      n: [SUBMIT([aiTask('a', 1)]), ASKS('Which file?'), REPLY, DONE],
    });
    await parked(tui, 'n');
    await openSubplanner(tui, 'd');
    await vi.waitFor(() => expect(taskIds(tui)).toEqual(['n', 'c']), WAIT);
    await openSubplanner(tui, 'n');

    focus(tui, 'chat');
    typed(tui, 'ask');
    press(tui, 'enter');
    await seesOnScreen(tui, 'Subplanner asks');
    expect(screen(tui)).not.toContain('raise');

    typed(tui, 'useatxt');
    press(tui, 'ctrl-g');

    await vi.waitFor(() => expect(planners.n.asked.join('\n')).toContain('useatxt'), WAIT);
    await vi.waitFor(() => expect(screen(tui)).not.toContain('Subplanner asks'), WAIT);
    release('a');
  });

  it('finds its way back after the sockets drop, and the composer still reaches the child', async () => {
    const { tui, daemon, planners, release } = await tree({ d: [SUBMIT([aiTask('a', 1)]), REPLY, DONE] });
    await parked(tui);
    await openSubplanner(tui);

    daemon.dropSockets();

    await vi.waitFor(() => expect(tui.actions.some((action) => action.type === 'followLost' && action.sessionId === tui.state().sessionId)).toBe(true), WAIT);
    await vi.waitFor(() => expect(tui.state().child?.lost).toBe(false), WAIT);

    focus(tui, 'chat');
    typed(tui, 'stillthere');
    press(tui, 'enter');
    await vi.waitFor(() => expect(planners.d.asked.join('\n')).toContain('stillthere'), WAIT);
    await seesOnScreen(tui, 'Done with this turn.');
    release('a');
  });

  it('reads a plan that ended without a composer, and nothing typed reaches it', async () => {
    const { tui, planners, session } = await tree({ d: [SUBMIT([aiTask('a', 1)]), DONE] }, []);
    await vi.waitFor(() => expect(session.planTasks[0].status).toBe('completed'), WAIT);
    await vi.waitFor(() => expect(entryOf(tui, 'd')?.state).toBe('ended'), WAIT);
    await vi.waitFor(() => expect(tui.state().overlay?.kind).toBe('handoff'), WAIT);
    press(tui, 'escape');

    await openSubplanner(tui);

    await vi.waitFor(() => expect(taskIds(tui)).toEqual(['a']), WAIT);
    expect(composerView(tui.state())).toBeNull();
    expect(screen(tui)).toContain('this plan has ended, so it takes no messages');
    const asked = planners.d.asked.length;
    focus(tui, 'chat');
    typed(tui, 'hello');
    press(tui, 'enter');
    expect(planners.d.asked).toHaveLength(asked);

    await vi.waitFor(() => expect(tui.state().tasks[0].attempted).toBeTruthy(), WAIT);
    enterSelected(tui);
    await vi.waitFor(() => expect(tui.state().taskView?.taskId).toBe('a'), WAIT);
    expect(screen(tui)).toContain('read-only');
  });

  it('offers the root\'s branch, not the child\'s, when the root\'s run lands beneath a child', async () => {
    const { tui, session, release } = await tree({ d: [SUBMIT([aiTask('a', 1)]), DONE] });
    await parked(tui);
    await openSubplanner(tui);
    release('a');
    await vi.waitFor(() => expect(session.planTasks[0].status).toBe('completed'), WAIT);

    await vi.waitFor(() => expect(tui.state().overlay?.kind).toBe('handoff'), WAIT);
    await seesOnScreen(tui, 'Run handoff');
    expect(screen(tui)).toContain('Delegated subtree');

    press(tui, 'escape');
    expect(tui.state().overlay).toBeNull();
    expect(tui.state().child?.entry.taskId).toBe('d');
  });

  it('stops the whole run from below, and leaves the plan to read with its Continue named', async () => {
    const { tui, session, sessions } = await tree({ d: [SUBMIT([aiTask('a', 1)]), REPLY, DONE] });
    await parked(tui);
    const answer = sessions.get('a')!.callCheckpoint(QUESTION);
    await openSubplanner(tui);

    focus(tui, 'plan');
    press(tui, 'char', 'S');

    await expect(answer).resolves.toMatchObject({ kind: 'withdrawn' });
    await vi.waitFor(() => expect(tui.state().child?.entry.state).toBe('ended'), WAIT);
    await vi.waitFor(() => expect(session.planTasks[0].status).toBe('pending'), WAIT);
    await seesOnScreen(tui, 'esc, then l continues it.');

    focus(tui, 'chat');
    press(tui, 'escape');
    expect(tui.state().child).toBeNull();
    expect(tui.state().sessionId).toBe(ROOT);
  });

  it('reopens the same subplanner, ready to take messages, once its task is continued', async () => {
    const { tui, planners } = await tree({ d: [SUBMIT([aiTask('a', 1)]), REPLY, REPLY, DONE] });
    await parked(tui);
    await openSubplanner(tui);
    const child = tui.state().sessionId;
    focus(tui, 'plan');
    press(tui, 'char', 'S');
    await vi.waitFor(() => expect(tui.state().child?.entry.state).toBe('ended'), WAIT);
    focus(tui, 'chat');
    press(tui, 'escape');
    await vi.waitFor(() => expect(tui.state().tasks[0]?.continuable).toBeTruthy(), WAIT);

    focus(tui, 'plan');
    press(tui, 'char', 'l');
    expect(tui.state().taskView?.taskId).toBe('d');
    focus(tui, 'chat');
    typed(tui, 'goon');
    press(tui, 'enter');

    await vi.waitFor(() => expect(planners.d.asked.join('\n')).toContain('goon'), WAIT);
    await parked(tui);
    press(tui, 'escape');
    expect(tui.state().taskView).toBeNull();
    await openSubplanner(tui);
    expect(tui.state().sessionId).toBe(child);
    expect(composerView(tui.state())).not.toBeNull();
    focus(tui, 'chat');
    typed(tui, 'andmore');
    press(tui, 'enter');
    await vi.waitFor(() => expect(planners.d.asked.join('\n')).toContain('andmore'), WAIT);
  });
});
