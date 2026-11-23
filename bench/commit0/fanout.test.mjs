// The script's reading of a plan's fan-out, on the shapes the recorded runs had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fanOutProperties, fanOutShape, median, reviewedWaits } from './fanout.mjs';

const t = (id, deps, extra = {}) => ({ id, title: `T ${id}`, type: 'ai', dependencies: deps, prompt: `Fill in src/${id}.py.`, ...extra });
const slices = (n, deps) => Array.from({ length: n }, (_, i) => t(`s${i + 1}`, deps));
const sliceIds = (n) => Array.from({ length: n }, (_, i) => `s${i + 1}`);

test('library 1: one opening task, slices at once, one closing check', () => {
  const plan = { tasks: [t('r', []), ...slices(6, ['r']), t('close', sliceIds(6))] };
  const p = fanOutProperties(plan, { baseBroken: true });
  assert.deepEqual(p.numbers, { slices: 6, width: 6, levels: 3, gates: 1, opening: 'r', closers: 1, shared: 0, sliceEdges: 0, faults: [] });
  assert.equal(p.P1_oneOpening && p.P3_slicesParallel && p.P4_closingCheck, true);
  // Written before the role notes, the briefs carry none of them.
  assert.equal(p.P5_ownScopeDone || p.P6_closingToldOfUnlanded || p.P7_openingHandsOffMap || p.P8_beforeSlicesImport, false);
});

test('library 2: three opening tasks in series fail P1 and P2', () => {
  const plan = { tasks: [t('g1', []), t('g2', ['g1']), t('g3', ['g2']), ...slices(6, ['g3']), t('close', sliceIds(6))] };
  const p = fanOutProperties(plan, { baseBroken: true });
  assert.deepEqual(p.numbers.faults, ['serial-opening']);
  assert.equal(p.P1_oneOpening || p.P2_openingFirstAndAlone, false);
});

test('library 3: no opening task and no closing check', () => {
  const p = fanOutProperties({ tasks: slices(6, []) }, { baseBroken: true });
  assert.deepEqual(p.numbers.faults, ['no-opening', 'no-closing']);
  assert.equal(p.P1_oneOpening || p.P4_closingCheck, false);
});

test('the four-level shape passes P3; a chained one does not', () => {
  const four = { tasks: [t('r', []), t('m1', ['r']), t('m2', ['r']), ...slices(5, ['m1', 'm2']), t('close', sliceIds(5))] };
  assert.equal(fanOutProperties(four).P3_slicesParallel, true);
  const chained = { tasks: [t('r', []), t('a', ['r']), t('b', ['a']), t('c', ['b']), t('d', ['c']), ...slices(4, ['r']), t('close', ['a', 'b', 'c', 'd', ...sliceIds(4)])] };
  assert.equal(fanOutProperties(chained).P3_slicesParallel, false);
});

test('a serial plan is no fan-out', () => {
  assert.equal(fanOutShape({ tasks: [t('a', []), t('b', ['a']), t('c', ['b'])] }).wide, false);
});

test('a read-only check is the closing check only through its loop\'s fix, whose brief is the one told', () => {
  const note = 'Plan shape: this check runs after the 4 slices. … a slice that did not land …';
  const looped = { tasks: [t('r', []), ...slices(4, ['r']), t('check', sliceIds(4), { readOnly: true, prompt: 'Review it.', loop: { body: ['fix'], maxRounds: 2 } }), t('fix', ['check'], { prompt: `Fix it.\n\n${note}` })] };
  const p = fanOutProperties(looped);
  assert.deepEqual(p.numbers.faults, []);
  assert.equal(p.P6_closingToldOfUnlanded, true);
  const alone = { tasks: [t('r', []), ...slices(4, ['r']), t('review', sliceIds(4), { readOnly: true, prompt: `Review it.\n\n${note}` })] };
  assert.deepEqual(fanOutProperties(alone).numbers.faults, ['no-closing']);
});

test('a shared module that waits for the opening task alone is not a second opening task', () => {
  const plan = { tasks: [t('r', []), t('core', ['r']), ...slices(5, ['core']), t('close', sliceIds(5))] };
  const p = fanOutProperties(plan, { baseBroken: true });
  assert.deepEqual(p.numbers.faults, []);
  assert.equal(p.P1_oneOpening && p.P2_openingFirstAndAlone && p.P3_slicesParallel, true);
  const chained = { tasks: [t('r', []), t('a', ['r']), t('b', ['a']), ...slices(5, ['b']), t('close', sliceIds(5))] };
  assert.equal(fanOutProperties(chained, { baseBroken: true }).P2_openingFirstAndAlone, false);
});

test('an opening task that waits for an install or a manual step alone is the one opening task', () => {
  const plan = { tasks: [t('install', [], { type: 'script', commands: [['npm', 'ci']] }), t('setup', [], { type: 'user' }), t('r', ['install', 'setup']), ...slices(4, ['r']), t('close', sliceIds(4))] };
  assert.equal(fanOutProperties(plan, { baseBroken: true }).P1_oneOpening, true);
});

