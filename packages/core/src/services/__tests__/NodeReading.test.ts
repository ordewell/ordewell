import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { ROOT_NODE } from '../../models/TreeEvent';
import type { UsageRecord } from '../../models/Usage';
import { FakeEventStore } from '../../testing';
import { saveChildSession } from '../../utils/sessionStore';
import { rootMandate, type Mandate } from '../Mandate';
import { ChildFunding, RootFunding, type NodeFunding } from '../NodeFunding';
import { ChildReading, RootReading, type ReadingHost } from '../NodeReading';
import { SESSION_RESERVE_TOKENS as R, type NodeBudget } from '../TreeLedger';

/**
 * A node's reading on a real ledger, log and session files, with its Session
 * faked as the narrow host it reads: its funding, its plan and its seats.
 */

const delegating = (tokens: number): Mandate => rootMandate({ level: 'act', autorun: true, autonomous: true, delegationTokens: tokens, runners: ['claude-code'], models: {} });
const used = (tokens: number): UsageRecord => ({ source: 'claude-code', inputTokens: tokens });
/** `createTask` keeps no runner session, which is what names the child a delegated task stands for. */
const task = (id: string, over: Partial<Task> = {}): Task => ({ ...createTask({ id, order: 1, title: `Task ${id}`, prompt: `do ${id}`, ...over }), ...over });
const delegated = (id: string, over: Partial<Task> = {}): Task => task(id, { type: 'delegated', ...over });
const planOf = (tasks: Task[]): LegacyPlanState => ({ tasks, runners: ['claude-code'], status: 'approved', generatedAt: '2026-01-01T00:00:00.000Z', lastUpdated: '2026-01-01T00:00:00.000Z' });

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'node-reading-'));
  dirs.push(dir);
  return dir;
}

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
  };
}

type Run = ReturnType<typeof seats>;

/** What every reading reads of its Session, around the funding and the plan a test hands it. */
function readingHost(funds: NodeFunding, run: Run, tasks: Task[], baseDir: string, over: Partial<ReadingHost>): ReadingHost {
  return {
    funds,
    delegationOffered: true,
    tasks: () => tasks,
    logs: { attempts: () => [], events: () => [] },
    stateRoot: () => baseDir,
    workspaceRoot: () => baseDir,
    git: { branch: () => undefined, blob: () => Promise.resolve(undefined) },
    childSession: (taskId) => run.childSession(taskId),
    addressed: vi.fn(() => Promise.resolve()),
    ...over,
  };
}

function root(tasks: Task[], over: Partial<ReadingHost> = {}) {
  const store = new FakeEventStore();
  const run = seats('a', 'b');
  const openLog = vi.fn(() => store);
  const funds = new RootFunding({
    mandate: () => delegating(10 * R),
    level: 0,
    seats: () => run,
    planHas: (taskId) => run.held.has(taskId),
    sessionId: () => 'root-session',
    openLog,
    limit: () => 10 * R,
    warn: () => undefined,
    childrenStopped: () => Promise.resolve(),
  });
  const baseDir = stateDir();
  const host = readingHost(funds, run, tasks, baseDir, over);
  return { reading: new RootReading({ ...host, sessionId: () => 'root-session' }), funds, host, tasks, openLog, run, baseDir };
}

async function carved(funds: NodeFunding, taskId: string, tokens: number): Promise<NodeBudget> {
  const given = await funds.carve(taskId, { tokens });
  if (!given.ok) throw new Error(JSON.stringify(given.refusal));
  return given.budget;
}

/** A child seated in the root's task `a`, as its parent's carve left it. */
async function child(tasks: Task[], over: Partial<ReadingHost> = {}) {
  const parent = root([delegated('a')]);
  const given = await parent.funds.carve('a', { tokens: 4 * R });
  if (!given.ok) throw new Error(JSON.stringify(given.refusal));
  const { budget, mandate } = given;
  parent.tasks.splice(0, 1, delegated('a', { runnerSessionId: budget.sessionId }));
  const run = seats('a1', 'a2');
  const funds = new ChildFunding({
    mandate: () => mandate,
    level: 1,
    seats: () => run,
    planHas: (taskId) => run.held.has(taskId),
    budget,
    stopped: vi.fn(),
    raised: vi.fn(),
  });
  const host = readingHost(funds, run, tasks, parent.baseDir, over);
  return { reading: new ChildReading({ ...host, rootSessionId: 'root-session' }), funds, host, tasks, budget, parent, run };
}

