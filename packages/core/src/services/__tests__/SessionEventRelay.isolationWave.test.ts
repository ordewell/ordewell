import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { SessionEventRelay } from '../SessionEventRelay';
import { PlanStore } from '../PlanStore';
import { PlannerUsageLedger } from '../PlannerUsage';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { RunMergeView, SessionMessage } from '../SessionMessage';
import type { Escalation } from '../escalations';

function plan(): LegacyPlanState {
  return { tasks: [], generatedAt: '2026-01-01T00:00:00Z', status: 'approved', runners: ['claude-code'], lastUpdated: '2026-01-01T00:00:00Z' };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/**
 * Every isolated task's landing and worktree release reports
 * `onIsolationChanged` (IsolationRunController), and each status carries every
 * task. A wide, healthy run must not send one full plan per report — the storm
 * the coalescing exists to stop — yet new work to merge must not wait a second.
 */
describe('a run of landings', () => {
  function run() {
    const sent: SessionMessage[] = [];
    const store = new PlanStore();
    store.load(Array.from({ length: 100 }, (_, i) => createTask({ id: `t${i + 1}`, order: i + 1, title: `T${i + 1}`, prompt: 'x' })), ['claude-code']);
    const landed: string[] = [];
    const waits: Escalation[] = [];
    const runMergeView = (): RunMergeView | null => (landed.length === 0 ? null : {
      waitingAtGate: false, paused: false, repos: [], landed: landed.map((taskId, i) => ({ taskId, order: i + 1, title: taskId })),
    });
    const relay = new SessionEventRelay({
      broadcast: (message) => sent.push(message),
      store,
      orchestrator: {
        judgingOnce: (read) => read(), getIdleSince: () => null, getCompletionReceipt: () => null,
        getToolsAttaching: () => null, getQueuedTaskMessages: () => [], getMergeGate: () => [],
        holdReason: () => null, loopStranded: () => false, runMergeView,
        activity: { starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: false },
        taskIsolation: () => null,
      },
      usage: new PlannerUsageLedger(),
      escalations: () => waits,
    });
    const p = plan();
    const observer = relay.observer(() => p);
    relay.status(p);
    sent.length = 0;
    const statuses = () => sent.filter((message): message is Extract<SessionMessage, { type: 'status_update' }> => message.type === 'status_update');
    /** As `IsolationRunController` reports it: the landing set, the landing settled, the worktree let go. */
    const land = (id: string) => {
      observer.onIsolationChanged();
      landed.push(id);
      observer.onIsolationChanged();
      observer.onIsolationChanged();
    };
    return { observer, land, statuses, waits };
  }

  it('does not send a whole status per landing and release', () => {
    const { observer, statuses } = run();

    // A fan-out's tasks let their worktrees go, and nothing waits on a person.
    for (let i = 0; i < 100; i++) observer.onIsolationChanged();
    expect(statuses().length).toBeLessThanOrEqual(2);

    vi.advanceTimersByTime(1000);
    expect(statuses().length).toBeLessThanOrEqual(2);
  });

  it('sends the first landing at once, and the rest of the wave by the end of the second', () => {
    const { land, statuses } = run();

    for (let i = 0; i < 100; i++) land(`t${i + 1}`);
    expect(statuses()).toHaveLength(1);
    expect(statuses()[0].runMerge?.landed.map((t) => t.taskId)).toEqual(['t1']);

    vi.advanceTimersByTime(1000);
    expect(statuses()).toHaveLength(2);
    expect(statuses()[1].runMerge?.landed).toHaveLength(100);
  });

  it('is prompt again for the next landing when the wave is over', () => {
    const { land, statuses } = run();
    land('t1');
    land('t2');

    vi.advanceTimersByTime(3000);
    land('t3');

    expect(statuses().at(-1)?.runMerge?.landed.map((t) => t.taskId)).toEqual(['t1', 't2', 't3']);
  });

  it('still sends a conflict that waits on a person at once, whatever landed in the second', () => {
    const { observer, land, statuses, waits } = run();
    land('t1');
    land('t2');
    const before = statuses().length;

    waits.push({ id: 'conflict:t3:1', kind: 'conflict', reason: 'It conflicts.', options: [] });
    observer.onIsolationChanged();

    expect(statuses()).toHaveLength(before + 1);
    expect(statuses().at(-1)?.escalations?.map((e) => e.id)).toEqual(['conflict:t3:1']);
  });
});
