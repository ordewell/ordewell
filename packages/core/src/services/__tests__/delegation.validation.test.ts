import { describe, it, expect } from 'vitest';
import { validatePlanTasks } from '../PlanValidator';
import { applyTaskOps, type TaskOp } from '../TaskOps';
import { checkPlanInvariants } from '../PlannedTask';
import { PlanChangeCheck, type NodeFunds, type PlanChangeScope } from '../PlanChangeCheck';
import { rootMandate, type Mandate } from '../Mandate';
import { createTask, keepExecutionState, type Task } from '../../models/Task';

/**
 * A delegated task as a plan holds it (ADR-0055 D1, D2, D7, D8, D19), on every
 * route: a submitted plan and an edit meet the same rules, as a loop's do.
 */

const runners = ['claude-code'];
const spec = (id: string, over: Record<string, unknown> = {}) => ({
  id, order: 1, title: `Task ${id}`, description: id, type: 'ai', prompt: `do ${id}`, sliceType: 'AFK', autonomy: 'AFK', dependencies: [], ...over,
});
const delegated = (id: string, over: Record<string, unknown> = {}) => ({
  id, order: 1, title: `Task ${id}`, description: id, type: 'delegated', goal: `reach ${id}`, sliceType: 'AFK', dependencies: [],
  budget: { tokens: 500_000 }, protectedPaths: ['tests/'], ...over,
});
const readOnlyCheck = (id: string, on: string[]) => spec(id, { readOnly: true, dependencies: on });
const scriptCheck = (id: string, on: string[], over: Record<string, unknown> = {}) => ({
  id, order: 2, title: `Task ${id}`, description: id, type: 'script', sliceType: 'AFK', commands: [['npm', 'test']], readOnly: true, dependencies: on, ...over,
});

const modes = { 'claude-code': [{ id: 'plan', label: 'Plan', description: '', readOnly: true }, { id: 'build', label: 'Build', description: '' }] };

function checked(tasks: Record<string, unknown>[]) {
  return validatePlanTasks({ tasks }, runners, modes, false, { delegationRefusal: null });
}

function refusals(tasks: Record<string, unknown>[]): string[] {
  const result = checked(tasks);
  if (result.ok) throw new Error('expected a refusal');
  return result.errors.map((e) => e.message);
}

describe('a delegated task on a submitted plan', () => {
  it('holds a goal, a budget and the paths its child may not change, and no prompt or mode', () => {
    const result = checked([delegated('d', { grants: ['research'], scope: { paths: ['packages/api/'] } }), readOnlyCheck('c', ['d'])]);

    if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; '));
    expect(result.tasks[0]).toMatchObject({
      type: 'delegated', goal: 'reach d', budget: { tokens: 500_000 }, protectedPaths: ['tests/'], grants: ['research'], scope: { paths: ['packages/api/'] },
    });
    expect(result.tasks[0].prompt).toBeUndefined();
    expect(result.tasks[0].taskMode).toBeUndefined();
  });

  it('refuses one with no goal, or no budget of tokens', () => {
    expect(refusals([delegated('d', { goal: '  ' }), readOnlyCheck('c', ['d'])])).toContain('Task "Task d" is a delegated task with no "goal": say what its child plan must achieve');
    expect(refusals([delegated('d', { budget: undefined }), readOnlyCheck('c', ['d'])])).toContain('Task "Task d" is a delegated task with no "budget": give it {"tokens": <a whole number>}, and "wallClockMs" if it has a time limit');
    expect(refusals([delegated('d', { budget: { tokens: 0 } }), readOnlyCheck('c', ['d'])])[0]).toMatch(/no "budget"/);
    expect(refusals([delegated('d', { budget: { tokens: 10, wallClockMs: -1 } }), readOnlyCheck('c', ['d'])])[0]).toMatch(/"wallClockMs"/);
  });

  it('refuses a prompt or a mode on it, as a script task refuses what a runner reads', () => {
    expect(refusals([delegated('d', { prompt: 'do it' }), readOnlyCheck('c', ['d'])])[0]).toMatch(/is a delegated task, which holds a goal.*"prompt"/);
    expect(refusals([delegated('d', { ops: true }), readOnlyCheck('c', ['d'])])[0]).toMatch(/"ops"/);
  });

  it('is top-level with no subtasks: a child plan\'s tasks are the child\'s own', () => {
    expect(refusals([spec('p', { subtasks: [delegated('d')] })])).toContainEqual(expect.stringContaining('only a top-level task can be delegated'));
    expect(refusals([delegated('d', { subtasks: [spec('s')] }), readOnlyCheck('c', ['d'])])).toContainEqual(expect.stringContaining('has no subtasks'));
  });

  it('is neither a loop\'s check nor its body', () => {
    const asCheck = [delegated('d', { loop: { body: ['fix'] } }), spec('fix', { dependencies: ['d'] }), readOnlyCheck('c', ['d'])];
    expect(refusals(asCheck)).toContainEqual(expect.stringContaining('is a delegated task, so it cannot be a loop\'s check'));
    const asBody = [spec('review', { loop: { body: ['d'] } }), delegated('d', { dependencies: ['review'] }), readOnlyCheck('c', ['d'])];
    expect(refusals(asBody)).toContainEqual(expect.stringContaining('names delegated task "Task d" in its loop\'s "body"'));
  });

  it('names its protected paths unless it is read-only (D7)', () => {
    expect(refusals([delegated('d', { protectedPaths: undefined }), readOnlyCheck('c', ['d'])])).toContain('Task "Task d" is a delegated task that lands, with no "protectedPaths": name the paths its child may not change, what its check runs and the configuration that runs it');
    expect(refusals([delegated('d', { protectedPaths: [] }), readOnlyCheck('c', ['d'])])[0]).toMatch(/no "protectedPaths"/);
    expect(checked([delegated('d', { protectedPaths: undefined, readOnly: true }), readOnlyCheck('c', ['d'])]).ok).toBe(true);
  });

  it('asks for only grants that exist', () => {
    expect(refusals([delegated('d', { grants: ['root'] }), readOnlyCheck('c', ['d'])])[0]).toMatch(/"grants".*"root"/);
  });
});

