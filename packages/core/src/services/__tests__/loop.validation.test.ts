import { describe, it, expect } from 'vitest';
import { validatePlanTasks } from '../PlanValidator';
import { applyTaskOps, canMergeTasks, canSplitTask, type TaskOp } from '../TaskOps';
import { PLANNER_TOOLS, type PlannerToolHandler } from '../mcp/tools';
import { PlanStore } from '../PlanStore';
import { createTask, keepExecutionState, removeTaskFromPlan, type Task, type Verdict } from '../../models/Task';
import { betweenRounds, DEFAULT_LOOP_ROUNDS, outOfRounds } from '../../models/Loop';
import { blockingFailures, repeatingChecks } from '../blocking';
import { collectDirectDependencyOutputs, renderPriorOutputs } from '../promptAugment';
import { mergeGate, startWaits, type StartRuleInput } from '../readiness';
import { renderTaskQueryAnswer } from '../TaskQuery';
import { serializeTask, serializeTaskStatus } from '../SessionMessage';

/**
 * A loop as a plan holds it (ADR-0045 L1): declared on its check, its body
 * top-level tasks that run only for it, on a graph that stays acyclic. Every
 * route a loop arrives by holds it to that.
 */

const runners = ['claude-code'];
const spec = (id: string, order: number, over: Record<string, unknown> = {}) => ({
  id, order, title: `Task ${id}`, description: id, type: 'ai', prompt: `do ${id}`, sliceType: 'AFK', autonomy: 'AFK', dependencies: [], ...over,
});
/** build → review (the check; body fix, retest) → ship. */
const looped = (review: Record<string, unknown> = {}, extra: Record<string, unknown>[] = []) => [
  spec('build', 1),
  spec('review', 2, { dependencies: ['build'], loop: { body: ['fix', 'retest'] }, ...review }),
  spec('fix', 3, { dependencies: ['review', 'build'] }),
  spec('retest', 4, { dependencies: ['review', 'fix'] }),
  spec('ship', 5, { dependencies: ['review'] }),
  ...extra,
];

function refusals(tasks: Record<string, unknown>[]): string[] {
  const result = validatePlanTasks({ tasks }, runners);
  if (result.ok) throw new Error('expected a refusal');
  return result.errors.map((e) => e.message);
}

const failed = (reported: Verdict['reported']): Verdict => ({ outcome: 'fail', reason: 'found problems', checks: [], decidedAt: '2026-10-20T00:00:00Z', reported });