test('the closing check is the task no other waits for; a module task it waits for is a slice', () => {
  const note = 'Plan shape: this check runs after the 5 slices. … a slice that did not land …';
  const plan = { tasks: [t('r', []), ...slices(4, ['r']), t('m', sliceIds(4)), t('verify', [...sliceIds(4), 'm'], { prompt: `Verify it.\n\n${note}` })] };
  const s = fanOutShape(plan);
  assert.equal(s.closers[0].id, 'verify');
  assert.deepEqual(s.slices.map((x) => x.id), [...sliceIds(4), 'm']);
  const p = fanOutProperties(plan);
  assert.equal(p.P6_closingToldOfUnlanded, true);
  assert.equal(p.P3_slicesParallel, true);
});

test('as core: a closing check with an editing task beside it is the closing check, not two more slices', () => {
  const plan = { tasks: [t('r', []), ...slices(6, ['r']), t('close', sliceIds(6)), t('docs', sliceIds(6))] };
  const s = fanOutShape(plan);
  assert.deepEqual(s.slices.map((x) => x.id), sliceIds(6));
  assert.deepEqual(s.closers.map((x) => x.id), ['docs', 'close']);
  assert.deepEqual(s.faults, []);
  assert.equal(fanOutProperties(plan).P4_closingCheck, true);
  const later = { tasks: [t('r', []), ...['m1', 'm2', 'm3', 'm4'].map((m) => t(m, ['r'])), ...slices(5, ['m1', 'm2', 'm3', 'm4'])] };
  // As core: every slice waits for every shared module, so they run before the fan-out.
  assert.deepEqual(fanOutShape(later).gates.map((x) => x.id), ['r', 'm1', 'm2', 'm3', 'm4']);
  assert.deepEqual(fanOutShape(later).slices.map((x) => x.id), sliceIds(5));
  assert.deepEqual(fanOutShape(later).faults, ['no-closing']);
});

test('as core: a loop check whose body names no task is no closing check, and reading it does not throw', () => {
  const plan = { tasks: [t('r', []), ...slices(4, ['r']), t('check', sliceIds(4), { type: 'script', commands: [['pytest']], loop: { body: ['gone'] } })] };
  assert.deepEqual(fanOutShape(plan).faults, ['no-closing']);
});

// Recorded: five tasks before 31 slices, which waited for the first and the last; the reader took the last as a slice.
test('as core: a task every slice of the fan-out waits for is a task before the slices, though tasks beside it do not wait for it', () => {
  const plan = { tasks: [t('o1', []), ...['o2', 'o3', 'o4', 'o5'].map((id) => t(id, ['o1'])), ...slices(31, ['o1', 'o5']), t('close', ['o2', 'o3', 'o4', ...sliceIds(31)])] };
  const p = fanOutProperties(plan, { baseBroken: true });
  assert.deepEqual([p.numbers.gates, p.numbers.opening, p.numbers.width, p.numbers.slices, p.numbers.faults], [2, 'o1', 31, 34, []]);
  assert.equal(p.P1_oneOpening, true);
  // The same plan with a second task before the slices that waits for the others beside it: tasks in series.
  const serial = { tasks: plan.tasks.map((x) => (x.id === 'o5' ? { ...x, dependencies: ['o1', 'o2', 'o3', 'o4'] } : x)) };
  assert.deepEqual(fanOutProperties(serial, { baseBroken: true }).numbers.faults, ['serial-opening']);
});

test('as core: a core task beside a few slices that every slice of the fan-out waits for is the opening task', () => {
  const plan = { tasks: [t('core', []), t('x1', []), t('x2', []), ...slices(8, ['core']), t('close', ['x1', 'x2', ...sliceIds(8)])] };
  const p = fanOutProperties(plan, { baseBroken: true });
  assert.equal(p.numbers.opening, 'core');
  assert.deepEqual(p.numbers.faults, []);
});

// Recorded: a chain before the slices, a catch-all off the opening task, and a last task that waited for only some slices.
test('as core: a chain before the slices is read whole beside a catch-all off the opening task and a last task waiting for some slices', () => {
  const plan = { tasks: [t('r', []), t('a', ['r']), t('b', ['a']), ...slices(5, ['b']), t('sweep', ['r']), t('close', ['s1', 's2', 'sweep'])] };
  const s = fanOutShape(plan);
  assert.deepEqual(s.gates.map((x) => x.id), ['r', 'a', 'b']);
  assert.equal(s.opening.id, 'r');
  assert.deepEqual(s.faults, ['serial-opening', 'no-closing']);
});

test('P8: every task before the slices carries the import criterion, and the opening task may edit any file for it', () => {
  const opening = 'Plan shape: 5 slices wait for this task to land before any of them starts, … collects its tests without an error … For that alone you may edit any file …';
  const shared = 'Plan shape: 5 slices wait for this task to land before they start, … collects its tests without an error …';
  const plan = (coreNote) => ({ tasks: [t('r', [], { prompt: `Restore.\n\n${opening}` }), t('core', ['r'], { prompt: `Core.${coreNote}` }), ...slices(5, ['core']), t('close', sliceIds(5))] });
  assert.equal(fanOutProperties(plan(`\n\n${shared}`)).P8_beforeSlicesImport, true);
  assert.equal(fanOutProperties(plan('')).P8_beforeSlicesImport, false);
});

