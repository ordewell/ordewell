import { describe, it, expect } from 'vitest';
import { checkUniqueIds, checkNoCycles, checkDepsResolve, checkImmutableLog, checkInProgress, validatePlanModification } from '../PlanValidator';
import { createTask } from '../../models/Task';
import type { Task, TaskSnapshot } from '../../models/Task';

function task(overrides: Partial<Task> = {}): Task {
  return createTask({ id: 'task-1', order: 1, title: 'Test', ...overrides });
}

function snap(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    ...createTask({ id: 'snap-1', order: 1, title: 'Snap', status: 'completed', ...overrides }),
    completedAt: Date.now(),
    retryCount: 0,
    finalized: true,
    ...overrides,
  };
}

describe('checkUniqueIds', () => {
  it('passes when all task IDs are unique', () => {
    const result = checkUniqueIds({
      executionLog: [snap({ id: 'log-1' })],
      oldPending: [task({ id: 'old-1' })],
      newPending: [task({ id: 'new-1' }), task({ id: 'new-2' })],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when newPending has duplicate IDs', () => {
    const result = checkUniqueIds({
      executionLog: [],
      oldPending: [],
      newPending: [task({ id: 'dup' }), task({ id: 'dup' })],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['Duplicate task ID in modified plan: dup']);
  });
});

describe('checkNoCycles', () => {
  it('passes when there are no cycles (tree structure)', () => {
    const result = checkNoCycles({
      executionLog: [],
      oldPending: [],
      newPending: [
        task({ id: 'a', dependencies: [] }),
        task({ id: 'b', dependencies: ['a'] }),
        task({ id: 'c', dependencies: ['a'] }),
      ],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes for parallel tasks with no dependencies', () => {
    const result = checkNoCycles({
      executionLog: [],
      oldPending: [],
      newPending: [
        task({ id: 'a', dependencies: [] }),
        task({ id: 'b', dependencies: [] }),
        task({ id: 'c', dependencies: [] }),
      ],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(true);
  });

  it('detects a simple A→B→A cycle', () => {
    const result = checkNoCycles({
      executionLog: [],
      oldPending: [],
      newPending: [
        task({ id: 'a', dependencies: ['b'] }),
        task({ id: 'b', dependencies: ['a'] }),
      ],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/cycle/i);
  });

  it('detects a longer A→B→C→A cycle', () => {
    const result = checkNoCycles({
      executionLog: [],
      oldPending: [],
      newPending: [
        task({ id: 'a', dependencies: ['b'] }),
        task({ id: 'b', dependencies: ['c'] }),
        task({ id: 'c', dependencies: ['a'] }),
      ],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('passes for self-dependencies (not a cycle through other tasks)', () => {
    const result = checkNoCycles({
      executionLog: [],
      oldPending: [],
      newPending: [
        task({ id: 'a', dependencies: ['b'] }),
        task({ id: 'b', dependencies: [] }),
      ],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(true);
  });
});

describe('checkDepsResolve', () => {
  it('passes when all dependencies exist in newPending', () => {
    const result = checkDepsResolve({
      executionLog: [],
      oldPending: [],
      newPending: [
        task({ id: 'a', dependencies: [] }),
        task({ id: 'b', dependencies: ['a'] }),
      ],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes when dependency exists in executionLog', () => {
    const result = checkDepsResolve({
      executionLog: [snap({ id: 'completed-task' })],
      oldPending: [],
      newPending: [
        task({ id: 'b', dependencies: ['completed-task'] }),
      ],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(true);
  });

  it('fails when a dependency ID does not exist anywhere', () => {
    const result = checkDepsResolve({
      executionLog: [],
      oldPending: [],
      newPending: [
        task({ id: 'a', title: 'a', dependencies: ['nonexistent'] }),
      ],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['Task "a" depends on "nonexistent" which is not in the execution log or pending tasks']);
  });

  it('reports all missing dependencies', () => {
    const result = checkDepsResolve({
      executionLog: [],
      oldPending: [],
      newPending: [
        task({ id: 'a', title: 'a', dependencies: ['x', 'y'] }),
        task({ id: 'b', title: 'b', dependencies: ['z'] }),
      ],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(3);
  });
});

describe('checkImmutableLog', () => {
  it('passes when no executionLog task IDs appear in newPending', () => {
    const result = checkImmutableLog({
      executionLog: [snap({ id: 'log-1' })],
      oldPending: [],
      newPending: [task({ id: 'new-1' })],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes when same ID appears as a retry of a failed task', () => {
    const result = checkImmutableLog({
      executionLog: [snap({ id: 'task-1', status: 'failed', finalized: true })],
      oldPending: [],
      newPending: [task({ id: 'task-1', status: 'pending' })],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(true);
  });

  it('fails when a completed executionLog task ID appears in newPending', () => {
    const result = checkImmutableLog({
      executionLog: [snap({ id: 'task-1', status: 'completed', finalized: true })],
      oldPending: [],
      newPending: [task({ id: 'task-1' })],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/task-1.*completed.*re-added/i);
  });

  it('passes with empty executionLog', () => {
    const result = checkImmutableLog({
      executionLog: [],
      oldPending: [],
      newPending: [task({ id: 'a' })],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(true);
  });
});

describe('checkInProgress', () => {
  it('passes when in-progress tasks remain unchanged', () => {
    const result = checkInProgress({
      executionLog: [],
      oldPending: [task({ id: 'ip-1', status: 'in_progress', title: 'Build', prompt: 'build it' })],
      newPending: [task({ id: 'ip-1', status: 'in_progress', title: 'Build', prompt: 'build it' })],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes when no in-progress tasks exist', () => {
    const result = checkInProgress({
      executionLog: [],
      oldPending: [task({ id: 'p1', status: 'pending' })],
      newPending: [task({ id: 'p1', status: 'pending' }), task({ id: 'p2', status: 'pending' })],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(true);
  });

  it('fails when an in-progress task is removed', () => {
    const result = checkInProgress({
      executionLog: [],
      oldPending: [task({ id: 'ip-1', status: 'in_progress', title: 'Build' })],
      newPending: [],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['In-progress task "Build" was removed from the modified plan']);
  });

  it('fails when an in-progress task prompt was modified', () => {
    const result = checkInProgress({
      executionLog: [],
      oldPending: [task({ id: 'ip-1', status: 'in_progress', title: 'Build', prompt: 'original' })],
      newPending: [task({ id: 'ip-1', status: 'in_progress', title: 'Build', prompt: 'changed' })],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/in.*progress.*Build.*modified/i);
  });

  it('fails when an in-progress task model was changed', () => {
    const result = checkInProgress({
      executionLog: [],
      oldPending: [task({ id: 'ip-1', status: 'in_progress', title: 'Build', assignedModel: { modelId: 'old', modelLabel: 'Old' } })],
      newPending: [task({ id: 'ip-1', status: 'in_progress', title: 'Build', assignedModel: { modelId: 'new', modelLabel: 'New' } })],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/in.*progress.*Build.*modified/i);
  });

  it('passes when in-progress task order changes (non-destructive)', () => {
    const result = checkInProgress({
      executionLog: [],
      oldPending: [task({ id: 'ip-1', status: 'in_progress', title: 'Build', order: 1 })],
      newPending: [task({ id: 'ip-1', status: 'in_progress', title: 'Build', order: 5 })],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(true);
  });
});

describe('validatePlanModification', () => {
  it('passes for a valid plan modification', () => {
    const result = validatePlanModification({
      executionLog: [snap({ id: 'log-1', status: 'completed', finalized: true })],
      oldPending: [task({ id: 'p1', status: 'pending', dependencies: [] })],
      newPending: [task({ id: 'p1', status: 'pending', dependencies: ['log-1'] }), task({ id: 'p2', status: 'pending' })],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accumulates errors from multiple checks', () => {
    const result = validatePlanModification({
      executionLog: [snap({ id: 'log-1', status: 'completed', finalized: true })],
      oldPending: [task({ id: 'ip-1', status: 'in_progress', title: 'Build', prompt: 'original' })],
      newPending: [
        task({ id: 'new-1', title: 'a', dependencies: ['nonexistent'] }),
        task({ id: 'log-1' }), // immutable log violation: completed task re-added
      ],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(3); // deps missing, immutable log, in-progress removed
  });

  it('passes when a failed task is retried with same ID', () => {
    const result = validatePlanModification({
      executionLog: [snap({ id: 'task-1', status: 'failed', finalized: true })],
      oldPending: [],
      newPending: [task({ id: 'task-1', status: 'pending' })],
      activeSessions: new Map(),
    });
    expect(result.valid).toBe(true);
  });
});
