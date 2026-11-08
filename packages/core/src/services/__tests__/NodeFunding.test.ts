import { describe, expect, it, vi } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import { ROOT_NODE } from '../../models/TreeEvent';
import type { UsageRecord } from '../../models/Usage';
import { FakeEventStore, flushMicrotasks } from '../../testing';
import { rootMandate, type Mandate } from '../Mandate';
import { ChildFunding, RootFunding, type ChildFundingHost, type NodeFunding, type RootFundingHost } from '../NodeFunding';
import { SESSION_RESERVE_TOKENS as R, TreeLedger, type NodeBudget } from '../TreeLedger';

/**
 * A node's funding on a real ledger and log, with its Session faked as the
 * narrow host it reads: the seats a run would hold, its mandate and its plan.
 */

const delegating = (tokens: number): Mandate => rootMandate({ level: 'act', autorun: true, autonomous: true, delegationTokens: tokens, runners: ['claude-code'], models: {} });
const used = (tokens: number): UsageRecord => ({ source: 'claude-code', inputTokens: tokens });
const delegated = (id: string, over: Partial<Task> = {}): Task => createTask({ id, order: 1, title: `Task ${id}`, prompt: `do ${id}`, type: 'delegated', ...over });

/** A run's worktree seats, as `IsolationRunController` keeps them: a task named here has one. */
function seats(...taskIds: string[]) {
  const held = new Map<string, string | undefined>(taskIds.map((id) => [id, undefined]));
  const seat = (taskId: string) => {
    if (!held.has(taskId)) throw new Error(`No seat for ${taskId}.`);
  };
  return {
    held,
    requireChildSeat: vi.fn(seat),
    childSession: (taskId: string) => held.get(taskId),
    hostChild: (taskId: string, mint: () => string) => {
      seat(taskId);
      const named = held.get(taskId) ?? mint();
      held.set(taskId, named);
      return named;
    },
  };
}

function root(limit: number, over: Partial<RootFundingHost> = {}) {
  let tokens = limit;
  const store = new FakeEventStore();
  const run = seats('a', 'b');
  const warnings: string[] = [];
  const host: RootFundingHost = {
    mandate: () => delegating(tokens),
    level: 0,
    seats: () => run,
    planHas: (taskId) => run.held.has(taskId),
    sessionId: () => 'root-session',
    openLog: vi.fn(() => store),
    limit: () => tokens,
    warn: (message) => { warnings.push(message); },
    childrenStopped: () => Promise.resolve(),
    ...over,
  };
  return { funds: new RootFunding(host), host, store, run, warnings, setLimit: (next: number) => { tokens = next; } };
}

/** A child whose Session holds `mandate`, as its parent's carve saved it: a raise moves only the ledger. */
function child(budget: NodeBudget | undefined, mandate: Mandate = delegating(0), over: Partial<ChildFundingHost> = {}) {
  const run = seats('a1', 'a2');
  const host: ChildFundingHost = {
    mandate: () => mandate,
    level: 1,
    seats: () => run,
    planHas: (taskId) => run.held.has(taskId),
    budget,
    stopped: vi.fn(),
    raised: vi.fn(),
    ...over,
  };
  return { funds: new ChildFunding(host), host, run };
}

async function carved(funds: NodeFunding, taskId: string, tokens: number): Promise<NodeBudget> {
  const given = await funds.carve(taskId, { tokens });
  if (!given.ok) throw new Error(JSON.stringify(given.refusal));
  return given.budget;
}

