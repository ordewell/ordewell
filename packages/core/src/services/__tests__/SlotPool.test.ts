import { describe, it, expect, vi, afterEach } from 'vitest';
import { SlotPool, type PoolNode } from '../SlotPool';

/**
 * The tree's one pool (ADR-0055 D18), driven as Sessions drive it: each node
 * asks through `refusal` and `take`, and hears back through its `PoolNode`.
 */

interface FakeNode extends PoolNode {
  tick: ReturnType<typeof vi.fn<PoolNode['tick']>>;
  openTurn: ReturnType<typeof vi.fn<PoolNode['openTurn']>>;
  limitFound: ReturnType<typeof vi.fn<PoolNode['limitFound']>>;
  waiting: Set<string>;
}

function node(): FakeNode {
  const waiting = new Set<string>();
  return {
    tick: vi.fn(async () => undefined),
    openTurn: vi.fn(),
    limitFound: vi.fn(),
    waitsOnPlanner: (taskId) => waiting.has(taskId),
    waiting,
  };
}

const task = (taskId: string) => ({ role: 'task', taskId }) as const;
const TURN = { role: 'planner' } as const;

function granted(result: ReturnType<SlotPool['take']>) {
  if ('refused' in result) throw new Error(`refused: ${result.refused}`);
  return result;
}

const flushed = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function tree(limit: number, children = 1) {
  const pool = new SlotPool(() => limit);
  const root = node();
  pool.join(root);
  const nodes = Array.from({ length: children }, () => {
    const child = node();
    pool.join(child);
    return child;
  });
  return { pool, root, nodes };
}

describe('a flat run: the Parallel limit, attempts alone (ADR-0030)', () => {
  const flat = (limit: number) => {
    const pool = new SlotPool(() => limit);
    const root = node();
    pool.join(root);
    return { pool, root };
  };

  it('refuses in the words a full session always used', () => {
    const { pool, root } = flat(1);
    granted(pool.take(root, task('a')));
    expect(pool.refusal(root, task('b'))).toBe('1 task is already running, the most this session runs at once. Wait for one to finish, or stop one first.');
    expect(pool.take(root, task('b'))).toEqual({ refused: '1 task is already running, the most this session runs at once. Wait for one to finish, or stop one first.' });
  });

  it('counts attempts past one in the plural', () => {
    const { pool, root } = flat(2);
    granted(pool.take(root, task('a')));
    granted(pool.take(root, task('b')));
    expect(pool.refusal(root, task('c'))).toBe('2 tasks are already running, the most this session runs at once. Wait for one to finish, or stop one first.');
  });

  it('counts no planner turn, and holds none back', () => {
    const { pool, root } = flat(1);
    const turn = granted(pool.take(root, TURN));
    expect(pool.refusal(root, task('a'))).toBeNull();
    granted(pool.take(root, task('a')));
    expect(pool.refusal(root, TURN)).toBeNull();
    turn.free();
  });

  it('ticks nobody: a flat run\'s own events already do', async () => {
    const { pool, root } = flat(1);
    const a = granted(pool.take(root, task('a')));
    expect(pool.take(root, task('b'))).toHaveProperty('refused');
    a.free();
    await flushed();
    expect(root.tick).not.toHaveBeenCalled();
  });

  it('reads the limit at each claim, as the setting changes', () => {
    let limit = 1;
    const pool = new SlotPool(() => limit);
    const root = node();
    pool.join(root);
    granted(pool.take(root, task('a')));
    expect(pool.refusal(root, task('b'))).not.toBeNull();
    limit = 2;
    expect(pool.refusal(root, task('b'))).toBeNull();
  });
});