describe('a submitted plan with a loop', () => {
  it('accepts a check whose body depends on it and on what it depends on, with three rounds unless it says otherwise', () => {
    const result = validatePlanTasks({ tasks: looped() }, runners);

    expect(result.ok).toBe(true);
    const review = result.ok ? result.tasks.find((t) => t.id === 'review') : undefined;
    expect(review?.loop).toEqual({ body: ['fix', 'retest'], maxRounds: DEFAULT_LOOP_ROUNDS });
    expect(validatePlanTasks({ tasks: looped({ loop: { body: ['fix', 'retest'], maxRounds: 10 } }) }, runners).ok).toBe(true);
  });

  it('accepts a script task as the check', () => {
    const tasks = looped({ type: 'script', prompt: undefined, autonomy: undefined, commands: [['npm', 'test']] });
    expect(validatePlanTasks({ tasks }, runners).ok).toBe(true);
  });

  it('refuses rounds out of range, and a loop of the wrong shape', () => {
    expect(refusals(looped({ loop: { body: ['fix', 'retest'], maxRounds: 0 } }))).toContain('Task "Task review" has "maxRounds" 0: a loop runs its check from 1 to 10 times, or 3 when it is left out');
    expect(refusals(looped({ loop: { body: ['fix', 'retest'], maxRounds: 11 } }))[0]).toMatch(/has "maxRounds" 11/);
    expect(refusals(looped({ loop: { body: ['fix', 'retest'], maxRounds: 2.5 } }))[0]).toMatch(/has "maxRounds" 2.5/);
    expect(refusals(looped({ loop: ['fix'] }))).toContain('Task "Task review" has a "loop" that is not {"body": ["<task id>", ...], "maxRounds"?: <rounds>}');
    expect(refusals(looped({ loop: { body: [] } }))).toContain('Task "Task review" has a "loop" with an empty "body": name the tasks that fix what it finds');
  });

  it('refuses a body task that is no task in the plan, the check itself, or named twice', () => {
    expect(refusals(looped({ loop: { body: ['fix', 'retest', 'ghost'] } }))).toContain('Task "Task review" names "ghost" in its loop\'s "body", which is no task in the plan');
    expect(refusals(looped({ loop: { body: ['fix', 'retest', 'review'] } }))).toContain('Task "Task review" names itself in its loop\'s "body": the body is the tasks that fix what it finds');
    expect(refusals(looped({ loop: { body: ['fix', 'retest', 'fix'] } }))).toContain('Task "Task review" names "Task fix" twice in its loop\'s "body"');
  });

  it('refuses a subtask in a body, and a subtask as a check', () => {
    const withSub = looped({ loop: { body: ['fix', 'retest', 'part'] } }, [spec('host', 6, { subtasks: [spec('part', 1)] })]);
    expect(refusals(withSub)).toContain('Task "Task review" names subtask "Task part" of "Task host" in its loop\'s "body": only a top-level task can be in a loop\'s body');
    const subCheck = [spec('host', 1, { subtasks: [spec('inner', 1, { loop: { body: ['x'] } })] }), spec('x', 2, { dependencies: ['inner'] })];
    expect(refusals(subCheck)).toContain('subtask "Task inner" of "Task host" has a "loop", but only a top-level task can be a loop\'s check');
  });

  it('refuses a task in two loops, and a loop inside a body', () => {
    const two = [...looped(), spec('audit', 6, { loop: { body: ['fix'] } })];
    expect(refusals(two)).toContain('Task "Task audit" names "Task fix" in its loop\'s "body", which is in the body of "Task review"\'s loop too: a task belongs to one loop only');
    const nested = looped({}, []).map((t) => (t.id === 'fix' ? { ...t, loop: { body: ['ship'] } } : t));
    expect(refusals(nested)).toContain('Task "Task review" names "Task fix" in its loop\'s "body", which has a loop of its own: a loop has no loop inside its body');
  });

  it('refuses a manual check, a manual body task, and loop tasks with subtasks', () => {
    const manual = looped({ type: 'user', prompt: undefined, autonomy: undefined, sliceType: 'HITL', userSteps: [{ order: 1, instruction: 'look' }] });
    expect(refusals(manual)[0]).toMatch(/^Task "Task review" is a manual task, so it cannot be a loop's check/);
    const manualBody = looped().map((t) => (t.id === 'fix' ? { ...t, type: 'user', prompt: undefined, autonomy: undefined, sliceType: 'HITL', userSteps: [{ order: 1, instruction: 'fix' }] } : t));
    expect(refusals(manualBody)).toContain('Task "Task review" names manual task "Task fix" in its loop\'s "body": a body is AI or script tasks, which Ordewell runs again each round');
    const parent = looped({ subtasks: [spec('step', 1)] });
    expect(refusals(parent)).toContain('Task "Task review" is a loop\'s check, which has no subtasks: each round runs it again whole');
  });

  it('refuses a body task that does not depend on the check, or depends on anything else', () => {
    const loose = looped().map((t) => (t.id === 'fix' ? { ...t, dependencies: ['build'] } : t));
    expect(refusals(loose)).toContain('Task "Task fix" is in the body of "Task review"\'s loop, so it depends on "Task review": the check\'s report is what it fixes. Add "Task review" to its dependencies');
    const wider = looped({}, [spec('docs', 6)]).map((t) => (t.id === 'fix' ? { ...t, dependencies: ['review', 'docs'] } : t));
    expect(refusals(wider)).toContain('Task "Task fix" is in the body of "Task review"\'s loop, so it depends only on "Task review", on what "Task review" depends on, or on other tasks of that body; "Task docs" is none of these');
  });

  it('refuses a task outside the loop that depends on its body, and a check that waits for its own body', () => {
    const outside = looped().map((t) => (t.id === 'ship' ? { ...t, dependencies: ['review', 'fix'] } : t));
    expect(refusals(outside)).toContain('Task "Task ship" depends on "Task fix", which is in the body of "Task review"\'s loop and runs only if "Task review" fails: depend on "Task review" instead');
    const backEdge = looped().map((t) => (t.id === 'review' ? { ...t, dependencies: ['build', 'fix'] } : t));
    const messages = refusals(backEdge);
    expect(messages).toContain('Task "Task review" depends on "Task fix" from its own loop\'s body: the body runs after the check, so the check cannot wait for it');
    expect(messages.some((m) => m.startsWith('Dependency cycle detected'))).toBe(true);
  });

  it('takes a loop through submit_plan\'s schema', async () => {
    const submit = PLANNER_TOOLS.find((t) => t.name === 'submit_plan')!;
    let submitted: unknown;
    const handler: PlannerToolHandler = { submitPlan: async (args) => { submitted = args; return { text: 'ok' }; } };

    const reply = await submit.call(handler, { tasks: looped({ loop: { body: ['fix', 'retest'], maxRounds: 2 } }) }, { signal: new AbortController().signal });

    expect(reply.isError).toBeFalsy();
    expect(submitted).toMatchObject({ tasks: expect.arrayContaining([expect.objectContaining({ id: 'review', loop: { body: ['fix', 'retest'], maxRounds: 2 } })]) });
  });
});

describe('a loop through edit_plan', () => {
  const plan = (): Task[] => {
    const result = validatePlanTasks({ tasks: looped() }, runners);
    if (!result.ok) throw new Error(result.errors[0].message);
    return result.tasks;
  };
  const apply = (ops: TaskOp[], tasks = plan()) => applyTaskOps(tasks, ops, runners);

  it('sets a loop with task references, resolved to ids, and drops one with null', () => {
    const base = plan().map((t) => (t.id === 'review' ? { ...t, loop: undefined } : t));
    const set = apply([{ op: 'update', taskId: '#2', changes: { loop: { body: ['#3', '#4'], maxRounds: 2 } } as Partial<Task> }], base);
    expect(set.ok).toBe(true);
    expect(set.tasks.find((t) => t.id === 'review')?.loop).toEqual({ body: ['fix', 'retest'], maxRounds: 2 });

    const dropped = apply([{ op: 'update', taskId: 'review', changes: { loop: null } as unknown as Partial<Task> }]);
    expect(dropped.ok).toBe(true);
    expect(dropped.tasks.find((t) => t.id === 'review')?.loop).toBeUndefined();
  });

  it('adds a body task by handle and then makes the check\'s loop name it', () => {
    const base = plan().map((t) => (t.id === 'review' ? { ...t, loop: undefined } : t)).filter((t) => t.id !== 'fix' && t.id !== 'retest');
    const result = apply([
      { op: 'add', task: { title: 'Patch it', description: 'patch', prompt: 'patch', dependencies: ['review'], sliceType: 'AFK', autonomy: 'AFK' }, handle: 'patch' },
      { op: 'update', taskId: 'review', changes: { loop: { body: ['patch'] } } as Partial<Task> },
    ], base);

    expect(result.ok).toBe(true);
    const patch = result.handles!.get('patch')!;
    expect(result.tasks.find((t) => t.id === 'review')?.loop).toEqual({ body: [patch], maxRounds: 3 });
  });

  it('refuses a loop edit that breaks a rule, naming the op', () => {
    const result = apply([{ op: 'update', taskId: 'review', changes: { loop: { body: ['build'] } } as Partial<Task> }]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/^op 1 \(update\): /);
  });

  it('takes a removed body task out of its loop, and drops a loop left with no body', () => {
    const one = apply([{ op: 'remove', taskId: 'retest' }]);
    expect(one.ok).toBe(true);
    expect(one.tasks.find((t) => t.id === 'review')?.loop?.body).toEqual(['fix']);

    const both = apply([{ op: 'remove', taskId: 'retest' }, { op: 'remove', taskId: 'fix' }]);
    expect(both.ok).toBe(true);
    expect(both.tasks.find((t) => t.id === 'review')?.loop).toBeUndefined();
  });

  it('refuses to remove a check whose body would be left to run on its own', () => {
    const result = apply([{ op: 'remove', taskId: 'review' }]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('"Task review" is a loop\'s check: remove its body tasks first, or drop its loop ("loop": null)');
  });

  it('refuses to merge or split a loop\'s tasks', () => {
    const merged = apply([{ op: 'merge', taskIds: ['fix', 'retest'], merged: { title: 'Fix and retest', description: 'both' } }]);
    expect(merged.errors[0]).toContain('"Task fix" is in a loop\'s body and cannot be merged');
    const split = apply([{ op: 'split', taskId: 'review', parts: [{ title: 'A', description: 'a' }, { title: 'B', description: 'b' }] }]);
    expect(split.errors[0]).toContain('"Task review" is a loop\'s check and cannot be split');
    expect(canMergeTasks(plan(), ['fix', 'retest'])).toMatchObject({ ok: false });
    expect(canSplitTask(plan(), 'review')).toMatchObject({ ok: false });
  });

  it('starts a re-armed check\'s rounds over', () => {
    const tasks = plan().map((t) => (t.id === 'review' ? { ...t, status: 'failed' as const, verdict: failed('failed'), loopRound: 3 } : t));
    const result = apply([{ op: 'rearm', taskId: 'review' }], tasks);
    expect(result.tasks.find((t) => t.id === 'review')).toMatchObject({ status: 'pending' });
    expect(result.tasks.find((t) => t.id === 'review')?.loopRound).toBeUndefined();
  });
});

describe('the loop\'s derived state (ADR-0045 L3)', () => {
  const check = (over: Partial<Task> = {}) => createTask({ id: 'review', order: 1, title: 'Review', prompt: 'review', loop: { body: ['fix'], maxRounds: 2 }, ...over });
  const body = (over: Partial<Task> = {}) => createTask({ id: 'fix', order: 2, title: 'Fix', prompt: 'fix', dependencies: ['review'], ...over });
  const ship = createTask({ id: 'ship', order: 3, title: 'Ship', prompt: 'ship', dependencies: ['review'] });

  it('reads a check between rounds only off a `failed` report with rounds left', () => {
    expect(betweenRounds(check({ status: 'failed', verdict: failed('failed') }))).toBe(true);
    expect(betweenRounds(check({ status: 'failed', verdict: failed('blocked') }))).toBe(false);
    expect(betweenRounds(check({ status: 'failed', verdict: failed(undefined) }))).toBe(false);
    expect(betweenRounds(check({ status: 'failed', verdict: failed('failed'), loopRound: 2 }))).toBe(false);
    expect(outOfRounds(check({ status: 'failed', verdict: failed('failed'), loopRound: 2 }))).toBe(true);
  });

  it('blocks nothing while the loop goes on, and blocks the check\'s dependents once a body task fails', () => {
    const between = check({ status: 'failed', verdict: failed('failed') });
    expect(blockingFailures([between, body(), ship])).toEqual(new Map());
    expect(repeatingChecks([between, body(), ship])).toEqual(new Set(['review']));

    expect(blockingFailures([between, body({ status: 'failed' }), ship])).toEqual(new Map([['ship', ['review']]]));
    expect(repeatingChecks([between, body({ status: 'skipped' }), ship])).toEqual(new Set());
  });

  it('reads a saved plan without loops as before', () => {
    const plain = [createTask({ id: 'a', order: 1, status: 'failed', verdict: failed('failed') }), createTask({ id: 'b', order: 2, dependencies: ['a'] })];
    expect(blockingFailures(plain)).toEqual(new Map([['b', ['a']]]));
  });

  it('keeps a check failed through a load, and a new run keeps one between rounds and starts the rounds of one out of them over', () => {
    const store = new PlanStore();
    store.load([check({ status: 'failed', verdict: failed('failed') }), body(), ship], ['claude-code']);
    expect(store.get('review')?.status).toBe('failed');
    store.resetForRun();
    expect(store.get('review')?.status).toBe('failed');

    store.load([check({ status: 'failed', verdict: failed('failed'), loopRound: 2 }), body({ status: 'completed' }), ship], ['claude-code']);
    expect(store.get('review')).toMatchObject({ status: 'failed', loopRound: 2 });
    store.resetForRun();
    expect(store.get('review')).toMatchObject({ status: 'approved' });
    expect(store.get('review')?.loopRound).toBeUndefined();
  });

  it('counts the round on for the loop\'s own run, and starts it over for a retry, but not for a resume', () => {
    const store = new PlanStore();
    store.load([check({ status: 'completed', loopRound: 2 }), body(), ship], ['claude-code']);
    store.repeat('review');
    expect(store.get('review')).toMatchObject({ status: 'pending', loopRound: 3 });
    store.retry('review', { sameRound: true });
    expect(store.get('review')?.loopRound).toBe(3);
    store.retry('review');
    expect(store.get('review')?.loopRound).toBeUndefined();
  });

  it('keeps the round a planner\'s rewrite restates the check without', () => {
    const current = [check({ status: 'failed', verdict: failed('failed'), loopRound: 2 }), body(), ship];
    const rewrite = [check({ title: 'Review again' }), body(), ship];
    expect(keepExecutionState(current, rewrite)[0]).toMatchObject({ title: 'Review again', status: 'failed', loopRound: 2 });
  });

  it('drops a loop whose last body task leaves the plan', () => {
    const tasks = removeTaskFromPlan([check({ loopRound: 2 }), body(), ship], 'fix');
    expect(tasks[0].loop).toBeUndefined();
    expect(tasks[0].loopRound).toBeUndefined();
  });
});

describe('what the rest of core reads of a loop', () => {
  const tasks = (): Task[] => [
    createTask({ id: 'review', order: 1, title: 'Review', type: 'script', commands: [['npm', 'test']], taskMode: undefined, status: 'failed', verdict: failed('failed'), loop: { body: ['fix'], maxRounds: 3 } }),
    createTask({ id: 'fix', order: 2, title: 'Fix', prompt: 'fix', dependencies: ['review'] }),
  ];
  const input = (all: Task[], awaitsMerge: (id: string) => boolean = () => false): StartRuleInput => {
    const store = new PlanStore();
    store.load(all, ['claude-code']);
    return {
      store,
      onHold: new Set(),
      approved: () => true,
      runs: { openRecord: () => undefined, awaitsMerge },
      merging: false,
      startsHeld: false,
      completing: new Set(),
      queued: new Set(),
    };
  };

  it('gives the body its check\'s report and round, and lets it start', () => {
    const all = tasks();
    all[0].outputSummary = { reviewReason: 'The script failed: `npm test` exited with code 1.', logTail: '2 failing', capturedAt: '2026-10-20T00:00:00Z' };
    const outputs = collectDirectDependencyOutputs(all[1], all);
    expect(outputs[0]).toMatchObject({ title: 'Review', round: { round: 1, maxRounds: 3 } });
    expect(renderPriorOutputs(outputs)).toContain('it failed round 1 of 3, and you are part of the fix');
    const rule = input(all);
    expect(startWaits(rule.store.get('fix')!, rule)).toEqual([]);
  });

  it('names the AI check\'s findings and round while keeping the instruction to fix its report', () => {
    const all = tasks();
    all[0] = { ...all[0], type: 'ai', prompt: 'Review', loopRound: 2,
      handoff: { summary: 'Two holes.', findings: [
        { id: 'F1', severity: 'major', title: 'Comma lost' },
        { id: 'F2', severity: 'minor', title: 'Escape doubled' },
      ], findingCount: 2 },
    };

    const prompt = renderPriorOutputs(collectDirectDependencyOutputs(all[1], all));

    expect(prompt).toContain('it failed round 2 of 3, and you are part of the fix. Answer its findings F1 and F2. Fix what its report found; it runs again once the fix has landed.');
    expect(prompt).toContain('F1 [major] Comma lost');
    expect(prompt).toContain('F2 [minor] Escape doubled');
  });

  it('holds a check that runs outside a worktree at its merge gate for its body\'s landed work', () => {
    const all = tasks().map((t) => (t.id === 'review' ? { ...t, status: 'pending' as const, verdict: undefined, loopRound: 2 } : { ...t, status: 'completed' as const }));
    const rule = input(all, (id) => id === 'fix');
    expect(mergeGate(rule.store.get('review')!, rule.store, rule.runs)).toEqual(['fix']);
  });

  it('shows the loop to task_query, and carries it to every surface', () => {
    const all = tasks();
    const answer = renderTaskQueryAnswer({ tasks: ['#1', '#2'], catalog: false }, all, { runners: [], models: {}, modes: {}, autonomousDefault: true });
    expect(answer).toContain('loop: body #2; at most 3 rounds; failed round 1, so its body is fixing what it found');
    expect(answer).toContain('loop: in the body of #1 "Review", so it runs only when that check fails');
    const repeated = { ...all[0], loopRound: 2 };
    expect(serializeTask(repeated)).toMatchObject({ loop: { body: ['fix'], maxRounds: 3 }, loopRound: 2 });
    expect(serializeTaskStatus(repeated)).toMatchObject({ loopRound: 2, verdict: { reported: 'failed' } });
  });
});
