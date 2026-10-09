import { describe, it, expect } from 'vitest';
import { createTask, flattenTasks, type Task } from '../../models/Task';
import { validatePlanTasks } from '../PlanValidator';
import { applyTaskOps, type TaskOp } from '../TaskOps';
import { PlanStore } from '../PlanStore';
import { PlanEditor, type PlanEditCatalog } from '../PlanEditor';

// The planner's JSON is not typed: a quoted "true" reaches every entry point as a string.
const quotedTrue = 'true' as unknown as boolean;

const slice = { type: 'ai', dependencies: [], subtasks: [], sliceType: 'AFK', autonomy: 'AFK' };

function parsed(raw: Record<string, unknown>): Task {
  const result = validatePlanTasks({ tasks: [{ ...slice, id: 't1', order: 1, title: 'T', description: 'd', prompt: 'p', ...raw }] }, ['claude-code']);
  if (!result.ok) throw new Error(result.errors[0].message);
  return result.tasks[0];
}

const plan = (): Task[] => [
  createTask({ id: 'c1', order: 1, title: 'Fix', prompt: 'fix' }),
  createTask({ id: 'c2', order: 2, title: 'Docs', prompt: 'docs' }),
  createTask({ id: 'o3', order: 3, title: 'Deploy', prompt: 'deploy', ops: true }),
  createTask({ id: 'o4', order: 4, title: 'Tag', prompt: 'tag', ops: true }),
];

function applied(ops: TaskOp[], tasks = plan()): Task[] {
  const result = applyTaskOps(tasks, ops, ['claude-code']);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return flattenTasks(result.tasks);
}

const byTitle = (tasks: Task[], title: string) => tasks.find((t) => t.title === title)!;

function editor(tasks = plan()) {
  const store = new PlanStore();
  store.load(tasks, ['claude-code']);
  const now = '2026-01-01T00:00:00Z';
  const state = { tasks: [], generatedAt: now, status: 'approved' as const, runners: ['claude-code'], lastUpdated: now };
  const catalog: PlanEditCatalog = {
    edit: () => ({ modelsByRunner: {}, runnerModes: {} }),
    runner: async () => ({ models: [], modes: [] }),
    allowlistFor: () => undefined,
    models: () => ({}),
    admit: () => undefined,
  };
  const edit = new PlanEditor({
    store,
    plan: () => state,
    catalog,
    mutate: (op) => (op() ? state : null),
    scheduler: { tick: async () => undefined, releaseTask: async () => undefined },
    runs: { current: null, linkResolver: () => undefined },
    broadcast: () => undefined,
    plannerTools: () => false,
    taskSkills: () => ({ findSkill: () => undefined, searchedDirs: () => [] }),
    notice: () => undefined,
  });
  return { store, edit };
}

describe('the ops flag, through each way a task is made or edited (ADR-0020)', () => {
  describe('a new task', () => {
    it.each([
      ['a literal true', { ops: true }, true],
      ['a quoted "true"', { ops: quotedTrue }, undefined],
      ['false', { ops: false }, undefined],
      ['no flag', {}, undefined],
      ['a manual task marked ops', { ops: true, type: 'user' as const }, undefined],
    ])('created with %s', (_label, over, expected) => {
      const task = createTask(over);
      expect(task.ops).toBe(expected);
      if (expected === undefined) expect(task).not.toHaveProperty('ops');
    });
  });

  describe('a parsed plan', () => {
    it.each([
      ['a literal true', { ops: true }, true],
      ['a quoted "true"', { ops: 'true' }, undefined],
      ['no flag', {}, undefined],
      ['a manual task marked ops', { ops: true, type: 'user', sliceType: 'HITL', userSteps: [{ order: 1, instruction: 'x' }] }, undefined],
    ])('reads %s', (_label, raw, expected) => {
      const task = parsed(raw);
      expect(task.ops).toBe(expected);
      if (expected === undefined) expect(task).not.toHaveProperty('ops');
    });

    it('drops the flag from a subtask, which runs with its parent', () => {
      const task = parsed({ ops: true, subtasks: [{ id: 's1', order: 1, title: 'Watch', description: 'w', type: 'ai', prompt: 'watch', ops: true }] });
      expect(task.ops).toBe(true);
      expect(task.subtasks[0]).not.toHaveProperty('ops');
    });
  });

  describe('a planner edit', () => {
    it.each([
      ['a literal true', true, true],
      ['a quoted "true"', quotedTrue, undefined],
    ])('adds a task with %s', (_label, ops, expected) => {
      const tasks = applied([{ op: 'add', task: { title: 'New', prompt: 'new', ops } }]);
      expect(byTitle(tasks, 'New').ops).toBe(expected);
    });

    it('adds a manual task marked ops as a manual task', () => {
      const tasks = applied([{ op: 'add', task: { title: 'Check', type: 'user', userSteps: [{ order: 1, instruction: 'x', completed: false }], ops: true } }]);
      expect(byTitle(tasks, 'Check')).not.toHaveProperty('ops');
    });

    it('reads a quoted "true" on an update or a re-arm as a change task, stored absent', () => {
      const updated = applied([{ op: 'update', taskId: 'o3', changes: { ops: quotedTrue } }]);
      expect(byTitle(updated, 'Deploy').ops).toBeUndefined();
      const rearmed = applied([{ op: 'rearm', taskId: 'o4', changes: { ops: quotedTrue } }]);
      expect(byTitle(rearmed, 'Tag').ops).toBeUndefined();
    });

    it('refuses to make a manual task or a subtask ops', () => {
      const withSub = [
        createTask({ id: 'p1', order: 1, title: 'Parent', prompt: 'p', subtasks: [createTask({ id: 's1', order: 1, title: 'Sub', prompt: 's' })] }),
        createTask({ id: 'u2', order: 2, title: 'Check', type: 'user', userSteps: [{ order: 1, instruction: 'x', completed: false }] }),
      ];
      expect(applyTaskOps(withSub, [{ op: 'update', taskId: 's1', changes: { ops: true } }], ['claude-code']).errors[0]).toMatch(/subtask/);
      expect(applyTaskOps(withSub, [{ op: 'update', taskId: 'u2', changes: { ops: true } }], ['claude-code']).errors[0]).toMatch(/manual task/);
    });
  });

  describe('a direct edit', () => {
    it('reads a quoted "true" as a change task, stored absent', async () => {
      const { store, edit } = editor();

      await edit.updateTask('o3', { ops: quotedTrue });

      expect(store.get('o3')!.ops).toBeUndefined();
      expect(store.isOps('o3')).toBe(false);
    });

    it('turns a change task into an ops task with a literal true', async () => {
      const { store, edit } = editor();

      await edit.updateTask('c1', { ops: true });

      expect(store.get('c1')!.ops).toBe(true);
      expect(store.isOps('c1')).toBe(true);
    });

    it('adds a task to the store with a quoted "true" as a change task', () => {
      const { store } = editor();

      const added = store.add({ title: 'New', prompt: 'new', ops: quotedTrue });

      expect(added).not.toHaveProperty('ops');
    });
  });

  describe('what the store runs as ops', () => {
    it('a subtask runs as its top-level task does', () => {
      const store = new PlanStore();
      store.load([
        createTask({ id: 'o1', order: 1, title: 'Deploy', prompt: 'd', ops: true, subtasks: [createTask({ id: 's1', order: 1, title: 'Watch', prompt: 'w' })] }),
        createTask({ id: 'c2', order: 2, title: 'Fix', prompt: 'f', subtasks: [{ ...createTask({ id: 's2', order: 1, title: 'Sub', prompt: 's' }), ops: true }] }),
      ], ['claude-code']);

      expect(store.isOps('s1')).toBe(true);
      expect(store.isOps('s2')).toBe(false);
    });

    it('never a manual task, nor a flag that is not a literal true', () => {
      const store = new PlanStore();
      store.load([
        { ...createTask({ id: 'u1', order: 1, title: 'Check', type: 'user' }), ops: true },
        { ...createTask({ id: 'c2', order: 2, title: 'Fix', prompt: 'f' }), ops: quotedTrue },
      ], ['claude-code']);

      expect(store.isOps('u1')).toBe(false);
      expect(store.isOps('c2')).toBe(false);
    });
  });
});

