import { describe, it, expect } from 'vitest';
import { createTask, createEmptyPlan, migrateLegacyPlan, migratePlanState, taskOrderLabel, resolveOrderLabel, flattenTasksWithParents } from '../Task';
import type { LegacyPlanState, PlanState, Message, TaskSnapshot } from '../Task';

describe('LegacyPlanState conversation fields', () => {
  it('createEmptyPlan carries no dialogue or PRD markdown by default', () => {
    const plan = createEmptyPlan();
    expect(plan.conversationHistory).toBeUndefined();
    expect(plan.prdMarkdown).toBeUndefined();
    expect(plan.tasks).toEqual([]);
  });

  it('LegacyPlanState can carry a conversationHistory and prdMarkdown', () => {
    const plan: LegacyPlanState = {
      tasks: [],
      generatedAt: new Date().toISOString(),
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
      conversationHistory: [
        { role: 'user', content: 'add dark mode', timestamp: new Date().toISOString() },
        { role: 'assistant', content: 'Which pages need theming?', timestamp: new Date().toISOString() },
      ],
      prdMarkdown: '# PRD\n...',
    };
    expect(plan.conversationHistory).toHaveLength(2);
    expect(plan.conversationHistory![1].role).toBe('assistant');
    expect(plan.prdMarkdown).toContain('# PRD');
  });
});

describe('createTask', () => {
  it('generates a unique completionMarker UUID for each task', () => {
    const a = createTask({ id: 'a', title: 'First', prompt: 'pa' });
    const b = createTask({ id: 'b', title: 'Second', prompt: 'pb' });

    expect(a.completionMarker).toBeDefined();
    expect(a.completionMarker).toBeTypeOf('string');
    expect(a.completionMarker.length).toBeGreaterThan(0);
    expect(b.completionMarker).toBeDefined();
    expect(b.completionMarker).toBeTypeOf('string');
    expect(a.completionMarker).not.toBe(b.completionMarker);
  });

  it('defaults sliceType to undefined for all task types', () => {
    const ai = createTask({ type: 'ai' });
    const user = createTask({ type: 'user' });
    expect(ai.sliceType).toBeUndefined();
    expect(user.sliceType).toBeUndefined();
  });

  it('defaults userStoriesCovered to undefined for all task types', () => {
    const ai = createTask({ type: 'ai' });
    const user = createTask({ type: 'user' });
    expect(ai.userStoriesCovered).toBeUndefined();
    expect(user.userStoriesCovered).toBeUndefined();
  });

  it('defaults autonomy to undefined for ai tasks', () => {
    const task = createTask({ type: 'ai' });
    expect(task.autonomy).toBeUndefined();
  });

  it('allows setting autonomy on ai tasks', () => {
    const task = createTask({ type: 'ai', autonomy: 'AFK' });
    expect(task.autonomy).toBe('AFK');
  });

  it('allows setting sliceType on any task', () => {
    const ai = createTask({ type: 'ai', sliceType: 'HITL' });
    const user = createTask({ type: 'user', sliceType: 'AFK' });
    expect(ai.sliceType).toBe('HITL');
    expect(user.sliceType).toBe('AFK');
  });

  it('allows setting userStoriesCovered on any task', () => {
    const task = createTask({ type: 'ai', userStoriesCovered: ['US-1', 'US-2'] });
    expect(task.userStoriesCovered).toEqual(['US-1', 'US-2']);
  });
});

describe('taskOrderLabel', () => {
  it('returns the task order alone when no parent is given', () => {
    const task = createTask({ id: 't1', order: 2 });
    expect(taskOrderLabel(task)).toBe('2');
  });

  it('returns parent.order.child.order when a parent is given', () => {
    const parent = createTask({ id: 'p1', order: 2 });
    const subtask = createTask({ id: 'c1', order: 1 });
    expect(taskOrderLabel(subtask, parent)).toBe('2.1');
  });
});

