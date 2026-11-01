import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegacyPlanState, Task } from '../../models/Task';
import { ROOT_NODE } from '../../models/TreeEvent';
import type { UsageRecord } from '../../models/Usage';
import { spentTokens, taskUsageSummary } from '../../models/Usage';
import { FakeEventStore, FakeRunnerSession, FakeWorktreeIsolation } from '../../testing';
import type { ChildPlacement, Session, SessionDeps } from '../createSession';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '../SettingsService';
import { foldTree, SESSION_RESERVE_TOKENS as R, type NodeBudget } from '../TreeLedger';
import { fakeConfig, fakeFs, makeSession, memoryTaskLogs, sealingFs, taskOf } from './sessionTestKit';
import { heldPlanner, NOW, plan, prose, recordingRunner, settled, task, until } from './supervisorTestKit';

/**
 * The budget ledger on real Sessions (ADR-0056 M5), side by side as
 * `Session.hostChild` seats them. Only the runners, the planner and git are
 * faked, and every spend comes through the usage a runner reports.
 */

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

interface Node {
  session: Session;
  planner: ReturnType<typeof heldPlanner>;
  run: ReturnType<typeof recordingRunner>;
  notices: string[];
  budget: NodeBudget;
}

const used = (tokens: number, over: Partial<UsageRecord> = {}): UsageRecord => ({ source: 'claude-code', inputTokens: tokens, ...over });
const report = (node: Node, taskId: string, record: UsageRecord) => node.run.of(taskId).emitEvent({ type: 'usage', record });
const run = (node: Node) => node.session.execute({ command: 'run_plan' }, { kind: 'user' });
const started = (node: Node) => node.run.spawnedIds();
const pass = async (node: Node, taskId: string) => {
  node.run.of(taskId).reportComplete({ status: 'done', summary: 'Done.' });
  await settled();
};

async function tree(tokens: number, seats: readonly string[], settingsOf: Partial<GlobalRunSettings> = {}, store = new FakeEventStore()) {
  const rootNotices: string[] = [];
  const say = (message: string) => { rootNotices.push(message); };
  const config = fakeConfig({ maxParallelSessions: 8, worktreeIsolation: true, conflictRepairAttempts: 1 });
  const isolation = new FakeWorktreeIsolation();
  const settings = () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' as const, delegationTokens: tokens, ...settingsOf } });
  const rootRun = recordingRunner();
  const open = vi.fn(() => store);
  const root = makeSession({ config, isolation, runner: rootRun.runner, aiService: heldPlanner().aiService, settings, workspaceRoot: () => '/repo', sessionId: 'root', eventLog: open, notifications: { info: say, warn: say, error: say, confirm: vi.fn().mockResolvedValue(undefined) } });
  root.loadPlan(plan(seats.map((id, i) => task(id, i + 1))), 'the root goal', '/repo');
  await root.execute({ command: 'run_plan' }, { kind: 'user' });
  await until(() => seats.every((id) => rootRun.spawnedIds().includes(id)));
  for (const id of seats) await root.execute({ command: 'stop_task', task: id }, { kind: 'user' });
  await settled();

  const child = async (name: string, carved: number, tasks: Task[], deps: Partial<SessionDeps> = {}): Promise<Node> => {
    const given = await root.carveChild(name, { tokens: carved });
    if (!given.ok) throw new Error(JSON.stringify(given.refusal));
    const seat: ChildPlacement = root.hostChild(name);
    const planner = heldPlanner();
    const childRun = recordingRunner();
    const notices: string[] = [];
    const tell = (message: string) => { notices.push(message); };
    const codeRoot = `/repo/.ordewell/worktrees/run1/${name}`;
    const session = makeSession({
      config, runner: childRun.runner, aiService: planner.aiService, settings,
      workspaceRoot: () => codeRoot,
      placement: seat,
      child: { depth: 1, mandate: () => given.mandate },
      saveSession: vi.fn(),
      openTaskLog: memoryTaskLogs(),
      notifications: { info: tell, warn: tell, error: tell, confirm: vi.fn().mockResolvedValue(undefined) },
      ...deps,
    });
    session.loadPlan(plan(tasks) as LegacyPlanState, `the goal of ${name}`, codeRoot);
    return { session, planner, run: childRun, notices, budget: given.budget };
  };
  return { root, rootRun, child, store, open, settings, rootNotices };
}

