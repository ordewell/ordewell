import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { UsageRecord } from '../../models/Usage';
import { parentPath, ROOT_NODE, type NodePath } from '../../models/TreeEvent';
import { FakeEventStore, flushMicrotasks } from '../../testing';
import { jsonlEventStore } from '../../utils/treeEventLog';
import { rootMandate, type Mandate, type MandateRequest } from '../Mandate';
import { foldTree, TreeLedger, type BudgetNumbers, type NodeBudget } from '../TreeLedger';
import type { EventStore } from '../eventStore';

/** One session's allowance in these tests; every number below is worked from it by hand. */
const R = 10;

const delegating = (tokens: number): Mandate => rootMandate({ level: 'act', autorun: true, autonomous: true, delegationTokens: tokens, runners: ['claude-code'], models: {} });

const open = (limit: number, store: EventStore = new FakeEventStore()) => TreeLedger.open(store, { sessionId: 'root-session', limit }, { sessionReserve: R });

let opened = 0;
function carve(ledger: TreeLedger, parent: NodePath, tokens: number, extra: Partial<MandateRequest> = {}) {
  opened += 1;
  return ledger.carve(parent, delegating(ledger.numbers(ROOT_NODE).limit), { level: parent.split('/').length - 1, tokens, ...extra }, { sessionId: `child-${opened}`, taskId: `task-${opened}` });
}

function child(ledger: TreeLedger, parent: NodePath, tokens: number): NodeBudget {
  const carved = carve(ledger, parent, tokens);
  if (!carved.ok) throw new Error(JSON.stringify(carved.refusal));
  return carved.budget;
}

const used = (tokens: number, over: Partial<UsageRecord> = {}): UsageRecord => ({ source: 'claude-code', inputTokens: tokens, ...over });
const numbers = (limit: number, committed: number, spent: number, reserve: number): BudgetNumbers => ({ limit, committed, spent, reserve });

describe('carving a child\'s budget (ADR-0056 M5)', () => {
  it('commits it from the parent, and the child keeps one session for its next turn', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 40);
    expect(budget.path).toBe('root/1');
    expect(ledger.numbers(ROOT_NODE)).toEqual(numbers(100, 40, 0, 0));
    expect(ledger.numbers('root/1')).toEqual(numbers(40, 0, 0, 10));
    expect(ledger.left(ROOT_NODE)).toBe(60);
    expect(ledger.left('root/1')).toBe(30);
  });

  it('numbers children under their parent, in the order they opened', async () => {
    const ledger = await open(100);
    expect(child(ledger, ROOT_NODE, 30).path).toBe('root/1');
    const second = child(ledger, ROOT_NODE, 30);
    expect(second.path).toBe('root/2');
    expect(child(ledger, second.path, 15).path).toBe('root/2/1');
  });

  it('hands narrow what the parent has left, not what it was given', async () => {
    const ledger = await open(100);
    child(ledger, ROOT_NODE, 70);
    const refused = carve(ledger, ROOT_NODE, 31);
    expect(refused).toEqual({ ok: false, refusal: { level: 0, field: 'limits.tokens', asked: '31', there: '30' } });
    expect(ledger.numbers(ROOT_NODE)).toEqual(numbers(100, 70, 0, 0));
  });

  it('takes the whole of what is left, and no more', async () => {
    const ledger = await open(100);
    expect(carve(ledger, ROOT_NODE, 100).ok).toBe(true);
    expect(ledger.left(ROOT_NODE)).toBe(0);
    expect(carve(ledger, ROOT_NODE, 1).ok).toBe(false);
  });

  it('asks a child\'s reserve of what it carves: a subplanner\'s own turn comes before its carves', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 40);
    expect(carve(ledger, budget.path, 31).ok).toBe(false);
    expect(carve(ledger, budget.path, 30).ok).toBe(true);
    expect(ledger.numbers(budget.path)).toEqual(numbers(40, 30, 0, 10));
  });

  it('refuses a second budget for a session that holds one', async () => {
    const ledger = await open(100);
    const opening = { sessionId: 'same', taskId: 't' };
    const request = { level: 0, tokens: 10 };
    expect(ledger.carve(ROOT_NODE, delegating(100), request, opening).ok).toBe(true);
    expect(ledger.carve(ROOT_NODE, delegating(100), request, opening)).toEqual({
      ok: false, refusal: { level: 0, field: 'limits.tokens', asked: '10', there: 'a budget this child already holds' },
    });
    expect(ledger.numbers(ROOT_NODE).committed).toBe(10);
  });

  it('finds a node by its session, and only while it is open', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 40);
    const sessionId = `child-${opened}`;
    expect(ledger.nodeOf(sessionId)?.path).toBe(budget.path);
    ledger.close(budget.path);
    expect(ledger.nodeOf(sessionId)).toBeUndefined();
  });

  it('carves a child of a closed node nothing', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 40);
    ledger.close(budget.path);
    expect(ledger.left(budget.path)).toBe(0);
    expect(carve(ledger, budget.path, 1).ok).toBe(false);
  });
});