describe('resolveOrderLabel', () => {
  it('round-trips a top-level label', () => {
    const top = createTask({ id: 't1', order: 2 });
    const tasks = [createTask({ id: 't0', order: 1 }), top];
    expect(resolveOrderLabel(tasks, taskOrderLabel(top))).toBe(top);
  });

  it('round-trips a subtask label', () => {
    const child = createTask({ id: 'c1', order: 1 });
    const parent = createTask({ id: 'p1', order: 2, subtasks: [createTask({ id: 'c0', order: 0 }), child] });
    const tasks = [parent, createTask({ id: 't0', order: 1 })];
    expect(resolveOrderLabel(tasks, taskOrderLabel(child, parent))).toBe(child);
  });

  it('returns undefined for a non-existent top-level order', () => {
    const tasks = [createTask({ id: 't1', order: 1 })];
    expect(resolveOrderLabel(tasks, '2')).toBeUndefined();
  });

  it('returns undefined for a subtask under the wrong parent', () => {
    const parent = createTask({ id: 'p1', order: 2, subtasks: [createTask({ id: 'c0', order: 0 })] });
    const tasks = [createTask({ id: 't0', order: 1 }), parent];
    expect(resolveOrderLabel(tasks, '2.1')).toBeUndefined();
  });

  it('returns undefined for non-numeric labels', () => {
    const tasks = [createTask({ id: 't1', order: 1 })];
    expect(resolveOrderLabel(tasks, 'abc')).toBeUndefined();
    expect(resolveOrderLabel(tasks, '1.x')).toBeUndefined();
    expect(resolveOrderLabel(tasks, '')).toBeUndefined();
  });

  it('returns undefined for labels with more than two dotted segments', () => {
    const parent = createTask({ id: 'p1', order: 1, subtasks: [createTask({ id: 'c1', order: 1 })] });
    const tasks = [parent];
    expect(resolveOrderLabel(tasks, '1.1.1')).toBeUndefined();
  });
});

describe('flattenTasksWithParents', () => {
  it('flattens nested tasks with their parent linkage', () => {
    const leaf = createTask({ id: 'leaf', order: 1 });
    const child = createTask({ id: 'child', order: 1, subtasks: [leaf] });
    const parent = createTask({ id: 'parent', order: 1, subtasks: [child] });
    const solo = createTask({ id: 'solo', order: 2 });
    const rows = flattenTasksWithParents([parent, solo]);
    expect(rows.map((r) => r.task.id)).toEqual(['parent', 'child', 'leaf', 'solo']);
    expect(rows[0].parent).toBeNull();
    expect(rows[1].parent?.id).toBe('parent');
    expect(rows[2].parent?.id).toBe('child');
    expect(rows[3].parent).toBeNull();
  });
});

describe('Message', () => {
  it('has id, role, content, timestamp', () => {
    const msg: Message = {
      id: 'msg-1',
      role: 'user',
      content: 'hello',
      timestamp: 1700000000000,
    };
    expect(msg.id).toBe('msg-1');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('hello');
    expect(msg.timestamp).toBe(1700000000000);
  });

  it('supports planner and system roles', () => {
    const plannerMsg: Message = { id: 'm1', role: 'planner', content: 'plan', timestamp: 1 };
    const sysMsg: Message = { id: 'm2', role: 'system', content: 'sys', timestamp: 2 };
    expect(plannerMsg.role).toBe('planner');
    expect(sysMsg.role).toBe('system');
  });
});

describe('TaskSnapshot', () => {
  it('extends Task with completedAt, verdict, retryCount, finalized', () => {
    const task = createTask({ id: 't1', title: 'Test task' });
    const snapshot: TaskSnapshot = {
      ...task,
      completedAt: 1700000000000,
      retryCount: 1,
      finalized: true,
    };
    expect(snapshot.id).toBe('t1');
    expect(snapshot.completedAt).toBe(1700000000000);
    expect(snapshot.verdict).toBeUndefined();
    expect(snapshot.retryCount).toBe(1);
    expect(snapshot.finalized).toBe(true);
  });

  it('defaults retryCount to 0 and finalized to false', () => {
    const task = createTask({ id: 't2' });
    const snapshot: TaskSnapshot = { ...task, completedAt: 1700000000000, retryCount: 0, finalized: false };
    expect(snapshot.retryCount).toBe(0);
    expect(snapshot.finalized).toBe(false);
  });
});

