import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import type { UsageRecord } from '../../models/Usage';
import { FakeEventStore, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { ChildDirectory } from '../ChildDirectory';
import type { ChildNode, SubplannerLink } from '../ChildPlanRunner';
import type { ChildPlacement, SessionRuntimeSettings } from '../createSession';
import { rootMandate, SCRIPT_PAST_THE_RULES, withheldPlannerTools, type Grant, type Mandate, type NodeAuthority, type RootSettings } from '../Mandate';
import type { PlannerToolHandler } from '../mcp';
import type { SubplannerBrief } from '../PlanPrompts';
import { ChildFunding, RootFunding } from '../NodeFunding';
import { ChildPosition, nodePosition, RootPosition, type BuiltChild, type NodeHost, type NodePosition, type SeatHost } from '../NodePosition';
import { ChildReading, RootReading } from '../NodeReading';
import { ChildSeat, RootSeat } from '../NodeSeat';
import { NODE_REPORTED } from '../plannerTools';
import { LeaseHost, SessionHeldError, type SessionHeld, type SessionLease } from '../sessionLease';
import { SlotPool } from '../SlotPool';
import { worktreesDirOf } from '../stateRoot';
import { SESSION_RESERVE_TOKENS as R, type NodeBudget } from '../TreeLedger';

/**
 * A Session's place in its tree, root and child, with that Session faked as
 * the narrow host a position reads: no tree of Sessions is built, and a child
 * is whatever the fake `child` builder hands back.
 */

const delegating = (tokens: number): Mandate => rootMandate({ level: 'act', autorun: true, autonomous: true, delegationTokens: tokens, runners: ['claude-code'], models: {} });
const used = (tokens: number): UsageRecord => ({ source: 'claude-code', inputTokens: tokens });
const delegated = (id: string, over: Partial<Task> = {}): Task => createTask({ id, order: 1, title: `Task ${id}`, prompt: `do ${id}`, type: 'delegated', ...over });

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'node-position-'));
  dirs.push(dir);
  return dir;
}