describe('a claim (ADR-0056 M5)', () => {
  it('holds one session\'s reserve while it runs, and frees it as it ends', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 40);
    const hold = budget.hold();
    expect(ledger.numbers(budget.path).reserve).toBe(20);
    expect(ledger.left(budget.path)).toBe(20);
    hold.release();
    hold.release();
    expect(ledger.numbers(budget.path).reserve).toBe(10);
    expect(ledger.left(budget.path)).toBe(30);
  });

  it('is refused once it would breach the reserve, and says what is left, naming the level', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 25);
    expect(budget.refusal()).toBeNull();
    budget.hold();
    expect(budget.refusal()).toBe('Level 1 refused this start: a session here needs 10 tokens to start, and 5 of its 25 are left.');
  });

  it('changes nothing by being refused or asked', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 25);
    budget.refusal();
    budget.refusal();
    expect(ledger.numbers(budget.path)).toEqual(numbers(25, 0, 0, 10));
  });

  it('is not logged: nothing is live after a restart, so a hold has nothing to rebuild', async () => {
    const store = new FakeEventStore();
    const ledger = await open(100, store);
    const budget = child(ledger, ROOT_NODE, 40);
    budget.hold();
    await ledger.flushed();
    expect(store.events.map((e) => e.kind)).toEqual(['node_opened', 'node_opened']);
  });
});