function budgetless(tasks: Task[], over: Partial<ReadingHost> = {}) {
  const run = seats('a1');
  const funds = new ChildFunding({
    mandate: () => delegating(0),
    level: 1,
    seats: () => run,
    planHas: (taskId) => run.held.has(taskId),
    budget: undefined,
    stopped: vi.fn(),
    raised: vi.fn(),
  });
  const host = readingHost(funds, run, tasks, stateDir(), over);
  return { reading: new ChildReading({ ...host, rootSessionId: 'root-session' }), host };
}

describe('a root\'s reading (ADR-0057 R8, ADR-0058 S3)', () => {
  it('holds no board and opens no log for a flat plan', async () => {
    const { reading, openLog, host } = root([task('t1')]);
    await expect(reading.board()).resolves.toBeNull();
    await expect(reading.subtree()).resolves.toBeNull();
    expect(reading.landed(host.tasks()[0])).toBeUndefined();
    await expect(reading.post({ type: 'pin', title: 'Use tabs' })).resolves.toMatchObject({ isError: true, text: expect.stringContaining('no board') });
    expect(openLog).not.toHaveBeenCalled();
    expect(host.addressed).not.toHaveBeenCalled();
  });

  it('holds no board with delegation off, and still reads what a delegated task put below it', async () => {
    const { reading, openLog, host } = root([delegated('a')], { delegationOffered: false });
    await expect(reading.board()).resolves.toBeNull();
    expect(reading.landed(host.tasks()[0])).toBeUndefined();
    await expect(reading.subtree()).resolves.not.toBeNull();
    expect(openLog).toHaveBeenCalledTimes(1);
  });

  it('gains a board at the root with its first delegated task, and reads back what was posted on it', async () => {
    const { reading } = root([delegated('a')]);
    const board = await reading.board();
    expect(board).not.toBeNull();
    await expect(reading.post({ type: 'pin', title: 'Use tabs' })).resolves.toMatchObject({ text: expect.stringContaining(`board:${ROOT_NODE}:E1`) });
    expect((await reading.read({ task: 'board' })).text).toContain('Use tabs');
    expect((await reading.board())?.pins().join('\n')).toContain('Use tabs');
  });

  it('reads a task of its own plan, which is no board reference', async () => {
    const { reading } = root([task('t1', { title: 'Write the parser' })]);
    expect((await reading.read({ task: 't1' })).text).toContain('Write the parser');
  });

  it('reads the plan a child saved under the root\'s session, afresh each time', async () => {
    const { reading, funds, tasks, baseDir } = root([delegated('a')]);
    const budget = await carved(funds, 'a', 4 * R);
    tasks.splice(0, 1, delegated('a', { runnerSessionId: budget.sessionId }));
    const before = await reading.subtree();
    expect(before?.plans()).toEqual([]);
    saveChildSession(planOf([task('c1', { title: 'Child work' })]), 'child goal', { baseDir, rootSessionId: 'root-session', sessionId: budget.sessionId });
    expect(before?.planAt(budget.path)?.tasks.map((t) => t.title)).toEqual(['Child work']);
    expect((await reading.subtree())?.plans().map((plan) => plan.node)).toEqual([budget.path]);
  });

  it('raises a landed child\'s contracts for what its task provides, then gives the running tasks their lines', async () => {
    const { reading, funds, host } = root([delegated('a', { scope: { provides: ['users-api'] } })]);
    const budget = await carved(funds, 'a', 4 * R);
    const tree = funds.tree;
    if (!tree) throw new Error('The carve opened no tree.');
    tree.post(budget.path, { type: 'contract', title: 'GET /users answers a list', key: 'users-api', value: 'v2', by: { node: budget.path } });
    tree.post(budget.path, { type: 'contract', title: 'Not provided', key: 'other', value: 'v1', by: { node: budget.path } });
    const landing = host.tasks()[0];
    await reading.landed(landing);
    const map = (await reading.read({ task: 'board' })).text;
    expect(map).toContain('GET /users answers a list');
    expect(map).not.toContain('Not provided');
    expect(host.addressed).toHaveBeenCalledWith(landing);
  });

  it('gives the running tasks their lines without raising anything when the task provides nothing', async () => {
    const { reading, funds, host } = root([delegated('a')]);
    await carved(funds, 'a', 4 * R);
    await reading.landed(host.tasks()[0]);
    expect(host.addressed).toHaveBeenCalledTimes(1);
    expect((await reading.read({ task: 'board' })).text).toContain('nothing on it yet');
  });

  it('costs a warning, never the landing, when what a landing owes fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { reading, host } = root([delegated('a')], { addressed: () => Promise.reject(new Error('scope lines broke')) });
    await expect(reading.landed(host.tasks()[0])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('scope lines broke'));
  });

  it('reads as having no board when its log cannot be opened', async () => {
    const { reading, funds } = root([delegated('a')]);
    vi.spyOn(funds, 'ledger').mockRejectedValue(new Error('log locked'));
    await expect(reading.board()).resolves.toBeNull();
    await expect(reading.subtree()).resolves.toBeNull();
    await expect(reading.post({ type: 'pin', title: 'Use tabs' })).resolves.toMatchObject({ isError: true });
  });
});

