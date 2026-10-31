import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { SessionEventRelay } from '../SessionEventRelay';
import { PlanStore } from '../PlanStore';
import { PlannerUsageLedger } from '../PlannerUsage';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { Escalation } from '../escalations';

function plan(): LegacyPlanState {
  return { tasks: [], generatedAt: '2026-01-01T00:00:00Z', status: 'approved', runners: ['claude-code'], lastUpdated: '2026-01-01T00:00:00Z' };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A wave of failures adds one escalation per failed task, as Session.escalations
 * does. Every status update carries the whole plan and every failure so far, so
 * one per failure costs what the square of the wave does.
 */
describe('a wave of failures', () => {
  function wave() {
    const sent: { type: string }[] = [];
    const told: (readonly string[])[] = [];
    const store = new PlanStore();
    const tasks = Array.from({ length: 100 }, (_, i) => createTask({ id: `t${i + 1}`, order: i + 1, title: `T${i + 1}`, prompt: 'x' }));
    store.load(tasks, ['claude-code']);
    const failed: string[] = [];
    const escalations = vi.fn((): Escalation[] => failed.map((id) => ({ id: `failed:${id}:1`, kind: 'failed', reason: 'It failed.', options: [] })));
    const relay = new SessionEventRelay({
      broadcast: (message) => sent.push(message),
      store,
      orchestrator: {
        judgingOnce: (read) => read(), getIdleSince: () => null, getCompletionReceipt: () => null,
        getToolsAttaching: () => null, getQueuedTaskMessages: () => [], getMergeGate: () => [],
        holdReason: () => null, loopStranded: () => false, runMergeView: () => null,
        activity: { starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: false },
        taskIsolation: () => null,
      },
      usage: new PlannerUsageLedger(),
      escalations,
      escalationsSent: (list) => told.push(list.map((e) => e.id)),
    });
    const p = plan();
    const observer = relay.observer(() => p);
    relay.status(p);
    sent.length = 0;
    told.length = 0;
    const fail = (id: string) => {
      failed.push(id);
      store.markFailed(id);
    };
    const statuses = () => sent.filter((message) => message.type === 'status_update').length;
    return { sent, told, tasks, observer, escalations, fail, statuses };
  }

  it('does not send a whole status per failure in the wave', () => {
    const { tasks, observer, fail, statuses } = wave();

    for (const task of tasks) {
      fail(task.id);
      observer.onTaskChanged();
    }

    expect(statuses()).toBeLessThanOrEqual(2);
  });

  it('sends the first failure at once and the rest when the second ends', () => {
    const { tasks, observer, fail, statuses, told } = wave();

    for (const task of tasks) {
      fail(task.id);
      observer.onTaskChanged();
    }
    expect(statuses()).toBe(1);
    expect(told).toHaveLength(1);
    expect(told[0]).toEqual(['failed:t1:1']);

    vi.advanceTimersByTime(1000);
    expect(statuses()).toBe(2);
    expect(told.at(-1)).toHaveLength(100);
  });

  it('stops judging the list once the second has sent its one change', () => {
    const { tasks, observer, fail, escalations } = wave();
    fail('t1');
    observer.onTaskChanged();
    escalations.mockClear();

    for (const task of tasks.slice(1)) {
      fail(task.id);
      observer.onTaskChanged();
    }

    expect(escalations).not.toHaveBeenCalled();
  });

  it('keeps to one a second while the wave lasts, and is prompt again when it is over', () => {
    const { tasks, observer, fail, statuses } = wave();

    for (const task of tasks.slice(0, 50)) {
      fail(task.id);
      observer.onTaskChanged();
      vi.advanceTimersByTime(100);
    }
    expect(statuses()).toBeLessThanOrEqual(6);

    vi.advanceTimersByTime(3000);
    const before = statuses();
    fail('t51');
    observer.onTaskChanged();
    expect(statuses()).toBe(before + 1);
  });

  it('holds back the worktree each failure gives up the same way', () => {
    const { tasks, observer, fail, statuses } = wave();

    for (const task of tasks) {
      fail(task.id);
      observer.onTaskChanged();
      observer.onIsolationChanged();
    }

    expect(statuses()).toBe(1);
  });

  it('tells of each checkpoint in a wave of them, with no status of its own past the first', () => {
    const { tasks, sent, observer, fail, statuses } = wave();

    for (const task of tasks) {
      fail(task.id);
      observer.onTaskChanged();
      observer.onCheckpoint({ taskId: task.id, taskTitle: task.title, summary: 'ok?' });
    }

    expect(statuses()).toBe(1);
    expect(sent.filter((message) => message.type === 'checkpoint')).toHaveLength(100);
  });
});
