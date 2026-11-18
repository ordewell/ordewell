import { describe, it, expect } from 'vitest';
import { EMPTY_RUN, reduceRun } from '../runView';
import type { RunInput, RunTask, RunView, SerializedPlan, SerializedTask, SerializedTaskStatus, SurfaceTask } from '../SessionMessage';

function planned(id: string, order: number, over: Partial<SerializedTask> = {}): SerializedTask {
  return {
    id, order, title: `Task ${id}`, type: 'ai', status: 'pending', description: 'd', dependencies: [],
    assignedRunner: 'claude-code', assignedModel: null, taskMode: 'build', prompt: null, subtasks: [],
    userSteps: undefined, autonomy: undefined, sliceType: undefined, userStoriesCovered: undefined,
    ...over,
  };
}

function generated(tasks: SerializedTask[], over: Partial<SerializedPlan> = {}): RunInput {
  return { type: 'plan_generated', plan: { tasks, runners: ['claude-code'], generatedAt: '2026-10-13T09:00:00.000Z', ...over }, goal: 'g', runners: ['claude-code'] };
}

const play = (inputs: RunInput[], from: RunView = EMPTY_RUN): RunView => inputs.reduce(reduceRun, from);

describe('reduceRun', () => {
  it('takes a broadcast plan\'s tasks and run settings', () => {
    const view = play([generated([planned('t1', 1, { title: 'Add the limiter', addedBy: 'supervisor' })], { runSettings: { mergeAtGatesAutomatically: true } })]);

    expect(view.tasks).toEqual([{ ...planned('t1', 1, { title: 'Add the limiter', addedBy: 'supervisor' }), subtasks: [] }]);
    expect(view.runSettings).toEqual({ mergeAtGatesAutomatically: true });
  });

  it('puts a status update on each task it names, a subtask included, and on the run', () => {
    const view = play([
      generated([planned('t1', 1, { subtasks: [planned('t1.1', 1)] }), planned('t2', 2)]),
      {
        type: 'status_update',
        tasks: [
          { id: 't1', status: 'in_progress', verdict: null, idleSince: '2026-10-13T09:05:00.000Z', awaitingApproval: 2 },
          { id: 't1.1', status: 'awaiting_user', verdict: null, awaitingReason: 'checkpoint', checkpoint: 'Keep the old API?', continuable: true },
          { id: 'gone', status: 'completed', verdict: null },
        ],
        runMerge: { waitingAtGate: true, paused: false, repos: [], landed: [] },
        usage: { attempts: 1, totals: { inputTokens: 10, outputTokens: 5 }, byModel: [], wallTimeMs: 0 },
      },
    ]);

    expect(view.tasks).toEqual([
      {
        ...planned('t1', 1), status: 'in_progress', verdict: null, idleSince: '2026-10-13T09:05:00.000Z', awaitingApproval: 2,
        subtasks: [{ ...planned('t1.1', 1), status: 'awaiting_user', verdict: null, awaitingReason: 'checkpoint', checkpoint: 'Keep the old API?', continuable: true, subtasks: [] }],
      },
      { ...planned('t2', 2), subtasks: [] },
    ]);
    expect(view.runMerge).toEqual({ waitingAtGate: true, paused: false, repos: [], landed: [] });
    expect(view.usage).toEqual({ attempts: 1, totals: { inputTokens: 10, outputTokens: 5 }, byModel: [], wallTimeMs: 0 });
  });

  it('keeps each task a status update does not name as the very task it was, so a surface can skip it', () => {
    const before = play([generated([planned('t1', 1, { subtasks: [planned('t1.1', 1)] }), planned('t2', 2, { subtasks: [planned('t2.1', 1)] })])]);

    const after = reduceRun(before, { type: 'status_update', tasks: [{ id: 't2.1', status: 'completed', verdict: null }] });
    const none = reduceRun(after, { type: 'status_update', tasks: [] });

    expect(after.tasks[0]).toBe(before.tasks[0]);
    expect(after.tasks[1]).not.toBe(before.tasks[1]);
    expect(after.tasks[1].subtasks[0].status).toBe('completed');
    expect(none.tasks).toBe(after.tasks);
  });

  it('carries the run activity a status update says, from an idle run to a start on its way', () => {
    expect(EMPTY_RUN.activity).toEqual({ starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: false });

    const view = play([{
      type: 'status_update',
      tasks: [],
      activity: { starting: true, running: false, scheduled: true, resumable: false, advancesOnItsOwn: true },
    }]);

    expect(view.activity).toEqual({ starting: true, running: false, scheduled: true, resumable: false, advancesOnItsOwn: true });
  });

  describe('task messages', () => {
    const waiting = play([
      generated([planned('t1', 1, { status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: '2026-10-13T10:00:00.000Z', subtasks: [planned('t1.1', 1)] })]),
      { type: 'status_update', tasks: [{ id: 't1', status: 'awaiting_user', verdict: null, awaitingReason: 'usage-limit', resumeAt: '2026-10-13T10:00:00.000Z', idleSince: null }] },
    ]);

    it.each<[string, RunInput, Partial<RunTask>]>([
      ['task_started runs the task and ends its wait', { type: 'task_started', taskId: 't1', order: 1, title: 'Task t1', runner: 'claude-code' }, { status: 'in_progress', awaitingReason: undefined, resumeAt: undefined }],
      ['task_updated patches plan fields', { type: 'task_updated', taskId: 't1', changes: { title: 'Renamed', skills: ['tdd'], dependencies: ['t0'] } }, { title: 'Renamed', skills: ['tdd'], dependencies: ['t0'] }],
      ['task_updated leaves status-only fields to the stream', { type: 'task_updated', taskId: 't1', changes: { idleSince: 'x', verdict: null } }, {}],
    ])('%s', (_name, input, change) => {
      expect(reduceRun(waiting, input).tasks[0]).toEqual({ ...waiting.tasks[0], ...change });
    });

    it('reaches a subtask', () => {
      const view = reduceRun(waiting, { type: 'task_updated', taskId: 't1.1', changes: { title: 'Nested' } });

      expect(view.tasks[0].subtasks[0].title).toBe('Nested');
    });

    it('leaves the view alone for a task it does not hold, or a start already running', () => {
      const running = reduceRun(waiting, { type: 'task_started', taskId: 't1', order: 1, title: 'Task t1', runner: 'claude-code' });

      expect(reduceRun(running, { type: 'task_started', taskId: 't1', order: 1, title: 'Task t1', runner: 'claude-code' })).toBe(running);
      expect(reduceRun(waiting, { type: 'task_updated', taskId: 'nope', changes: { title: 'x' } })).toBe(waiting);
    });
  });

  describe('the run\'s isolation', () => {
    const repos = [{ path: '/w', integrationBranch: 'ordewell/run', baseRef: 'main', landed: [] }];
    const landed = play([
      generated([planned('t1', 1)]),
      { type: 'status_update', tasks: [], runMerge: { waitingAtGate: false, paused: false, repos, landed: [] } },
      { type: 'isolation_handoff', repos, landed: [], deferredTo: 'supervisor' },
    ]);

    it('holds the handoff as sent', () => {
      expect(landed.handoff).toEqual({ repos, landed: [], deferredTo: 'supervisor' });
    });

    it('holds what Merge all did, and a merged run has nothing left to hand off or merge', () => {
      const blocked = reduceRun(landed, { type: 'isolation_merge', result: { outcome: 'blocked', blocked: [] } });
      const merged = reduceRun(landed, { type: 'isolation_merge', result: { outcome: 'merged' }, trigger: { kind: 'run_end' } });

      expect(blocked).toEqual({ ...landed, mergeResult: { outcome: 'blocked', blocked: [] } });
      expect(merged).toEqual({ ...landed, mergeResult: { outcome: 'merged' }, handoff: null, runMerge: null });
    });

    describe('a handoff git has since found merged', () => {
      const t1 = { taskId: 't1', order: 1, title: 'Task t1' };
      const t2 = { taskId: 't2', order: 2, title: 'Task t2' };
      const left = [{ ...repos[0], landed: [t2] }];
      const handed = play([
        generated([planned('t1', 1), planned('t2', 2)]),
        { type: 'isolation_handoff', repos: [{ ...repos[0], landed: [t1, t2] }], landed: [t1, t2], deferredTo: 'supervisor' },
      ]);
      const status = (runMerge?: { repos: typeof left; landed: typeof t1[] }): RunInput => ({
        type: 'status_update', tasks: [], ...(runMerge ? { runMerge: { waitingAtGate: false, paused: false, ...runMerge } } : {}),
      });

      it('offers only what the status update says is still unmerged', () => {
        const view = reduceRun(handed, status({ repos: left, landed: [t2] }));

        expect(view.handoff).toEqual({ repos: left, landed: [t2], deferredTo: 'supervisor' });
      });

      it('keeps the handoff as it was while the same work is unmerged', () => {
        const same = reduceRun(handed, status({ repos: [{ ...repos[0], landed: [t1, t2] }], landed: [t1, t2] }));

        expect(same.handoff).toBe(handed.handoff);
      });

      it('goes once a status update says nothing landed is unmerged', () => {
        expect(reduceRun(handed, status()).handoff).toBeNull();
      });

      it('leaves a handoff that landed nothing, which offers only the clean-up', () => {
        expect(reduceRun(landed, status()).handoff).toEqual({ repos, landed: [], deferredTo: 'supervisor' });
      });
    });

    describe('with a task marked', () => {
      const isolation = { state: 'integrated' as const, branch: 'ordewell/run/1-t1', worktree: '/wt/1', repos: ['.'] };
      const marked = play([
        generated([planned('t1', 1)]),
        { type: 'status_update', tasks: [{ id: 't1', status: 'completed', verdict: null, isolation }], runMerge: { waitingAtGate: false, paused: false, repos, landed: [] } },
        { type: 'isolation_handoff', repos, landed: [] },
      ]);

      it('keeps the marks through a merge that leaves the run open', () => {
        const view = reduceRun(marked, { type: 'isolation_merge', result: { outcome: 'merged' } });

        expect(view.tasks[0].isolation).toEqual(isolation);
      });

      it('drops the marks, the handoff and what Merge all said once the run is closed', () => {
        const merged = reduceRun(marked, { type: 'isolation_merge', result: { outcome: 'merged' } });
        const view = reduceRun(merged, { type: 'run_closed' });

        expect(view.tasks[0]).not.toHaveProperty('isolation');
        expect(view).toMatchObject({ handoff: null, runMerge: null, mergeResult: null });
        expect(view.tasks).toHaveLength(1);
      });
    });
  });

  it.each<RunInput>([
    { type: 'checkpoint', taskId: 't1', taskTitle: 'Task t1', summary: 'Keep the old API?' },
    { type: 'review_needed', tasks: [planned('t1', 1, { status: 'completed' })] },
    { type: 'review_approved' },
    { type: 'execution_complete', summary: { total: 1, completed: 1, failed: 0, blocked: 0, skipped: 0 } },
    { type: 'execution_stopped' },
    { type: 'task_output', taskId: 't1', text: 'npm test' },
    { type: 'task_log', taskId: 't1', attempt: 1, events: [] },
    { type: 'isolation_blocked', reason: 'dirty', message: 'Tracked files have uncommitted changes' },
    { type: 'planner_message', content: 'Done.', timestamp: '2026-10-13T09:00:00.000Z' },
    { type: 'planner_liveness' },
  ])('leaves the view as it was for $type', (input) => {
    const before = play([generated([planned('t1', 1)])]);

    expect(reduceRun(before, input)).toBe(before);
  });

  describe('a plan snapshot', () => {
    const surfaced = (id: string, order: number, over: Partial<SurfaceTask> = {}): SurfaceTask => ({
      id, order, title: `Task ${id}`, type: 'ai', status: 'pending', description: 'd', dependencies: [], assignedRunner: 'claude-code', subtasks: [], ...over,
    });

    it('reads a flat plan as a plan refresh, run settings included', () => {
      const view = reduceRun(EMPTY_RUN, {
        type: 'plan_snapshot',
        plan: { status: 'approved', runners: ['claude-code'], generatedAt: '2026-10-13T09:00:00.000Z', lastUpdated: '2026-10-13T09:00:00.000Z', tasks: [surfaced('t1', 1, { subtasks: [surfaced('t1.1', 1)] })], runSettings: { mergeAtGatesAutomatically: false } },
      });

      expect(view.tasks).toEqual([{ ...planned('t1', 1), subtasks: [{ ...planned('t1.1', 1), subtasks: [] }] }]);
      expect(view.runSettings).toEqual({ mergeAtGatesAutomatically: false });
    });

    it('rejoins a saved plan\'s finished and pending tasks in plan order, and keeps the run settings it does not carry', () => {
      const before = play([generated([], { runSettings: { mergeAtGatesAutomatically: true } })]);
      const view = reduceRun(before, {
        type: 'plan_snapshot',
        plan: {
          phase: 'executing', history: [], message: '', goal: 'g', runners: ['claude-code'], status: 'running',
          pendingTasks: [surfaced('t2', 2), surfaced('t1', 1, { status: 'in_progress' })],
          executionLog: [{ ...surfaced('t1', 1, { status: 'completed' }), completedAt: 1, retryCount: 0, finalized: true }],
        },
      });

      expect(view.tasks).toEqual([{ ...planned('t1', 1, { status: 'completed' }), subtasks: [] }, { ...planned('t2', 2), subtasks: [] }]);
      expect(view.runSettings).toEqual({ mergeAtGatesAutomatically: true });
    });

    // The log is flat: a finished subtask is logged on its own as well as inside its parent.
    it('keeps a finished subtask under its parent, never beside the top-level task with its order', () => {
      const logged = (task: SurfaceTask) => ({ ...task, completedAt: 1, retryCount: 0, finalized: true });
      const sub = surfaced('t1.2', 2, { status: 'completed' });
      const view = reduceRun(EMPTY_RUN, {
        type: 'plan_snapshot',
        plan: {
          phase: 'executing', history: [], message: '', goal: 'g', runners: ['claude-code'], status: 'running',
          pendingTasks: [surfaced('t3', 3)],
          executionLog: [logged(surfaced('t1', 1, { status: 'completed', subtasks: [surfaced('t1.2', 2)] })), logged(sub), logged(surfaced('t2', 2, { status: 'completed' }))],
        },
      });

      expect(view.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
      expect(view.tasks[0].subtasks.map((t) => [t.id, t.status])).toEqual([['t1.2', 'completed']]);
    });
  });

  describe('a plan refresh', () => {
    const isolation: RunTask['isolation'] = { state: 'integrated', branch: 'ordewell/t1', worktree: '/w/t1', repos: ['/w'] };
    const statusOnly: [string, Partial<SerializedTaskStatus>][] = [
      ['verdict', { verdict: { outcome: 'fail', reason: 'tests failed', checks: [] } }],
      ['idleSince', { idleSince: '2026-10-13T09:05:00.000Z' }],
      ['completionReceived', { completionReceived: 'done' }],
      ['isolation', { isolation }],
      ['queued', { queued: [{ id: 'q1', text: 'also update the docs' }] }],
      ['continuable', { continuable: true }],
      ['awaitingApproval', { awaitingApproval: 1 }],
      ['mergeGate', { mergeGate: ['t0'] }],
      ['forcedPastGate', { forcedPastGate: ['Add the limiter'] }],
      ['handoff', { handoff: { summary: 'Done.', findings: [], findingCount: 0 } }],
      ['attempted', { attempted: true }],
    ];

    it.each(statusOnly)('keeps %s from the last status update', (_field, status) => {
      const before = play([
        generated([planned('t1', 1)]),
        { type: 'status_update', tasks: [{ id: 't1', status: 'failed', verdict: null, ...status }] },
      ]);

      const after = reduceRun(before, generated([planned('t1', 1, { status: 'failed', title: 'Renamed' })]));

      expect(after.tasks[0]).toEqual({ ...before.tasks[0], title: 'Renamed' });
    });

    it('keeps the checkpoint question while the task still waits at it', () => {
      const waiting = { status: 'awaiting_user' as const, awaitingReason: 'checkpoint' as const };
      const before = play([
        generated([planned('t1', 1, waiting)]),
        { type: 'status_update', tasks: [{ id: 't1', verdict: null, ...waiting, checkpoint: 'Keep the old API?' }] },
      ]);

      expect(reduceRun(before, generated([planned('t1', 1, waiting)])).tasks[0].checkpoint).toBe('Keep the old API?');
      expect(reduceRun(before, generated([planned('t1', 1, { status: 'in_progress' })])).tasks[0].checkpoint).toBeUndefined();
    });

    it('takes a handoff from the status stream and clears it when the latest attempt left none', () => {
      const handoff = { summary: 'Done.', findings: [], findingCount: 0 };
      const handed = play([
        generated([planned('t1', 1, { status: 'completed' })]),
        { type: 'status_update', tasks: [{ id: 't1', status: 'completed', verdict: null, handoff }] },
      ]);
      expect(handed.tasks[0].handoff).toEqual(handoff);

      const retried = reduceRun(handed, { type: 'status_update', tasks: [{ id: 't1', status: 'pending', verdict: null }] });
      expect(retried.tasks[0].handoff).toBeUndefined();
    });

    it('takes plan fields from the plan, absent meaning none', () => {
      const before = play([generated([planned('t1', 1, { addedBy: 'supervisor', skills: ['tdd'], ops: true })])]);

      const after = reduceRun(before, generated([planned('t1', 1)]));

      expect(after.tasks[0]).toEqual({ ...planned('t1', 1), subtasks: [] });
    });

    it('drops a task the plan no longer has, status and all', () => {
      const before = play([
        generated([planned('t1', 1), planned('t2', 2)]),
        { type: 'status_update', tasks: [{ id: 't2', status: 'pending', verdict: null, awaitingApproval: 1 }] },
      ]);

      expect(reduceRun(before, generated([planned('t1', 1)])).tasks.map((t) => t.id)).toEqual(['t1']);
    });
  });
});
