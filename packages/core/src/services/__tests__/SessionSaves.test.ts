import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegacyPlanState } from '../../models/Task';
import type { SessionHeld } from '../sessionLease';
import { SessionSaves } from '../SessionSaves';

const plan: LegacyPlanState = {
  tasks: [],
  generatedAt: '2026-01-01T00:00:00Z',
  status: 'draft',
  runners: ['claude-code'],
  lastUpdated: '2026-01-01T00:00:00Z',
};

const otherHost = (hostId: string): SessionHeld => ({
  holder: { hostId, pid: 4242, since: '2026-01-01T00:00:00Z', heartbeatAt: '2026-01-01T00:00:00Z', runnerGroups: [] },
});

/** A Session's side of the seam: a plan store whose revision and statuses the test moves, and a status relay that records what it sent. */
function harness() {
  const store = { revision: 1, statuses: 'a', statusMark() { return this.statuses; } };
  const sent: string[] = [];
  let holding = false;
  let owed = false;
  const status = {
    get holdingStatus() { return holding; },
    holdStatus<T>(op: () => T): T {
      holding = true;
      try {
        return op();
      } finally {
        holding = false;
      }
    },
    releaseStatus: () => {
      if (owed) sent.push('status');
      owed = false;
    },
    flushStatus: () => {
      if (owed) sent.push('status');
      owed = false;
    },
  };
  const write = vi.fn<(saved: LegacyPlanState) => void>(() => sent.push('save'));
  const notice = vi.fn<(message: string) => void>();
  const deps = { plan: (): LegacyPlanState | null => plan, write, heldElsewhere: (): SessionHeld | null => null, store, status, notice };
  const saves = new SessionSaves(deps);
  saves.loaded();
  const refuse = () => write.mockImplementation(() => { throw new Error('disk full'); });
  const statusMoved = () => {
    store.revision++;
    store.statuses += '+';
    owed = true;
  };
  return { saves, deps, store, write, notice, sent, refuse, statusMoved, oweStatus: () => { owed = true; } };
}

describe('SessionSaves', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refuses the act a save it depends on is refused for', () => {
    const { saves, refuse } = harness();
    refuse();
    expect(() => saves.first()).toThrow('disk full');
  });

  it('never throws a save made after the act, and says a failing stretch once until a save lands', () => {
    const { saves, write, notice, refuse } = harness();
    refuse();
    expect(() => saves.after()).not.toThrow();
    saves.after();
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0][0]).toMatch(/could not be saved: disk full/);

    write.mockImplementation(() => {});
    saves.after();
    refuse();
    saves.after();
    expect(notice).toHaveBeenCalledTimes(2);
  });

  it('says the next failure after a stop, whatever was said before', () => {
    const { saves, notice, refuse } = harness();
    refuse();
    saves.after();
    saves.sayNextFailure();
    saves.after();
    expect(notice).toHaveBeenCalledTimes(2);
  });

  it('saves a moved status at once when none was saved in the second before, and paces the next to the second', () => {
    const { saves, write, statusMoved } = harness();
    vi.setSystemTime(10_000);
    statusMoved();
    saves.owed('status');
    expect(write).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(300);
    statusMoved();
    saves.owed('status');
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(699);
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('owes nothing for a status the disk already has', () => {
    const { saves, write } = harness();
    saves.owed('status');
    vi.advanceTimersByTime(10_000);
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps a change beside the statuses, and usage, for five seconds, saved once however often it is owed', () => {
    const { saves, write, store } = harness();
    store.revision++;
    saves.owed('status');
    saves.owed('usage');
    saves.owed('usage');
    vi.advanceTimersByTime(4_999);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('leaves a status moved inside a hold to whoever holds it', () => {
    const { saves, write, statusMoved } = harness();
    saves.mutation(() => {
      statusMoved();
      saves.owed('status');
      expect(write).not.toHaveBeenCalled();
      return true;
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('saves every status a control announces at once, then sends what it held back', async () => {
    const { saves, write, sent, statusMoved } = harness();
    vi.setSystemTime(10_000);
    await saves.control(async () => {
      statusMoved();
      saves.owed('status');
      statusMoved();
      saves.owed('status');
    });
    expect(write).toHaveBeenCalledTimes(3);
    expect(sent.at(-1)).toBe('status');
  });

  it('answers a control that took as done when its save is refused', async () => {
    const { saves, notice, refuse } = harness();
    refuse();
    await expect(saves.control(async () => 'stopped')).resolves.toBe('stopped');
    expect(saves.sync(() => 'paused')).toBe('paused');
    expect(notice).toHaveBeenCalledTimes(1);
  });

  it('saves a synchronous control before its status goes', () => {
    const { saves, sent, oweStatus } = harness();
    saves.sync(oweStatus);
    expect(sent).toEqual(['save', 'status']);
  });

  it('makes one save of all an act asks for, even when the act throws', () => {
    const { saves, write } = harness();
    saves.once(() => {
      saves.first();
      saves.after();
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(() => saves.once(() => { throw new Error('boom'); })).toThrow('boom');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('saves a mutation that changed something before its status goes, and holds back one the disk refused', () => {
    const { saves, sent, refuse, oweStatus } = harness();
    expect(saves.mutation(() => { oweStatus(); return true; })).toBe(true);
    expect(sent).toEqual(['save', 'status']);

    expect(saves.mutation(() => false)).toBe(false);
    expect(sent).toEqual(['save', 'status']);

    refuse();
    expect(() => saves.mutation(() => { oweStatus(); return true; })).toThrow('disk full');
    expect(sent).toEqual(['save', 'status']);
  });

  it('says a mutation\'s refused save, rather than throwing it, for one that has already taken effect', () => {
    const { saves, sent, notice, refuse, oweStatus } = harness();
    refuse();
    expect(saves.mutation(() => { oweStatus(); return true; }, 'after')).toBe(true);
    expect(sent).toEqual(['status']);
    expect(notice).toHaveBeenCalledTimes(1);
  });

  it('writes nothing over the host that holds the session, and says so once for each such host', () => {
    const { saves, deps, write, notice } = harness();
    let held: SessionHeld | null = otherHost('h1');
    deps.heldElsewhere = () => held;
    saves.first();
    saves.after();
    expect(write).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0][0]).toMatch(/Nothing of this session is saved from here/);

    held = otherHost('h2');
    saves.after();
    expect(notice).toHaveBeenCalledTimes(2);

    saves.heldBy(otherHost('h3'));
    held = otherHost('h3');
    saves.after();
    expect(notice).toHaveBeenCalledTimes(2);
  });

  it('writes nothing once there is no plan to save', () => {
    const { saves, deps, write, store } = harness();
    deps.plan = () => null;
    store.revision++;
    saves.owed('usage');
    saves.first();
    vi.advanceTimersByTime(10_000);
    expect(write).not.toHaveBeenCalled();
  });

  it('makes the save owed when settled, and nothing when none is', () => {
    const { saves, write, store } = harness();
    saves.settle();
    expect(write).not.toHaveBeenCalled();
    store.revision++;
    saves.owed('usage');
    saves.settle();
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
