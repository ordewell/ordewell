import { describe, it, expect } from 'vitest';
import { applyTaskOps, parseTaskOpsJson, textHasTaskOps, canMergeTasks, canSplitTask } from '../TaskOps';
import { PlanParseError } from '../JsonExtractor';
import { createTask, type Task } from '../../models/Task';

function samplePlan(): Task[] {
  return [
    createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'setup', assignedRunner: 'claude-code' }),
    createTask({ id: 'b', order: 2, title: 'Build', prompt: 'build', dependencies: ['a'], assignedRunner: 'claude-code' }),
    createTask({ id: 'c', order: 3, title: 'Test', prompt: 'test', dependencies: ['b'], assignedRunner: 'claude-code' }),
  ];
}

describe('parseTaskOpsJson', () => {
  it('parses ops from a reply with prose around the JSON', () => {
    const ops = parseTaskOpsJson('Sure, here you go:\n{"taskOps":[{"op":"remove","taskId":"#2"}]}\nDone.');
    expect(ops).toEqual([{ op: 'remove', taskId: '#2' }]);
  });

  it('rejects an empty or missing taskOps array', () => {
    expect(() => parseTaskOpsJson('{"taskOps":[]}')).toThrow(PlanParseError);
    expect(() => parseTaskOpsJson('{"other":1}')).toThrow(PlanParseError);
  });

  it('textHasTaskOps detects the key', () => {
    expect(textHasTaskOps('{"taskOps":[...]}')).toBe(true);
    expect(textHasTaskOps('{"tasks":[...]}')).toBe(false);
  });

  it('finds the ops object even when a tasks-keyed object appears in the same reply', () => {
    // A schema echo like {"tasks":[...]} must not shadow the actual ops.
    const reply = 'The plan format is {"tasks":[{"id":"x","title":"example"}]} but I only need an edit:\n{"taskOps":[{"op":"remove","taskId":"#2"}]}';
    expect(parseTaskOpsJson(reply)).toEqual([{ op: 'remove', taskId: '#2' }]);
  });

  it('prefers the LAST ops object when the reply carries several', () => {
    const reply = 'Draft: {"taskOps":[{"op":"remove","taskId":"#1"}]}\nFinal: {"taskOps":[{"op":"remove","taskId":"#3"}]}';
    expect(parseTaskOpsJson(reply)).toEqual([{ op: 'remove', taskId: '#3' }]);
  });
});

