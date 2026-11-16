// The Commit0 driver's own logic: each check's verdict, the parsers its
// numbers come from, and the record. The docker and git calls around them are
// proved by the dry run, which needs an engine (bench/README.md, "Commit0").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const lib = (over = {}) => L.validateLibrary({
  name: 'tinylib', image: 'commit0/tinylib:v0', srcDir: 'tinylib', testDir: 'tests',
  importName: 'tinylib', distName: 'tinylib', baseCommit: 'abc1234', ...over,
});

test('validateLibrary fills the defaults Commit0 images share', () => {
  const l = lib();
  assert.equal(l.workdir, '/testbed');
  // Commit0's images install into /testbed/.venv, which `docker exec` puts on no PATH.
  assert.equal(l.testCmd, '/testbed/.venv/bin/python -m pytest');
  assert.equal(l.python, '/testbed/.venv/bin/python');
  assert.equal(lib({ workdir: '/work/' }).python, '/work/.venv/bin/python');
  assert.equal(l.networkMarker, 'network');
  assert.equal(lib({ testCmd: '/venv/bin/python -m pytest' }).python, '/venv/bin/python');
});

test('the example runs the tests under the venv python', () => {
  for (const raw of JSON.parse(fs.readFileSync(path.join(here, 'libraries.example.json'), 'utf8')).libraries) {
    assert.equal(raw.testCmd, `${raw.workdir}/.venv/bin/python -m pytest`);
  }
});

test('validateLibrary refuses a missing field, a placeholder and a bad name', () => {
  assert.throws(() => lib({ image: undefined }), /"image" is missing/);
  assert.throws(() => lib({ baseCommit: '<the base commit>' }), /placeholder/);
  assert.throws(() => lib({ name: '../x' }), /plain file name/);
  assert.throws(() => lib({ baseCommit: 'main' }), /commit sha/);
  assert.throws(() => lib({ networkMarker: 'not a marker' }), /marker name/);
  assert.throws(() => lib({ referenceCommit: '<ref>' }), /referenceCommit/);
  for (const raw of JSON.parse(fs.readFileSync(path.join(here, 'libraries.example.json'), 'utf8')).libraries) {
    assert.throws(() => L.validateLibrary(raw), /placeholder/, 'the example must not run as it stands');
  }
});

test('the goal is one text for both arms and names the tests and the closed network', () => {
  const g = L.goalText(lib());
  assert.match(g, /tests/);
  assert.match(g, /python -m pytest tests/);
  assert.match(g, /network is closed/);
  assert.match(g, /may not import until its stubbed functions are implemented/);
  assert.match(g, /fails to import is not a reason to stop/);
  assert.match(g, /tests in the repository are the specification/);
  const [, , ...a] = L.armCommands(L.ARMS.A, { workspace: '/testbed', goal: g, sessionId: 's' });
  const [plan, ...b] = L.armCommands(L.ARMS.B, { workspace: '/testbed', goal: g, sessionId: 's' });
  assert.deepEqual(plan, ['ordewell', 'plan', '--goal', g, '--runner', 'ordewell', '--no-chat', '--yes', '--workspace', '/testbed']);
  assert.deepEqual(b.at(-1), ['ordewell', 'merge', '--session-id', 's', '--yes', '--workspace', '/testbed']);
  assert.deepEqual(a, b.slice(1), 'both arms merge alike');
  // Arm A's one task is handed the goal as an argument of ARM_A_PLAN_JS, in drive.mjs; both read goalText.
  assert.match(fs.readFileSync(path.join(here, 'drive.mjs'), 'utf8'), /L\.ARM_A_PLAN_JS, lib\.workdir, L\.goalText\(lib\)/);
  assert.match(plan[3], /may not import until its stubbed functions are implemented/);
  assert.equal(plan[3], L.goalText(lib()));
});

test('the arms hold the protocol: one model, the caps, no planner in A', () => {
  assert.equal(L.MODEL_ID, 'openrouter:deepseek/deepseek-v4.1-flash');
  assert.equal(L.ARMS.A.capUsd, 2.5);
  assert.equal(L.ARMS.B.capUsd, 5.5);
  assert.equal(L.WALL_CAP_MS, 3 * 3600 * 1000);
  assert.deepEqual(L.armsOf('both').map((a) => a.id), ['A', 'B']);
  assert.deepEqual(L.boxSettings().modelAllowlist, { ordewell: [L.MODEL_ID] });
  assert.match(L.ARM_A_PLAN_JS, /assignedRunner: 'ordewell'/);
  assert.match(L.ARM_A_PLAN_JS, /status: 'approved'/);
});

