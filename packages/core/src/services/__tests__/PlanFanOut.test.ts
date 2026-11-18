import { describe, expect, it } from 'vitest';
import { applyShapeReview, closingNote, fanOutShape, FAN_OUT_MIN, openingNote, shapeReviewMessage, sliceNote, withShapeNotes } from '../PlanFanOut';
import { chainReviewMessage, longestChain } from '../PlanChainReview';
import { BaseAiService, type PlanTextCall, type PlanTextReply } from '../BaseAiService';
import { createTask, type ResearchLogEntry, type RunnerId, type Task } from '../../models/Task';
import { fakeConfig } from '../../testing';
import { applyTaskOps } from '../TaskOps';

const RUNNERS: RunnerId[] = ['claude-code'];
const t = (id: string, deps: string[], extra: Partial<Task> = {}): Task =>
  createTask({ id, title: `T ${id}`, dependencies: deps, prompt: `Fill in src/lib/${id}.py.`, assignedRunner: 'claude-code', autonomy: 'AFK', sliceType: 'AFK', ...extra });
const ids = (ts: readonly Task[]) => ts.map((x) => x.id);
const slices = (n: number, deps: string[]) => Array.from({ length: n }, (_, i) => t(`s${i + 1}`, deps));
const sliceIds = (n: number) => Array.from({ length: n }, (_, i) => `s${i + 1}`);
const text = (e: ResearchLogEntry): string => ('content' in e ? String(e.content) : '');

/** Library 1: one opening task, the slices at once, one closing check. */
const good = () => [t('r', []), ...slices(6, ['r']), t('close', sliceIds(6))];
/** Library 2: three opening tasks in series, the import fix last. */
const serial = () => [t('g1', []), t('g2', ['g1']), t('g3', ['g2']), ...slices(6, ['g3']), t('close', sliceIds(6))];
/** Library 3: every slice at the first level, nothing before or after. */
const flat = () => slices(6, []);

describe('fanOutShape', () => {
  it('reads one opening task, the slices and one closing check, with no fault', () => {
    const s = fanOutShape(good());
    expect(s).toMatchObject({ wide: true, width: 6, sliceEdges: 0, faults: [] });
    expect(ids(s.gates)).toEqual(['r']);
    expect(ids(s.slices)).toEqual(sliceIds(6));
    expect(ids(s.closers)).toEqual(['close']);
  });

  it('names opening tasks in series, first to last', () => {
    const s = fanOutShape(serial());
    expect(ids(s.gates)).toEqual(['g1', 'g2', 'g3']);
    expect(s.faults).toEqual(['serial-opening']);
  });

  it('names a fan-out with nothing before it and nothing after it', () => {
    expect(fanOutShape(flat()).faults).toEqual(['no-opening', 'no-closing']);
  });

  it('takes the measured four-level shape, shared modules in parallel after the restoring task, as having no fault', () => {
    const plan = [t('r', []), t('m1', ['r']), t('m2', ['r']), ...slices(5, ['m1', 'm2']), t('close', [...sliceIds(5)])];
    const s = fanOutShape(plan);
    expect(s.faults).toEqual([]);
    expect(ids(s.gates)).toEqual(['r']);
    expect(s.sliceEdges).toBe(10);
  });

  it('counts a script loop check as the closing check, its fix out of the slices', () => {
    const plan = [t('r', []), ...slices(4, ['r']),
      createTask({ id: 'check', title: 'Run the suite', type: 'script', commands: [['pytest']], dependencies: sliceIds(4), sliceType: 'AFK', loop: { body: ['fix'], maxRounds: 3 } }),
      t('fix', ['check'])];
    const s = fanOutShape(plan);
    expect(ids(s.closers)).toEqual(['check']);
    expect(ids(s.slices)).toEqual(sliceIds(4));
    expect(s.faults).toEqual([]);
  });

  // A closing check fixes what still fails, so a task that cannot edit counts only with a loop whose body can.
  it('takes a read-only check with no loop to fix for it as no closing check', () => {
    for (const review of [
      t('review', sliceIds(4), { readOnly: true, prompt: 'Review the library.' }),
      createTask({ id: 'review', title: 'Run the suite', type: 'script', readOnly: true, commands: [['pytest']], dependencies: sliceIds(4), sliceType: 'AFK' }),
    ]) {
      const plan = [t('r', []), ...slices(4, ['r']), review];
      expect(fanOutShape(plan).closers).toEqual([]);
      expect(fanOutShape(plan).faults).toEqual(['no-closing']);
    }
  });

  it('does not count an ops task or a push after everything as a closing check', () => {
    const plan = [t('r', []), ...slices(4, ['r']), t('push', sliceIds(4), { ops: true })];
    expect(fanOutShape(plan).faults).toEqual(['no-closing']);
  });

  // The guards: a serial rename, a reproduction before its fix, and a fan-out narrower than the threshold are no fan-out.
  it.each([
    ['a serial chain', [t('a', []), t('b', ['a']), t('c', ['b'])]],
    ['a reproduction, then its fix, then a check', [t('repro', [], { readOnly: true }), t('fix', ['repro']), t('verify', ['fix'], { readOnly: true })]],
    ['three slices at once', [t('r', []), ...slices(FAN_OUT_MIN - 1, ['r'])]],
    ['a cycle', [t('a', ['b']), t('b', ['a'])]],
  ])('reads %s as no fan-out', (_name, plan) => {
    const s = fanOutShape(plan as Task[]);
    expect(s.wide).toBe(false);
    expect(s.faults).toEqual([]);
    expect(withShapeNotes(plan as Task[])).toBe(plan);
  });
});