/** A delegated task's worktree under `stateRoot`, where a child's code root must be. */
function worktreeOf(stateRoot: string, name = 'task-a'): string {
  const dir = path.join(worktreesDirOf(stateRoot), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A seat host no test here reaches: a position only hands it on to the seat it builds. */
const unreachedSeat = new Proxy({}, { get: (_, key) => () => { throw new Error(`The seat host's ${String(key)} was read.`); } }) as SeatHost;

/** A run's worktree seats, as `IsolationRunController` keeps them: a task named here has one. */
function seats(...taskIds: string[]) {
  const held = new Map<string, string | undefined>(taskIds.map((id) => [id, undefined]));
  const seat = (taskId: string) => {
    if (!held.has(taskId)) throw new Error(`No seat for ${taskId}.`);
  };
  return {
    held,
    requireChildSeat: seat,
    childSession: (taskId: string) => held.get(taskId),
    hostChild: (taskId: string, mint: () => string) => {
      seat(taskId);
      const named = held.get(taskId) ?? mint();
      held.set(taskId, named);
      return named;
    },
    childIsolation: new FakeWorktreeIsolation(),
    discardChild: vi.fn(() => Promise.resolve({ preserved: [], refused: [] as { worktree: string; reason: string }[] })),
  };
}

function link(over: Partial<SubplannerLink> = {}) {
  const state = { stopped: false, reported: false };
  const given: SubplannerLink = {
    taskComplete: vi.fn(),
    checkpoint: vi.fn(),
    changed: vi.fn(),
    stopped: () => state.stopped,
    reported: () => state.reported,
    usage: vi.fn(),
    listening: () => true,
    spoken: vi.fn(),
    ...over,
  };
  return { link: given, state };
}

/** A Session as a position reads it: its plan holds `tasks`, and each child it builds is `built`. */
function nodeHost(workspace: string, over: Partial<NodeHost> & { tasks?: Task[]; built?: BuiltChild } = {}) {
  const { tasks = [], built, ...rest } = over;
  const run = seats(...tasks.map((t) => t.id));
  const runnerSessions = new Map<string, string | undefined>();
  const state = { mandate: delegating(10 * R), closed: false };
  const store = {
    get: (id: string) => {
      const task = tasks.find((t) => t.id === id);
      return task && { ...task, runnerSessionId: runnerSessions.get(id) ?? task.runnerSessionId };
    },
    setTaskRunnerSessionId: vi.fn((id: string, sessionId: string | undefined) => { runnerSessions.set(id, sessionId); }),
    resolveTaskRunner: () => 'claude-code' as const,
  };
  const pool = new SlotPool(() => 4);
  const host: NodeHost = {
    depth: 0,
    mandate: () => state.mandate,
    sessionId: () => 'root-session',
    workspace: () => workspace,
    closed: () => state.closed,
    delegationOffered: true,
    runs: () => run,
    pool: () => pool,
    store: () => store,
    saved: vi.fn(),
    heldElsewhere: () => null,
    delegationLimit: () => 10 * R,
    notice: vi.fn(),
    childrenStopped: () => Promise.resolve(),
    stopSubtree: vi.fn(() => Promise.resolve()),
    raised: vi.fn(),
    refusedStart: vi.fn(),
    child: vi.fn(() => built ?? builtChild()),
    seat: unreachedSeat,
    reading: {
      tasks: () => tasks,
      logs: { attempts: () => [], events: () => [] },
      workspaceRoot: () => workspace,
      git: { branch: () => undefined, blob: () => Promise.resolve(undefined) },
      childSession: (taskId) => run.childSession(taskId),
      addressed: () => Promise.resolve(),
    },
    ...rest,
  };
  return { host, run, store, pool, state };
}

function builtChild(over: Partial<BuiltChild> = {}): BuiltChild {
  return {
    load: vi.fn(),
    asNode: vi.fn((_task: Task, _mandate: Mandate, _pins: readonly string[]) => ({ sessionId: 'child' }) as ChildNode),
    destroy: vi.fn(),
    ...over,
  };
}

function rootAt(workspace: string, over: Parameters<typeof nodeHost>[1] = {}) {
  const log = new FakeEventStore();
  const position = new RootPosition({ eventLog: () => log, saveSession: vi.fn() });
  const placed = nodeHost(workspace, over);
  position.bind(placed.host);
  return { position, log, ...placed };
}

function placementUnder(stateRoot: string, over: Partial<ChildPlacement> = {}): ChildPlacement {
  return {
    sessionId: 'child-session',
    stateRoot,
    rootSessionId: 'root-session',
    held: () => null,
    isolation: new FakeWorktreeIsolation(),
    pool: new SlotPool(() => 4),
    directory: new ChildDirectory({ rootSessionId: () => 'root-session', ledger: () => Promise.resolve(null), rootTask: () => undefined, saved: () => null, logLocation: (sessionId) => ({ baseDir: stateRoot, sessionId }) }),
    ...over,
  };
}

/** A child's side of a real tree, carved by a root for task `a`, so a stop or a raise on it reaches its funding as one would. */
async function carvedBudget(tokens: number, parent = rootAt(stateDir(), { tasks: [delegated('a', { budget: { tokens } })] })): Promise<NodeBudget> {
  const carved = await parent.position.funds.carveFor(delegated('a', { budget: { tokens } }));
  if (!carved.ok) throw new Error('refused');
  return carved.budget;
}

const settings = (containers: SessionRuntimeSettings['containers']) => () => ({ containers }) as SessionRuntimeSettings;

describe('a root position', () => {
  it('keeps its state in its workspace, under its own id, and is opened under the id it is given', () => {
    const position = new RootPosition({ eventLog: () => new FakeEventStore() });
    expect(position.stateRoot('/w')).toBe('/w');
    expect(position.rootSessionId('own')).toBe('own');
    expect(position.logLocation('/w', 's1')).toEqual({ baseDir: '/w', sessionId: 's1' });
    expect(position.sessionId('given')).toBe('given');
    expect(position.sessionId(undefined)).toBeUndefined();
    expect(position.budget).toBeUndefined();
    expect(position.isolation).toBeUndefined();
    expect(position.run()).toEqual({});
  });

  it('saves through the saves it is given, and then holds no lease file unless it is handed a host', () => {
    const save = vi.fn();
    const lease: SessionLease = { claim: vi.fn(), hold: () => null, release: vi.fn(), publish: vi.fn() };
    const leaseHost = new LeaseHost({ id: 'test-host' });
    vi.spyOn(leaseHost, 'lease').mockReturnValue(lease);
    const swapped = new RootPosition({ eventLog: () => new FakeEventStore(), saveSession: save });
    expect(swapped.save).toBe(save);
    const unleased = swapped.lease(vi.fn(), () => false);
    expect(unleased.hold('s', 'w')).toBeNull();
    const commit = vi.fn();
    unleased.claim('s', 'w', commit);
    expect(commit).toHaveBeenCalled();

    const hosted = new RootPosition({ eventLog: () => new FakeEventStore(), saveSession: save, leaseHost });
    expect(hosted.lease(vi.fn(), () => false)).toBe(lease);
    expect(leaseHost.lease).toHaveBeenCalledTimes(1);
  });

  it('reads where its tasks run from its settings, and lets a plan load in any checkout', () => {
    const position: NodePosition = new RootPosition({ eventLog: () => new FakeEventStore() });
    expect(position.containers(settings({ enabled: true } as SessionRuntimeSettings['containers']))).toEqual({ enabled: true });
    expect(() => position.refuseCheckout('/anywhere')).not.toThrow();
  });

  it('holds a root\'s funding, seat and reading once bound, and places one Session', () => {
    const position = new RootPosition({ eventLog: () => new FakeEventStore() });
    expect(() => position.funds).toThrow('This position has no Session yet.');
    const { host } = nodeHost(stateDir());
    position.bind(host);
    expect(position.funds).toBeInstanceOf(RootFunding);
    expect(position.seat).toBeInstanceOf(RootSeat);
    expect(position.reading).toBeInstanceOf(RootReading);
    expect(() => position.bind(host)).toThrow('A position places one Session.');
  });

  it('refuses nothing at its node, and stops its funds when nothing ready can start', () => {
    const { position, host } = rootAt(stateDir());
    expect(position.nodeRefusal()).toBeNull();
    expect(position.startRefusal()).toBeNull();
    expect(position.reported).toBe(false);
    expect(position.underStop).toBe(false);
    const stop = vi.spyOn(position.funds, 'stop');
    position.startRefused('Nothing fits.');
    expect(stop).toHaveBeenCalledWith('Nothing fits.');
    expect(host.refusedStart).not.toHaveBeenCalled();
  });

  it('seats a child in a task\'s worktree under the root\'s state, lease and slots', async () => {
    const workspace = stateDir();
    const a = delegated('a', { budget: { tokens: 2 * R } });
    const { position, run, pool } = rootAt(workspace, { tasks: [a] });
    const placement = position.hostChild('a');
    expect(placement).toMatchObject({ stateRoot: workspace, rootSessionId: 'root-session', isolation: run.childIsolation, pool, directory: position.children });
    expect(placement.held()).toBeNull();
    expect(placement.budget).toBeUndefined();
    expect(position.hostChild('a').sessionId).toBe(placement.sessionId);
    expect(() => position.hostChild('b')).toThrow('No seat for b.');
  });
});

describe('a child position', () => {
  it('refuses to be built in the user\'s checkout', () => {
    const stateRoot = stateDir();
    expect(() => new ChildPosition({ placement: placementUnder(stateRoot), workspace: stateRoot })).toThrow('never in the user\'s checkout');
  });

  it('keeps its state, its log and its lease at its root\'s, under the id its parent seated it by', () => {
    const stateRoot = stateDir();
    const workspace = worktreeOf(stateRoot);
    const holder = { holder: { host: { id: 'h' } } } as unknown as SessionHeld;
    let held: SessionHeld | null = null;
    const placement = placementUnder(stateRoot, { held: () => held });
    const position = new ChildPosition({ placement, workspace });
    expect(position.stateRoot()).toBe(stateRoot);
    expect(position.rootSessionId()).toBe('root-session');
    expect(position.logLocation(workspace, 'child-session')).toEqual({ baseDir: stateRoot, sessionId: 'child-session', rootSessionId: 'root-session' });
    expect(position.sessionId()).toBe('child-session');
    expect(position.isolation).toBe(placement.isolation);
    expect(position.children).toBe(placement.directory);
    expect(position.containers()).toBeUndefined();
    expect(() => position.refuseCheckout(stateRoot)).toThrow('never in the user\'s checkout');

    const lease = position.lease();
    expect(() => lease.claim('child-session', workspace)).not.toThrow();
    held = holder;
    expect(lease.hold('child-session', workspace)).toBe(holder);
    expect(() => lease.claim('child-session', workspace)).toThrow(SessionHeldError);
  });

  it('runs inside its root\'s state and slots, refusing a start as its node does', async () => {
    const stateRoot = stateDir();
    const placement = placementUnder(stateRoot, { budget: await carvedBudget(R) });
    const { link: given, state } = link();
    const position = new ChildPosition({ placement, workspace: worktreeOf(stateRoot), link: given });
    position.bind(nodeHost(worktreeOf(stateRoot), { depth: 1 }).host);
    const run = position.run();
    expect(run).toMatchObject({ stateRoot, pool: placement.pool, budget: position.budget });
    expect(run.planNode?.()).toBe('root/1');
    run.decided?.();
    expect(given.changed).toHaveBeenCalled();
    expect(run.nodeRefusal?.()).toBeNull();
    state.reported = true;
    expect(run.nodeRefusal?.()).toBe(NODE_REPORTED);
  });

  it('tells its parent\'s attempt of each record it is charged', () => {
    const stateRoot = stateDir();
    const budget = { path: 'root/1', spent: vi.fn(), turnSpent: vi.fn() } as unknown as NodeBudget;
    const { link: given } = link();
    const position = new ChildPosition({ placement: placementUnder(stateRoot, { budget }), workspace: worktreeOf(stateRoot), link: given });
    position.budget?.spent(used(1), { taskId: 't', attempt: 1 });
    position.budget?.turnSpent(used(2));
    expect(budget.spent).toHaveBeenCalledWith(used(1), { taskId: 't', attempt: 1 });
    expect(budget.turnSpent).toHaveBeenCalledWith(used(2));
    expect(given.usage).toHaveBeenNthCalledWith(1, used(1));
    expect(given.usage).toHaveBeenNthCalledWith(2, used(2));

    const unlinked = new ChildPosition({ placement: placementUnder(stateRoot, { budget }), workspace: worktreeOf(stateRoot) });
    expect(unlinked.budget).toBe(budget);
  });

  it('holds a child\'s funding, seat and reading, or a root\'s seat when it answers to no attempt', () => {
    const stateRoot = stateDir();
    const workspace = worktreeOf(stateRoot);
    const linked = new ChildPosition({ placement: placementUnder(stateRoot), workspace, link: link().link });
    linked.bind(nodeHost(workspace, { depth: 1 }).host);
    expect(linked.funds).toBeInstanceOf(ChildFunding);
    expect(linked.seat).toBeInstanceOf(ChildSeat);
    expect(linked.reading).toBeInstanceOf(ChildReading);

    const unlinked = new ChildPosition({ placement: placementUnder(stateRoot), workspace });
    unlinked.bind(nodeHost(workspace, { depth: 1 }).host);
    expect(unlinked.seat).toBeInstanceOf(RootSeat);
    expect(unlinked.nodeRefusal()).toBeNull();
  });

  it('refuses a start under a Stop, a withdrawn mandate or a report', () => {
    const stateRoot = stateDir();
    const workspace = worktreeOf(stateRoot);
    const { link: given, state: linkState } = link();
    const position = new ChildPosition({ placement: placementUnder(stateRoot), workspace, link: given });
    const { host, state } = nodeHost(workspace, { depth: 1 });
    position.bind(host);
    expect(position.nodeRefusal()).toBeNull();

    linkState.stopped = true;
    expect(position.underStop).toBe(true);
    expect(position.nodeRefusal()).toBe('A Stop stands at or above this node, so nothing starts here.');
    linkState.stopped = false;

    const withdrawn = { ...state.mandate, grants: new Set([...state.mandate.grants].filter((grant) => grant !== 'control')) };
    state.mandate = withdrawn;
    expect(position.nodeRefusal()).toBe('what it may do was withdrawn above it');
    state.mandate = delegating(10 * R);

    linkState.reported = true;
    expect(position.nodeRefusal()).toBeNull();
    expect(position.startRefusal()).toBe(NODE_REPORTED);
  });

  it('tells its subplanner once that nothing ready can start, and again after a raise', async () => {
    const stateRoot = stateDir();
    const workspace = worktreeOf(stateRoot);
    const parent = rootAt(stateDir(), { tasks: [delegated('a', { budget: { tokens: 2 * R } })] });
    const position = new ChildPosition({ placement: placementUnder(stateRoot, { budget: await carvedBudget(2 * R, parent) }), workspace, link: link().link });
    const { host } = nodeHost(workspace, { depth: 1 });
    position.bind(host);

    position.startRefused('Nothing fits.');
    position.startRefused('Nothing fits.');
    expect(host.refusedStart).toHaveBeenCalledTimes(1);
    expect(host.refusedStart).toHaveBeenCalledWith('Nothing fits.');
    expect(position.funds.stoppedFor()).toBeNull();

    expect(await parent.position.funds.raise('a', R)).toBeNull();
    expect(host.raised).toHaveBeenCalled();
    position.startRefused('Nothing fits.');
    expect(host.refusedStart).toHaveBeenCalledTimes(2);
  });

  it('stops its subtree when its budget stops it, unless its Session is gone', async () => {
    const stateRoot = stateDir();
    const workspace = worktreeOf(stateRoot);
    const open = new ChildPosition({ placement: placementUnder(stateRoot, { budget: await carvedBudget(R) }), workspace, link: link().link });
    const { host } = nodeHost(workspace, { depth: 1 });
    open.bind(host);
    open.funds.stop('Out of tokens.');
    await flushMicrotasks();
    expect(host.notice).toHaveBeenCalledWith('warn', 'Out of tokens.');
    expect(host.stopSubtree).toHaveBeenCalledTimes(1);
    expect(open.underStop).toBe(true);
    expect(open.nodeRefusal()).toBe('Out of tokens.');

    const gone = new ChildPosition({ placement: placementUnder(stateRoot, { budget: await carvedBudget(R) }), workspace, link: link().link });
    const closed = nodeHost(workspace, { depth: 1 });
    gone.bind(closed.host);
    closed.state.closed = true;
    gone.funds.stop('Out of tokens.');
    await flushMicrotasks();
    expect(closed.host.stopSubtree).not.toHaveBeenCalled();
  });
});

describe('opening and discarding a child', () => {
  it('refuses before the ledger when its Session is closed, the attempt stopped or delegation is off', async () => {
    const a = delegated('a', { budget: { tokens: 2 * R } });
    const closed = rootAt(stateDir(), { tasks: [a] });
    closed.state.closed = true;
    await expect(closed.position.openChild(a, 'cwd', link().link)).rejects.toThrow('Task "Task a" was stopped before its child opened.');
    const stopped = link();
    stopped.state.stopped = true;
    await expect(rootAt(stateDir(), { tasks: [a] }).position.openChild(a, 'cwd', stopped.link)).rejects.toThrow('was stopped before its child opened');
    const off = rootAt(stateDir(), { tasks: [a], delegationOffered: false });
    await expect(off.position.openChild(a, 'cwd', link().link)).rejects.toThrow('Task "Task a" is a delegated task, and delegation is off here.');
    expect(closed.log.events).toHaveLength(0);
  });

  it('builds a child holding what was carved, seated and saved before it is built', async () => {
    const workspace = stateDir();
    const a = delegated('a', { budget: { tokens: 2 * R } });
    const built = builtChild();
    const { position, host, store } = rootAt(workspace, { tasks: [a], built });
    const node = await position.openChild(a, 'cwd', link().link);
    expect(node.sessionId).toBe('child');
    const spec = vi.mocked(host.child).mock.calls[0]?.[0];
    expect(spec).toMatchObject({ task: a, cwd: 'cwd', placement: { stateRoot: workspace, rootSessionId: 'root-session' }, authority: { depth: 1 }, brief: { readOnly: false, runner: a.assignedRunner } });
    expect(spec?.placement.budget?.path).toBe('root/1');
    expect(store.setTaskRunnerSessionId).toHaveBeenCalledWith('a', spec?.placement.sessionId, 'claude-code');
    expect(host.saved).toHaveBeenCalled();
    expect(built.load).not.toHaveBeenCalled();
    expect(vi.mocked(built.asNode).mock.calls[0]?.[1].limits.tokens).toBeGreaterThan(0);
    expect(built.destroy).not.toHaveBeenCalled();
  });

  it('destroys a child it built and closes its node when the open fails after building it', async () => {
    const a = delegated('a', { budget: { tokens: 2 * R } });
    const built = builtChild({ asNode: () => { throw new Error('No seat.'); } });
    const { position } = rootAt(stateDir(), { tasks: [a], built });
    await expect(position.openChild(a, 'cwd', link().link)).rejects.toThrow('No seat.');
    expect(built.destroy).toHaveBeenCalledTimes(1);
    expect(position.funds.tree?.raise('root/1', 1)).toBe('That child has closed, so nothing can raise its budget.');
  });

  it('reports the refusal that failed the open, not a failure to destroy', async () => {
    const a = delegated('a', { budget: { tokens: 2 * R } });
    const built = builtChild({ asNode: () => { throw new Error('No seat.'); }, destroy: () => { throw new Error('Already gone.'); } });
    const { position } = rootAt(stateDir(), { tasks: [a], built });
    await expect(position.openChild(a, 'cwd', link().link)).rejects.toThrow('No seat.');
  });

  it('discards the child a task names, as the plan holds it now, and lets the task go of it', async () => {
    const workspace = stateDir();
    const a = delegated('a', { budget: { tokens: 2 * R } });
    const { position, run, store } = rootAt(workspace, { tasks: [a] });
    await position.discardChild(a);
    expect(run.discardChild).not.toHaveBeenCalled();

    store.setTaskRunnerSessionId('a', 'old-child');
    await position.discardChild(a);
    expect(run.discardChild).toHaveBeenCalledWith({ baseDir: workspace, rootSessionId: 'root-session', sessionId: 'old-child' });
    expect(store.get('a')?.runnerSessionId).toBeUndefined();

    store.setTaskRunnerSessionId('a', 'kept-child');
    run.discardChild.mockResolvedValueOnce({ preserved: [], refused: [{ worktree: 'wt', reason: 'dirty' }] });
    await expect(position.discardChild(a)).rejects.toThrow('The child run of its last attempt could not be discarded: wt (dirty)');
    expect(store.get('a')?.runnerSessionId).toBe('kept-child');
  });
});

describe('choosing a position', () => {
  it('places a Session with a placement as a child, and one without as the root', () => {
    const stateRoot = stateDir();
    const workspace = worktreeOf(stateRoot);
    const eventLog = () => new FakeEventStore();
    expect(nodePosition({ placement: placementUnder(stateRoot), workspaceRoot: () => workspace, eventLog })).toBeInstanceOf(ChildPosition);
    expect(nodePosition({ workspaceRoot: () => stateRoot, eventLog })).toBeInstanceOf(RootPosition);
  });

  it('hands a child the authority and the brief it was given, and a root only the authority', () => {
    const stateRoot = stateDir();
    const workspace = worktreeOf(stateRoot);
    const eventLog = () => new FakeEventStore();
    const given = authorityAt(1, heldBelow());
    const child = nodePosition({ placement: placementUnder(stateRoot), workspaceRoot: () => workspace, eventLog, child: given, brief });
    expect([child.heldAuthority(), child.brief]).toEqual([given, brief]);
    const root = nodePosition({ workspaceRoot: () => stateRoot, eventLog, child: given, brief });
    expect([root.heldAuthority(), root.brief]).toEqual([given, undefined]);
  });
});

/** A child's mandate: what a delegating root may hand down, narrowed by `over`. */
const heldBelow = (over: Partial<Mandate> & { granted?: readonly Grant[] } = {}): Mandate => {
  const { granted = ['observe', 'steer', 'control', 'replan', 'approve'], ...rest } = over;
  return { ...delegating(R), grants: new Set(granted), autonomy: 'guarded', ...rest };
};
const authorityAt = (depth: number, mandate: Mandate): NodeAuthority => ({ depth, mandate: () => mandate });
const brief: SubplannerBrief = { protectedPaths: ['secrets'], readOnly: false, runner: 'claude-code' };
const rootSettings = (): Omit<RootSettings, 'level'> => ({ autorun: false, autonomous: false, delegationTokens: 0, runners: ['claude-code'], models: {} });
const push = (): Task => createTask({ id: 'push', order: 1, title: 'Push', type: 'script', commands: [['git', 'push']] });
const noTools: PlannerToolHandler = {};

describe('what a node may do and whom it answers to', () => {
  it('holds the root to its settings and its person', () => {
    const position = new RootPosition({ eventLog: () => new FakeEventStore() });
    expect(position.authority(rootSettings).depth).toBe(0);
    expect(position.authority(rootSettings).mandate('watch')).toEqual(rootMandate({ ...rootSettings(), level: 'watch' }));
    expect(position.heldAuthority()).toBeUndefined();
    expect([position.autonomous(true), position.autonomous(false)]).toEqual([true, false]);
    expect(position.heldLimits()).toBeUndefined();
    expect(position.inheritedProtectedPaths()).toEqual([]);
    expect(position.unsealedRefusal(push())).toBeNull();
    expect(position.mayMergeUnasked()).toBe(true);
    expect(position.mayAskAPerson).toBe(true);
    expect(position.plannerActor()).toBeUndefined();
    expect(position.plannerTools('user')).toEqual({});
    expect(position.offeredTools(noTools)).toBe(noTools);
    expect(position.answersToParent).toBe(false);
    expect(position.mergeTarget()).toBe('the user\'s branch');
    expect(position.turnsTakeTreeSlots).toBe(false);
    expect(position.brief).toBeUndefined();
    expect(() => { position.changed(); position.passUsageUp(used(5)); }).not.toThrow();
  });

  it('holds a child to the mandate it was given, whatever the root settings say', () => {
    const stateRoot = stateDir();
    const mandate = heldBelow({ exclusions: { protectedPaths: ['secrets'] } });
    const given = authorityAt(2, mandate);
    const position = new ChildPosition({ placement: placementUnder(stateRoot), workspace: worktreeOf(stateRoot), authority: given, brief, link: link().link });
    expect(position.authority(rootSettings)).toBe(given);
    expect(position.heldAuthority()).toBe(given);
    expect(position.autonomous(true)).toBe(false);
    expect(position.heldLimits()).toBe(mandate.limits);
    expect(position.inheritedProtectedPaths()).toEqual(['secrets']);
    expect(position.mayMergeUnasked()).toBe(false);
    expect(position.mayAskAPerson).toBe(false);
    expect(position.plannerActor()).toEqual({ kind: 'subplanner', depth: 2 });
    expect(position.brief).toBe(brief);
    expect(position.turnsTakeTreeSlots).toBe(true);
  });

  it('reads autonomy and merge from a child\'s grants as they stand', () => {
    const stateRoot = stateDir();
    let mandate = heldBelow();
    const position = new ChildPosition({ placement: placementUnder(stateRoot), workspace: worktreeOf(stateRoot), authority: { depth: 1, mandate: () => mandate } });
    expect([position.autonomous(false), position.mayMergeUnasked()]).toEqual([false, false]);
    mandate = heldBelow({ autonomy: 'full', granted: ['observe', 'merge'] });
    expect([position.autonomous(false), position.mayMergeUnasked()]).toEqual([true, true]);
  });

  it('refuses a child\'s script that would run unsealed, naming its level', () => {
    const stateRoot = stateDir();
    const position = new ChildPosition({ placement: placementUnder(stateRoot), workspace: worktreeOf(stateRoot), authority: authorityAt(2, heldBelow()) });
    expect(position.unsealedRefusal(push())).toBe(`Level 2 refused Task "Push": ${SCRIPT_PAST_THE_RULES}.`);
  });

  it('offers a subplanner what its grants leave it, its token and a minimal setup unless one is asked', () => {
    const stateRoot = stateDir();
    const mandate = heldBelow();
    const position = new ChildPosition({ placement: placementUnder(stateRoot), workspace: worktreeOf(stateRoot), authority: authorityAt(1, mandate), link: link().link });
    expect(position.plannerTools(undefined)).toEqual({ withheld: withheldPlannerTools(mandate), subplanner: true, noSubagents: true, runnerConfig: 'minimal' });
    const researching = heldBelow({ granted: ['observe', 'research'] });
    const asked = new ChildPosition({ placement: placementUnder(stateRoot), workspace: worktreeOf(stateRoot), authority: authorityAt(1, researching), link: link().link });
    expect(asked.plannerTools('user')).toEqual({ withheld: withheldPlannerTools(researching), subplanner: true, runnerConfig: 'user' });
  });

  it('answers its parent\'s attempt through its link: completion, checkpoints, changes and spend', async () => {
    const stateRoot = stateDir();
    const { link: given } = link({ taskComplete: vi.fn(() => Promise.resolve({ text: 'taken' })), checkpoint: vi.fn(() => ({ text: 'yes' })) });
    const position = new ChildPosition({ placement: placementUnder(stateRoot), workspace: worktreeOf(stateRoot), link: given });
    const tools = position.offeredTools(noTools);
    const context = { signal: new AbortController().signal };
    await expect(tools.taskComplete?.({ status: 'done', summary: 'did it' }, context)).resolves.toEqual({ text: 'taken' });
    expect(given.taskComplete).toHaveBeenCalledWith({ status: 'done', summary: 'did it' });
    await expect(tools.checkpoint?.({ question: 'ship?' }, context)).resolves.toEqual({ text: 'yes' });
    expect(given.checkpoint).toHaveBeenCalledWith('ship?');
    position.changed();
    expect(given.changed).toHaveBeenCalledOnce();
    position.passUsageUp(used(7));
    expect(given.usage).toHaveBeenCalledWith(used(7));
    expect(position.answersToParent).toBe(true);
    expect(position.mergeTarget()).toBe('the delegated task\'s branch');
  });

  it('seats a child with neither link nor authority as answering to nobody, though its turns take its tree\'s slots', () => {
    const stateRoot = stateDir();
    const position = new ChildPosition({ placement: placementUnder(stateRoot), workspace: worktreeOf(stateRoot) });
    expect([position.answersToParent, position.mayAskAPerson, position.turnsTakeTreeSlots]).toEqual([false, true, true]);
    expect(position.plannerTools(undefined)).toEqual({});
    expect(position.offeredTools(noTools)).toBe(noTools);
  });

  it('holds a root a test gave an authority to that mandate, with no parent to answer', () => {
    const mandate = heldBelow();
    const position = new RootPosition({ eventLog: () => new FakeEventStore(), authority: authorityAt(1, mandate) });
    expect([position.mayAskAPerson, position.answersToParent, position.turnsTakeTreeSlots]).toEqual([false, false, false]);
    expect(position.plannerActor()).toEqual({ kind: 'subplanner', depth: 1 });
    expect(position.plannerTools(undefined)).toEqual({ withheld: withheldPlannerTools(mandate), noSubagents: true });
  });
});