test('judgeWindow runs only on a listed window above the fallback', () => {
  assert.deepEqual(
    { ok: L.judgeWindow({ listed: 1048576, snapshot: 1048576 }).ok, window: L.judgeWindow({ listed: 1048576, snapshot: 1048576 }).window },
    { ok: true, window: 1048576 },
  );
  const unlisted = L.judgeWindow({ listed: undefined, snapshot: 1048576 });
  assert.equal(unlisted.ok, false, 'a snapshot does not save a run whose listing fails');
  assert.match(unlisted.reason, /32000-token fallback/);
  const zero = L.judgeWindow({ listed: 0, snapshot: 1048576 });
  assert.equal(zero.ok, true);
  assert.equal(zero.source, 'offline catalog (the listing states 0)');
  assert.equal(L.judgeWindow({ listed: 0, snapshot: undefined }).ok, false);
  assert.equal(L.judgeWindow({ listed: 32000, snapshot: undefined }).ok, false);
  assert.match(L.judgeWindow({ listed: 200000, snapshot: 1048576 }).reason, /offline catalog says 1048576/);
});

test('listedWindow and snapshotWindow read the model, with or without the provider prefix', () => {
  assert.equal(L.listedWindow([{ id: 'deepseek/deepseek-v4.1-flash', contextLength: 5 }]), 5);
  assert.equal(L.listedWindow([{ id: 'openrouter:deepseek/deepseek-v4.1-flash' }]), 0);
  assert.equal(L.listedWindow([{ id: 'other' }]), undefined);
  assert.equal(L.listedWindow(null), undefined);
  assert.equal(L.snapshotWindow({ openrouter: { 'deepseek/deepseek-v4.1-flash': { contextWindow: 7 } } }), 7);
  assert.equal(L.snapshotWindow({}), undefined);
});

test("core's offline catalog states the model's window", () => {
  const table = JSON.parse(fs.readFileSync(path.join(repo, 'packages/core/src/services/modelDetailsSnapshot.json'), 'utf8'));
  assert.ok(L.snapshotWindow(table) > L.FALLBACK_WINDOW);
});

test('windowFallbackSuspected flags a compaction from under half the window', () => {
  assert.equal(L.windowFallbackSuspected([30000], 1048576), true);
  assert.equal(L.windowFallbackSuspected([600000], 1048576), false);
  assert.equal(L.windowFallbackSuspected([], 1048576), false);
});

test('judgeEgress: the listing through the gateway, nothing else, nothing around it', () => {
  const proxied = [
    { url: L.EGRESS_ALLOWED_PROBES[0], status: 200 },
    ...L.EGRESS_DENIED_PROBES.map((url) => ({ url, error: 'Request was cancelled.' })),
  ];
  const direct = [...L.EGRESS_ALLOWED_PROBES, ...L.EGRESS_DENIED_PROBES].map((url) => ({ url, error: 'EAI_AGAIN' }));
  assert.deepEqual(L.judgeEgress({ proxied, direct }), { ok: true, failures: [] });
  const leaky = L.judgeEgress({ proxied: proxied.map((p) => (p.url.includes('pypi') ? { url: p.url, status: 200 } : p)), direct });
  assert.equal(leaky.ok, false);
  assert.match(leaky.failures[0], /pypi.org.*answered 200 through the gateway/);
  assert.equal(L.judgeEgress({ proxied, direct: [{ url: 'https://github.com/', status: 301 }] }).ok, false);
  assert.equal(L.judgeEgress({ proxied, direct: [] }).ok, false, 'an empty probe proves nothing');
  assert.equal(L.judgeEgress({ proxied: proxied.slice(1), direct }).ok, false, 'the listing must answer');
});

