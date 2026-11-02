import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { ChildPlanRunner, type ChildHost, type ChildNode, type NodeState, type SubplannerLink } from '../ChildPlanRunner';
import { createTask } from '../../models/Task';

const IDLE_BUT_LIVE: NodeState = { unfinished: [], completed: 0, live: true, plannerBusy: false, wakeOwed: false, stoppedFor: null, withdrawn: null, startRefused: null, tasks: [] };

/** A child whose state a test sets, behind the runner seam: what its clock does, with no Session under it. */
function child(wallClockMs: number) {
  const held = { ms: 0 };
  const state = { ...IDLE_BUT_LIVE };
  const node: ChildNode = {
    sessionId: 'child-session',
    protectedPaths: [],
    wallClockMs,
    startPlanning: () => Promise.resolve(),
    continueConversation: () => Promise.resolve(),
    hear: () => undefined,
    goOn: () => Promise.resolve(),
    state: () => state,
    halt: vi.fn(async () => { state.live = false; }),
    close: vi.fn(async () => undefined),
    heldSince: () => held.ms,
    takeReport: (report) => ({ ok: true, handoff: report }),
  };
  const links: SubplannerLink[] = [];
  const host: ChildHost = { openChild: async (_task, _cwd, link) => { links.push(link); return node; }, changedPaths: async () => [], stopped: () => false, passUp: () => undefined, moved: () => undefined };
  return { held, node, state, links, runner: new ChildPlanRunner(host) };
}

async function started(runner: ChildPlanRunner) {
  const session = await runner.spawn({ taskId: 'd', runner: 'claude-code', prompt: '', cwd: '/w', delegated: createTask({ id: 'd', order: 1, title: 'D', type: 'delegated', goal: 'g' }) } as never);
  const reports: unknown[] = [];
  session.onTaskComplete?.((report) => reports.push(report));
  await vi.advanceTimersByTimeAsync(1);
  return { reports };
}

describe('what reaches a subplanner in a run (ADR-0057 R6)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  async function running() {
    const built = child(60_000);
    const hear = vi.fn();
    const go = vi.fn(() => Promise.resolve());
    Object.assign(built.node, { hear, continueConversation: go });
    const session = await built.runner.spawn({ taskId: 'd', runner: 'claude-code', prompt: '', cwd: '/w', delegated: createTask({ id: 'd', order: 1, title: 'D', type: 'delegated', goal: 'g' }) } as never);
    await vi.advanceTimersByTimeAsync(1);
    return { session, hear, go };
  }

  it('holds Ordewell\'s own line for its next turn, and opens none', async () => {
    const { session, hear, go } = await running();
    session.sendMessage('moved', 'ordewell');
    expect(hear).toHaveBeenCalledWith('moved');
    expect(go).not.toHaveBeenCalled();
  });

  it('opens a turn on a message from the plan above', async () => {
    const { session, hear, go } = await running();
    session.sendMessage('go on');
    expect(go).toHaveBeenCalledWith('go on');
    expect(hear).not.toHaveBeenCalled();
  });
});

describe('a child stopped from above or below (ADR-0056 M8)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    ['a guard lowered it', 'blocked'],
    ['its planner failed its restart', 'failed'],
  ] as const)('ends as what stopped it says: %s', async (why, ends) => {
    const { links, runner, state } = child(60_000);
    const { reports } = await started(runner);
    Object.assign(state, { live: false, stoppedFor: { why, ends } });
    links[0].changed();
    await vi.advanceTimersByTimeAsync(1);
    expect(reports[0]).toMatchObject({ status: ends });
  });
});

describe('a child\'s wall clock (ADR-0056 M3)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs out at its limit with nothing holding the tree', async () => {
    const { node, runner } = child(1000);
    const { reports } = await started(runner);
    await vi.advanceTimersByTimeAsync(1000);
    expect(node.halt).toHaveBeenCalled();
    expect(reports[0]).toMatchObject({ status: 'blocked', reason: expect.stringContaining('ran out') });
  });

  it('runs on by what the tree was held, however late the hold is found', async () => {
    const { held, node, runner } = child(1000);
    await started(runner);
    await vi.advanceTimersByTimeAsync(600);
    held.ms = 5000;
    await vi.advanceTimersByTimeAsync(5300);
    expect(node.halt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(node.halt).toHaveBeenCalled();
  });

  it('is on the clock again past the reset: a resume waiting on a slot does not stop it', async () => {
    const { held, node, runner } = child(1000);
    await started(runner);
    held.ms = 2000;
    await vi.advanceTimersByTimeAsync(3000);
    expect(node.halt).toHaveBeenCalled();
  });
});