describe('shapeReviewMessage', () => {
  const lines = (plan: Task[]) => shapeReviewMessage(plan, longestChain(plan), fanOutShape(plan)).split('\n');

  it('asks of a short flat plan only its faults, as measured, and no chain question', () => {
    const msg = lines(flat());
    expect(msg[0]).toBe('This is the plan you wrote:');
    expect(msg.slice(2)).toEqual([
      '',
      'This plan fans out: up to 6 of its slices run at once.',
      'No task runs before the slices. If the project does not import or collect its tests as it stands, add one task that restores just that: it may edit whichever files block it, whatever task owns them, implements nothing beyond that, and is checked by the project importing and its tests collecting. Every slice will wait for it. If the project imports and collects its tests already, add none.',
      'No task runs after every slice, so nothing runs the whole test suite once they have all ended. Add one closing check that runs it and fixes what still fails; it will wait for every slice.',
      'Reply as one JSON object and nothing else: {"dependencyChanges":[{"id":"<task id>","dependencies":["<task id>", ...]}],"addTasks":[{"id":"<new task id>","role":"restoring|closing","title":"<title>","prompt":"<its whole brief>"}]}. In "dependencyChanges" list only the tasks whose dependencies change, each with its complete new list, by the ids above; an empty list makes the task wait for none. In "addTasks" put only a task the questions above ask you to add; Ordewell sets what it waits for and what waits for it. When nothing changes, reply {"dependencyChanges":[],"addTasks":[]}.',
    ]);
  });

  it('asks a long chain the measured chain question first, then the serial opening', () => {
    const plan = serial();
    const msg = lines(plan);
    const chain = chainReviewMessage(plan, longestChain(plan)).split('\n');
    // Every line of the measured chain question but its reply line, as it stands.
    expect(msg.slice(0, chain.length - 1)).toEqual(chain.slice(0, -1));
    expect(msg[chain.length]).toBe('This plan fans out: up to 6 of its slices run at once.');
    expect(msg[chain.length + 1]).toBe('Before any slice starts, 3 tasks run one after another: "T g1" (g1) → "T g2" (g2) → "T g3" (g3). Every slice waits for all of them, so only one task should come first: the one that makes the project import and collect its tests, and nothing more. Make that task depend on nothing. Of the others, keep one before the slices only where it is one of a few shared modules most slices\' tests build their inputs with, and make it depend on that first task alone; make every other one a slice that depends on that first task alone.');
  });

  it('claims no authorship when asked alone after a cut-off', () => {
    const plan = flat();
    expect(shapeReviewMessage(plan, longestChain(plan), fanOutShape(plan), true).split('\n')[0]).toBe('This is a plan of tasks that coding agents will run, each task once its dependencies are done:');
  });
});

