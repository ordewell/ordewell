import { describe, expect, it } from 'vitest';
import { applyChainReview, chainReviewMessage, longestChain } from '../PlanChainReview';
import { BaseAiService, type PlanTextCall } from '../BaseAiService';
import { mergeGate } from '../readiness';
import { checkPlanInvariants } from '../PlannedTask';
import { createTask, type ResearchLogEntry, type RunnerId, type Task } from '../../models/Task';
import { fakeConfig } from '../../testing';

// Adversarial review of ADR-0072: what Ordewell holds whatever the review's reply says.
const RUNNERS: RunnerId[] = ['claude-code'];
const ai = (id: string, deps: string[], extra: Partial<Task> = {}): Task => createTask({ id, title: `T ${id}`, dependencies: deps, prompt: `Do ${id}.`, assignedRunner: 'claude-code', ...extra });

/** a > b > c > d, then an ops push after d. */
const withOps = () => [ai('a', []), ai('b', ['a']), ai('c', ['b']), ai('d', ['c']), ai('push', ['d'], { ops: true, prompt: 'Push the branch and watch CI.' })];
const withScript = () => [ai('a', []), ai('b', ['a']), ai('c', ['b']), ai('d', ['c']), createTask({ id: 'push', title: 'Push', type: 'script', commands: [['git', 'push']], dependencies: ['d'] })];
/** a > b > c > d > check (a loop, body fix). */
const withLoop = () => [ai('a', []), ai('b', ['a']), ai('c', ['b']), ai('d', ['c']), ai('check', ['a', 'b', 'c', 'd'], { readOnly: true, loop: { body: ['fix'], maxRounds: 2 } }), ai('fix', ['check'])];

class OneReply extends BaseAiService {
  constructor(private readonly reply: string) { super(fakeConfig()); }
  reset(): void {}
  ensureInit(): void {}
  protected async streamPlanText(_p: string, _h: string | undefined, _t: (x: string) => void, _r?: (x: string) => void, _s?: AbortSignal, call?: PlanTextCall): Promise<string> {
    call?.onReply?.({ cutOff: false });
    return this.reply;
  }
  review(tasks: Task[], log: ResearchLogEntry[] = []): Promise<Task[]> {
    return this.reviewLongChain(tasks, 'goal', '', '', {}, RUNNERS, () => {}, undefined, undefined, undefined, log);
  }
}

describe('a task that acts on the user\'s checkout keeps every task it acted after', () => {
  it.each([
    ['an ops task', withOps, 'push'],
    ['a script task', withScript, 'push'],
    ['a loop\'s check', withLoop, 'check'],
  ])('refuses a reply that drops what %s waits for', (_name, plan, id) => {
    const tasks = plan();
    expect(longestChain(tasks).length).toBeGreaterThanOrEqual(5);
    const r = applyChainReview(tasks, `{"dependencyChanges":[{"id":"${id}","dependencies":[]}]}`, RUNNERS);
    expect(r.ok).toBe(false);
  });

  it('refuses a reply that drops what a user task waits for', () => {
    const tasks = [ai('a', []), ai('b', ['a']), ai('c', ['b']), ai('d', ['c']), createTask({ id: 'try', title: 'Try it', type: 'user', dependencies: ['d'] })];
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"try","dependencies":["a"]}]}', RUNNERS);
    expect(r.ok ? 'applied' : r.error).toBe('task "try" would no longer run after "T d" (d), which it waits for');
  });

  it('refuses dropping the order between two ops tasks that collide in the checkout', () => {
    const tasks = [ai('a', []), ai('b', ['a']), ai('c', ['b']), ai('push', ['c'], { ops: true }), ai('tag', ['push'], { ops: true })];
    expect(applyChainReview(tasks, '{"dependencyChanges":[{"id":"tag","dependencies":["c"]}]}', RUNNERS).ok).toBe(false);
  });

  it('reviewLongChain returns the plan as written, its push still after the changes it pushes', async () => {
    const tasks = withOps();
    const out = await new OneReply('{"dependencyChanges":[{"id":"push","dependencies":[]}]}').review(tasks);
    expect(out.find((x) => x.id === 'push')!.dependencies).toEqual(['d']);
  });

  it('still lets a redundant direct edge of an ops task go, since it waits for the same tasks', () => {
    const tasks = [ai('a', []), ai('b', ['a']), ai('c', ['b']), ai('d', ['c']), ai('push', ['a', 'd'], { ops: true })];
    expect(applyChainReview(tasks, '{"dependencyChanges":[{"id":"push","dependencies":["d"]}]}', RUNNERS).ok).toBe(true);
  });
});

