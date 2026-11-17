// The Commit0 driver's own logic: each check's verdict, the parsers its
// numbers come from, and the record. The docker and git calls around them are
// proved by the dry run, which needs an engine (bench/README.md, "Commit0").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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
  assert.deepEqual(plan, ['ordewell', 'plan', '--goal', g, '--runner', 'openrouter', '--no-chat', '--yes', '--workspace', '/testbed']);
  assert.deepEqual(b.at(-1), ['ordewell', 'merge', '--session-id', 's', '--yes', '--workspace', '/testbed']);
  assert.deepEqual(a, b.slice(1), 'both arms merge alike');
  // Arm A's one task is handed the goal as an argument of ARM_A_PLAN_JS, in drive.mjs; both read goalText.
  assert.match(fs.readFileSync(path.join(here, 'drive.mjs'), 'utf8'), /L\.ARM_A_PLAN_JS, lib\.workdir, L\.goalText\(lib\)/);
  assert.match(plan[3], /may not import until its stubbed functions are implemented/);
  assert.equal(plan[3], L.goalText(lib()));
});

test('the arms hold the protocol: one model, one cap for both (D1), no planner in A', () => {
  assert.equal(L.MODEL_ID, 'openrouter:deepseek/deepseek-v4.1-flash');
  assert.equal(L.CAP_USD, 8);
  assert.equal(L.ARMS.A.capUsd, undefined, 'no per-arm cap');
  assert.equal(L.ARMS.B.capUsd, undefined, 'no per-arm cap');
  assert.equal(L.WALL_CAP_MS, 3 * 3600 * 1000);
  assert.deepEqual(L.armsOf('both').map((a) => a.id), ['A', 'B']);
  for (const arm of L.armsOf('both')) assert.deepEqual(L.boxSettings(arm).modelAllowlist, { openrouter: [L.MODEL_ID] });
  assert.match(L.ARM_A_PLAN_JS, /assignedRunner: 'openrouter'/);
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

const cleanProbe = { commits: 1, objectCommits: 1, reference: 'absent', alternates: false, resolves: ['/testbed/tinylib/__init__.py'], resolvesOutside: [], installedOutside: [], archives: [], untracked: [] };

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

// The eval box's flattened commit as selectScoredFiles reads it, and an arm's files: path to content.
const blob = (text) => ({ mode: '100644', oid: execFileSync('git', ['hash-object', '--stdin'], { input: text, encoding: 'utf8' }).trim() });
const manifestOf = (files) => new Map(Object.entries(files).map(([p, v]) => [p, v === null ? { pruned: true } : typeof v === 'string' ? blob(v) : v]));

test('what crosses into the eval box: the arm\'s source, never its tests, test configuration, venv or a shadowing module', { skip: !hasGit && 'needs git' }, () => {
  const base = { 'tinylib/__init__.py': 'stub\n', 'tinylib/core.py': 'stub\n', 'tinylib/gone.py': 'stub\n', 'tests/test_core.py': 'test\n', 'tests/test_gone.py': 'test\n', 'pyproject.toml': '[project]\n', 'conftest.py': 'base\n' };
  const unchanged = (...paths) => Object.fromEntries(paths.map((p) => [p, base[p]]));
  const cases = [
    ['a source edit crosses', { 'tinylib/core.py': 'impl\n' }, { copy: ['tinylib/core.py'] }],
    ['a new module inside the library crosses', { 'tinylib/helpers.py': 'x\n' }, { copy: ['tinylib/helpers.py'] }],
    ['a test edit is excluded', { 'tests/test_core.py': 'assert True\n' }, { excluded: [['tests/test_core.py', "a test: the reference's is kept"]] }],
    ['a new test is excluded', { 'tests/test_new.py': 'x\n' }, { excluded: [['tests/test_new.py', "a test: the reference's is kept"]] }],
    ['a conftest.py edit is excluded and recorded', { 'conftest.py': 'def pytest_runtest_makereport(): ...\n' }, { excluded: [['conftest.py', "test configuration: the reference's is kept"]], inspect: true }],
    ['a nested conftest.py is excluded and recorded', { 'tinylib/conftest.py': 'x\n' }, { excluded: [['tinylib/conftest.py', "test configuration: the reference's is kept"]], inspect: true }],
    ['a pyproject.toml edit keeps the reference\'s and is recorded', { 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-p no:python"\n' }, { excluded: [['pyproject.toml', "test configuration: the reference's is kept whole"]], inspect: true }],
    ['a .venv write is excluded', { '.venv': null }, { excluded: [['.venv', "the image's venv"]] }],
    ['git metadata and Ordewell\'s data are excluded', { '.git': null, '.ordewell': null }, { excluded: [['.git', 'git metadata'], ['.ordewell', "Ordewell's session data"]] }],
    ['a pytest.ini, hidden or not, and a pytest.toml are excluded and recorded', { 'pytest.ini': 'x\n', '.pytest.ini': 'x\n', 'pytest.toml': 'x\n', 'tinylib/.pytest.toml': 'x\n' }, {
      excluded: ['pytest.ini', '.pytest.ini', 'pytest.toml', 'tinylib/.pytest.toml'].map((p) => [p, "test configuration: the reference's is kept"]), inspect: true }],
    ['bytecode is excluded, in __pycache__ or beside its source', { 'tinylib/__pycache__': null, 'tinylib/core.pyc': 'x', 'tinylib/old.pyo': 'x' }, {
      excluded: [['tinylib/__pycache__', 'bytecode'], ['tinylib/core.pyc', 'bytecode'], ['tinylib/old.pyo', 'bytecode']] }],
    ['a compiled module is excluded', { 'tinylib/_ext.cpython-312-x86_64-linux-gnu.so': 'x', 'tinylib/_win.pyd': 'x' }, {
      excluded: [['tinylib/_ext.cpython-312-x86_64-linux-gnu.so', 'a compiled module'], ['tinylib/_win.pyd', 'a compiled module']] }],
    ['git metadata is excluded at any depth', { 'vendor/x/.git/config': 'x\n', 'vendor/y/.git': 'gitdir: /elsewhere\n' }, {
      excluded: [['vendor/x/.git/config', 'git metadata'], ['vendor/y/.git', 'git metadata']] }],
    ['a top-level pytest/ package is excluded and flagged', { 'pytest/__init__.py': 'x\n', 'pytest/__main__.py': 'x\n' }, {
      excluded: [['pytest/__init__.py', 'a new top-level module shadowing pytest, which the eval imports'], ['pytest/__main__.py', 'a new top-level module shadowing pytest, which the eval imports']], inspect: true }],
    ['a top-level module shadowing the standard library is excluded and flagged', { 'argparse.py': 'x\n' }, { excluded: [['argparse.py', 'a new top-level module shadowing argparse, which the eval imports']], inspect: true }],
    ['a new top-level module of the arm\'s own crosses', { 'tinylib_extra.py': 'x\n' }, { copy: ['tinylib_extra.py'] }],
    ['a link out of the workdir is excluded', { 'tinylib/data': { mode: '120000', oid: 'f'.repeat(40), target: '../../etc' } }, { excluded: [['tinylib/data', 'a link out of the workdir']] }],
    ['a deleted source file is removed; a deleted test is the reference\'s', { 'tinylib/gone.py': undefined, 'tests/test_gone.py': undefined }, {
      remove: ['tinylib/gone.py'], excluded: [['tests/test_gone.py', "deleted: a test: the reference's is kept"]] }],
  ];
  for (const [name, change, want] of cases) {
    const final = { ...base, ...change };
    for (const [p, v] of Object.entries(change)) if (v === undefined) delete final[p];
    const got = L.selectScoredFiles({ lib: lib(), base: manifestOf(base), final: manifestOf(final), stdlib: ['argparse', 'os'] });
    assert.deepEqual(got.copy, want.copy ?? [], name);
    assert.deepEqual(got.remove, want.remove ?? [], name);
    assert.deepEqual(got.excluded.map((e) => [e.path, e.reason]), want.excluded ?? [], name);
    assert.equal(got.needsInspection.length > 0, Boolean(want.inspect), name);
  }
  assert.deepEqual(L.selectScoredFiles({ lib: lib(), base: manifestOf(base), final: manifestOf(unchanged(...Object.keys(base))) }), { copy: [], remove: [], excluded: [], needsInspection: [] });
  // A src layout's editable install puts src/ on sys.path too.
  const src = L.selectScoredFiles({ lib: lib({ srcDir: 'src/calc' }), base: new Map(), final: manifestOf({ 'src/pytest.py': 'x\n', 'src/calc/x.py': 'x\n' }) });
  assert.deepEqual([src.copy, src.excluded.map((e) => e.path)], [['src/calc/x.py'], ['src/pytest.py']]);
  // networkx's shape: testDir is srcDir, and pytest collects *_test.py.
  const nx = lib({ srcDir: 'networkx/', testDir: 'networkx/' });
  const n = L.selectScoredFiles({ lib: nx, base: new Map(), final: manifestOf({ 'networkx/algorithms/easy_test.py': 'x\n', 'networkx/algorithms/tests/test_c.py': 'x\n', 'networkx/algorithms/cycles.py': 'x\n', 'networkx/testing/__init__.py': 'x\n' }) });
  assert.deepEqual(n.copy, ['networkx/algorithms/cycles.py', 'networkx/testing/__init__.py']);
});

test('treeManifest hashes the arm\'s files as git does, so an untouched file stays and only real changes cross', { skip: !(hasGit && process.platform !== 'win32') && 'needs git, sh and symlinks' }, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-')));
  try {
    const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
    const put = (p, text = 'x\n', mode = 0o644) => {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), text, { mode });
    };
    g('init', '-q', '-b', 'commit0-base');
    put('tinylib/__init__.py'); put('tinylib/run.sh', '#!/bin/sh\n', 0o755); put('tests/test_a.py'); put('setup.cfg', '[metadata]\n');
    fs.symlinkSync('__init__.py', path.join(dir, 'tinylib', 'alias.py'));
    g('add', '-A'); g('commit', '-qm', 'base');
    const base = L.parseLsTree(g('ls-tree', '-r', '-z', 'HEAD'));
    assert.deepEqual(L.selectScoredFiles({ lib: lib(), base, final: L.treeManifest(dir) }).copy, [], 'every unchanged file, mode and link hashes as git\'s');
    put('tinylib/__init__.py', 'def f(): return 1\n');
    fs.chmodSync(path.join(dir, 'tinylib', 'run.sh'), 0o644);
    put('setup.cfg', '[tool:pytest]\naddopts = -p evil\n');
    put('.venv/lib/site-packages/pkg/conftest.py');
    put('.ordewell/worktrees/t1/tinylib/x.py');
    put('tinylib/__pycache__/core.cpython-312.pyc');
    put('tinylib/core.pyc'); put('tinylib/_ext.so'); put('vendor/x/.git/config');
    const got = L.selectScoredFiles({ lib: lib(), base, final: L.treeManifest(dir) });
    assert.deepEqual(got.copy, ['tinylib/__init__.py', 'tinylib/run.sh']);
    assert.deepEqual(got.excluded.map((e) => e.path).sort(), ['.git', '.ordewell', '.venv', 'setup.cfg', 'tinylib/__pycache__', 'tinylib/_ext.so', 'tinylib/core.pyc', 'vendor/x/.git']);
    assert.deepEqual(got.needsInspection, ["setup.cfg: test configuration: the reference's is kept whole"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the eval box must flatten to the tree the arm\'s box did, or nothing is scored', async () => {
  assert.equal(L.judgeFreshTree({ armTree: 'abc', freshTree: 'abc' }).ok, true);
  assert.equal(L.judgeFreshTree({ armTree: 'abc', freshTree: 'abd' }).ok, false);
  assert.equal(L.judgeFreshTree({ armTree: null, freshTree: null }).ok, false, 'an arm box whose tree was never recorded proves nothing');
  const calls = [];
  const io = {
    prepare: async () => ({ tree: 'other', lsTree: '', stdlib: [] }),
    manifest: async () => { calls.push('manifest'); return new Map(); },
    remove: async () => calls.push('remove'), put: async () => calls.push('put'), patch: async () => calls.push('patch'),
    evaluate: async () => { calls.push('evaluate'); return { passed: 1 }; },
  };
  const r = await L.scoreFiles({ lib: lib(), dir: '/arm', armTree: 'abc' }, io);
  assert.equal(r.treeCheck.ok, false);
  assert.equal(r.tests, null);
  assert.deepEqual(calls, [], 'no file crosses and no eval runs on a different base');
});

test('both arms go through one scoring path, from their files to the eval', async () => {
  const base = [`100644 blob ${'1'.repeat(40)}\ttinylib/core.py`, `100644 blob ${'2'.repeat(40)}\ttests/test_core.py`, ''].join('\0');
  const run = async (arm) => {
    const calls = [];
    const io = {
      prepare: async () => { calls.push(['prepare']); return { tree: 't1', lsTree: base, stdlib: [] }; },
      manifest: async (dir, algo) => {
        calls.push(['manifest', algo]);
        return new Map([['tinylib/core.py', { mode: '100644', oid: '3'.repeat(40) }], ['tests/test_core.py', { mode: '100644', oid: '4'.repeat(40) }]]);
      },
      remove: async (paths) => calls.push(['remove', paths]),
      put: async (dir, paths) => calls.push(['put', paths]),
      patch: async (paths) => calls.push(['patch', paths]),
      evaluate: async () => { calls.push(['evaluate']); return { passed: 2 }; },
    };
    const r = await L.scoreFiles({ lib: lib(), dir: `/runs/${arm}`, armTree: 't1' }, io);
    return { calls, r };
  };
  const a = await run('A');
  const b = await run('B');
  assert.deepEqual(a, b);
  assert.deepEqual(a.calls.map((c) => c[0]), ['prepare', 'manifest', 'remove', 'put', 'patch', 'evaluate']);
  assert.deepEqual(a.r.copied, ['tinylib/core.py']);
  assert.deepEqual(a.r.excluded, [{ path: 'tests/test_core.py', reason: "a test: the reference's is kept" }]);
  assert.equal(a.r.evalBox, 'fresh');
  // The driver itself: one call, no arm in it, and nothing scored in the arm's box.
  const drive = fs.readFileSync(path.join(here, 'drive.mjs'), 'utf8');
  assert.equal(drive.match(/L\.scoreFiles\(/g)?.length, 1, 'drive.mjs scores through L.scoreFiles exactly once');
  assert.doesNotMatch(drive, /L\.scoreFiles\([^)]*\barm\b/, 'the scoring call takes no arm');
  assert.equal(drive.match(/L\.evalCommand\(/g)?.length, 1, 'one evaluate builds the eval command, for the baseline and the eval box alike');
});

// wentingzhao/sphinx:v0 keeps uv's editable build of the stubs at
// /root/.cache/uv/sdists-v4/editable/<hash>/<dir>/sphinx-8.1.0-py3-none-any.whl:
// six entries, a .pth and the dist-info, no module. dnspython:v0's has the same shape.
test('the leak probe passes uv\'s source-free editable wheel and flags one that carries the modules', { skip: !(hasPython && process.platform !== 'win32') && 'needs python3' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-'));
  try {
    const editable = (name) => path.join(dir, 'root', '.cache', 'uv', 'sdists-v4', 'editable', 'a005330d8cf01d63', name, 'tinylib-1.0-py3-none-any.whl');
    const wheel = (file, entries) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      execFileSync('python3', ['-I', '-c', 'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z:\n    for n in sys.argv[2:]: z.writestr(n, "x")', file, ...entries]);
    };
    const metadataOnly = editable('WxPEn39bGyV-DryTz_dg9');
    wheel(metadataOnly, ['tinylib.pth', ...['entry_points.txt', 'LICENSE.rst', 'WHEEL', 'METADATA', 'RECORD'].map((n) => `tinylib-1.0.dist-info/${n}`)]);
    const withSource = editable('HYyzHJmJ7LCTKp_cKXSsX');
    wheel(withSource, ['tinylib/__init__.py', 'tinylib/core.py', 'tinylib-1.0.dist-info/RECORD']);
    const workdir = path.join(dir, 'testbed');
    fs.mkdirSync(workdir);
    const out = execFileSync('python3', ['-c', L.LEAK_PROBE_PY, workdir, 'tinylib', 'tinylib', '-', dir], { cwd: '/', encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out.trim().split('\n').pop()).archives, [withSource]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Task #203: the bootstrap links the image's .venv into the task worktree, the
// agent's own `git add -A` committed the link, and the merge turned
// /testbed/.venv into a link to itself, so the eval could not start.
test('an arm that commits the .venv link brings it into neither the patch nor the eval', { skip: !(hasGit && process.platform !== 'win32') && 'needs git, sh and symlinks' }, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-')));
  const ws = path.join(dir, 'testbed');
  const wt = path.join(dir, 'task');
  try {
    const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
    fs.mkdirSync(path.join(ws, 'tinylib'), { recursive: true });
    g(ws, 'init', '-q', '-b', 'commit0-base');
    fs.writeFileSync(path.join(ws, 'tinylib', '__init__.py'), 'def f():\n    raise NotImplementedError\n');
    g(ws, 'add', '-A'); g(ws, 'commit', '-qm', 'Commit0 base');
    fs.mkdirSync(path.join(ws, '.venv', 'bin'), { recursive: true });
    const l = lib({ workdir: ws, baseCommit: g(ws, 'rev-parse', 'HEAD') });
    l.flatCommit = g(ws, 'rev-parse', 'HEAD');
    execFileSync('sh', ['-c', L.workspaceIgnoreScript(l)], { encoding: 'utf8' });
    const base = L.parseLsTree(g(ws, 'ls-tree', '-r', '-z', 'HEAD'));

    g(ws, 'worktree', 'add', '-q', '-b', 'task', wt);
    fs.symlinkSync(path.join(ws, '.venv'), path.join(wt, '.venv'));
    fs.writeFileSync(path.join(wt, 'tinylib', '__init__.py'), 'def f():\n    return 1\n');
    fs.writeFileSync(path.join(wt, '.gitignore'), 'tinylib/new.py\n');
    fs.writeFileSync(path.join(wt, 'tinylib', 'new.py'), 'X = 2\n');
    g(wt, 'add', '-A'); g(wt, 'commit', '-qm', 'the agent commits everything');
    const sel = L.selectScoredFiles({ lib: l, base, final: L.treeManifest(wt) });
    assert.deepEqual(sel.copy, ['.gitignore', 'tinylib/__init__.py', 'tinylib/new.py']);
    assert.deepEqual(sel.excluded.map((e) => e.path), ['.git', '.venv'], 'the link never crosses');

    // In the eval box: the files put in, and the patch made of what crossed, the ignored new module included.
    for (const p of sel.copy) fs.copyFileSync(path.join(wt, p), path.join(ws, p));
    fs.mkdirSync(path.join(ws, '.ordewell'));
    fs.writeFileSync(path.join(ws, '.ordewell', 'session.json'), '{}\n');
    const patch = execFileSync('sh', ['-c', L.armPatchScript(l)], { cwd: ws, input: `${sel.copy.join('\0')}\0`, encoding: 'utf8' });
    assert.match(patch, /\+ {4}return 1/);
    assert.match(patch, /\+X = 2/);
    assert.doesNotMatch(patch, /\.venv|\.ordewell/);
    assert.equal(execFileSync('sh', ['-c', L.armPatchScript(l)], { cwd: ws, input: '', encoding: 'utf8' }).includes('return 1'), true, 'nothing copied: the patch still runs');
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

test('a test is told from the arm\'s work when testDir lies inside the source', () => {
  const networkx = lib({ srcDir: 'networkx/', testDir: 'networkx/' });
  assert.equal(L.isTestPath(networkx, 'networkx/algorithms/tests/test_cycles.py'), true);
  assert.equal(L.isTestPath(networkx, 'networkx/algorithms/tests/__init__.py'), true);
  assert.equal(L.isTestPath(networkx, 'networkx/algorithms/easy_test.py'), true, 'pytest collects *_test.py');
  assert.equal(L.isTestPath(networkx, 'networkx/algorithms/cycles.py'), false, 'the arm\'s work');
  assert.equal(L.isTestPath(networkx, 'networkx/testing/__init__.py'), false);
  assert.equal(L.isTestPath(networkx, 'docs/tests/test_x.py'), false, 'outside testDir');
  const tlslite = lib({ srcDir: 'tlslite/', testDir: 'unit_tests/' });
  assert.equal(L.isTestPath(tlslite, 'unit_tests/mocksock.py'), true, 'a helper in unit_tests/ is a test file');
  assert.equal(L.isTestPath(tlslite, 'tlslite/utils/cryptomath.py'), false);
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

test('the eval command bounds each test as well as the whole run', () => {
  // tlslite-ng's stubbed Parser.atLengthCheck returns None, so test_atLengthCheck's
  // `while not p.atLengthCheck()` spun until the run's 1800 s killed every count with it.
  const cmd = L.evalCommand(lib({ testCmd: '/testbed/.venv/bin/python -m pytest' }));
  assert.match(cmd, /^timeout 1800 /, 'the run keeps its overall limit');
  assert.match(cmd, / '-p' 'commit0_test_timeout' /, 'the per-test timeout plugin is loaded');
  assert.match(cmd, / '--commit0-test-timeout=120' /, 'each test is bounded');
  assert.match(cmd, /PYTHONPATH='\/opt\/commit0-bench'\$\{PYTHONPATH:\+:\$PYTHONPATH\} \/testbed\/\.venv\/bin\/python -m pytest /, 'the plugin is importable, the image\'s own path kept');
  assert.match(cmd, / '--continue-on-collection-errors' .* '-m' 'not network' '-p' 'no:cacheprovider' 'tests'$/);
});

const pytestPython = process.env.ORDEWELL_PYTEST_PYTHON ?? 'python3';
const hasPytest = (() => { try { execFileSync(pytestPython, ['-c', 'import pytest'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('the timeout plugin fails a spinning test and the run goes on', { skip: !(hasPytest && process.platform !== 'win32') && `needs ${pytestPython} with pytest (ORDEWELL_PYTEST_PYTHON names another), and SIGALRM` }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-timeout-'));
  try {
    fs.mkdirSync(path.join(dir, 'plugin'));
    fs.writeFileSync(path.join(dir, 'plugin', `${L.TEST_TIMEOUT_PLUGIN}.py`), L.TEST_TIMEOUT_PLUGIN_PY);
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(path.join(dir, 'tests', 'test_spin.py'), [
      'def test_spins():',
      '    while True:',
      '        pass',
      '',
      'def test_swallows_exceptions():',
      '    while True:',
      '        try:',
      '            pass',
      '        except Exception:',
      '            pass',
      '',
      'def test_passes():',
      '    assert 1 + 1 == 2',
      '',
    ].join('\n'));
    let out;
    try {
      out = execFileSync(pytestPython, ['-m', 'pytest', '-p', L.TEST_TIMEOUT_PLUGIN, '--commit0-test-timeout=1', '-q', '-rN', '-p', 'no:cacheprovider', 'tests'],
        { cwd: dir, env: { ...process.env, PYTHONPATH: path.join(dir, 'plugin') }, encoding: 'utf8', timeout: 60_000 });
    } catch (err) {
      out = `${err.stdout}${err.stderr}`;
    }
    const summary = L.parsePytestSummary(out);
    assert.deepEqual({ passed: summary?.passed, failed: summary?.failed, errors: summary?.errors }, { passed: 1, failed: 2, errors: 0 }, out);
    assert.match(out, /Commit0TestTimeout: the test ran past 1s/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that fails to collect is an error of its own, and the other files still score', () => {
  assert.ok(L.EVAL_PYTEST_FLAGS.includes('--continue-on-collection-errors'), 'the eval must keep going past a broken file');
  const out = [
    '=================================== ERRORS ====================================',
    '____________________ ERROR collecting tests/test_bad.py ______________________',
    "ImportError while importing test module '/testbed/tests/test_bad.py'.",
    'E   ModuleNotFoundError: No module named "nope"',
    '=========================== short test summary info ============================',
    'ERROR tests/test_bad.py',
    '!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!',
    '========================= 7 passed, 1 error in 0.40s ==========================',
  ].join('\n');
  const r = L.parseEvaluation(1, out);
  assert.equal(r.passed, 7, 'the library is not zeroed for one file');
  assert.equal(r.errors, 1);
  assert.deepEqual(r.collectionErrors, ['tests/test_bad.py']);
  assert.deepEqual(L.parseEvaluation(1, '== 3 passed, 2 failed in 0.4s ==').collectionErrors, []);
});

test('lockKey removes a lock whose pid is dead, logs it, and keeps one whose pid is alive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-lock-'));
  const lines = [];
  try {
    const dead = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    fs.writeFileSync(path.join(dir, 'key.lock'), `${dead}\n`);
    const release = L.lockKey(dir, { log: (m) => lines.push(m) });
    assert.equal(fs.readFileSync(path.join(dir, 'key.lock'), 'utf8').trim(), String(process.pid), 'the lock is ours now');
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`stale.*${dead}`));
    assert.throws(() => L.lockKey(dir, { log: () => {} }), /held/, 'our own live pid holds it');
    release();
    assert.equal(fs.existsSync(path.join(dir, 'key.lock')), false);
    fs.writeFileSync(path.join(dir, 'key.lock'), 'not a pid\n');
    assert.throws(() => L.lockKey(dir, { log: () => {} }), /held/, 'a lock that names no pid is not removed on a guess');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a run that ends blocked or at its cap is marked truncated, judged by its tasks and never by run\'s exit (D5)', () => {
  const done = { tasks: [{ status: 'completed' }] };
  assert.deepEqual(L.judgeLanding({ stopped: null, plan: done }), { truncated: false, why: null });
  assert.deepEqual(L.judgeLanding({ stopped: null, plan: done, runExit: 1 }), { truncated: false, why: null }, 'a non-zero exit with every task done is not truncated');
  assert.deepEqual(L.judgeLanding({ stopped: { why: 'spend' }, plan: done }), { truncated: true, why: 'cap: spend' });
  assert.deepEqual(L.judgeLanding({ stopped: { why: 'wall-clock' }, plan: null }), { truncated: true, why: 'cap: wall-clock' });
  assert.deepEqual(L.judgeLanding({ stopped: null, stalled: { waiting: 'checkpoint' }, plan: done }), { truncated: true, why: 'stalled: waiting on checkpoint' });
  assert.deepEqual(L.judgeLanding({ stopped: null, plan: { tasks: [{ status: 'failed' }] } }), { truncated: true, why: 'blocked: 1 task not completed' });
  assert.deepEqual(L.judgeLanding({ stopped: null, plan: { tasks: [{ status: 'awaiting_user' }] } }), { truncated: true, why: 'blocked: 1 task not completed' });
  assert.deepEqual(L.judgeLanding({ stopped: null, plan: { tasks: [{ status: 'completed', subtasks: [{ status: 'failed' }] }] } }), { truncated: true, why: 'blocked: 1 task not completed' }, 'an open subtask leaves its task open');
  assert.deepEqual(L.judgeLanding({ stopped: null, plan: null }), { truncated: true, why: 'blocked: no plan to read' });
  const rec = L.resultRecord({
    lib: lib(), arm: L.ARMS.A, window: L.judgeWindow({ listed: 1048576, snapshot: 1048576 }), ordewell: { sha: 'abc', containsPr177: true },
    egress: { ok: true }, leak: { ok: true }, network: { collected: 9, deselected: 2 }, tests: null, truncated: { truncated: true, why: 'cap: spend' },
    dryRun: false, startedAt: 'a', endedAt: 'b',
  });
  assert.deepEqual(rec.truncated, { truncated: true, why: 'cap: spend' });
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
  const t = (o = {}) => ({ title: 't', type: 'ai', assignedRunner: L.RUNNER, assignedModel: { modelId: L.MODEL_ID }, taskMode: 'full', ...o });
  const build = L.judgePlan({ tasks: [t({ taskMode: 'build' })] });
  assert.equal(build.ok, false);
  assert.match(build.failures[0], /mode build, which the built-in runner does not have/);
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

test('the runner is the built-in runner\'s on the protocol\'s provider, as core names it, not the legacy id', () => {
  // ADR-0070: one built-in runner per provider, under the provider's id, for a provider whose models can be listed.
  const runners = fs.readFileSync(path.join(repo, 'packages', 'core', 'src', 'services', 'providerRunners.ts'), 'utf8');
  const providers = fs.readFileSync(path.join(repo, 'packages', 'core', 'src', 'services', 'apiProviders.ts'), 'utf8');
  assert.match(runners, /PROVIDER_RUNNER_IDS: readonly AiProvider\[\] = PROVIDER_PRIORITY\.filter\(\(provider\) => VENDORS\[provider\]\.discoversModels\)/);
  const registration = providers.match(new RegExp(`\\n  ${L.PROVIDER}: \\{\\n[\\s\\S]*?\\n  \\},`))?.[0];
  assert.ok(registration, `apiProviders.ts registers ${L.PROVIDER}`);
  assert.match(registration, new RegExp(`id: '${L.PROVIDER}'`));
  assert.match(registration, /discoversModels: true/);
  const legacy = runners.match(/export const LEGACY_BUILTIN_RUNNER = '([^']+)'/)?.[1];
  assert.equal(legacy, 'ordewell');
  assert.equal(L.RUNNER, 'openrouter');
  assert.notEqual(L.RUNNER, legacy);

  const t = (o = {}) => ({ title: 't', type: 'ai', assignedRunner: L.RUNNER, assignedModel: { modelId: L.MODEL_ID }, taskMode: 'full', ...o });
  assert.equal(L.judgePlan({ tasks: [t()] }).ok, true);
  const old = L.judgePlan({ tasks: [t({ assignedRunner: legacy })] });
  assert.equal(old.ok, false);
  assert.match(old.failures[0], /runs on ordewell, not openrouter/);

  assert.deepEqual(L.boxSettings(L.ARMS.A).enabledRunners, [L.RUNNER]);
  assert.deepEqual(L.boxSettings(L.ARMS.B).modelAllowlist, { [L.RUNNER]: [L.MODEL_ID] });
  assert.match(L.ARM_A_PLAN_JS, /assignedRunner: 'openrouter'/);
  assert.match(L.ARM_A_PLAN_JS, /runners: \['openrouter'\]/);
  assert.doesNotMatch(L.ARM_A_PLAN_JS, /'ordewell'/);
  const [plan] = L.armCommands(L.ARMS.B, { workspace: '/testbed', goal: 'g' });
  assert.deepEqual(plan.slice(4, 6), ['--runner', 'openrouter']);
  assert.doesNotMatch(fs.readFileSync(path.join(here, 'drive.mjs'), 'utf8'), /'--runner', 'ordewell'/);
});

test('judgePlan holds every AI task, subtasks too, to the runner and the model', () => {
  const t = (o = {}) => ({ title: 't', type: 'ai', assignedRunner: L.RUNNER, assignedModel: { modelId: L.MODEL_ID }, taskMode: 'full', ...o });
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
  assert.deepEqual(r.tests, { passed: 7, collected: 9, failed: 2, errors: 0, skipped: 0, collectionErrors: [], exit: 1, timedOut: false });
  assert.equal(r.networkDeselected, 2);
  assert.equal(r.billedUsd, 1.5);
  assert.equal(r.capUsd, L.CAP_USD);
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

// --- A sound single run (task #219) -----------------------------------------

test('the settings keys are core\'s own: supervisorLevel, mergeAtGatesAutomatically, autorun', () => {
  const defaults = ['runSettingsDefaults.ts', 'SettingsService.ts'].map((f) => fs.readFileSync(path.join(repo, 'packages', 'core', 'src', 'services', f), 'utf8')).join('\n');
  for (const key of ['supervisorLevel', 'mergeAtGatesAutomatically', 'autorun', 'autonomousMode', 'enabledRunners', 'modelAllowlist', 'ordewellStepLimit']) {
    assert.match(defaults, new RegExp(`\\n  ${key}\\??: `), `${key} is a run setting`);
  }
  assert.match(fs.readFileSync(path.join(repo, 'packages', 'cli', 'src', 'commands', 'parallel.ts'), 'utf8'), /ORDEWELL_MAX_PARALLEL/);
});

test('arm A runs alone with the supervisor off (D2), arm B as its user runs it at Act (D3)', () => {
  const a = L.boxSettings(L.ARMS.A);
  const b = L.boxSettings(L.ARMS.B);
  assert.deepEqual([a.supervisorLevel, a.autorun, a.mergeAtGatesAutomatically], ['off', false, false]);
  assert.deepEqual([b.supervisorLevel, b.autorun, b.mergeAtGatesAutomatically], ['act', true, true]);
  for (const s of [a, b]) assert.deepEqual([s.autonomousMode, s.ordewellStepLimit], [true, L.STEP_LIMIT]);
  const opts = L.parseArgs(['--dry-run', '--libs', 'x', '--parallel', '3', '--cpus', '2', '--memory', '4g', '--cap-usd', '1.5']);
  const recA = L.armSettings(L.ARMS.A, opts);
  const recB = L.armSettings(L.ARMS.B, opts);
  assert.deepEqual(recA, { supervisorLevel: 'off', autorun: false, automerge: false, parallel: 1, cpus: 2, memory: '4g', capUsd: 1.5, wallCapMs: L.WALL_CAP_MS });
  assert.deepEqual(recB, { supervisorLevel: 'act', autorun: true, automerge: true, parallel: 3, cpus: 2, memory: '4g', capUsd: 1.5, wallCapMs: L.WALL_CAP_MS });
  assert.equal(L.boxSettings(L.ARMS.B, recB).supervisorLevel, 'act');
});

test('the box runs under its quota (D4), with the parallel limit and its driver named', () => {
  const args = L.boxRunArgs({ cpus: 8, memory: '12g', parallel: 8, driver: 'host/123' });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('--cpus'), '8');
  assert.equal(at('--memory'), '12g');
  assert.equal(at('--memory-swap'), '12g', 'no swap beyond the quota');
  assert.ok(args.includes(`${L.DRIVER_LABEL}=host/123`));
  assert.ok(args.includes('ORDEWELL_MAX_PARALLEL=8'));
  assert.match(L.driverId(), new RegExp(`/${process.pid}$`));
  assert.deepEqual(L.parseDriver('host/123'), { host: 'host', pid: 123 });
  assert.equal(L.parseDriver('nonsense'), null);
  // The dry run compares the engine's figure with this, so it must read sizes as docker does.
  assert.equal(L.dockerBytes('12g'), 12 * 1024 ** 3);
  assert.equal(L.dockerBytes('512m'), 512 * 1024 ** 2);
  assert.equal(L.dockerBytes('1.5G'), 1.5 * 1024 ** 3);
  assert.equal(L.dockerBytes('100'), 100);
  assert.equal(L.dockerBytes('12t'), null);
});

test('the options and their defaults', () => {
  const o = L.parseArgs(['--dry-run', '--libs', 'x']);
  assert.deepEqual(
    [o.capUsd, o.parallel, o.cpus, o.memory, o.stallMin, o.ordewellRoot, o.allowStaleDist, o.sweep],
    [8, 8, 8, '12g', 15, null, false, false],
  );
  const s = L.parseArgs(['--sweep']);
  assert.equal(s.sweep, true, '--sweep needs neither --dry-run nor --run');
  assert.throws(() => L.parseArgs(['--dry-run', '--libs', 'x', '--cap-usd', '0']), /--cap-usd/);
  assert.throws(() => L.parseArgs(['--dry-run', '--libs', 'x', '--parallel', '1.5']), /--parallel/);
  assert.throws(() => L.parseArgs(['--dry-run', '--libs', 'x', '--memory', 'lots']), /--memory/);
  assert.throws(() => L.parseArgs(['--dry-run', '--libs', 'x', '--stall-min', '-1']), /--stall-min/);
  const r = L.parseArgs(['--dry-run', '--libs', 'x', '--ordewell-root', '/somewhere', '--allow-stale-dist', '--stall-min', '0.5']);
  assert.deepEqual([r.ordewellRoot, r.allowStaleDist, r.stallMin], [path.resolve('/somewhere'), true, 0.5]);
});

test('--sweep removes only what a dead driver on this host left', () => {
  const alive = new Set([10]);
  const items = [
    { kind: 'container', name: 'dead-box', driver: 'me/20' },
    { kind: 'network', name: 'dead-net', driver: 'me/20' },
    { kind: 'container', name: 'live-box', driver: 'me/10' },
    { kind: 'container', name: 'other-host', driver: 'them/20' },
    { kind: 'container', name: 'unnamed', driver: null },
  ];
  const { remove, keep } = L.sweepTargets(items, { host: 'me', isAlive: (pid) => alive.has(pid) });
  assert.deepEqual(remove.map((i) => i.name), ['dead-box', 'dead-net']);
  assert.deepEqual(keep.map((i) => [i.name, i.why]), [
    ['live-box', 'its driver, pid 10, is running'],
    ['other-host', 'its driver ran on them'],
    ['unnamed', 'it names no driver'],
  ]);
});

test('waitingOnPerson finds a task waiting on a checkpoint, an input, an approval or a user task, and none while an attempt runs', () => {
  const t = (o) => ({ id: o.id ?? 't', title: o.title ?? 'T', type: 'ai', ...o });
  assert.equal(L.waitingOnPerson({ tasks: [t({ status: 'awaiting_user', awaitingReason: 'checkpoint' }), t({ id: 'u', status: 'in_progress' })] }), null, 'an attempt running is not a stall');
  assert.deepEqual(L.waitingOnPerson({ tasks: [t({ status: 'awaiting_user', awaitingReason: 'checkpoint', parkedQuestion: 'ok?' })] }), { task: { id: 't', title: 'T' }, waiting: 'checkpoint', question: 'ok?' });
  assert.equal(L.waitingOnPerson({ tasks: [t({ status: 'awaiting_user', awaitingReason: 'input' })] }).waiting, 'input');
  // core's waitsForApproval (Task.ts): an approved plan's task outside its approval record.
  assert.equal(L.waitingOnPerson({ approved: true, approvedTasks: [], tasks: [t({ status: 'pending' })] }).waiting, 'approval');
  assert.equal(L.waitingOnPerson({ approved: true, approvedTasks: ['t'], tasks: [t({ status: 'pending' })] }), null, 'already approved');
  assert.equal(L.waitingOnPerson({ approved: false, tasks: [t({ status: 'pending' })] }), null, 'a plan never approved singles nothing out');
  // A user task needs no approval, but nobody in the bench does it: the run waits on it.
  assert.equal(L.waitingOnPerson({ approved: true, tasks: [t({ status: 'pending', type: 'user' })] }).waiting, 'user-task');
  assert.equal(L.waitingOnPerson({ approved: true, tasks: [t({ status: 'completed', type: 'user' })] }), null, 'a user task done');
  assert.equal(L.waitingOnPerson({ approved: false, tasks: [t({ status: 'pending', type: 'user' })] }), null, 'a plan never approved runs nothing');
  assert.equal(L.waitingOnPerson({ tasks: [t({ status: 'awaiting_user', awaitingReason: 'usage-limit' })] }), null, 'a usage limit waits on the clock');
  assert.equal(L.waitingOnPerson({ tasks: [t({ status: 'completed', subtasks: [t({ id: 's', status: 'awaiting_user', awaitingReason: 'input' })] })] }).task.id, 's');
  assert.equal(L.waitingOnPerson(null), null);
});

test('stallDecision stalls after --stall-min of waiting on a person, and resets when work runs', () => {
  const waiting = { tasks: [{ id: 't', title: 'T', status: 'awaiting_user', awaitingReason: 'checkpoint', parkedQuestion: 'q' }] };
  const running = { tasks: [{ id: 't', title: 'T', status: 'in_progress' }] };
  const stallMs = 15 * 60_000;
  let d = L.stallDecision({ plan: waiting, nowMs: 1000, sinceMs: null, stallMs });
  assert.deepEqual(d, { sinceMs: 1000, stalled: null });
  d = L.stallDecision({ plan: waiting, nowMs: 1000 + stallMs - 1, sinceMs: d.sinceMs, stallMs });
  assert.equal(d.stalled, null);
  d = L.stallDecision({ plan: waiting, nowMs: 1000 + stallMs, sinceMs: d.sinceMs, stallMs });
  assert.deepEqual(d.stalled, { task: { id: 't', title: 'T' }, waiting: 'checkpoint', question: 'q', sinceMs: stallMs });
  assert.deepEqual(L.stallDecision({ plan: running, nowMs: 1e9, sinceMs: 1000, stallMs }), { sinceMs: null, stalled: null });
});

test('settleDecision ends a run once no attempt runs, no person is waited on and nothing moved for the settle time', () => {
  const settleMs = 60_000;
  const done = { tasks: [{ id: 'a', status: 'completed', attempted: true }, { id: 'b', status: 'failed', attempted: true }] };
  const unstarted = { tasks: [{ id: 'a', status: 'pending' }] };
  const running = { tasks: [{ id: 'a', status: 'in_progress', attempted: true }] };
  assert.equal(L.settleDecision({ plan: unstarted, fingerprint: 'x', nowMs: 1e9, state: { fingerprint: 'x', sinceMs: 0 }, settleMs }).settled, false, 'a run that never started has not settled');
  assert.equal(L.settleDecision({ plan: running, fingerprint: 'x', nowMs: 1e9, state: { fingerprint: 'x', sinceMs: 0 }, settleMs }).settled, false);
  let d = L.settleDecision({ plan: done, fingerprint: 'x', nowMs: 0, state: null, settleMs });
  assert.equal(d.settled, false);
  d = L.settleDecision({ plan: done, fingerprint: 'y', nowMs: settleMs, state: d.state, settleMs });
  assert.equal(d.settled, false, 'the supervisor moved something: the clock restarts');
  d = L.settleDecision({ plan: done, fingerprint: 'y', nowMs: 2 * settleMs, state: d.state, settleMs });
  assert.equal(d.settled, true);
  assert.equal(L.planFingerprint(done, 3), L.planFingerprint(structuredClone(done), 3));
  assert.notEqual(L.planFingerprint(done, 3), L.planFingerprint(done, 4), 'a model call moves it');
});

test('choosePatches takes each task\'s own worktree, never the integration one, then its preserved branch', () => {
  const runRoot = '/testbed/.ordewell/worktrees/r1';
  const plan = {
    isolation: {
      run: { id: 'r1', workspaceRoot: '/testbed', repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration' }] },
      tasks: {
        a: { taskId: 'a', order: 1, branch: 'ordewell/r1/1-a', workspace: `${runRoot}/1-a`, status: 'kept', repos: { '.': { worktree: `${runRoot}/1-a` } } },
        b: { taskId: 'b', order: 2, branch: 'ordewell/r1/2-b', workspace: `${runRoot}/2-b`, status: 'kept', repos: { '.': { worktree: `${runRoot}/2-b` } } },
        c: { taskId: 'c', order: 3, branch: 'ordewell/r1/3-c', workspace: `${runRoot}/3-c`, status: 'merged', repos: { '.': {} } },
        d: { taskId: 'd', order: 4, branch: 'ordewell/r1/4-d', workspace: `${runRoot}/integration`, status: 'active', repos: { '.': { worktree: `${runRoot}/integration` } } },
      },
    },
    tasks: [
      { id: 'a', order: 1, title: 'A', type: 'ai', status: 'failed' },
      { id: 'b', order: 2, title: 'B', type: 'ai', status: 'awaiting_user' },
      { id: 'c', order: 3, title: 'C', type: 'ai', status: 'completed' },
      { id: 'd', order: 4, title: 'D', type: 'ai', status: 'completed', subtasks: [{ id: 'd1', status: 'failed' }] },
      { id: 's', order: 5, title: 'S', type: 'script', status: 'failed' },
    ],
  };
  const worktrees = [
    { path: '/testbed', branch: 'commit0-base' },
    { path: `${runRoot}/integration`, branch: 'ordewell/r1/integration' },
    { path: `${runRoot}/1-a`, branch: 'ordewell/r1/1-a' },
  ];
  const branches = ['commit0-base', 'ordewell/r1/integration', 'ordewell-preserved/r1/2-b', 'ordewell-preserved/r1/2-b-2', 'ordewell/r1/4-d'];
  const got = L.choosePatches({ plan, worktrees, branches });
  assert.deepEqual(got.map((p) => [p.taskId, p.landed, p.source]), [
    ['a', false, { kind: 'worktree', path: `${runRoot}/1-a` }],
    ['b', false, { kind: 'branch', ref: 'ordewell-preserved/r1/2-b-2' }],
    ['c', true, null],
    ['d', false, { kind: 'branch', ref: 'ordewell/r1/4-d' }],
  ], 'the newest preserved branch; an open subtask leaves its task unlanded; the integration worktree is never a source');
  assert.deepEqual(L.choosePatches({ plan: { tasks: [{ id: 'x', title: 'X', status: 'failed' }] }, worktrees, branches }).map((p) => p.source), [null]);
});

test('readGitLayout reads a copied repository\'s worktrees and branches from its files, running no git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-'));
  try {
    const put = (p, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), text);
    };
    const sha = (c) => c.repeat(40);
    put('.git/HEAD', 'ref: refs/heads/commit0-base\n');
    put('.git/packed-refs', `# pack-refs with: peeled fully-peeled sorted\n${sha('a')} refs/heads/commit0-base\n${sha('b')} refs/heads/ordewell-preserved/r1/2-b\n^${sha('c')}\n`);
    put('.git/refs/heads/ordewell/r1/1-a', `${sha('d')}\n`);
    put('.git/refs/heads/ordewell-preserved/r1/2-b', `${sha('e')}\n`);
    put('.git/worktrees/1-a/gitdir', '/testbed/.ordewell/worktrees/r1/1-a/.git\n');
    put('.git/worktrees/1-a/HEAD', 'ref: refs/heads/ordewell/r1/1-a\n');
    put('.git/worktrees/gone/gitdir', '/testbed/.ordewell/worktrees/r1/gone/.git\n');
    put('.git/worktrees/gone/HEAD', `${sha('f')}\n`);
    put('.ordewell/worktrees/r1/1-a/.git', 'gitdir: /testbed/.git/worktrees/1-a\n');
    const got = L.readGitLayout(dir, '/testbed');
    assert.deepEqual(got.worktrees, [{ path: '/testbed', branch: 'commit0-base' }, { path: '/testbed/.ordewell/worktrees/r1/1-a', branch: 'ordewell/r1/1-a' }], 'a worktree gone from the copy is not listed');
    assert.deepEqual(Object.fromEntries(got.branches), { 'commit0-base': sha('a'), 'ordewell-preserved/r1/2-b': sha('e'), 'ordewell/r1/1-a': sha('d') }, 'a loose ref wins over its packed one');
    assert.equal(L.hostPathOf(dir, '/testbed', '/testbed/.ordewell/worktrees/r1/1-a'), path.join(dir, '.ordewell', 'worktrees', 'r1', '1-a'));
    assert.equal(L.hostPathOf(dir, '/testbed', '/etc'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the score\'s source per arm: A from its worktree when its task did not land (D2), B only from what merged (D3)', () => {
  const unlanded = [{ taskId: 'a', order: 1, landed: false, source: { kind: 'worktree', path: '/w/1-a' } }];
  assert.deepEqual(L.scoringPlan(L.ARMS.A, unlanded), { scoredFrom: 'task-worktree', apply: unlanded[0], diagnostic: [] });
  assert.deepEqual(L.scoringPlan(L.ARMS.A, [{ ...unlanded[0], source: null }]), { scoredFrom: 'merged', apply: null, diagnostic: [] }, 'no work to apply: the workspace as it is');
  assert.deepEqual(L.scoringPlan(L.ARMS.A, [{ ...unlanded[0], landed: true, source: null }]), { scoredFrom: 'merged', apply: null, diagnostic: [] });
  const b = [unlanded[0], { taskId: 'c', order: 3, landed: true, source: null }, { taskId: 'd', order: 4, landed: false, source: null }];
  assert.deepEqual(L.scoringPlan(L.ARMS.B, b), { scoredFrom: 'merged', apply: null, diagnostic: [unlanded[0]] });
});

test('distFreshness refuses a dist older than the newest tracked source, unless allowed', () => {
  const fresh = L.distFreshness({ dists: [{ path: 'packages/core/dist/index.js', mtimeMs: 200 }], sources: [{ path: 'packages/core/src/a.ts', mtimeMs: 100 }] });
  assert.deepEqual([fresh.ok, fresh.stale], [true, false]);
  const stale = L.distFreshness({ dists: [{ path: 'packages/core/dist/index.js', mtimeMs: 200 }, { path: 'packages/web/dist/x.js', mtimeMs: 50 }], sources: [{ path: 'packages/cli/src/b.ts', mtimeMs: 100 }] });
  assert.deepEqual([stale.ok, stale.stale], [false, true]);
  assert.match(stale.detail, /packages\/web\/dist\/x\.js is older than packages\/cli\/src\/b\.ts/);
  const allowed = L.distFreshness({ dists: [{ path: 'd', mtimeMs: 1 }], sources: [{ path: 's', mtimeMs: 2 }], allowStale: true });
  assert.deepEqual([allowed.ok, allowed.stale, allowed.allowed], [true, true, true]);
  assert.equal(L.distFreshness({ dists: [], sources: [] }).ok, false, 'no dist at all');
  assert.deepEqual(L.FRESHNESS_SOURCES, ['packages/core/src', 'packages/web/server', 'packages/cli/src']);
});

test('judgeValidity names every reason a result cannot be compared', () => {
  const ok = { ok: true };
  assert.deepEqual(L.judgeValidity({ aborted: null, checks: [ok], tests: { passed: 1, exit: 0, timedOut: false }, freshness: { stale: false } }), { valid: true, invalidReasons: [] });
  const v = L.judgeValidity({
    aborted: 'boom',
    checks: [{ ok: false, scope: 'x', name: 'egress' }, { ok: false, unverified: true, name: 'u' }, { ok: false, expectedFailure: true, name: 'e' }],
    tests: { exit: 124, timedOut: true },
    freshness: { stale: true, allowed: true },
  });
  assert.equal(v.valid, false);
  assert.deepEqual(v.invalidReasons, ['aborted: boom', 'failed check: x: egress', 'eval timed out', 'stale dist allowed']);
  assert.deepEqual(L.judgeValidity({ checks: [], tests: null, freshness: { stale: false } }).invalidReasons, ['eval gave no summary']);
  assert.deepEqual(L.judgeValidity({ checks: [], tests: null, freshness: { stale: false }, dryRun: true }).invalidReasons, ['dry run: no arm ran']);
});

test('the daemon must read back the arm\'s supervisor level, autorun, merging and parallel limit', () => {
  const b = L.armSettings(L.ARMS.B);
  const a = L.armSettings(L.ARMS.A);
  const reply = (run, maxParallel) => ({ status: 200, body: { run, maxParallel } });
  assert.equal(L.judgeSettingsReadback(b, reply({ supervisorLevel: 'act', autorun: true, mergeAtGatesAutomatically: true }, 8)).ok, true);
  assert.equal(L.judgeSettingsReadback(a, reply({ supervisorLevel: 'off', autorun: false, mergeAtGatesAutomatically: false }, 1)).ok, true);
  // The daemon's defaults, which the sweep's runs got: the supervisor at Watch and five at once.
  const defaults = L.judgeSettingsReadback(b, reply({ supervisorLevel: 'watch', autorun: false, mergeAtGatesAutomatically: false }, 5));
  assert.equal(defaults.ok, false);
  assert.equal(defaults.failures.length, 4);
  assert.match(defaults.failures[0], /supervisorLevel is "watch", not "act"/);
  assert.equal(L.judgeSettingsReadback(b, { error: 'no daemon token' }).ok, false);
  assert.equal(L.judgeSettingsReadback(b, { status: 401, body: {} }).ok, false);
  assert.match(L.SETTINGS_PROBE_JS, /\/api\/settings\?/);
});

test('a stub baseline that collects nothing is recorded as the library\'s, not a defect', () => {
  assert.deepEqual(L.baselineRecord({ passed: 0, failed: 0, errors: 0, collectionErrors: [], collectionError: 'ImportError while loading conftest x', exit: 4 }).baseline, { collected: 0, reason: 'ImportError while loading conftest x' });
  assert.deepEqual(L.baselineRecord({ passed: 0, failed: 0, errors: 0, skipped: 0, exit: 5 }).baseline, { collected: 0, reason: 'pytest collected no test' });
  assert.equal(L.baselineRecord({ passed: 0, failed: 9, errors: 0, exit: 1 }).baseline, null);
  assert.equal(L.baselineRecord(null).ok, false, 'no summary is still a failure');
  assert.equal(L.baselineRecord({ passed: 0, failed: 0, errors: 0, collectionError: 'x', exit: 4 }).ok, true);
});

test('resultRecord records the arm\'s settings, the eval exit, the stop, the stall, the source and the validity', () => {
  const settings = L.armSettings(L.ARMS.B, L.parseArgs(['--dry-run', '--libs', 'x']));
  const r = L.resultRecord({
    lib: lib(), arm: L.ARMS.B, settings, window: L.judgeWindow({ listed: 1048576, snapshot: 1048576 }), ordewell: { sha: 'abc', containsPr177: true, staleDistAllowed: false },
    egress: { ok: true }, leak: { ok: true }, network: { collected: 9, deselected: 2 }, tests: { passed: 1, collected: 2, failed: 1, errors: 0, skipped: 0, exit: 124, timedOut: true },
    stopped: { why: 'wall-clock' }, stalled: { waiting: 'input' }, scoredFrom: 'merged', patches: [{ file: 'arm.patch', source: null }],
    validity: { valid: false, invalidReasons: ['eval timed out'] }, baseline: { collected: 0, reason: 'r' }, dryRun: false, startedAt: 'a', endedAt: 'b',
  });
  for (const [k, v] of Object.entries({ supervisorLevel: 'act', autorun: true, automerge: true, parallel: 8, cpus: 8, memory: '12g', capUsd: 8, wallCapMs: L.WALL_CAP_MS })) assert.deepEqual(r[k], v, k);
  assert.deepEqual([r.tests.exit, r.tests.timedOut], [124, true]);
  assert.deepEqual(r.stopped, { why: 'wall-clock' });
  assert.deepEqual(r.stalled, { waiting: 'input' });
  assert.equal(r.scoredFrom, 'merged');
  assert.deepEqual(r.patches, [{ file: 'arm.patch', source: null }]);
  assert.deepEqual([r.valid, r.invalidReasons], [false, ['eval timed out']]);
  assert.deepEqual(r.baseline, { collected: 0, reason: 'r' });
  assert.equal(r.staleDistAllowed, false);
});

// --- Spend, batches and run metrics -----------------------------------------

const usd = (n) => ({ totals: { inputTokens: 10, reportedCost: { USD: n } } });
const attempt = (n, cost, over = {}) => ({ attempt: n, runner: 'openrouter', startedAt: '2026-01-01T00:00:00.000Z', wallTimeMs: 0, byModel: [], ...usd(cost), ...over });

test('recordedSpend sums the planner\'s turns, wake-ups included, and every attempt, subtasks too', () => {
  const plan = {
    plannerUsage: usd(0.25),
    tasks: [
      { id: 'a', attemptUsage: [attempt(1, 0.5)], subtasks: [{ id: 'a1', attemptUsage: [attempt(1, 0.0625), attempt(2, 0.0625)] }] },
      { id: 'b', attemptUsage: [] },
    ],
  };
  assert.deepEqual(L.recordedSpend(plan), { usd: 0.875, plannerUsd: 0.25, attemptsUsd: 0.625, attempts: 3, unpriced: 0 });
  // A call the provider priced at nothing still counts as known; one with no price is counted apart, never guessed.
  assert.deepEqual(L.recordedSpend({ tasks: [{ id: 'a', attemptUsage: [attempt(1, 0.5), { ...attempt(2, 0), totals: { inputTokens: 5 } }] }] }),
    { usd: 0.5, plannerUsd: null, attemptsUsd: 0.5, attempts: 2, unpriced: 1 });
  assert.equal(L.recordedSpend(null).usd, null);
  assert.equal(L.recordedSpend({ plannerUsage: { totals: {} }, tasks: [] }).usd, null);
});

test('capDecision acts on the recorded spend, and on the key\'s only for a run alone on it', () => {
  assert.deepEqual(L.capDecision({ elapsedMs: 0, recordedSpentUsd: 8, keySpentUsd: 1, transcriptSpentUsd: 1, capUsd: 8 }), { stop: true, why: 'spend', spentUsd: 8 });
  assert.equal(L.capDecision({ elapsedMs: 0, recordedSpentUsd: 1, keySpentUsd: 9, capUsd: 8 }).stop, true);
  // Overlapping runs share the key: its delta is every run's, so it never stops one of them.
  assert.equal(L.capDecision({ elapsedMs: 0, recordedSpentUsd: 1, keySpentUsd: null, transcriptSpentUsd: 2, capUsd: 8 }).stop, false);
});

test('budgetDecision stops the batch once the key\'s delta reaches the budget, and never on an unread key', () => {
  assert.deepEqual(L.budgetDecision({ keyBeforeUsd: 10, keyNowUsd: 29.99, budgetUsd: 20 }), { stop: false, spentUsd: 19.99 });
  assert.deepEqual(L.budgetDecision({ keyBeforeUsd: 10, keyNowUsd: 30, budgetUsd: 20 }), { stop: true, spentUsd: 20 });
  assert.deepEqual(L.budgetDecision({ keyBeforeUsd: 10, keyNowUsd: null, budgetUsd: 20 }), { stop: false, spentUsd: null });
  assert.deepEqual(L.budgetDecision({ keyBeforeUsd: 10, keyNowUsd: 30, budgetUsd: null }), { stop: false, spentUsd: 20 });
});

test('capacityCheck refuses more cpus than the host has, or more than 80% of its memory', () => {
  const host = { hostCpus: 20, hostMemBytes: 32 * 2 ** 30 };
  assert.equal(L.capacityCheck({ jobs: 2, cpus: 8, memory: '12g', ...host }).ok, true);
  const cpu = L.capacityCheck({ jobs: 3, cpus: 8, memory: '4g', ...host });
  assert.equal(cpu.ok, false);
  assert.match(cpu.failures[0], /3 runs × 8 cpus = 24 cpus, the host has 20/);
  const mem = L.capacityCheck({ jobs: 2, cpus: 2, memory: '13g', ...host });
  assert.equal(mem.ok, false);
  assert.match(mem.failures[0], /80%/);
  assert.equal(L.capacityCheck({ jobs: 2, cpus: 8, memory: '12.8g', ...host }).ok, true, '25.6g is exactly 80% of 32g');
});

test('runIdFor makes each run\'s directory, container and network names unique within a batch, seed included', () => {
  const stamp = '2026-11-17T10:00:00.000Z';
  const ids = [];
  for (const libName of ['tlslite-ng', 'networkx']) for (const arm of ['A', 'B']) for (const seed of [null, 's1']) ids.push(L.runIdFor({ stamp, lib: libName, arm, seed }));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(L.runIdFor({ stamp, lib: 'networkx', arm: 'B', seed: 'Seed 1' }), '2026-11-17t10-00-00-networkx-b-seed-1');
  assert.equal(L.runIdFor({ stamp, lib: 'networkx', arm: 'B', seed: null }), '2026-11-17t10-00-00-networkx-b');
  for (const id of ids) assert.match(`commit0-${id}-egress`, /^[a-z0-9][a-z0-9_.-]+$/, 'a docker name');
  // Two processes in one second carry the same stamp: the batch plan says no pair repeats.
  assert.throws(() => L.batchPlan({ libs: ['x', 'x'], arms: ['A'], seed: null }), /twice/);
  assert.deepEqual(L.batchPlan({ libs: ['x', 'y'], arms: ['A', 'B'], seed: 's' }).map((r) => `${r.lib}-${r.arm}`), ['x-A', 'x-B', 'y-A', 'y-B']);
});

test('parseBatchArgs: --jobs 2 by default, a budget required to spend, the shared options passed to each run', () => {
  const d = L.parseBatchArgs(['--dry-run', '--libs', 'l.json']);
  assert.equal(d.jobs, 2);
  assert.equal(d.budgetUsd, null);
  assert.deepEqual(d.driveArgs, ['--dry-run', '--libs', path.resolve('l.json')]);
  assert.throws(() => L.parseBatchArgs(['--run', '--libs', 'l.json', '--provider-pin', 'p']), /--batch-budget-usd/);
  const r = L.parseBatchArgs(['--run', '--libs', 'l.json', '--provider-pin', 'p', '--batch-budget-usd', '30', '--jobs', '3', '--cpus', '4', '--seed', 's2', '--only', 'a,b', '--arm', 'B']);
  assert.equal(r.jobs, 3);
  assert.equal(r.budgetUsd, 30);
  assert.equal(r.seed, 's2');
  assert.deepEqual(r.only, ['a', 'b']);
  assert.equal(r.arm, 'B');
  assert.deepEqual(r.driveArgs, ['--run', '--libs', path.resolve('l.json'), '--provider-pin', 'p', '--cpus', '4']);
  assert.throws(() => L.parseBatchArgs(['--dry-run', '--libs', 'l.json', '--jobs', '0']), /--jobs/);
  assert.throws(() => L.parseBatchArgs(['--dry-run']), /--libs/);
  assert.throws(() => L.parseBatchArgs(['--dry-run', '--libs', 'l.json', '--batch-dir', 'x']), /unknown argument/);
});

test('parseArgs takes a seed, and the batch\'s own --batch-dir and --batch-shared', () => {
  const a = L.parseArgs(['--dry-run', '--libs', 'l.json']);
  assert.equal(a.seed, null);
  assert.equal(a.batchDir, null);
  assert.equal(a.batchShared, false);
  const b = L.parseArgs(['--dry-run', '--libs', 'l.json', '--seed', 's1', '--batch-dir', 'bd', '--batch-shared']);
  assert.equal(b.seed, 's1');
  assert.equal(b.batchDir, path.resolve('bd'));
  assert.equal(b.batchShared, true);
  assert.throws(() => L.parseArgs(['--dry-run', '--libs', 'l.json', '--batch-shared']), /--batch-dir/);
});

test('planShape: the longest dependency chain and the widest level', () => {
  const t = (id, dependencies = []) => ({ id, dependencies, status: 'pending' });
  // a → b → d, a → c, e alone: levels {a, e}, {b, c}, {d}.
  assert.deepEqual(L.planShape({ tasks: [t('a'), t('b', ['a']), t('c', ['a']), t('d', ['b']), t('e')] }), { longestChain: 3, widestLevel: 2 });
  assert.deepEqual(L.planShape({ tasks: [t('a')] }), { longestChain: 1, widestLevel: 1 });
  assert.deepEqual(L.planShape({ tasks: [] }), { longestChain: null, widestLevel: null });
  // A cycle or a dependency on no task is not a shape to guess.
  assert.deepEqual(L.planShape({ tasks: [t('a', ['b']), t('b', ['a'])] }), { longestChain: null, widestLevel: null });
});

test('meanConcurrency is the attempts\' running time over the time any ran, and null with one unended', () => {
  const at = (s, e) => ({ startedAt: new Date(s * 1000).toISOString(), endedAt: e === null ? undefined : new Date(e * 1000).toISOString() });
  assert.equal(L.meanConcurrency([at(0, 10), at(0, 10)]), 2);
  // 0-10 and 5-15 cover 15 s with 20 s of attempts; 20-30 adds 10 of each.
  assert.equal(L.meanConcurrency([at(0, 10), at(5, 15), at(20, 30)]), 1.2);
  assert.equal(L.meanConcurrency([at(0, 10), at(5, null)]), null);
  assert.equal(L.meanConcurrency([]), null);
});

test('runMetrics reads the tasks, checkpoints, the supervisor and each attempt from the session, and guesses nothing', () => {
  const call = (id, name, args) => ({ type: 'tool_call', id, name, args: JSON.stringify(args) });
  const result = (id, output) => ({ type: 'tool_result', id, output, success: true });
  const plan = {
    tasks: [
      { id: 't1', order: 1, title: 'one', type: 'ai', status: 'completed', dependencies: [], verdict: { outcome: 'pass', reported: 'done' },
        attemptUsage: [attempt(1, 0.1, { runningMs: 1000, startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:10.000Z' }), attempt(2, 0.1, { runningMs: 500, startedAt: '2026-01-01T00:00:10.000Z', endedAt: '2026-01-01T00:00:20.000Z' })] },
      { id: 't2', order: 2, title: 'two', type: 'ai', autonomy: 'HITL', status: 'failed', dependencies: ['t1'], verdict: { outcome: 'fail', reported: 'blocked' },
        attemptUsage: [attempt(1, 0.1, { startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:10.000Z' })] },
      { id: 't3', order: 3, title: 'three', type: 'user', status: 'skipped', dependencies: [] },
      { id: 't4', order: 4, title: 'four', type: 'ai', sliceType: 'HITL', status: 'failed', dependencies: ['t2'], verdict: { outcome: 'fail', reported: 'failed' }, attemptUsage: [] },
    ],
    conversationHistory: [
      { role: 'user', kind: 'wake_up', content: 'digest', timestamp: 'x' },
      { role: 'assistant', kind: 'execution', content: '', timestamp: 'y', execution: { command: 'continue', actor: 'supervisor', task: { id: 't2', ref: '#2', title: 'two' }, outcome: 'done', at: 'y' } },
      { role: 'assistant', kind: 'execution', content: '', timestamp: 'z', execution: { command: 'merge', actor: 'user', outcome: 'done', at: 'z' } },
      { role: 'user', kind: 'wake_up', content: 'digest', timestamp: 'w' },
    ],
  };
  const logs = {
    t1: {
      1: [call('c1', 'read_file', {}), call('c2', 'mcp__ordewell__checkpoint', { question: 'May I?' }), result('c2', 'approved: the supervisor said yes for the user — continue'), { type: 'runner_ended' }],
      2: [call('c3', 'bash', {}), call('c4', 'mcp__ordewell__task_complete', { status: 'done', summary: 's' }), result('c4', 'ok')],
    },
    t2: { 1: [call('c5', 'checkpoint', { question: 'Where is upstream?' }), result('c5', 'rejected: the user said no — not here'), call('c6', 'task_complete', { status: 'blocked' }), result('c6', 'ok')] },
  };
  const m = L.runMetrics(plan, logs);
  assert.deepEqual(m.tasks, { total: 4, passed: 1, failed: 1, blocked: 1, skipped: 1, open: 0, hitl: 2, user: 1 });
  assert.deepEqual(m.checkpoints, [
    { taskId: 't1', attempt: 1, question: 'May I?', answeredBy: 'supervisor', answer: 'approved' },
    { taskId: 't2', attempt: 1, question: 'Where is upstream?', answeredBy: 'user', answer: 'rejected' },
  ]);
  assert.equal(m.supervisor.wakeUps, 2);
  assert.deepEqual(m.supervisor.actions, [{ command: 'continue', task: '#2', outcome: 'done', at: 'y' }]);
  assert.deepEqual(m.perTask[0], { id: 't1', order: 1, title: 'one', type: 'ai', status: 'completed', runningMs: 1500, steps: 4,
    attempts: [{ attempt: 1, ended: 'ended without task_complete', steps: 2, runningMs: 1000 }, { attempt: 2, ended: 'done', steps: 2, runningMs: 500 }] });
  assert.equal(m.perTask[1].runningMs, null, 'an attempt with no running clock is not guessed');
  assert.equal(m.perTask[1].attempts[0].ended, 'blocked');
  assert.equal(m.perTask[3].steps, null);
  assert.deepEqual(m.plan, { longestChain: 3, widestLevel: 2 });
  assert.equal(m.meanConcurrentAttempts, 1.5);
  // Without the logs, what only they hold is null.
  const bare = L.runMetrics(plan, null);
  assert.equal(bare.checkpoints, null);
  assert.equal(bare.perTask[0].steps, null);
  assert.equal(bare.perTask[0].attempts[0].ended, null);
  assert.equal(L.runMetrics(null, null), null);
});

test('readTaskLogs reads each attempt\'s log from a copied-out session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c0-logs-'));
  try {
    const tasks = path.join(dir, 'sessions', 'sess-1', 'tasks');
    fs.mkdirSync(path.join(tasks, 't1'), { recursive: true });
    fs.writeFileSync(path.join(tasks, 't1', '1.jsonl'), `${JSON.stringify({ type: 'runner_ended' })}\nnot json\n`);
    fs.writeFileSync(path.join(tasks, 't1', '2.output.txt'), 'x');
    // An id that is no plain segment sits under core's idSegment encoding.
    const odd = 'a/b';
    fs.mkdirSync(path.join(tasks, `~${Buffer.from(odd).toString('hex')}`), { recursive: true });
    fs.writeFileSync(path.join(tasks, `~${Buffer.from(odd).toString('hex')}`, '1.jsonl'), '{"type":"turn_end","reason":"done"}\n');
    const logs = L.readTaskLogs(dir, 'sess-1', { tasks: [{ id: 't1' }, { id: odd }, { id: 'none' }] });
    assert.deepEqual(logs, { t1: { 1: [{ type: 'runner_ended' }] }, [odd]: { 1: [{ type: 'turn_end', reason: 'done' }] }, none: {} });
    assert.equal(L.readTaskLogs(path.join(dir, 'missing'), 'sess-1', { tasks: [] }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the goal puts the original implementation off limits, in the one text both arms get', () => {
  assert.match(L.goalText(lib()), /The original implementation is off limits: do not look for it in caches, compiled files, installed packages or on the network; write it from the docstrings and the tests\./);
});

test('the patch the driver writes leaves out __pycache__ and .pyc', () => {
  const script = L.armPatchScript(lib());
  assert.match(script, /:\(exclude,glob\)\*\*\/__pycache__\/\*\*/);
  assert.match(script, /:\(exclude,glob\)\*\*\/\*\.pyc/);
});

test('judgeLeak fails an untracked or ignored file that carries the implementation', () => {
  const clean = { commits: 1, objectCommits: 1, reference: 'absent', alternates: false, resolvesOutside: [], installedOutside: [], archives: [], untracked: [] };
  assert.equal(L.judgeLeak(clean).ok, true);
  const hit = L.judgeLeak({ ...clean, untracked: ['tinylib/__pycache__/core.cpython-312.pyc'] });
  assert.equal(hit.ok, false);
  assert.match(hit.failures[0], /untracked or ignored file tinylib\/__pycache__\/core\.cpython-312\.pyc/);
  assert.deepEqual(L.leakKinds({ ...clean, untracked: ['x.pyc'] }), ['untracked']);
  assert.equal(L.judgeLeak({ ...clean, untracked: null }).ok, false, 'an unreadable status is no pass');
});

test('the leak probe scans untracked and ignored files, and the cleanup leaves only the venv', { skip: !(hasGit && hasPython && process.platform !== 'win32') && 'needs git, python3 and sh' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-'));
  try {
    const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(dir, 'tinylib'));
    fs.writeFileSync(path.join(dir, 'tinylib', '__init__.py'), 'def f():\n    raise NotImplementedError\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '__pycache__/\nbuild/\n');
    g('add', '-A'); g('commit', '-qm', 'stubs');
    const l = lib({ workdir: dir, baseCommit: g('rev-parse', 'HEAD'), python: 'python3' });
    execFileSync('sh', ['-c', L.flattenScript(l)]);
    execFileSync('sh', ['-c', L.workspaceIgnoreScript(l)]);
    // What a reference collection and an image leave: bytecode of the implementation, a build tree, a stray copy.
    fs.mkdirSync(path.join(dir, 'tinylib', '__pycache__'));
    fs.writeFileSync(path.join(dir, 'tinylib', '__pycache__', '__init__.cpython-312.pyc'), 'compiled');
    fs.mkdirSync(path.join(dir, 'build', 'lib', 'tinylib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'build', 'lib', 'tinylib', '__init__.py'), 'def f():\n    return 1\n');
    fs.writeFileSync(path.join(dir, 'tinylib', 'orig.py'), 'def f():\n    return 1\n');
    fs.mkdirSync(path.join(dir, '.venv', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.venv', 'lib', 'keep.pyc'), 'the image\'s venv');
    fs.mkdirSync(path.join(dir, 'tinylib.egg-info'));
    fs.writeFileSync(path.join(dir, 'tinylib.egg-info', 'PKG-INFO'), 'Name: tinylib\n');
    const probe = () => JSON.parse(execFileSync('python3', ['-c', L.LEAK_PROBE_PY, dir, 'tinylib', 'tinylib-unlikely-dist', '-', dir], { cwd: '/', encoding: 'utf8' }).trim().split('\n').pop());
    assert.deepEqual(probe().untracked, ['build/lib/tinylib/__init__.py', 'tinylib/__pycache__/__init__.cpython-312.pyc', 'tinylib/orig.py']);
    const removed = execFileSync('sh', ['-c', L.leftoverCleanupScript(l)], { encoding: 'utf8' });
    assert.match(removed, /tinylib\/__pycache__/);
    const after = probe();
    assert.deepEqual(after.untracked, []);
    assert.equal(L.judgeLeak({ ...after, commits: 1, objectCommits: 1 }).ok, true);
    assert.ok(fs.existsSync(path.join(dir, '.venv', 'lib', 'keep.pyc')), 'the venv stays');
    assert.ok(fs.existsSync(path.join(dir, 'tinylib.egg-info', 'PKG-INFO')), 'an editable install\'s metadata stays: it holds no module');
    assert.equal(g('status', '--porcelain', '--untracked-files=no'), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('batchRecord sets the key\'s delta against the recorded sum, and marks per-run key figures unavailable when runs overlapped', () => {
  const runs = [
    { lib: 'a', arm: 'A', recordedUsd: 1.25 },
    { lib: 'a', arm: 'B', recordedUsd: 2.5 },
    { lib: 'b', arm: 'A', recordedUsd: null },
  ];
  const r = L.batchRecord({ keyBeforeUsd: 10, keyAfterUsd: 14, budgetUsd: 20, stoppedByBudget: null, jobs: 2, overlapped: true, runs });
  assert.equal(r.keyDeltaUsd, 4);
  assert.equal(r.recordedSumUsd, 3.75);
  assert.equal(r.gapUsd, 0.25);
  assert.deepEqual(r.unrecordedRuns, ['b A']);
  assert.match(r.perRunKeyBilled, /not available/);
  const dry = L.batchRecord({ keyBeforeUsd: null, keyAfterUsd: null, jobs: 2, overlapped: false, runs: [] });
  assert.equal(dry.keyDeltaUsd, null);
  assert.equal(dry.gapUsd, null);
  assert.doesNotMatch(dry.perRunKeyBilled, /not available/);
});

test('keyUsage reads the key\'s usage, and null without a key or on any failure', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ data: { usage: 3.5 } }) });
  assert.equal(await L.keyUsage('k', ok), 3.5);
  assert.equal(await L.keyUsage('', ok), null);
  assert.equal(await L.keyUsage('k', async () => ({ ok: false })), null);
  assert.equal(await L.keyUsage('k', async () => { throw new Error('offline'); }), null);
  const seq = [1, 2, 2];
  assert.equal(await L.settledKeyUsage('k', { read: async () => seq.shift(), waitMs: 0 }), 2);
});

test('batch.mjs refuses a batch that does not fit the host before it starts anything', () => {
  const libs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-batch-')), 'libs.json');
  fs.writeFileSync(libs, JSON.stringify([{ name: 'tinylib', image: 'x', srcDir: 'tinylib', testDir: 'tests', importName: 'tinylib', distName: 'tinylib', baseCommit: 'abc1234' }]));
  const jobs = String(os.cpus().length + 1);
  let out = null;
  try {
    execFileSync(process.execPath, [path.join(here, 'batch.mjs'), '--dry-run', '--libs', libs, '--jobs', jobs, '--cpus', '1'], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NODE_OPTIONS: '' } });
  } catch (err) {
    out = err;
  }
  assert.ok(out, 'the batch started');
  assert.equal(out.status, 2);
  assert.match(out.stderr, /does not fit this host[\s\S]*lower --jobs or --cpus/);
});

test('ADV F-c: a signal to a batch stops its queued runs, not only the running one', { skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
  // A copy of the batch beside a drive.mjs that records its start and waits to be signalled.
  // data-dir.mjs refuses run data inside the tree two levels above it, so the copy sits a level below root.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-signal-'));
  const copy = path.join(root, 'tree', 'bench');
  try {
    fs.mkdirSync(path.join(copy, 'commit0'), { recursive: true });
    fs.mkdirSync(path.join(copy, 'lib'));
    for (const f of ['batch.mjs', 'lib.mjs']) fs.copyFileSync(path.join(here, f), path.join(copy, 'commit0', f));
    fs.copyFileSync(path.join(here, '..', 'lib', 'data-dir.mjs'), path.join(copy, 'lib', 'data-dir.mjs'));
    const starts = path.join(root, 'starts.log');
    fs.writeFileSync(path.join(copy, 'commit0', 'drive.mjs'), [
      "import fs from 'node:fs';",
      `fs.appendFileSync(${JSON.stringify(starts)}, process.argv[process.argv.indexOf('--only') + 1] + '\\n');`,
      "process.on('SIGINT', () => process.exit(130));",
      'setTimeout(() => {}, 20_000);',
    ].join('\n'));
    const libs = path.join(root, 'libs.json');
    fs.writeFileSync(libs, JSON.stringify(['a', 'b', 'c'].map((name) => ({ name, image: 'x', srcDir: name, testDir: 'tests', importName: name, distName: name, baseCommit: 'abc1234' }))));
    const bench = path.join(root, 'data');
    const child = spawn(process.execPath, [path.join(copy, 'commit0', 'batch.mjs'), '--dry-run', '--libs', libs, '--jobs', '1', '--cpus', '1', '--memory', '1g', '--arm', 'A'], {
      stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '', ORDEWELL_BENCH_DIR: bench },
    });
    const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    const started = () => (fs.existsSync(starts) ? fs.readFileSync(starts, 'utf8').split('\n').filter(Boolean) : []);
    for (const until = Date.now() + 10_000; started().length === 0 && Date.now() < until;) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(started(), ['a']);
    child.kill('SIGINT');
    assert.notEqual(await exited, 0);
    assert.deepEqual(started(), ['a'], 'a queued run started after the signal');
    const [dir] = fs.readdirSync(path.join(bench, 'commit0', 'dry-runs'));
    const batch = JSON.parse(fs.readFileSync(path.join(bench, 'commit0', 'dry-runs', dir, 'batch.json'), 'utf8'));
    assert.deepEqual(batch.runs.map((r) => [r.lib, r.skipped === null ? null : 'skipped']), [['a', null], ['b', 'skipped'], ['c', 'skipped']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Adversarial review, round 1: each reproduces a problem it confirmed, and failed before the fix. ---

test('ADV F-a: a run cut short by the batch budget is not a valid comparison', () => {
  // drive.mjs:899 records stopped = { why: 'batch-budget' } and scores the run;
  // drive.mjs:1129 calls judgeValidity without `stopped`, so nothing marks it.
  const v = L.judgeValidity({ aborted: null, checks: [], tests: { passed: 3, collected: 10 }, freshness: { stale: false }, stopped: { why: 'batch-budget', atMs: 1_800_000 } });
  assert.equal(v.valid, false, 'a batch-budget stop gave this arm a cap the other arm did not get');
});

test('ADV F-b3: more passed than the reference collected is not a valid score', () => {
  const v = L.judgeValidity({ aborted: null, checks: [], tests: { passed: 12, failed: 0, errors: 0, skipped: 0, collected: 10 }, freshness: { stale: false } });
  assert.equal(v.valid, false, '12 of 10 passed was reported valid');
});

test('ADV F-f: a user task left pending at the end of an arm-B plan stalls rather than settles', () => {
  const plan = { approved: true, approvedTasks: ['t1', 't2'], tasks: [
    { id: 't1', title: 'implement', type: 'ai', status: 'completed', attempted: true },
    { id: 't2', title: 'confirm with the maintainer', type: 'user', status: 'pending' },
  ] };
  const stallMs = 15 * 60_000;
  const first = L.stallDecision({ plan, nowMs: 0, sinceMs: null, stallMs });
  const later = L.stallDecision({ plan, nowMs: stallMs, sinceMs: first.sinceMs, stallMs });
  const fp = L.planFingerprint(plan, 5);
  const s0 = L.settleDecision({ plan, fingerprint: fp, nowMs: 0, state: null });
  const s1 = L.settleDecision({ plan, fingerprint: fp, nowMs: L.SETTLE_MS, state: s0.state });
  assert.equal(s1.settled, false, 'the run settles at 5 min as if nobody were waited on');
  assert.ok(later.stalled, 'the run never stalls on the pending user task');
});

test('ADV F-d: a paid batch whose key cannot be read when it begins is refused, since its budget could never stop it', async () => {
  // budgetDecision has no spend without the usage at the start, and batch.mjs read it once.
  assert.equal(L.budgetDecision({ keyBeforeUsd: null, keyNowUsd: 500, budgetUsd: 20 }).stop, false);
  let reads = 0;
  const flaky = async () => (++reads < 3 ? null : 41.5);
  assert.equal(await L.startingKeyUsage({ read: flaky, waitMs: 0 }), 41.5, 'a read that fails twice is retried');
  assert.equal(reads, 3);
  reads = 0;
  await assert.rejects(L.startingKeyUsage({ read: async () => { reads++; return null; }, waitMs: 0, tries: 4 }), /could not be read[\s\S]*budget/);
  assert.equal(reads, 4);
});

test('ADV2 F-a: a forged summary within the reference count is valid, so a pytest package at the workdir root must never cross', () => {
  // `python -m` puts the working directory first on sys.path: /testbed/pytest/__main__.py
  // would run in place of pytest and print whatever summary it likes.
  const l = lib();
  assert.equal(l.testCmd, '/testbed/.venv/bin/python -m pytest');
  const forged = L.parseEvaluation(0, 'tests/test_a.py .....\n============ 5 passed in 0.01s ============\n');
  const v = L.judgeValidity({ aborted: null, checks: [], tests: { ...forged, collected: 5 }, freshness: { stale: false } });
  assert.equal(v.valid, true, 'precondition: a forged summary within the reference count is valid');
  const blobOf = { mode: '100644', oid: '0'.repeat(40) };
  const final = new Map(['pytest/__main__.py', '_pytest/runner.py', 'pluggy/__init__.py', 'sitecustomize.py'].map((p) => [p, blobOf]));
  const sel = L.selectScoredFiles({ lib: l, base: new Map(), final });
  assert.deepEqual(sel.copy, []);
  assert.equal(sel.needsInspection.length, 4);
});