describe('a child\'s reading (ADR-0057 R8, R10)', () => {
  it('holds a board at its own path with nothing delegated, and reads its root\'s pins on it', async () => {
    const { reading, budget, parent } = await child([task('c1')]);
    await parent.reading.post({ type: 'pin', title: 'Use tabs' });
    await expect(reading.post({ type: 'pin', title: 'Mine' })).resolves.toMatchObject({ text: expect.stringContaining(`board:${budget.path}:E1`) });
    const pins = (await reading.board())?.pins().join('\n') ?? '';
    expect(pins).toContain('Use tabs');
    expect(pins).toContain('Mine');
  });

  it('reads a grandchild\'s plan under its root\'s session, never opening a log of its own', async () => {
    const { reading, funds, tasks, parent } = await child([delegated('a1')]);
    const grand = await carved(funds, 'a1', 2 * R);
    tasks.splice(0, 1, delegated('a1', { runnerSessionId: grand.sessionId }));
    saveChildSession(planOf([task('g1', { title: 'Grandchild work' })]), 'grand goal', { baseDir: parent.baseDir, rootSessionId: 'root-session', sessionId: grand.sessionId });
    const below = await reading.subtree();
    expect(below?.plans().map((plan) => plan.node)).toEqual([grand.path]);
    expect(parent.openLog).toHaveBeenCalledTimes(1);
  });

  it('reports at its own path, with what its task has spent', async () => {
    const { reading, budget, funds } = await child([task('c1', { status: 'completed' })]);
    budget.spent(used(3000), { taskId: 'c1', attempt: 1 });
    const taken = reading.report({ status: 'done', summary: 'Done.' });
    if (!taken.ok) throw new Error(taken.refusal);
    expect(taken.handoff.subtree).toMatchObject({ node: budget.path, counts: { done: 1, tokens: funds.tree?.taskSpent(budget.path) } });
    expect(taken.handoff.subtree?.counts.tokens).toBeGreaterThan(0);
  });

  it('passes a report\'s refusal back as it is', async () => {
    const { reading } = await child([task('c1')]);
    const taken = reading.report({ status: 'done', summary: 'Done.', open: ['#9/F1'] });
    expect(taken.ok).toBe(false);
  });
});

describe('a child no carve gave a budget', () => {
  it('reads no board and nothing below, and reports at the root with nothing spent', async () => {
    const { reading } = budgetless([task('c1')]);
    await expect(reading.board()).resolves.toBeNull();
    await expect(reading.subtree()).resolves.toBeNull();
    const taken = reading.report({ status: 'done', summary: 'Done.' });
    if (!taken.ok) throw new Error(taken.refusal);
    expect(taken.handoff.subtree).toMatchObject({ node: ROOT_NODE, counts: { tokens: 0 } });
  });

  it('still owes a delegated task\'s landing its lines, with no board to raise onto', async () => {
    const { reading, host } = budgetless([delegated('a1', { scope: { provides: ['users-api'] }, runnerSessionId: 'grand' })]);
    await expect(reading.board()).resolves.toBeNull();
    await reading.landed(host.tasks()[0]);
    expect(host.addressed).toHaveBeenCalledTimes(1);
  });
});