// The same plan as first written and after review: what each slice waits for among the tasks before the slices.
test('reviewedWaits: a task a review added before the slices is a new ancestor of every slice, and the counts are per plan', () => {
  const written = { tasks: [t('r', []), ...slices(6, ['r']), t('close', sliceIds(6))] };
  const reviewed = { tasks: [t('r', []), t('fix', ['r']), ...slices(6, ['r', 'fix']), t('close', sliceIds(6))] };
  const m = reviewedWaits(written, reviewed);
  assert.deepEqual(m.slices.map((s) => [s.id, s.written, s.reviewed]), sliceIds(6).map((id) => [id, ['r'], ['fix', 'r']]));
  assert.deepEqual(m.written, { median: 1, max: 1 });
  assert.deepEqual(m.reviewed, { median: 2, max: 2 });
  assert.deepEqual(m.newAncestry, sliceIds(6).map((task) => ({ task, waitsFor: 'fix' })));
  assert.deepEqual(m.openingCut, []);
});

test('reviewedWaits: a wait whose task was already an ancestor adds nothing; the median is of the slices, the maximum the deepest', () => {
  const written = { tasks: [t('r', []), t('a', ['r']), t('b', ['a']), ...slices(5, ['b']), t('close', sliceIds(5))] };
  // The review makes s1 wait for r directly (it already did, through b) and s2 for the slice s3 (new).
  const reviewed = { tasks: written.tasks.map((x) => (x.id === 's1' ? { ...x, dependencies: ['b', 'r'] } : x.id === 's2' ? { ...x, dependencies: ['b', 's3'] } : x)) };
  const m = reviewedWaits(written, reviewed);
  assert.deepEqual(m.newAncestry, [{ task: 's2', waitsFor: 's3' }]);
  assert.deepEqual(m.written, { median: 3, max: 3 });
  assert.deepEqual(m.reviewed, { median: 3, max: 3 });
});

test('reviewedWaits: a slice that no longer waits for what every slice waited for as written is an opening cut', () => {
  const written = { tasks: [t('r', []), ...slices(5, ['r']), t('close', sliceIds(5))] };
  const reviewed = { tasks: written.tasks.map((x) => (x.id === 's5' ? { ...x, dependencies: [] } : x)) };
  const m = reviewedWaits(written, reviewed);
  assert.deepEqual(m.openingCut, [{ slice: 's5', lost: ['r'] }]);
  assert.deepEqual(m.newAncestry, []);
  // A plan reviewed with its slices still all behind the opening task cuts nothing.
  assert.deepEqual(reviewedWaits(written, written).openingCut, []);
});

test('reviewedWaits: a slice outside the fan-out that waited for fewer tasks before the slices, and a review that makes it wait for the rest', () => {
  const written = { tasks: [t('r', []), t('g', ['r']), ...slices(4, ['g']), t('p', ['r']), t('close', [...sliceIds(4), 'p'])] };
  const reviewed = { tasks: written.tasks.map((x) => (x.id === 'p' ? { ...x, dependencies: ['g'] } : x)) };
  const m = reviewedWaits(written, reviewed);
  assert.deepEqual(m.slices.map((s) => [s.id, s.written.length, s.reviewed.length]), [...sliceIds(4).map((id) => [id, 2, 2]), ['p', 1, 2]]);
  assert.deepEqual(m.written, { median: 2, max: 2 });
  assert.deepEqual(m.reviewed, { median: 2, max: 2 });
  assert.deepEqual(m.newAncestry, [{ task: 'p', waitsFor: 'g' }]);
});

test('median: the middle value, the mean of the middle two for an even count, null for none', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('fanout.mjs --review prints one JSON line a pair of plans', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-review-'));
  try {
    const written = { tasks: [t('r', []), ...slices(5, ['r']), t('close', sliceIds(5))] };
    const reviewed = { tasks: written.tasks.map((x) => (x.id === 's5' ? { ...x, dependencies: [] } : x)) };
    fs.writeFileSync(path.join(dir, 'w.json'), JSON.stringify(written));
    fs.writeFileSync(path.join(dir, 'r.json'), JSON.stringify(reviewed));
    const out = execFileSync(process.execPath, [path.join(import.meta.dirname, 'fanout.mjs'), '--review', path.join(dir, 'w.json'), path.join(dir, 'r.json')], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    const line = JSON.parse(out);
    assert.deepEqual(line.openingCut, [{ slice: 's5', lost: ['r'] }]);
    assert.deepEqual(line.files, [path.join(dir, 'w.json'), path.join(dir, 'r.json')]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reviewedWaits: a plan with no fan-out reports no slices', () => {
  const serial = { tasks: [t('a', []), t('b', ['a'])] };
  assert.deepEqual(reviewedWaits(serial, serial), { slices: [], written: { median: null, max: null }, reviewed: { median: null, max: null }, newAncestry: [], openingCut: [] });
});