/** A child's script as it lands without `effect`: sealed (ADR-0056 M9). */
const sealedScript = () => task('a1', 1, { type: 'script', script: 'echo hi', readOnly: true, assignedRunner: undefined });
const seals = () => ({ fsAdapter: { ...fakeFs(), ...sealingFs() } });

describe('a child\'s claim (ADR-0056 M5)', () => {
  it('takes what room there is, and starts the rest as the sessions before it free theirs', async () => {
    const { child } = await tree(10 * R, ['a']);
    const a = await child('a', 3 * R, [task('a1', 1), task('a2', 2), task('a3', 3)]);
    await run(a);
    await until(() => started(a).length === 2);
    await settled();

    expect(started(a)).toEqual(['a1', 'a2']);
    expect(taskOf(a.session, 'a3')!.status).not.toBe('in_progress');

    await pass(a, 'a1');
    await until(() => started(a).includes('a3'));
  });

  it('answers an explicit start with the refusal', async () => {
    const { child } = await tree(10 * R, ['a']);
    const a = await child('a', 2 * R, [task('a1', 1), task('a2', 2, { approved: true } as Partial<Task>)]);
    await run(a);
    await until(() => started(a).includes('a1'));
    const refused = await a.session.execute({ command: 'run_task', task: 'a2' }, { kind: 'user' }).catch((err: Error) => err.message);
    expect(String(JSON.stringify(refused))).toContain(`a session here needs ${R} tokens to start`);
    await settled();
    expect(started(a)).toEqual(['a1']);
  });

  it('takes nothing for a script, which spends no tokens', async () => {
    const { child } = await tree(10 * R, ['a']);
    const scripted = vi.fn();
    const a = await child('a', R, [sealedScript()], {
      ...seals(),
      scriptRunner: { spawn: scripted.mockImplementation(async ({ taskId }: { taskId: string }) => new FakeRunnerSession('s1', taskId)), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 },
    });
    expect(a.budget.refusal()).not.toBeNull();
    await run(a);
    await until(() => scripted.mock.calls.length === 1);
  });

  it('holds no allowance for a script while it runs', async () => {
    const { root, child } = await tree(10 * R, ['a']);
    const scripted = vi.fn(async ({ taskId }: { taskId: string }) => new FakeRunnerSession('s1', taskId));
    const a = await child('a', 3 * R, [sealedScript()], {
      ...seals(),
      scriptRunner: { spawn: scripted, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 },
    });
    await run(a);
    await until(() => scripted.mock.calls.length === 1);
    const ledger = await root.ledger();
    expect(ledger.numbers(a.budget.path).reserve).toBe(R);
    expect(ledger.left(a.budget.path)).toBe(2 * R);
  });

  it('has no budget at the root: its own tasks are charged nothing', async () => {
    const { root, rootRun, child } = await tree(10 * R, ['a', 'b']);
    await child('a', R, []);
    await root.execute({ command: 'run_task', task: 'b' }, { kind: 'user' });
    await until(() => rootRun.spawnedIds().filter((id) => id === 'b').length === 2);
    rootRun.of('b').emitEvent({ type: 'usage', record: used(50 * R) });
    await settled();
    expect((await root.ledger()).numbers(ROOT_NODE)).toEqual({ limit: 10 * R, committed: R, spent: 0, reserve: 0 });
  });
});

