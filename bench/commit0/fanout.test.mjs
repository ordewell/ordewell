// The script's reading of a plan's fan-out, on the shapes the recorded runs had.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fanOutProperties, fanOutShape } from './fanout.mjs';

const t = (id, deps, extra = {}) => ({ id, title: `T ${id}`, type: 'ai', dependencies: deps, prompt: `Fill in src/${id}.py.`, ...extra });
const slices = (n, deps) => Array.from({ length: n }, (_, i) => t(`s${i + 1}`, deps));
const sliceIds = (n) => Array.from({ length: n }, (_, i) => `s${i + 1}`);

test('library 1: one opening task, slices at once, one closing check', () => {
  const plan = { tasks: [t('r', []), ...slices(6, ['r']), t('close', sliceIds(6))] };
  const p = fanOutProperties(plan, { baseBroken: true });
  assert.deepEqual(p.numbers, { slices: 6, width: 6, levels: 3, gates: 1, closers: 1, shared: 0, sliceEdges: 0, faults: [] });
  assert.equal(p.P1_oneOpening && p.P3_slicesParallel && p.P4_closingCheck, true);
  // Written before the role notes, the briefs carry none of them.
  assert.equal(p.P5_ownScopeDone || p.P6_closingToldOfUnlanded || p.P7_openingHandsOffMap, false);
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
