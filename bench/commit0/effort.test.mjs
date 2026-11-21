// --effort-a: the reasoning effort of the single-agent arms' task, so that the arms think at the level B's planned tasks do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from './lib.mjs';
import * as R from './rehearsal.mjs';

const argv = (...more) => ['--dry-run', '--libs', 'l.json', ...more];

test('--effort-a sets the effort of the single-agent arms\' task, and with it absent nothing is set', () => {
  assert.equal(L.parseArgs(argv()).effortA, null);
  assert.equal(L.parseArgs(argv('--effort-a', 'high')).effortA, 'high');
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(L.parseArgs(argv('--effort-a', level)).effortA, level);
  assert.throws(() => L.parseArgs(argv('--effort-a', 'extreme')), /--effort-a takes one of low, medium, high, xhigh, max/);
  assert.throws(() => L.parseArgs(argv('--effort-a')), /needs a value/);
  // It is arm A's, plain or continued: with no arm A, or no attempt to run, it is refused rather than ignored.
  assert.equal(L.parseArgs(argv('--effort-a', 'max', '--continue-a')).effortA, 'max');
  assert.throws(() => L.parseArgs(argv('--effort-a', 'high', '--arm', 'B')), /--effort-a.*arm A/);
  assert.throws(() => L.parseArgs(['--run', '--libs', 'l.json', '--provider-pin', 'p', '--plan-only', '--effort-a', 'high']), /--effort-a.*no plan/);
  // A batch hands it to each single-agent run, never to B's.
  const b = L.parseBatchArgs(argv('--effort-a', 'high'));
  assert.equal(b.effortA, 'high');
  assert.deepEqual(L.driveArmArgs(L.ARMS.A, b), ['--arm', 'A', '--effort-a', 'high']);
  assert.deepEqual(L.driveArmArgs(L.ARMS['A-continued'], b), ['--arm', 'A', '--continue-a', '--effort-a', 'high']);
  assert.deepEqual(L.driveArmArgs(L.ARMS.B, b), ['--arm', 'B']);
  assert.deepEqual(L.driveArmArgs(L.ARMS.A, L.parseBatchArgs(argv())), ['--arm', 'A']);
  assert.throws(() => L.parseBatchArgs(argv('--effort-a', 'high', '--arm', 'B')), /--effort-a.*arm A/);
  assert.throws(() => L.parseBatchArgs(argv('--effort-a', 'nope')), /--effort-a takes one of/);
});

test('the one-task session carries the effort on its model as a planned task does, and none when the flag is absent', () => {
  // The script runs in the box against core: here it is the text that is read, with its arguments in order.
  assert.match(L.ARM_A_PLAN_JS, /const \[workspace, goal, modelId, modelLabel, effort\] = process\.argv\.slice\(1\)/);
  assert.match(L.ARM_A_PLAN_JS, /assignedModel: \{ modelId, modelLabel, \.\.\.\(effort \? \{ thinkingEffort: effort \} : \{\}\) \}/);
});

test('effortCounts reads the efforts a plan\'s AI tasks carry, subtasks included, and "unset" for a task with none', () => {
  const t = (effort, extra = {}) => ({ type: 'ai', assignedModel: { modelId: 'm', modelLabel: 'M', ...(effort ? { thinkingEffort: effort } : {}) }, subtasks: [], ...extra });
  const script = { type: 'script', subtasks: [] };
  assert.deepEqual(L.effortCounts({ tasks: [t('high'), t('max'), t('high'), t(null), script, t('low', { subtasks: [t('high')] })] }), { high: 3, max: 1, unset: 1, low: 1 });
  assert.deepEqual(L.effortCounts({ tasks: [t(null)] }), { unset: 1 });
  assert.deepEqual(L.effortCounts({ tasks: [t('high')] }), { high: 1 });
  assert.equal(L.effortCounts(null), null, 'no plan read: not zero');
});

test('result.json records the effort the arm\'s tasks ran at, and batch.json totals it per arm', () => {
  const window = L.judgeWindow({ listed: 1048576, snapshot: 1048576 });
  const base = { lib: L.validateLibrary({ name: 'tinylib', image: 'i', srcDir: 'tinylib', testDir: 'tests', importName: 'tinylib', distName: 'tinylib', baseCommit: 'abc1234' }), window, ordewell: { sha: 'abc' }, startedAt: 'a', endedAt: 'b', dryRun: true };
  const a = L.resultRecord({ ...base, arm: L.ARMS.A, effortA: 'high', efforts: { high: 1 } });
  assert.deepEqual([a.effortA, a.efforts], ['high', { high: 1 }]);
  const plain = L.resultRecord({ ...base, arm: L.ARMS.A, efforts: { unset: 1 } });
  assert.deepEqual([plain.effortA, plain.efforts], [null, { unset: 1 }], 'the flag absent: no effort set, and the record says so');
  const b = L.resultRecord({ ...base, arm: L.ARMS.B, efforts: { high: 5, max: 2 } });
  assert.deepEqual([b.effortA, b.efforts], [null, { high: 5, max: 2 }]);
  assert.equal(L.resultRecord({ ...base, arm: L.ARMS.B }).efforts, null);
  const run = (lib, arm, efforts) => ({ lib, arm, recordedUsd: 1, efforts });
  const rec = L.batchRecord({ jobs: 1, overlapped: false, runs: [run('x', 'A', { high: 1 }), run('y', 'A', { high: 1 }), run('x', 'B', { high: 5, max: 2 }), run('y', 'B', { max: 3, unset: 1 })] });
  assert.deepEqual(rec.perArm.A.efforts, { high: 2 });
  assert.deepEqual(rec.perArm.B.efforts, { high: 5, max: 5, unset: 1 });
});

test('the effort scenario passes the flag and the fake provider is told to read the effort off the request', () => {
  const s = R.scenario('a-continued-effort');
  assert.equal(s.arm, 'A-continued');
  assert.equal(s.effortA, 'high');
  assert.ok(R.windowArgs(s).length > 0);
  const f = (requests, want = 'high') => R.judgeEffort('a-continued-effort', requests, want).join('\n');
  const asked = (reasoning, role = 'runner') => ({ turn: { role, key: 'A', attempt: 1, round: 0 }, reasoning });
  assert.equal(f([asked({ effort: 'high' }), asked({ effort: 'high' })]), '');
  assert.match(f([asked(null), asked({ effort: 'high' })]), /1 of 2 requests of the task carried reasoning effort "high"/);
  assert.match(f([asked({ effort: 'medium' })]), /carried reasoning effort "high"/);
  assert.match(f([]), /no request of the task/);
  assert.deepEqual(R.judgeEffort('a-continued', [asked(null)], 'high'), [], 'a scenario that sets no effort has nothing to judge');
  // The planner and the supervisor are not the task: only the runner's requests are read.
  assert.equal(f([asked({ effort: 'high' }), asked(null, 'supervisor')]), '');
});