describe('applyTaskOps', () => {
  it('updates a task referenced by #order', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'update', taskId: '#2', changes: { title: 'Build v2' } }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks[1].title).toBe('Build v2');
    expect(res.summary[0]).toContain('Build');
  });

  it('adds a task with dependencies resolved from order refs', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'add', task: { title: 'Docs', dependencies: ['#3'] } }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks).toHaveLength(4);
    const added = res.tasks[3];
    expect(added.dependencies).toEqual(['c']);
    expect(added.assignedRunner).toBe('claude-code');
    expect(added.id).toBeTruthy();
  });

  it('removes a task and cleans up dependent references', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'remove', taskId: 'b' }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks).toHaveLength(2);
    expect(res.tasks.find((t) => t.title === 'Test')!.dependencies).toEqual([]);
  });

  it('rejects a dependency cycle and leaves the plan untouched', () => {
    const original = samplePlan();
    const res = applyTaskOps(original, [{ op: 'update', taskId: 'a', changes: { dependencies: ['c'] } }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/cycle|ordered before/i);
    expect(res.tasks).toBe(original);
  });

  it('rejects unknown dependency references', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'update', taskId: 'a', changes: { dependencies: ['nope'] } }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('unknown dependencies');
  });

  it('refuses to touch running or completed tasks', () => {
    const plan = samplePlan();
    plan[0].status = 'in_progress';
    plan[1].status = 'completed';
    expect(applyTaskOps(plan, [{ op: 'update', taskId: 'a', changes: { title: 'x' } }], ['claude-code']).ok).toBe(false);
    expect(applyTaskOps(plan, [{ op: 'remove', taskId: 'b' }], ['claude-code']).ok).toBe(false);
  });

  it('is atomic: a later invalid op rolls back earlier valid ones', () => {
    const original = samplePlan();
    const res = applyTaskOps(original, [
      { op: 'update', taskId: 'a', changes: { title: 'renamed' } },
      { op: 'remove', taskId: 'does-not-exist' },
    ], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.tasks).toBe(original);
    expect(original[0].title).toBe('Setup');
  });

  it('reorders tasks while respecting dependencies', () => {
    const plan = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'p' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'p' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'p' }),
    ];
    const ok = applyTaskOps(plan, [{ op: 'reorder', taskIds: ['#3', '#1', '#2'] }], ['claude-code']);
    expect(ok.ok).toBe(true);
    expect(ok.tasks.map((t) => t.title)).toEqual(['C', 'A', 'B']);

    const bad = applyTaskOps(samplePlan(), [{ op: 'reorder', taskIds: ['#3', '#2', '#1'] }], ['claude-code']);
    expect(bad.ok).toBe(false);
  });

  it('rejects a runner outside the plan runner set', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'update', taskId: 'a', changes: { assignedRunner: 'aider' } }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('runner');
  });

  it('never lets the model change system-owned fields', () => {
    const res = applyTaskOps(samplePlan(), [
      { op: 'update', taskId: 'a', changes: { status: 'completed', id: 'hax', title: 'ok' } as never },
    ], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks[0].id).toBe('a');
    expect(res.tasks[0].status).toBe('pending');
    expect(res.tasks[0].title).toBe('ok');
  });
});

describe('applyTaskOps — merge', () => {
  it('collapses selected tasks into one and rewires dependents to the survivor', () => {
    const plan = samplePlan(); // a(1) -> b(2) -> c(3)
    const res = applyTaskOps(plan, [{
      op: 'merge', taskIds: ['a', 'b'],
      merged: { title: 'Setup + Build', description: 'combined', prompt: 'do both' },
    }], ['claude-code']);
    expect(res.ok).toBe(true);
    expect(res.tasks).toHaveLength(2);
    const merged = res.tasks.find((t) => t.title === 'Setup + Build')!;
    expect(merged.dependencies).toEqual([]); // a had none, b had [a] which is merged away
    // c depended on b; b is gone, so c now depends on the survivor.
    const c = res.tasks.find((t) => t.title === 'Test')!;
    expect(c.dependencies).toEqual([merged.id]);
    expect(merged.order).toBeLessThan(c.order);
  });

  it('inherits assignedModel from the source tasks when the spec omits it', () => {
    const plan = samplePlan();
    plan[0].assignedModel = { modelId: 'claude-code/opus', modelLabel: 'Opus' };
    const res = applyTaskOps(plan, [{
      op: 'merge', taskIds: ['a', 'b'],
      merged: { title: 'Setup + Build' },
    }], ['claude-code']);
    expect(res.ok).toBe(true);
    const merged = res.tasks.find((t) => t.title === 'Setup + Build')!;
    expect(merged.assignedModel?.modelId).toBe('claude-code/opus');
  });

  it('rejects a merge with fewer than two tasks', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'merge', taskIds: ['a'], merged: { title: 'x' } }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/at least two/i);
  });

  it('rejects a merge whose merged spec has no title', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'merge', taskIds: ['a', 'b'], merged: {} }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/title/);
  });

  it('refuses to merge running or completed tasks', () => {
    const plan = samplePlan();
    plan[1].status = 'completed';
    const res = applyTaskOps(plan, [{ op: 'merge', taskIds: ['a', 'b'], merged: { title: 'x' } }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/completed/);
  });

  it('falls back to combined description/prompt when the spec omits them', () => {
    const plan = [
      createTask({ id: 'a', order: 1, title: 'A', description: 'desc-a', prompt: 'p-a', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'B', description: 'desc-b', prompt: 'p-b', assignedRunner: 'claude-code' }),
    ];
    const res = applyTaskOps(plan, [{ op: 'merge', taskIds: ['a', 'b'], merged: { title: 'AB' } }], ['claude-code']);
    expect(res.ok).toBe(true);
    const merged = res.tasks.find((t) => t.title === 'AB')!;
    expect(merged.description).toContain('desc-a');
    expect(merged.description).toContain('desc-b');
    expect(merged.prompt).toContain('p-a');
    expect(merged.prompt).toContain('p-b');
  });
});