describe('spending (ADR-0056 M5)', () => {
  it('counts input and output, cache reads inside the input and not twice', async () => {
    const ledger = await open(1000);
    const budget = child(ledger, ROOT_NODE, 500);
    budget.spent(used(100, { cachedInputTokens: 80, outputTokens: 20 }), { taskId: 't', attempt: 1 });
    expect(ledger.numbers(budget.path).spent).toBe(120);
  });

  it('counts a subagent\'s calls and a breakdown\'s, and what reports no tokens as nothing', async () => {
    const store = new FakeEventStore();
    const ledger = await open(1000, store);
    const budget = child(ledger, ROOT_NODE, 500);
    budget.spent(used(5, { subagentId: 'sub-1' }), { taskId: 't', attempt: 1 });
    budget.spent(used(7, { aggregate: true }), { taskId: 't', attempt: 1 });
    budget.spent({ source: 'claude-code', compacted: true, contextTokens: 900 }, { taskId: 't', attempt: 1 });
    budget.spent({ source: 'claude-code', sessionBilling: { type: 'subscription' } }, { taskId: 't', attempt: 1 });
    expect(ledger.numbers(budget.path).spent).toBe(12);
    await ledger.flushed();
    expect(store.events.filter((e) => e.kind === 'tokens_spent')).toHaveLength(2);
  });

  it('keeps an allowance for each live session while there is room, and lets it shrink rather than breach the limit', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 25);
    budget.hold();
    budget.spent(used(5), { taskId: 't', attempt: 1 });
    expect(ledger.numbers(budget.path)).toEqual(numbers(25, 0, 5, 20));
    budget.spent(used(10), { taskId: 't', attempt: 1 });
    expect(ledger.numbers(budget.path)).toEqual(numbers(25, 0, 15, 10));
    budget.spent(used(9), { taskId: 't', attempt: 1 });
    expect(ledger.numbers(budget.path)).toEqual(numbers(25, 0, 24, 1));
  });

  it('counts an overshoot: nothing can recall a request already sent', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 25);
    budget.spent(used(40), { taskId: 't', attempt: 1 });
    expect(ledger.numbers(budget.path)).toEqual(numbers(25, 0, 40, 0));
  });

  it('says a node is out once, as `spent` reaches what its children\'s spending leaves of `limit`', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 25);
    const out = vi.fn();
    budget.onStop(out);
    budget.spent(used(24), { taskId: 't', attempt: 1 });
    await flushMicrotasks();
    expect(out).not.toHaveBeenCalled();
    budget.spent(used(1), { taskId: 't', attempt: 1 });
    budget.spent(used(1), { taskId: 't', attempt: 1 });
    await flushMicrotasks();
    expect(out.mock.calls).toEqual([['Level 1 is out of budget: it has spent 25 of its 25 tokens, and nothing it holds is left to spend.']]);
  });

  describe('stopping before the limit, since a call\'s usage arrives with the next already sent', () => {
    /** A real run's numbers: a 750,000 grant, a planning turn, then a runner's calls as they came. */
    async function realRun(calls: readonly number[]) {
      const ledger = await TreeLedger.open(new FakeEventStore(), { sessionId: 'root-session', limit: 800_000 }, { sessionReserve: 200_000 });
      const budget = child(ledger, ROOT_NODE, 750_000);
      const out = vi.fn();
      budget.onStop(out);
      budget.turnSpent(used(63_393));
      budget.hold();
      for (const [i, call] of calls.entries()) {
        budget.spent(used(call), { taskId: 't', attempt: 1 });
        await flushMicrotasks();
        if (out.mock.calls.length > 0) {
          budget.spent(used(calls[i + 1]), { taskId: 't', attempt: 1 });
          break;
        }
      }
      return { spent: ledger.numbers(budget.path).spent, out };
    }

    it('stops while what it holds still pays for the call on its way, so nothing passes the grant', async () => {
      const { spent, out } = await realRun([22_996, 67_824, 90_124, 110_200, 113_809, 117_674, 118_000, 118_500, 119_000]);
      expect(out).toHaveBeenCalledOnce();
      expect(spent).toBeLessThanOrEqual(750_000);
      expect(out.mock.calls[0][0]).toMatch(/^Level 1 is out of budget: it has spent \d+ of its 750000 tokens, and what it holds would not pay for its next model calls\.$/);
    });

    it('holds at small calls, stopping no sooner than two of them from the end', async () => {
      const { spent, out } = await realRun(Array.from({ length: 30 }, () => 30_000));
      expect(out).toHaveBeenCalledOnce();
      expect(spent).toBe(63_393 + 22 * 30_000);
    });

    it('asks nothing of what a runner reports winding down, with no session live: no call follows it', async () => {
      const ledger = await open(100);
      const budget = child(ledger, ROOT_NODE, 25);
      const out = vi.fn();
      budget.onStop(out);
      budget.spent(used(20), { taskId: 't', attempt: 1 });
      await flushMicrotasks();
      expect(out).not.toHaveBeenCalled();
    });

    it('counts its children\'s room as a turn can reach it, so a node is not stopped for what it can still take', async () => {
      const ledger = await open(100);
      const parent = child(ledger, ROOT_NODE, 60);
      child(ledger, parent.path, 40);
      const out = vi.fn();
      parent.onStop(out);
      parent.turnSpent(used(10));
      await flushMicrotasks();
      expect(out).not.toHaveBeenCalled();
    });
  });

  it('says it again after a raise, once it has reached that too', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 25);
    const out = vi.fn();
    budget.onStop(out);
    budget.spent(used(25), { taskId: 't', attempt: 1 });
    await flushMicrotasks();
    expect(budget.stoppedFor()).not.toBeNull();
    expect(ledger.raise(budget.path, 5)).toBeNull();
    expect(budget.stoppedFor()).toBeNull();
    budget.spent(used(5), { taskId: 't', attempt: 1 });
    await flushMicrotasks();
    expect(out).toHaveBeenCalledTimes(2);
  });

  it('charges what arrives after a node closed to the nearest node still open', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 40);
    ledger.close(budget.path);
    budget.spent(used(5), { taskId: 't', attempt: 1 });
    expect(ledger.numbers(ROOT_NODE)).toEqual(numbers(100, 0, 5, 0));
    expect(ledger.numbers(budget.path).spent).toBe(0);
  });

  it('does not let what a closed child\'s turn reports eat its parent\'s reserve', async () => {
    const ledger = await open(100);
    const parent = child(ledger, ROOT_NODE, 60);
    const kid = child(ledger, parent.path, 20);
    ledger.close(kid.path);
    kid.turnSpent(used(4));
    expect(ledger.numbers(parent.path)).toEqual(numbers(60, 0, 4, 10));
  });

  it('takes an attempt\'s overrun past the node\'s room from its children, so the node\'s own work cannot spend what they hold', async () => {
    const ledger = await open(100);
    const parent = child(ledger, ROOT_NODE, 100);
    const kid = child(ledger, parent.path, 60);
    // Room 30, kept 10: a spend of 45 is 5 past everything the parent does not hold for its child.
    parent.spent(used(45), { taskId: 't', attempt: 1 });
    expect(ledger.numbers(parent.path)).toEqual(numbers(100, 55, 45, 0));
    expect(ledger.numbers(kid.path)).toEqual(numbers(55, 0, 0, 10));
  });

  it('never takes a child\'s reserve or what it has spent, and stops the node when nothing is left to take', async () => {
    const ledger = await open(100);
    const parent = child(ledger, ROOT_NODE, 100);
    const kid = child(ledger, parent.path, 60);
    kid.spent(used(20), { taskId: 't', attempt: 1 });
    const out = vi.fn();
    parent.onStop(out);
    parent.spent(used(200), { taskId: 't', attempt: 1 });
    await flushMicrotasks();
    // The child's room was 30: 60 less 20 spent less 10 kept. Its limit falls to what it holds.
    expect(ledger.numbers(kid.path)).toEqual(numbers(30, 0, 20, 10));
    expect(ledger.numbers(parent.path)).toEqual(numbers(100, 30, 200, 0));
    expect(out).toHaveBeenCalledTimes(1);
  });
});

