import { describe, expect, it } from 'vitest';
import { closingNote, fanOutShape, FAN_OUT_MIN, openingNote, sliceNote, withShapeNotes } from '../PlanFanOut';
import { applyChainReview, chainReviewMessage, longestChain } from '../PlanChainReview';
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

  // Two change tasks after every slice, not ordered against each other: neither is in the spine, but they are not slices either.
  it('takes a closing check with an editing task beside it, both after every slice, as the closing check and the task beside it', () => {
    const plan = [t('r', []), ...slices(6, ['r']), t('close', sliceIds(6)), t('docs', sliceIds(6), { title: 'Write the docs' })];
    const s = fanOutShape(plan);
    expect(s).toMatchObject({ wide: true, width: 6, faults: [] });
    expect(ids(s.gates)).toEqual(['r']);
    expect(ids(s.slices)).toEqual(sliceIds(6));
    // By level then plan order, as among any closers: the later one is the closing check.
    expect(ids(s.closers)).toEqual(['docs', 'close']);
    const out = withShapeNotes(plan);
    const prompt = (id: string) => out.find((x) => x.id === id)!.prompt!;
    expect(prompt('docs')).toBe(`Fill in src/lib/docs.py.\n\n${closingNote(s)}`);
    expect(prompt('close')).toBe('Fill in src/lib/close.py.');
    for (const id of sliceIds(6)) expect(prompt(id)).toContain('"Write the docs" (docs) runs the whole test suite once every slice has ended.');
    expect(prompt('r')).toContain('Plan shape: 6 slices wait for this task');
  });

  // Fewer than a fan-out's width after the rest is a closing check beside other tasks; as many is the plan's last level of slices.
  it('keeps a fan-out of slices after shared modules as slices when nothing after them closes', () => {
    const plan = [t('r', []), ...['m1', 'm2', 'm3', 'm4'].map((m) => t(m, ['r'])), ...slices(5, ['m1', 'm2', 'm3', 'm4'])];
    const s = fanOutShape(plan);
    expect(ids(s.slices)).toEqual(['m1', 'm2', 'm3', 'm4', ...sliceIds(5)]);
    expect(s.faults).toEqual(['no-closing']);
    expect(withShapeNotes(plan)).toBe(plan);
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
    expect(note[note.length - 1]).toBe('Your scope is this brief\'s. You are done when the code in your scope is written and its tests pass, except tests that fail only because they call code another slice owns that has not landed yet, or that ask for behaviour the repository does not let you derive. Run those once, list each as a finding with the module it waits for or why it cannot be derived, and end with status done: they are "T close" (close)\'s. Take in another slice\'s work once it has landed. Do not write, stub or shim another slice\'s code to make those tests pass, and do not keep iterating on them. End with status failed only when the code in your scope is not in place.');
  });

  // The runner tells a slice its worktree holds only what had landed when it started, and to take in what lands after.
  it('excuses only a slice\'s work that has not landed yet, and says to take it in once it has, as the runner\'s note on work landing beside it does', () => {
    const note = sliceNote(fanOutShape(good()));
    expect(note).not.toContain('landed in your worktree');
    expect(note).toContain('that has not landed yet');
    expect(note).toContain('Take in another slice\'s work once it has landed.');
  });

  it('reads the paths a brief names from the brief alone, not from a note already appended to it', () => {
    expect(sliceNote(fanOutShape(withShapeNotes(good())))).toBe(sliceNote(fanOutShape(good())));
  });

  // A revision note names the tasks it changed by title, and a title may name a file.
  it('lists in the opening note\'s table only the paths a brief names, not those in the titles its revision note names', () => {
    const titled = serial().map((x) => ({ ...x, title: `Fill in src/lib/${x.id}.py` }));
    const reply = JSON.stringify({ dependencyChanges: [{ id: 'g3', dependencies: [] }, { id: 'g1', dependencies: ['g3'] }, { id: 'g2', dependencies: ['g3'] }, { id: 'close', dependencies: [...sliceIds(6), 'g1', 'g2'] }] });
    const r = applyChainReview(titled, reply, RUNNERS);
    if (!r.ok) throw new Error(r.error);
    expect(r.tasks.find((x) => x.id === 'g1')!.prompt).toContain('Plan revision:');
    const table = openingNote(fanOutShape(r.tasks)).split('\n').slice(1);
    expect(table.slice(0, 3)).toEqual([
      '- "Fill in src/lib/g3.py" (g3): src/lib/g3.py',
      '- "Fill in src/lib/g1.py" (g1): src/lib/g1.py',
      '- "Fill in src/lib/g2.py" (g2): src/lib/g2.py',
    ]);
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

  // Measured: a module task that waits for every slice took the closing note, and every slice named it as the one running the suite.
  it('gives the closing note to the task no other waits for, and takes a module task after every slice as a slice', () => {
    const plan = [t('r', []), ...slices(5, ['r']), t('m', sliceIds(5), { title: 'Implement the CLI module' }), t('verify', [...sliceIds(5), 'm'], { title: 'Final verification' })];
    const shape = fanOutShape(plan);
    expect(shape.closers[0].id).toBe('verify');
    expect(ids(shape.slices)).toEqual([...sliceIds(5), 'm']);
    const out = withShapeNotes(plan);
    const prompt = (id: string) => out.find((x) => x.id === id)!.prompt!;
    expect(prompt('verify')).toBe('Fill in src/lib/verify.py.\n\nPlan shape: this check runs after the 6 slices. Read each slice\'s handoff with read: a slice that ended done lists the tests it left to you, and a slice that did not land (it failed and was skipped) left its module unwritten here, so write that module from its brief, its handoff and the tests. Run the whole test suite, fix what fails, and report each test that still fails with its reason.');
    for (const id of [...sliceIds(5), 'm']) {
      expect(prompt(id)).toContain('Plan shape: this task is one of 6 slices that start once "T r" (r) has landed, and "Final verification" (verify) runs the whole test suite once every slice has ended.');
    }
    expect(prompt('m')).not.toContain('this check runs after');
  });

  // Measured: restore the import, then a core module every slice waits for. Only the first is the opening task.
  it('takes a second task every slice waits for, which waits for the opening task alone, as a shared module: no opening note, no fault', () => {
    const plan = [t('r', [], { title: 'Restore import' }), t('core', ['r'], { title: 'Implement the core module' }), ...slices(5, ['core']), t('close', sliceIds(5))];
    const shape = fanOutShape(plan);
    expect(ids(shape.gates)).toEqual(['r', 'core']);
    expect(shape.faults).toEqual([]);
    const out = withShapeNotes(plan);
    const prompt = (id: string) => out.find((x) => x.id === id)!.prompt!;
    expect(prompt('r')).toContain('Plan shape: 5 slices wait for this task to land before any of them starts, so finish it as soon as your brief allows');
    expect(prompt('core')).toBe('Fill in src/lib/core.py.');
    for (const id of sliceIds(5)) expect(prompt(id)).toContain('Read the module map at the end of "Restore import" (r)\'s report (read, with include_report) before you explore.');
  });

  it('still names opening tasks in series where a later one waits for more than the opening task', () => {
    const plan = [t('r', []), t('a', ['r']), t('b', ['a']), ...slices(5, ['b']), t('close', sliceIds(5))];
    expect(fanOutShape(plan).faults).toEqual(['serial-opening']);
    const out = withShapeNotes(plan);
    expect(out.filter((x) => x.prompt!.includes('finish it as soon as your brief allows')).map((x) => x.id)).toEqual(['r']);
  });

  it('keeps a module task after every slice as the closing check when nothing else waits for every slice', () => {
    const plan = [t('r', []), ...slices(5, ['r']), t('m', sliceIds(5), { title: 'Implement the CLI module' })];
    const shape = fanOutShape(plan);
    expect(ids(shape.closers)).toEqual(['m']);
    expect(ids(shape.slices)).toEqual(sliceIds(5));
  });

  // Measured: the table listed every slice with up to six paths, and a slice's brief reached about ten thousand characters.
  describe('a slice note in a plan of forty slices', () => {
    const files = (id: string) => Array.from({ length: 6 }, (_, i) => `src/library/${id}/part_${i}.py`);
    const wide = (opening: boolean) => {
      const big = (id: string, deps: string[]) => t(id, deps, { title: `Implement the ${id} module and the tests that cover it`, prompt: `Fill in ${files(id).join(', ')}.` });
      const ss = Array.from({ length: 40 }, (_, i) => big(`s${i + 1}`, opening ? ['r'] : []));
      return [...(opening ? [big('r', [])] : []), ...ss, t('close', ss.map((x) => x.id))];
    };
    const table = (note: string) => note.split('\n').slice(1, -1);

    it('lists each task on one line with its first path, within 2,000 characters, then says how many more and where they are', () => {
      const note = sliceNote(fanOutShape(wide(true)));
      const lines = table(note);
      const listed = lines.slice(0, -1);
      expect(listed[0]).toBe('- "Implement the r module and the tests that cover it" (r): src/library/r/part_0.py');
      expect(listed[1]).toBe('- "Implement the s1 module and the tests that cover it" (s1): src/library/s1/part_0.py');
      for (const line of listed) expect(line).toMatch(/^- "[^"]+" \(\w+\): src\/library\/\w+\/part_0\.py$/);
      expect(lines.join('\n').length).toBeLessThanOrEqual(2000);
      expect(lines[lines.length - 1]).toBe(`- … and ${41 - listed.length} more, each with the paths it owns in the module map at the end of "Implement the r module and the tests that cover it" (r)'s report.`);
      expect(note.length).toBeLessThan(3500);
    });

    it('with no opening task, says a module its brief does not name is another task\'s', () => {
      const lines = table(sliceNote(fanOutShape(wide(false))));
      expect(lines.join('\n').length).toBeLessThanOrEqual(2000);
      expect(lines[lines.length - 1]).toBe(`- … and ${41 - (lines.length - 1) - 1} more, not listed here: a module your brief does not name is another task's.`);
    });

    it('leaves the opening task the whole table, each task with every path its brief names, for the map the slices read', () => {
      const lines = openingNote(fanOutShape(wide(true))).split('\n').slice(1);
      expect(lines).toHaveLength(41);
      expect(lines[1]).toBe(`- "Implement the s1 module and the tests that cover it" (s1): ${files('s1').join(', ')}`);
    });
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

// ADR-0072 R5: the fan-out is noted, never asked about; the review call is R1's, as measured.
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

  it('makes no call on a fan-out with every fault and a short chain, and notes nothing without a closing check', async () => {
    const plan = flat();
    expect(fanOutShape(plan).faults).toEqual(['no-opening', 'no-closing']);
    expect(longestChain(plan)).toHaveLength(1);
    const svc = new ReviewService([]);
    const log: ResearchLogEntry[] = [];
    expect(await svc.review(plan, log)).toBe(plan);
    expect(svc.calls).toHaveLength(0);
    expect(log).toEqual([]);
  });

  it('makes no call on a short serial opening', async () => {
    const plan = [t('g1', []), t('g2', ['g1']), t('g3', ['g2']), ...slices(6, ['g3'])];
    expect(fanOutShape(plan).faults).toEqual(['serial-opening', 'no-closing']);
    expect(longestChain(plan)).toHaveLength(4);
    const svc = new ReviewService([]);
    expect(await svc.review(plan, [])).toBe(plan);
    expect(svc.calls).toHaveLength(0);
  });

  it('asks a long serial opening the chain question word for word, and takes no task from its reply', async () => {
    const plan = serial();
    const reply = JSON.stringify({
      dependencyChanges: [{ id: 'g3', dependencies: [] }, { id: 'g1', dependencies: ['g3'] }, { id: 'g2', dependencies: ['g3'] }, { id: 'close', dependencies: [...sliceIds(6), 'g1', 'g2'] }],
      addTasks: [{ id: 'extra', role: 'closing', title: 'Run the suite', prompt: 'Run it.' }],
    });
    const svc = new ReviewService([[reply, done]]);
    const log: ResearchLogEntry[] = [];
    const out = await svc.review(plan, log);
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0].call?.effort).toBe('low');
    expect(svc.calls[0].hint).toBe(chainReviewMessage(plan, longestChain(plan)));
    expect(svc.calls[0].hint).not.toContain('fans out');
    expect(out.map((x) => x.id)).toEqual(plan.map((x) => x.id));
    expect(longestChain(out)).toHaveLength(3);
    expect(log.map(text)).toEqual([
      'chain review: 5 -> 3, kept; 4 tasks changed: "T g1" adds "T g3"; "T g2" drops "T g1" adds "T g3"; "T g3" drops "T g2"; "T close" adds "T g1", "T g2"',
      'fan-out: 8 at once, 1 before, 1 after; role notes added',
    ]);
  });

  it('asks a long serial plan the chain question word for word, and notes nothing', async () => {
    const plan = [t('a', []), t('b', ['a']), t('c', ['b']), t('d', ['c']), t('e', ['d'])];
    const svc = new ReviewService([['{"dependencyChanges":[]}', done]]);
    const log: ResearchLogEntry[] = [];
    const out = await svc.review(plan, log);
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0].hint).toBe(chainReviewMessage(plan, longestChain(plan)));
    expect(out).toBe(plan);
    expect(log.map(text)).toEqual(['chain review: 5 -> 5, first plan kept, not shorter; 0 tasks changed']);
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
});
