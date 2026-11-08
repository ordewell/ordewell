import { describe, expect, it } from 'vitest';
import { flipClears, forbiddenFields, isTaskType, presentForbiddenFields, taskKinds, TASK_KINDS, writtenForbiddenFields } from '../TaskKind';
import type { TaskType } from '../Task';

describe('task kinds', () => {
  it('names a kind only for a key of its own table', () => {
    for (const kind of ['ai', 'user', 'script', 'delegated']) expect(isTaskType(kind)).toBe(true);
    for (const value of ['manual', 'constructor', '__proto__', 'toString', '', null, undefined, 1]) expect(isTaskType(value)).toBe(false);
  });

  it.each<TaskType>(['ai', 'user', 'script', 'delegated'])('%s owns its forbidden fields', (kind) => {
    const fields = forbiddenFields(kind);
    expect(new Set(fields).size).toBe(fields.length);
    expect(presentForbiddenFields(kind, Object.fromEntries(fields.map((f) => [f, 'set'])))).toEqual(fields);
    expect(writtenForbiddenFields(kind, Object.fromEntries(fields.map((f) => [f, 'set'])))).toEqual(fields);
    for (const value of [undefined, false, []]) {
      expect(presentForbiddenFields(kind, Object.fromEntries(fields.map((f) => [f, value])))).toEqual([]);
      expect(writtenForbiddenFields(kind, Object.fromEntries(fields.map((f) => [f, value])))).toEqual([]);
    }
    expect(presentForbiddenFields(kind, Object.fromEntries(fields.map((f) => [f, true])), fields)).toEqual([]);
  });

  // Bug: one reading served both, so an edit's `null` on a script task passed where the edit check had refused it.
  it.each<TaskType>(['ai', 'user', 'script', 'delegated'])('%s holds a null an edit sets, and reads the planner\'s JSON null as left out', (kind) => {
    const fields = forbiddenFields(kind);
    const nulls = Object.fromEntries(fields.map((f) => [f, null]));
    expect(presentForbiddenFields(kind, nulls)).toEqual(fields);
    expect(writtenForbiddenFields(kind, nulls)).toEqual([]);
  });

  it.each<TaskType>(['ai', 'user', 'script', 'delegated'])('%s owns planner-only edit refusals', (kind) => {
    const fields = forbiddenFields(kind, 'plannerEdit');
    expect(writtenForbiddenFields(kind, { readOnly: true, thinkingEffort: 'high' }, 'plannerEdit')).toEqual(fields);
  });

  it.each([
    ['ai', false, true, true, true],
    ['user', false, true, false, false],
    ['script', true, false, false, false],
    ['delegated', true, false, false, true],
  ] as const)('%s owns its placement and execution capabilities', (kind, topLevelOnly, mayHaveSubtasks, runsInMode, hasRunner) => {
    expect(TASK_KINDS[kind]).toMatchObject({ topLevelOnly, mayHaveSubtasks, runsInMode, hasRunner });
  });
});

describe('type flip clearing', () => {
  const kinds: TaskType[] = ['ai', 'user', 'script', 'delegated'];
  it.each(kinds.flatMap((from) => kinds.map((to) => [from, to] as const)))('%s to %s', (from, to) => {
    const clear = flipClears(from, to);
    if (from === to || from === 'delegated' || to === 'delegated') {
      expect(clear).toEqual([]);
    } else {
      expect(clear.includes('research')).toBe(from === 'ai');
      expect(clear.includes('commands')).toBe(from === 'script');
      expect(clear.includes('assignedModel')).toBe(to !== 'ai');
      expect(clear.includes('prompt')).toBe(to === 'script');
      expect(new Set(clear).size).toBe(clear.length);
    }
  });
});

it.each([false, true])('lists kinds for a planner with delegation %s', (delegates) => {
  expect(taskKinds(delegates)).toEqual(delegates ? ['ai', 'user', 'script', 'delegated'] : ['ai', 'user', 'script']);
});