describe('one pool across a tree (ADR-0055 D18)', () => {
  it('counts every attempt in the tree against the root\'s limit', () => {
    const { pool, root, nodes: [child] } = tree(2);
    granted(pool.take(root, task('a')));
    granted(pool.take(child, task('b')));
    expect(pool.refusal(child, task('c'))).toContain('the most this tree runs at once');
    expect(pool.refusal(root, task('d'))).toContain('the most this tree runs at once');
  });

  it('counts a subplanner\'s running turn', () => {
    const { pool, nodes: [child] } = tree(1);
    const turn = granted(pool.take(child, TURN));
    expect(pool.refusal(child, task('a'))).not.toBeNull();
    turn.free();
    expect(pool.refusal(child, task('a'))).toBeNull();
  });

  it('gives a delegated task no slot, so a parent at its limit cannot deadlock on its children', () => {
    const { pool, root, nodes: [child] } = tree(1);
    const delegated = granted(pool.take(root, { role: 'child-plan', taskId: 'd' }));
    expect(delegated.holdsSlot).toBe(false);
    granted(pool.take(child, task('a')));
    // The limit is full, and a second node is still let in.
    expect(pool.take(root, { role: 'child-plan', taskId: 'e' })).not.toHaveProperty('refused');
    delegated.free();
  });

  it('takes no slot for a merge', () => {
    const { pool, root } = tree(1);
    granted(pool.take(root, task('a')));
    expect(granted(pool.take(root, { role: 'merge' })).holdsSlot).toBe(false);
  });

  it('frees a slot once however often it is released', () => {
    const { pool, root, nodes: [child] } = tree(2);
    const a = granted(pool.take(root, task('a')));
    granted(pool.take(root, task('b')));
    a.free();
    a.free();
    granted(pool.take(child, task('c')));
    expect(pool.refusal(child, task('d'))).not.toBeNull();
  });

  describe('the root\'s planner turn', () => {
    it('is counted once the tree has a child, and not before', () => {
      const pool = new SlotPool(() => 1);
      const root = node();
      pool.join(root);
      granted(pool.take(root, TURN));
      expect(pool.refusal(root, task('a'))).toBeNull();
      const leave = pool.join(node());
      expect(pool.refusal(root, task('a'))).not.toBeNull();
      leave();
      expect(pool.refusal(root, task('a'))).toBeNull();
    });

    it('is never held: the run does not depend on it, and it is the user\'s conversation', () => {
      const { pool, root, nodes: [child] } = tree(1);
      granted(pool.take(child, task('a')));
      expect(pool.refusal(root, TURN)).toBeNull();
      expect(pool.take(root, TURN)).not.toHaveProperty('refused');
    });
  });

  describe('a Session the pool refused', () => {
    it('is ticked when a slot frees in another Session, oldest first, until no slot is free', async () => {
      const { pool, root, nodes: [a, b] } = tree(1, 2);
      const held = granted(pool.take(root, task('x')));
      expect(pool.take(a, task('a1'))).toHaveProperty('refused');
      expect(pool.take(b, task('b1'))).toHaveProperty('refused');
      a.tick.mockImplementation(async () => { granted(pool.take(a, task('a1'))); });

      held.free();
      await flushed();

      expect(a.tick).toHaveBeenCalledTimes(1);
      // The first took the slot: the next is not ticked for it.
      expect(b.tick).not.toHaveBeenCalled();
      expect(pool.refusal(b, task('b1'))).not.toBeNull();
    });

    it('goes on to the next when the oldest takes nothing, so one that no longer wants the slot strands nobody', async () => {
      const { pool, root, nodes: [a, b] } = tree(1, 2);
      const held = granted(pool.take(root, task('x')));
      pool.take(a, task('a1'));
      pool.take(b, task('b1'));
      held.free();
      await flushed();
      expect(a.tick).toHaveBeenCalledTimes(1);
      expect(b.tick).toHaveBeenCalledTimes(1);
    });

    it('keeps a Session once, however many of its tasks were refused', async () => {
      const { pool, root, nodes: [child] } = tree(1);
      const held = granted(pool.take(root, task('x')));
      pool.take(child, task('a'));
      pool.take(child, task('b'));
      held.free();
      await flushed();
      expect(child.tick).toHaveBeenCalledTimes(1);
    });

    it('offers the next as soon as a tick has taken its slot, not when its spawn has settled', async () => {
      const { pool, root, nodes: [a, b] } = tree(2, 2);
      const held = [granted(pool.take(root, task('x'))), granted(pool.take(root, task('y')))];
      pool.take(a, task('a1'));
      pool.take(b, task('b1'));
      // A runner that takes its time to attach holds its tick open past the claim.
      a.tick.mockImplementation(() => {
        granted(pool.take(a, task('a1')));
        return new Promise<void>(() => undefined);
      });

      held.forEach((h) => h.free());
      await flushed();

      expect(b.tick).toHaveBeenCalledTimes(1);
    });

    it('stops offering to a node that has left', async () => {
      const pool = new SlotPool(() => 1);
      const root = node();
      const child = node();
      const other = node();
      pool.join(root);
      const leave = pool.join(child);
      pool.join(other);
      const held = granted(pool.take(root, task('x')));
      pool.take(child, task('a'));
      leave();
      held.free();
      await flushed();
      expect(child.tick).not.toHaveBeenCalled();
    });
  });

  describe('a subplanner\'s turn', () => {
    it('waits for a slot, and queues ahead of attempts when one frees', async () => {
      const { pool, root, nodes: [a, b] } = tree(1, 2);
      const held = granted(pool.take(root, task('x')));
      expect(pool.take(a, task('a1'))).toHaveProperty('refused');
      expect(pool.take(b, TURN)).toHaveProperty('refused');
      b.openTurn.mockImplementation(() => { granted(pool.take(b, TURN)); });

      held.free();
      await flushed();

      expect(b.openTurn).toHaveBeenCalledTimes(1);
      expect(a.tick).not.toHaveBeenCalled();
    });

    it('is let past the limit when everything that holds a slot waits on a planner', () => {
      const { pool, nodes: [child] } = tree(1);
      granted(pool.take(child, task('a')));
      child.waiting.add('a');
      const turn = granted(pool.take(child, TURN));
      expect(turn.holdsSlot).toBe(true);
    });

    it('stays out while anything that holds a slot is at work', () => {
      const { pool, nodes: [child] } = tree(2);
      granted(pool.take(child, task('a')));
      granted(pool.take(child, task('b')));
      child.waiting.add('a');
      expect(pool.take(child, TURN)).toHaveProperty('refused');
    });

    it('stays out when no attempt waits on it: holding slots on another planner is no claim on this turn', () => {
      const { pool, nodes: [waited, other] } = tree(1, 2);
      granted(pool.take(waited, task('a')));
      waited.waiting.add('a');
      expect(pool.take(other, TURN)).toHaveProperty('refused');
    });

    it('lets one turn past at a time, the oldest one waited on, and reads the test again when it ends', () => {
      const { pool, nodes: [a, b] } = tree(2, 2);
      granted(pool.take(a, task('a1')));
      granted(pool.take(b, task('b1')));
      b.waiting.add('b1');
      // A's turn queued first, while A's attempt was at work.
      expect(pool.take(a, TURN)).toHaveProperty('refused');
      expect(pool.take(b, TURN)).toHaveProperty('refused');
      a.openTurn.mockImplementation(() => { first = granted(pool.take(a, TURN)); });
      b.openTurn.mockImplementation(() => { second = granted(pool.take(b, TURN)); });
      let first: ReturnType<typeof granted> | undefined;
      let second: ReturnType<typeof granted> | undefined;

      a.waiting.add('a1');
      pool.waitsChanged();

      expect(a.openTurn).toHaveBeenCalledTimes(1);
      expect(first).toBeDefined();
      expect(b.openTurn).not.toHaveBeenCalled();

      // The turn past the limit holds no slot anyone waits on, so the next waits for it to end.
      first!.free();
      expect(b.openTurn).toHaveBeenCalledTimes(1);
      expect(second).toBeDefined();
    });

    it('is the most let past the limit: one, however many wait', () => {
      const { pool, nodes } = tree(1, 3);
      const [holder, b, c] = nodes;
      granted(pool.take(holder, task('a')));
      holder.waiting.add('a');
      granted(pool.take(holder, TURN));
      expect(pool.take(b, TURN)).toHaveProperty('refused');
      expect(pool.take(c, TURN)).toHaveProperty('refused');
    });

    it('does not pass a planner with nothing holding a slot: only a full pool of waiting attempts stops the tree', () => {
      const { pool, nodes: [child] } = tree(0);
      expect(pool.take(child, TURN)).toHaveProperty('refused');
    });
  });

  describe('the time a tree is held (ADR-0056 M3)', () => {
  it('counts a limit from when it was found up to its reset, and only once where limits overlap', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const pool = new SlotPool(() => 3);
    const root = node();
    const child = node();
    pool.join(root);
    pool.join(child);
    expect(pool.heldSince(1_000_000)).toBe(0);

    pool.limitFound(child, 'codex', new Date(1_060_000));
    expect(pool.heldSince(1_000_000)).toBe(60_000);
    vi.setSystemTime(1_030_000);
    pool.limitFound(root, 'claude-code', new Date(1_090_000));
    expect(pool.heldSince(1_000_000)).toBe(90_000);

    vi.setSystemTime(2_000_000);
    pool.limitFound(child, 'codex', new Date(2_010_000));
    expect(pool.heldSince(1_000_000)).toBe(100_000);
    expect(pool.heldSince(2_005_000)).toBe(5_000);
    vi.useRealTimers();
  });

  it('holds nothing while no child shares the pool: a flat run has no clock', () => {
    const pool = new SlotPool(() => 3);
    const root = node();
    pool.join(root);
    pool.limitFound(root, 'codex', new Date(Date.now() + 60_000));
    expect(pool.heldSince(0)).toBe(0);
  });
});

describe('a usage limit found by one node', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('holds for the whole tree until it resets, then ticks every node', async () => {
      vi.useFakeTimers({ now: 1_000_000 });
      const { pool, root, nodes: [child] } = tree(3);
      const at = new Date(1_060_000);

      expect(pool.limitFound(child, 'codex', at)).toEqual(at);

      expect([...pool.limited()]).toEqual(['codex']);
      expect(root.limitFound).toHaveBeenCalledWith('codex', at);
      expect(child.limitFound).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);

      expect([...pool.limited()]).toEqual([]);
      expect(root.tick).toHaveBeenCalledTimes(1);
      expect(child.tick).toHaveBeenCalledTimes(1);
    });

    it('resets only once every limit a runner hit has reset', () => {
      vi.useFakeTimers({ now: 1_000_000 });
      const { pool, root, nodes: [child] } = tree(3);
      pool.limitFound(child, 'codex', new Date(1_120_000));
      expect(pool.limitFound(root, 'codex', new Date(1_060_000))).toEqual(new Date(1_120_000));
    });

    it('keys its waits by runner', () => {
      vi.useFakeTimers({ now: 1_000_000 });
      const { pool, root, nodes: [child] } = tree(3);
      pool.limitFound(child, 'codex', new Date(1_060_000));
      pool.limitFound(root, 'claude-code', new Date(1_060_000));
      expect([...pool.limited()].sort()).toEqual(['claude-code', 'codex']);
    });

    it('in a flat run stays the Session\'s own: no wait of the tree\'s is armed', () => {
      const pool = new SlotPool(() => 1);
      const root = node();
      pool.join(root);
      const at = new Date(Date.now() + 60_000);
      expect(pool.limitFound(root, 'codex', at)).toEqual(at);
      expect([...pool.limited()]).toEqual([]);
    });
  });
});