describe('PlanState discriminated union', () => {
  it('planning phase has history, message, pendingTasks', () => {
    const msg: Message = { id: 'm1', role: 'user', content: 'plan this', timestamp: 1 };
    const plan: PlanState = {
      phase: 'planning',
      history: [msg],
      message: 'plan this',
      pendingTasks: [],
    };
    expect(plan.phase).toBe('planning');
    expect(plan.history).toEqual([msg]);
    expect(plan.pendingTasks).toEqual([]);
  });

  it('executing phase has all execution fields', () => {
    const task = createTask({ id: 't1', title: 'Build' });
    const msg: Message = { id: 'm1', role: 'user', content: 'go', timestamp: 1 };
    const plan: PlanState = {
      phase: 'executing',
      history: [msg],
      message: 'go',
      executionLog: [],
      pendingTasks: [task],
      goal: 'build app',
      runners: ['claude-code'],
      status: 'running',
    };
    expect(plan.phase).toBe('executing');
    expect(plan.goal).toBe('build app');
    expect(plan.runners).toEqual(['claude-code']);
    expect(plan.status).toBe('running');
    expect(plan.executionLog).toEqual([]);
    expect(plan.pendingTasks).toEqual([task]);
  });
});

describe('migrateLegacyPlan', () => {
  it('migrates old flat plan to planning phase when status is draft', () => {
    const legacy: LegacyPlanState = {
      tasks: [],
      generatedAt: '2024-01-01T00:00:00.000Z',
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: '2024-01-01T00:00:00.000Z',
    };
    const result = migrateLegacyPlan(legacy);
    expect(result.phase).toBe('planning');
    expect(result.history).toEqual([]);
    expect(result.pendingTasks).toEqual([]);
  });

  it('migrates old flat plan to executing phase when status is running', () => {
    const task = createTask({ id: 't1', title: 'Do it', status: 'pending' });
    const legacy: LegacyPlanState = {
      tasks: [task],
      generatedAt: '2024-01-01T00:00:00.000Z',
      status: 'running',
      runners: ['opencode'],
      lastUpdated: '2024-01-01T00:00:00.000Z',
    };
    const result = migrateLegacyPlan(legacy);
    expect(result.phase).toBe('executing');
    if (result.phase === 'executing') {
      expect(result.goal).toBe('Plan migration');
      expect(result.runners).toEqual(['opencode']);
      expect(result.status).toBe('running');
      expect(result.executionLog).toEqual([]);
      expect(result.pendingTasks).toHaveLength(1);
    }
  });

  it('preserves queuedMessages and researchLog in planning phase history', () => {
    const legacy: LegacyPlanState = {
      tasks: [],
      generatedAt: '2024-01-01T00:00:00.000Z',
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: '2024-01-01T00:00:00.000Z',
      queuedMessages: [{ id: 'qm1', text: 'waiting', timestamp: '2024' }],
      researchLog: [{ id: 'rs1', tool: 'grep', args: 'test', result: 'found', success: true, outcome: 'success', timestamp: '2024' }],
    };
    const result = migrateLegacyPlan(legacy);
    expect(result.phase).toBe('planning');
    expect(result.history).toHaveLength(2);
  });

  it('migrates old flat plan without researchLog to executing phase with empty log', () => {
    const task = createTask({ id: 't1', title: 'Test', status: 'pending' });
    const legacy: LegacyPlanState = {
      tasks: [task],
      generatedAt: '2024-01-01T00:00:00.000Z',
      status: 'running',
      runners: ['claude-code'],
      lastUpdated: '2024-01-01T00:00:00.000Z',
    };
    const result = migrateLegacyPlan(legacy);
    expect(result.phase).toBe('executing');
    if (result.phase === 'executing') {
      expect(result.executionLog).toEqual([]);
      expect(result.runners).toEqual(['claude-code']);
    }
  });
});

