import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegacyPlanState } from '../../models/Task';
import type { SessionHeld } from '../sessionLease';
import { SessionSaves, type RunControls, type SavedEvent } from '../SessionSaves';
import type { OrchestratorObserver } from '../TaskOrchestrator';

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

/** A Session's side of the seam: a plan store whose revision and statuses the test moves, and a status gate that records what it sent. */
function harness() {
  const store = { revision: 1, statuses: 'a', statusMark() { return this.statuses; } };
  const sent: string[] = [];
  let owed = false;
  const status = {
    holdStatus: <T>(op: () => T): T => op(),
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
  saves.load(() => {}, () => {}, false);
  const refuse = () => write.mockImplementation(() => { throw new Error('disk full'); });
  const statusMoved = () => {
    store.revision++;
    store.statuses += '+';
    owed = true;
  };
  return { saves, deps, store, write, notice, sent, refuse, statusMoved, oweStatus: () => { owed = true; } };
}

/** Every orchestrator event with no data, as the table names them, with what the one that takes some is given. */
const settled = { taskId: 't1' };
const fire = (observer: OrchestratorObserver, event: SavedEvent): void => {
  if (event === 'onTaskSettled') observer.onTaskSettled?.(settled);
  else if (event === 'onRunStarted') observer.onRunStarted?.({ origin: 'user' });
  else observer[event]?.();
};

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

  describe('the orchestrator\'s run controls', () => {
    /** The orchestrator's side: each control owes a status and keeps what it was asked on its own `this`. */
    function orchestrator(oweStatus: () => void) {
      return {
        asked: [] as unknown[][],
        async retryTask(taskId: string, origin: string) { this.asked.push(['retryTask', taskId, origin]); oweStatus(); },
        sendTaskMessage(taskId: string, text: string) { this.asked.push(['sendTaskMessage', taskId, text]); oweStatus(); return 'm1'; },
      };
    }

    it('saves an asynchronous control once it has acted, then sends its status at once', async () => {
      const { saves, sent, oweStatus } = harness();
      const fake = orchestrator(oweStatus);
      const controls = saves.controls(fake as unknown as RunControls);

      const acting = controls.retryTask('t1', 'user');
      expect(sent).toEqual([]);
      await acting;

      expect(fake.asked).toEqual([['retryTask', 't1', 'user']]);
      expect(sent).toEqual(['save', 'status']);
    });

    it('holds a synchronous control\'s status until its save, and answers what the control did', () => {
      const { saves, sent, oweStatus } = harness();
      const fake = orchestrator(oweStatus);

      expect(saves.controls(fake as unknown as RunControls).sendTaskMessage('t1', 'go on')).toBe('m1');
      expect(fake.asked).toEqual([['sendTaskMessage', 't1', 'go on']]);
      expect(sent).toEqual(['save', 'status']);
    });
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

  describe('what an orchestrator event owes the disk', () => {
    /** An observer that records each announcement beside the saves, and effects that record theirs. */
    function observed(env: ReturnType<typeof harness>) {
      const announce = (name: string) => () => { env.sent.push(`announce ${name}`); };
      const effect = (name: string) => () => { env.sent.push(`effect ${name}`); };
      const events: SavedEvent[] = ['onTaskChanged', 'onTick', 'onUsageChanged', 'onIsolationChanged', 'onScriptClaimed', 'onRunStarted', 'onExecutionComplete', 'onTaskSettled'];
      const announced = Object.fromEntries(events.map((e) => [e, announce(e)]));
      const effects = Object.fromEntries(events.map((e) => [e, effect(e)]));
      return env.saves.observe({ ...announced, onCheckpoint: announce('onCheckpoint') }, effects);
    }

    it.each(['onTaskChanged', 'onTick'] as const)('%s saves a moved status before it is announced, after its effect', (event) => {
      const env = harness();
      vi.setSystemTime(10_000);
      env.store.revision++;
      env.store.statuses += '+';
      fire(observed(env), event);
      expect(env.sent).toEqual([`effect ${event}`, 'save', `announce ${event}`]);
    });

    it('lets usage be announced before the save it owes, which waits for the timer', () => {
      const env = harness();
      env.store.revision++;
      fire(observed(env), 'onUsageChanged');
      expect(env.sent).toEqual(['effect onUsageChanged', 'announce onUsageChanged']);
      vi.advanceTimersByTime(5000);
      expect(env.sent.at(-1)).toBe('save');
    });

    it.each(['onIsolationChanged', 'onScriptClaimed', 'onRunStarted', 'onExecutionComplete'] as const)('%s saves after its effect and before it is announced, unpaced', (event) => {
      const env = harness();
      vi.setSystemTime(10_000);
      env.saves.after();
      env.sent.length = 0;
      fire(observed(env), event);
      expect(env.sent).toEqual([`effect ${event}`, 'save', `announce ${event}`]);
    });

    it('makes one save of all a settled task\'s effect asks for, before the settle is announced', () => {
      const env = harness();
      const observer = env.saves.observe({ onTaskSettled: () => { env.sent.push('announce'); } }, {
        onTaskSettled: (data) => {
          expect(data).toBe(settled);
          env.saves.after();
          env.saves.first();
        },
      });
      fire(observer, 'onTaskSettled');
      expect(env.sent).toEqual(['save', 'announce']);
    });

    it('still saves an event that has no effect, or no announcement', () => {
      const env = harness();
      const observer = env.saves.observe({});
      fire(observer, 'onScriptClaimed');
      fire(observer, 'onTaskSettled');
      expect(env.write).toHaveBeenCalledTimes(2);
    });

    it('hands every other event on untouched, with no save', () => {
      const env = harness();
      const observer = observed(env);
      observer.onCheckpoint?.({ taskId: 't1', taskTitle: 'T', summary: '' });
      expect(env.sent).toEqual(['announce onCheckpoint']);
    });

    it('leaves a status moved inside a load to the load', () => {
      const env = harness();
      const observer = observed(env);
      env.saves.load(() => {
        env.statusMoved();
        fire(observer, 'onTaskChanged');
      }, () => {}, true);
      expect(env.sent).toEqual(['effect onTaskChanged', 'announce onTaskChanged', 'save', 'status']);
    });
  });

  describe('a load', () => {
    it('saves what adopting the plan added before the status it held goes', () => {
      const { saves, sent, statusMoved, store } = harness();
      saves.load(statusMoved, () => { store.revision++; sent.push('adopt'); }, true);
      expect(sent).toEqual(['adopt', 'save', 'status']);
    });

    it('saves nothing when its caller says it may not, and still lets the status go', () => {
      const { saves, sent, statusMoved } = harness();
      saves.load(statusMoved, () => {}, false);
      expect(sent).toEqual(['status']);
    });

    it('owes nothing for what it put in the store, and owes what adopting it changed', () => {
      const { saves, write, statusMoved, store } = harness();
      vi.setSystemTime(10_000);
      saves.load(statusMoved, () => {}, false);
      saves.owed('status');
      expect(write).not.toHaveBeenCalled();

      saves.load(statusMoved, () => { store.revision++; }, false);
      saves.owed('status');
      vi.advanceTimersByTime(5000);
      expect(write).toHaveBeenCalledTimes(1);
    });
  });
});