/** What the merge gate holds a task to, every other task completed and unmerged: the guard's source of truth. */
const gate = (tasks: Task[], id: string): string[] => {
  const all = (ts: Task[]): Task[] => ts.flatMap((t) => [t, ...all(t.subtasks)]);
  const flat = all(tasks);
  const rootOf = (x: string): Task => tasks.find((t) => all([t]).some((s) => s.id === x))!;
  const store = { allTasks: tasks, get: (x: string) => flat.find((t) => t.id === x), isCompleted: () => true, isOps: (x: string) => rootOf(x).ops === true };
  return mergeGate(flat.find((t) => t.id === id)!, store as never, { awaitsMerge: () => true } as never).sort();
};

describe('a path through a subtask counts as the merge gate counts it', () => {
  it('refuses a reply that lets an ops task waiting on a subtask act before that subtask\'s parent\'s ancestors', () => {
    // a > b > c > r (subtask s1); push (ops) waits on s1 alone.
    const tasks = [ai('a', []), ai('b', ['a']), ai('c', ['b']), ai('r', ['c'], { subtasks: [ai('s1', [])] }), ai('push', ['s1'], { ops: true })];
    expect(checkPlanInvariants(tasks, RUNNERS)).toEqual([]);
    expect(gate(tasks, 'push')).toEqual(['a', 'b', 'c', 's1']);
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"r","dependencies":[]}]}', RUNNERS);
    expect(r.ok ? gate(r.tasks, 'push') : r.error).toBe('task "push" would no longer run after "T c" (c), which it waits for');
  });

  it('refuses a reply that lets a user subtask check by hand before what it waits for has merged', () => {
    // a > b > x; change task r holds a user subtask that waits on x.
    const tasks = [ai('a', []), ai('b', ['a']), ai('x', ['b']), ai('r', [], { subtasks: [createTask({ id: 'try', title: 'Try it', type: 'user', dependencies: ['x'] })] })];
    expect(checkPlanInvariants(tasks, RUNNERS)).toEqual([]);
    expect(gate(tasks, 'try')).toEqual(['a', 'b', 'x']);
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"x","dependencies":[]}]}', RUNNERS);
    expect(r.ok ? gate(r.tasks, 'try') : r.error).toBe('task "try" would no longer run after "T b" (b), which it waits for');
  });

  it('refuses a reply that lets a loop\'s check, waiting on a subtask, check before its parent\'s ancestors', () => {
    const tasks = [ai('a', []), ai('b', ['a']), ai('c', ['b']), ai('r', ['c'], { subtasks: [ai('s1', [])] }),
      ai('check', ['s1'], { readOnly: true, loop: { body: ['fix'], maxRounds: 2 } }), ai('fix', ['check'])];
    expect(checkPlanInvariants(tasks, RUNNERS)).toEqual([]);
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"r","dependencies":[]}]}', RUNNERS);
    expect(r.ok ? 'applied' : r.error).toBe('task "check" would no longer run after "T c" (c), which it waits for');
  });

  it('still applies a change through a subtask that leaves every such task waiting for the same tasks', () => {
    // r's edge to a is redundant: r still waits for a through c.
    const tasks = [ai('a', []), ai('b', ['a']), ai('c', ['b']), ai('r', ['a', 'c'], { subtasks: [ai('s1', [])] }), ai('push', ['s1'], { ops: true })];
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"r","dependencies":["c"]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(r.tasks.find((x) => x.id === 'r')!.dependencies).toEqual(['c']);
    expect(r.tasks.find((x) => x.id === 'r')!.subtasks.map((s) => s.id)).toEqual(['s1']);
    expect(gate(r.tasks, 'push')).toEqual(['a', 'b', 'c', 's1']);
  });
});

