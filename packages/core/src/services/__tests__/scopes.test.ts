import { describe, it, expect } from 'vitest';
import { validatePlanTasks } from '../PlanValidator';
import { PlanChangeCheck, type PlanChangeScope } from '../PlanChangeCheck';
import { rootMandate } from '../Mandate';
import { createTask, type Task } from '../../models/Task';

/** A scope as a plan holds it (ADR-0057 R6): declared on a delegated task, answered at plan time, and refusing nothing. */

const runners = ['claude-code'];
const modes = { 'claude-code': [{ id: 'plan', label: 'Plan', description: '', readOnly: true }, { id: 'build', label: 'Build', description: '' }] };
const delegated = (id: string, scope: unknown, over: Record<string, unknown> = {}) => ({
  id, order: 1, title: `Task ${id}`, description: id, type: 'delegated', goal: `reach ${id}`, sliceType: 'AFK', dependencies: [], budget: { tokens: 500_000 }, protectedPaths: ['tests/'], scope, ...over,
});
const check = (id: string, on: string) => ({ id, order: 2, title: `Check ${on}`, description: id, type: 'ai', prompt: `read ${on}`, readOnly: true, sliceType: 'AFK', autonomy: 'AFK', dependencies: [on] });
const plan = (...tasks: Record<string, unknown>[]) => validatePlanTasks({ tasks }, runners, modes, false, { delegationRefusal: null });
const warned = (...tasks: Record<string, unknown>[]) => {
  const result = plan(...tasks);
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
  return result.warnings ?? [];
};

describe('scope overlap at plan time', () => {
  it('names two unordered tasks that declare the same path, and takes the plan', () => {
    expect(warned(delegated('a', { paths: ['src/api/'] }), check('ca', 'a'), delegated('b', { paths: ['src/api/users.ts'] }), check('cb', 'b'))).toEqual([
      'Tasks "Task a" and "Task b" both declare src/api/users.ts, and nothing orders them: give one a dependency on the other, or name an owner.',
    ]);
  });

  it('reads a pattern as covering what it matches', () => {
    expect(warned(delegated('a', { paths: ['src/*.ts'] }), check('ca', 'a'), delegated('b', { paths: ['src/x.ts'] }), check('cb', 'b'))).toHaveLength(1);
    expect(warned(delegated('a', { paths: ['src/**/*.ts'] }), check('ca', 'a'), delegated('b', { paths: ['src/lib/*.ts'] }), check('cb', 'b'))).toHaveLength(1);
    expect(warned(delegated('a', { paths: ['src/*.ts'] }), check('ca', 'a'), delegated('b', { paths: ['docs/*.md'] }), check('cb', 'b'))).toEqual([]);
  });

  it('says nothing of tasks an edge orders, or of paths that do not meet', () => {
    expect(warned(delegated('a', { paths: ['src/'] }), check('ca', 'a'), delegated('b', { paths: ['src/'] }, { dependencies: ['ca'] }), check('cb', 'b'))).toEqual([]);
    expect(warned(delegated('a', { paths: ['src/'] }), check('ca', 'a'), delegated('b', { paths: ['srcs/'] }), check('cb', 'b'))).toEqual([]);
  });

  it('names two owners of one interface, and a consumer nothing puts after its producer', () => {
    expect(warned(delegated('a', { provides: ['api'] }), check('ca', 'a'), delegated('b', { provides: ['api'] }), check('cb', 'b'))).toEqual([
      'Tasks "Task a" and "Task b" both provide "api", and nothing orders them: name one owner.',
    ]);
    expect(warned(delegated('a', { provides: ['api'] }), check('ca', 'a'), delegated('b', { consumes: ['api'] }), check('cb', 'b'))).toEqual([
      'Task "Task b" consumes "api", which "Task a" provides, and nothing orders them: a dependency puts the producer first; without one it gets a line when "Task a" lands.',
    ]);
  });

  it('refuses a scope that is not lists of one-line text, so what reaches a line is what a plan may hold', () => {
    const refused = (scope: unknown) => {
      const result = plan(delegated('a', scope), check('ca', 'a'));
      return result.ok ? [] : result.errors.map((e) => e.field);
    };
    expect(refused({ paths: 'src/' })).toEqual(['scope']);
    expect(refused({ provides: ['two\nlines'] })).toEqual(['scope']);
    expect(refused({ consumes: [''] })).toEqual(['scope']);
    expect(refused({ consumes: [7] })).toEqual(['scope']);
  });

  it('stays off a task that is not delegated, so a flat plan has no scope', () => {
    const flat = { id: 'f', order: 1, title: 'Flat', description: 'f', type: 'ai', prompt: 'do it', sliceType: 'AFK', autonomy: 'AFK', dependencies: [], scope: { paths: ['src/'] } };
    const result = validatePlanTasks({ tasks: [flat] }, runners, modes);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.tasks[0].scope).toBeUndefined();
    expect(result.ok && result.warnings).toBeUndefined();
  });
});

describe('scope overlap on an edit', () => {
  const task = (id: string, scope: Task['scope'], over: Partial<Task> = {}) => createTask({ id, order: 1, title: `Task ${id}`, type: 'delegated', goal: 'g', budget: { tokens: 500_000 }, protectedPaths: ['tests/'], assignedRunner: 'claude-code', ...(scope ? { scope } : {}), ...over });
  const guard = (id: string, on: string) => createTask({ id, order: 2, title: `Check ${on}`, prompt: 'read', taskMode: 'plan', assignedRunner: 'claude-code', dependencies: [on] });

  function checker(tasks: Task[]) {
    const mandate = rootMandate({ level: 'watch', autorun: false, autonomous: true, delegationTokens: 5_000_000, runners, models: {} });
    const scope: PlanChangeScope = { tasks: () => tasks, runners: () => runners, catalog: () => ({ modelsByRunner: {}, runnerModes: modes }), node: () => ({ mandate, level: 0 }) };
    return new PlanChangeCheck(scope);
  }

  it('answers in the tool\'s result what the edit brought, and not what stood before it', () => {
    const standing = [task('a', { paths: ['src/'] }), guard('ca', 'a'), task('b', { paths: ['src/'] }), guard('cb', 'b')];
    const adding = [{ op: 'add', task: delegated('z', { paths: ['docs/'] }), handle: 'z' }, { op: 'add', task: { ...check('cz', 'z'), id: undefined } }];
    const checked = checker(standing).checkNow({ kind: 'ops', ops: adding as never }, 'submit');
    expect(checked).toMatchObject({ ok: true, warnings: [] });
    const widened = checker(standing).checkNow({ kind: 'ops', ops: [{ op: 'update', taskId: 'b', changes: { scope: { paths: ['src/', 'docs/'] } } }, ...adding] as never }, 'submit');
    expect(widened).toMatchObject({ ok: true, warnings: ['Tasks "Task b" and "Task z" both declare docs/, and nothing orders them: give one a dependency on the other, or name an owner.'] });
  });
});