test("extractEgressEntry finds core's gateway program", () => {
  const source = fs.readFileSync(path.join(repo, 'packages/core/src/services/container/egressSidecar.ts'), 'utf8');
  const entry = L.extractEgressEntry(source);
  assert.match(entry, /ORDEWELL_EGRESS/);
  assert.match(entry, /ready/);
  assert.match(source, new RegExp(`EGRESS_PORT = ${L.EGRESS_PORT};`));
  assert.throws(() => L.extractEgressEntry('nothing here'), /core moved it/);
});

const cleanProbe = { commits: 1, objectCommits: 1, reference: 'absent', alternates: false, resolves: ['/testbed/tinylib/__init__.py'], resolvesOutside: [], installedOutside: [], archives: [] };

test('judgeLeak passes a flattened repository and names every way out', () => {
  assert.deepEqual(L.judgeLeak(cleanProbe), { ok: true, failures: [] });
  assert.deepEqual(L.leakKinds(cleanProbe), []);
  const leaky = { ...cleanProbe, commits: 40, objectCommits: 40, reference: 'present', alternates: true, resolvesOutside: ['/usr/lib/python3/site-packages/tinylib'], installedOutside: ['/usr/lib/python3/site-packages/tinylib-1.0.dist-info'], archives: ['/root/tinylib-1.0.tar.gz'] };
  const v = L.judgeLeak(leaky);
  assert.equal(v.ok, false);
  assert.equal(v.failures.length, 7);
  assert.deepEqual(L.leakKinds(leaky), ['history', 'reference', 'alternates', 'import', 'installed', 'archive']);
  assert.equal(L.judgeLeak({ ...cleanProbe, commits: null }).ok, false, 'an unreadable history is not a clean one');
});

test('flattenScript leaves one commit and drops every ref and log that keeps another', () => {
  const s = L.flattenScript(lib({ workdir: "/test'bed" }));
  assert.match(s, /cd '\/test'\\''bed'/);
  assert.match(s, /checkout -q --orphan commit0-base/);
  assert.match(s, /update-ref -d/);
  assert.match(s, /reflog expire --expire=now --all/);
  assert.match(s, /gc -q --prune=now/);
  assert.match(s, /ORIG_HEAD/);
});

const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
const hasPython = (() => { try { execFileSync('python3', ['--version']); return true; } catch { return false; } })();

test('flattenScript and the leak probe on a real repository', { skip: !(hasGit && hasPython && process.platform !== 'win32') && 'needs git, python3 and sh' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-'));
  try {
    const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(dir, 'tinylib'));
    fs.writeFileSync(path.join(dir, 'tinylib', '__init__.py'), 'def f():\n    return 1\n');
    g('add', '-A'); g('commit', '-qm', 'impl'); g('tag', 'v1');
    const ref = g('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'tinylib', '__init__.py'), 'def f():\n    raise NotImplementedError\n');
    g('commit', '-qam', 'stubs');
    const base = g('rev-parse', 'HEAD');
    const l = lib({ workdir: dir, baseCommit: base, referenceCommit: ref, python: 'python3' });
    const probe = () => JSON.parse(execFileSync('python3', ['-c', L.LEAK_PROBE_PY, dir, 'tinylib', 'tinylib-unlikely-dist', ref, dir], { cwd: '/', encoding: 'utf8' }).trim().split('\n').pop());
    const before = probe();
    assert.equal(before.commits, 2);
    assert.equal(before.reference, 'present');
    execFileSync('sh', ['-c', L.flattenScript(l)], { encoding: 'utf8' });
    const after = probe();
    assert.equal(after.commits, 1);
    assert.equal(after.objectCommits, 1);
    assert.equal(after.reference, 'absent');
    assert.equal(g('show', 'HEAD:tinylib/__init__.py'), 'def f():\n    raise NotImplementedError');
    assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'commit0-base');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeWrittenScript removes what was written after the marker, and nothing in .git', { skip: process.platform === 'win32' && 'POSIX find and sh' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-'));
  try {
    const old = new Date(Date.now() - 60_000);
    for (const f of ['kept.py', '.git/HEAD']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), 'x');
      fs.utimesSync(path.join(dir, f), old, old);
    }
    const mark = path.join(dir, '..', `${path.basename(dir)}.mark`);
    fs.writeFileSync(mark, '');
    fs.utimesSync(mark, new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));
    fs.mkdirSync(path.join(dir, 'pkg', '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pkg', '__pycache__', 'impl.cpython-310.pyc'), 'compiled reference');
    fs.writeFileSync(path.join(dir, '.git', 'index'), 'new');
    const out = execFileSync('sh', ['-c', L.removeWrittenScript(mark)], { cwd: dir, encoding: 'utf8' });
    assert.deepEqual(out.trim().split('\n'), ['./pkg/__pycache__/impl.cpython-310.pyc']);
    assert.equal(fs.existsSync(path.join(dir, 'pkg', '__pycache__', 'impl.cpython-310.pyc')), false);
    assert.equal(fs.existsSync(path.join(dir, 'kept.py')), true);
    assert.equal(fs.existsSync(path.join(dir, '.git', 'index')), true);
    assert.equal(fs.existsSync(mark), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pytestArgs leaves the network-marked tests out and writes no cache', () => {
  assert.deepEqual(L.pytestArgs(lib({ networkMarker: 'online' })), ['-m', 'not online', '-p', 'no:cacheprovider', 'tests']);
});