describe('the revision note', () => {
  it('does not tell a task that a dependency it still waits for, through another, runs in parallel with it', () => {
    // c lists a and b, and b waits for a; the review drops c's direct edge to a, so c still runs after a.
    const tasks = [ai('a', []), ai('b', ['a']), ai('c', ['a', 'b']), ai('d', ['c']), ai('e', ['d'])];
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"c","dependencies":["b"]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(r.tasks.find((x) => x.id === 'c')!.prompt).toBe('Do c.');
    expect(r.changes).toEqual([{ id: 'c', removed: ['a'], added: [] }]);
  });

  it('reaches a delegated task, whose brief is its goal', () => {
    const tasks = [ai('a', []), ai('b', ['a']), ai('c', ['b']), ai('d', ['c']),
      createTask({ id: 'del', title: 'Del', type: 'delegated', goal: 'After "T d" lands, migrate the callers.', budget: { tokens: 100000 }, protectedPaths: ['test/'], dependencies: ['d'], assignedRunner: 'claude-code' }),
      ai('chk', ['del'], { readOnly: true, taskMode: 'plan' } as Partial<Task>)];
    const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"del","dependencies":["a"]}]}', RUNNERS);
    if (!r.ok) throw new Error(r.error);
    const del = r.tasks.find((x) => x.id === 'del')!;
    expect(del.dependencies).toEqual(['a']);
    expect(del.prompt).toBeUndefined();
    expect(del.goal).toBe('After "T d" lands, migrate the callers.\n\nPlan revision: this task no longer waits for "T d" (d), which runs in parallel with it. Where this brief says to wait for it, do not: take in its work once it has landed, and until then run this slice\'s tests, name each that fails only because that work has not landed in a finding, and leave those to the closing check. It now also runs after "T a" (a).');
    // The review judges its edges against that brief.
    expect(chainReviewMessage(tasks, longestChain(tasks))).toContain('"goal":"After \\"T d\\" lands, migrate the callers."');
  });
});

it('does not throw away a valid revision because the reply also answers for a subtask the message showed it', () => {
  const tasks = [ai('a', []), ai('b', ['a'], { subtasks: [ai('b1', []), ai('b2', ['b1'])] }), ai('c', ['b']), ai('d', ['c']), ai('e', ['d'])];
  const r = applyChainReview(tasks, '{"dependencyChanges":[{"id":"c","dependencies":["a"]},{"id":"b2","dependencies":[]}]}', RUNNERS);
  expect(r.ok ? r.tasks.find((x) => x.id === 'c')!.dependencies : r.error).toEqual(['a']);
  expect(r.ok && r.ignored).toEqual(['b2']);
  expect(r.ok && r.tasks.find((x) => x.id === 'b')!.subtasks[1].dependencies).toEqual(['b1']);
});

it('reviewLongChain keeps that revision and logs the subtask it ignored', async () => {
  const tasks = [ai('a', []), ai('b', ['a'], { subtasks: [ai('b1', []), ai('b2', ['b1'])] }), ai('c', ['b']), ai('d', ['c']), ai('e', ['d'])];
  const log: ResearchLogEntry[] = [];
  const out = await new OneReply('{"dependencyChanges":[{"id":"c","dependencies":["a"]},{"id":"b2","dependencies":[]}]}').review(tasks, log);
  expect(out.find((x) => x.id === 'c')!.dependencies).toEqual(['a']);
  expect(log.map((e) => ('content' in e ? String(e.content) : ''))).toEqual(['chain review: 5 -> 4, kept; 1 task changed: "T c" drops "T b" adds "T a"; ignored subtask b2']);
});