describe('a root\'s funding (ADR-0056 M5)', () => {
  it('opens no log for a flat run, and reads as holding nothing', () => {
    const { funds, host } = root(10 * R);
    expect(funds.tree).toBeNull();
    expect(funds.held()).toBeUndefined();
    expect(funds.path).toBe(ROOT_NODE);
    expect(host.openLog).not.toHaveBeenCalled();
  });

  it('refuses a carve that can never pass before it opens the log', async () => {
    const { funds, host, run } = root(10 * R);
    const refused = await funds.carve('a', { tokens: 10 * R + 1 });
    expect(refused).toEqual({ ok: false, refusal: { level: 0, field: 'limits.tokens', asked: String(10 * R + 1), there: String(10 * R) } });
    expect(host.openLog).not.toHaveBeenCalled();
    expect(run.requireChildSeat).not.toHaveBeenCalled();
  });

  it('carves from what it has left, and names the child on the task\'s seat only once it took', async () => {
    const { funds, run } = root(10 * R);
    const a = await carved(funds, 'a', 7 * R);
    expect(a.path).toBe('root/1');
    expect(run.held.get('a')).toBe(a.sessionId);
    expect(funds.held()).toMatchObject({ limit: 10 * R, left: 3 * R });

    const refused = await funds.carve('b', { tokens: 3 * R + 1 });
    expect(refused.ok).toBe(false);
    expect(run.held.get('b')).toBeUndefined();
  });

  it('carves a task with no seat nothing', async () => {
    const { funds } = root(10 * R);
    await expect(funds.carve('nowhere', { tokens: R })).rejects.toThrow('No seat for nowhere.');
    expect(funds.tree).toBeNull();
  });

  it('reads the user\'s limit afresh at each carve and in each tick', async () => {
    const { funds, setLimit } = root(5 * R);
    await carved(funds, 'a', 2 * R);
    setLimit(8 * R);
    expect(funds.held()).toMatchObject({ limit: 8 * R, left: 6 * R });
    setLimit(10 * R);
    expect((await carved(funds, 'b', 8 * R)).path).toBe('root/2');
  });

  it('carves a delegated task what it has left of its budget and every raise, closing what it left open', async () => {
    const { funds, run } = root(10 * R);
    const task = delegated('a', { budget: { tokens: 4 * R } });
    const first = await funds.carveFor(task);
    if (!first.ok) throw new Error('refused');
    first.budget.spent(used(R), { taskId: 'a', attempt: 1 });
    expect(await funds.raise('a', R)).toBeNull();

    // A Continue's child is the next one: the task's last is closed before the carve.
    run.held.set('a', undefined);
    const second = await funds.carveFor(task);
    expect(second.ok && second.budget.path).toBe('root/2');
    expect(funds.tree?.numbers('root/1')).toMatchObject({ spent: R });
    expect(second.ok && funds.tree?.numbers('root/2').limit).toBe(4 * R);
  });

  it('refuses a delegated task\'s child once its tokens or its time are spent', async () => {
    const { funds, run } = root(10 * R);
    const task = delegated('a', { budget: { tokens: R } });
    const first = await funds.carveFor(task);
    if (!first.ok) throw new Error('refused');
    first.budget.spent(used(R), { taskId: 'a', attempt: 1 });
    run.held.set('a', undefined);
    await expect(funds.carveFor(task)).rejects.toThrow(`Task "Task a" has spent its budget of ${R} tokens, so no child can start on it.`);

    const timed = delegated('b', { budget: { tokens: R, wallClockMs: 1000 }, attemptUsage: [{ attempt: 1, runner: 'claude-code', startedAt: '2026-10-11T17:00:00Z', wallTimeMs: 1000, totals: {} }] });
    await expect(funds.carveFor(timed)).rejects.toThrow('Task "Task b" has spent its time of 1000 ms, so no child can start on it.');
  });

  it('carves a delegated task the time it has left', async () => {
    const { funds } = root(10 * R);
    const task = delegated('a', { budget: { tokens: R, wallClockMs: 1000 }, attemptUsage: [{ attempt: 1, runner: 'claude-code', startedAt: '2026-10-11T17:00:00Z', wallTimeMs: 400, totals: {} }] });
    const given = await funds.carveFor(task);
    expect(given.ok && given.mandate.limits.wallClockMs).toBe(600);
  });

  it('raises a task\'s child from what it has left, and says why not when it cannot', async () => {
    const { funds } = root(5 * R);
    const a = await carved(funds, 'a', 3 * R);
    expect(await funds.raise('a', 3 * R)).toBe(`Level 0 refused this raise: it asks ${3 * R} tokens, and ${2 * R} are left.`);
    expect(await funds.raise('b', R)).toBe('That task has no child to raise.');
    expect(await funds.raise('a', R)).toBeNull();
    expect(funds.tree?.numbers(a.path).limit).toBe(4 * R);
  });

  it('takes back what a child did not spend when it closes', async () => {
    const { funds } = root(10 * R);
    const a = await carved(funds, 'a', 5 * R);
    a.spent(used(1000), { taskId: 'a', attempt: 1 });
    await funds.closeChild(a.sessionId);
    await funds.closeChild('no-such-child');
    expect(funds.tree?.numbers(ROOT_NODE)).toEqual({ limit: 10 * R, committed: 0, spent: 1000, reserve: 0 });
  });

  it('shows a delegated row\'s tokens: as stated before the log is read, then what the ledger says', async () => {
    const { funds, run } = root(10 * R);
    expect(funds.rowTokens(delegated('a'))).toBeUndefined();
    const task = delegated('a', { budget: { tokens: 2 * R } });
    expect(funds.rowTokens(task)).toEqual({ budget: 2 * R, left: 2 * R });
    expect(funds.rowTokens({ ...task, attempted: true })).toBeUndefined();

    const given = await funds.carveFor(task);
    if (!given.ok) throw new Error('refused');
    given.budget.spent(used(R), { taskId: 'a', attempt: 1 });
    await funds.raise('a', R);
    expect(funds.rowTokens(task)).toEqual({ budget: 3 * R, left: 2 * R });

    // Its child gone, what the task spent is read from every child it had.
    run.held.set('a', undefined);
    expect(funds.rowTokens(task)).toEqual({ budget: 3 * R, left: 2 * R });
    given.budget.spent(used(5 * R), { taskId: 'a', attempt: 1 });
    expect(funds.rowTokens(task)).toEqual({ budget: 3 * R, left: 0 });
  });

  it('lets its tree go with its session, writing what its children still spend first, and reopens it from the log', async () => {
    let stopChildren = () => {};
    const childrenStopped = vi.fn(() => new Promise<void>((resolve) => { stopChildren = resolve; }));
    const { funds, store } = root(10 * R, { childrenStopped });
    const a = await carved(funds, 'a', 2 * R);
    const tree = await funds.ledger();
    const shutdown = vi.spyOn(tree, 'shutdown');

    funds.letGo();
    expect(funds.tree).toBeNull();
    expect(childrenStopped).toHaveBeenCalledOnce();
    const reopening = funds.ledger();
    await flushMicrotasks();
    expect(shutdown).not.toHaveBeenCalled();
    stopChildren();

    const reopened = await reopening;
    expect(shutdown).toHaveBeenCalledOnce();
    expect(reopened).not.toBe(tree);
    expect(reopened.nodeOf(a.sessionId)?.path).toBe('root/1');
    expect(store.events.filter((event) => event.kind === 'node_opened' && event.node === ROOT_NODE)).toHaveLength(1);
  });

  it('opens the log afresh for a new session, and once for asks that overlap', async () => {
    let sessionId = 'first';
    const logs = new Map<string, FakeEventStore>();
    const openLog = vi.fn((id: string) => logs.get(id) ?? logs.set(id, new FakeEventStore()).get(id)!);
    const { funds } = root(10 * R, { sessionId: () => sessionId, openLog });
    const [one, two] = await Promise.all([funds.ledger(), funds.ledger()]);
    expect(one).toBe(two);
    sessionId = 'second';
    expect(await funds.ledger()).not.toBe(one);
    expect(openLog.mock.calls.map(([id]) => id)).toEqual(['first', 'second']);
  });

  it('opens again after an opening failed', async () => {
    const store = new FakeEventStore();
    let fails = true;
    const openLog = vi.fn(() => {
      if (fails) throw new Error('disk gone');
      return store;
    });
    const { funds } = root(10 * R, { openLog });
    await expect(funds.ledger()).rejects.toThrow('disk gone');
    fails = false;
    await expect(funds.ledger()).resolves.toBeInstanceOf(TreeLedger);
  });

  it('warns when the log refuses a write', async () => {
    const { funds, store, warnings } = root(10 * R);
    await funds.ledger();
    store.failing = new Error('disk full');
    await carved(funds, 'a', R);
    await funds.tree?.flushed().catch(() => undefined);
    await flushMicrotasks();
    expect(warnings).toEqual(['The tree\'s event log could not be written, so a restart would not know of its latest spending: disk full']);
  });

  it('is charged nothing, so a root\'s own turn and stop ask nothing of the ledger', async () => {
    // Through the interface, as its Session calls it: the root's no-ops take no arguments.
    const funds: NodeFunding = root(R).funds;
    await funds.ledger();
    funds.stop('why');
    funds.woken('anyone');
    funds.parked();
    funds.closeOwn();
    expect(funds.turnRefusal()).toBeNull();
    expect(funds.stoppedFor()).toBeNull();
    expect(funds.tree?.numbers(ROOT_NODE)).toEqual({ limit: R, committed: 0, spent: 0, reserve: 0 });
  });
});

