import { describe, expect, it } from 'vitest';
import { closingNote, fanOutRoles, fanOutShape, FAN_OUT_MIN, gateNote, notedRole, openingNote, sliceNote, withShapeNotes } from '../PlanFanOut';
import { applyChainReview, chainReviewMessage, longestChain } from '../PlanChainReview';
import { BaseAiService, type PlanTextCall, type PlanTextReply } from '../BaseAiService';
import { createTask, type ResearchLogEntry, type RunnerId, type Task } from '../../models/Task';
import { fakeConfig, fakeFileSystem } from '../../testing';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import { applyTaskOps } from '../TaskOps';
import { DEFAULT_PLANNER_MODES, type PlannerModes } from '../plannerModes';
import { lines, workspace } from './planFanOutKit';

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
    // Every slice waits for both shared modules: they run before the fan-out, after the opening task.
    expect(ids(s.gates)).toEqual(['r', 'm1', 'm2']);
    expect(s.opening?.id).toBe('r');
    expect(ids(s.slices)).toEqual(sliceIds(5));
    expect(s.sliceEdges).toBe(0);
  });

  // Recorded: one opening task, four more beside each other, and 31 slices that waited for the first and the last of those five.
  // The reader logged "31 at once, 1 before" and took the last as a slice, so it got a slice's note and the slices were told they start after the first alone.
  it('takes a task every slice of the fan-out waits for as a task before the slices, though tasks beside it do not wait for it', () => {
    const plan = [t('o1', []), ...['o2', 'o3', 'o4', 'o5'].map((id) => t(id, ['o1'])), ...slices(31, ['o1', 'o5']), t('close', ['o2', 'o3', 'o4', ...sliceIds(31)])];
    const s = fanOutShape(plan);
    expect(ids(s.gates)).toEqual(['o1', 'o5']);
    expect(s.opening?.id).toBe('o1');
    expect(ids(s.slices)).toEqual(['o2', 'o3', 'o4', ...sliceIds(31)]);
    expect(s.width).toBe(31);
    expect(s.faults).toEqual([]);
    expect(ids(s.waits.get('s1')!)).toEqual(['o1', 'o5']);
    expect(ids(s.waits.get('o2')!)).toEqual(['o1']);
    const out = withShapeNotes(plan);
    const prompt = (id: string) => out.find((x) => x.id === id)!.prompt!;
    expect(prompt('o1')).toContain('Plan shape: 34 slices wait for this task to land before any of them starts');
    expect(prompt('o5')).toBe(`Fill in src/lib/o5.py.\n\n${gateNote(s, s.gates[1])}`);
    expect(prompt('o5')).toContain('Plan shape: 31 slices wait for this task to land before they start');
    expect(prompt('s1')).toContain('one of 34 slices that start once "T o1" (o1) and "T o5" (o5) have landed');
    expect(prompt('o2')).toContain('one of 34 slices that start once "T o1" (o1) has landed');
  });

  // Recorded: the plan had no task before the slices, and a core slice most of them waited for ran beside the rest.
  it('takes a core task beside some slices, which every slice of the fan-out waits for, as the opening task', () => {
    const plan = [t('core', []), t('x1', []), t('x2', []), ...slices(8, ['core']), t('close', ['x1', 'x2', ...sliceIds(8)])];
    const s = fanOutShape(plan);
    expect(s.opening?.id).toBe('core');
    expect(s.faults).toEqual([]);
    const out = withShapeNotes(plan);
    const prompt = (id: string) => out.find((x) => x.id === id)!.prompt!;
    expect(prompt('core')).toContain('Plan shape: 8 slices wait for this task to land before any of them starts');
    // A slice beside it starts before its map is written, so it is told neither.
    expect(prompt('x1')).toContain('Plan shape: this task is one of 10 slices, and "T close" (close)');
    expect(prompt('x1')).not.toContain('module map at the end');
    expect(prompt('s1')).toContain('Read the module map at the end of "T core" (core)\'s report');
  });

  it('names no opening task when the tasks before the slices run beside each other, and tells each to keep the import', () => {
    const plan = [t('m1', []), t('m2', []), ...slices(5, ['m1', 'm2']), t('close', sliceIds(5))];
    const s = fanOutShape(plan);
    expect(ids(s.gates)).toEqual(['m1', 'm2']);
    expect(s.opening).toBeUndefined();
    expect(s.faults).toEqual(['no-opening']);
    const out = withShapeNotes(plan);
    for (const id of ['m1', 'm2']) expect(out.find((x) => x.id === id)!.prompt).toBe(`Fill in src/lib/${id}.py.\n\n${gateNote(s, s.gates.find((g) => g.id === id)!)}`);
    expect(out.find((x) => x.id === 's1')!.prompt).not.toContain('module map at the end');
  });

  it('takes a level every slice after it waits for whole as the tasks before the slices, and names no opening task among them', () => {
    const plan = [...['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((id) => t(id, [])), ...slices(6, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']), t('close', sliceIds(6))];
    const s = fanOutShape(plan);
    expect(s.gates).toHaveLength(6);
    expect(ids(s.slices)).toEqual(sliceIds(6));
    expect(s.faults).toEqual(['no-opening']);
  });

  // Fewer tasks than a fan-out after the rest would leave no fan-out: the rest stay the slices.
  it('takes nothing before the slices when the level after them is narrower than a fan-out', () => {
    const plan = [t('r', []), ...slices(6, ['r']), t('cli', sliceIds(6)), t('api', sliceIds(6)), t('close', [...sliceIds(6), 'cli', 'api'])];
    const s = fanOutShape(plan);
    expect(ids(s.gates)).toEqual(['r']);
    expect(ids(s.slices)).toEqual([...sliceIds(6), 'cli', 'api']);
    expect(s.width).toBe(6);
  });

  it('takes no task before the slices from the fan-out\'s level when its slices do not all wait for one', () => {
    const plan = [t('r', []), ...['a1', 'a2', 'a3', 'a4'].map((id) => t(id, ['r'])), ...['a1', 'a2', 'a3', 'a4'].map((a, i) => t(`b${i + 1}`, [a])), t('close', ['b1', 'b2', 'b3', 'b4'])];
    const s = fanOutShape(plan);
    expect(ids(s.gates)).toEqual(['r']);
    expect(s.slices).toHaveLength(8);
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
    // Every slice waits for every shared module, so they run before the fan-out.
    expect(ids(s.gates)).toEqual(['r', 'm1', 'm2', 'm3', 'm4']);
    expect(ids(s.slices)).toEqual(sliceIds(5));
    expect(s.faults).toEqual(['no-closing']);
    // Each role's note stands without a closing check: the slices still start from the tree the tasks before them land.
    const out = withShapeNotes(plan);
    const prompt = (id: string) => out.find((x) => x.id === id)!.prompt!;
    expect(prompt('r')).toBe(`Fill in src/lib/r.py.\n\n${openingNote(s)}`);
    for (const m of ['m1', 'm2', 'm3', 'm4']) expect(prompt(m)).toBe(`Fill in src/lib/${m}.py.\n\n${gateNote(s, s.gates.find((g) => g.id === m)!)}`);
    for (const id of sliceIds(5)) expect(prompt(id)).toBe(`Fill in src/lib/${id}.py.\n\n${sliceNote(s, s.slices.find((x) => x.id === id))}`);
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
    expect(note[note.length - 1]).toBe('Your scope is this brief\'s. You are done when the code in your scope is written and its tests pass, except tests that fail only because they call code another slice owns that has not landed yet, or that ask for behaviour the repository does not let you derive. Run those once, list each as an `info` finding that cites, by task reference, the slice it waits for, or says why it cannot be derived, and end with status done: they are "T close" (close)\'s. Severity `blocker` is for a defect in code that has landed and stops you, given with the file and the input. Take in another slice\'s work once it has landed. Do not write, stub or shim another slice\'s code to make those tests pass, and do not keep iterating on them. End with status failed only when the code in your scope is not in place.');
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
      'Plan shape: 6 slices wait for this task to land before any of them starts, and they start from the tree you land. Besides your brief\'s own criterion, you are done only when the project builds or imports and the test command the slices\' briefs run (the project\'s own, if they name none) collects its tests without an error, though tests may still fail: run both, a collection-only run where the test runner has one, and put each command and the last lines of its output in your report. For that alone you may edit any file, whichever task below owns it: add only the smallest placeholder that lets it import (a missing name, a function that raises NotImplementedError or its like), and list each placeholder in your summary with the task that owns it. Leave everything else in a module a slice owns to that slice, and finish it as soon as your brief allows. End with status failed when the project still does not import or its tests do not collect for a cause in the repository\'s code, saying what stops them. A cause outside that code which no placeholder fixes, such as a dependency that is not installed, is not yours to fix: report it as a finding with the command and its output, and end with status done. End your report with a map the slices read before they explore: for each module the tests import, its path, its public names, and the task below that owns it. Say in your summary that the map is in your report. The tasks and the paths their briefs name:',
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
  it('takes a second task every slice waits for, which waits for the opening task alone, as a shared module: no opening note, no fault, and it keeps the import', () => {
    const plan = [t('r', [], { title: 'Restore import' }), t('core', ['r'], { title: 'Implement the core module' }), ...slices(5, ['core']), t('close', sliceIds(5))];
    const shape = fanOutShape(plan);
    expect(ids(shape.gates)).toEqual(['r', 'core']);
    expect(shape.faults).toEqual([]);
    const out = withShapeNotes(plan);
    const prompt = (id: string) => out.find((x) => x.id === id)!.prompt!;
    expect(prompt('r')).toContain('Plan shape: 5 slices wait for this task to land before any of them starts, and they start from the tree you land.');
    expect(prompt('core')).toBe(`Fill in src/lib/core.py.\n\n${gateNote(shape, shape.gates[1])}`);
    expect(gateNote(shape, shape.gates[1])).toBe('Plan shape: 5 slices wait for this task to land before they start, and they start from the tree you land, so finish as soon as your brief allows and leave every module a slice owns to that slice. Besides your brief\'s own criterion, you are done only when your change leaves the project building or importing and the test command the slices\' briefs run (the project\'s own, if they name none) collects its tests without an error, though tests may still fail, as it did when you started or better: run both, a collection-only run where the test runner has one, and put each command and the last lines of its output in your report.');
    for (const id of sliceIds(5)) expect(prompt(id)).toContain('that start once "Restore import" (r) and "Implement the core module" (core) have landed');
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

  it('reads back from each note the role it was written for, and none from a brief with no note', () => {
    const chain = [t('r', []), t('a', ['r']), ...slices(5, ['a']), t('close', sliceIds(5))];
    const expected = { r: 'opening', a: 'gate', ...Object.fromEntries(sliceIds(5).map((id) => [id, 'slice'])), close: 'closing' };
    expect(Object.fromEntries(withShapeNotes(chain).flatMap((x) => { const role = notedRole(x); return role ? [[x.id, role]] : []; }))).toEqual(expected);
    expect(chain.map(notedRole).filter(Boolean)).toEqual([]);
    expect(notedRole({ prompt: 'Keep the Plan shape: notes the planner wrote.' })).toBeUndefined();
  });

  it('notes a script check\'s fix as the closing check, and a fan-out with nothing before or after it only on its slices', () => {
    const plan = [t('r', []), ...slices(4, ['r']),
      createTask({ id: 'check', title: 'Run the suite', type: 'script', commands: [['pytest']], dependencies: sliceIds(4), sliceType: 'AFK', loop: { body: ['fix'], maxRounds: 3 } }),
      t('fix', ['check'])];
    expect(withShapeNotes(plan).find((x) => x.id === 'fix')!.prompt).toContain(closingNote(fanOutShape(plan)));
    const out = withShapeNotes(flat());
    for (const x of out) expect(x.prompt!.split('\n')[2]).toBe('Plan shape: this task is one of 6 slices. The tasks and the paths their briefs name:');
  });
});

// Recorded: a wide plan whose last task waited for only some slices had no closing check, so no role got a note, and the
// opening task, its brief naming two files, was told by the supervisor to revert the edits that made the package import.
describe('withShapeNotes on a wide plan with no closing check', () => {
  const SLICE_HEAD = 'Plan shape: this task is one of 6 slices that start once "T r" (r) has landed. Read the module map at the end of "T r" (r)\'s report (read, with include_report) before you explore. The tasks and the paths their briefs name:';
  const SLICE_SCOPE = 'Your scope is this brief\'s. You are done when the code in your scope is written and its tests pass, except tests that fail only because they call code another slice owns that has not landed yet, or that ask for behaviour the repository does not let you derive. Run those once, list each as an `info` finding that cites, by task reference, the slice it waits for, or says why it cannot be derived, and end with status done. Severity `blocker` is for a defect in code that has landed and stops you, given with the file and the input. Take in another slice\'s work once it has landed. Do not write, stub or shim another slice\'s code to make those tests pass, and do not keep iterating on them. End with status failed only when the code in your scope is not in place.';

  it('notes the opening task and every slice, the slices told of no closing check, and writes no closing note', () => {
    const plan = [t('r', []), ...slices(6, ['r'])];
    const shape = fanOutShape(plan);
    expect(shape.closers).toEqual([]);
    const out = withShapeNotes(plan);
    const prompt = (id: string) => out.find((x) => x.id === id)!.prompt!;
    expect(prompt('r')).toBe(`Fill in src/lib/r.py.\n\n${openingNote(shape)}`);
    for (const id of sliceIds(6)) {
      const note = prompt(id).split('\n\n')[1].split('\n');
      expect(note[0]).toBe(SLICE_HEAD);
      expect(note[note.length - 1]).toBe(SLICE_SCOPE);
    }
    expect(out.some((x) => x.prompt!.includes('this check runs after'))).toBe(false);
    expect(withShapeNotes(out)).toBe(out);
  });

  const roles = (plan: Task[]) => Object.fromEntries(fanOutRoles(fanOutShape(plan)));

  it('reads the tasks before the slices in a chain as the opening task and two gates', () => {
    const plan = [t('r', []), t('a', ['r']), t('b', ['a']), ...slices(5, ['b'])];
    expect(roles(plan)).toEqual({ r: 'opening', a: 'gate', b: 'gate', ...Object.fromEntries(sliceIds(5).map((id) => [id, 'slice'])) });
  });

  it('still reads the opening task when a catch-all task hangs off it beside the slices', () => {
    const plan = [t('r', []), ...slices(5, ['r']), t('sweep', ['r'], { title: 'Sweep the rest' })];
    expect(roles(plan)).toEqual({ r: 'opening', sweep: 'slice', ...Object.fromEntries(sliceIds(5).map((id) => [id, 'slice'])) });
  });

  // The recorded shape: a chain before the slices, a catch-all off the opening task, and a last task waiting for only some slices.
  it('still reads a chain before the slices when a catch-all hangs off the opening task and the last task waits for only some slices', () => {
    const plan = [t('r', []), t('a', ['r']), t('b', ['a']), ...slices(5, ['b']), t('sweep', ['r']), t('close', ['s1', 's2', 'sweep'])];
    const s = fanOutShape(plan);
    expect(ids(s.gates)).toEqual(['r', 'a', 'b']);
    expect(s.faults).toEqual(['serial-opening', 'no-closing']);
    // A last task that waits for only some slices is no closing check, and no slice either: it gets no role.
    expect(roles(plan)).toEqual({ r: 'opening', a: 'gate', b: 'gate', sweep: 'slice', ...Object.fromEntries(sliceIds(5).map((id) => [id, 'slice'])) });
    expect(withShapeNotes(plan).find((x) => x.id === 'r')!.prompt).toContain('For that alone you may edit any file');
  });

  // The recorded plan's last task (#469 F1): told it was a slice that must not write other slices' code, though it runs the suite.
  it('gives no role, and no note, to a last check that waits for only some slices', () => {
    const final = t('final', sliceIds(5), { title: 'Final closing check', prompt: 'Run the whole test suite and fix what fails.' });
    const plan = [t('r', []), ...slices(8, ['r']), final];
    expect(roles(plan)).toEqual({ r: 'opening', ...Object.fromEntries(sliceIds(8).map((id) => [id, 'slice'])) });
    expect(withShapeNotes(plan).find((x) => x.id === 'final')!.prompt).toBe('Run the whole test suite and fix what fails.');
  });

  // A task after one slice carries that slice's module further; one after several gathers their work, as a check does.
  it('keeps the slice role of a last task that waits for one slice alone', () => {
    const plan = [t('r', []), ...slices(5, ['r']), t('more', ['s1'])];
    expect(roles(plan)).toEqual({ r: 'opening', more: 'slice', ...Object.fromEntries(sliceIds(5).map((id) => [id, 'slice'])) });
  });

  // As many tasks after the slices as a fan-out are the plan's last level of slices, as fanOutShape reads them.
  it('keeps the role of a second level of slices as wide as a fan-out that nothing after them closes', () => {
    const plan = [t('r', []), ...['a1', 'a2', 'a3', 'a4'].map((id) => t(id, ['r'])), ...['a1', 'a2', 'a3', 'a4'].map((a, i) => t(`b${i + 1}`, [a]))];
    expect(Object.values(roles(plan)).filter((role) => role === 'slice')).toHaveLength(8);
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
  review(tasks: Task[], log: ResearchLogEntry[], fs?: IFileSystem, modes?: PlannerModes): Promise<Task[]> {
    return this.reviewLongChain(tasks, 'goal', '', '', {}, RUNNERS, () => {}, undefined, undefined, modes, log, fs);
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

  it('logs the tasks the recorded 31-slice plan waited for before its slices as two before', async () => {
    const plan = [t('o1', []), ...['o2', 'o3', 'o4', 'o5'].map((id) => t(id, ['o1'])), ...slices(31, ['o1', 'o5']), t('close', ['o2', 'o3', 'o4', ...sliceIds(31)])];
    const log: ResearchLogEntry[] = [];
    await new ReviewService([]).review(plan, log);
    expect(log.map(text)).toEqual(['fan-out: 31 at once, 2 before, 1 after; role notes added']);
  });

  // ADR-0072 R6: ready tasks start in plan order, so the slices that take longest start first.
  it('starts the largest slices first, then notes their roles in that order, and logs the order once', async () => {
    const testLines: Record<string, number> = { 'tests/test_s2.py': 80, 'tests/test_s5.py': 400, 'tests/test_s6.py': 80 };
    // Numbered lines, as the planner's read answers.
    const fs = fakeFileSystem({
      readFile: async (p) => (p in testLines
        ? { success: true, output: Array.from({ length: testLines[p] }, (_, i) => `${i + 1}|x`).join('\n'), truncated: false }
        : { success: false, output: 'not found', truncated: false }),
    });
    const plan = good().map((x, i) => ({ ...x, order: i + 1, prompt: `${x.prompt} Verify: pytest tests/test_${x.id}.py` }));
    const log: ResearchLogEntry[] = [];
    const out = await new ReviewService([]).review(plan, log, fs);
    expect(ids(out)).toEqual(['r', 's5', 's2', 's6', 's1', 's3', 's4', 'close']);
    expect(out.map((x) => x.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const table = out.find((x) => x.id === 's1')!.prompt!.split('\n').filter((l) => l.startsWith('- "T s'));
    expect(table.map((l) => /\((\w+)\)/.exec(l)![1])).toEqual(['s5', 's2', 's6', 's1', 's3', 's4']);
    expect(log.map(text)).toEqual([
      'slice order: largest first by the lines of the test files their briefs name; 5 of 6 moved',
      'fan-out: 6 at once, 1 before, 1 after; role notes added',
    ]);
  });

  // ADR-0072 R7: replayed on recorded runs, merging small slices past the parallel limit made the closing check start later.
  describe('with a parallel limit', () => {
    const SIZES = [100, 90, 10, 10, 20, 20, 30, 30, 40, 50];
    const plan = () => [t('r', []), ...SIZES.map((_, i) => t(`s${i + 1}`, ['r'], { prompt: `Fill in src/m${i + 1}.py. Verify: pytest tests/test_m${i + 1}.py` })), t('close', sliceIds(10))]
      .map((x, i) => ({ ...x, order: i + 1 }));
    const files = () => workspace(Object.fromEntries(SIZES.map((n, i) => [`tests/test_m${i + 1}.py`, lines(n)]))).fs;
    const limit = (parallelLimit: number): PlannerModes => ({ ...DEFAULT_PLANNER_MODES, parallelLimit });

    it('merges no slice, however far past the limit the slices are: it orders them largest first and notes every one', async () => {
      const log: ResearchLogEntry[] = [];
      const out = await new ReviewService([]).review(plan(), log, files(), limit(2));
      expect(ids(out)).toEqual(['r', 's1', 's2', 's10', 's9', 's7', 's8', 's5', 's6', 's3', 's4', 'close']);
      expect(out.some((x) => x.mergedSlices)).toBe(false);
      expect(out.find((x) => x.id === 's9')!.prompt).toContain('Plan shape: this task is one of 10 slices');
      expect(log.map(text)).toEqual([
        'slice order: largest first by the lines of the test files their briefs name; 8 of 10 moved',
        'fan-out: 10 at once, 1 before, 1 after; role notes added',
      ]);
    });

    it('starts a task every slice waits for ahead of the slices beside it, and notes every slice', async () => {
      const shared = t('g', ['r'], { prompt: 'Write src/shared.py, which every module imports.' });
      const beside = ['a1', 'a2'].map((id, i) => t(id, ['r'], { prompt: `Fill in src/${id}.py. Verify: pytest tests/test_${id}.py`, order: i }));
      const fanned = plan().slice(1, -1).map((x) => ({ ...x, dependencies: ['r', 'g'] }));
      const wide = [t('r', []), ...beside, shared, ...fanned, t('close', ['a1', 'a2', ...sliceIds(10)])].map((x, i) => ({ ...x, order: i + 1 }));
      const fs = workspace({ 'tests/test_a1.py': lines(8), 'tests/test_a2.py': lines(5), ...Object.fromEntries(SIZES.map((n, i) => [`tests/test_m${i + 1}.py`, lines(n)])) }).fs;
      const log: ResearchLogEntry[] = [];
      const out = await new ReviewService([]).review(wide, log, fs, limit(2));
      expect(ids(out)).toEqual(['r', 'g', 'a1', 'a2', 's1', 's2', 's10', 's9', 's7', 's8', 's5', 's6', 's3', 's4', 'close']);
      expect(out.map((x) => x.order)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
      const prompt = (id: string) => out.find((x) => x.id === id)!.prompt!;
      expect(prompt('g')).toContain('Plan shape: 10 slices wait for this task to land before they start');
      expect(prompt('r')).toContain('Plan shape: 12 slices wait for this task to land before any of them starts');
      expect(prompt('s9')).toContain('Plan shape: this task is one of 12 slices that start once "T r" (r) and "T g" (g) have landed');
      expect(log.map(text)).toEqual([
        'slice order: largest first by the lines of the test files their briefs name; 10 of 12 moved',
        'slice order: 1 task the slices wait for moved ahead of the slices beside it',
        // The widest level's ten, a1 and a2 a level above them.
        'fan-out: 10 at once, 2 before, 1 after; role notes added',
      ]);
    });

    it('shapes a plan at any limit as with none', async () => {
      const kept: ResearchLogEntry[] = [];
      const none = await new ReviewService([]).review(plan(), kept, files());
      for (const n of [1, 2, 10]) {
        const log: ResearchLogEntry[] = [];
        expect(await new ReviewService([]).review(plan(), log, files(), limit(n))).toEqual(none);
        expect(log.map(text)).toEqual(kept.map(text));
      }
    });
  });

  it('makes no call on a fan-out with every fault and a short chain, and notes its slices though it has no closing check', async () => {
    const plan = flat();
    expect(fanOutShape(plan).faults).toEqual(['no-opening', 'no-closing']);
    expect(longestChain(plan)).toHaveLength(1);
    const svc = new ReviewService([]);
    const log: ResearchLogEntry[] = [];
    const out = await svc.review(plan, log);
    expect(svc.calls).toHaveLength(0);
    expect(out.every((x) => x.prompt!.includes('Plan shape: this task is one of 6 slices.'))).toBe(true);
    expect(log.map(text)).toEqual(['fan-out: 6 at once, 0 before, 0 after, faults no-opening, no-closing; role notes added']);
  });

  it('makes no call on a short serial opening, and notes each task before the slices though no closing check follows', async () => {
    const plan = [t('g1', []), t('g2', ['g1']), t('g3', ['g2']), ...slices(6, ['g3'])];
    expect(fanOutShape(plan).faults).toEqual(['serial-opening', 'no-closing']);
    expect(longestChain(plan)).toHaveLength(4);
    const svc = new ReviewService([]);
    const log: ResearchLogEntry[] = [];
    const out = await svc.review(plan, log);
    expect(svc.calls).toHaveLength(0);
    const prompt = (id: string) => out.find((x) => x.id === id)!.prompt!;
    expect(prompt('g1')).toContain('Plan shape: 6 slices wait for this task to land before any of them starts');
    for (const id of ['g2', 'g3']) expect(prompt(id)).toContain('Plan shape: 6 slices wait for this task to land before they start');
    expect(prompt('s1')).toContain('Plan shape: this task is one of 6 slices that start once "T g1" (g1), "T g2" (g2) and "T g3" (g3) have landed. Read the module map');
    expect(log.map(text)).toEqual(['fan-out: 6 at once, 3 before, 0 after, faults serial-opening, no-closing; role notes added']);
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
    // ADR-0072 R1: the reply may put g3 first, but every slice still runs after g1 and g2, which all of them ran after.
    expect(longestChain(out)).toHaveLength(4);
    expect(log.map(text)).toEqual([
      `chain review: 5 -> 4, kept; 4 tasks changed: "T g1" adds "T g3"; "T g2" drops "T g1" adds "T g3"; "T g3" drops "T g2"; "T close" adds "T g1", "T g2", 0 added waits dropped, 12 opening waits kept`,
      'fan-out: 6 at once, 3 before, 1 after; role notes added',
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