describe('a child closing (ADR-0056 M5)', () => {
  it('returns what it did not spend to its parent, and charges the parent what it did', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 40);
    budget.spent(used(15), { taskId: 't', attempt: 1 });
    ledger.close(budget.path);
    expect(ledger.numbers(ROOT_NODE)).toEqual(numbers(100, 0, 15, 0));
    expect(ledger.left(ROOT_NODE)).toBe(85);
  });

  it('returns it to the parent and goes no further: a grandparent and a sibling see nothing', async () => {
    const ledger = await open(100);
    const parent = child(ledger, ROOT_NODE, 80);
    const sibling = child(ledger, parent.path, 20);
    const kid = child(ledger, parent.path, 30);
    kid.spent(used(10), { taskId: 't', attempt: 1 });
    ledger.close(kid.path);
    expect(ledger.numbers(parent.path)).toEqual(numbers(80, 20, 10, 10));
    expect(ledger.numbers(ROOT_NODE)).toEqual(numbers(100, 80, 0, 0));
    expect(ledger.numbers(sibling.path)).toEqual(numbers(20, 0, 0, 10));
  });

  it('closes what is still open under it first, in one batch', async () => {
    const store = new FakeEventStore();
    const ledger = await open(100, store);
    const parent = child(ledger, ROOT_NODE, 80);
    const kid = child(ledger, parent.path, 30);
    kid.spent(used(10), { taskId: 't', attempt: 1 });
    await ledger.flushed();
    const before = store.events.length;
    ledger.close(parent.path);
    await ledger.flushed();
    expect(store.events.slice(before).map((e) => [e.kind, e.node])).toEqual([['node_closed', kid.path], ['node_closed', parent.path]]);
    expect(ledger.numbers(ROOT_NODE)).toEqual(numbers(100, 0, 10, 0));
  });

  it('does nothing asked twice', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 40);
    ledger.close(budget.path);
    ledger.close(budget.path);
    expect(ledger.numbers(ROOT_NODE)).toEqual(numbers(100, 0, 0, 0));
  });

  it('frees a hold left behind by nothing: a late release after a close changes no number', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 40);
    const hold = budget.hold();
    ledger.close(budget.path);
    hold.release();
    expect(ledger.left(ROOT_NODE)).toBe(100);
  });

  it('passes on what an overshoot cost: the parent\'s other child pays, and the parent stops when nothing can', async () => {
    const ledger = await open(100);
    const parent = child(ledger, ROOT_NODE, 100);
    const greedy = child(ledger, parent.path, 40);
    const other = child(ledger, parent.path, 50);
    greedy.spent(used(60), { taskId: 't', attempt: 1 });
    ledger.close(greedy.path);
    // Spent 60, the other child holds 50: 10 over a limit of 100, from a child with 40 of room.
    expect(ledger.numbers(parent.path)).toEqual(numbers(100, 40, 60, 0));
    expect(ledger.numbers(other.path)).toEqual(numbers(40, 0, 0, 10));
  });
});

describe('a raise (ADR-0056 M5)', () => {
  it('is the task\'s: it outlives the node it went to, and what a parent\'s turn takes back does not lessen it (M5, M10)', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 40);
    const taskId = [...ledger.below(ROOT_NODE)].find((node) => node.path === budget.path)!.taskId!;
    expect(ledger.raise(budget.path, 25)).toBeNull();
    expect(ledger.raisedOn(ROOT_NODE, taskId)).toBe(25);
    ledger.close(budget.path);
    expect(ledger.raisedOn(ROOT_NODE, taskId)).toBe(25);
    expect(ledger.raisedOn(ROOT_NODE, 'another')).toBe(0);
  });

  it('comes from what the parent has left, and moves both numbers', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 40);
    expect(ledger.raise(budget.path, 25)).toBeNull();
    expect(ledger.numbers(budget.path).limit).toBe(65);
    expect(ledger.numbers(ROOT_NODE)).toEqual(numbers(100, 65, 0, 0));
  });

  it('is refused past what the parent has left, which keeps a subplanner\'s own turn', async () => {
    const ledger = await open(100);
    const parent = child(ledger, ROOT_NODE, 100);
    const kid = child(ledger, parent.path, 80);
    expect(ledger.raise(kid.path, 11)).toBe('Level 1 refused this raise: it asks 11 tokens, and 10 are left.');
    expect(ledger.numbers(kid.path).limit).toBe(80);
    expect(ledger.raise(kid.path, 10)).toBeNull();
  });

  it('is refused for what cannot take one', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 40);
    expect(ledger.raise(ROOT_NODE, 5)).toBe('Only the user raises the tree\'s budget.');
    expect(ledger.raise(budget.path, 0)).toBe('A raise is a whole number of tokens, 1 or more.');
    expect(ledger.raise(budget.path, 1.5)).toBe('A raise is a whole number of tokens, 1 or more.');
    ledger.close(budget.path);
    expect(ledger.raise(budget.path, 5)).toBe('That child has closed, so nothing can raise its budget.');
  });

  it('turns no number on a refusal', async () => {
    const store = new FakeEventStore();
    const ledger = await open(100, store);
    const budget = child(ledger, ROOT_NODE, 40);
    ledger.raise(budget.path, 61);
    await ledger.flushed();
    expect(store.events.map((e) => e.kind)).toEqual(['node_opened', 'node_opened']);
  });
});