describe('a delegated task\'s check (D8)', () => {
  it('needs a task that directly depends on it: a read-only AI task or a read-only script', () => {
    expect(refusals([delegated('d')])).toContain('Task "Task d" is a delegated task with no check: add a read-only AI task, or a script task marked "readOnly", that depends on it directly');
    expect(checked([delegated('d'), readOnlyCheck('c', ['d'])]).ok).toBe(true);
    expect(checked([delegated('d'), scriptCheck('c', ['d'])]).ok).toBe(true);
  });

  it('does not count a change task, or a script behind a merge gate', () => {
    expect(refusals([delegated('d'), spec('c', { dependencies: ['d'] })])[0]).toMatch(/with no check/);
    expect(refusals([delegated('d'), scriptCheck('c', ['d'], { readOnly: undefined })])[0]).toMatch(/with no check/);
  });

  it('does not count a check one step removed', () => {
    expect(refusals([delegated('d'), spec('m', { dependencies: ['d'] }), readOnlyCheck('c', ['m'])])[0]).toMatch(/with no check/);
  });

  it('is a read-only AI task on a read-only delegated task, whose branch goes when it passes, and a script is refused there either way', () => {
    const quiet = delegated('d', { readOnly: true, protectedPaths: undefined });
    expect(refusals([quiet, scriptCheck('c', ['d'])])).toContainEqual(expect.stringContaining('is a read-only delegated task, which lands nothing, so a script has nothing to run on'));
    expect(refusals([quiet, readOnlyCheck('a', ['d']), scriptCheck('c', ['d'], { readOnly: undefined })])).toContainEqual(expect.stringContaining('is a read-only delegated task'));
    expect(checked([quiet, readOnlyCheck('c', ['d'])]).ok).toBe(true);
  });

  it('refuses a script or ops body whose check depends on a delegated task, directly or through other tasks', () => {
    const script = { id: 'fix', order: 3, title: 'Task fix', description: 'fix', type: 'script', sliceType: 'AFK', commands: [['npm', 'run', 'fix']], dependencies: ['c'] };
    const direct = [delegated('d'), readOnlyCheck('c', ['d']), spec('r', { dependencies: ['c'], loop: { body: ['fix'] } }), { ...script, dependencies: ['r'] }];
    expect(refusals(direct)).toContainEqual(expect.stringContaining('names "Task fix"'));
    const ops = [delegated('d'), readOnlyCheck('c', ['d']), spec('r', { dependencies: ['c'], loop: { body: ['fix'] } }), spec('fix', { ops: true, dependencies: ['r'] })];
    expect(refusals(ops)).toContainEqual(expect.stringContaining('waits at a merge gate'));
    const worktree = [delegated('d'), readOnlyCheck('c', ['d']), spec('r', { dependencies: ['c'], loop: { body: ['fix'] } }), spec('fix', { dependencies: ['r'] })];
    expect(checked(worktree).ok).toBe(true);
  });

  it('refuses a script check where nothing can seal, on the one check of every route', () => {
    const tasks = checked([delegated('d'), scriptCheck('c', ['d'])]);
    if (!tasks.ok) throw new Error('expected a plan');
    expect(checkPlanInvariants(tasks.tasks, runners, modes, { canSeal: false }).map((e) => e.message)).toContain('Task "Task c" is a read-only script task, and this machine has no sandbox to seal one in: make the check a read-only AI task');
    expect(checkPlanInvariants(tasks.tasks, runners, modes, { canSeal: true })).toEqual([]);
  });
});

