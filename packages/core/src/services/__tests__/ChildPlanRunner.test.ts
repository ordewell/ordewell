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
  const host: ChildHost = { openChild: async (_task, _cwd, link) => { links.push(link); return node; }, changedPaths: async () => [], stopped: () => false, passUp: () => undefined };
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