describe('the ops flag of a task merged or split from others (ADR-0020)', () => {
  describe('in the store', () => {
    it('merges into an ops task only when both were ops', () => {
      const store = new PlanStore();
      store.load(plan(), ['claude-code']);

      expect(store.merge('o3', 'o4').ops).toBe(true);
      expect(store.merge('c1', store.allTasks.find((t) => t.ops)!.id)).not.toHaveProperty('ops');
    });

    it('merges an ops task with a manual task into a manual task', () => {
      const store = new PlanStore();
      store.load([...plan(), createTask({ id: 'u5', order: 5, title: 'Check', type: 'user' })], ['claude-code']);

      const merged = store.merge('o3', 'u5');

      expect(merged.type).toBe('user');
      expect(merged).not.toHaveProperty('ops');
    });

    it('splits into parts that run where the task ran, unless a part says otherwise', () => {
      const store = new PlanStore();
      store.load(plan(), ['claude-code']);

      const fromOps = store.split('o3', [{ title: 'Push' }, { title: 'Watch' }, { title: 'Bump', ops: false }]);
      const fromChange = store.split('c1', [{ title: 'Half' }, { title: 'Release', ops: true }]);

      expect(fromOps.map((t) => t.ops)).toEqual([true, true, undefined]);
      expect(fromChange.map((t) => t.ops)).toEqual([undefined, true]);
    });
  });

  describe('in a planner edit', () => {
    it('merges into an ops task only when every task was ops, unless the merge says', () => {
      expect(byTitle(applied([{ op: 'merge', taskIds: ['o3', 'o4'], merged: { title: 'M' } }]), 'M').ops).toBe(true);
      expect(byTitle(applied([{ op: 'merge', taskIds: ['c2', 'o3'], merged: { title: 'M' } }]), 'M')).not.toHaveProperty('ops');
      expect(byTitle(applied([{ op: 'merge', taskIds: ['c1', 'c2'], merged: { title: 'M', ops: true } }]), 'M').ops).toBe(true);
      expect(byTitle(applied([{ op: 'merge', taskIds: ['o3', 'o4'], merged: { title: 'M', ops: false } }]), 'M')).not.toHaveProperty('ops');
      expect(byTitle(applied([{ op: 'merge', taskIds: ['c1', 'c2'], merged: { title: 'M', ops: quotedTrue } }]), 'M')).not.toHaveProperty('ops');
    });

    it('splits into parts that run where the task ran, unless a part says otherwise', () => {
      const fromOps = applied([{ op: 'split', taskId: 'o3', parts: [{ title: 'Push' }, { title: 'Bump', ops: false }, { title: 'Odd', ops: quotedTrue }] }]);
      const fromChange = applied([{ op: 'split', taskId: 'c1', parts: [{ title: 'Half' }, { title: 'Release', ops: true }] }]);

      expect(['Push', 'Bump', 'Odd'].map((t) => byTitle(fromOps, t).ops)).toEqual([true, undefined, undefined]);
      expect(['Half', 'Release'].map((t) => byTitle(fromChange, t).ops)).toEqual([undefined, true]);
    });
  });
});