describe('applyShapeReview', () => {
  const restoring = { id: 'restore', role: 'restoring', title: 'Restore import and collection', prompt: 'Make the package import and its tests collect; implement nothing else.' };
  const closing = { id: 'close', role: 'closing', title: 'Run the whole suite', prompt: 'Run pytest over tests/ and fix what fails.' };

  it('adds a restoring task every slice waits for and a closing check that waits for every slice', () => {
    const plan = flat();
    const r = applyShapeReview(plan, fanOutShape(plan), JSON.stringify({ dependencyChanges: [], addTasks: [restoring, closing] }), RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(ids(r.added)).toEqual(['restore', 'close']);
    for (const s of r.tasks.filter((x) => x.id.startsWith('s'))) expect(s.dependencies).toEqual(['restore']);
    expect(r.tasks.find((x) => x.id === 'close')!.dependencies).toEqual(sliceIds(6));
    expect(r.tasks.find((x) => x.id === 'restore')!).toMatchObject({ dependencies: [], assignedRunner: 'claude-code', autonomy: 'AFK', sliceType: 'AFK' });
    expect(fanOutShape(r.tasks).faults).toEqual([]);
  });

  it('reorders opening tasks in series by dependency changes alone', () => {
    const plan = serial();
    const reply = '{"dependencyChanges":[{"id":"g3","dependencies":[]},{"id":"g1","dependencies":["g3"]},{"id":"g2","dependencies":["g3"]}],"addTasks":[]}';
    const r = applyShapeReview(plan, fanOutShape(plan), reply, RUNNERS);
    if (!r.ok) throw new Error(r.error);
    const after = fanOutShape(r.tasks);
    expect(ids(after.gates)).toEqual(['g3']);
    expect(after.faults).toEqual([]);
    expect(after.width).toBe(8);
    // The tasks moved beside the slices are slices the closing check waits for too.
    expect(r.tasks.find((x) => x.id === 'close')!.dependencies).toEqual([...sliceIds(6), 'g1', 'g2']);
  });

  it.each([
    ['a task no fault asks for', { dependencyChanges: [], addTasks: [{ ...restoring }] }, serial],
    ['an id the plan has', { dependencyChanges: [], addTasks: [{ ...restoring, id: 's1' }] }, flat],
    ['two restoring tasks', { dependencyChanges: [], addTasks: [restoring, { ...restoring, id: 'r2' }] }, flat],
    ['an unknown role', { dependencyChanges: [], addTasks: [{ ...restoring, role: 'helper' }] }, flat],
    ['a task with no brief', { dependencyChanges: [], addTasks: [{ ...restoring, prompt: ' ' }] }, flat],
  ])('rejects the whole reply on %s', (_name, reply, plan) => {
    const p = plan();
    expect(applyShapeReview(p, fanOutShape(p), JSON.stringify(reply), RUNNERS).ok).toBe(false);
  });
});

// ADR-0072 R1's guard, for a shape revision: what an ops task, a user task or a loop's check waits for, a task the reply adds included.
describe('applyShapeReview holds what a task acting on the checkout waits for', () => {
  const restoring = { id: 'restore', role: 'restoring', title: 'Restore import', prompt: 'Make it import.' };
  const closing = { id: 'close', role: 'closing', title: 'Run the suite', prompt: 'Run it.' };
  const reply = (dependencyChanges: unknown[], addTasks: unknown[]) => JSON.stringify({ dependencyChanges, addTasks });
  /** Six slices at once, then a push that waits for all of them: no closing check, no opening task. */
  const flatWithPush = () => [...flat(), t('push', sliceIds(6), { ops: true, prompt: 'Push the branch.' })];

  it('makes a push that waited for every slice wait for the closing check it adds too', () => {
    const plan = flatWithPush();
    const r = applyShapeReview(plan, fanOutShape(plan), reply([], [closing]), RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(r.tasks.find((x) => x.id === 'push')!.dependencies).toEqual([...sliceIds(6), 'close']);
    expect(r.tasks.find((x) => x.id === 'close')!.dependencies).toEqual(sliceIds(6));
  });

  it('makes a restoring task it adds wait for what every slice waited for: an install or a manual step', () => {
    for (const first of [
      t('install', [], { ops: true, prompt: 'npm install' }),
      t('setup', [], { type: 'user', prompt: undefined, description: 'Create the .env', sliceType: 'HITL', autonomy: 'HITL' }),
    ]) {
      const plan = [first, ...slices(4, [first.id]), t('close', sliceIds(4))];
      expect(fanOutShape(plan).faults).toEqual(['no-opening']);
      const r = applyShapeReview(plan, fanOutShape(plan), reply([], [restoring]), RUNNERS);
      if (!r.ok) throw new Error(r.error);
      expect(r.tasks.find((x) => x.id === 'restore')!.dependencies).toEqual([first.id]);
      expect(r.tasks.find((x) => x.id === 's1')!.dependencies).toEqual([first.id, 'restore']);
    }
  });

  it('makes a restoring task it adds wait for nothing when the slices share no wait', () => {
    const plan = [t('a', [], { ops: true, prompt: 'npm install' }), ...slices(5, []).map((x, i) => (i === 0 ? { ...x, dependencies: ['a'] } : x)), t('close', sliceIds(5))];
    const r = applyShapeReview(plan, fanOutShape(plan), reply([], [restoring]), RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(r.tasks.find((x) => x.id === 'restore')!.dependencies).toEqual([]);
  });

  it('refuses a reply that drops a slice the push waits for', () => {
    const plan = flatWithPush();
    const r = applyShapeReview(plan, fanOutShape(plan), reply([{ id: 'push', dependencies: sliceIds(6).slice(1) }], [closing]), RUNNERS);
    expect(r).toEqual({ ok: false, error: 'task "push" would no longer run after "T s1" (s1), which it waits for' });
  });

  it('refuses a reply that unhooks the restoring task it adds from what the push waits for', () => {
    const plan = flatWithPush();
    const r = applyShapeReview(plan, fanOutShape(plan), reply(sliceIds(6).map((id) => ({ id, dependencies: [] })), [restoring, closing]), RUNNERS);
    expect(r).toEqual({ ok: false, error: 'task "push" would no longer run after "Restore import" (restore), which it waits for' });
  });

  it('refuses a reply that drops what a slice\'s manual subtask waits for through its parent', () => {
    const plan = [t('r', []), t('s1', ['r'], { subtasks: [createTask({ id: 'try', title: 'Try it', type: 'user', dependencies: [] })] }), ...slices(4, ['r']).slice(1), t('s5', ['r'])];
    expect(fanOutShape(plan).faults).toEqual(['no-closing']);
    const r = applyShapeReview(plan, fanOutShape(plan), reply([{ id: 's1', dependencies: [] }], [closing]), RUNNERS);
    expect(r).toEqual({ ok: false, error: 'task "try" would no longer run after "T r" (r), which it waits for' });
  });

  it('refuses a reply that drops what a loop\'s check waits for', () => {
    const plan = [t('r', []), ...slices(4, ['r']), t('check', ['r', ...sliceIds(4)], { readOnly: true, loop: { body: ['fix'], maxRounds: 2 } }), t('fix', ['check']), t('g2', ['r'])];
    // A fifth slice beside the four: the check does not wait for it, so the plan has no closing check.
    expect(fanOutShape(plan).faults).toEqual(['no-closing']);
    const r = applyShapeReview(plan, fanOutShape(plan), reply([{ id: 'check', dependencies: sliceIds(4) }], [closing]), RUNNERS);
    expect(r.ok).toBe(true);
    const dropped = applyShapeReview(plan, fanOutShape(plan), reply([{ id: 'check', dependencies: sliceIds(3) }], [closing]), RUNNERS);
    expect(dropped).toEqual({ ok: false, error: 'task "check" would no longer run after "T s4" (s4), which it waits for' });
  });
});

describe('withShapeNotes', () => {
  it('notes the opening task, every slice and the closing check, once', () => {
    const plan = good();
    const shape = fanOutShape(plan);
    const out = withShapeNotes(plan);
    expect(out.find((x) => x.id === 'r')!.prompt).toBe(`Fill in src/lib/r.py.\n\n${openingNote(shape)}`);
    for (const s of sliceIds(6)) expect(out.find((x) => x.id === s)!.prompt).toBe(`Fill in src/lib/${s}.py.\n\n${sliceNote(shape)}`);
    expect(out.find((x) => x.id === 'close')!.prompt).toBe(`Fill in src/lib/close.py.\n\n${closingNote(shape)}`);
    expect(withShapeNotes(out)).toBe(out);
  });

  it('words the slice note as measured, with the map of who owns what', () => {
    const note = sliceNote(fanOutShape(good())).split('\n');
    expect(note[0]).toBe('Plan shape: this task is one of 6 slices that start once "T r" (r) has landed, and "T close" (close) runs the whole test suite once every slice has ended. Read the module map at the end of "T r" (r)\'s report (read, with include_report) before you explore. The tasks and the paths their briefs name:');
    expect(note.slice(1, 3)).toEqual(['- "T r" (r): src/lib/r.py', '- "T s1" (s1): src/lib/s1.py']);
    expect(note[note.length - 1]).toBe('Your scope is this brief\'s. You are done when the code in your scope is written and its tests pass, except tests that fail only because they call code another slice owns that has not landed in your worktree, or that ask for behaviour the repository does not let you derive. Run those once, list each as a finding with the module it waits for or why it cannot be derived, and end with status done: they are "T close" (close)\'s. Do not write, stub or shim another slice\'s code to make them pass, and do not keep iterating on them. End with status failed only when the code in your scope is not in place.');
  });

  it('reads the paths a brief names from the brief alone, not from a note already appended to it', () => {
    expect(sliceNote(fanOutShape(withShapeNotes(good())))).toBe(sliceNote(fanOutShape(good())));
  });

  it('words the opening and closing notes as measured', () => {
    const shape = fanOutShape(good());
    expect(openingNote(shape).split('\n')).toEqual([
      'Plan shape: 6 slices wait for this task to land before any of them starts, so finish it as soon as your brief allows and leave every module a slice owns to that slice. End your report with a map the slices read before they explore: for each module the tests import, its path, its public names, and the task below that owns it. Say in your summary that the map is in your report. The tasks and the paths their briefs name:',
      '- "T r" (r): src/lib/r.py',
      ...sliceIds(6).map((id) => `- "T ${id}" (${id}): src/lib/${id}.py`),
    ]);
    expect(closingNote(shape)).toBe('Plan shape: this check runs after the 6 slices. Read each slice\'s handoff with read: a slice that ended done lists the tests it left to you, and a slice that did not land (it failed and was skipped) left its module unwritten here, so write that module from its brief, its handoff and the tests. Run the whole test suite, fix what fails, and report each test that still fails with its reason.');
  });

  it('notes a read-only check\'s fix as the closing check, not the check that cannot edit', () => {
    const plan = [t('r', []), ...slices(4, ['r']), t('check', sliceIds(4), { readOnly: true, loop: { body: ['fix'], maxRounds: 3 } }), t('fix', ['check'])];
    const out = withShapeNotes(plan);
    expect(out.find((x) => x.id === 'fix')!.prompt).toBe(`Fill in src/lib/fix.py.\n\n${closingNote(fanOutShape(plan))}`);
    expect(out.find((x) => x.id === 'check')!.prompt).toBe('Fill in src/lib/check.py.');
  });

  it('notes a script check\'s fix as the closing check, and adds nothing without a closing check', () => {
    const plan = [t('r', []), ...slices(4, ['r']),
      createTask({ id: 'check', title: 'Run the suite', type: 'script', commands: [['pytest']], dependencies: sliceIds(4), sliceType: 'AFK', loop: { body: ['fix'], maxRounds: 3 } }),
      t('fix', ['check'])];
    expect(withShapeNotes(plan).find((x) => x.id === 'fix')!.prompt).toContain(closingNote(fanOutShape(plan)));
    expect(withShapeNotes(flat())).toEqual(flat());
  });
});

/** Answers each plan-text call with the next reply in turn, and keeps what each call asked for. */
class ReviewService extends BaseAiService {
  calls: { prompt: string; hint: string | undefined; call: PlanTextCall | undefined }[] = [];
  constructor(private readonly replies: readonly [string, PlanTextReply][]) { super(fakeConfig()); }
  reset(): void {}
  ensureInit(): void {}
  protected async streamPlanText(prompt: string, hint: string | undefined, _t: (x: string) => void, _r?: (x: string) => void, _s?: AbortSignal, call?: PlanTextCall): Promise<string> {
    const [reply, r] = this.replies[this.calls.length];
    this.calls.push({ prompt, hint, call });
    call?.onReply?.(r);
    return reply;
  }
  review(tasks: Task[], log: ResearchLogEntry[]): Promise<Task[]> {
    return this.reviewLongChain(tasks, 'goal', '', '', {}, RUNNERS, () => {}, undefined, undefined, undefined, log);
  }
}

describe('reviewLongChain on a fan-out', () => {
  const done = { cutOff: false };

  it('makes no call on a fan-out with no fault and a short chain, and notes its roles', async () => {
    const svc = new ReviewService([]);
    const log: ResearchLogEntry[] = [];
    const out = await svc.review(good(), log);
    expect(svc.calls).toHaveLength(0);
    expect(out.find((x) => x.id === 's1')!.prompt).toContain('Plan shape: this task is one of 6 slices');
    expect(log.map(text)).toEqual(['fan-out: 6 at once, 1 before, 1 after; role notes added']);
  });

  it('asks a flat plan its faults in one call, under the chain threshold, and keeps the mended plan', async () => {
    const reply = JSON.stringify({ dependencyChanges: [], addTasks: [
      { id: 'restore', role: 'restoring', title: 'Restore import', prompt: 'Make it import.' },
      { id: 'close', role: 'closing', title: 'Run the suite', prompt: 'Run it.' },
    ] });
    const svc = new ReviewService([[reply, done]]);
    const log: ResearchLogEntry[] = [];
    const out = await svc.review(flat(), log);
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0].call?.effort).toBe('low');
    expect(svc.calls[0].hint).toBe(shapeReviewMessage(flat(), longestChain(flat()), fanOutShape(flat())));
    expect(fanOutShape(out).faults).toEqual([]);
    expect(out.find((x) => x.id === 'restore')!.prompt).toContain('Plan shape: 6 slices wait for this task');
    expect(log.map(text)).toEqual([
      'shape review (no-opening, no-closing): 1 -> 3, kept (faults 2 -> 0); added "Restore import"; added "Run the suite"; 0 tasks changed',
      'fan-out: 6 at once, 1 before, 1 after; role notes added',
    ]);
  });

  it('keeps the first plan when the reply mends nothing, and still notes it when it has a closing check', async () => {
    const svc = new ReviewService([['{"dependencyChanges":[],"addTasks":[]}', done]]);
    const log: ResearchLogEntry[] = [];
    const plan = serial();
    const out = await svc.review(plan, log);
    expect(svc.calls).toHaveLength(1);
    expect(ids(fanOutShape(out).gates)).toEqual(['g1', 'g2', 'g3']);
    expect(out.find((x) => x.id === 'g1')!.prompt).toContain('Plan shape: 6 slices wait');
    expect(text(log[0])).toBe('shape review (serial-opening): 5 -> 5, first plan kept, faults 1 -> 1; 0 tasks changed');
  });

  it('asks a long serial plan the chain question word for word, with no fault question, and notes nothing', async () => {
    const plan = [t('a', []), t('b', ['a']), t('c', ['b']), t('d', ['c']), t('e', ['d'])];
    const svc = new ReviewService([['{"dependencyChanges":[]}', done]]);
    const log: ResearchLogEntry[] = [];
    const out = await svc.review(plan, log);
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0].hint).toBe(chainReviewMessage(plan, longestChain(plan)));
    expect(svc.calls[0].hint).not.toContain('fans out');
    expect(out).toBe(plan);
    expect(log.map(text)).toEqual(['chain review: 5 -> 5, first plan kept, not shorter; 0 tasks changed']);
  });

  it('notes nothing on a fan-out that is left with no closing check', async () => {
    const svc = new ReviewService([['{"dependencyChanges":[],"addTasks":[]}', done]]);
    const out = await svc.review(flat(), []);
    expect(out.some((x) => x.prompt?.includes('Plan shape:'))).toBe(false);
  });

  it('notes a plan once: a second review, a reload and an edit add no second note', async () => {
    const notes = (ts: readonly Task[]) => ts.map((x) => (x.prompt ?? '').split('Plan shape:').length - 1);
    const first = await new ReviewService([]).review(good(), []);
    expect(notes(first)).toEqual(Array(8).fill(1));

    const again = new ReviewService([]);
    expect(await again.review(first, [])).toEqual(first);
    expect(again.calls).toHaveLength(0);

    const reloaded = JSON.parse(JSON.stringify(first)) as Task[];
    expect(await new ReviewService([]).review(reloaded, [])).toEqual(reloaded);

    const edited = applyTaskOps(first, [{ op: 'update', taskId: 's1', changes: { title: 'Fill in s1 again' } }], RUNNERS);
    expect(edited.errors).toEqual([]);
    expect(notes(edited.tasks)).toEqual(Array(8).fill(1));
    expect(notes(await new ReviewService([]).review([...edited.tasks], []))).toEqual(Array(8).fill(1));
  });

  it('asks a long serial opening the chain question and the fault together, and keeps the reordered plan', async () => {
    const reply = '{"dependencyChanges":[{"id":"g3","dependencies":[]},{"id":"g1","dependencies":["g3"]},{"id":"g2","dependencies":["g3"]}],"addTasks":[]}';
    const svc = new ReviewService([[reply, done]]);
    const out = await svc.review(serial(), []);
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0].hint).toContain('Its longest chain of dependencies is 5 tasks');
    expect(svc.calls[0].hint).toContain('Before any slice starts, 3 tasks run one after another');
    expect(longestChain(out)).toHaveLength(3);
    expect(ids(fanOutShape(out).gates)).toEqual(['g3']);
  });
});