describe('a subplanner\'s own turns (ADR-0056 M5)', () => {
  it('spends what it kept first, `reserve` falling as `spent` rises, so nothing carved meanwhile can take it', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 40);
    expect(ledger.left(budget.path)).toBe(30);
    budget.turnSpent(used(4));
    expect(ledger.numbers(budget.path)).toEqual(numbers(40, 0, 4, 6));
    expect(ledger.left(budget.path)).toBe(30);
  });

  it('spends room past that', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 40);
    budget.turnSpent(used(15));
    expect(ledger.numbers(budget.path)).toEqual(numbers(40, 0, 15, 0));
    expect(ledger.left(budget.path)).toBe(25);
  });

  it('keeps one session again as it parks, from room', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 40);
    budget.turnSpent(used(15));
    budget.parked();
    expect(ledger.numbers(budget.path)).toEqual(numbers(40, 0, 15, 10));
    expect(ledger.left(budget.path)).toBe(15);
  });

  it('asks nothing of anyone parking with its reserve whole', async () => {
    const store = new FakeEventStore();
    const ledger = await open(100, store);
    const budget = child(ledger, ROOT_NODE, 40);
    budget.parked();
    await ledger.flushed();
    expect(store.events.filter((e) => e.kind === 'reserve_kept')).toEqual([]);
  });

  it('past its room spends its children\'s, the child that woke it first, and their limit and its committed fall together', async () => {
    const ledger = await open(100);
    const parent = child(ledger, ROOT_NODE, 100);
    const older = child(ledger, parent.path, 30);
    const waker = child(ledger, parent.path, 60);
    parent.woken(waker.path);
    // Kept 10 and room 0: a turn of 25 is 15 past both.
    parent.turnSpent(used(25));
    expect(ledger.numbers(waker.path).limit).toBe(45);
    expect(ledger.numbers(older.path).limit).toBe(30);
    expect(ledger.numbers(parent.path)).toEqual(numbers(100, 75, 25, 0));
  });

  it('goes on to the next child, oldest first, when the first has no room', async () => {
    const ledger = await open(100);
    const parent = child(ledger, ROOT_NODE, 100);
    const older = child(ledger, parent.path, 30);
    const waker = child(ledger, parent.path, 60);
    parent.woken(waker.path);
    // The waker holds 50 of room and the older child 20; a turn of 70 is 60 past what the parent kept.
    parent.turnSpent(used(70));
    expect(ledger.numbers(waker.path).limit).toBe(10);
    expect(ledger.numbers(older.path).limit).toBe(20);
    expect(ledger.numbers(parent.path).committed).toBe(30);
  });

  it('keeps its reserve again from its children\'s room as it parks, in one batch', async () => {
    const store = new FakeEventStore();
    const ledger = await open(100, store);
    const parent = child(ledger, ROOT_NODE, 100);
    const kid = child(ledger, parent.path, 90);
    parent.turnSpent(used(10));
    await ledger.flushed();
    const before = store.events.length;
    const appended = vi.spyOn(store, 'append');
    parent.parked();
    await ledger.flushed();
    expect(ledger.numbers(parent.path)).toEqual(numbers(100, 80, 10, 10));
    expect(ledger.numbers(kid.path).limit).toBe(80);
    expect(store.events.slice(before).map((e) => e.kind)).toEqual(['budget_taken', 'reserve_kept']);
    expect(appended).toHaveBeenCalledTimes(1);
  });

  it('forgets who woke it as it parks', async () => {
    const ledger = await open(100);
    const parent = child(ledger, ROOT_NODE, 100);
    const older = child(ledger, parent.path, 30);
    const waker = child(ledger, parent.path, 60);
    parent.woken(waker.path);
    parent.parked();
    parent.turnSpent(used(20));
    expect(ledger.numbers(older.path).limit).toBe(20);
    expect(ledger.numbers(waker.path).limit).toBe(60);
  });

  it('starts on what it kept, on its room, or on its children\'s, and on nothing less than one session', async () => {
    const ledger = await open(100);
    const parent = child(ledger, ROOT_NODE, 100);
    const kid = child(ledger, parent.path, 90);
    expect(parent.turnRefusal()).toBeNull();
    parent.turnSpent(used(10));
    expect(parent.turnRefusal()).toBeNull();
    kid.spent(used(80), { taskId: 't', attempt: 1 });
    expect(ledger.left(kid.path)).toBe(0);
    expect(parent.turnRefusal()).toBe('Level 1 refused this turn: a turn here needs 10 tokens to start, and 0 are left across this node and its children.');
  });

  it('refuses a claim that would take what its subplanner needs for its next turn, though a turn has just spent its share', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 28);
    budget.turnSpent(used(10));

    // 18 are free and 10 are the subplanner's: a turn spent its share down, and nothing has parked yet.
    expect(budget.refusal()).toBe('Level 1 refused this start: a session here needs 10 tokens to start, and 8 of its 28 are left.');
    budget.turnSpent(used(0));
    budget.parked();
    expect(budget.refusal()).toBe('Level 1 refused this start: a session here needs 10 tokens to start, and 8 of its 28 are left.');
  });

  it('adds what earlier openings of a task spent to what the task has cost, and nothing of a sibling', async () => {
    const ledger = await open(1000);
    const first = ledger.carve(ROOT_NODE, delegating(1000), { level: 1, tokens: 100 }, { sessionId: 'a', taskId: 't' });
    if (!first.ok) throw new Error('refused');
    first.budget.turnSpent(used(30));
    ledger.close(first.budget.path);
    const other = child(ledger, ROOT_NODE, 100);
    other.turnSpent(used(40));
    const again = ledger.carve(ROOT_NODE, delegating(1000), { level: 1, tokens: 100 }, { sessionId: 'b', taskId: 't' });
    if (!again.ok) throw new Error('refused');
    again.budget.turnSpent(used(5));
    const below = child(ledger, again.budget.path, 20);
    below.turnSpent(used(2));

    expect(ledger.taskSpent(again.budget.path)).toBe(37);
  });

  it('counts a carve too small for a turn as a turn it cannot start, and says so when asked', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 6);
    expect(ledger.numbers(budget.path)).toEqual(numbers(6, 0, 0, 6));
    expect(budget.turnRefusal()).toBe('Level 1 refused this turn: a turn here needs 10 tokens to start, and 6 are left across this node and its children.');
  });

  it('leaves live attempts their allowance when judging a turn', async () => {
    const ledger = await open(100);
    const budget = child(ledger, ROOT_NODE, 20);
    budget.turnSpent(used(10));
    budget.hold();
    expect(budget.turnRefusal()).toBe('Level 1 refused this turn: a turn here needs 10 tokens to start, and 0 are left across this node and its children.');
  });
});