test('parseCollection reads the collected and deselected counts', () => {
  assert.deepEqual(L.parseCollection('a::b\n\n3/4 tests collected (1 deselected) in 0.01s\n'), { collected: 3, total: 4, deselected: 1 });
  assert.deepEqual(L.parseCollection('12 tests collected in 0.2s'), { collected: 12, total: 12, deselected: 0 });
  assert.deepEqual(L.parseCollection('1 test collected in 0.2s'), { collected: 1, total: 1, deselected: 0 });
  assert.deepEqual(L.parseCollection('no tests collected (5 deselected) in 0.1s'), { collected: 0, total: 5, deselected: 5 });
  assert.equal(L.parseCollection('ERROR collecting tests/test_x.py'), null);
});

test('the denominator is counted at the reference, where collection must succeed', () => {
  const ok = L.judgeReferenceCollection({ code: 0, output: 'x::y\n\n5268/5270 tests collected (2 deselected) in 9.1s\n' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.counts, { collected: 5268, total: 5270, deselected: 2 });
  assert.equal(L.judgeReferenceCollection({ code: 2, output: 'ERROR collecting x\n1 test collected, 1 error in 0.1s' }).ok, false);
  assert.equal(L.judgeReferenceCollection({ code: 5, output: 'no tests collected in 0.1s' }).ok, false);
});

test('at the stubs collection may fail, and only a missing module fails the check', () => {
  // What the real images print: networkx's stubs break every import (exit 4, none collected), tlslite-ng's exit 2.
  const networkx = L.judgeStubCollection({ code: 4, output: 'ImportError while loading conftest \'/testbed/networkx/conftest.py\'.\nnetworkx/__init__.py:19: in <module>\nE   NotImplementedError\n' });
  assert.equal(networkx.ok, true);
  const tlslite = L.judgeStubCollection({ code: 2, output: 'ERROR collecting unit_tests/test_tlslite_x.py\nE   ImportError: cannot import name \'x\'\n12 tests collected, 30 errors in 1.2s\n' });
  assert.equal(tlslite.ok, true);
  assert.equal(tlslite.counts.collected, 12);
  const missing = L.judgeStubCollection({ code: 0, output: 'E   ModuleNotFoundError: No module named \'scipy\'\n3 tests collected in 0.1s\n' });
  assert.equal(missing.ok, false);
  assert.match(missing.failures[0], /No module named 'scipy'/);
  assert.equal(L.judgeStubCollection({ code: 1, output: "ImportError: No module named ecdsa\n" }).ok, false);
});

test('only the tests are restored when testDir lies inside the source', () => {
  const networkx = lib({ srcDir: 'networkx/', testDir: 'networkx/' });
  assert.equal(L.isTestPath(networkx, 'networkx/algorithms/tests/test_cycles.py'), true);
  assert.equal(L.isTestPath(networkx, 'networkx/algorithms/tests/__init__.py'), true);
  assert.equal(L.isTestPath(networkx, 'networkx/conftest.py'), true);
  assert.equal(L.isTestPath(networkx, 'networkx/algorithms/cycles.py'), false, 'the arm\'s work');
  assert.equal(L.isTestPath(networkx, 'networkx/testing/__init__.py'), false);
  assert.equal(L.isTestPath(networkx, 'docs/tests/test_x.py'), false, 'outside testDir');
  const tlslite = lib({ srcDir: 'tlslite/', testDir: 'unit_tests/' });
  assert.equal(L.isTestPath(tlslite, 'unit_tests/mocksock.py'), true, 'a helper in unit_tests/ is a test file');
  assert.equal(L.isTestPath(tlslite, 'tlslite/utils/cryptomath.py'), false);

  const z = (...a) => `${a.join('\0')}\0`;
  const plan = L.testRestorePlan(networkx,
    z('M', 'networkx/algorithms/cycles.py', 'M', 'networkx/algorithms/tests/test_cycles.py', 'D', 'networkx/tests/test_x.py', 'A', 'networkx/tests/test_new.py', 'A', 'networkx/algorithms/helper.py'),
    z('networkx/tests/test_untracked.py', 'networkx/scratch.py'));
  assert.deepEqual(plan, {
    checkout: ['networkx/algorithms/tests/test_cycles.py', 'networkx/tests/test_x.py'],
    remove: ['networkx/tests/test_new.py', 'networkx/tests/test_untracked.py'],
  });
  assert.deepEqual(L.testRestorePlan(networkx, '', ''), { checkout: [], remove: [] });
});

test('parsePytestSummary reads the last summary line', () => {
  assert.deepEqual(L.parsePytestSummary('..F\n=== 2 failed, 10 passed, 1 skipped, 3 deselected, 1 error in 1.20s ===\n'),
    { passed: 10, failed: 2, errors: 1, skipped: 1, xfailed: 0, xpassed: 0, deselected: 3 });
  assert.deepEqual(L.parsePytestSummary('1 passed, 2 failed in 0.03s (0:00:00)'), { passed: 1, failed: 2, errors: 0, skipped: 0, xfailed: 0, xpassed: 0, deselected: 0 });
  assert.equal(L.parsePytestSummary('Terminated'), null);
});

const line = (o) => JSON.stringify({ v: 1, at: 't', ...o });
const transcript = [
  line({ kind: 'session', model: 'openrouter:deepseek/deepseek-v4.1-flash', system: [] }),
  line({ kind: 'message', step: 1, message: { role: 'user', content: 'x' } }),
  line({ kind: 'usage', step: 1, usage: { inputTokens: 1000, outputTokens: 200, cost: { amount: 0.01 } }, covers: 2 }),
  line({ kind: 'usage', step: 2, usage: { inputTokens: 5000, outputTokens: 300 } }),
  line({ kind: 'compaction', step: 3, head: 1, tailFrom: 3, message: { role: 'user', content: 's' }, preTokens: 600000, postTokens: 2000, usage: { inputTokens: 1, cost: { amount: 0.002 } } }),
  '{"v":1,"kind":"usage","step":4,"usa',
].join('\n');

test('parseEvaluation counts a run whose stubs break collection as none passed, and nothing else without a summary', () => {
  assert.equal(L.parseEvaluation(1, '== 3 passed, 2 failed in 0.4s ==').passed, 3);
  // networkx at the stubs: the conftest import fails, exit 4, no summary line.
  const networkx = L.parseEvaluation(4, "ImportError while loading conftest '/testbed/networkx/conftest.py'.\nnetworkx/__init__.py:19: in <module>\nE   TypeError: 'NoneType' object is not callable\n");
  assert.equal(networkx.passed, 0);
  assert.match(networkx.collectionError, /conftest '\/testbed\/networkx\/conftest.py'/);
  assert.equal(L.parseEvaluation(4, 'ERROR: usage: pytest [options]\npytest: error: unrecognized arguments: --bad\n'), null, 'a driver mistake is not a score');
  assert.equal(L.parseEvaluation(124, ''), null);
});

test('summarizeTranscript: spend, peak context and compactions', () => {
  const s = L.summarizeTranscript(transcript);
  assert.equal(s.usageLines, 2);
  assert.equal(s.uncosted, 1);
  assert.equal(L.round6(s.spendUsd), 0.012);
  assert.equal(s.peakContext, 5300);
  assert.equal(s.compactions, 1);
  assert.deepEqual(s.compactionPreTokens, [600000]);
  assert.equal(s.steps, 3, 'a torn last line is skipped');
  assert.equal(s.model, L.MODEL_ID);
  const both = L.combineTranscripts([s, s]);
  assert.equal(both.sessions, 2);
  assert.equal(both.spendUsd, 0.024);
  assert.equal(both.peakContext, 5300);
  assert.equal(both.compactions, 2);
  assert.deepEqual(both.models, [L.MODEL_ID]);
});

test('the runner modes are the built-in runner manifest\'s, and arm A takes its autonomous one', () => {
  const manifest = fs.readFileSync(path.join(repo, 'packages', 'core', 'src', 'plugins', 'builtin', 'ordewell.manifest.ts'), 'utf8');
  const ids = [...manifest.matchAll(/export const ORDEWELL_\w+_MODE = '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...L.RUNNER_MODES].sort(), ids.sort());
  assert.match(manifest, new RegExp(`id: ORDEWELL_FULL_MODE, [^\\n]*autonomous: true`));
  assert.equal(L.ARM_A_MODE, 'full');
  assert.match(L.ARM_A_PLAN_JS, /taskMode: 'full'/);
});

test('judgePlan fails a task in a mode the runner lacks, as createTask\'s default build', () => {
  const t = (o = {}) => ({ title: 't', type: 'ai', assignedRunner: 'ordewell', assignedModel: { modelId: L.MODEL_ID }, taskMode: 'full', ...o });
  const build = L.judgePlan({ tasks: [t({ taskMode: 'build' })] });
  assert.equal(build.ok, false);
  assert.match(build.failures[0], /mode build, which the ordewell runner does not have/);
  assert.match(L.judgePlan({ tasks: [t({ taskMode: undefined })] }).failures[0], /mode none/);
  assert.equal(L.judgePlan({ tasks: [t({ subtasks: [t({ taskMode: 'build' })] })] }).ok, false);
  for (const mode of L.RUNNER_MODES) assert.equal(L.judgePlan({ tasks: [t({ taskMode: mode })] }).ok, true, mode);
});

test('startDecision stops a run with no model call past the bound, and only then', () => {
  assert.equal(L.NO_START_MS, 10 * 60 * 1000);
  const plan = { tasks: [{ title: 'Implement', type: 'ai', status: 'pending', taskMode: 'build' }, { title: 'done', type: 'ai', status: 'completed', attempted: true }] };
  assert.equal(L.startDecision({ sinceRunMs: L.NO_START_MS - 1, usageLines: 0, plan }).stop, false, 'inside the bound');
  assert.equal(L.startDecision({ sinceRunMs: L.NO_START_MS * 5, usageLines: 1, plan }).stop, false, 'a model call means it started');
  const stuck = L.startDecision({ sinceRunMs: L.NO_START_MS, usageLines: 0, plan });
  assert.equal(stuck.stop, true);
  assert.equal(stuck.why, 'no-start');
  assert.match(stuck.detail, /no model call 10 min into the run; waiting: "Implement" pending, no attempt, mode build$/);
  assert.match(L.startDecision({ sinceRunMs: L.NO_START_MS, usageLines: 0, plan: null }).detail, /could not be read/);
  assert.equal(L.startDecision({ sinceRunMs: 60_000, usageLines: 0, plan, boundMs: 60_000 }).stop, true);
});

test('judgePlan holds every AI task, subtasks too, to the runner and the model', () => {
  const t = (o = {}) => ({ title: 't', type: 'ai', assignedRunner: 'ordewell', assignedModel: { modelId: L.MODEL_ID }, taskMode: 'full', ...o });
  assert.equal(L.judgePlan({ tasks: [t(), t({ type: 'script', assignedRunner: undefined, assignedModel: undefined })] }).ok, true);
  assert.equal(L.judgePlan({ tasks: [t({ subtasks: [t({ assignedRunner: 'claude' })] })] }).ok, false);
  assert.match(L.judgePlan({ tasks: [t({ assignedModel: { modelId: 'openrouter:x' } })] }).failures[0], /not openrouter:deepseek/);
  assert.equal(L.judgePlan({ tasks: [] }).ok, false);
  assert.equal(L.judgePlan(null).ok, false);
});

test('capDecision stops at either cap, on the larger spend it knows', () => {
  assert.deepEqual(L.capDecision({ elapsedMs: 0, keySpentUsd: 1, transcriptSpentUsd: 0.5, capUsd: 2.5 }), { stop: false, why: null, spentUsd: 1 });
  assert.equal(L.capDecision({ elapsedMs: 0, keySpentUsd: null, transcriptSpentUsd: 2.6, capUsd: 2.5 }).why, 'spend');
  assert.equal(L.capDecision({ elapsedMs: L.WALL_CAP_MS, keySpentUsd: 0, transcriptSpentUsd: 0, capUsd: 2.5 }).why, 'wall-clock');
});

test('resultRecord carries every field the comparison reports', () => {
  const window = L.judgeWindow({ listed: 1048576, snapshot: 1048576 });
  const r = L.resultRecord({
    lib: lib(), arm: L.ARMS.B, window, ordewell: { sha: 'abc', containsPr177: true },
    egress: { ok: true }, leak: { ok: true }, network: { collected: 9, deselected: 2 },
    tests: { passed: 7, collected: 9, failed: 2, errors: 0, skipped: 0, exit: 1 }, wallClockMs: 1000,
    spend: { billedUsd: 1.5, source: 'openrouter key usage' }, transcripts: L.combineTranscripts([L.summarizeTranscript(transcript)]),
    providerPin: 'SomeProvider', dryRun: false, startedAt: 'a', endedAt: 'b',
  });
  assert.equal(r.contextWindow, 1048576);
  assert.equal(r.pr177Merge, L.PR177_MERGE);
  assert.equal(r.ordewellSha, 'abc');
  assert.deepEqual(r.tests, { passed: 7, collected: 9, failed: 2, errors: 0, skipped: 0 });
  assert.equal(r.networkDeselected, 2);
  assert.equal(r.billedUsd, 1.5);
  assert.equal(r.capUsd, 5.5);
  assert.equal(r.peakContext, 5300);
  assert.equal(r.compactions, 1);
  assert.equal(r.windowFallbackSuspected, false);
  assert.equal(r.providerPin, 'SomeProvider');
});

test('parseArgs never spends by default', () => {
  assert.throws(() => L.parseArgs(['--libs', 'x.json']), /--dry-run.*--run/);
  assert.throws(() => L.parseArgs(['--dry-run', '--run', '--libs', 'x']), /--dry-run.*--run/);
  assert.throws(() => L.parseArgs(['--run', '--libs', 'x.json']), /--provider-pin/);
  assert.throws(() => L.parseArgs(['--run', '--fixture', '--image', 'i', '--provider-pin', 'p']), /--fixture is a dry-run/);
  assert.throws(() => L.parseArgs(['--dry-run', '--fixture']), /--image/);
  assert.throws(() => L.parseArgs(['--dry-run']), /--libs/);
  assert.throws(() => L.parseArgs(['--dry-run', '--libs']), /needs a value/);
  assert.throws(() => L.parseArgs(['--dry-run', '--arm', 'C', '--libs', 'x']), /A, B or both/);
  assert.throws(() => L.parseArgs(['--bogus']), /unknown argument/);
  const o = L.parseArgs(['--dry-run', '--libs', 'x.json', '--only', 'a,b', '--arm', 'a']);
  assert.deepEqual([o.dryRun, o.run, o.arm, o.only], [true, false, 'A', ['a', 'b']]);
  assert.equal(L.parseArgs(['--help']).help, true);
});

test('shellQuote survives a quote', () => {
  assert.equal(execFileSync('sh', ['-c', `printf %s ${L.shellQuote("it's")}`], { encoding: 'utf8' }), "it's");
});

test('the driver holds no key and writes no run data into the repository', () => {
  for (const f of fs.readdirSync(here)) {
    const text = fs.readFileSync(path.join(here, f), 'utf8');
    assert.doesNotMatch(text, /sk-or-v1-[0-9a-f]{8,}/, `${f} holds an OpenRouter key`);
  }
  assert.match(fs.readFileSync(path.join(here, 'drive.mjs'), 'utf8'), /checkedBenchDir\('commit0'\)/);
});
