import { describe, it, expect } from 'vitest';
import { parsePlanJson, validatePlanTasks } from '../PlanValidator';

const slice = { type: 'ai', dependencies: [], subtasks: [], sliceType: 'AFK', autonomy: 'AFK' };

describe('validatePlanTasks', () => {
  it('names the task and field when a task is assigned to a runner that is not enabled', () => {
    const result = validatePlanTasks(
      { tasks: [{ ...slice, id: 'build', order: 1, title: 'Build it', description: 'd', assignedRunner: 'codex' }] },
      ['claude-code'],
    );
    expect(result).toEqual({
      ok: false,
      errors: [{
        taskId: 'build',
        field: 'assignedRunner',
        message: 'Task "Build it" has invalid assignedRunner "codex". Expected one of: claude-code',
      }],
    });
  });
});

/** The text path's verdict on the same object, in validatePlanTasks' shape. */
function viaText(obj: unknown, runners: string[]) {
  try {
    return { ok: true, tasks: parsePlanJson(JSON.stringify(obj), runners) };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

function viaObject(obj: unknown, runners: string[]) {
  const result = validatePlanTasks(obj, runners);
  return result.ok
    ? { ok: true, tasks: result.tasks }
    : { ok: false, message: result.errors[0].message };
}

describe('validatePlanTasks against the JSON envelope', () => {
  const fixtures: Array<[string, unknown, string[]]> = [
    ['a minimal plan', { tasks: [{ ...slice, id: 't1', order: 1, title: 'Read README', description: 'Read the project README', prompt: 'Open README.md' }] }, ['claude-code']],
    ['a task with no prompt', { tasks: [{ ...slice, id: 't1', order: 1, title: 'Read README', description: 'Read the project README' }] }, ['claude-code']],
    ['an ops task with an ops subtask', { tasks: [{ ...slice, id: 'o1', order: 1, title: 'Deploy', description: 'Deploy', prompt: 'deploy', ops: true,
      subtasks: [{ id: 's1', order: 1, title: 'Watch', description: 'Watch', type: 'ai', prompt: 'watch', ops: true }] }] }, ['claude-code']],
    ['a user task', { tasks: [{ id: 'u', order: 1, title: 't', description: 'd', type: 'user', dependencies: [], sliceType: 'HITL', autonomy: 'AFK', userSteps: [{ order: 1, instruction: 'Do X', completed: true }], subtasks: [] }] }, ['claude-code']],
    ['a model, effort, mode and runner', { tasks: [{ ...slice, id: 't1', order: 1, title: 'T', description: 'd', assignedRunner: 'opencode', taskMode: 'plan',
      assignedModel: { modelId: 'm-1', modelLabel: 'Model 1', thinkingEffort: 'high' } }] }, ['claude-code', 'opencode']],
    ['bare subtasks inheriting the parent slice', { tasks: [{ ...slice, id: 'p', order: 1, title: 'p', description: 'd', sliceType: 'HITL', autonomy: 'HITL',
      subtasks: [{ id: 'c', order: 1, title: 'c', description: 'd', type: 'ai' }] }] }, ['claude-code']],
    ['no tasks array', {}, ['claude-code']],
    ['tasks that are not an array', { tasks: 'not-an-array' }, ['claude-code']],
    ['an empty tasks array', { tasks: [] }, ['claude-code']],
    ['a task missing everything', { tasks: [{ title: 'missing everything' }] }, ['claude-code']],
    ['a bare user subtask', { tasks: [{ ...slice, id: 'p', order: 1, title: 'Parent slice', description: 'd',
      subtasks: [{ id: 'c', order: 1, title: 'Manual check', description: 'd', type: 'user' }] }] }, ['claude-code']],
    ['an AFK task with user steps', { tasks: [{ ...slice, id: 't1', order: 1, title: 'T', description: 'd', userSteps: [{ order: 1, instruction: 'Click' }] }] }, ['claude-code']],
    ['a user task sliced AFK', { tasks: [{ id: 'u', order: 1, title: 'U', description: 'd', type: 'user', sliceType: 'AFK', subtasks: [] }] }, ['claude-code']],
    ['a runner outside the set', { tasks: [{ ...slice, id: 't1', order: 1, title: 'T', description: 'd', assignedRunner: 'bogus-runner' }] }, ['claude-code', 'opencode']],
  ];

  it.each(fixtures)('agrees on %s', (_name, obj, runners) => {
    expect(viaObject(obj, runners)).toEqual(viaText(obj, runners));
  });

  it('reports every problem, not only the first', () => {
    const result = validatePlanTasks({ tasks: [
      { id: 'a', order: 1, title: 'A', description: 'd', type: 'ai', assignedRunner: 'codex' },
      { ...slice, id: 'b', order: 2, title: 'B', description: 'd' },
    ] }, ['claude-code']);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.map((e) => [e.taskId, e.field])).toEqual([
      ['a', 'sliceType'],
      ['a', 'autonomy'],
      ['a', 'assignedRunner'],
    ]);
  });

  it('refuses a task that is not an object instead of throwing', () => {
    const result = validatePlanTasks({ tasks: [null] }, ['claude-code']);
    expect(result.ok).toBe(false);
  });
});