describe('spending (ADR-0056 M5)', () => {
  it('reads the number a surface shows, from the usage the runner reports', async () => {
    const { root, child } = await tree(10 * R, ['a']);
    const a = await child('a', 5 * R, [task('a1', 1)]);
    await run(a);
    await until(() => started(a).includes('a1'));
    report(a, 'a1', used(1000, { cachedInputTokens: 900 }));
    report(a, 'a1', used(0, { inputTokens: undefined, outputTokens: 50, aggregate: true }));
    report(a, 'a1', used(200, { subagentId: 'sub' }));
    report(a, 'a1', { source: 'claude-code', compacted: true, contextTokens: 40_000 });

    const ledger = await root.ledger();
    const shown = spentTokens(taskUsageSummary(taskOf(a.session, 'a1')!).totals);
    expect(shown).toBe(1250);
    expect(ledger.numbers(a.budget.path).spent).toBe(shown);
  });

  it('counts what a stopped runner reports as it winds down', async () => {
    const { root, child } = await tree(10 * R, ['a']);
    const a = await child('a', 5 * R, [task('a1', 1)]);
    await run(a);
    await until(() => started(a).includes('a1'));
    const session = a.run.of('a1');
    await a.session.execute({ command: 'stop_task', task: 'a1' }, { kind: 'user' });
    session.emitEvent({ type: 'usage', record: used(300) });
    expect((await root.ledger()).numbers(a.budget.path).spent).toBe(300);
  });

  it('gives a slot\'s allowance back as its attempt ends', async () => {
    const { root, child } = await tree(10 * R, ['a']);
    const a = await child('a', 5 * R, [task('a1', 1)]);
    await run(a);
    await until(() => started(a).includes('a1'));
    const ledger = await root.ledger();
    expect(ledger.numbers(a.budget.path).reserve).toBe(2 * R);
    await pass(a, 'a1');
    expect(ledger.numbers(a.budget.path).reserve).toBe(R);
  });

  it('stops the node at its limit, which ends what runs there and starts nothing more', async () => {
    const { child } = await tree(10 * R, ['a']);
    const a = await child('a', 3 * R, [task('a1', 1), task('a2', 2), task('a3', 3)]);
    await run(a);
    await until(() => started(a).length === 2);
    expect(a.session.outOfBudget).toBeNull();

    report(a, 'a1', used(3 * R));
    await settled();

    expect(a.session.outOfBudget).toBe(`Level 1 is out of budget: it has spent ${3 * R} of its ${3 * R} tokens, and nothing it holds is left to spend.`);
    expect(a.notices.join('\n')).toContain('Level 1 is out of budget');
    expect(a.run.runner.stop.mock.calls.flat()).toEqual([a.run.of('a1').id, a.run.of('a2').id]);
    expect(started(a)).toEqual(['a1', 'a2']);
  });
});

