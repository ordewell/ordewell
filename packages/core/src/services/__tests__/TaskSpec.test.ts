import { describe, expect, it } from 'vitest';
import { CORE_PLANNER_PROMPT } from '../PlanPrompts';
import { opShapeRefusal, readSpec, TASK_SPEC_FIELDS, taskOpSchema, taskSpecSchema } from '../TaskSpec';

describe('readSpec', () => {
  it('refuses a field in a shape it cannot hold, naming it, the value and what it must be', () => {
    expect(readSpec({ title: 'Ship', dependencies: '#2' }, 'patch')).toEqual([
      { field: 'dependencies', message: 'has "dependencies" "#2", which must be a list of task refs, as ["<id or #order>"]' },
    ]);
    expect(readSpec({ title: 7, research: 'yes', autonomy: 'later' }, 'new').map((e) => e.field)).toEqual(['title', 'research', 'autonomy']);
  });

  it('refuses a type no kind owns by the intake\'s own words, and takes a delegated one for the intake to judge', () => {
    expect(readSpec({ type: 'manual' }, 'new')[0].message).toMatch(/"manual", which is no kind of task/);
    expect(readSpec({ type: 'delegated' }, 'new')).toEqual([]);
  });

  it('takes a number wherever it takes a task ref', () => {
    expect(readSpec({ id: 3, dependencies: [1, '#2'], loop: { body: [4] } }, 'new')).toEqual([]);
  });

  it('refuses what is no object of task fields', () => {
    expect(readSpec('title: x', 'patch')).toEqual([{ field: 'changes', message: 'is "title: x", which must be an object of task fields' }]);
    expect(readSpec(['a'], 'new')[0].field).toBe('task');
  });

  it('passes a patch\'s null to the edit\'s rules, and refuses one on a new task', () => {
    expect(readSpec({ prompt: null, type: null, assignedModel: null }, 'patch')).toEqual([]);
    expect(readSpec({ description: null }, 'new').map((e) => e.field)).toEqual(['description']);
    expect(readSpec({ thinkingEffort: null }, 'new')).toEqual([]);
  });

  it('leaves to their own rules the fields another rule judges or reads as any value', () => {
    expect(readSpec({ commands: 'npm test', loop: 'twice', goal: 3, ops: 'yes', skills: ['tdd', 7] }, 'new')).toEqual([]);
  });

  it('ignores in a patch the fields only a new task has', () => {
    expect(readSpec({ id: {}, order: 'first' }, 'patch')).toEqual([]);
  });
});

describe('opShapeRefusal', () => {
  it('reads a well-formed op as nothing to refuse', () => {
    expect(opShapeRefusal({ op: 'update', taskId: 3, changes: { dependencies: [1], prompt: null } }, 0)).toBeNull();
    expect(opShapeRefusal({ op: 'split', taskId: '#2', parts: [{ title: 'A' }, { title: 'B' }] }, 0)).toBeNull();
  });

  it('names the op and the slot it cannot read', () => {
    expect(opShapeRefusal({ taskId: '#2' }, 1)).toBe('op 2 needs an "op" field: update | add | remove | reorder | merge | split | rearm');
    expect(opShapeRefusal({ op: 'update', taskId: '#3', changes: { dependencies: '#2' } }, 0))
      .toBe('op 1 (update): "changes.dependencies" is "#2", which must be a list of task refs, as ["<id or #order>"]');
    expect(opShapeRefusal({ op: 'reorder', taskIds: '#1,#2' }, 0)).toMatch(/^op 1 \(reorder\): "taskIds" is "#1,#2": /);
    expect(opShapeRefusal({ op: 'update', taskId: '#2', changes: 'title: x' }, 0)).toMatch(/^op 1 \(update\): "changes" is "title: x": /);
    expect(opShapeRefusal({ op: 'add', task: { type: 'manual' } }, 0)).toMatch(/^op 1 \(add\): "task.type" is "manual", which is no kind of task/);
  });

  it('agrees with readSpec on what a task\'s fields may hold', () => {
    for (const fields of [{ dependencies: '#2' }, { research: 1 }, { userSteps: 'click' }, { assignedModel: 'opus' }]) {
      expect(readSpec(fields, 'new')).toHaveLength(1);
      expect(taskOpSchema().safeParse({ op: 'add', task: fields }).success).toBe(false);
    }
  });
});

describe('the table and what the prompts teach', () => {
  it('lists every field the plan JSON example names on a task', () => {
    const named = [...CORE_PLANNER_PROMPT.matchAll(/^ {6}"(\w+)":/gm)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(10);
    expect(named.filter((field) => !TASK_SPEC_FIELDS.includes(field))).toEqual([]);
  });

  it('lists a delegated task\'s fields only where the planner may delegate', () => {
    const fields = (delegates: boolean) => Object.keys(taskSpecSchema({ delegates }).shape);
    expect(fields(false)).not.toContain('goal');
    expect(fields(true)).toEqual(expect.arrayContaining(['goal', 'budget', 'protectedPaths', 'grants', 'scope']));
  });
});