describe('a read-only script task (ADR-0055 D8)', () => {
  it('is kept, and holds no ops flag: it runs past no gate', () => {
    const result = checked([scriptCheck('c', [])]);
    if (!result.ok) throw new Error('expected a plan');
    expect(result.tasks[0]).toMatchObject({ type: 'script', readOnly: true });
    expect(result.tasks[0].ops).toBeUndefined();
  });

  it('reads as it always did where nothing can delegate: refused, like any field a script does not have', () => {
    const result = validatePlanTasks({ tasks: [scriptCheck('c', [])] }, runners, modes);
    expect(result).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining('leave out "readOnly"') }] });
  });

  it('keeps its flag through an execution state overlay, as every planned field', () => {
    const before = createTask({ id: 'c', type: 'script', commands: [['true']], readOnly: true, status: 'completed' });
    expect(keepExecutionState([before], [createTask({ id: 'c', type: 'script', commands: [['true']], readOnly: true })])[0].readOnly).toBe(true);
  });
});

describe('an edit', () => {
  const plan: Task[] = (() => {
    const result = checked([delegated('d'), readOnlyCheck('c', ['d'])]);
    if (!result.ok) throw new Error('expected a plan');
    return result.tasks;
  })();

  const apply = (ops: unknown[]) => applyTaskOps(plan, ops as TaskOp[], runners, { modelsByRunner: {}, runnerModes: modes, delegationRefusal: null });

  it('adds a delegated task as a plan does, held to the same rules', () => {
    const added = apply([{ op: 'add', task: delegated('e', { order: undefined }), handle: 'e' }]);
    expect(added.ok).toBe(false);
    const withCheck = apply([
      { op: 'add', task: delegated('e', { order: undefined }), handle: 'e' },
      { op: 'add', task: spec('f', { readOnly: true, order: undefined, dependencies: ['e'] }) },
    ]);
    expect(withCheck.ok).toBe(true);
  });

  it('may change a delegated task\'s budget, goal and paths, and takes away no check', () => {
    expect(apply([{ op: 'update', taskId: 'd', changes: { budget: { tokens: 9 }, goal: 'another', protectedPaths: ['ci/'] } }])).toMatchObject({ ok: true });
    expect(apply([{ op: 'remove', taskId: 'c' }]).ok).toBe(false);
  });
});