describe('a start the budget refuses with nothing live', () => {
  it('stops the node and says why: nothing would tick it again, and the run must not hang', async () => {
    const { child } = await tree(10 * R, ['a']);
    const a = await child('a', R + 5, [task('a1', 1)]);
    await run(a);
    await settled();

    expect(started(a)).toEqual([]);
    expect(a.session.outOfBudget).toBe(`Level 1 refused this start: a session here needs ${R} tokens to start, and 5 of its ${R + 5} are left.`);
    expect(a.notices.join('\n')).toContain('Level 1 refused this start');
  });

  it('does not stop for a script that finished the plan: nothing it left needs tokens', async () => {
    const { child } = await tree(10 * R, ['a']);
    const scripted = vi.fn(async ({ taskId }: { taskId: string }) => new FakeRunnerSession('s1', taskId));
    const scriptRunner = { spawn: scripted, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
    const a = await child('a', R, [sealedScript()], { ...seals(), scriptRunner });
    await run(a);
    await until(() => scripted.mock.calls.length === 1);
    await settled();
    expect(a.session.outOfBudget).toBeNull();
  });

  it('does not stop for a script whose start failed: what is left of the plan needs no tokens', async () => {
    const { child } = await tree(10 * R, ['a']);
    const scripted = vi.fn(async (): Promise<FakeRunnerSession> => { throw new Error('no shell here'); });
    const a = await child('a', R, [sealedScript()], {
      ...seals(),
      scriptRunner: { spawn: scripted, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 },
    });
    expect(a.budget.refusal()).not.toBeNull();
    await run(a);
    await until(() => scripted.mock.calls.length === 1);
    await settled();
    expect(a.session.outOfBudget).toBeNull();
  });

  it('does not stop for a start that only has to wait for a live session to end', async () => {
    const { child } = await tree(10 * R, ['a']);
    const a = await child('a', 2 * R, [task('a1', 1), task('a2', 2)]);
    await run(a);
    await until(() => started(a).includes('a1'));
    await settled();
    expect(a.session.outOfBudget).toBeNull();
    await pass(a, 'a1');
    await until(() => started(a).includes('a2'));
    expect(a.session.outOfBudget).toBeNull();
  });

  it('goes on after a raise: the reason goes with it and a new run starts what it refused', async () => {
    const { root, child } = await tree(10 * R, ['a']);
    const a = await child('a', R + 5, [task('a1', 1)]);
    await run(a);
    await settled();
    expect(a.session.outOfBudget).not.toBeNull();

    expect(await root.raiseChild('a', R)).toBeNull();
    expect(a.session.outOfBudget).toBeNull();
    await run(a);
    await until(() => started(a).includes('a1'));
  });

  it('says it again if it runs out again after that', async () => {
    const { root, child } = await tree(10 * R, ['a']);
    const a = await child('a', R + 5, [task('a1', 1)]);
    await run(a);
    await settled();
    await root.raiseChild('a', R);
    await run(a);
    await until(() => started(a).includes('a1'));
    report(a, 'a1', used(2 * R + 5));
    await settled();
    expect(a.session.outOfBudget).toContain('Level 1 is out of budget');
    expect(a.notices.filter((n) => n.startsWith('Level 1')).length).toBe(2);
  });
});

describe('a tree under concurrent claims', () => {
  it('cannot spend past its budget: siblings starting at once are held to what each was carved', async () => {
    const { root, child } = await tree(6 * R, ['a', 'b']);
    const tasks = (name: string) => [1, 2, 3, 4, 5].map((n) => task(`${name}${n}`, n));
    const a = await child('a', 3 * R, tasks('a'));
    const b = await child('b', 3 * R, tasks('b'));

    await Promise.all([run(a), run(b)]);
    await settled();

    // Each child keeps one session for its turn, so each has room for two.
    expect(started(a).length).toBe(2);
    expect(started(b).length).toBe(2);

    // Every live session spends what it was allowed: the whole of the room, and the node's turn untouched.
    for (const node of [a, b]) for (const id of started(node)) report(node, id, used(R));
    const ledger = await root.ledger();
    await settled();
    const spent = ledger.numbers(a.budget.path).spent + ledger.numbers(b.budget.path).spent;
    expect(spent).toBeLessThanOrEqual(6 * R);
    expect(ledger.numbers(ROOT_NODE).limit).toBe(6 * R);
    expect((await root.carveChild('a', { tokens: 1 })).ok).toBe(false);
  });
});

describe('a subplanner\'s turn (ADR-0056 M5)', () => {
  const progressOf = (node: Node) => node.planner.calls.at(-1)!.progress!;
  const say = (node: Node, text: string) => node.planner.calls.at(-1)!.finish(prose(text));

  it('spends what it kept first, and keeps it again as it parks', async () => {
    const { root, child } = await tree(10 * R, ['a']);
    const a = await child('a', 5 * R, []);
    const ledger = await root.ledger();
    void a.session.continueConversation('hello').catch(() => undefined);
    await until(() => a.planner.calls.length === 1);

    progressOf(a)({ type: 'usage', record: used(R + 1000) });
    expect(ledger.numbers(a.budget.path)).toEqual({ limit: 5 * R, committed: 0, spent: R + 1000, reserve: 0 });
    expect(ledger.left(a.budget.path)).toBe(4 * R - 1000);

    say(a, 'Done.');
    await settled();

    expect(ledger.numbers(a.budget.path)).toEqual({ limit: 5 * R, committed: 0, spent: R + 1000, reserve: R });
  });

  it('is not started when nothing can cover it, and the node stops', async () => {
    const { child } = await tree(10 * R, ['a']);
    const a = await child('a', 2 * R, [task('a1', 1)]);
    await run(a);
    await until(() => started(a).includes('a1'));
    report(a, 'a1', used(2 * R - 1));
    await settled();
    expect(a.session.outOfBudget).toBeNull();

    await expect(a.session.continueConversation('hello')).rejects.toThrow(`a turn here needs ${R} tokens to start`);
    await settled();

    expect(a.planner.calls).toEqual([]);
    expect(a.session.outOfBudget).toContain(`a turn here needs ${R} tokens to start`);
    expect(a.run.runner.stop.mock.calls.flat()).toEqual([a.run.of('a1').id]);
  });

  it('charges the root\'s turns nothing', async () => {
    const { root, child } = await tree(10 * R, ['a']);
    await child('a', R, []);
    expect(root.mandate().limits.tokens).toBe(10 * R);
    expect((await root.ledger()).numbers(ROOT_NODE).spent).toBe(0);
  });
});

describe('what the parent does', () => {
  it('reads what it has left from the ledger: a second child cannot be carved from the first one\'s', async () => {
    const { root, child } = await tree(5 * R, ['a', 'b']);
    await child('a', 3 * R, []);
    expect(await root.carveChild('b', { tokens: 3 * R })).toEqual({
      ok: false, refusal: { level: 0, field: 'limits.tokens', asked: String(3 * R), there: String(2 * R) },
    });
    expect((await root.carveChild('b', { tokens: 2 * R })).ok).toBe(true);
  });

  it('applies a raise from what it has left, which its child\'s next start reads', async () => {
    const { root, child } = await tree(10 * R, ['a']);
    const a = await child('a', 2 * R, [task('a1', 1), task('a2', 2)]);
    await run(a);
    await until(() => started(a).includes('a1'));
    await settled();
    expect(started(a)).toEqual(['a1']);

    expect(await root.raiseChild('a', R)).toBeNull();
    await a.session.execute({ command: 'run_plan' }, { kind: 'user' }).catch(() => undefined);
    await settled();

    expect(started(a)).toEqual(['a1', 'a2']);
    expect((await root.ledger()).numbers(a.budget.path).limit).toBe(3 * R);
  });

  it('says why a raise did not take, and for a task with no child that it has none', async () => {
    const { root, child } = await tree(5 * R, ['a', 'b']);
    await child('a', 3 * R, []);
    expect(await root.raiseChild('a', 3 * R)).toBe(`Level 0 refused this raise: it asks ${3 * R} tokens, and ${2 * R} are left.`);
    expect(await root.raiseChild('b', R)).toBe('That task has no child to raise.');
  });

  it('takes back what a child did not spend on confirmed close', async () => {
    const { root, child } = await tree(10 * R, ['a']);
    const a = await child('a', 5 * R, [task('a1', 1)]);
    await run(a);
    await until(() => started(a).includes('a1'));
    report(a, 'a1', used(1000));
    await root.closeChild('a');

    expect((await root.ledger()).numbers(ROOT_NODE)).toEqual({ limit: 10 * R, committed: 0, spent: 1000, reserve: 0 });
  });

  it('has a grandchild carved from a child, and no further than it', async () => {
    const { root, child } = await tree(10 * R, ['a']);
    const a = await child('a', 3 * R, [task('a1', 1)]);
    await run(a);
    await until(() => started(a).includes('a1'));
    await a.session.execute({ command: 'stop_task', task: 'a1' }, { kind: 'user' });
    await settled();

    expect((await a.session.carveChild('a1', { tokens: 2 * R + 1 })).ok).toBe(false);
    const carved = await a.session.carveChild('a1', { tokens: 2 * R });

    expect(carved.ok && carved.budget.path).toBe('root/1/1');
    expect(a.session.hostChild('a1').budget?.path).toBe('root/1/1');
    expect((await root.ledger()).numbers(a.budget.path)).toEqual({ limit: 3 * R, committed: 2 * R, spent: 0, reserve: R });
  });

  it('carves a raised child\'s new budget, which only the ledger knows: its saved mandate holds what it was first given', async () => {
    const { root, child } = await tree(10 * R, ['a']);
    const a = await child('a', 2 * R, [task('a1', 1)]);
    await run(a);
    await until(() => started(a).includes('a1'));
    await a.session.execute({ command: 'stop_task', task: 'a1' }, { kind: 'user' });
    await settled();
    await root.raiseChild('a', 5 * R);
    expect((await a.session.carveChild('a1', { tokens: 5 * R })).ok).toBe(true);
  });

  it('reads the user\'s budget as it stands at each carve', async () => {
    let budget = 3 * R;
    const { root, child, settings } = await tree(0, ['a', 'b'], { get delegationTokens() { return budget; } });
    await child('a', 3 * R, []);
    expect(settings().run.delegationTokens).toBe(3 * R);
    budget = 5 * R;
    root.applyRunSettings({ delegationTokens: budget });
    expect((await root.carveChild('b', { tokens: 2 * R })).ok).toBe(true);
    expect((await root.ledger()).numbers(ROOT_NODE)).toEqual({ limit: 5 * R, committed: 5 * R, spent: 0, reserve: 0 });
  });

  it('refuses a carve with delegation off and opens no log for it', async () => {
    const { root, open } = await tree(0, ['a']);
    const carved = await root.carveChild('a', { tokens: 10 });
    expect(carved.ok).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('tells the user once when the log refuses a write', async () => {
    const store = new FakeEventStore();
    const { root, child, rootNotices } = await tree(10 * R, ['a'], {}, store);
    const a = await child('a', 5 * R, [task('a1', 1)]);
    const ledger = await root.ledger();
    await ledger.flushed();
    store.failing = new Error('disk full');
    a.budget.spent(used(1), { taskId: 'a1', attempt: 1 });
    await ledger.flushed();
    a.budget.spent(used(1), { taskId: 'a1', attempt: 1 });
    await ledger.flushed();
    expect(rootNotices.filter((n) => n.includes('event log'))).toEqual(['The tree\'s event log could not be written, so a restart would not know of its latest spending: disk full']);
  });
});

describe('a restart (ADR-0058 S3)', () => {
  it('lets the log go with the root, having landed all that was decided', async () => {
    const { root, child, store } = await tree(10 * R, ['a']);
    const a = await child('a', 5 * R, []);
    a.budget.spent(used(7), { taskId: 'a1', attempt: 1 });
    const closing = vi.spyOn(store, 'close');
    root.destroy();
    await settled();
    expect(closing).toHaveBeenCalledTimes(1);
    expect(foldTree(store.events).get(a.budget.path)?.spent).toBe(7);
  });

  it('rebuilds the ledger from the log, and a child reopened finds its node', async () => {
    const { root, child, store } = await tree(10 * R, ['a']);
    const a = await child('a', 5 * R, [task('a1', 1)]);
    await run(a);
    await until(() => started(a).includes('a1'));
    report(a, 'a1', used(4242));
    const before = await root.ledger();
    await before.flushed();
    const numbers = before.numbers(a.budget.path);

    const held = root.hostChild('a').sessionId;
    root.destroy();
    await settled();
    const log = new FakeEventStore();
    log.events.push(...store.events);

    const { settings } = { settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' as const, delegationTokens: 10 * R } }) };
    const reopened = makeSession({
      config: fakeConfig({ maxParallelSessions: 8, worktreeIsolation: true }), isolation: new FakeWorktreeIsolation(), runner: recordingRunner().runner,
      aiService: heldPlanner().aiService, settings, workspaceRoot: () => '/repo', sessionId: 'root', eventLog: () => log,
    });
    const ledger = await reopened.ledger();

    expect(ledger.numbers(a.budget.path)).toEqual({ ...numbers, reserve: R });
    expect(ledger.nodeOf(held)?.path).toBe(a.budget.path);
    expect(foldTree(store.events).get(a.budget.path)?.spent).toBe(4242);
  });
});