describe('a child\'s funding (ADR-0056 M5)', () => {
  async function seated(limit: number, tokens: number) {
    const parent = root(limit);
    const given = await parent.funds.carve('a', { tokens });
    if (!given.ok) throw new Error(JSON.stringify(given.refusal));
    return { parent, budget: given.budget, ...child(given.budget, given.mandate) };
  }

  it('reads its parent\'s tree, which it never lets go of', async () => {
    const { parent, budget, funds } = await seated(10 * R, 4 * R);
    expect(funds.path).toBe(budget.path);
    expect(funds.tree).toBe(parent.funds.tree);
    await expect(funds.ledger()).resolves.toBe(parent.funds.tree);
    funds.letGo();
    expect(funds.tree).toBe(parent.funds.tree);
    expect(funds.held()).toMatchObject({ limit: 4 * R, left: 3 * R });
  });

  it('carves a grandchild from what it holds, and no further', async () => {
    const { funds, run } = await seated(10 * R, 3 * R);
    const refused = await funds.carve('a1', { tokens: 2 * R + 1 });
    expect(refused.ok).toBe(false);
    expect(run.held.get('a1')).toBeUndefined();
    const given = await carved(funds, 'a1', 2 * R);
    expect(given.path).toBe('root/1/1');
    expect(funds.tree?.numbers('root/1')).toEqual({ limit: 3 * R, committed: 2 * R, spent: 0, reserve: R });
  });

  it('carves past its saved mandate once a raise moved its limit', async () => {
    const { parent, funds } = await seated(10 * R, 2 * R);
    await parent.funds.raise('a', 5 * R);
    expect((await funds.carve('a1', { tokens: 5 * R })).ok).toBe(true);
  });

  it('tells its Session when its budget stops it and when a raise takes', async () => {
    const { parent, budget, funds, host } = await seated(10 * R, 2 * R);
    funds.stop('Out.');
    await flushMicrotasks();
    expect(host.stopped).toHaveBeenCalledWith('Out.');
    expect(funds.stoppedFor()).toBe('Out.');
    expect(budget.stoppedFor()).toBe('Out.');
    await parent.funds.raise('a', R);
    expect(host.raised).toHaveBeenCalledOnce();
    expect(funds.stoppedFor()).toBeNull();
  });

  it('asks its budget whether its turn may start, and keeps a session\'s reserve when it parks', async () => {
    const short = await seated(10 * R, R);
    short.budget.turnSpent(used(R / 2));
    expect(short.funds.turnRefusal()).toMatch(/^Level 1 refused this turn/);

    const { budget, funds } = await seated(10 * R, 3 * R);
    budget.turnSpent(used(R / 2));
    expect(funds.turnRefusal()).toBeNull();
    expect(funds.tree?.numbers(budget.path).reserve).toBe(R / 2);
    funds.parked();
    expect(funds.tree?.numbers(budget.path).reserve).toBe(R);
  });

  it('has the child that woke its turn pay first for it', async () => {
    const { budget, funds } = await seated(10 * R, 6 * R);
    const first = await carved(funds, 'a1', 2 * R);
    const woke = await carved(funds, 'a2', 2 * R);
    funds.woken(woke.sessionId);
    funds.woken('no-such-child');
    budget.turnSpent(used(3 * R));
    expect(funds.tree?.numbers(woke.path).limit).toBe(R);
    expect(funds.tree?.numbers(first.path).limit).toBe(2 * R);
  });

  it('gives back what it did not spend when it closes itself', async () => {
    const { parent, budget, funds } = await seated(10 * R, 4 * R);
    budget.spent(used(R), { taskId: 'x', attempt: 1 });
    funds.closeOwn();
    expect(parent.funds.held()).toMatchObject({ left: 9 * R });
  });

  it('holds nothing when it was seated before any carve', async () => {
    const { funds } = child(undefined);
    expect(funds.path).toBe(ROOT_NODE);
    expect(funds.tree).toBeNull();
    expect(funds.held()).toBeUndefined();
    await expect(funds.ledger()).rejects.toThrow('This child holds no budget, so it has no tree to read.');
    funds.stop('why');
    funds.woken('anyone');
    funds.parked();
    funds.closeOwn();
    expect(funds.turnRefusal()).toBeNull();
    expect(funds.stoppedFor()).toBeNull();
    expect(funds.rowTokens(delegated('a1', { budget: { tokens: R } }))).toEqual({ budget: R, left: R });
  });
});