describe('migratePlanState', () => {
  it('passes through new PlanState format unchanged', () => {
    const msg: Message = { id: 'm1', role: 'user', content: 'hi', timestamp: 1 };
    const planning: PlanState = {
      phase: 'planning',
      history: [msg],
      message: 'hi',
      pendingTasks: [],
    };
    const result = migratePlanState(planning);
    expect(result.phase).toBe('planning');
    expect(result.history).toEqual([msg]);
    expect(result.pendingTasks).toEqual([]);
  });

  it('migrates old session JSON with completed tasks to executing phase', () => {
    const completed = createTask({ id: 't1', title: 'Done', status: 'completed' });
    const pending = createTask({ id: 't2', title: 'Pending', status: 'pending' });
    const inProgress = createTask({ id: 't3', title: 'Active', status: 'in_progress' });
    const legacy: LegacyPlanState = {
      tasks: [completed, pending, inProgress],
      generatedAt: '2024-01-01T00:00:00.000Z',
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: '2024-01-01T00:00:00.000Z',
    };
    const result = migratePlanState(legacy);
    expect(result.phase).toBe('executing');
    if (result.phase === 'executing') {
      expect(result.executionLog).toHaveLength(1);
      expect(result.executionLog[0].id).toBe('t1');
      expect(result.executionLog[0].status).toBe('completed');
      expect(result.pendingTasks).toHaveLength(2);
      expect(result.pendingTasks.map((t) => t.status)).toEqual(
        expect.arrayContaining(['pending', 'in_progress']),
      );
    }
  });

  it('migrates an old draft session with no tasks to planning phase', () => {
    const legacy: LegacyPlanState = {
      tasks: [],
      generatedAt: '2024-01-01T00:00:00.000Z',
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: '2024-01-01T00:00:00.000Z',
    };
    const result = migratePlanState(legacy);
    expect(result.phase).toBe('planning');
  });

  it('migrates queuedMessages from old format to history messages', () => {
    const legacy: LegacyPlanState = {
      tasks: [],
      generatedAt: '2024-01-01T00:00:00.000Z',
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: '2024-01-01T00:00:00.000Z',
      queuedMessages: [
        { id: 'qm1', text: 'add tests', timestamp: '2024-01-01T00:00:00.000Z' },
      ],
    };
    const result = migratePlanState(legacy);
    expect(result.history.length).toBeGreaterThanOrEqual(1);
  });

  it('migrates old format with failed tasks to executing phase', () => {
    const failed = createTask({ id: 't1', title: 'Crashed', status: 'failed' });
    const legacy: LegacyPlanState = {
      tasks: [failed],
      generatedAt: '2024-01-01T00:00:00.000Z',
      status: 'running',
      runners: ['opencode'],
      lastUpdated: '2024-01-01T00:00:00.000Z',
    };
    const result = migratePlanState(legacy);
    expect(result.phase).toBe('executing');
    if (result.phase === 'executing') {
      expect(result.executionLog).toHaveLength(1);
      expect(result.executionLog[0].status).toBe('failed');
    }
  });

  it('migrates old format with no execution tasks to planning phase (task-based detection)', () => {
    const task = createTask({ id: 't1', title: 'New', status: 'pending' });
    const legacy: LegacyPlanState = {
      tasks: [task],
      generatedAt: '2024-01-01T00:00:00.000Z',
      status: 'running',
      runners: ['claude-code'],
      lastUpdated: '2024-01-01T00:00:00.000Z',
    };
    const result = migratePlanState(legacy);
    expect(result.phase).toBe('planning');
    expect(result.pendingTasks).toHaveLength(1);
  });

  it('returns planning phase for null/undefined input', () => {
    const result = migratePlanState(null);
    expect(result.phase).toBe('planning');
    expect(result.history).toEqual([]);
    expect(result.pendingTasks).toEqual([]);
  });

  it('returns planning phase for unrecognized object', () => {
    const result = migratePlanState({ foo: 'bar' });
    expect(result.phase).toBe('planning');
    expect(result.history).toEqual([]);
    expect(result.pendingTasks).toEqual([]);
  });

  it('migrates executing PlanState passes through unchanged', () => {
    const msg: Message = { id: 'm1', role: 'planner', content: 'executing', timestamp: 2 };
    const task = createTask({ id: 't99', title: 'Running task', status: 'in_progress' });
    const executing: PlanState = {
      phase: 'executing',
      history: [msg],
      message: 'executing',
      executionLog: [],
      pendingTasks: [task],
      goal: 'fix it',
      runners: ['claude-code'],
      status: 'running',
    };
    const result = migratePlanState(executing);
    expect(result.phase).toBe('executing');
    if (result.phase === 'executing') {
      expect(result.goal).toBe('fix it');
      expect(result.pendingTasks).toEqual([task]);
    }
  });
});
