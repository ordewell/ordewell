import { describe, it, expect } from 'vitest';
import { createTask, createEmptyPlan, migratePlanState, taskOrderLabel, flattenTasksWithParents, keepExecutionState, isAwaitingReason } from '../Task';
import { serializeTask, serializeTaskStatus, surfaceTask } from '../../services/SessionMessage';
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

  it('carries a finished subagent into history as its brief and digest', () => {
    const legacy: LegacyPlanState = {
      tasks: [],
      generatedAt: '2024-01-01T00:00:00.000Z',
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: '2024-01-01T00:00:00.000Z',
      researchLog: [{ id: 'sa1-log', type: 'subagent', subagentId: 'sa1', brief: 'find auth', outcome: 'done', digest: 'in auth.ts', timestamp: '2024-01-01T00:00:00.000Z' }],
    };
    const result = migratePlanState(legacy);
    expect(result.history).toEqual([{
      id: 'sa1-log',
      role: 'system',
      content: '{"subagentId":"sa1","brief":"find auth","outcome":"done","digest":"in auth.ts"}',
      timestamp: Date.UTC(2024, 0, 1),
    }]);
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

describe('keepExecutionState', () => {
  it('keeps the count of a waiting task\'s ended waits through a rewrite (ADR-0053)', () => {
    const current = [{ ...createTask({ id: 'a', title: 'A' }), status: 'pending' as const, waitsEnded: 2 }];
    expect(keepExecutionState(current, [createTask({ id: 'a', title: 'Edited' })])[0].waitsEnded).toBe(2);
  });

  const done = (id: string, order: number) => createTask({ id, order, title: id.toUpperCase(), prompt: `do ${id}`, status: 'completed' });
  const todo = (id: string, order: number) => createTask({ id, order, title: id.toUpperCase(), prompt: `do ${id}` });

  it('keeps the reason for a skipped subtask when the planner restates it', () => {
    const current = [{ ...todo('parent', 1), subtasks: [
      { ...todo('child', 1), status: 'skipped' as const, skipReason: 'The test host is unavailable' },
    ] }];
    const rewrite = [{ ...todo('parent', 1), subtasks: [
      { ...todo('child', 1), skipReason: 'invented by the planner' },
    ] }];

    const result = keepExecutionState(current, rewrite);

    expect(result[0].subtasks[0]).toMatchObject({ status: 'skipped', skipReason: 'The test host is unavailable' });
  });

  it('keeps the attempted mark of a task a planner restates, so its chat does not vanish', () => {
    const current = [{ ...todo('a', 1), attempted: true as const }];
    const rewrite = [todo('a', 1)];

    expect(keepExecutionState(current, rewrite)[0].attempted).toBe(true);
  });

  it('keeps a settled task exactly as it stands wherever the rewrite names it', () => {
    const running = createTask({ id: 'b', order: 2, title: 'B', prompt: 'do b', status: 'in_progress' });
    const held = createTask({ id: 'c', order: 3, title: 'C', prompt: 'do c', status: 'awaiting_user' });
    const rewrite = [
      { ...done('a', 1), status: 'pending' as const, prompt: 'placeholder' },
      { ...running, status: 'pending' as const, title: 'B v2' },
      { ...held, status: 'pending' as const },
    ];

    const result = keepExecutionState([done('a', 1), running, held], rewrite);

    expect(result.map((t) => [t.id, t.status, t.title, t.prompt])).toEqual([
      ['a', 'completed', 'A', 'do a'],
      ['b', 'in_progress', 'B', 'do b'],
      ['c', 'awaiting_user', 'C', 'do c'],
    ]);
  });

  it('keeps the handoff of a failed task the rewrite restates, as it keeps its output summary', () => {
    const handoff = { summary: 'The schema is missing.', findings: [{ id: 'F1', severity: 'blocker' as const, title: 'No schema' }], findingCount: 1 };
    const failed = { ...todo('a', 1), status: 'failed' as const, handoff };

    const [result] = keepExecutionState([failed], [todo('a', 1)]);

    expect(result.handoff).toEqual(handoff);
  });

  it('keeps the runner a task\'s saved session belongs to, with the session', () => {
    const stopped = { ...todo('a', 1), runnerSessionId: 'sess-1', runnerSessionOwner: 'claude-code' };

    const [result] = keepExecutionState([stopped], [todo('a', 1)]);

    expect(result).toMatchObject({ runnerSessionId: 'sess-1', runnerSessionOwner: 'claude-code' });
  });

  it('puts a settled task the rewrite left out back beside its old neighbour', () => {
    const current = [done('a', 1), todo('b', 2), done('c', 3), todo('d', 4)];
    const rewrite = [todo('b', 1), todo('d', 2), todo('e', 3)];

    const result = keepExecutionState(current, rewrite);

    expect(result.map((t) => [t.id, t.order])).toEqual([['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]]);
  });

  it('lets the rewrite drop or edit a task that has not run', () => {
    const result = keepExecutionState([done('a', 1), todo('b', 2), todo('c', 3)], [{ ...todo('c', 1), title: 'C v2' }]);

    expect(result.map((t) => [t.id, t.title])).toEqual([['a', 'A'], ['c', 'C v2']]);
  });

  it('never takes a status from the rewrite: a planner cannot mark a task done', () => {
    const current = [createTask({ id: 'a', order: 1, status: 'failed' }), todo('b', 2)];
    const rewrite = [
      { ...current[0], status: 'pending' as const },
      { ...todo('b', 2), status: 'completed' as const },
      createTask({ id: 'new', order: 3, status: 'completed', verdict: { outcome: 'pass', reason: 'said so', checks: [], decidedAt: '' } }),
    ];

    const result = keepExecutionState(current, rewrite);

    expect(result.map((t) => [t.id, t.status])).toEqual([['a', 'failed'], ['b', 'pending'], ['new', 'pending']]);
    expect(result[2].verdict).toBeUndefined();
  });

  it('keeps where a task that has run ran, and a force start past its merge gate (ADR-0020)', () => {
    const failed = { ...createTask({ id: 'a', order: 1, status: 'failed', ops: true }), forcedPastGate: ['"Fix"'] };
    const current = [failed, todo('b', 2)];
    const rewrite = [{ ...failed, status: 'pending' as const, ops: undefined, forcedPastGate: undefined }, { ...todo('b', 2), ops: true }];

    const result = keepExecutionState(current, rewrite);

    expect(result[0]).toMatchObject({ ops: true, forcedPastGate: ['"Fix"'] });
    expect(result[1].ops).toBe(true);
  });
});

describe('the ops flag on a new task (ADR-0020)', () => {
  it('is set only by a literal true, on an AI task', () => {
    expect(createTask({ ops: true }).ops).toBe(true);
    expect(createTask({ ops: 'true' as unknown as boolean })).not.toHaveProperty('ops');
    expect(createTask({ ops: false })).not.toHaveProperty('ops');
    expect(createTask({ ops: true, type: 'user' })).not.toHaveProperty('ops');
  });
});

describe('a task\'s handoff on the wire (ADR-0047)', () => {
  const handoff = {
    summary: 'The cache key omits the tenant.',
    findings: [{ id: 'F1', severity: 'blocker' as const, title: 'Cache key leaks across tenants' }],
    findingCount: 2,
    artifacts: [{ kind: 'file' as const, path: 'src/cache.ts', line: 42 }],
  };

  it('goes out with the plan and with a status update, and is absent when the attempt left none', () => {
    const task = { ...createTask({ id: 't1', order: 1, title: 'Fix the cache' }), handoff };

    expect(serializeTask(surfaceTask(task)).handoff).toEqual(handoff);
    expect(serializeTaskStatus(task).handoff).toEqual(handoff);
    expect(serializeTask(surfaceTask(createTask({ id: 't2', order: 2 })))).not.toHaveProperty('handoff');
    expect(serializeTaskStatus(createTask({ id: 't2', order: 2 }))).not.toHaveProperty('handoff');
  });

  it('is copied, so a surface cannot change the plan it was sent', () => {
    const task = { ...createTask({ id: 't1', order: 1 }), handoff };
    const sent = serializeTaskStatus(task);

    sent.handoff!.findings[0].title = 'changed';

    expect(task.handoff.findings[0].title).toBe('Cache key leaks across tenants');
  });
});

describe('a status update carries the task type a surface tags it by', () => {
  it('says which task is a script task (ADR-0035)', () => {
    const script = createTask({ id: 't1', title: 'Push the tag', type: 'script', commands: [['git', 'push']] });

    expect(serializeTaskStatus(script).type).toBe('script');
    expect(serializeTaskStatus(createTask({ id: 't2', title: 'Build' })).type).toBe('ai');
  });
});

describe('a started task on the wire', () => {
  it('carries its attempted mark with the plan and with a status update, and nothing on a task never run', () => {
    const started = createTask({ id: 't1', title: 'Build', attempted: true });

    expect(serializeTask(surfaceTask(started)).attempted).toBe(true);
    expect(serializeTaskStatus(started).attempted).toBe(true);
    expect(serializeTask(surfaceTask(createTask({ id: 't2' })))).not.toHaveProperty('attempted');
    expect(serializeTaskStatus(createTask({ id: 't2' }))).not.toHaveProperty('attempted');
  });
});

describe('what an awaiting_user task waits on (ADR-0018, W1)', () => {
  it.each(['input', 'checkpoint', 'conflict', 'files-changed'])('%s is a reason', (reason) => {
    expect(isAwaitingReason(reason)).toBe(true);
  });

  it.each([undefined, null, '', 'Input', 'approval', 'waiting for your input', 1, {}])('%o is not', (value) => {
    expect(isAwaitingReason(value)).toBe(false);
  });

  it.each(['input', 'checkpoint', 'conflict', 'files-changed'] as const)('a %s wait goes on the wire with its reason', (awaitingReason) => {
    const task = { ...createTask({ id: 't1', title: 'T', status: 'awaiting_user' }), awaitingReason };
    expect(serializeTaskStatus(task).awaitingReason).toBe(awaitingReason);
  });

  it('a reason left on a task that no longer waits never reaches a surface', () => {
    const task = { ...createTask({ id: 't1', title: 'T', status: 'in_progress' }), awaitingReason: 'input' as const };
    expect(serializeTaskStatus(task)).not.toHaveProperty('awaitingReason');
  });
});
