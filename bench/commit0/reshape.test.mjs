// The offline check on the shapes the recorded runs had, through this build's core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCore, reshape, reshapeChecks } from './reshape.mjs';

const core = await loadCore();
const t = (id, deps) => ({ id, order: 0, title: `Implement ${id}`, description: '', type: 'ai', status: 'pending', dependencies: deps, prompt: `Fill in src/lib/${id}.py.`, subtasks: [], assignedRunner: 'claude-code' });
const slices = (n, deps) => Array.from({ length: n }, (_, i) => t(`s${i + 1}`, deps));
const sliceIds = (n) => Array.from({ length: n }, (_, i) => `s${i + 1}`);
const numbered = (tasks) => tasks.map((x, i) => ({ ...x, order: i + 1 }));

test('the 31-slice plan: two tasks before the slices, the second moved ahead of the tasks beside it, every check holds', async () => {
  const recorded = { tasks: numbered([t('o1', []), ...['o2', 'o3', 'o4', 'o5'].map((id) => t(id, ['o1'])), ...slices(31, ['o1', 'o5']), t('close', ['o2', 'o3', 'o4', ...sliceIds(31)])]) };
  const r = await reshape(core, recorded, { baseBroken: true });
  assert.deepEqual(r.now.before, ['o1', 'o5']);
  assert.equal(r.gatesFirst, 1);
  assert.deepEqual(r.renoted.tasks.slice(0, 3).map((x) => x.id), ['o1', 'o5', 'o2']);
  assert.deepEqual(r.failed, []);
  assert.equal(r.properties.P8_beforeSlicesImport, true);
});

test('a recorded brief is cut at its note and noted once again', async () => {
  const plan = numbered([t('r', []), ...slices(5, ['r']), t('close', sliceIds(5))]);
  const once = await reshape(core, { tasks: plan });
  const twice = await reshape(core, once.renoted);
  assert.deepEqual(twice.renoted.tasks.map((x) => x.prompt), once.renoted.tasks.map((x) => x.prompt));
  assert.equal(twice.checks.slicesUnchanged, true);
  for (const x of twice.renoted.tasks) assert.ok(x.prompt.split('Plan shape:').length <= 2);
});

test('a plan with nothing before its slices is reported, not failed: nothing restores its import', async () => {
  const r = await reshape(core, { tasks: numbered([...slices(6, []), t('close', sliceIds(6))]) });
  assert.deepEqual(r.now.faults, ['no-opening']);
  assert.equal(r.checks.importCriterion, null);
  assert.deepEqual(r.failed, []);
});

test('with a parallel limit and the run\'s repository, no slice merges: the slices start largest first and the graph is the recorded one', async () => {
  const SIZES = [100, 90, 10, 10, 20, 20, 30, 30, 40, 50];
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'reshape-repo-'));
  fs.mkdirSync(path.join(repo, 'tests'));
  SIZES.forEach((n, i) => fs.writeFileSync(path.join(repo, 'tests', `test_m${i + 1}.py`), 'x = 1\n'.repeat(n)));
  const brief = (i) => ({ prompt: `Fill in src/m${i}.py. Verify: pytest tests/test_m${i}.py` });
  const recorded = { tasks: numbered([t('r', []), ...slices(10, ['r']).map((s, i) => ({ ...s, ...brief(i + 1) })), t('close', sliceIds(10))]) };
  const r = await reshape(core, recorded, { workdir: repo, limit: 2 }).finally(() => fs.rmSync(repo, { recursive: true, force: true }));
  assert.deepEqual(r.log, [
    'slice order: largest first by the lines of the test files their briefs name; 8 of 10 moved',
    'fan-out: 10 at once, 1 before, 1 after; role notes added',
  ]);
  assert.deepEqual(r.renoted.tasks.map((x) => x.id), ['r', 's1', 's2', 's10', 's9', 's7', 's8', 's5', 's6', 's3', 's4', 'close']);
  assert.equal(r.checks.sameGraph, true);
  assert.deepEqual(r.failed, []);
});

test('with the run\'s repository, a slice is sized by every test file its brief names, by a test directory and by a bare test name', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'reshape-repo-'));
  const write = (p, n) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), 'x = 1\n'.repeat(n)); };
  write('pkg/flow/tests/test_maxflow.py', 900);
  write('pkg/flow/tests/test_mincost.py', 300);
  write('pkg/cuts/cuts.py', 5);
  write('pkg/cuts/tests/test_cuts.py', 700);
  [1, 2, 3, 4].forEach((i) => write(`tests/test_m${i}.py`, 10 * i));
  const modules = (i) => Array.from({ length: 6 }, (_, k) => `m${i}_${k}.py`).join(', ');
  const recorded = { tasks: numbered([t('r', []),
    ...slices(4, ['r']).map((s, i) => ({ ...s, prompt: `Fill in ${modules(i + 1)}. Verify: pytest tests/test_m${i + 1}.py` })),
    { ...t('flow', ['r']), prompt: 'Fill in pkg/flow/maxflow.py. Its tests are in pkg/flow/tests/.' },
    { ...t('cuts', ['r']), prompt: 'Fill in pkg/cuts/cuts.py. Use its tests: test_cuts.py.' },
    t('close', [...sliceIds(4), 'flow', 'cuts'])]) };
  const r = await reshape(core, recorded, { workdir: repo }).finally(() => fs.rmSync(repo, { recursive: true, force: true }));
  assert.deepEqual(r.log.slice(0, 1), ['slice order: largest first by the lines of the test files their briefs name; 6 of 6 moved']);
  assert.deepEqual(r.renoted.tasks.slice(1, 7).map((x) => x.id), ['flow', 'cuts', 's4', 's3', 's2', 's1']);
  assert.deepEqual(r.failed, []);
});

