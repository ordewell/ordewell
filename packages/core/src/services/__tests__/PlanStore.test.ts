import { describe, it, expect, beforeEach } from 'vitest';
import { PlanStore } from '../PlanStore';
import { createTask } from '../../models/Task';
import type { TaskSnapshot } from '../../models/Task';

function makeSnapshot(taskId: string, overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  const task = createTask({ id: taskId, title: taskId });
  return {
    ...task,
    completedAt: 1700000000000,
    retryCount: 0,
    finalized: false,
    ...overrides,
  };
}

describe('PlanStore execution log', () => {
  let store: PlanStore;

  beforeEach(() => {
    store = new PlanStore();
  });

  it('starts with an empty execution log', () => {
    expect(store.getExecutionLog()).toEqual([]);
  });

  describe('appendToLog', () => {
    it('appends a snapshot to the log', () => {
      const snap = makeSnapshot('task-1');
      store.appendToLog(snap);
      expect(store.getExecutionLog()).toHaveLength(1);
      expect(store.getExecutionLog()[0].id).toBe('task-1');
    });

    it('deduplicates by task ID keeping the latest', () => {
      const first = makeSnapshot('task-1', { completedAt: 1, retryCount: 0 });
      const second = makeSnapshot('task-1', { completedAt: 2, retryCount: 1, finalized: true });
      store.appendToLog(first);
      store.appendToLog(second);
      expect(store.getExecutionLog()).toHaveLength(1);
      expect(store.getExecutionLog()[0].completedAt).toBe(2);
      expect(store.getExecutionLog()[0].retryCount).toBe(1);
    });

    it('keeps snapshots for different task IDs', () => {
      store.appendToLog(makeSnapshot('task-1'));
      store.appendToLog(makeSnapshot('task-2'));
      expect(store.getExecutionLog()).toHaveLength(2);
    });
  });

  describe('clearLog', () => {
    it('resets the execution log', () => {
      store.appendToLog(makeSnapshot('task-1'));
      expect(store.getExecutionLog()).toHaveLength(1);
      store.clearLog();
      expect(store.getExecutionLog()).toEqual([]);
    });
  });

  describe('load preserves execution log', () => {
    it('rebuilds taskMap but does not clear the execution log', () => {
      store.appendToLog(makeSnapshot('task-1'));
      const task = createTask({ id: 'task-a', title: 'A' });
      store.load([task], ['claude-code']);

      expect(store.get('task-a')).toBeDefined();
      expect(store.getExecutionLog()).toHaveLength(1);
      expect(store.getExecutionLog()[0].id).toBe('task-1');
    });
  });

  describe('completedTasks survive removeFromActive', () => {
    it('keeps isCompleted true for a completed task after removeFromActive + rebuild', () => {
      const t1 = createTask({ id: 't1', title: 'Task 1' });
      const t2 = createTask({ id: 't2', title: 'Task 2', dependencies: ['t1'] });
      store.load([t1, t2], ['claude-code']);

      store.markCompleted('t1');
      expect(store.isCompleted('t1')).toBe(true);

      store.removeFromActive('t1');
      expect(store.get('t1')).toBeUndefined();
      expect(store.planTasks.find(t => t.id === 't1')).toBeUndefined();

      expect(store.isCompleted('t1')).toBe(true);
    });
  });

  describe('structural removals prune terminal sets', () => {
    it('remove() drops the task from completedTasks', () => {
      const t1 = createTask({ id: 't1', title: 'Task 1' });
      const t2 = createTask({ id: 't2', title: 'Task 2' });
      store.load([t1, t2], ['claude-code']);
      store.markCompleted('t1');

      store.remove('t1');

      expect(store.isCompleted('t1')).toBe(false);
      expect(store.completedCount).toBe(0);
    });

    it('remove() drops the task from failedTasks', () => {
      const t1 = createTask({ id: 't1', title: 'Task 1' });
      const t2 = createTask({ id: 't2', title: 'Task 2' });
      store.load([t1, t2], ['claude-code']);
      store.markFailed('t1');

      store.remove('t1');

      expect(store.isFailed('t1')).toBe(false);
      expect(store.isAnyFailed()).toBe(false);
    });

    it('merge() drops both original ids from the terminal sets', () => {
      const t1 = createTask({ id: 't1', title: 'Task 1' });
      const t2 = createTask({ id: 't2', title: 'Task 2' });
      store.load([t1, t2], ['claude-code']);
      store.markCompleted('t1');
      store.markFailed('t2');

      store.merge('t1', 't2');

      expect(store.isCompleted('t1')).toBe(false);
      expect(store.isFailed('t2')).toBe(false);
    });
  });
});

describe('PlanStore.resetForRun', () => {
  let store: PlanStore;

  beforeEach(() => {
    store = new PlanStore();
  });

  it('flips AI tasks to approved but preserves completed ones by default', () => {
    store.load([
      createTask({ id: 'a', title: 'A', status: 'completed' }),
      createTask({ id: 'b', title: 'B', status: 'pending' }),
      createTask({ id: 'c', title: 'C', status: 'failed' }),
    ], ['claude-code']);

    store.resetForRun();

    expect(store.get('a')!.status).toBe('completed');
    expect(store.get('b')!.status).toBe('approved');
    expect(store.get('c')!.status).toBe('approved');
  });

  it('re-approves everything for a fresh plan commit with preserveCompleted: false', () => {
    store.load([
      createTask({ id: 'a', title: 'A', status: 'completed' }),
      createTask({ id: 'b', title: 'B', status: 'pending' }),
    ], ['claude-code']);
    // load() records 'a' as completed; a fresh commit starts the run over.
    store.resetForRun({ preserveCompleted: false });

    expect(store.get('a')!.status).toBe('approved');
    expect(store.get('b')!.status).toBe('approved');
  });

  it('leaves user tasks untouched', () => {
    store.load([
      createTask({ id: 'a', title: 'A', type: 'user', status: 'pending' }),
      createTask({ id: 'b', title: 'B', status: 'pending' }),
    ], ['claude-code']);

    store.resetForRun();

    expect(store.get('a')!.status).toBe('pending');
    expect(store.get('b')!.status).toBe('approved');
  });
});