describe('the root (ADR-0056 M5)', () => {
  it('takes the user\'s new limit as an event', async () => {
    const store = new FakeEventStore();
    const ledger = await open(100, store);
    ledger.setRootLimit(150);
    ledger.setRootLimit(150);
    await ledger.flushed();
    expect(ledger.numbers(ROOT_NODE).limit).toBe(150);
    expect(store.events.filter((e) => e.kind === 'limit_set')).toHaveLength(1);
  });

  it('opens with one event, and only when the log has no root', async () => {
    const store = new FakeEventStore();
    await (await open(100, store)).flushed();
    await (await open(100, store)).flushed();
    expect(store.events.map((e) => e.kind)).toEqual(['node_opened']);
  });
});

describe('a failed append', () => {
  it('loses nothing: the facts wait, in order, and land with the next, and the failure is said once', async () => {
    const store = new FakeEventStore();
    const failed = vi.fn();
    const ledger = await TreeLedger.open(store, { sessionId: 'root-session', limit: 100 }, { sessionReserve: R, failed });
    await ledger.flushed();
    const budget = child(ledger, ROOT_NODE, 40);
    store.failing = new Error('disk full');
    await ledger.flushed();
    budget.spent(used(5), { taskId: 't', attempt: 1 });
    await ledger.flushed();
    expect(failed).toHaveBeenCalledTimes(1);
    store.failing = null;
    budget.spent(used(6), { taskId: 't', attempt: 1 });
    await ledger.flushed();
    expect(foldTree(store.events).get(budget.path)?.spent).toBe(11);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('tries once more as it closes', async () => {
    const store = new FakeEventStore();
    const ledger = await open(100, store);
    await ledger.flushed();
    store.failing = new Error('disk full');
    const budget = child(ledger, ROOT_NODE, 40);
    await ledger.flushed();
    store.failing = null;
    await ledger.shutdown();
    expect(foldTree(store.events).get(budget.path)?.limit).toBe(40);
  });
});

describe('a restart (ADR-0058 S3)', () => {
  const quiet = (ledger: TreeLedger, nodes: readonly NodePath[]) => nodes.map((node) => [node, ledger.numbers(node), ledger.left(node)]);

  /** A tree worked over: carves, spends, a raise, a close, a park. */
  async function worked(ledger: TreeLedger): Promise<NodePath[]> {
    const a = child(ledger, ROOT_NODE, 300);
    const b = child(ledger, ROOT_NODE, 200);
    const c = child(ledger, a.path, 120);
    a.spent(used(40, { outputTokens: 5 }), { taskId: 't', attempt: 1 });
    c.spent(used(70), { taskId: 't', attempt: 1 });
    ledger.raise(c.path, 60);
    a.turnSpent(used(25));
    a.parked();
    b.spent(used(30), { taskId: 't', attempt: 1 });
    ledger.close(b.path);
    await ledger.flushed();
    return [ROOT_NODE, a.path, b.path, c.path];
  }

  it('gives the same numbers from the log alone', async () => {
    const store = new FakeEventStore();
    const ledger = await open(1000, store);
    const nodes = await worked(ledger);
    expect(quiet(await open(1000, store), nodes)).toEqual(quiet(ledger, nodes));
  });

  it('gives the numbers the log holds after a torn write, and carries on from them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-ledger-'));
    try {
      const file = path.join(dir, 'tree.jsonl');
      const store = jsonlEventStore(file);
      const ledger = await open(1000, store);
      const nodes = await worked(ledger);
      const before = quiet(ledger, nodes);

      // The crash: a spend whose line reached the disk only in part. Its session never heard it land.
      const line = fs.readFileSync(file, 'utf-8').trimEnd().split('\n').at(-1)!;
      await store.close();
      fs.appendFileSync(file, line.slice(0, Math.floor(line.length / 2)));

      const reopened = await open(1000, jsonlEventStore(file));
      expect(quiet(reopened, nodes)).toEqual(before);

      const a = reopened.node('root/1');
      a.spent(used(9), { taskId: 't', attempt: 2 });
      await reopened.shutdown();
      const third = await open(1000, jsonlEventStore(file));
      expect(third.numbers(a.path).spent).toBe(reopened.numbers(a.path).spent);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not bring back what was live: nothing is, after a restart', async () => {
    const store = new FakeEventStore();
    const ledger = await open(1000, store);
    const a = child(ledger, ROOT_NODE, 300);
    a.hold();
    a.hold();
    await ledger.flushed();
    expect(ledger.numbers(a.path).reserve).toBe(30);
    expect((await open(1000, store)).numbers(a.path).reserve).toBe(10);
  });

  it('finds a child by its session, and a raise lands on the rebuilt numbers', async () => {
    const store = new FakeEventStore();
    const ledger = await open(1000, store);
    const a = child(ledger, ROOT_NODE, 300);
    await ledger.flushed();
    const reopened = await open(1000, store);
    expect(reopened.nodeOf(`child-${opened}`)?.path).toBe(a.path);
    expect(reopened.raise(a.path, 100)).toBeNull();
    expect(reopened.numbers(a.path).limit).toBe(400);
  });

  it('numbers the next child after those it rebuilt', async () => {
    const store = new FakeEventStore();
    const ledger = await open(1000, store);
    child(ledger, ROOT_NODE, 300);
    const closing = child(ledger, ROOT_NODE, 300);
    ledger.close(closing.path);
    await ledger.flushed();
    expect(child(await open(1000, store), ROOT_NODE, 100).path).toBe('root/3');
  });
});