describe('applyTaskOps — split', () => {
  it('replaces one task with a chained sequence and rewires dependents to the tail', () => {
    const plan = samplePlan(); // a(1) -> b(2) -> c(3)
    const res = applyTaskOps(plan, [{
      op: 'split', taskId: 'b',
      parts: [
        { title: 'Build core', description: 'core', prompt: 'build core' },
        { title: 'Build UI', description: 'ui', prompt: 'build ui' },
      ],
    }], ['claude-code']);
    expect(res.ok).toBe(true);
    const parts = res.tasks.filter((t) => t.title.startsWith('Build'));
    expect(parts).toHaveLength(2);
    // First part inherits b's dependencies ([a]); second depends on first.
    expect(parts[0].dependencies).toEqual(['a']);
    expect(parts[1].dependencies).toEqual([parts[0].id]);
    // c depended on b; now depends on the last part.
    const c = res.tasks.find((t) => t.title === 'Test')!;
    expect(c.dependencies).toEqual([parts[1].id]);
  });

  it('rejects a split with fewer than two parts', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'split', taskId: 'b', parts: [{ title: 'only' }] }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/at least two/i);
  });

  it('rejects a split part missing a title', () => {
    const res = applyTaskOps(samplePlan(), [{ op: 'split', taskId: 'b', parts: [{ title: 'x' }, {}] }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/part 2.*title/i);
  });

  it('refuses to split a completed task', () => {
    const plan = samplePlan();
    plan[1].status = 'completed';
    const res = applyTaskOps(plan, [{ op: 'split', taskId: 'b', parts: [{ title: 'x' }, { title: 'y' }] }], ['claude-code']);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/completed/);
  });
});

describe('canMergeTasks', () => {
  it('approves a simple consecutive chain merge', () => {
    expect(canMergeTasks(samplePlan(), ['a', 'b']).ok).toBe(true);
  });

  it('rejects fewer than two ids', () => {
    expect(canMergeTasks(samplePlan(), ['a']).ok).toBe(false);
  });

  it('rejects a merge that would pull in a later dependency (ordering break)', () => {
    // a(1), b(2) depends on a, c(3) depends on a, d(4) depends on b.
    // Merging a + d: survivor (order 1) would depend on b (order 2) -> order violation.
    const plan = [
      createTask({ id: 'a', order: 1, title: 'A', prompt: 'p', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'B', prompt: 'p', dependencies: ['a'], assignedRunner: 'claude-code' }),
      createTask({ id: 'c', order: 3, title: 'C', prompt: 'p', dependencies: ['a'], assignedRunner: 'claude-code' }),
      createTask({ id: 'd', order: 4, title: 'D', prompt: 'p', dependencies: ['b'], assignedRunner: 'claude-code' }),
    ];
    const res = canMergeTasks(plan, ['a', 'd']);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ordering|cycle/i);
  });

  it('rejects merging a running task', () => {
    const plan = samplePlan();
    plan[0].status = 'in_progress';
    expect(canMergeTasks(plan, ['a', 'b']).ok).toBe(false);
  });
});

describe('canSplitTask', () => {
  it('approves a pending task', () => {
    expect(canSplitTask(samplePlan(), 'b').ok).toBe(true);
  });

  it('rejects a completed task', () => {
    const plan = samplePlan();
    plan[1].status = 'completed';
    expect(canSplitTask(plan, 'b').ok).toBe(false);
  });

  it('rejects an unknown task', () => {
    expect(canSplitTask(samplePlan(), 'nope').ok).toBe(false);
  });
});