describe('who may write one (ADR-0056 M2, M4, ADR-0055 D2, D19)', () => {
  const root = (over: Partial<Parameters<typeof rootMandate>[0]> = {}) => rootMandate({ level: 'watch', autorun: false, autonomous: true, delegationTokens: 1_000_000, runners, models: {}, ...over });

  const scopeOf = (mandate: Mandate | undefined, level = 0, before: Task[] = [], asChild = false, budget?: NodeFunds): PlanChangeScope => ({
    tasks: () => before,
    runners: () => runners,
    catalog: () => ({ modelsByRunner: {}, runnerModes: modes }),
    ...(mandate ? { node: () => ({ mandate, level, ...(budget ? { budget } : {}) }) } : {}),
    ...(asChild && mandate ? { child: () => ({ depth: level, mandate: () => mandate }) } : {}),
  });

  const submitted = (scope: PlanChangeScope, tasks: Record<string, unknown>[]) => new PlanChangeCheck(scope).checkNow({ kind: 'plan', tasks }, 'submit');
  const messages = (outcome: ReturnType<typeof submitted>) => (outcome.ok ? [] : outcome.errors.map((e) => e.message));

  const pair = [delegated('d'), readOnlyCheck('c', ['d'])];

  it('passes for a node that holds `delegate`, and is refused with delegation off', () => {
    expect(submitted(scopeOf(root()), pair).ok).toBe(true);
    expect(messages(submitted(scopeOf(root({ delegationTokens: 0 })), pair))[0]).toBe('Level 0 refused this: it needs the delegate grant, and this node holds observe, research.');
  });

  it('is refused for a planner with no node behind it, a one-shot plan', () => {
    expect(messages(submitted(scopeOf(undefined), pair))[0]).toMatch(/delegation is not available/);
  });

  it('is narrowed as it is written: a budget past what is there is refused, naming the level', () => {
    const big = [delegated('d', { budget: { tokens: 2_000_000 } }), readOnlyCheck('c', ['d'])];
    expect(messages(submitted(scopeOf(root()), big))[0]).toBe('Level 0 refused limits.tokens: asked 2000000, and there is 1000000.');
  });

  describe('the budgets of a plan together (ADR-0056 M5)', () => {
    const asking = (...tokens: number[]) => tokens.flatMap((each, i) => [delegated(`d${i}`, { budget: { tokens: each } }), readOnlyCheck(`c${i}`, [`d${i}`])]);
    const standing = (...tokens: number[]) => {
      const planned = checked(asking(...tokens));
      if (!planned.ok) throw new Error('expected a plan');
      return planned.tasks;
    };

    it('refuses budgets each of which passes alone and that together pass what is there, once', () => {
      expect(messages(submitted(scopeOf(root()), asking(600_000, 600_000)))).toEqual(['Level 0 refused limits.tokens: asked 1200000, and there is 1000000.']);
    });

    it('takes budgets that come to exactly what is there', () => {
      expect(submitted(scopeOf(root()), asking(600_000, 400_000)).ok).toBe(true);
    });

    const edited = (scope: PlanChangeScope, ...ops: unknown[]) => new PlanChangeCheck(scope).checkNow({ kind: 'ops', ops: ops as TaskOp[] }, 'land');
    const added = (id: string, tokens: number) => [
      { op: 'add', task: delegated(id, { order: undefined, budget: { tokens } }), handle: id },
      { op: 'add', task: spec(`check-${id}`, { readOnly: true, order: undefined, dependencies: [id] }) },
    ];

    it('holds an edit to what the plan\'s other tasks still ask', () => {
      const scope = scopeOf(root(), 0, standing(700_000));
      expect(messages(edited(scope, ...added('more', 400_000)))).toEqual(['Level 0 refused limits.tokens: asked 1100000, and there is 1000000.']);
      expect(edited(scope, ...added('more', 300_000)).ok).toBe(true);
    });

    it('leaves a plan already past what is there free to come down, and to change what asks no more', () => {
      const scope = scopeOf(root(), 0, standing(600_000, 600_000));
      expect(edited(scope, { op: 'update', taskId: 'd1', changes: { budget: { tokens: 500_000 } } }).ok).toBe(true);
      expect(edited(scope, { op: 'update', taskId: 'd1', changes: { goal: 'another' } }).ok).toBe(true);
      expect(messages(edited(scope, { op: 'update', taskId: 'd1', changes: { budget: { tokens: 700_000 } } }))).toEqual(['Level 0 refused limits.tokens: asked 1300000, and there is 1000000.']);
    });

    it('counts nothing for a task that has finished, whatever a whole plan\'s JSON says of it', () => {
      const done = standing(600_000, 300_000).map((task) => (task.id === 'd0' ? { ...task, status: 'completed' as const } : task));
      const scope = scopeOf(root(), 0, done);
      expect(edited(scope, ...added('more', 600_000)).ok).toBe(true);
      expect(submitted(scope, [...asking(600_000, 300_000), ...added('more', 600_000).map((op) => ({ ...op.task, order: 9 }))]).ok).toBe(true);
    });

    it('reads what a ledger says is left over the mandate\'s limit, and a task\'s own ask from it', () => {
      const budget = { limit: 1_000_000, left: 500_000, stillAsks: (task: Pick<Task, 'id'>) => (task.id === 'd0' ? 100_000 : 400_000) };
      const held = (tasks: Task[]) => scopeOf(root(), 0, tasks, false, budget);
      expect(submitted(held([]), asking(900_000, 900_000)).ok).toBe(true);
      const three = { ...budget, stillAsks: () => 300_000 };
      expect(messages(submitted(scopeOf(root(), 0, [], false, three), asking(10, 10)))).toEqual(['Level 0 refused limits.tokens: asked 600000, and there is 500000.']);
    });

    it('holds one task to a raised limit, which its saved mandate does not know of, and to a lowered one', () => {
      const raised = { limit: 1_500_000, left: 1_500_000, stillAsks: (task: Pick<Task, 'budget'>) => task.budget?.tokens ?? 0 };
      const child = root({ level: 'act' });
      expect(submitted(scopeOf(child, 1, [], true, raised), asking(1_200_000)).ok).toBe(true);
      const lowered = { limit: 400_000, left: 900_000, stillAsks: () => 0 };
      expect(messages(submitted(scopeOf(child, 1, [], true, lowered), asking(500_000)))).toEqual(['Level 1 refused limits.tokens: asked 500000, and there is 400000.']);
    });
  });

  it('holds a plan to the delegated tasks its mandate allows', () => {
    const tasks = [...Array.from({ length: 9 }, (_, i) => delegated(`d${i}`)), ...Array.from({ length: 9 }, (_, i) => readOnlyCheck(`c${i}`, [`d${i}`]))];
    expect(messages(submitted(scopeOf(root()), tasks))).toContain('Level 0 refused limits.delegatedTasks: asked 9, and there is 8.');
  });

  it('holds a plan to the delegated tasks the user set, not the default', () => {
    const two = [delegated('d0'), delegated('d1'), readOnlyCheck('c0', ['d0']), readOnlyCheck('c1', ['d1'])];
    expect(messages(submitted(scopeOf(root({ shape: { delegatedTasks: 1 } })), two))).toContain('Level 0 refused limits.delegatedTasks: asked 2, and there is 1.');
    expect(submitted(scopeOf(root({ shape: { delegatedTasks: 2 } })), two).ok).toBe(true);
  });

  it('holds a child plan to its tasks, and leaves a root plan none', () => {
    const child = { ...root(), limits: { ...root().limits, tasksPerPlan: 2, depth: 0 } };
    const tasks = [spec('a'), spec('b'), spec('c')];
    expect(messages(submitted(scopeOf(child, 1, [], true), tasks))).toContain('Level 1 refused limits.tasksPerPlan: asked 3, and there is 2.');
    expect(submitted(scopeOf(root()), Array.from({ length: 200 }, (_, i) => spec(`t${i}`))).ok).toBe(true);
  });

  it('refuses ops and user tasks in a child plan, which act on the user\'s systems or wait on a person (D2)', () => {
    const child = root();
    expect(messages(submitted(scopeOf(child, 1, [], true), [spec('a', { ops: true })]))).toContain('Level 1 refused Task "Task a": an ops task acts on the user\'s systems from their checkout, so none runs below the root.');
    const manual = { id: 'u', order: 1, title: 'Task u', description: 'u', type: 'user', sliceType: 'HITL', userSteps: [{ order: 1, instruction: 'x' }], dependencies: [] };
    expect(messages(submitted(scopeOf(child, 1, [], true), [manual]))).toContain('Level 1 refused Task "Task u": a manual task waits on a person, and none is below the root.');
  });

  it('refuses a delegated task where the depth has run out', () => {
    const atTheBottom = { ...root({ level: 'act' }), limits: { ...root().limits, depth: 0 } };
    expect(messages(submitted(scopeOf(atTheBottom, 2, [], true), pair))[0]).toBe('Level 2 refused limits.depth: asked a child, and there is no depth left.');
  });

  it('checks only what the change wrote: a plan that already holds one is left to its carve', () => {
    const planned = checked(pair);
    if (!planned.ok) throw new Error('expected a plan');
    const off = scopeOf(root({ delegationTokens: 0 }), 0, planned.tasks);
    expect(new PlanChangeCheck(off).checkNow({ kind: 'ops', ops: [{ op: 'add', task: spec('more', { order: undefined }) }] as TaskOp[] }, 'land').ok).toBe(true);
  });
});