/** A small deterministic generator (mulberry32), so a failure is a seed anyone can run again. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { int: (below: number) => Math.floor(next() * below), pick: <T>(from: readonly T[]) => from[Math.floor(next() * from.length)] };
}

describe('down a tree, over generated histories', () => {
  const RUNS = 200;
  const STEPS = 120;

  it('nothing carved exceeds its parent\'s limit, and what a node commits is what its children hold', async () => {
    let carves = 0;
    let refused = 0;
    let closes = 0;
    let takes = 0;
    for (let seed = 1; seed <= RUNS; seed++) {
      const r = random(seed);
      const store = new FakeEventStore();
      const ledger = await open(500 + r.int(1000), store);
      const budgets: NodeBudget[] = [];
      for (let step = 0; step < STEPS; step++) {
        const live = budgets.filter((b) => ledger.nodeOf(b.sessionId));
        const at = r.pick(live);
        switch (r.int(7)) {
          case 0: case 1: {
            const parent = at?.path ?? ROOT_NODE;
            const carved = carve(ledger, r.int(3) === 0 ? ROOT_NODE : parent, 1 + r.int(200));
            if (carved.ok) { budgets.push(carved.budget); carves += 1; } else refused += 1;
            break;
          }
          case 2: at?.spent(used(r.int(60)), { taskId: 't', attempt: 1 }); break;
          case 3: at?.turnSpent(used(r.int(60))); break;
          case 4: at?.parked(); break;
          case 5: if (at) ledger.raise(at.path, 1 + r.int(100)); break;
          default: if (at && r.int(3) === 0) { ledger.close(at.path); closes += 1; }
        }
        await ledger.flushed();
        const tree = foldTree(store.events);
        for (const [node, state] of tree) {
          if (!state.open) continue;
          const children = [...tree.values()].filter((c) => c.open && parentPath(c.path) === node);
          expect(state.committed, `${node} commits what its children hold, seed ${seed}`).toBe(children.reduce((total, c) => total + c.limit, 0));
          expect(state.committed, `${node} never commits past its limit, seed ${seed}`).toBeLessThanOrEqual(state.limit);
        }
      }
      takes += store.events.filter((e) => e.kind === 'budget_taken').length;
      // The live numbers are the log's, whatever came.
      const replayed = await open(0, store);
      const tree = foldTree(store.events);
      for (const [node, state] of tree) {
        expect(replayed.numbers(node), `seed ${seed}`).toEqual(ledger.numbers(node));
        expect(ledger.nodeOf(state.sessionId)?.path, `seed ${seed}`).toBe(state.open ? node : undefined);
        expect(replayed.nodeOf(state.sessionId)?.path, `seed ${seed}`).toBe(state.open ? node : undefined);
      }
    }
    // A property nothing reached proves nothing.
    expect(carves).toBeGreaterThan(500);
    expect(refused).toBeGreaterThan(100);
    expect(closes).toBeGreaterThan(100);
    expect(takes).toBeGreaterThan(100);
  });

  it('claims made in one step across a tree cannot together spend past its budget', async () => {
    let refusals = 0;
    for (let seed = 1; seed <= RUNS; seed++) {
      const r = random(seed);
      const limit = 200 + r.int(300);
      const ledger = await open(limit);
      const budgets: NodeBudget[] = [];
      for (let i = 0; i < 2 + r.int(5); i++) {
        const carved = carve(ledger, ROOT_NODE, 20 + r.int(120));
        if (carved.ok) budgets.push(carved.budget);
      }
      for (let i = 0; i < 2 + r.int(6); i++) {
        const carved = carve(ledger, r.pick(budgets).path, 20 + r.int(60));
        if (carved.ok) budgets.push(carved.budget);
      }
      // Every claim of the round lands before any session reports, as a tick's do; each then spends up to its allowance.
      let spent = 0;
      for (let round = 0; round < 4; round++) {
        const holds: { budget: NodeBudget; release: () => void }[] = [];
        for (const budget of budgets) {
          for (let claims = r.int(6); claims > 0; claims--) {
            if (budget.refusal()) { refusals += 1; continue; }
            holds.push({ budget, release: budget.hold().release });
          }
        }
        for (const { budget, release } of holds) {
          const tokens = 1 + r.int(R);
          budget.spent(used(tokens), { taskId: 't', attempt: 1 });
          spent += tokens;
          release();
        }
      }
      expect(spent, `seed ${seed}`).toBeLessThanOrEqual(limit);
    }
    expect(refusals).toBeGreaterThan(100);
  });
});

/** How often `act` walked a map of at least `size` entries: a whole tree, in the tests below. */
function walksOf(size: number, act: () => void): number {
  const walks = vi.spyOn(Map.prototype, 'values');
  try {
    act();
    return walks.mock.contexts.filter((map) => (map as Map<unknown, unknown>).size >= size).length;
  } finally {
    walks.mockRestore();
  }
}