test('a recorded plan whose run had merged slices keeps the same graph', async () => {
  const recorded = { tasks: numbered([t('r', []), ...slices(4, ['r']), { ...t('m', ['r']), mergedSlices: ['m2', 'm3'] }, t('close', [...sliceIds(4), 'm'])]) };
  const r = await reshape(core, recorded);
  assert.equal(r.checks.sameGraph, true);
});

// Recorded: no task waited for every slice, so the build that planned it wrote no note, the opening task's licence included.
// Its last task, waiting for only some slices, is told nothing: a slice's note would forbid it the fixing a last check does.
test('a plan with no closing check has its opening task, its other tasks before the slices and its slices noted, and is held to the same checks', async () => {
  const recorded = { tasks: numbered([t('r', []), t('a', ['r']), t('b', ['a']), ...slices(5, ['b']), t('sweep', ['r']), t('close', ['s1', 's2', 'sweep'])]) };
  const r = await reshape(core, recorded);
  assert.deepEqual(r.was, { opening: [], gates: [], slices: [], closing: [] });
  assert.deepEqual(r.noted, { opening: ['r'], gates: ['a', 'b'], slices: ['s1', 's2', 's3', 's4', 's5', 'sweep'], closing: [] });
  assert.deepEqual(r.now.faults, ['serial-opening', 'no-closing']);
  assert.equal(r.checks.licenceOnOpening, true);
  assert.equal(r.checks.importCriterion, true);
  assert.equal(r.checks.slicesToldTruly, true);
  assert.deepEqual(r.failed, []);
});

test('only the opening task carries the licence to edit any file', async () => {
  const recorded = { tasks: numbered([t('o1', []), ...['o2', 'o3', 'o4', 'o5'].map((id) => t(id, ['o1'])), ...slices(31, ['o1', 'o5']), t('close', ['o2', 'o3', 'o4', ...sliceIds(31)])]) };
  const r = await reshape(core, recorded);
  assert.deepEqual(r.licensed, ['o1']);
  assert.equal(r.checks.licenceOnOpening, true);
});

test('with the run\'s repository, the closing check is given the test directories no brief names, and the graph is the recorded one', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'reshape-repo-'));
  const write = (p) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), 'x = 1\n'); };
  ['src/lib/tests/test_s1.py', 'src/lib/minors/tests/test_contract.py', 'src/lib/minors/tests/test_minors.py'].forEach(write);
  const recorded = { tasks: numbered([t('r', []), ...slices(5, ['r']), t('close', sliceIds(5))]) };
  const r = await reshape(core, recorded, { workdir: repo }).finally(() => fs.rmSync(repo, { recursive: true, force: true }));
  assert.ok(r.log.includes('coverage: 2 test files in 1 directory no brief names, given to the closing check'));
  assert.ok(r.renoted.tasks.find((x) => x.id === 'close').prompt.endsWith('src/lib/minors/tests (2 test files).'));
  assert.equal(r.checks.sameGraph, true);
  assert.deepEqual(r.failed, []);
});

// A title is free text, and a slice's note names the tasks it waits for as `"title" (id)`.
test('parenthesised text in a title is not taken for a task id, a quoted title or one holding "has landed" included', async () => {
  const recorded = { tasks: numbered([
    { ...t('r', []), title: 'Restore imports (classes/function.py)' },
    { ...t('g', ['r']), title: 'Port "argmap" (argmap) once it has landed' },
    ...slices(5, ['r', 'g']),
    t('close', sliceIds(5))]) };
  const r = await reshape(core, recorded);
  assert.match(r.renoted.tasks.find((x) => x.id === 's1').prompt, /\(classes\/function\.py\)/);
  assert.equal(r.checks.slicesToldTruly, true);
  assert.deepEqual(r.failed, []);
});

test('a slice told it waits for a task it does not wait for fails the check', async () => {
  const recorded = { tasks: numbered([t('r', []), ...slices(5, ['r']), t('close', sliceIds(5))]) };
  const r = await reshape(core, recorded);
  const lie = { ...r.renoted, tasks: r.renoted.tasks.map((x) => (x.id === 's2' ? { ...x, prompt: x.prompt.replace('(r)', '(s3)') } : x)) };
  assert.equal(reshapeChecks(recorded, lie).checks.slicesToldTruly, false);
});