describe('the longest wall clock a timer cannot hold (ADR-0056 M3)', () => {
  it('waits in one long timer rather than firing at once and spinning', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'Date'] });
    const armed = vi.spyOn(globalThis, 'setTimeout');
    try {
      const { node, runner } = child(3_000_000_000);
      await started(runner);
      expect(armed.mock.calls.map(([, ms]) => ms ?? 0).every((ms) => ms <= 2 ** 31 - 1)).toBe(true);
      await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
      expect(node.halt).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3_000_000_000 - (2 ** 31 - 1));
      expect(node.halt).toHaveBeenCalled();
    } finally {
      armed.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('a question that cannot go up', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('leaves no question waiting, so the next one goes up and a quiet child still ends', async () => {
    const { links, runner, state } = child(60_000);
    const session = await runner.spawn({ taskId: 'd', runner: 'claude-code', prompt: '', cwd: '/w', delegated: createTask({ id: 'd', order: 1, title: 'D', type: 'delegated', goal: 'g' }) } as never);
    const reports: unknown[] = [];
    session.onTaskComplete?.((report) => reports.push(report));
    const asked = vi.fn().mockRejectedValueOnce(new Error('the log would not take it')).mockReturnValue(new Promise(() => undefined));
    session.onToolCheckpoint?.(asked);
    await vi.advanceTimersByTimeAsync(1);

    links[0].checkpoint('first?');
    await vi.advanceTimersByTimeAsync(1);

    expect((links[0].checkpoint('second?') as { isError?: boolean }).isError).toBeUndefined();
    expect(asked).toHaveBeenCalledTimes(2);
    expect(reports).toEqual([]);
    expect(state.live).toBe(true);
  });
});

describe('the verdict a subplanner\'s report takes', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });

  /** A child done at its call, with `branch` the paths its branch shows at each read. */
  async function reporting(branch: () => Promise<string[]>) {
    const { node, links, state } = child(60_000);
    Object.assign(node, { protectedPaths: ['tests/'] });
    Object.assign(state, { live: false, completed: 1 });
    const host: ChildHost = { openChild: async (_task, _cwd, link) => { links.push(link); return node; }, changedPaths: branch, stopped: () => false, passUp: () => undefined, moved: () => undefined };
    const session = await new ChildPlanRunner(host).spawn({ taskId: 'd', runner: 'claude-code', prompt: '', cwd: '/w', delegated: createTask({ id: 'd', order: 1, title: 'D', type: 'delegated', goal: 'g' }) } as never);
    const verdicts: unknown[] = [];
    session.onTaskComplete?.((_report, refuted) => verdicts.push(refuted));
    await vi.advanceTimersByTimeAsync(1);
    const reply = await links[0].taskComplete({ status: 'done', summary: 'Done.' } as never);
    return { node, state, verdicts, reply };
  }

  it('reads the branch again at publishing: what landed behind the call is judged too', async () => {
    const reads = [['a.txt'], ['a.txt'], ['a.txt', 'tests/guard.txt']];
    const { verdicts, reply } = await reporting(async () => reads.shift() ?? []);
    expect(reply.isError).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5000);

    expect(verdicts).toEqual([expect.objectContaining({ name: 'protected_paths', passed: false, detail: expect.stringContaining('tests/guard.txt') })]);
  });

  it('refutes the work when that last read fails: an unread branch never lands', async () => {
    let reads = 0;
    const { verdicts } = await reporting(async () => {
      reads += 1;
      if (reads > 2) throw new Error('git went away');
      return ['a.txt'];
    });

    await vi.advanceTimersByTimeAsync(5000);

    expect(verdicts).toEqual([expect.objectContaining({ name: 'protected_paths', passed: false, detail: expect.stringContaining('git went away') })]);
  });

  it('winds down what raced the call before that read, so nothing merges behind it', async () => {
    let wound = false;
    const { node, state, verdicts } = await reporting(async () => (wound ? ['a.txt', 'tests/guard.txt'] : ['a.txt']));
    state.live = true;
    vi.mocked(node.halt).mockImplementation(async () => { state.live = false; wound = true; });

    await vi.advanceTimersByTimeAsync(5000);

    expect(node.halt).toHaveBeenCalled();
    expect(verdicts).toEqual([expect.objectContaining({ name: 'protected_paths', detail: expect.stringContaining('tests/guard.txt') })]);
  });

  it('takes a clean branch at the last read', async () => {
    const { verdicts } = await reporting(async () => ['a.txt']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(verdicts).toEqual([undefined]);
  });
});