describe('a tree that has opened far more children than are open (ADR-0058 S3)', () => {
  const OVER_ITS_LIFE = 50;

  async function longRunning() {
    const store = new FakeEventStore();
    const ledger = await open(100_000, store);
    for (let i = 0; i < OVER_ITS_LIFE; i++) ledger.close(child(ledger, ROOT_NODE, 20).path);
    return { ledger, store };
  }

  it('pays a usage record without walking every child it ever opened', async () => {
    const { ledger } = await longRunning();
    const busy = child(ledger, ROOT_NODE, 100);
    busy.hold();
    expect(walksOf(OVER_ITS_LIFE, () => busy.spent(used(1), { taskId: 't', attempt: 1 }))).toBe(0);
    expect(ledger.numbers(busy.path).spent).toBe(1);
  });

  it('finds a session, a task and a board without walking them either', async () => {
    const { ledger } = await longRunning();
    const budget = child(ledger, ROOT_NODE, 100);
    const taskId = `task-${opened}`;
    const walks = walksOf(OVER_ITS_LIFE, () => {
      expect(ledger.nodeOf(budget.sessionId)?.path).toBe(budget.path);
      expect(ledger.spentOn(ROOT_NODE, taskId)).toBe(0);
      expect(ledger.board(budget.path)).toEqual([]);
    });
    expect(walks).toBe(0);
  });

  it('carves and closes a child without walking them', async () => {
    const { ledger } = await longRunning();
    const walks = walksOf(OVER_ITS_LIFE, () => ledger.close(child(ledger, ROOT_NODE, 20).path));
    expect(walks).toBe(0);
  });

  it('answers the same after a restart, from the log alone', async () => {
    const { ledger, store } = await longRunning();
    const held = child(ledger, ROOT_NODE, 100);
    const below = child(ledger, held.path, 50);
    below.spent(used(3), { taskId: 't', attempt: 1 });
    ledger.close(child(ledger, ROOT_NODE, 20).path);
    await ledger.flushed();
    const reopened = await open(100_000, store);
    expect(reopened.subtreeSpent(held.path)).toBe(3);
    expect(reopened.nodeOf(below.sessionId)?.path).toBe(below.path);
    expect(reopened.numbers(ROOT_NODE)).toEqual(ledger.numbers(ROOT_NODE));
    reopened.close(held.path);
    expect(reopened.nodeOf(below.sessionId)).toBeUndefined();
    expect(reopened.numbers(ROOT_NODE).spent).toBe(3);
  });
});
