// The Commit0 driver's own logic: each check's verdict, the parsers its
// numbers come from, and the record. The docker and git calls around them are
// proved by the dry run, which needs an engine (bench/README.md, "Commit0").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  assert.deepEqual(r.tests, { passed: 7, collected: 9, failed: 2, errors: 0, skipped: 0, moduleSkipped: null, collectionErrors: [], exit: 1, timedOut: false });
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
  assert.deepEqual(recA, { supervisorLevel: 'off', autorun: false, automerge: false, parallel: 1, cpus: 2, memory: '4g', capUsd: 1.5, wallCapMs: L.WALL_CAP_MS, callBudget: L.STEP_LIMIT });
  assert.deepEqual(recB, { supervisorLevel: 'act', autorun: true, automerge: true, parallel: 3, cpus: 2, memory: '4g', capUsd: 1.5, wallCapMs: L.WALL_CAP_MS, callBudget: L.STEP_LIMIT });
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

test('settledStall records each open task and what held it, and the run that settled with it open is truncated with that reason', () => {
  const plan = {
    approved: true,
    approvedTasks: ['a', 'b', 'c', 'd', 'e', 's'],
    tasks: [
      { id: 'a', order: 1, title: 'A', type: 'ai', status: 'completed', attempted: true },
      { id: 'b', order: 2, title: 'B', type: 'ai', status: 'failed', attempted: true, dependencies: ['a'] },
      { id: 'c', order: 3, title: 'C', type: 'ai', status: 'pending', dependencies: ['b'] },
      { id: 'd', order: 4, title: 'D', type: 'ai', status: 'awaiting_user', awaitingReason: 'conflict', attempted: true },
      { id: 'e', order: 5, title: 'E', type: 'ai', status: 'pending', dependencies: ['a'] },
      { id: 'f', order: 6, title: 'F', type: 'ai', status: 'pending', dependencies: [] },
      { id: 'g', order: 7, title: 'G', type: 'ai', status: 'skipped' },
    ],
  };
  // The daemon's run view (RunTask in core's SessionMessage.ts) is where a hold lives: the saved plan keeps none.
  const run = { tasks: [{ id: 'e', holdReason: 'Its runner did not connect twice', subtasks: [] }, { id: 'f', waitsForApproval: true, subtasks: [] }] };
  const s = L.settledStall({ plan, run, quietMs: 300_000 });
  assert.deepEqual(s, {
    why: 'settled', quietMs: 300_000, runView: true,
    open: [
      { id: 'b', order: 2, title: 'B', status: 'failed', held: 'nothing ready', reason: 'failed' },
      { id: 'c', order: 3, title: 'C', status: 'pending', held: 'nothing ready', reason: 'depends on 2 (failed)' },
      { id: 'd', order: 4, title: 'D', status: 'awaiting_user', held: 'waiting on a person', reason: 'conflict' },
      { id: 'e', order: 5, title: 'E', status: 'pending', held: 'on hold', reason: 'Its runner did not connect twice' },
      { id: 'f', order: 6, title: 'F', status: 'pending', held: 'waiting on a person', reason: 'approval' },
    ],
  });
  const noView = L.settledStall({ plan, run: null, quietMs: 1 });
  assert.equal(noView.runView, false, 'without the daemon\'s view a hold cannot be told, and the record says so');
  assert.deepEqual(noView.open.find((t) => t.id === 'e'), { id: 'e', order: 5, title: 'E', status: 'pending', held: 'nothing ready', reason: 'ready, not started' });
  assert.equal(L.settledStall({ plan: { tasks: [plan.tasks[0]] }, run, quietMs: 1 }), null, 'a run that settled with every task closed did not stall');
  assert.deepEqual(L.judgeLanding({ stopped: null, stalled: s, plan }), { truncated: true, why: 'settled with 5 tasks open: 2 nothing ready, 1 on hold, 2 waiting on a person' });
});

// Built by core itself, never written by hand: a hand-written plan put `tasks`
// beside `run`, the chooser read it there, and a paid run scored arm A on the
// stubs while its kept worktree held the work.
const coreUrl = pathToFileURL(path.join(repo, 'packages', 'core', 'dist', 'index.mjs')).href;
const hasCore = fs.existsSync(fileURLToPath(coreUrl));

/** A git repository whose isolation run core started: one task kept, one preserved twice, one merged, one never started. */
async function coreIsolationFixture() {
  const core = await import(coreUrl);
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-iso-')));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'commit0-base');
  git('config', 'user.email', 'bench@example.invalid');
  git('config', 'user.name', 'bench');
  fs.writeFileSync(path.join(dir, 'lib.py'), 'stub\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const iso = core.createWorktreeIsolation({ config: { worktreeIsolation: 'auto', worktreeSetupCommand: '', workspaceRepos: [], worktreeLinks: [] }, noHooks: true });
  const run = await iso.startRun(dir);
  const mk = (title, order, status) => ({ ...core.createTask({ title, description: title, type: 'ai', order }), status });
  const [a, b, c, d] = [mk('Implement A', 1, 'failed'), mk('Implement B', 2, 'awaiting_user'), mk('Implement C', 3, 'completed'), mk('Implement D', 4, 'pending')];
  const work = async (t, text) => {
    const { cwd } = await iso.prepare(t, run);
    fs.writeFileSync(path.join(cwd, 'lib.py'), text);
  };
  await work(a, 'a\n');
  await iso.release(run, a.id, { keep: true });
  for (const n of [1, 2]) {
    await work(b, `b${n}\n`);
    await iso.release(run, b.id, { keep: false });
  }
  await work(c, 'c\n');
  await iso.integrate(c, run);
  const plan = { tasks: [a, b, c, d, { ...mk('Script', 5, 'failed'), type: 'script' }], isolation: { run, resolvers: {} } };
  return { dir, run, plan, tasks: { a, b, c, d } };
}

test('choosePatches reads core\'s records: a kept worktree, else the newest preserved branch, never the integration worktree', { skip: !(hasGit && hasCore) && 'needs git and the built core (npm run build -w packages/core)' }, async () => {
  const { dir, run, plan, tasks: { a, b, c, d } } = await coreIsolationFixture();
  try {
    const { worktrees, branches } = L.readGitLayout(dir, dir);
    const got = L.choosePatches({ plan, worktrees, branches: [...branches.keys()] });
    assert.deepEqual(got.map((p) => [p.taskId, p.isolation, p.landed, p.source]), [
      [a.id, 'kept', false, { kind: 'worktree', path: run.tasks[a.id].workspace }],
      [b.id, null, false, { kind: 'branch', ref: `ordewell-preserved/${run.id}/2-implement-b-2` }],
      [c.id, 'merged', true, null],
      [d.id, null, false, null],
    ], 'a released task\'s record is gone, so its preserved branch is found by the order its name starts with');
    const open = structuredClone(plan);
    open.tasks[2].subtasks = [{ id: 'c1', status: 'failed' }];
    assert.equal(L.choosePatches({ plan: open, worktrees, branches: [...branches.keys()] })[2].landed, false, 'an open subtask leaves its task unlanded');
    assert.deepEqual(L.choosePatches({ plan: { tasks: [{ id: 'x', title: 'X', status: 'failed' }] }, worktrees, branches: [] }).map((p) => p.source), [null]);
    // The kept worktree hidden: its branch is still at the base, since the work in it was never committed, so it is no source.
    fs.rmSync(run.tasks[a.id].workspace, { recursive: true, force: true });
    const hidden = L.readGitLayout(dir, dir);
    const lost = L.choosePatches({ plan, worktrees: hidden.worktrees, branches: [...hidden.branches.keys()], tips: hidden.branches });
    assert.equal(lost[0].source, null, 'a task branch at its base holds none of the task\'s work');
    assert.match(L.judgeScoredSource({ arm: L.ARMS.A, chosen: lost.slice(0, 1), scoredFrom: L.scoringPlan(L.ARMS.A, lost.slice(0, 1)).scoredFrom }).failures[0], /did not land and no source for its work was found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// A run core made on Windows records `C:\…` while git writes `C:/…` into a
// worktree's gitdir: the same worktree, which a kept task's work is found in.
test('readGitLayout and choosePatches match a Windows record\'s backslashes with git\'s forward slashes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-'));
  try {
    const put = (p, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), text);
    };
    put('.git/HEAD', 'ref: refs/heads/commit0-base\n');
    put('.git/worktrees/1-a/gitdir', 'C:/w/.ordewell/worktrees/r1/1-a/.git\n');
    put('.git/worktrees/1-a/HEAD', 'ref: refs/heads/ordewell/r1/1-a\n');
    put('.git/worktrees/integration/gitdir', 'C:/w/.ordewell/worktrees/r1/integration/.git\n');
    put('.git/worktrees/integration/HEAD', 'ref: refs/heads/ordewell/r1/integration\n');
    put('.ordewell/worktrees/r1/1-a/.git', 'gitdir: C:/w/.git/worktrees/1-a\n');
    put('.ordewell/worktrees/r1/integration/.git', 'gitdir: C:/w/.git/worktrees/integration\n');
    const { worktrees } = L.readGitLayout(dir, 'C:\\w');
    assert.deepEqual(worktrees.map((w) => w.branch), ['commit0-base', 'ordewell/r1/1-a', 'ordewell/r1/integration']);
    const workspace = 'C:\\w\\.ordewell\\worktrees\\r1\\1-a';
    const run = { id: 'r1', workspaceRoot: 'C:\\w', tasks: { a: { status: 'kept', workspace, branch: 'ordewell/r1/1-a' }, b: { status: 'kept', workspace: 'C:\\w\\.ordewell\\worktrees\\r1\\integration' } } };
    const plan = { tasks: [{ id: 'a', order: 1, title: 'A', status: 'failed' }, { id: 'b', order: 2, title: 'B', status: 'failed' }], isolation: { run } };
    assert.deepEqual(L.choosePatches({ plan, worktrees, branches: [] }).map((p) => p.source), [{ kind: 'worktree', path: workspace }, null], 'never the integration worktree, however it is spelled');
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

test('judgeScoredSource fails arm A when an unlanded task\'s work has no source, or when it is scored on the merged workspace with its task open', () => {
  const task = { taskId: 'a', order: 1, title: 'Implement', status: 'failed', isolation: 'kept', landed: false, source: { kind: 'worktree', path: '/w/1-a' } };
  const judge = (chosen, arm = L.ARMS.A) => L.judgeScoredSource({ arm, chosen, scoredFrom: L.scoringPlan(arm, chosen).scoredFrom });
  assert.deepEqual(judge([task]), { ok: true, failures: [] });
  assert.deepEqual(judge([{ ...task, status: 'completed', isolation: 'merged', landed: true, source: null }]), { ok: true, failures: [] }, 'landed work is in the workspace');
  const lost = judge([{ ...task, isolation: null, source: null }]);
  assert.equal(lost.ok, false);
  assert.deepEqual(lost.failures, [
    'task 1 "Implement" (failed, isolation record: none) did not land and no source for its work was found',
    'scored from the merged workspace while task 1 "Implement" is failed',
  ]);
  // A worktree the chooser found but the driver could not read falls back to the workspace (filesToScore).
  assert.deepEqual(L.judgeScoredSource({ arm: L.ARMS.A, chosen: [task], scoredFrom: 'merged' }).failures, ['scored from the merged workspace while task 1 "Implement" is failed']);
  assert.deepEqual(L.judgeScoredSource({ arm: L.ARMS.A, chosen: [], scoredFrom: 'merged' }).failures, ['the plan holds no task to score']);
  assert.deepEqual(judge([{ ...task, source: null }], L.ARMS.B), { ok: true, failures: [] }, 'arm B is scored on what merged by design (D3)');
  const v = L.judgeValidity({ checks: [], tests: { passed: 1, exit: 0 }, freshness: { stale: false }, scoring: lost });
  assert.deepEqual(v.invalidReasons, lost.failures.map((f) => `arm A scored without its work: ${f}`));
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

// --- --plan-only: the shape of a plan -----------------------------------------

const pt = (id, dependencies = [], over = {}) => ({ id, title: `Task ${id}`, description: `does ${id}`, type: 'ai', dependencies, subtasks: [], ...over });
const titles = (...ids) => ids.map((i) => `Task ${i}`);

test('planStructure: a chain has as many levels as tasks, one wide, and its first task gates the rest', () => {
  const s = L.planStructure({ tasks: [pt('a'), pt('b', ['a']), pt('c', ['b']), pt('d', ['c'])] });
  assert.deepEqual([s.tasks, s.levels, s.longestChain, s.widestLevel, s.edges, s.valid], [4, 4, 4, 1, 3, true]);
  assert.deepEqual(s.chain, titles('a', 'b', 'c', 'd'));
  assert.deepEqual([s.gatedByOne, s.gate], [true, 'Task a']);
  assert.deepEqual(s.problems, []);
});

test('planStructure: a fan-out of independent tasks is one level, wide, with no gate and no edge', () => {
  const s = L.planStructure({ tasks: [pt('a'), pt('b'), pt('c'), pt('d')] });
  assert.deepEqual([s.levels, s.longestChain, s.widestLevel, s.edges, s.gatedByOne, s.gate], [1, 1, 4, 0, false, null]);
  assert.deepEqual(s.chain, titles('a'), 'with every chain of one task equal, the first listed');
  // One task fans out to three, which a last task joins: the root gates all, the widest level is the middle.
  const diamond = L.planStructure({ tasks: [pt('r'), pt('x', ['r']), pt('y', ['r']), pt('z', ['r']), pt('j', ['x', 'y', 'z'])] });
  assert.deepEqual([diamond.levels, diamond.widestLevel, diamond.edges, diamond.gate], [3, 3, 6, 'Task r']);
  assert.deepEqual(diamond.chain, titles('r', 'x', 'j'), 'the first of equal chains');
});

test('planStructure: a root gate is the one task every other reaches, however indirectly', () => {
  const gated = L.planStructure({ tasks: [pt('g'), pt('a', ['g']), pt('b', ['a']), pt('c', ['g'])] });
  assert.deepEqual([gated.gatedByOne, gated.gate], [true, 'Task g']);
  // Two roots: neither gates the other's branch.
  const two = L.planStructure({ tasks: [pt('g'), pt('h'), pt('a', ['g', 'h'])] });
  assert.deepEqual([two.gatedByOne, two.gate], [false, null]);
  // A last task depends on everything yet gates nothing: it is a sink, not a root.
  const sink = L.planStructure({ tasks: [pt('a'), pt('b'), pt('z', ['a', 'b'])] });
  assert.equal(sink.gatedByOne, false);
  assert.equal(L.planStructure({ tasks: [pt('only')] }).gatedByOne, false, 'a lone task gates no other');
});

test('planStructure counts a task once by kind, loop checks besides, subtasks apart, and a repeated dependency once', () => {
  const s = L.planStructure({
    tasks: [
      pt('r', [], { research: true, readOnly: true }),
      pt('c', ['r'], { subtasks: [pt('c1'), pt('c2', [], { subtasks: [pt('c3')] })] }),
      pt('o', ['r'], { ops: true }),
      pt('s', ['c'], { type: 'script', commands: [['pytest']], loop: { body: ['f'], maxRounds: 2 } }),
      pt('f', ['s', 's']),
      pt('u', [], { type: 'user' }),
      pt('d', [], { type: 'delegated' }),
    ],
  });
  assert.deepEqual(s.kinds, { research: 1, change: 2, ops: 1, script: 1, user: 1, delegated: 1 });
  assert.equal(Object.values(s.kinds).reduce((a, b) => a + b, 0), s.tasks, 'the kinds sum to the tasks');
  assert.equal(s.loopChecks, 1);
  assert.equal(s.subtasks, 3);
  assert.equal(s.edges, 4, 'r→c, r→o, c→s, s→f once, and none for the subtasks');
  assert.deepEqual(s.chain, titles('r', 'c', 's', 'f'));
});

test('planStructure: a cycle, an unknown dependency, a repeated id or no task is a shape without a graph, never a crash', () => {
  const cycle = L.planStructure({ tasks: [pt('a', ['b']), pt('b', ['a']), pt('c')] });
  assert.equal(cycle.valid, false);
  assert.match(cycle.problems.join(), /cycle/);
  assert.deepEqual([cycle.levels, cycle.longestChain, cycle.chain, cycle.widestLevel, cycle.gatedByOne, cycle.gate], [null, null, null, null, null, null]);
  assert.deepEqual([cycle.tasks, cycle.edges, cycle.kinds.change], [3, 2, 3], 'what needs no graph is still counted');
  assert.match(L.planStructure({ tasks: [pt('a', ['a'])] }).problems.join(), /cycle/, 'a task cannot wait on itself');
  const unknown = L.planStructure({ tasks: [pt('a', ['ghost'])] });
  assert.equal(unknown.valid, false);
  assert.match(unknown.problems.join(), /"Task a" depends on "ghost", which is no task/);
  assert.match(L.planStructure({ tasks: [pt('a'), pt('a')] }).problems.join(), /two tasks have the id "a"/);
  assert.deepEqual(L.planStructure({ tasks: [] }).problems, ['the plan holds no task']);
  for (const odd of [null, undefined, {}, { tasks: 'no' }, { tasks: [null, 3, pt('x', 'not-a-list', { subtasks: 'no' })] }]) {
    assert.doesNotThrow(() => L.planStructure(odd), JSON.stringify(odd));
  }
  assert.equal(L.planStructure({ tasks: [null, 3, pt('x', 'not-a-list', { subtasks: 'no' })] }).valid, true, 'what is not a task is left out');
});

test('planStructure reads a deep plan without the stack, and its shape agrees with planShape', () => {
  const deep = Array.from({ length: 800 }, (_, i) => pt(`t${i}`, i ? [`t${i - 1}`] : []));
  assert.equal(L.planStructure({ tasks: deep }).longestChain, 800);
  const plan = { tasks: [pt('a'), pt('b', ['a']), pt('c', ['a']), pt('d', ['b']), pt('e')] };
  const s = L.planStructure(plan);
  assert.deepEqual({ longestChain: s.longestChain, widestLevel: s.widestLevel }, L.planShape(plan));
});

test('planDigest holds every task\'s title, brief and dependencies, by id and by title', () => {
  const d = L.planDigest({ tasks: [pt('a', [], { prompt: 'Do a, thoroughly.' }), pt('b', ['a', 'zz'], { subtasks: [pt('b1')] })] });
  assert.deepEqual(d.tasks.map((t) => [t.title, t.brief, t.dependencies, t.dependsOn, t.kind]), [
    ['Task a', 'Do a, thoroughly.', [], [], 'change'],
    ['Task b', 'does b', ['a', 'zz'], ['Task a', null], 'change'],
  ]);
  assert.equal(d.tasks[1].subtasks[0].title, 'Task b1');
});

test('describePlanned says the plan in one line, and what it could not say', () => {
  const planned = L.plannedRecord({ plan: { plannerUsage: { totals: { reportedCost: { USD: 0.0123 } } }, tasks: [pt('a'), pt('b', ['a'])] }, planCheck: { ok: true, failures: [] }, planningMs: 41_400 });
  assert.equal(planned.plannerUsd, 0.0123);
  assert.equal(planned.planningMs, 41_400);
  assert.match(L.describePlanned(planned), /^plan-only: 2 tasks \(2 change\), longest chain 2, widest level 1, 1 edges, all gated by "Task a"; planner \$0\.0123, 41 s$/);
  assert.match(L.describePlanned(L.plannedRecord({ plan: { tasks: [pt('a', ['b'])] }, planningMs: null })), /no graph: "Task a" depends on "b", which is no task; planner spend not recorded$/);
  assert.equal(L.describePlanned(null), 'no plan was recorded');
});

test('--plan-only: arm B alone, refused for arm A and for a dry run, and no plan-only run is a valid, scored or listed one', () => {
  const o = L.parseArgs(['--run', '--plan-only', '--libs', 'x.json', '--provider-pin', 'p']);
  assert.equal(o.planOnly, true);
  assert.equal(o.arm, 'B', 'both arms means B: arm A has no plan');
  assert.equal(L.parseArgs(['--run', '--plan-only', '--arm', 'B', '--libs', 'x.json', '--provider-pin', 'p']).arm, 'B');
  assert.throws(() => L.parseArgs(['--run', '--plan-only', '--arm', 'A', '--libs', 'x.json', '--provider-pin', 'p']), /arm A.*no plan/);
  assert.throws(() => L.parseArgs(['--plan-only', '--arm', 'a', '--rehearse', 'b-plan', '--libs', 'x.json']), /arm A.*no plan/);
  assert.throws(() => L.parseArgs(['--dry-run', '--plan-only', '--libs', 'x.json']), /--plan-only.*--run or --rehearse/);
  assert.equal(L.parseArgs(['--rehearse', 'b-plan', '--plan-only', '--libs', 'x.json']).planOnly, true);
  assert.equal(L.parseArgs(['--dry-run', '--libs', 'x.json']).planOnly, false);
  // Its runs and results sit apart from the scored ones.
  assert.equal(L.runsDirName({ planOnly: true }), 'plan-runs');
  assert.equal(L.runsDirName({ planOnly: true, rehearse: 'b-plan' }), 'rehearsals');
  assert.equal(L.runsDirName({ planOnly: false }), 'runs');
  assert.equal(L.resultsFileName({ planOnly: true }), 'plans.jsonl');
  assert.equal(L.resultsFileName({ planOnly: false }), 'results.jsonl');
  const v = L.judgeValidity({ aborted: null, checks: [], tests: null, freshness: { stale: false }, planOnly: true });
  assert.equal(v.valid, false);
  assert.deepEqual(v.invalidReasons, ['plan-only: the plan was made and nothing ran, so nothing was scored']);
  const r = L.resultRecord({ lib: lib(), arm: L.ARMS.B, window: { window: 1 }, ordewell: { sha: 's' }, validity: v, planOnly: true, dryRun: false });
  assert.deepEqual([r.planOnly, r.valid, r.tests, r.scoredFrom], [true, false, null, null]);
  assert.equal(L.resultRecord({ lib: lib(), arm: L.ARMS.B, window: { window: 1 }, ordewell: { sha: 's' } }).planOnly, false);
});

test('a batch takes --plan-only for arm B alone, passes it on, refuses arm A, and marks its batch.json', () => {
  const b = L.parseBatchArgs(['--run', '--plan-only', '--libs', 'l.json', '--provider-pin', 'p', '--batch-budget-usd', '2', '--jobs', '3', '--seed', 's2', '--ordewell-root', 'other']);
  assert.equal(b.planOnly, true);
  assert.equal(b.arm, 'B');
  assert.equal(b.jobs, 3);
  assert.ok(b.driveArgs.includes('--plan-only'));
  assert.deepEqual(b.driveArgs.slice(b.driveArgs.indexOf('--ordewell-root'), b.driveArgs.indexOf('--ordewell-root') + 2), ['--ordewell-root', path.resolve('other')]);
  assert.throws(() => L.parseBatchArgs(['--run', '--plan-only', '--arm', 'A', '--libs', 'l.json', '--provider-pin', 'p', '--batch-budget-usd', '2']), /arm A.*no plan/);
  assert.throws(() => L.parseBatchArgs(['--dry-run', '--plan-only', '--libs', 'l.json']), /--plan-only/);
  assert.deepEqual(L.batchPlan({ libs: ['x', 'y'], arms: L.armsOf(b.arm).map((a) => a.id), seed: 's' }).map((r) => `${r.lib}-${r.arm}`), ['x-B', 'y-B']);
  assert.equal(L.batchRecord({ jobs: 1, runs: [], planOnly: true }).planOnly, true);
  assert.equal(L.batchRecord({ jobs: 1, runs: [] }).planOnly, false);
  // Repeated seeds are repeated batches: each seed's runs have a name of their own.
  assert.notEqual(L.runIdFor({ stamp: '2026-01-01T00-00-00', lib: 'x', arm: 'B', seed: '1' }), L.runIdFor({ stamp: '2026-01-01T00-00-00', lib: 'x', arm: 'B', seed: '2' }));
});

test('the b-plan scenario judges a plan-only result by the shape, the priced planner and the absence of any run', () => {
  const s = R.scenario('b-plan');
  const planned = { shape: structuredClone(s.expect.shape), plannerUsd: 0.0002, planningMs: 9000, protocolOk: true, protocolFailures: [] };
  const good = {
    planOnly: true, valid: false, invalidReasons: ['plan-only: the plan was made and nothing ran, so nothing was scored'],
    tests: null, scoredFrom: null, tasks: null, patches: [], baseline: null, truncated: { truncated: false, why: null },
    steps: { plan: { exit: 0 }, planCheck: { ok: true } }, closing: { stop: { exit: 0 } }, stopped: null, stalled: null,
    planned, recordedUsd: 0.0002, metrics: null, ending: { by: 'not-run', modelCalls: null }, providerSwitches: null,
  };
  assert.deepEqual(R.judgeRehearsal('b-plan', good), []);
  assert.match(R.judgeRehearsal('b-plan', { ...good, steps: { ...good.steps, run: { exit: 0 } } }).join(), /a run or a merge step/);
  assert.match(R.judgeRehearsal('b-plan', { ...good, tests: { passed: 1 } }).join(), /holds a score/);
  assert.match(R.judgeRehearsal('b-plan', { ...good, valid: true }).join(), /not valid for being plan-only/);
  assert.match(R.judgeRehearsal('b-plan', { ...good, planned: { ...planned, shape: { ...planned.shape, edges: 5 } } }).join(), /shape\.edges is 5, wanted 6/);
  assert.match(R.judgeRehearsal('b-plan', { ...good, planned: { ...planned, plannerUsd: 0 } }).join(), /planner's spend is 0/);
  assert.match(R.judgeRehearsal('b-plan', { ...good, planned: null }).join(), /no planned record/);
  // The expectation is the shape the harness computes for the plan the fake serves.
  assert.deepEqual(L.planStructure(s.plan()), s.expect.shape);
  assert.deepEqual(L.planDigest(s.plan()).tasks.map((t) => t.kind), ['research', 'change', 'script', 'change', 'ops', 'change']);
  const clean = { names: ['result.json', 'plan.json', 'plan-saved.json', 'ordewell.log'], digest: L.planDigest(s.plan()), expectedTitles: s.plan().tasks.map((t) => t.title) };
  assert.deepEqual(R.judgePlanOnlyDir(clean), []);
  assert.match(R.judgePlanOnlyDir({ ...clean, names: [...clean.names, 'arm-workdir', 'arm.patch'] }).join(), /arm-workdir.*arm\.patch/);
  assert.match(R.judgePlanOnlyDir({ ...clean, names: ['result.json'] }).join(), /no plan\.json/);
  // Nothing ran: the fake heard the planner alone.
  assert.deepEqual(R.judgePlayed('b-plan', [{ role: 'planner' }], playCtx), []);
  assert.match(R.judgePlayed('b-plan', [{ role: 'planner' }, { role: 'runner', key: 'edit' }], playCtx).join(), /runner turn was played/);
  assert.match(R.judgePlayed('b-plan', [], playCtx).join(), /never heard the planner/);
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
  assert.deepEqual(m.supervisor.actions, [{ kind: 'continue', command: 'continue', task: '#2', title: 'two', outcome: 'done', at: 'y' }]);
  assert.deepEqual(m.supervisor.actionsBy, { continue: 1 });
  assert.deepEqual(m.supervisor.wakes.map((w) => [w.at, w.updates]), [['x', 1], ['w', 1]]);
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

test('supervisorRecord counts every act the supervisor made, edits and words included, and what woke it', () => {
  const exec = (command, ref, outcome, at, extra = {}) => ({
    role: 'assistant', kind: 'execution', content: '', timestamp: at,
    execution: { command, actor: 'supervisor', level: 'act', ...(ref ? { task: { id: `id${ref}`, ref, title: `Task ${ref}` } } : {}), outcome, at, ...extra },
  });
  const said = (content, at) => ({ role: 'assistant', kind: 'supervisor', content, timestamp: at });
  const wake = (content, at) => ({ role: 'user', kind: 'wake_up', content, timestamp: at });
  const plan = {
    tasks: [{ id: 'a', order: 1, title: 'Implement the library' }, { id: 'b', order: 2, title: 'Note the rehearsal' }],
    conversationHistory: [
      wake('Run update:\n- task #1 "Implement the library" failed: nope; it blocks task #2 "Note the rehearsal"', 't1'),
      wake('Run update:\n- task #2 "Note the rehearsal" is waiting for input: May I?\nSince the last update:\n- task #3 "x" passed', 't1'),
      exec('retry_task', '#1', 'done', 't2'),
      exec('skip_task', '#2', 'done', 't3'),
      exec('stop_task', '#2', 'refused', 't4', { detail: 'not running' }),
      exec('stop_run', null, 'done', 't5'),
      exec('message_task', '#2', 'done', 't6', { detail: 'use the tests' }),
      exec('answer_checkpoint', '#2', 'done', 't7'),
      exec('answer_approval', '#2', 'declined', 't8'),
      exec('merge_all', null, 'done', 't9'),
      { role: 'assistant', kind: 'execution', content: '', timestamp: 't10', execution: { command: 'retry_task', actor: 'user', outcome: 'done', at: 't10' } },
      said('Tasks updated:\n- Updated "Implement the library" (prompt)\n- Added "A new task"\n- Removed "Gone"\n- Merged 2 tasks into "Note the rehearsal"\n- Re-armed "Implement the library"', 't11'),
      said('I left task #1 alone.', 't12'),
      { role: 'assistant', kind: 'plan_generated', content: 'Plan generated with 2 tasks.', timestamp: 't0' },
      wake('Run update:\n- Task #1 "Implement the library" is still failed after your turn, and 1 task waits on it. The run has ended, and an edit starts nothing: nothing runs until you release it. Release it: call retry_task', 't13'),
    ],
  };
  const s = L.supervisorRecord(plan);
  assert.equal(s.wakeUps, 3);
  assert.deepEqual(s.wakes, [
    { at: 't1', updates: 2, triggers: [{ kind: 'task_failed', task: '#1' }, { kind: 'waiting_input', task: '#2' }] },
    { at: 't13', updates: 1, triggers: [{ kind: 'failure_standing', task: '#1', closing: true }] },
  ]);
  assert.deepEqual(s.wakesBy, { task_failed: 1, waiting_input: 1, failure_standing: 1 });
  // The user's own call and the plan card are not the supervisor's.
  assert.deepEqual(s.actions.map((a) => [a.kind, a.task, a.outcome, a.at]), [
    ['retry_task', '#1', 'done', 't2'], ['skip_task', '#2', 'done', 't3'], ['stop_task', '#2', 'refused', 't4'], ['stop_run', null, 'done', 't5'],
    ['message_task', '#2', 'done', 't6'], ['answer_checkpoint', '#2', 'done', 't7'], ['answer_approval', '#2', 'declined', 't8'], ['merge_all', null, 'done', 't9'],
    ['plan_edit', '#1', 'done', 't11'], ['plan_edit', null, 'done', 't11'], ['plan_edit', null, 'done', 't11'], ['plan_edit', '#2', 'done', 't11'], ['plan_edit', '#1', 'done', 't11'],
    ['message', null, 'done', 't12'],
  ]);
  assert.deepEqual(s.actions.filter((a) => a.kind === 'plan_edit').map((a) => [a.op, a.title]), [
    ['updated', 'Implement the library'], ['added', 'A new task'], ['removed', 'Gone'], ['merged', 'Note the rehearsal'], ['re-armed', 'Implement the library'],
  ]);
  assert.equal(s.actions.find((a) => a.kind === 'stop_task').detail, 'not running');
  assert.deepEqual(s.actionsBy, { retry_task: 1, skip_task: 1, stop_task: 1, stop_run: 1, message_task: 1, answer_checkpoint: 1, answer_approval: 1, merge_all: 1, plan_edit: 5, message: 1 });
  // A session with no history holds nothing to count, which is not zero.
  assert.deepEqual(L.supervisorRecord({ tasks: [] }), { wakeUps: null, wakes: null, wakesBy: null, actions: null, actionsBy: null });
  assert.deepEqual(L.supervisorRecord({ tasks: [], conversationHistory: [] }), { wakeUps: 0, wakes: [], wakesBy: {}, actions: [], actionsBy: {} });
});

test('wakeTriggers names each kind of line a wake-up digest holds', () => {
  const one = (line) => L.wakeTriggers(`Run update:\n${line}`)[0];
  assert.deepEqual(one('- the run finished: 2 tasks'), { kind: 'run_finished', task: null });
  assert.deepEqual(one('- the run is idle: nothing is running and nothing can start. Task #2 "x" is on hold'), { kind: 'run_held', task: null });
  assert.deepEqual(one('- task #1.1 "x" is waiting for approval: run it'), { kind: 'waiting_approval', task: '#1.1' });
  assert.deepEqual(one('- task #1 "x" has gone quiet (3 min)'), { kind: 'task_idle', task: '#1' });
  assert.deepEqual(one('- task #1 "x" has run long: 40 min running, past its 20 min threshold'), { kind: 'running_long', task: '#1' });
  assert.deepEqual(one('- task #1 "x" finished, but its work conflicts and could not land: a.py'), { kind: 'landing_conflict', task: '#1' });
  assert.deepEqual(one('- task #1 "x" passed, but git refused to land its work, which is kept'), { kind: 'landing_failed', task: '#1' });
  assert.deepEqual(one('- task #1 "x"\'s runner asked for something nobody here may allow, and was denied'), { kind: 'approval_denied', task: '#1' });
  assert.deepEqual(one('- openrouter\'s usage limit paused a task, which waits for a retry: #1 "x"'), { kind: 'usage_limit', task: null });
  assert.deepEqual(one('- Task #1 "x" is still failed after your turn, and 1 task waits on it. Release it: skip_task'), { kind: 'failure_standing', task: '#1' });
  assert.deepEqual(one('- task #2 "x", whose result you asked for, has ended. passed'), { kind: 'task_report', task: '#2' });
  assert.deepEqual(one('- something new'), { kind: 'other', task: null });
  assert.deepEqual(L.wakeTriggers('no bullet at all'), []);
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
    for (const f of ['batch.mjs', 'lib.mjs', 'rehearsal.mjs']) fs.copyFileSync(path.join(here, f), path.join(copy, 'commit0', f));
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

// --- Reading a live run -------------------------------------------------------

/** The daemon's `GET /api/sessions/:id` as SESSION_VIEW_JS prints it, for a session the pool holds. */
const daemonSession = ({ tasks, activity, approved = true, plannerUsage } = {}) => ({
  status: 200,
  body: {
    meta: { id: 's1', goal: 'g' },
    // The phase-tagged plan the route serves: its tasks split between the log and the pending list.
    plan: { phase: 'executing', executionLog: [], pendingTasks: tasks.map(({ subtasks: _subtasks, ...t }) => t), approved, approvedTasks: tasks.map((t) => t.id), status: 'approved' },
    ...(plannerUsage ? { conversation: { plannerUsage } } : {}),
    run: { tasks, runMerge: null, handoff: null, mergeResult: null, activity: { starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: false, ...activity } },
  },
});

/** Polls a run every 30 s for `minutes`, nothing moving, and says whether it ever settled. */
const settlesWithin = (view, minutes, usageLines = 7) => {
  const fingerprint = L.planFingerprint(view.plan, usageLines);
  let state = null;
  for (let nowMs = 0; nowMs <= minutes * 60_000; nowMs += 30_000) {
    const d = L.settleDecision({ ...view, fingerprint, nowMs, state });
    if (d.settled) return true;
    state = d.state;
  }
  return false;
};

test('a run whose task is in progress, with no model call for twenty minutes, is not settled', () => {
  const task = { id: 't1', order: 1, title: 'Implement', type: 'ai', status: 'in_progress', attempted: true, subtasks: [] };
  const view = L.liveView({ response: daemonSession({ tasks: [task], activity: { running: true, scheduled: true, advancesOnItsOwn: true } }), saved: null });
  assert.equal(view.source, 'daemon');
  assert.equal(view.plan.tasks[0].status, 'in_progress', 'the daemon\'s word on the task, not a loader\'s');
  assert.equal(settlesWithin(view, 20), false, 'a long shell command or a stream-idle retry was cut off as a quiet run');
  // An attempt the daemon counts live while its task reads otherwise (landing, starting) is no quieter.
  const landing = L.liveView({ response: daemonSession({ tasks: [{ ...task, status: 'completed' }], activity: { running: true } }), saved: null });
  assert.equal(settlesWithin(landing, 20), false, 'an attempt still running settled');
  const starting = L.liveView({ response: daemonSession({ tasks: [{ ...task, status: 'failed' }], activity: { starting: true } }), saved: null });
  assert.equal(settlesWithin(starting, 20), false, 'a start on its way settled');
  const resuming = L.liveView({ response: daemonSession({ tasks: [{ ...task, status: 'awaiting_user', awaitingReason: 'usage-limit' }], activity: { resumable: true, advancesOnItsOwn: true } }), saved: null });
  assert.equal(settlesWithin(resuming, 20), false, 'a run that resumes by itself settled');
  // Core's endedOnFailure: resumable, yet nothing advances until a retry nobody in arm A gives (found by the rehearsal).
  const endedOnFailure = L.liveView({ response: daemonSession({ tasks: [{ ...task, status: 'failed', attempted: true }], activity: { resumable: true, advancesOnItsOwn: false } }), saved: null });
  assert.equal(settlesWithin(endedOnFailure, 20), true, 'a run that ended on a failure never settled, so it ran to the wall cap');
});

test('a run whose tasks have all ended settles once nothing moved for the settle time', () => {
  const tasks = [
    { id: 't1', order: 1, title: 'one', type: 'ai', status: 'completed', attempted: true, subtasks: [], attemptUsage: [{ totals: { reportedCost: { USD: 0.25 } } }] },
    { id: 't2', order: 2, title: 'two', type: 'ai', status: 'failed', attempted: true, subtasks: [] },
  ];
  const view = L.liveView({ response: daemonSession({ tasks, activity: { scheduled: true }, plannerUsage: { totals: { reportedCost: { USD: 0.5 } } } }), saved: null });
  assert.equal(settlesWithin(view, (L.SETTLE_MS / 60_000) - 0.5), false, 'settled before the settle time');
  assert.equal(settlesWithin(view, L.SETTLE_MS / 60_000), true);
  // The caps read the daemon's view too: the planner's spend and every attempt's.
  assert.equal(L.recordedSpend(view.plan).usd, 0.75);
});

test('a run waiting on a person follows the stall rule and does not settle', () => {
  const tasks = [
    { id: 't1', order: 1, title: 'one', type: 'ai', status: 'completed', attempted: true, subtasks: [] },
    { id: 't2', order: 2, title: 'two', type: 'ai', status: 'awaiting_user', awaitingReason: 'checkpoint', attempted: true, subtasks: [] },
  ];
  const view = L.liveView({ response: daemonSession({ tasks }), saved: null });
  assert.equal(settlesWithin(view, 30), false, 'a wait on a person settled');
  const stallMs = 15 * 60_000;
  const first = L.stallDecision({ plan: view.plan, nowMs: 0, sinceMs: null, stallMs });
  assert.equal(first.stalled, null);
  assert.equal(L.stallDecision({ plan: view.plan, nowMs: stallMs, sinceMs: first.sinceMs, stallMs }).stalled.waiting, 'checkpoint');
});

test('without the daemon\'s run the saved session is read as written, a task in progress still in progress', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-saved-'));
  try {
    const dir = path.join(ws, '.ordewell', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const plan = { tasks: [{ id: 't1', title: 'Implement', type: 'ai', status: 'in_progress', attempted: true }], status: 'approved', runners: [], generatedAt: 'x', lastUpdated: 'x' };
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ meta: { id: 'other' }, plan: { tasks: [] } }));
    fs.writeFileSync(path.join(dir, '2026-11-17-s1.json'), JSON.stringify({ meta: { id: 's1', goal: 'g' }, plan }));
    const read = (id) => JSON.parse(execFileSync(process.execPath, ['-e', L.SAVED_PLAN_JS, ws, id], { encoding: 'utf8' }));
    assert.deepEqual(read('s1'), plan, 'the saved plan, nothing settled on it');
    assert.equal(read('missing'), null);
    for (const response of [{ error: 'no daemon token: the daemon is not running' }, { status: 200, body: { meta: { id: 's1' }, plan: { phase: 'executing' } } }]) {
      const view = L.liveView({ response, saved: read('s1') });
      assert.equal(view.source, 'saved');
      assert.equal(view.run, null);
      assert.equal(settlesWithin(view, 20), false, 'an attempt the file still holds in progress settled');
    }
    assert.equal(L.liveView({ response: { error: 'x' }, saved: null }).plan, null);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('the harness never reads a session through core\'s loader, which fails every task in progress in what it returns', () => {
  for (const file of ['lib.mjs', 'drive.mjs', 'batch.mjs']) {
    const src = fs.readFileSync(path.join(here, file), 'utf8');
    assert.doesNotMatch(src, /\bloadSession(PlanState)?\s*\(|getLatestSession\s*\(|loadChildSession\s*\(/, `${file} reads a session through core's loader`);
  }
});

// --- The rehearsal: its scripts' own logic; the Docker run only when asked ---

const R = await import('./rehearsal.mjs');
const playCtx = { src: 'tlslite', tests: 'unit_tests', longSec: 85 };
const runnerRequest = (messages) => ({ tools: [{ function: { name: 'shell' } }, { function: { name: 'task_complete' } }], messages });
const toolRound = (name) => [{ role: 'assistant', tool_calls: [{ function: { name } }] }, { role: 'tool', content: 'ok' }];

test('parseArgs takes a rehearsal and its shortened windows, never with --run, and spends nothing', () => {
  const o = L.parseArgs(['--rehearse', 'a-done', '--libs', 'x.json', '--settle-min', '1', '--poll-sec', '5', '--no-start-min', '3', '--wall-min', '25']);
  assert.equal(o.rehearse, 'a-done');
  assert.equal(o.run, false, 'a rehearsal is not a paid run');
  assert.deepEqual([o.settleMin, o.pollSec, o.noStartMin, o.wallCapMs], [1, 5, 3, 25 * 60_000]);
  assert.throws(() => L.parseArgs(['--rehearse', 'a-done', '--run', '--libs', 'x.json']), /--rehearse/);
  assert.throws(() => L.parseArgs(['--rehearse', 'A Done', '--libs', 'x.json']), /scenario name/);
  // A paid run keeps the defaults: the settle window is the one the D5 fix set.
  assert.equal(L.parseArgs(['--dry-run', '--libs', 'x.json']).settleMin, null);
});

test('a rehearsal refuses every real credential in its environment, and only its own placeholder passes', () => {
  assert.deepEqual(R.realKeysIn({ OPENROUTER_API_KEY: 'sk-or-1', ANTHROPIC_API_KEY: 'a', GH_TOKEN: 'g', CLAUDE_CODE_OAUTH_TOKEN: 'c', PATH: '/bin' }),
    ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'OPENROUTER_API_KEY']);
  assert.deepEqual(R.realKeysIn({ OPENROUTER_API_KEY: R.FAKE_KEY, OPENAI_API_KEY: '' }), []);
  // The placeholder must not hold a word the run's output uses, or Ordewell's redaction hides that word.
  assert.doesNotMatch(R.FAKE_KEY, /rehears|commit0|ordewell/i);
});

test('the long command outlasts the settle window by more than two polls, and every scenario names a known arm and windows', () => {
  for (const w of [R.WINDOWS, { settleMin: 5, pollSec: 30 }]) assert.ok(R.longCommandSec(w) > w.settleMin * 60 + 2 * w.pollSec);
  for (const name of R.scenarioNames()) {
    const s = R.scenario(name);
    assert.ok(['A', 'A-continued', 'B'].includes(s.arm), name);
    const args = R.windowArgs(s);
    const o = L.parseArgs(['--rehearse', name, '--libs', 'x.json', ...L.driveArmArgs(L.ARMS[s.arm]), ...args]);
    assert.equal(o.settleMin, R.WINDOWS.settleMin, name);
    if (s.capUsd) assert.equal(o.capUsd, s.capUsd, name);
    assert.ok(R.longCommandSec(R.WINDOWS) < (s.windows?.wallMin ?? R.WINDOWS.wallMin) * 60, `${name}: the long command outlasts the wall cap`);
  }
  assert.throws(() => R.scenario('nope'), /no rehearsal scenario nope/);
});

test('the fake routes a runner\'s attempts by its task key and round, and an attempt past its script stops in prose', () => {
  const state = R.createState();
  const steps = R.scenario('b-retry').attempts(playCtx).edit;
  const brief = { role: 'user', content: 'Implement the library. [rehearsal:edit]' };
  const first = R.turnFor('b-retry', runnerRequest([brief]), state, playCtx);
  assert.deepEqual([first.role, first.key, first.attempt, first.round, first.toolCall.name], ['runner', 'edit', 1, 0, steps[0][0].tool]);
  const later = R.turnFor('b-retry', runnerRequest([brief, ...toolRound('shell')]), state, playCtx);
  assert.equal(later.round, 1);
  assert.equal(later.toolCall.name, 'write');
  assert.match(later.toolCall.args.path, /^tlslite\/_commit0_rehearsal\.py$/, 'the new module goes inside the library');
  // A request with no tool round opens the next attempt, whose script is the retry's.
  const retry = R.turnFor('b-retry', runnerRequest([brief]), state, playCtx);
  assert.equal(retry.attempt, 2);
  const past = R.turnFor('b-retry', runnerRequest([brief, ...Array.from({ length: 40 }, () => toolRound('shell')).flat()]), state, playCtx);
  assert.equal(past.toolCall, undefined);
  assert.equal(past.content, 'Done.');
  // Arm A's one task carries no key.
  assert.equal(R.taskKeyOf([{ role: 'user', content: 'Implement the tlslite-ng library' }]), 'A');
  assert.equal(R.turnFor('a-failed', runnerRequest([{ role: 'user', content: 'x' }]), R.createState(), playCtx).toolCall.args.command, `timeout 85 tail -f /dev/null; echo slept 85s`);
});

test('the edits change a source file, add a module inside the library and edit a test, and the failing script reports failed', () => {
  const steps = R.editSteps(playCtx);
  const said = JSON.stringify(steps);
  assert.match(said, /tar -xf \/tmp\/commit0-rehearsal-reference\.tar/);
  assert.match(said, /tlslite\/__init__\.py/, 'the package imports the new module, so scoring that drops it breaks every import');
  assert.match(said, /find unit_tests -name 'test_\*\.py'/);
  const [attempt] = R.scenario('a-failed').attempts(playCtx).A;
  assert.equal(attempt[0].tool, 'shell');
  assert.match(attempt[0].args.command, /^timeout \d+ tail -f \/dev\/null; echo slept/);
  assert.ok(attempt[0].args.timeout > 85_000, 'the shell tool\'s own timeout would cut the long command short');
  assert.deepEqual(attempt.at(-1).args.status, 'failed');
});

test('the planner plays the plan once; after it the conversation is the supervisor, which plays each rule once and closes in prose', () => {
  const state = R.createState();
  const plan = R.turnFor('b-retry', { tools: [{ function: { name: 'retry_task' } }], messages: [{ role: 'user', content: 'the goal' }] }, state, playCtx);
  assert.equal(plan.role, 'planner', 'a planner offered retry_task is still the planner before its plan');
  const json = JSON.parse(/```json\n([\s\S]*)\n```/.exec(plan.content)[1]);
  assert.deepEqual(L.judgePlan(json).ok, true, 'the driver refuses a plan that breaks the protocol');
  assert.deepEqual(json.tasks[1].dependencies, [json.tasks[0].id]);
  assert.match(json.tasks[1].prompt, /\[rehearsal:after\]/);

  // As core's wake-up turn shows the plan: one line per task, its status in brackets, under protocol text that names checkpoints and failures.
  const line = (n, title, status) => `#${n} id=${json.tasks[n - 1].id} "${title}" [${status}] type:AI runner:openrouter autonomy:AFK slice:AFK deps:[]`;
  const protocol = 'Answer a checkpoint with answer_checkpoint; a failed task blocks what depends on it.';
  const planBlock = (...lines) => `<current_plan>\n${lines.join('\n')}\n</current_plan>\n${protocol}`;
  const history = [{ role: 'user', content: 'the goal' }, { role: 'assistant', content: plan.content }];
  const wake = (content, after = []) => R.turnFor('b-retry', { tools: [], messages: [...history, { role: 'user', content }, ...after] }, state, playCtx);
  assert.equal(wake(planBlock(line(1, 'Implement the library', 'in_progress'), line(2, 'Note the rehearsal', 'approved'))).toolCall, undefined,
    'the protocol\'s own words are no event: nothing is failed or waiting');
  const failed = wake(planBlock(line(1, 'Implement the library', 'failed'), line(2, 'Note the rehearsal', 'approved')));
  assert.equal(failed.role, 'supervisor');
  assert.deepEqual([failed.toolCall.name, failed.toolCall.args.task, failed.toolCall.args.from], ['retry_task', '#1', 'fresh'], 'a fresh attempt opens a new runner conversation, which the fake counts as attempt 2');
  assert.ok(failed.toolCall.args.message, 'its note is the change the identical-retry guard lets through');
  const retried = [{ role: 'assistant', tool_calls: [{}] }, { role: 'tool', content: 'retried' }];
  assert.equal(wake(planBlock(line(1, 'Implement the library', 'failed')), retried).content, 'Done.', 'after the tool\'s answer, with nothing else to play, it closes in prose');
  assert.equal(wake(planBlock(line(1, 'Implement the library', 'failed'))).toolCall, undefined, 'a rule plays once');
  const asked = wake(planBlock(line(1, 'Implement the library', 'completed'), line(2, 'Note the rehearsal', 'awaiting_user')));
  assert.deepEqual([asked.toolCall.name, asked.toolCall.args.task, asked.toolCall.args.answer], ['answer_checkpoint', '#2', 'approve']);

  // A wake that holds both plays both: the second after the first's answer, in the same turn.
  const both = R.createState();
  both.planned = true;
  const two = planBlock(line(1, 'Implement the library', 'failed'), line(2, 'Note the rehearsal', 'awaiting_user'));
  const first = R.turnFor('b-retry', { tools: [], messages: [{ role: 'user', content: two }] }, both, playCtx);
  const second = R.turnFor('b-retry', { tools: [], messages: [{ role: 'user', content: two }, ...retried] }, both, playCtx);
  assert.deepEqual([first.toolCall?.name, second.toolCall?.name].sort(), ['answer_checkpoint', 'retry_task']);
  // Left alone, a failure stays failed: the closing turn plays nothing, and the second wake, for the failure left standing, is answered in prose too.
  const leave = R.createState();
  leave.planned = true;
  assert.equal(R.turnFor('b-leave', { tools: [], messages: [{ role: 'user', content: planBlock(line(1, 'Implement the library', 'failed')) }] }, leave, playCtx).toolCall, undefined);
  const again = R.turnFor('b-leave', { tools: [], messages: [{ role: 'user', content: 'Run update:\n- Task #1 "Implement the library" is still failed after your turn, and 1 task waits on it.' }] }, leave, playCtx);
  assert.equal(again.toolCall, undefined);
  assert.match(again.content, /leaves task #1 failed/);

  // The edit-then-retry scenario: the closing turn edits the failed task, keeping the key the fake routes by; only the second wake retries.
  const er = R.createState();
  er.planned = true;
  const closing = planBlock(line(1, 'Implement the library', 'failed'), line(2, 'Note the rehearsal', 'approved'));
  const edit = R.turnFor('b-edit-retry', { tools: [], messages: [{ role: 'user', content: closing }] }, er, playCtx);
  assert.equal(edit.toolCall, undefined, 'the built-in planner edits by a JSON reply: it has no edit_plan tool');
  const ops = JSON.parse(/```json\n([\s\S]*)\n```/.exec(edit.content)[1]).taskOps;
  assert.deepEqual([ops[0].op, ops[0].taskId], ['update', '#1']);
  assert.match(ops[0].changes.prompt, /\[rehearsal:edit\]/);
  assert.equal(R.turnFor('b-edit-retry', { tools: [], messages: [{ role: 'user', content: closing }, ...retried] }, er, playCtx).toolCall, undefined, 'the closing turn retries nothing');
  const standingWake = `Run update:\n- Task #1 "Implement the library" is still failed after your turn, and 1 task waits on it.\n${closing}`;
  assert.equal(R.turnFor('b-edit-retry', { tools: [], messages: [{ role: 'user', content: standingWake }] }, er, playCtx).toolCall.name, 'retry_task');
});

test('the fake streams a tool call and its usage as OpenRouter does, and lists the bench\'s model', () => {
  const body = R.sseBody({ toolCall: { name: 'shell', args: { command: 'ls' } }, costUsd: 0.25 });
  const chunks = body.split('\n\n').filter((c) => c.startsWith('data: ') && c !== 'data: [DONE]').map((c) => JSON.parse(c.slice(6)));
  const call = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])[0];
  assert.equal(call.function.name, 'shell');
  assert.deepEqual(JSON.parse(call.function.arguments), { command: 'ls' });
  assert.equal(chunks.find((c) => c.choices?.[0]?.finish_reason)?.choices[0].finish_reason, 'tool_calls');
  assert.equal(chunks.find((c) => c.usage)?.usage.cost, 0.25, 'the spend cap reads the usage the fake reports');
  assert.ok(body.endsWith('data: [DONE]\n\n'));
  const listing = R.modelsBody({ modelId: 'deepseek/deepseek-v4.1-flash', contextLength: 1048576 });
  assert.equal(listing.data[0].id, 'deepseek/deepseek-v4.1-flash');
  assert.equal(listing.data[0].context_length, 1048576);
});

test('judgeRehearsal holds a result.json to its scenario, and judgePlayed to the steps the fake played', () => {
  const passing = {
    valid: true, scoredFrom: 'task-worktree', truncated: { truncated: true, why: 'settled with 1 task open: 1 nothing ready ("x" failed)' }, stopped: null,
    tasks: [{ status: 'failed' }], tests: { passed: 1653, collectionErrors: [] }, baseline: { passed: 11 },
    excluded: [{ path: 'unit_tests/test_x.py', reason: 'a test: the reference\'s is kept' }],
    steps: { run: { exit: 2, ended: 'by itself' } },
    ending: { by: 'completion', status: 'failed', reason: 'The rehearsal fails this task on purpose.', modelCalls: { used: 3, limitPerAttempt: 1000, reachedLimit: false } },
    providerSwitches: { attempts: 1, withProvider: 0, attemptsSwitched: 0, switches: 0 },
    callBudget: 1000, stepLimit: 1000, referenceUsd: 0.1, referenceSpend: { priceTable: { id: 'ref-1' } },
  };
  assert.deepEqual(R.judgeRehearsal('a-failed', passing), []);
  // The ending is the scenario's: another status, another reason, another way to stop, no calls for arm A, calls for arm B, a switch the fake never makes, or no field at all.
  assert.match(R.judgeRehearsal('a-failed', { ...passing, ending: { ...passing.ending, status: 'blocked' } }).join(), /ending\.status is "blocked", wanted "failed"/);
  assert.match(R.judgeRehearsal('a-failed', { ...passing, ending: { ...passing.ending, reason: null } }).join(), /ending\.reason is null/);
  assert.match(R.judgeRehearsal('a-failed', { ...passing, ending: { by: 'settle', open: [], modelCalls: passing.ending.modelCalls } }).join(), /ending\.by is "settle", wanted "completion"/);
  assert.match(R.judgeRehearsal('a-failed', { ...passing, ending: { ...passing.ending, modelCalls: null } }).join(), /ending\.modelCalls is null/);
  assert.match(R.judgeRehearsal('a-failed', { ...passing, providerSwitches: { attempts: 1, withProvider: 1, attemptsSwitched: 1, switches: 2 } }).join(), /providerSwitches is/);
  assert.match(R.judgeRehearsal('a-failed', { ...passing, ending: undefined }).join(), /holds no ending/);
  const wrongTree = R.judgeRehearsal('a-failed', { ...passing, scoredFrom: 'merged', tests: { passed: 11, collectionErrors: ['tlslite/_commit0_rehearsal.py'] } });
  assert.equal(wrongTree.length, 3, wrongTree.join('; '));
  assert.match(R.judgeRehearsal('a-failed', { ...passing, truncated: { truncated: true, why: 'cap: wall-clock' }, stopped: { why: 'wall-clock' } }).join('; '), /cap: wall-clock.*stopped by wall-clock/);
  assert.match(R.judgeRehearsal('a-done', { ...passing, scoredFrom: 'merged', truncated: { truncated: false }, tasks: [{ status: 'completed' }], steps: { run: { exit: 0, ended: 'by the stop' } } }).join(), /not by itself/);
  assert.match(R.judgeRehearsal('b-leave', { ...passing, truncated: { truncated: true, why: 'settled with 2 tasks open' }, stalled: {}, tasks: [{ status: 'completed' }, { status: 'completed' }] }).join(), /every task is completed/);
  // An unanswered checkpoint is the stall rule's: a person waited on with nothing running.
  const waited = {
    ...passing, truncated: { truncated: true, why: 'stalled: waiting on checkpoint' }, stopped: null,
    stalled: { task: { id: 'x', title: 'Implement' }, waiting: 'checkpoint', question: 'q', sinceMs: 120_000 }, tasks: [{ status: 'awaiting_user' }],
    ending: { by: 'stall', waiting: 'checkpoint', modelCalls: passing.ending.modelCalls },
  };
  assert.deepEqual(R.judgeRehearsal('a-stall', waited), []);
  assert.match(R.judgeRehearsal('a-stall', { ...waited, truncated: { truncated: true, why: 'settled with 1 task open: 1 waiting on a person' }, stalled: { why: 'settled', open: [] } }).join(), /wanted \/\^stalled: waiting on checkpoint/);
  assert.match(R.judgeRehearsal('a-stall', { ...waited, tasks: [{ status: 'completed' }] }).join(), /every task is completed/);
  const held = { status: 'failed', held: 'nothing ready', reason: 'failed' };
  const standing = (at) => ({ at, updates: 1, triggers: [{ kind: 'failure_standing', task: '#1', closing: true }] });
  const leaving = { wakeUps: 2, wakes: [{ at: '2026-01-01T00:00:00.000Z', updates: 1, triggers: [{ kind: 'run_finished', task: null }] }, standing('2026-01-01T00:01:00.000Z')], actions: [{ kind: 'message', at: 'a', outcome: 'done' }] };
  const leftAlone = {
    metrics: { supervisor: leaving },
    ...passing, ending: { ...passing.ending, modelCalls: null }, scoredFrom: 'merged', truncated: { truncated: true, why: 'settled with 2 tasks open: 2 nothing ready' }, tests: { passed: 11, collectionErrors: [] },
    stalled: { why: 'settled', open: [held, { status: 'approved', held: 'nothing ready', reason: 'depends on 1 (failed)' }] }, tasks: [{ status: 'failed' }, { status: 'approved' }],
  };
  assert.deepEqual(R.judgeRehearsal('b-leave', leftAlone), []);
  assert.match(R.judgeRehearsal('b-leave', { ...leftAlone, tests: { passed: 1653 } }).join(), /1653 passed, not the baseline's 11: work that never landed was scored/);
  assert.match(R.judgeRehearsal('b-leave', { ...leftAlone, stalled: { why: 'settled', open: [held] } }).join(), /1 task\(s\) held open, wanted 2/);
  // What the supervisor did is judged from the metrics: a retry the scenario never plays, or no wake for the failure left standing, fails.
  assert.match(R.judgeRehearsal('b-leave', { ...leftAlone, metrics: { supervisor: { ...leaving, actions: [{ kind: 'retry_task', at: 'a', outcome: 'done' }] } } }).join(), /acts are \["retry_task"\], wanted \[\]/);
  assert.match(R.judgeRehearsal('b-leave', { ...leftAlone, metrics: { supervisor: { ...leaving, wakes: leaving.wakes.slice(0, 1) } } }).join(), /0 wake\(s\) for a failure the closing turn left, wanted 1/);
  assert.match(R.judgeRehearsal('b-leave', { ...leftAlone, metrics: { supervisor: { ...leaving, wakes: [...leaving.wakes, standing('2026-01-01T00:02:00.000Z')], wakeUps: 3 } } }).join(), /2 wake\(s\) for a failure the closing turn left, wanted 1/);
  assert.match(R.judgeRehearsal('b-leave', { ...leftAlone, metrics: { supervisor: { ...leaving, wakes: [{ at: 'x', updates: 1, triggers: [{ kind: 'other', task: null }] }, standing('y')] } } }).join(), /trigger the harness cannot read/);
  assert.match(R.judgeRehearsal('b-leave', { ...leftAlone, metrics: null }).join(), /no actions or wakes/);
  const edited = { wakeUps: 3, wakes: [leaving.wakes[0], standing('2026-01-01T00:01:00.000Z')],
    actions: [{ kind: 'plan_edit', at: '2026-01-01T00:00:30.000Z', outcome: 'done' }, { kind: 'message', at: '2026-01-01T00:00:40.000Z', outcome: 'done' }, { kind: 'retry_task', at: '2026-01-01T00:01:10.000Z', outcome: 'done' }] };
  assert.deepEqual(R.judgeSupervision(R.scenario('b-edit-retry').supervision, edited), []);
  assert.match(R.judgeSupervision(R.scenario('b-edit-retry').supervision, { ...edited, actions: [edited.actions[0], { ...edited.actions[2], at: '2026-01-01T00:00:50.000Z' }] }).join(), /did not follow the closing wake/);
  assert.match(R.judgeSupervision(R.scenario('b-edit-retry').supervision, { ...edited, actions: edited.actions.slice(1) }).join(), /acts are \["retry_task"\], wanted \["plan_edit","retry_task"\]/);
  assert.match(R.judgeRehearsal('b-cap', { ...passing, scoredFrom: 'merged', truncated: { truncated: true, why: 'cap: spend' }, stopped: { why: 'spend' }, tasks: [{ status: 'completed' }], steps: { run: { ended: 'by itself' }, merge: { exit: 0 } } }).join(), /driver had to stop it/);
  assert.deepEqual(R.judgeRehearsal('a-done', null), ['no result.json']);

  const steps = R.scenario('a-failed').attempts(playCtx).A[0];
  const last = { role: 'runner', key: 'A', attempt: 1, round: steps.length - 1, toolCall: { name: 'task_complete' } };
  assert.deepEqual(R.judgePlayed('a-failed', [last], playCtx), []);
  assert.match(R.judgePlayed('a-failed', [{ ...last, round: 0, toolCall: { name: 'shell' } }], playCtx).join(), /never played/);
  assert.match(R.judgePlayed('b-retry', [], playCtx).join(), /supervisor never played retry_task/);
  // b-cap's stop must land mid-attempt: its spending task began, and never reached its last step.
  const capSteps = R.scenario('b-cap').attempts(playCtx);
  const played = (key, steps) => steps.map((st, round) => ({ role: 'runner', key, attempt: 1, round, toolCall: { name: st.tool } }));
  const editDone = played('edit', capSteps.edit[0]);
  assert.deepEqual(R.judgePlayed('b-cap', [...editDone, ...played('spend', capSteps.spend[0]).slice(0, 2)], playCtx), []);
  assert.match(R.judgePlayed('b-cap', [...editDone, ...played('spend', capSteps.spend[0])], playCtx).join(), /task spend, attempt 1: its last scripted step \(task_complete\) was played: the stop did not cut it short/);
  assert.match(R.judgePlayed('b-cap', editDone, playCtx).join(), /task spend never started/);
});

// What core's renderLandingBeside writes for a lone repository, and what a task is first told.
const TAKE_IN_COMMAND = `git merge --no-edit -m 'Merge: Build on the library (take in landed work)' ordewell/run1/integration`;
const landingBlock = (command = TAKE_IN_COMMAND) => `Build on the library. [rehearsal:consumer]\n\n${R.LANDING_HEADING}\n\nIf that work has landed, commit your work and take it in with \`${command}\`; resolve any conflict.`;

test('the fake reads a step\'s command out of the task\'s own first message, and a message with none makes a failing step', () => {
  const state = R.createState();
  const steps = R.scenario('b-take-in').attempts(playCtx).consumer[0];
  const at = steps.findIndex((s) => s.fromPrompt);
  assert.ok(at > 0, 'the take-in comes after the long step, so the producer has landed');
  assert.equal(steps[0].args.command, 'timeout 85 tail -f /dev/null; echo slept 85s');
  const brief = { role: 'user', content: landingBlock() };
  const turnAt = (messages, round) => R.turnFor('b-take-in', runnerRequest([...messages, ...Array.from({ length: round }, () => toolRound('shell')).flat()]), state, playCtx);
  const turn = turnAt([{ role: 'system', content: 'a system prompt that says take it in with `not this`' }, brief], at);
  assert.deepEqual([turn.key, turn.round, turn.toolCall.name, turn.toolCall.args.command, turn.fromPrompt], ['consumer', at, 'shell', TAKE_IN_COMMAND, TAKE_IN_COMMAND]);
  const none = turnAt([{ role: 'user', content: 'Build on the library. [rehearsal:consumer]' }], at);
  assert.match(none.toolCall.args.command, /exit 3$/);
  assert.equal(none.fromPrompt, null);
  // The producer has no such step, and the commit comes before the take-in so that the merge is a merge.
  assert.equal(R.scenario('b-take-in').attempts(playCtx).producer[0].some((s) => s.fromPrompt), false);
  assert.match(steps[at - 1].args.command, /git commit/);
  assert.deepEqual(R.scenario('b-take-in').takeIn, { key: 'consumer', ownSubject: 'Note the rehearsal consumer', landed: 'Implement the library' });
});

test('judgeTakeIn wants the heading and the command in the consumer\'s first message, every step to exit 0, and the merge commit on the integration branch', () => {
  const steps = R.scenario('b-take-in').attempts(playCtx).consumer[0];
  const at = steps.findIndex((s) => s.fromPrompt);
  const exit = (n) => ({ role: 'tool', content: `taken\n[exit code ${n}]` });
  const log = ({ exits = {}, first = landingBlock() } = {}) => steps.map((st, round) => ({
    messages: [{ role: 'system', content: 's' }, { role: 'user', content: first }, ...(round > 0 ? [exit(exits[round - 1] ?? 0)] : [])],
    turn: { role: 'runner', key: 'consumer', attempt: 1, round, toolCall: { name: st.tool }, ...(st.fromPrompt ? { fromPrompt: TAKE_IN_COMMAND } : {}) },
  })).concat([{ messages: [{ role: 'user', content: first }, exit(exits[steps.length - 1] ?? 0)], turn: { role: 'runner', key: 'consumer', attempt: 1, round: steps.length, content: 'Done.' } }]);
  // As the merged work's git log reads: the consumer's landing holds the take-in, which joins its own commit and the producer's landing.
  const history = [
    { sha: 'l', parents: ['p', 'm'], subject: 'Merge: Build on the library' },
    { sha: 'm', parents: ['b', 'p'], subject: 'Merge: Build on the library (take in landed work)' },
    { sha: 'p', parents: ['a', 'x'], subject: 'Merge: Implement the library' },
    { sha: 'x', parents: ['a'], subject: 'Implement the library' },
    { sha: 'b', parents: ['a'], subject: 'Note the rehearsal consumer' },
    { sha: 'a', parents: [], subject: 'Commit0 base' },
  ];
  assert.deepEqual(R.judgeTakeIn('b-take-in', log(), playCtx, history), []);
  assert.match(R.judgeTakeIn('b-take-in', log({ first: 'Build on the library. [rehearsal:consumer]' }), playCtx, history).join(), /holds no "## Work landing beside yours" block/);
  assert.match(R.judgeTakeIn('b-take-in', log({ exits: { [at]: 1 } }), playCtx, history).join(), /the take-in command exited 1, wanted 0/);
  assert.match(R.judgeTakeIn('b-take-in', log({ exits: { [at + 1]: 1 } }), playCtx, history).join(), /test -f tlslite\/_commit0_rehearsal\.py.* exited 1/);
  assert.match(R.judgeTakeIn('b-take-in', log().filter((r) => r.turn.round !== at), playCtx, history).join(), /gives no command to take the work in with/);
  assert.match(R.judgeTakeIn('b-take-in', [], playCtx, history).join(), /task consumer never made a request/);
  // A fast-forward leaves no merge commit; a merge of another subject is not the take-in.
  const without = history.filter((c) => c.sha !== 'm');
  assert.match(R.judgeTakeIn('b-take-in', log(), playCtx, without).join(), /holds no merge commit "Merge: \.\.\. \(take in landed work\)"/);
  const swap = (sha, change) => history.map((c) => (c.sha === sha ? { ...c, ...change } : c));
  assert.match(R.judgeTakeIn('b-take-in', log(), playCtx, swap('m', { parents: ['b'] })).join(), /holds no merge commit/);
  // The take-in must join the consumer's own commit and the producer's landing, and the consumer's landing must hold it.
  assert.match(R.judgeTakeIn('b-take-in', log(), playCtx, swap('m', { parents: ['a', 'p'] })).join(), /first parent is "Commit0 base", wanted the consumer's own commit/);
  assert.match(R.judgeTakeIn('b-take-in', log(), playCtx, swap('m', { parents: ['b', 'a'] })).join(), /second parent is "Commit0 base", wanted the landing of "Implement the library"/);
  assert.match(R.judgeTakeIn('b-take-in', log(), playCtx, swap('l', { parents: ['p', 'b'] })).join(), /does not hold it/);
  assert.match(R.judgeTakeIn('b-take-in', log(), playCtx, null).join(), /could not be read/);
  assert.deepEqual(R.judgeTakeIn('b-cap', [], playCtx, null), [], 'a scenario with no take-in has nothing to judge');
  // The scenario is judged as b-retry is: both tasks completed and merged work scored above the baseline.
  const e = R.scenario('b-take-in').expect;
  assert.deepEqual([e.scoredFrom, e.tasks, e.passedAboveBaseline, e.truncated], ['merged', { completed: 2 }, true, false]);
});

test('b-wait\'s consumer parks on its first step and goes on from the step after the prose turn that ends the attempt', () => {
  const s = R.scenario('b-wait');
  const [parkAttempt, freshAttempt] = s.attempts(playCtx).consumer;
  assert.deepEqual([parkAttempt[0].tool, parkAttempt[0].args.tasks], ['wait_for', ['#1']], 'the first step is the call, naming the producer by its order');
  assert.ok(parkAttempt[0].args.reason);
  assert.ok(parkAttempt[1].say, 'the attempt ends in prose, as a granted wait asks');
  assert.deepEqual(parkAttempt.slice(2), freshAttempt, 'a session that cannot resume plays the same work without the wait');
  assert.equal(s.windows.parallel, 2);
  assert.deepEqual(R.windowArgs(s).slice(-2), ['--parallel', '2']);
  assert.equal(L.parseArgs(['--rehearse', 'b-wait', '--libs', 'x.json', '--arm', 'B', ...R.windowArgs(s)]).parallel, 2);
  assert.equal(R.windowArgs(R.scenario('b-take-in')).includes('--parallel'), false, 'only a scenario that sets a limit passes one');
  // The producer is still at work when the consumer calls: its long step comes first.
  assert.match(s.attempts(playCtx).producer[0][0].args.command, /^timeout 85 tail/);
  const plan = s.plan();
  assert.deepEqual(plan.tasks.map((t) => t.dependencies), [[], [], []], 'three tasks side by side: the wait is added by the call, never planned');

  // The fake plays the steps by the turns a task has had, so a resumed session goes on after its prose turn.
  const state = R.createState();
  const brief = { role: 'user', content: 'Build on the library. [rehearsal:consumer]' };
  const asked = (messages) => R.turnFor('b-wait', runnerRequest(messages), state, playCtx);
  const first = asked([brief]);
  assert.deepEqual([first.toolCall.name, first.round, first.attempt], ['wait_for', 0, 1]);
  const waiting = [brief, ...toolRound('wait_for')];
  const prose = asked(waiting);
  assert.deepEqual([prose.content, prose.toolCall, prose.round], ['Waiting for the producer.', undefined, 1]);
  const resumed = asked([...waiting, { role: 'assistant', content: prose.content }, { role: 'user', content: '(Ordewell) The work you waited for has landed: #1 "Implement the library".' }]);
  assert.deepEqual([resumed.round, resumed.attempt, resumed.toolCall.name], [2, 1, 'write'], 'the continuation is the same attempt, past the park');
  // A fresh start (a runner that cannot resume) is attempt 2, which does not wait again.
  const fresh = asked([brief]);
  assert.deepEqual([fresh.attempt, fresh.toolCall.name], [2, 'write']);
});

test('judgeWait wants the wait granted, the edge in the plan, the slot used meanwhile, and the continuation after the producer lands, told what landed', () => {
  const at = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const stepsOf = R.scenario('b-wait').attempts(playCtx).consumer[0];
  const req = (key, attempt, round, secs, toolCall, extra = {}) => ({ at: at(secs), messages: [{ role: 'user', content: `x [rehearsal:${key}]` }], turn: { role: 'runner', key, attempt, round, toolCall, ...extra.turn }, ...extra.top });
  const log = ({ cont = 100, other = 20, ended = 90, told = 'The work you waited for has landed: #1 "Implement the library".', reply = 'Waiting for #1 "Implement the library". This attempt ends with your turn.', contAttempt = 1, early = null } = {}) => [
    req('producer', 1, 0, 1, { name: 'shell' }),
    req('consumer', 1, 0, 5, { name: 'wait_for' }),
    { ...req('consumer', 1, 1, 6, undefined), messages: [{ role: 'user', content: 'x' }, { role: 'tool', content: reply }] },
    req('small', 1, 0, other, { name: 'write' }),
    req('producer', 1, 5, ended, { name: 'task_complete' }),
    ...(early ? [req('consumer', 1, 1, early, { name: 'task_complete' })] : []),
    { ...req('consumer', contAttempt, 2, cont, { name: 'write' }), messages: [{ role: 'user', content: 'x' }, { role: 'user', content: told }] },
    ...stepsOf.map((st, i) => (i < 2 ? null : { ...req('consumer', contAttempt, i + 1, cont + i, { name: st.tool }), messages: [{ role: 'tool', content: i === 3 ? 'taken in\n[exit code 0]' : 'ok' }] })).filter(Boolean),
  ];
  const plan = [
    { id: 'p', order: 1, dependencies: [] },
    { id: 'c', order: 2, dependencies: ['p'], parked: { attempt: 1, waitsOn: ['p'], added: ['p'], count: 1 } },
  ];
  assert.deepEqual(R.judgeWait('b-wait', log(), playCtx, plan), []);
  assert.match(R.judgeWait('b-wait', log({ reply: 'wait_for is for a change task' }), playCtx, plan).join(), /wait_for was not granted for "Implement the library"/);
  assert.match(R.judgeWait('b-wait', log({ cont: 60 }), playCtx, plan).join(), /went on .* before task producer's last turn/);
  assert.match(R.judgeWait('b-wait', log({ early: 50 }), playCtx, plan).join(), /reported before it was continued/);
  assert.match(R.judgeWait('b-wait', log({ told: 'Go on with your brief.' }), playCtx, plan).join(), /does not say what landed/);
  assert.match(R.judgeWait('b-wait', log({ contAttempt: 2 }), playCtx, plan).join(), /did not continue its session/);
  // The third task must start while the producer is at work, and only after the park: before it, it was never queued.
  assert.match(R.judgeWait('b-wait', log({ other: 95 }), playCtx, plan).join(), /only after task producer's last turn.*the slot was not free/);
  assert.match(R.judgeWait('b-wait', log({ other: 2 }), playCtx, plan).join(), /never queued behind the limit/);
  assert.match(R.judgeWait('b-wait', log().filter((r) => r.turn.key !== 'consumer'), playCtx, plan).join(), /never called wait_for/);
  assert.match(R.judgeWait('b-wait', log().filter((r) => r.turn.key !== 'small'), playCtx, plan).join(), /task small never started/);
  assert.match(R.judgeWait('b-wait', log().filter((r) => !(r.turn.key === 'consumer' && r.turn.round > 2)), playCtx, plan).join(), /never reported after it went on|no answer to/);
  // The plan must show the edge, and the wait the task saved.
  assert.match(R.judgeWait('b-wait', log(), playCtx, [plan[0], { ...plan[1], dependencies: [] }]).join(), /does not show task #2 depending on #1/);
  assert.match(R.judgeWait('b-wait', log(), playCtx, [plan[0], { ...plan[1], parked: undefined }]).join(), /holds no park on #1/);
  assert.match(R.judgeWait('b-wait', log(), playCtx, null).join(), /plan could not be read/);
  assert.deepEqual(R.judgeWait('b-cap', [], playCtx, null), [], 'a scenario with no wait has nothing to judge');
  const e = R.scenario('b-wait').expect;
  assert.deepEqual([e.scoredFrom, e.tasks, e.passedAboveBaseline, e.truncated, e.parallel], ['merged', { completed: 3 }, true, false, 2]);
  assert.match(R.judgeRehearsal('b-wait', { scoredFrom: 'merged', parallel: 8 }).join(), /parallel limit is 8, wanted 2/);
  const perTask = (ended) => ({ metrics: { perTask: [{ order: 1, attempts: [{ ended: 'done' }] }, { order: 2, attempts: ended.map((x) => ({ ended: x })) }] } });
  assert.doesNotMatch(R.judgeRehearsal('b-wait', { parallel: 2, ...perTask(['ended without task_complete', 'done']) }).join(), /attempts ended/);
  assert.match(R.judgeRehearsal('b-wait', { parallel: 2, ...perTask(['done']) }).join(), /task #2's attempts ended \["done"\], wanted \["ended without task_complete","done"\]/);
});

test('b-blocker\'s plan, supervisor and judge: one fix task, which the closing check waits for, lands before the check starts', () => {
  const s = R.scenario('b-blocker');
  const tasks = s.plan().tasks;
  assert.deepEqual(tasks.map((t) => t.title), ['Implement the library', 'Slice A', 'Slice B', 'Slice C', 'Slice D', 'Check the whole']);
  assert.deepEqual(tasks.map((t) => t.dependencies.length), [0, 1, 1, 1, 1, 4], 'four slices: the shape whose landed-blocker line names the closing check');
  const scripts = s.attempts(playCtx);
  for (const slice of ['slice-a', 'slice-b']) {
    const [done] = scripts[slice][0].slice(-1);
    assert.equal(done.args.findings[0].severity, 'blocker');
    assert.deepEqual(done.args.findings[0].evidence, [{ kind: 'task', task: '#1' }], 'a task reference with no finding id: how the landed-blocker count reads it');
  }
  assert.match(scripts['slice-b'][0][0].args.command, /^timeout 85 tail/, 'the second slice is at work while the supervisor is woken');
  assert.equal(scripts.check[0][0].exit0, true);

  // The wake the first report raises, and the one reply: a JSON edit that adds the fix and makes the check wait for it.
  const state = R.createState();
  state.planned = true;
  const wake = 'Run update:\n- task #1 "Implement the library" has landed, and 1 task reports a blocker in its work: #2/F1 "x"; the closing check is #6 "Check the whole"\nA blocker reported in landed work is fixed once, by one task, never once per report.';
  const turn = R.turnFor('b-blocker', { tools: [], messages: [{ role: 'user', content: wake }] }, state, playCtx);
  assert.equal(turn.role, 'supervisor');
  assert.equal(turn.toolCall, undefined, 'the built-in planner edits by a JSON reply');
  const ops = JSON.parse(/```json\n([\s\S]*)\n```/.exec(turn.content)[1]).taskOps;
  assert.deepEqual(ops.map((o) => o.op), ['add', 'update'], 'one fix task, then the closing check made to wait for it');
  assert.match(ops[0].task.prompt, /\[rehearsal:fix\]/);
  assert.deepEqual([ops[0].task.dependencies, ops[1].taskId, ops[1].changes.dependencies], [['#1'], '#6', ['#2', '#3', '#4', '#5', 'fix']]);
  assert.equal(R.turnFor('b-blocker', { tools: [], messages: [{ role: 'user', content: `${wake}\nand 2 tasks report` }] }, state, playCtx).toolCall, undefined, 'a rule plays once');
  assert.deepEqual(L.wakeTriggers(wake).map((t) => t.kind), ['landed_blocker'], 'the harness reads the line');

  const at = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  const run = (key, attempt, round, secs, toolCall, messages = [{ role: 'user', content: 'x' }]) => ({ at: at(secs), messages, turn: { role: 'runner', key, attempt, round, toolCall } });
  const log = ({ fixEnd = 40, checkStart = 50, exit = 0, line = wake } = {}) => [
    { at: at(30), messages: [{ role: 'user', content: line }], turn: { role: 'supervisor', rule: 0 } },
    run('fix', 1, 1, fixEnd, { name: 'task_complete' }),
    run('check', 1, 0, checkStart, { name: 'shell' }),
    run('check', 1, 1, checkStart + 1, { name: 'write' }, [{ role: 'tool', content: `fixed\n[exit code ${exit}]` }]),
  ];
  const plan = [
    { id: 'o', order: 1, title: 'Implement the library', dependencies: [], status: 'completed' },
    ...['a', 'b', 'x', 'y'].map((id, i) => ({ id, order: i + 2, dependencies: ['o'] })),
    { id: 'f', order: 6, title: 'Fix the opening task\'s defect', dependencies: ['o'], status: 'completed' },
    { id: 'c', order: 7, title: 'Check the whole', dependencies: ['a', 'b', 'x', 'y', 'f'] },
  ];
  assert.deepEqual(R.judgeBlocker('b-blocker', log(), playCtx, plan), []);
  assert.match(R.judgeBlocker('b-blocker', log({ line: 'Run update:\n- the run finished' }), playCtx, plan).join(), /no supervisor request held the landed-blocker line/);
  assert.match(R.judgeBlocker('b-blocker', log({ line: wake.replace('the closing check is #6 "Check the whole"', '') }), playCtx, plan).join(), /does not name the closing check #6/);
  assert.match(R.judgeBlocker('b-blocker', log({ line: wake.replace('A blocker reported', 'A thing reported') }), playCtx, plan).join(), /not the guidance/);
  assert.match(R.judgeBlocker('b-blocker', log().map((r, i) => (i === 0 ? { ...r, turn: { role: 'supervisor' } } : r)), playCtx, plan).join(), /did not answer the wake/);
  assert.match(R.judgeBlocker('b-blocker', log({ checkStart: 35 }), playCtx, plan).join(), /closing check started .* before the fix's last turn/);
  assert.match(R.judgeBlocker('b-blocker', log({ exit: 1 }), playCtx, plan).join(), /exited 1, wanted 0: the fix had not landed/);
  assert.match(R.judgeBlocker('b-blocker', log(), playCtx, [...plan, { ...plan[5], id: 'g', order: 8 }]).join(), /8 tasks, 2 of them the fix/);
  assert.match(R.judgeBlocker('b-blocker', log(), playCtx, plan.map((t) => (t.id === 'c' ? { ...t, dependencies: ['a', 'b', 'x', 'y'] } : t))).join(), /closing check does not wait for the fix/);
  assert.match(R.judgeBlocker('b-blocker', log(), playCtx, plan.map((t) => (t.id === 'f' ? { ...t, dependencies: [] } : t))).join(), /fix does not depend on the opening task/);
  assert.match(R.judgeBlocker('b-blocker', log().slice(0, 1), playCtx, plan).join(), /fix never reported/);
  assert.match(R.judgeBlocker('b-blocker', log(), playCtx, null).join(), /plan could not be read/);
  assert.deepEqual(R.judgeBlocker('b-cap', [], playCtx, null), []);
  const edits = ['added', 'updated', 'reordered'].map((op) => ({ kind: 'plan_edit', op, at: at(32), outcome: 'done' }));
  const sup = { wakeUps: 2, wakes: [{ at: at(31), updates: 1, triggers: [{ kind: 'landed_blocker', task: '#1' }] }], actions: edits };
  assert.deepEqual(R.judgeSupervision(s.supervision, sup), []);
  assert.match(R.judgeSupervision(s.supervision, { ...sup, actions: [edits[0], edits[1], { ...edits[2], op: 'removed' }] }).join(), /plan edits are \["added","updated","removed"\]/);
  assert.match(R.judgeSupervision(s.supervision, { ...sup, actions: edits.slice(0, 1) }).join(), /acts are \["plan_edit"\], wanted/);
});

test('a-done scripts a five-minute sleep as its first step, and judgeRefusals wants the guard\'s refusal naming wait_for, answered at once', () => {
  const steps = R.scenario('a-done').attempts(playCtx).A[0];
  assert.deepEqual([steps[0].tool, steps[0].args.command, steps[0].refused], ['shell', 'sleep 300; echo slept', true]);
  assert.equal(steps.slice(1).some((s) => s.refused), false);
  const at = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  const refusal = 'Not run: this command sleeps for 300 seconds. Waiting inside a task holds one of the run\'s slots. If you are waiting for work another task has not landed yet, call `wait_for` with those tasks.';
  const log = ({ reply = refusal, gap = 1 } = {}) => [
    { at: at(0), messages: [], turn: { role: 'runner', key: 'A', attempt: 1, round: 0 } },
    { at: at(gap), messages: [{ role: 'tool', content: reply }], turn: { role: 'runner', key: 'A', attempt: 1, round: 1 } },
  ];
  assert.deepEqual(R.judgeRefusals('a-done', log(), playCtx), []);
  assert.match(R.judgeRefusals('a-done', log({ reply: 'slept\n[exit code 0]' }), playCtx).join(), /was not refused as a wait/);
  assert.match(R.judgeRefusals('a-done', log({ reply: 'Not run: this command sleeps for 300 seconds. Finish your own part.' }), playCtx).join(), /does not name wait_for/);
  assert.match(R.judgeRefusals('a-done', log({ gap: 300 }), playCtx).join(), /took 300 s to answer, so something ran/);
  assert.match(R.judgeRefusals('a-done', log().slice(0, 1), playCtx).join(), /was never answered/);
  assert.deepEqual(R.judgeRefusals('a-failed', [], playCtx), [], 'a scenario that scripts no refusal has nothing to judge');
  // The rest of the scenario is unmoved: the edits and the verdict follow it.
  assert.equal(steps.at(-1).args.status, 'done');
  assert.equal(R.roundsOf([{ role: 'assistant', content: '' }, { role: 'assistant', content: 'Waiting.' }, { role: 'assistant', tool_calls: [{}] }, { role: 'user', content: 'x' }]), 2, 'a prose turn is a round; an empty one is not');
});
test('a task that ends done with a finding must still land: b-edit-retry names its note, and judgeLanded misses it when absent', () => {
  const s = R.scenario('b-edit-retry');
  const closing = s.attempts(playCtx).after[0].at(-1);
  assert.equal(closing.args.status, 'done');
  assert.equal(closing.args.findings.length, 1);
  assert.deepEqual(s.landed, ['commit0-rehearsal-note.md']);
  assert.deepEqual(R.judgeLanded('b-edit-retry', () => true), []);
  assert.match(R.judgeLanded('b-edit-retry', () => false).join(), /commit0-rehearsal-note\.md never landed/);
  assert.deepEqual(R.judgeLanded('a-done', () => false), []);
});

test('judgeBatch holds the rehearsal\'s batch.json to its one run, marked a rehearsal and never a paid batch', () => {
  const record = L.batchRecord({
    keyBeforeUsd: null, keyAfterUsd: null, budgetUsd: null, stoppedByBudget: null, jobs: 1, overlapped: false, seed: 's', dryRun: false,
    rehearsal: 'a-done', startedAt: 't0', endedAt: 't1',
    runs: [{ lib: 'tlslite-ng', arm: 'A', exit: 0, signal: null, skipped: null, resultDir: '/r/x', recordedUsd: 0.001, valid: true }],
  });
  const want = { lib: 'tlslite-ng', arm: 'A', rehearsal: 'a-done' };
  assert.deepEqual(R.judgeBatch(record, want), []);
  assert.deepEqual(R.judgeBatch(null, want), ['no batch.json']);
  assert.match(R.judgeBatch({ ...record, rehearsal: null }, want).join(), /not marked as rehearsal a-done/);
  assert.match(R.judgeBatch({ ...record, runs: [{ ...record.runs[0], resultDir: null }] }, want).join(), /no result directory/);
  assert.match(R.judgeBatch({ ...record, runs: [] }, want).join(), /1 run of tlslite-ng A, not 0 /);
  assert.match(R.judgeBatch({ ...record, runs: [{ ...record.runs[0], skipped: 'cancelled' }] }, want).join(), /skipped its run: cancelled/);
  assert.match(R.judgeBatch({ ...record, keyBeforeUsd: 3 }, want).join(), /read the key/);
  assert.equal(L.runsDirName({ dryRun: false, rehearse: 'a-done' }), 'rehearsals');
  assert.equal(L.runsDirName({ dryRun: true }), 'dry-runs');
  assert.equal(L.runsDirName({ dryRun: false, rehearse: null }), 'runs');
});

test('a batch passes a rehearsal and its windows on to every run, and a rehearsal batch needs no budget', () => {
  const b = L.parseBatchArgs(['--rehearse', 'a-done', '--libs', 'libs.json', '--arm', 'A', '--settle-min', '1', '--poll-sec', '5', '--wall-min', '25']);
  assert.equal(b.rehearse, 'a-done');
  assert.equal(b.run, false);
  assert.equal(b.budgetUsd, null);
  assert.deepEqual(b.driveArgs.filter((a) => a.startsWith('--')), ['--rehearse', '--libs', '--settle-min', '--poll-sec', '--wall-min']);
  assert.throws(() => L.parseBatchArgs(['--rehearse', 'a-done', '--run', '--libs', 'libs.json']), /pass --dry-run/);
});

// The rehearsal itself: real Docker, a real image, minutes per scenario. Only when asked:
// ORDEWELL_COMMIT0_REHEARSAL=<libraries.json> [ORDEWELL_COMMIT0_REHEARSAL_SCENARIOS=a,b].
test('the rehearsal passes every scenario on a real library image', { skip: process.env.ORDEWELL_COMMIT0_REHEARSAL ? false : 'set ORDEWELL_COMMIT0_REHEARSAL=<libraries.json> to run the Docker rehearsal', timeout: 3 * 60 * 60_000 }, () => {
  const scenarios = process.env.ORDEWELL_COMMIT0_REHEARSAL_SCENARIOS;
  execFileSync(process.execPath, [path.join(import.meta.dirname, 'rehearse.mjs'), '--libs', process.env.ORDEWELL_COMMIT0_REHEARSAL, ...(scenarios ? ['--scenario', scenarios] : [])], { stdio: 'inherit' });
});

// --- Pairs: a library's two arms start together, the next library's pair when both have ended. ---

test('batchSegments: with --jobs 2 a library\'s A and B are one wave, and the next library waits for both', () => {
  const runs = L.batchPlan({ libs: ['x', 'y', 'z'], arms: ['A', 'B'], seed: null });
  const two = L.batchSegments({ runs, jobs: 2 });
  assert.deepEqual(two.map((s) => [s.jobs, s.runs.map((r) => `${r.lib}${r.arm}`)]), [[2, ['xA', 'xB']], [2, ['yA', 'yB']], [2, ['zA', 'zB']]]);
  // Four at once hold two libraries' pairs; an odd budget wastes its odd slot rather than split a pair.
  assert.deepEqual(L.batchSegments({ runs, jobs: 4 }).map((s) => [s.jobs, s.runs.length]), [[4, 4], [2, 2]]);
  assert.deepEqual(L.batchSegments({ runs, jobs: 3 }).map((s) => [s.jobs, s.runs.length]), [[2, 2], [2, 2], [2, 2]]);
});

test('batchSegments: one job, or one arm, is a plain queue', () => {
  const both = L.batchPlan({ libs: ['x', 'y'], arms: ['A', 'B'], seed: null });
  assert.deepEqual(L.batchSegments({ runs: both, jobs: 1 }).map((s) => [s.jobs, s.runs.length]), [[1, 4]]);
  const one = L.batchPlan({ libs: ['x', 'y', 'z'], arms: ['B'], seed: null });
  assert.deepEqual(L.batchSegments({ runs: one, jobs: 2 }).map((s) => [s.jobs, s.runs.length]), [[2, 3]]);
  assert.deepEqual(L.batchSegments({ runs: [], jobs: 2 }), []);
});

test('judgePairing: a pair starts together, and the next library starts after both of the last have ended', () => {
  const at = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const run = (lib, arm, s, e) => ({ lib, arm, startedAt: at(s), endedAt: at(e) });
  const good = [run('x', 'A', 0, 50), run('x', 'B', 5, 90), run('y', 'A', 95, 120), run('y', 'B', 96, 130)];
  assert.deepEqual(L.judgePairing(good, { jobs: 2 }), []);
  const crept = [run('x', 'A', 0, 50), run('x', 'B', 5, 90), run('y', 'A', 60, 120), run('y', 'B', 96, 130)];
  assert.match(L.judgePairing(crept, { jobs: 2 }).join(), /y A started .* before x B ended/);
  const apart = [run('x', 'A', 0, 50), run('x', 'B', 400, 450)];
  assert.match(L.judgePairing(apart, { jobs: 2 }).join(), /x A and x B did not start together/);
  assert.match(L.judgePairing([run('x', 'A', 0, 5)], { jobs: 2 }).join(), /no pair/);
  assert.match(L.judgePairing([{ lib: 'x', arm: 'A' }, { lib: 'x', arm: 'B' }], { jobs: 2 }).join(), /no start or end/);
});

// --- A stopped batch keeps what it had: batch.json after every run, written whole. ---

test('writeJsonAtomic replaces the file whole and leaves nothing beside it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-atomic-'));
  try {
    const file = path.join(dir, 'batch.json');
    L.writeJsonAtomic(file, { n: 1 });
    L.writeJsonAtomic(file, { n: 2, list: [1, 2] });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 2, list: [1, 2] });
    assert.deepEqual(fs.readdirSync(dir), ['batch.json']);
    assert.match(fs.readFileSync(file, 'utf8'), /\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('batchRecord keeps the key readings as they were taken, and says whether the batch finished', () => {
  const readings = [{ at: 't0', usd: 10, after: null }, { at: 't1', usd: 11.5, after: 'x A' }];
  const partial = L.batchRecord({ keyBeforeUsd: 10, keyAfterUsd: null, budgetUsd: 20, stoppedByBudget: null, jobs: 2, overlapped: true, startedAt: 't0', endedAt: null, keyReadings: readings, runs: [{ lib: 'x', arm: 'A', recordedUsd: 1 }] });
  assert.equal(partial.finished, false);
  assert.equal(partial.endedAt, null);
  assert.deepEqual(partial.keyReadings, readings);
  // Unfinished, the key's delta is as of the latest reading, not of an end the batch never reached.
  assert.equal(partial.keyDeltaUsd, 1.5);
  const done = L.batchRecord({ keyBeforeUsd: 10, keyAfterUsd: 12, jobs: 2, overlapped: true, startedAt: 't0', endedAt: 't2', keyReadings: readings, runs: [] });
  assert.equal(done.finished, true);
  assert.equal(done.keyDeltaUsd, 2);
  const keyless = L.batchRecord({ keyBeforeUsd: null, keyAfterUsd: null, jobs: 1, overlapped: false, startedAt: 't0', endedAt: 't1', runs: [] });
  assert.deepEqual(keyless.keyReadings, []);
  assert.equal(keyless.keyDeltaUsd, null);
});

test('a batch of pairs: a library\'s A and B start together, the next pair after both ended, and batch.json is whole after every run', { skip: process.platform === 'win32' && 'a copied tree of scripts and POSIX signals' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-pairs-'));
  const copy = path.join(root, 'tree', 'bench');
  try {
    fs.mkdirSync(path.join(copy, 'commit0'), { recursive: true });
    fs.mkdirSync(path.join(copy, 'lib'));
    for (const f of ['batch.mjs', 'lib.mjs', 'rehearsal.mjs']) fs.copyFileSync(path.join(here, f), path.join(copy, 'commit0', f));
    fs.copyFileSync(path.join(here, '..', 'lib', 'data-dir.mjs'), path.join(copy, 'lib', 'data-dir.mjs'));
    const release = path.join(root, 'release');
    // A drive that writes the result.json a run leaves, after a time of its arm's: A is quick, B slow, and the second library's B waits to be let go.
    fs.writeFileSync(path.join(copy, 'commit0', 'drive.mjs'), [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const arg = (n) => process.argv[process.argv.indexOf(n) + 1];",
      "const [lib, arm, dir] = [arg('--only'), arg('--arm'), arg('--batch-dir')];",
      'const startedAt = new Date().toISOString();',
      "const wait = async (ms) => new Promise((r) => setTimeout(r, ms));",
      "if (lib === 'b' && arm === 'B') while (!fs.existsSync(" + JSON.stringify(release) + ')) await wait(25);',
      "else await wait(arm === 'A' ? 100 : 600);",
      "const out = path.join(dir, `run-${lib}-${arm}`);",
      'fs.mkdirSync(out);',
      "fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ library: lib, arm, startedAt, endedAt: new Date().toISOString(), recordedUsd: 0.5, valid: true }));",
    ].join('\n'));
    const libs = path.join(root, 'libs.json');
    fs.writeFileSync(libs, JSON.stringify(['a', 'b'].map((name) => ({ name, image: 'x', srcDir: name, testDir: 'tests', importName: name, distName: name, baseCommit: 'abc1234' }))));
    const bench = path.join(root, 'data');
    const child = spawn(process.execPath, [path.join(copy, 'commit0', 'batch.mjs'), '--dry-run', '--libs', libs, '--jobs', '2', '--cpus', '1', '--memory', '1g'], {
      stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '', ORDEWELL_BENCH_DIR: bench },
    });
    const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    const dryRuns = path.join(bench, 'commit0', 'dry-runs');
    const readBatch = () => {
      const [dir] = fs.existsSync(dryRuns) ? fs.readdirSync(dryRuns) : [];
      const file = dir && path.join(dryRuns, dir, 'batch.json');
      // Every read parses: the file is replaced whole, never written in place.
      return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    };
    // Library a's pair has ended, library b's A has too, and b's B is held: the batch is not over, and batch.json has what ended.
    let mid = null;
    for (const until = Date.now() + 20_000; Date.now() < until;) {
      const b = readBatch();
      if (b?.runs.length === 3) { mid = b; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(mid, 'batch.json never held the three runs that had ended');
    assert.equal(mid.finished, false);
    assert.equal(mid.endedAt, null);
    assert.deepEqual(mid.runs.map((r) => `${r.lib}${r.arm}`).sort(), ['aA', 'aB', 'bA']);
    fs.writeFileSync(release, '');
    assert.equal(await exited, 0);
    const done = readBatch();
    assert.equal(done.finished, true);
    assert.equal(done.runs.length, 4);
    assert.deepEqual(L.judgePairing(done.runs, { jobs: 2 }), []);
    const start = (lib, arm) => Date.parse(done.runs.find((r) => r.lib === lib && r.arm === arm).startedAt);
    const end = (lib, arm) => Date.parse(done.runs.find((r) => r.lib === lib && r.arm === arm).endedAt);
    assert.ok(start('b', 'A') >= end('a', 'B'), 'b A started before a B ended');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- What result.json gains: the plan review, a cut attempt's running time, calls per upstream. ---

test('planReview reads the last "chain review" line of the research log: the chains, the tasks changed, whether it was kept', () => {
  const sys = (content) => ({ id: 'cr-1', type: 'system', content, timestamp: 't' });
  const kept = L.planReview([sys('chain review: 12, reply cut off at the output limit [reply 3 tokens out]; asked once more with the plan alone'), sys('chain review: 12 -> 5, kept; 30 tasks changed: "A" drops "B" adds "C" [reply 9 tokens out]')]);
  assert.deepEqual(kept, { reviewed: true, firstChain: 12, reviewedChain: 5, tasksChanged: 30, kept: true, outcome: 'kept' });
  const notShorter = L.planReview([sys('chain review: 6 -> 6, first plan kept, not shorter; 1 task changed: "A" drops "B"')]);
  assert.deepEqual(notShorter, { reviewed: true, firstChain: 6, reviewedChain: 6, tasksChanged: 1, kept: false, outcome: 'first plan kept, not shorter' });
  const none = L.planReview([sys('chain review: 7 -> 4, kept; 0 tasks changed')]);
  assert.equal(none.tasksChanged, 0);
  // A review that failed or whose reply was refused changed nothing, and names no reviewed chain.
  assert.deepEqual(L.planReview([sys('chain review: 5, first plan kept: unknown task "t9"')]), { reviewed: true, firstChain: 5, reviewedChain: null, tasksChanged: null, kept: false, outcome: 'first plan kept' });
  assert.deepEqual(L.planReview([sys('chain review: 5, failed: socket closed')]), { reviewed: true, firstChain: 5, reviewedChain: null, tasksChanged: null, kept: false, outcome: 'failed' });
  assert.deepEqual(L.planReview([sys('chain review: 12, reply cut off at the output limit [reply 3 tokens out]; asked once more with the plan alone')]), { reviewed: true, firstChain: 12, reviewedChain: null, tasksChanged: null, kept: false, outcome: 'no answer' });
  // No such line: a chain under the review's minimum, or an arm with no planner. Nothing to say, and nothing guessed.
  assert.equal(L.planReview([{ id: 'x', type: 'user_prompt', content: 'hello' }, { id: 'y', type: 'tool_call' }]), null);
  assert.equal(L.planReview([]), null);
  assert.equal(L.planReview(null), null);
});

test('readResearchLog reads a copied-out session\'s log, and is null without one or with one that does not parse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-rlog-'));
  try {
    assert.equal(L.readResearchLog(dir, 's1'), null);
    const sdir = path.join(dir, 'sessions', 's1');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, 'research-log.json'), '{ not json');
    assert.equal(L.readResearchLog(dir, 's1'), null);
    fs.writeFileSync(path.join(sdir, 'research-log.json'), JSON.stringify([{ type: 'system', content: 'chain review: 5 -> 4, kept; 1 task changed' }]));
    assert.equal(L.readResearchLog(dir, 's1').length, 1);
    // An id with a character a directory name cannot take is hex-named, as core's idSegment does.
    const odd = path.join(dir, 'sessions', `~${Buffer.from('a/b', 'utf-8').toString('hex')}`);
    fs.mkdirSync(odd, { recursive: true });
    fs.writeFileSync(path.join(odd, 'research-log.json'), '[]');
    assert.deepEqual(L.readResearchLog(dir, 'a/b'), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runMetrics counts the running time of an attempt the stop cut, from its wall time, and says so', () => {
  const iso = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const plan = {
    tasks: [
      { id: 't1', order: 1, title: 'one', type: 'ai', status: 'completed', dependencies: [],
        attemptUsage: [{ attempt: 1, runner: 'openrouter', startedAt: iso(0), endedAt: iso(100), wallTimeMs: 100_000, runningMs: 90_000, byModel: [] }] },
      // The stop ended this one while it ran: its running clock reads 0, and its wall time holds the time it ran.
      { id: 't2', order: 2, title: 'two', type: 'ai', status: 'in_progress', dependencies: [],
        attemptUsage: [{ attempt: 1, runner: 'openrouter', startedAt: iso(0), endedAt: iso(300), wallTimeMs: 300_000, runningMs: 0, byModel: [] }] },
      { id: 't3', order: 3, title: 'three', type: 'ai', status: 'failed', dependencies: [],
        attemptUsage: [{ attempt: 1, runner: 'openrouter', startedAt: iso(0), endedAt: iso(5), wallTimeMs: 5_000, runningMs: 0, byModel: [] }, { attempt: 2, runner: 'openrouter', startedAt: iso(5), endedAt: iso(65), wallTimeMs: 60_000, runningMs: 60_000, byModel: [] }] },
    ],
  };
  const m = L.runMetrics(plan, null);
  assert.deepEqual(m.perTask[0].attempts, [{ attempt: 1, ended: null, steps: null, runningMs: 90_000 }]);
  assert.deepEqual(m.perTask[1].attempts, [{ attempt: 1, ended: null, steps: null, runningMs: 300_000, runningFrom: 'wallTimeMs' }]);
  assert.equal(m.perTask[1].runningMs, 300_000);
  assert.equal(m.perTask[2].runningMs, 65_000, 'the cut attempt and the one that ran are both counted');
  assert.equal(m.perTask[2].attempts[1].runningFrom, undefined);
});

test('callStats counts calls per upstream, and the billed calls that found almost no cache straight after a call of their attempt', () => {
  const call = (input, cached, extra = {}) => ({ type: 'usage', record: { source: 'openrouter', model: 'm', inputTokens: input, cachedInputTokens: cached, ...extra } });
  const logs = {
    t1: {
      1: [
        call(1000, 0, { provider: 'up-a' }),     // the first call of an attempt has nothing before it to be cached from
        call(1100, 1000, { provider: 'up-a' }),  // cached
        call(1200, 0, { provider: 'up-b' }),     // cold straight after a call: counted
        { type: 'tool_call', id: 'c1', name: 'bash', args: '{}' },
        call(1300, 20, { provider: 'up-b' }),    // 20 of 1300 is under the share: counted
        call(900, undefined, {}),                 // no cached count reported: not read as cold
        call(50, 0, { subagentId: 's' }),         // a subagent's context is its own: counted as a call, never as cold
        { type: 'usage', record: { source: 'openrouter', aggregate: true, inputTokens: 99999 } },
        { type: 'usage', record: { source: 'openrouter', compacted: true } },
      ],
      2: [call(500, 0, { provider: 'up-a' }), call(600, 560, { provider: 'up-a' })],
    },
    t2: { 1: [call(100, 0, { provider: 'up-a' }), call(200, 0, { provider: 'up-a' })] },
  };
  const s = L.callStats(logs);
  assert.deepEqual(s.byUpstream, { 'up-a': 6, 'up-b': 2, unreported: 2 });
  assert.equal(s.calls, 10);
  assert.equal(s.coldAfterCall, 3, 'up-b 1200, up-b 1300, and t2\'s second call');
  assert.equal(L.callStats(null), null);
  assert.deepEqual(L.callStats({}), { calls: 0, byUpstream: {}, coldAfterCall: 0, coldShare: L.COLD_CACHE_SHARE });
});

test('providerSwitches counts the attempts whose upstream changed and the changes, from the provider the usage records name', () => {
  const call = (provider, extra = {}) => ({ type: 'usage', record: { source: 'openrouter', model: 'm', inputTokens: 10, ...(provider ? { provider } : {}), ...extra } });
  const logs = {
    t1: {
      1: [call('up-a'), call('up-a'), call('up-b'), call('up-a')],                 // a to b, and back: two switches
      2: [call('up-a'), call('up-a')],                                              // none
    },
    t2: {
      1: [call('up-a'), call(null), call('up-a')],                                  // a record that names none is skipped, not a change
      2: [call('up-a'), call('up-b', { subagentId: 's' }), call('up-a', { aggregate: true }), call('up-c', { compacted: true, inputTokens: undefined })], // a subagent's own upstream and the non-calls are not the attempt's
      3: [call('up-a'), call('up-c'), call(null), call('up-c'), call('up-d')],      // a to c, c to d: two
      4: [call(null), call(null)],                                                  // names no provider at all
    },
  };
  assert.deepEqual(L.providerSwitches(logs), { attempts: 6, withProvider: 5, attemptsSwitched: 2, switches: 4 });
  assert.deepEqual(L.providerSwitches({}), { attempts: 0, withProvider: 0, attemptsSwitched: 0, switches: 0 });
  assert.equal(L.providerSwitches(null), null, 'no logs: not read, not zero');
});

test('runEnding says how the arm stopped: its own completion with the runner\'s reason, a cap, the settle rule with the tasks open', () => {
  const use = (n, extra = {}) => Array.from({ length: n }, () => ({ type: 'usage', record: { source: 'openrouter', inputTokens: 5, ...extra } }));
  const done = (args) => ({ type: 'tool_call', id: 'x', name: 'mcp__ordewell__task_complete', args: JSON.stringify(args) });
  const task = (id, order, status, extra = {}) => ({ id, order, title: `task ${order}`, type: 'ai', status, dependencies: [], attemptUsage: [], ...extra });
  const one = (status, extra) => ({ tasks: [task('t1', 1, status, extra)] });

  // Arm A, done: no reason; the calls against the step limit, per attempt, a subagent's apart.
  const doneLogs = { t1: { 1: [...use(2), ...use(1, { subagentId: 's' }), done({ status: 'done', summary: 'ok' })], 2: [...use(3), done({ status: 'done', summary: 'ok' })] } };
  assert.deepEqual(L.runEnding({ arm: 'A', plan: one('completed', { verdict: { outcome: 'pass', reported: 'done' } }), taskLogs: doneLogs, stopped: null, stalled: null }), {
    by: 'completion', status: 'done', reason: null,
    reports: [{ order: 1, title: 'task 1', status: 'done', reason: null }],
    modelCalls: { used: 5, limitPerAttempt: L.STEP_LIMIT, perAttempt: [{ attempt: 1, calls: 2 }, { attempt: 2, calls: 3 }], peakAttempt: 3, reachedLimit: false, subagentCalls: 1 },
  });

  // Failed and blocked: the status and the text the runner gave. The settle rule saw only a failed task, which the runner itself reported: its completion.
  const failedPlan = one('failed', { verdict: { outcome: 'fail', reported: 'failed' } });
  const failedLogs = { t1: { 1: [...use(1000), done({ status: 'failed', summary: 's', reason: 'the tests cannot import' })] } };
  const failedStall = { why: 'settled', quietMs: 300_000, runView: true, open: [{ id: 't1', order: 1, title: 'task 1', status: 'failed', held: 'nothing ready', reason: 'failed' }] };
  const failed = L.runEnding({ arm: 'A', plan: failedPlan, taskLogs: failedLogs, stopped: null, stalled: failedStall });
  assert.deepEqual([failed.by, failed.status, failed.reason, failed.modelCalls.used, failed.modelCalls.reachedLimit], ['completion', 'failed', 'the tests cannot import', 1000, true]);
  const blocked = L.runEnding({ arm: 'B', plan: failedPlan, taskLogs: { t1: { 1: [done({ status: 'blocked', reason: 'no network' })] } }, stopped: null, stalled: failedStall });
  assert.deepEqual([blocked.by, blocked.status, blocked.reason, blocked.modelCalls], ['completion', 'blocked', 'no network', null], 'arm B has no one call budget to report');

  // A cap: which one, and nothing of the runner's own word.
  const capped = L.runEnding({ arm: 'A', plan: one('in_progress'), taskLogs: { t1: { 1: use(7) } }, stopped: { why: 'spend', atMs: 4000, spentUsd: 8.01 }, stalled: null });
  assert.deepEqual([capped.by, capped.cap, capped.spentUsd, capped.atMs, capped.modelCalls.used], ['cap', 'spend', 8.01, 4000, 7]);
  assert.equal(L.runEnding({ arm: 'B', plan: null, taskLogs: null, stopped: { why: 'wall-clock', atMs: 9, spentUsd: 1 }, stalled: null }).cap, 'wall-clock');
  assert.equal(L.runEnding({ arm: 'B', plan: null, taskLogs: null, stopped: { why: 'batch-budget', atMs: 9, spentUsd: 1 }, stalled: null }).cap, 'batch-budget');
  assert.deepEqual(L.runEnding({ arm: 'B', plan: null, taskLogs: null, stopped: { why: 'no-start', atMs: 9, spentUsd: 0, detail: 'no model call' }, stalled: null }), { by: 'no-start', detail: 'no model call', modelCalls: null });

  // The settle rule, with tasks still open that something else holds.
  const open = [{ id: 't2', order: 2, title: 'task 2', status: 'awaiting_user', held: 'waiting on a person', reason: 'checkpoint' }, { id: 't3', order: 3, title: 'task 3', status: 'pending', held: 'nothing ready', reason: 'depends on 2 (awaiting_user)' }];
  const settled = L.runEnding({ arm: 'B', plan: { tasks: [task('t2', 2, 'awaiting_user'), task('t3', 3, 'pending')] }, taskLogs: null, stopped: null, stalled: { why: 'settled', quietMs: 300_000, runView: true, open } });
  assert.deepEqual([settled.by, settled.quietMs, settled.open], ['settle', 300_000, open.map((o) => ({ order: o.order, title: o.title, status: o.status, held: o.held, reason: o.reason }))]);
  // A person waited on for --stall-min is the stall rule's, not the settle rule's.
  assert.equal(L.runEnding({ arm: 'B', plan: null, taskLogs: null, stopped: null, stalled: { waiting: 'checkpoint', sinceMs: 1, task: { title: 't' } } }).by, 'stall');

  // Every task done by itself: done, from the plan when the logs were not copied. A run that never ran says so.
  const bare = L.runEnding({ arm: 'B', plan: { tasks: [task('t1', 1, 'completed', { verdict: { outcome: 'pass', reported: 'done' } }), task('t2', 2, 'skipped')] }, taskLogs: null, stopped: null, stalled: null });
  assert.deepEqual([bare.by, bare.status, bare.reason, bare.reports.map((r) => r.status)], ['completion', 'done', null, ['done', null]]);
  assert.deepEqual(L.runEnding({ arm: 'A', plan: null, taskLogs: null, stopped: null, stalled: null }), { by: 'not-run', modelCalls: null });
  // A dry run or a plan-only run holds a plan whose tasks never ran: not an ending.
  assert.deepEqual(L.runEnding({ arm: 'B', plan: one('pending'), taskLogs: null, stopped: null, stalled: null, ran: false }), { by: 'not-run', modelCalls: null });
});

test('runMetrics carries the call counts, null without the logs', () => {
  const plan = { tasks: [{ id: 't1', order: 1, title: 'one', type: 'ai', status: 'completed', dependencies: [], attemptUsage: [] }] };
  const logs = { t1: { 1: [{ type: 'usage', record: { source: 'openrouter', inputTokens: 10, cachedInputTokens: 0, provider: 'p' } }] } };
  assert.deepEqual(L.runMetrics(plan, logs).calls.byUpstream, { p: 1 });
  assert.equal(L.runMetrics(plan, null).calls, null);
});

// --- Score over time: the choice of points and the commit-to-time mapping on a fixture repository, the container call through the dry-run seam. ---

const T = await import('./timeline.mjs');
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const minutesAfter = (m) => new Date(T0 + m * 60_000).toISOString();

/**
 * A finished run's directory with a made-up history: `arm-workdir/.git` whose
 * root is the stubs on commit0-base, then either arm B's landings (merge
 * commits on ordewell/r1/integration, at `landings` minutes) or arm A's task
 * branch (commits at those minutes). Each commit writes src/tinylib/m.py as
 * `v<minute>`, so what a point materializes names the commit it came from.
 */
function fixtureRun(arm, minutes, { wall = 100, tests = { passed: 7, failed: 1, errors: 0, collected: 9 }, plan = null, merged = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-timeline-'));
  const work = path.join(dir, 'arm-workdir');
  fs.mkdirSync(work);
  // An empty file, not os.devNull: on Windows that is `\\.\nul`, which git cannot open as a config.
  const noConfig = path.join(dir, 'empty-gitconfig');
  fs.writeFileSync(noConfig, '');
  const git = (at, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], {
    cwd: work, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: minutesAfter(at), GIT_COMMITTER_DATE: minutesAfter(at), GIT_CONFIG_GLOBAL: noConfig, GIT_CONFIG_NOSYSTEM: '1' },
  });
  const write = (v) => {
    fs.mkdirSync(path.join(work, 'src', 'tinylib'), { recursive: true });
    fs.writeFileSync(path.join(work, 'src', 'tinylib', 'm.py'), `${v}\n`);
    git(0, 'add', '-A');
  };
  git(0, 'init', '-q', '-b', 'commit0-base');
  write('stubs');
  git(0, 'commit', '-q', '-m', 'stubs');
  if (arm === 'B') {
    git(0, 'checkout', '-q', '-b', 'ordewell/r1/integration');
    minutes.forEach((m, i) => {
      git(m - 1, 'checkout', '-q', '-b', `ordewell/r1/${i + 1}-task`, 'ordewell/r1/integration');
      write(`v${m}`);
      git(m - 1, 'commit', '-q', '-m', `task ${i + 1}`);
      git(m, 'checkout', '-q', 'ordewell/r1/integration');
      git(m, 'merge', '-q', '--no-ff', '-m', `land task ${i + 1}`, `ordewell/r1/${i + 1}-task`);
    });
    if (merged) {
      // The end-of-run merge: commit0-base takes the integration branch whole, every ordewell/ branch is gone, and a remote ref is left behind the landings.
      const first = git(0, 'rev-parse', 'ordewell/r1/1-task^{commit}').trim();
      git(0, 'checkout', '-q', 'commit0-base');
      git(minutes.at(-1), 'merge', '-q', '--ff-only', 'ordewell/r1/integration');
      for (const b of git(0, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/ordewell').split('\n').filter(Boolean)) git(0, 'branch', '-q', '-D', b);
      git(0, 'update-ref', 'refs/remotes/origin/ordewell/r1/integration', first);
    }
  } else if (arm === 'A-continued') {
    // The control arm: each attempt's worktree is cut again, over what landed so far, and every one that reported done lands; the last is left unlanded.
    git(0, 'checkout', '-q', '-b', 'ordewell/r2/integration');
    let firstAttempt = null;
    minutes.forEach((m, i) => {
      git(m - 1, 'checkout', '-q', '-B', 'ordewell/r2/1-implement', 'ordewell/r2/integration');
      write(`v${m}`);
      git(m, 'commit', '-q', '-m', `attempt ${i + 1}`);
      firstAttempt ??= git(m, 'rev-parse', 'HEAD').trim();
      if (i < minutes.length - 1 || merged) {
        git(m + 1, 'checkout', '-q', 'ordewell/r2/integration');
        git(m + 1, 'merge', '-q', '--no-ff', '-m', `land attempt ${i + 1}`, 'ordewell/r2/1-implement');
      }
    });
    if (merged) {
      // The end-of-run merge: commit0-base takes the integration branch, the task's branch is gone, and the only one left is the first attempt's, kept as work in progress.
      git(0, 'checkout', '-q', 'commit0-base');
      git(minutes.at(-1) + 1, 'merge', '-q', '--ff-only', 'ordewell/r2/integration');
      for (const b of git(0, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/ordewell').split('\n').filter(Boolean)) git(0, 'branch', '-q', '-D', b);
      git(0, 'branch', 'ordewell-preserved/r2/1-implement', firstAttempt);
    }
  } else {
    git(0, 'checkout', '-q', '-b', 'ordewell/r2/1-implement');
    for (const m of minutes) {
      write(`v${m}`);
      git(m, 'commit', '-q', '-m', `edit at ${m}`);
    }
  }
  fs.mkdirSync(path.join(dir, 'workspace-ordewell', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace-ordewell', 'sessions', 's.json'), JSON.stringify({ meta: { id: 's', createdAt: minutesAfter(0) }, ...(plan ? { plan } : {}) }));
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({
    library: 'tinylib', arm, ...(merged && arm !== 'B' ? { scoredFrom: 'merged' } : {}), wallClockMs: wall * 60_000, startedAt: minutesAfter(-2), tests, parallel: 4, cpus: 2, memory: '4g', capUsd: 8, wallCapMs: 3 * 3_600_000,
  }));
  return dir;
}

const tinyLibs = [{ name: 'tinylib', image: 'commit0/tinylib:v0', srcDir: 'src/tinylib', testDir: 'tests', importName: 'tinylib', distName: 'tinylib', baseCommit: 'abc1234' }];

test('runHistory maps arm B\'s landings to their committer times and arm A\'s branch commits to theirs, the stubs never a point', { skip: !hasGit && 'needs git' }, () => {
  const b = fixtureRun('B', [10, 25, 40, 70]);
  const a = fixtureRun('A', [5, 15, 30, 50, 80]);
  try {
    const hb = T.runHistory(b, { arm: 'B' });
    assert.equal(hb.branch, 'ordewell/r1/integration');
    assert.deepEqual(hb.commits.map((c) => (c.ms - T0) / 60_000), [10, 25, 40, 70]);
    assert.deepEqual(hb.commits.map((c) => c.subject), ['land task 1', 'land task 2', 'land task 3', 'land task 4']);
    assert.equal(hb.final, hb.commits.at(-1).sha);
    assert.equal(hb.lastLanding, hb.final);
    assert.match(hb.armTree, /^[0-9a-f]{40}$/);
    const ha = T.runHistory(a, { arm: 'A' });
    assert.equal(ha.branch, 'ordewell/r2/1-implement');
    assert.deepEqual(ha.commits.map((c) => (c.ms - T0) / 60_000), [5, 15, 30, 50, 80]);
    assert.equal(ha.final, ha.commits.at(-1).sha);
    assert.equal(ha.lastLanding, null);
    assert.ok(![...hb.commits, ...ha.commits].some((c) => c.sha === hb.root || c.sha === ha.root));
    assert.equal(T.runStartMs(b, JSON.parse(fs.readFileSync(path.join(b, 'result.json'), 'utf8'))), T0, 'the session\'s creation, not the run\'s earlier start');
    assert.throws(() => T.runHistory(a, { arm: 'A', branch: 'nope' }), /no branch of the run's work/);
  } finally {
    fs.rmSync(b, { recursive: true, force: true });
    fs.rmSync(a, { recursive: true, force: true });
  }
});

test('the timeline reads a continued run, whose history spans several attempts: the commits of each attempt and the landings between, the final tree the last attempt\'s', { skip: !hasGit && 'needs git' }, async () => {
  const dir = fixtureRun('A-continued', [5, 20, 40, 70]);
  try {
    const h = T.runHistory(dir, { arm: 'A-continued' });
    assert.equal(h.branch, 'ordewell/r2/1-implement', 'the task\'s branch, never the integration one');
    assert.deepEqual(h.commits.map((c) => c.subject), ['attempt 1', 'land attempt 1', 'attempt 2', 'land attempt 2', 'attempt 3', 'land attempt 3', 'attempt 4']);
    assert.equal(h.final, h.commits.at(-1).sha, 'the last attempt\'s own commit, landed or not');
    assert.equal(h.lastLanding, null);
    const chosen = T.chooseTimelinePoints(dir, { arm: 'A-continued', points: 8 }).chosen;
    assert.equal(chosen.at(-1).sha, h.final);
    assert.equal(new Set(chosen.map((p) => p.sha)).size, chosen.length);
    // The arm's own label is the one scoring reads: it settles like arm A, not B.
    const drive = await import('./drive.mjs');
    const seen = [];
    const driver = { materialize: drive.materialize, scoreInFreshBox: async (lib, tree, o) => { seen.push(o.settings); return { treeCheck: { ok: true }, tests: { passed: 7, failed: 1, errors: 0 }, copied: [], removed: [], needsInspection: [], patchError: null }; } };
    const { timeline } = await T.scoreTimeline({ runDir: dir, libraries: tinyLibs, points: 4, jobs: 1, driver });
    assert.equal(timeline.verified, true);
    assert.equal(seen.length, 3, "four points less the final's own slot, and the final");
    assert.deepEqual([seen[0].supervisorLevel, seen[0].parallel], ['off', 1], 'arm A\'s settings, not arm B\'s');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the timeline of a continued run scored from its merged work ends on commit0-base, never on the attempt branch the merge left behind', { skip: !hasGit && 'needs git' }, () => {
  const dir = fixtureRun('A-continued', [5, 20, 40], { merged: true });
  try {
    // After the end-of-run merge the workdir holds commit0-base and the first attempt's kept branch: an early point of the run, not its final tree.
    const h = T.runHistory(dir, { arm: 'A-continued', merged: true });
    assert.equal(h.branch, 'commit0-base');
    assert.deepEqual(h.commits.map((c) => c.subject), ['attempt 1', 'land attempt 1', 'attempt 2', 'land attempt 2', 'attempt 3', 'land attempt 3']);
    assert.equal(h.final, h.commits.at(-1).sha);
    // The run's own word on where it was scored from decides, and a run scored from a worktree keeps reading the task's newest branch.
    assert.equal(T.chooseTimelinePoints(dir, { arm: 'A-continued', points: 8 }).history.branch, 'commit0-base');
    assert.equal(T.runHistory(dir, { arm: 'A-continued' }).branch, 'ordewell-preserved/r2/1-implement');
    assert.equal(T.runHistory(dir, { arm: 'A-continued', merged: true, branch: 'ordewell-preserved/r2/1-implement' }).branch, 'ordewell-preserved/r2/1-implement', 'a branch named is the branch read');
    assert.equal(T.chooseTimelinePoints(dir, { arm: 'A-continued', points: 8 }).chosen.at(-1).sha, h.final);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('timelinePoints: up to N points evenly in time, each the newest commit at or before it, the final tree and arm B\'s last landing always among them', () => {
  const at = (m) => ({ sha: `c${m}`, ms: T0 + m * 60_000 });
  const landings = [10, 25, 40, 70].map(at);
  const base = { commits: landings, finalSha: 'c70', lastLanding: 'c70', t0Ms: T0, endMs: T0 + 100 * 60_000 };
  const shas = (o) => T.timelinePoints({ ...base, ...o }).map((p) => p.sha);
  // Three points: the final and two targets, at a third and two thirds of the run.
  assert.deepEqual(shas({ points: 3 }), ['c25', 'c40', 'c70']);
  // Eight points over four landings is the four landings, each once.
  assert.deepEqual(shas({ points: 8 }), ['c10', 'c25', 'c40', 'c70']);
  assert.equal(T.timelinePoints({ ...base }).length, 4, 'the default is 8, and gives up to 8');
  // A list of minutes: each the newest at or before it; the final is added.
  assert.deepEqual(shas({ minutes: [30, 60] }), ['c25', 'c40', 'c70']);
  // Before any commit there is nothing to score; the final is still one.
  assert.deepEqual(shas({ minutes: [2] }), ['c70']);
  assert.deepEqual(T.timelinePoints({ ...base, points: 3 }).map((p) => [p.kind, p.atMin, p.targetMin === null ? null : Math.round(p.targetMin)]), [['time', 25, 33], ['time', 40, 67], ['final', 70, null]]);
  // A last landing that is not the final tree takes a point of its own, on top of the spaced ones.
  const apart = T.timelinePoints({ ...base, finalSha: 'tip', lastLanding: 'c70', commits: [...landings, { sha: 'tip', ms: T0 + 90 * 60_000 }], points: 4 });
  assert.deepEqual(apart.map((p) => [p.sha, p.kind]), [['c25', 'time'], ['c40', 'time'], ['c70', 'landing'], ['tip', 'final']]);
  // Landings after the last slice are points whatever --points says: here the spaced targets (33 and 66) name c10 and c40.
  const late = T.timelinePoints({ ...base, finalSha: 'c70', lastLanding: 'c70', afterSlices: ['c40', 'c70'], commits: [10, 40, 70].map(at), points: 3 });
  assert.deepEqual(late.map((p) => [p.sha, p.kind]), [['c10', 'time'], ['c40', 'landing'], ['c70', 'final']]);
  // Arm A: the final alone is forced.
  const a = [5, 15, 30, 50, 80].map(at);
  assert.deepEqual(T.timelinePoints({ commits: a, finalSha: 'c80', t0Ms: T0, endMs: T0 + 100 * 60_000, points: 3 }).map((p) => p.sha), ['c30', 'c50', 'c80']);
  // Nothing committed: the final, the stubs, is the one point.
  assert.deepEqual(T.timelinePoints({ commits: [], finalSha: 'root', t0Ms: T0, endMs: T0 + 1000, points: 5 }).map((p) => p.sha), ['root']);
});

/** An arm B plan of an opening task, four slices and a closing check that starts at `closerStart` minutes: what the session saves of it. */
function closingPlan(closerStart) {
  const task = (id, order, dependencies, extra = {}) => ({ id, order, title: id, type: 'ai', status: 'completed', dependencies, attemptUsage: [], ...extra });
  const slices = ['s1', 's2', 's3', 's4'].map((id, i) => task(id, i + 2, ['open']));
  return { tasks: [task('open', 1, []), ...slices, task('close', 6, slices.map((s) => s.id), { attemptUsage: [{ attempt: 1, runner: 'openrouter', startedAt: minutesAfter(closerStart) }] })] };
}

test('chooseTimelinePoints: for arm B every landing after the last slice landed is a point, however few the evenly spaced ones reach', { skip: !hasGit && 'needs git' }, () => {
  // The opening task and four slices land early; the closing check starts at 70 and lands at 90, a repair at 95 is the final tree.
  const b = fixtureRun('B', [5, 10, 20, 30, 40, 90, 95], { plan: closingPlan(70) });
  const a = fixtureRun('A', [5, 10, 20, 30, 40, 90, 95]);
  try {
    const at = (dir, arm, o) => T.chooseTimelinePoints(dir, { arm, ...o }).chosen.map((p) => [p.atMin, p.kind]);
    // Three evenly spaced targets (25, 50, 75) all land on two commits: the closing landing would be missed.
    assert.deepEqual(at(b, 'B', { points: 4 }), [[20, 'time'], [40, 'time'], [90, 'landing'], [95, 'final']]);
    // --points bounds only the evenly spaced part: one point is the final's own slot, and the landings come on top.
    assert.deepEqual(at(b, 'B', { points: 1 }), [[90, 'landing'], [95, 'final']]);
    // --minutes keeps its meaning, the landings added as before.
    assert.deepEqual(at(b, 'B', { minutes: [15] }), [[10, 'time'], [90, 'landing'], [95, 'final']]);
    // Arm A has no landings: its points are as they were.
    assert.deepEqual(at(a, 'A', { points: 4 }), [[20, 'time'], [40, 'time'], [95, 'final']]);
  } finally {
    fs.rmSync(b, { recursive: true, force: true });
    fs.rmSync(a, { recursive: true, force: true });
  }
});

test('judgeFinal: the final point must score as result.json does', () => {
  const resultTests = { passed: 7, failed: 1, errors: 0, collected: 9 };
  assert.deepEqual(T.judgeFinal({ resultTests, final: { tests: { passed: 7, failed: 1, errors: 0, skipped: 2 } } }), { ok: true, reason: null });
  assert.match(T.judgeFinal({ resultTests, final: { tests: { passed: 6, failed: 1, errors: 0 } } }).reason, /scored 6 passed.*result.json says 7/);
  assert.match(T.judgeFinal({ resultTests, final: { error: 'eval box: no engine' } }).reason, /could not be scored: eval box/);
  assert.match(T.judgeFinal({ resultTests: null, final: { tests: { passed: 1 } } }).reason, /no score to compare/);
  assert.match(T.judgeFinal({ resultTests, final: undefined }).reason, /no final point/);
});

test('scoreTimeline scores each point\'s source through the driver\'s own two calls, with no key, at most --jobs at once, and writes timeline.json', { skip: !hasGit && 'needs git' }, async () => {
  const dir = fixtureRun('B', [10, 25, 40, 70]);
  const drive = await import('./drive.mjs');
  const calls = [];
  let live = 0;
  let peak = 0;
  const keyBefore = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-not-a-real-key-0000';
  const driver = {
    // The harness's own materialize, on the fixture repository; the container call is the stand-in.
    materialize: drive.materialize,
    scoreInFreshBox: async (lib, tree, o) => {
      live++;
      peak = Math.max(peak, live);
      calls.push({ source: fs.readFileSync(path.join(tree, 'src', 'tinylib', 'm.py'), 'utf8').trim(), key: process.env.OPENROUTER_API_KEY ?? null, lib, runId: o.runId, settings: o.settings, runDir: o.runDir });
      await new Promise((r) => setTimeout(r, 60));
      live--;
      return { treeCheck: { ok: true }, tests: { passed: 7, failed: 1, errors: 0, skipped: 0 }, copied: ['a'], removed: [], needsInspection: [], patchError: null };
    },
  };
  try {
    const { timeline, ok } = await T.scoreTimeline({ runDir: dir, libraries: tinyLibs, points: 8, jobs: 2, driver });
    assert.equal(ok, true);
    assert.equal(timeline.verified, true);
    assert.deepEqual(calls.map((c) => c.source).sort(), ['v10', 'v25', 'v40', 'v70'], 'each point scored the files of its own commit');
    assert.ok(calls.every((c) => c.key === null), 'a key reached the scoring');
    assert.equal(peak, 2, 'two at once, no more');
    const c = calls[0];
    assert.equal(c.lib.flatTree.length, 40);
    assert.match(c.lib.flatCommit, /^[0-9a-f]{40}$/);
    assert.deepEqual(c.settings, { supervisorLevel: 'act', autorun: true, automerge: true, parallel: 4, cpus: 2, memory: '4g', capUsd: 8, wallCapMs: 3 * 3_600_000, callBudget: L.STEP_LIMIT });
    assert.match(c.runId, /^timescore-[a-z0-9-]+-p\d-[0-9a-f]{8}$/);
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
    assert.deepEqual(file.points.map((p) => [p.atMin, p.kind, p.tests.passed]), [[10, 'time', 7], [25, 'time', 7], [40, 'time', 7], [70, 'final', 7]]);
    assert.equal(file.library, 'tinylib');
    assert.equal(file.arm, 'B');
    assert.equal(file.collected, 9);
    assert.equal(file.unverified, null);
    assert.ok(fs.existsSync(path.join(file.points[0].label ? path.join(dir, 'timeline', file.points[0].label) : dir, 'score.json')));
  } finally {
    if (keyBefore === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = keyBefore;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scoreTimeline marks the timeline unverified, and is not ok, when its final point does not score as result.json does', { skip: !hasGit && 'needs git' }, async () => {
  const dir = fixtureRun('A', [5, 15, 30], { tests: { passed: 5, failed: 0, errors: 0, collected: 9 } });
  const drive = await import('./drive.mjs');
  const driver = { materialize: drive.materialize, scoreInFreshBox: async () => ({ treeCheck: { ok: true }, tests: { passed: 4, failed: 1, errors: 0 }, copied: [], removed: [], needsInspection: [], patchError: null }) };
  try {
    const { timeline, ok } = await T.scoreTimeline({ runDir: dir, libraries: tinyLibs, points: 2, jobs: 1, driver });
    assert.equal(ok, false);
    assert.equal(timeline.verified, false);
    assert.match(timeline.unverified, /final point scored 4 passed.*result.json says 5/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8')).verified, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('timeline.mjs on the command line: the container calls are the eval box\'s, on no network, and no key reaches them; an unscored final point is a non-zero exit', { skip: (!hasGit || process.platform === 'win32') && 'needs git, and spawn finds no .cmd shim for a fake docker' }, () => {
  const dir = fixtureRun('A', [5, 15, 30]);
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-fakedocker-'));
  try {
    const log = path.join(bin, 'calls.jsonl');
    // An engine that is not there: every `run` is refused, anything else (the cleanup) is let through, and each call is written down with the key it saw.
    fs.writeFileSync(path.join(bin, 'docker'), [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), key: process.env.OPENROUTER_API_KEY ?? null }) + '\\n');`,
      "if (process.argv[2] === 'run') { console.error('no engine here'); process.exit(1); }",
    ].join('\n'), { mode: 0o755 });
    const libs = path.join(dir, 'libs.json');
    fs.writeFileSync(libs, JSON.stringify(tinyLibs));
    let status = 0;
    try {
      execFileSync(process.execPath, [path.join(here, 'timeline.mjs'), dir, '--libs', libs, '--minutes', '6,16', '--jobs', '1'], {
        encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NODE_OPTIONS: '', PATH: `${bin}${path.delimiter}${process.env.PATH}`, OPENROUTER_API_KEY: 'sk-or-v1-not-a-real-key-0000' },
      });
    } catch (err) {
      status = err.status;
      assert.match(err.stderr, /UNVERIFIED: the final point could not be scored: .*no engine here/);
    }
    assert.notEqual(status, 0);
    const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const runs = calls.filter((c) => c.argv[0] === 'run');
    assert.equal(runs.length, 3, 'one eval box per point');
    assert.ok(runs.every((c) => c.argv.includes('--network') && c.argv[c.argv.indexOf('--network') + 1] === 'none' && c.argv.some((a) => /^commit0-timescore-.*-eval$/.test(a))));
    assert.ok(calls.every((c) => c.key === null), 'a docker call saw the key');
    const timeline = JSON.parse(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8'));
    assert.equal(timeline.verified, false);
    assert.equal(timeline.points.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('parseTimelineArgs: a run directory and its libraries, the points or the minutes, the jobs', () => {
  const o = T.parseTimelineArgs(['run1', '--libs', 'l.json']);
  assert.deepEqual([o.points, o.minutes, o.jobs], [8, null, 2]);
  assert.equal(o.runDir, path.resolve('run1'));
  const m = T.parseTimelineArgs(['run1', '--libs', 'l.json', '--minutes', '20,40.5,60', '--jobs', '3', '--branch', 'x']);
  assert.deepEqual(m.minutes, [20, 40.5, 60]);
  assert.equal(m.jobs, 3);
  assert.throws(() => T.parseTimelineArgs(['--libs', 'l.json']), /run directory/);
  assert.throws(() => T.parseTimelineArgs(['run1']), /--libs/);
  assert.throws(() => T.parseTimelineArgs(['run1', '--libs', 'l', '--points', '0']), /--points/);
  assert.throws(() => T.parseTimelineArgs(['run1', '--libs', 'l', '--minutes', 'a,b']), /--minutes/);
  assert.throws(() => T.parseTimelineArgs(['run1', '--libs', 'l', '--jobs', '1.5']), /--jobs/);
  assert.throws(() => T.parseTimelineArgs(['run1', 'run2', '--libs', 'l']), /one run directory/);
});

// --- The rehearsal on the fake provider covers the pairs and the batch.json written as runs end. ---

test('judgeBatch also holds the rehearsal\'s batch.json to being finished, with no key reading', () => {
  const record = L.batchRecord({
    keyBeforeUsd: null, keyAfterUsd: null, jobs: 1, overlapped: false, seed: 's', rehearsal: 'a-done', startedAt: 't0', endedAt: 't1',
    runs: [{ lib: 'tlslite-ng', arm: 'A', exit: 0, signal: null, skipped: null, resultDir: '/r/x', recordedUsd: 0.001, valid: true }],
  });
  const want = { lib: 'tlslite-ng', arm: 'A', rehearsal: 'a-done' };
  assert.deepEqual(R.judgeBatch(record, want), []);
  assert.match(R.judgeBatch({ ...record, finished: false, endedAt: null }, want).join(), /not marked finished/);
  assert.match(R.judgeBatch({ ...record, keyReadings: [{ at: 't', usd: 1, after: null }] }, want).join(), /key reading/);
});

test('judgePairBatch: every library\'s two runs found, the batch finished, and the pairs scheduled as --jobs 2 says', () => {
  const at = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const run = (lib, arm, s, e, over = {}) => ({ lib, arm, exit: 0, signal: null, skipped: null, resultDir: `/r/${lib}-${arm}`, startedAt: at(s), endedAt: at(e), ...over });
  const record = L.batchRecord({
    keyBeforeUsd: null, keyAfterUsd: null, jobs: 2, overlapped: true, seed: 's', rehearsal: 'a-done', startedAt: at(0), endedAt: at(200),
    runs: [run('x', 'A', 0, 40), run('x', 'B', 1, 90), run('y', 'A', 95, 140), run('y', 'B', 96, 150)],
  });
  const want = { libs: ['x', 'y'], rehearsal: 'a-done' };
  assert.deepEqual(L.judgePairBatch(record, want), []);
  assert.deepEqual(L.judgePairBatch(null, want), ['no batch.json']);
  assert.match(L.judgePairBatch({ ...record, finished: false }, want).join(), /not marked finished/);
  assert.match(L.judgePairBatch({ ...record, jobs: 1 }, want).join(), /--jobs 2/);
  assert.match(L.judgePairBatch({ ...record, runs: record.runs.slice(0, 3) }, want).join(), /4 runs.*not 3/);
  assert.match(L.judgePairBatch({ ...record, runs: record.runs.map((r) => (r.lib === 'y' && r.arm === 'A' ? { ...r, startedAt: at(50) } : r)) }, want).join(), /y A started .* before x B ended/);
  assert.match(L.judgePairBatch({ ...record, runs: record.runs.map((r) => ({ ...r, resultDir: null })) }, want).join(), /no result directory/);
  assert.match(L.judgePairBatch({ ...record, keyBeforeUsd: 3 }, want).join(), /read the key/);
});

// --- The call budget, both arms alike ---------------------------------------

test('--call-budget sets the built-in runner\'s per-attempt budget of model calls for both arms, the default unchanged, and every result records it', () => {
  assert.equal(L.parseArgs(['--dry-run', '--libs', 'x']).callBudget, L.STEP_LIMIT);
  const o = L.parseArgs(['--dry-run', '--libs', 'x', '--call-budget', '2500']);
  assert.equal(o.callBudget, 2500);
  for (const bad of ['0', '1.5', 'many', '-3']) assert.throws(() => L.parseArgs(['--dry-run', '--libs', 'x', '--call-budget', bad]), /--call-budget takes a whole number/);
  for (const arm of [L.ARMS.A, L.ARMS.B]) {
    const settings = L.armSettings(arm, o);
    assert.equal(settings.callBudget, 2500);
    assert.equal(L.boxSettings(arm, settings).ordewellStepLimit, 2500, 'the box\'s settings.json holds core\'s own key');
    assert.equal(L.armSettings(arm).callBudget, L.STEP_LIMIT);
  }
  const window = L.judgeWindow({ listed: 1048576, snapshot: 1048576 });
  const rec = (arm) => L.resultRecord({ lib: lib(), arm, settings: L.armSettings(arm, o), window, ordewell: { sha: 'abc' }, startedAt: 'a', endedAt: 'b', dryRun: true });
  assert.deepEqual([rec(L.ARMS.A).callBudget, rec(L.ARMS.B).callBudget], [2500, 2500]);
  assert.equal(rec(L.ARMS.A).stepLimit, 2500, 'the older field names the same budget');
  // The run's ending reads arm A's calls against the budget it ran with.
  const logs = { t1: { 1: Array.from({ length: 3 }, () => ({ type: 'usage', record: { source: 'openrouter', inputTokens: 5 } })) } };
  const plan = { tasks: [{ id: 't1', order: 1, title: 't', status: 'completed', attemptUsage: [] }] };
  assert.deepEqual([L.runEnding({ arm: 'A', plan, taskLogs: logs, stepLimit: 3 }).modelCalls.reachedLimit, L.runEnding({ arm: 'A', plan, taskLogs: logs, stepLimit: 4 }).modelCalls.reachedLimit], [true, false]);
});

test('batch.mjs passes --call-budget to every run as given', () => {
  const r = L.parseBatchArgs(['--dry-run', '--libs', 'l.json', '--call-budget', '3000']);
  assert.equal(r.callBudget, 3000);
  assert.deepEqual(r.driveArgs, ['--dry-run', '--libs', path.resolve('l.json'), '--call-budget', '3000']);
  assert.throws(() => L.parseBatchArgs(['--dry-run', '--libs', 'l.json', '--call-budget', '0']), /--call-budget/);
});

test('judgeArmPair: a pair whose arms ran with different call budgets is not valid, and one that ran with the same is', () => {
  const run = (arm, callBudget) => ({ lib: 'x', arm, callBudget, valid: true });
  assert.deepEqual(L.judgeArmPair(run('A', 2000), run('B', 2000)), { valid: true, invalidReasons: [] });
  const bad = L.judgeArmPair(run('A', 2000), run('B', 1000));
  assert.equal(bad.valid, false);
  assert.match(bad.invalidReasons[0], /arm A ran with a call budget of 2000, arm B with 1000/);
  // A result written before the flag ran with the constant.
  assert.equal(L.judgeArmPair({ arm: 'A' }, { arm: 'B', callBudget: L.STEP_LIMIT }).valid, true);
  assert.equal(L.judgeArmPair({ arm: 'A' }, { arm: 'B', callBudget: 5 }).valid, false);
  // The batch record carries the verdict for each library that has both arms.
  const rec = L.batchRecord({ jobs: 2, overlapped: true, runs: [run('A', 2000), run('B', 1000), { lib: 'y', arm: 'A', callBudget: 7 }] });
  assert.deepEqual(rec.pairs.map((p) => [p.lib, p.valid]), [['x', false]]);
  assert.match(rec.pairs[0].invalidReasons[0], /call budget/);
  // The rehearsal's pair judgement fails on it too.
  const timed = (r, s, e) => ({ ...r, resultDir: `/d/${r.arm}`, startedAt: s, endedAt: e });
  const batch = { rehearsal: 'a-done', keyBeforeUsd: null, keyAfterUsd: null, keyReadings: [], finished: true, jobs: 2, runs: [timed(run('A', 2000), '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z'), timed(run('B', 1000), '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z')] };
  assert.match(L.judgePairBatch(batch, { libs: ['x'], rehearsal: 'a-done' }).join('\n'), /call budget/);
  batch.runs[1].callBudget = 2000;
  assert.deepEqual(L.judgePairBatch(batch, { libs: ['x'], rehearsal: 'a-done' }), []);
});

// --- Timeline: a fully merged run, and a point that was killed --------------

test('runHistory: a fully merged arm B run, whose workdir holds only commit0-base and a stale remote ref, is read from the first-parent line of commit0-base, with or without --branch', { skip: !hasGit && 'needs git' }, () => {
  const dir = fixtureRun('B', [10, 25, 40, 70], { merged: true });
  try {
    const wantTimes = [10, 25, 40, 70];
    const h = T.runHistory(dir, { arm: 'B' });
    assert.equal(h.branch, 'commit0-base');
    assert.deepEqual(h.commits.map((c) => [(c.ms - T0) / 60_000, c.subject]), wantTimes.map((m, i) => [m, `land task ${i + 1}`]));
    assert.equal(h.final, h.commits.at(-1).sha);
    assert.equal(h.lastLanding, h.final);
    // With --branch it is still the first-parent line: a full `git log` would score each slice's own commit as a point.
    const named = T.runHistory(dir, { arm: 'B', branch: 'commit0-base' });
    assert.deepEqual(named.commits.map((c) => c.subject), h.commits.map((c) => c.subject));
    assert.ok(!named.commits.some((c) => /^task \d/.test(c.subject)), 'a slice\'s own commit is not on the first-parent line');
    // The stale remote ref is not taken for the run's work.
    assert.equal(T.chooseTimelinePoints(dir, { arm: 'B', points: 8 }).chosen.at(-1).sha, h.final);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a point whose pytest was killed and printed no counts is not a score: it fails, is retried once alone, and stays out of the threshold crossings if it fails again', { skip: !hasGit && 'needs git' }, async () => {
  assert.equal(T.isKilledRun({ exit: 137 }), true);
  assert.equal(T.isKilledRun({ exit: 137, passed: 0, failed: 0 }), false, 'a summary was printed: the counts are what they say');
  assert.equal(T.isKilledRun({ exit: 1 }), false);
  assert.equal(T.isKilledRun(null), false);
  const drive = await import('./drive.mjs');
  const killed = { exit: 137, timedOut: false };
  const counted = (passed) => ({ exit: 1, passed, failed: 1, errors: 0, skipped: 0 });
  /** A driver that kills the sources `kills` says, as many times as it says, and notes how many were scoring at once. */
  const driverFor = (kills) => {
    const seen = {};
    const log = [];
    let live = 0;
    return {
      log,
      materialize: drive.materialize,
      scoreInFreshBox: async (lib, tree) => {
        const source = fs.readFileSync(path.join(tree, 'src', 'tinylib', 'm.py'), 'utf8').trim();
        seen[source] = (seen[source] ?? 0) + 1;
        live++;
        log.push({ source, attempt: seen[source], liveAtStart: live });
        await new Promise((r) => setTimeout(r, 40));
        live--;
        const dead = seen[source] <= (kills[source] ?? 0);
        return { treeCheck: { ok: true }, tests: dead ? killed : counted(source === 'v70' ? 7 : { v10: 2, v25: 4, v40: 6 }[source]), copied: [], removed: [], needsInspection: [], patchError: null };
      },
    };
  };
  // Killed once, then scored: the retry is alone, and the point counts.
  const once = fixtureRun('B', [10, 25, 40, 70], { tests: { passed: 7, failed: 1, errors: 0, collected: 8 } });
  try {
    const driver = driverFor({ v25: 1 });
    const { timeline, ok } = await T.scoreTimeline({ runDir: once, libraries: tinyLibs, points: 8, jobs: 3, driver });
    const p = timeline.points.find((x) => x.atMin === 25);
    assert.deepEqual([p.ok, p.retried, p.killed ?? false, p.tests.passed], [true, true, false, 4]);
    assert.deepEqual(driver.log.filter((l) => l.source === 'v25').map((l) => l.attempt), [1, 2]);
    assert.equal(driver.log.find((l) => l.source === 'v25' && l.attempt === 2).liveAtStart, 1, 'the retry ran alone');
    assert.equal(ok, true);
    assert.equal(timeline.crossings.find((c) => c.share === 0.5).atMin, 25);
  } finally {
    fs.rmSync(once, { recursive: true, force: true });
  }
  // Killed both times: failed, marked, retried only once, kept out of the crossings, and the exit says so.
  const twice = fixtureRun('B', [10, 25, 40, 70], { tests: { passed: 7, failed: 1, errors: 0, collected: 8 } });
  try {
    const driver = driverFor({ v25: 5, v40: 5 });
    const { timeline, ok } = await T.scoreTimeline({ runDir: twice, libraries: tinyLibs, points: 8, jobs: 3, driver });
    const p = timeline.points.find((x) => x.atMin === 25);
    assert.deepEqual([p.ok, p.retried, p.killed], [false, true, true]);
    assert.match(p.error, /killed \(exit 137\).*no counts/);
    assert.deepEqual(driver.log.filter((l) => l.source === 'v25').map((l) => l.attempt), [1, 2], 'one retry, no more');
    assert.equal(ok, false);
    assert.equal(timeline.verified, true, 'the final point scored as result.json does');
    // 6 of 8 passed at 40 minutes is 75%, but that point was killed: the 75% crossing is the final's, 70 minutes.
    const at = (share) => timeline.crossings.find((c) => c.share === share)?.atMin ?? null;
    assert.deepEqual([at(0.25), at(0.5), at(0.75), at(1)], [10, 70, 70, null]);
    assert.ok(timeline.crossings.every((c) => c.label === null || !['p2', 'p3'].some((l) => c.label.startsWith(l))));
  } finally {
    fs.rmSync(twice, { recursive: true, force: true });
  }
});

// --- Spend at one price table -----------------------------------------------

test('referenceSpend prices the token counts of the planner\'s ledger (the supervisor\'s turns are in it) and of every attempt at the harness\'s one fixed table', () => {
  // Synthetic counts. By hand at the table's per-million prices, fresh input 0.3, cached input 0.006, output 1.2:
  //   planner: 200,000 in of which 150,000 cached, 10,000 out -> 50,000 fresh -> 0.015 + 0.0009 + 0.012 = 0.0279
  //   attempt 1: 1,000,000 in of which 600,000 cached, 100,000 out -> 0.12 + 0.0036 + 0.12 = 0.2436
  //   attempt 2 (a subtask's): 0 cached, 500,000 in, 0 out -> 0.15
  assert.deepEqual(L.REFERENCE_PRICES.usdPerMTok, { freshInput: 0.3, cachedInput: 0.006, output: 1.2 });
  const plan = {
    plannerUsage: { totals: { inputTokens: 200_000, cachedInputTokens: 150_000, outputTokens: 10_000, reportedCost: { USD: 9 } } },
    tasks: [{
      id: 't1', order: 1, title: 'a',
      attemptUsage: [{ attempt: 1, runner: 'openrouter', totals: { inputTokens: 1_000_000, cachedInputTokens: 600_000, outputTokens: 100_000, reportedCost: { USD: 5 } } }],
      subtasks: [{ id: 't1.1', order: 1, title: 'b', attemptUsage: [{ attempt: 1, runner: 'openrouter', totals: { inputTokens: 500_000, outputTokens: 0 } }] }],
    }],
  };
  const r = L.referenceSpend(plan);
  assert.deepEqual(r.planner, { freshInputTokens: 50_000, cachedInputTokens: 150_000, outputTokens: 10_000, usd: 0.0279 });
  assert.deepEqual(r.attempts.map((a) => [a.task, a.attempt, a.freshInputTokens, a.cachedInputTokens, a.outputTokens, a.usd]), [
    ['t1', 1, 400_000, 600_000, 100_000, 0.2436],
    ['t1.1', 1, 500_000, 0, 0, 0.15],
  ]);
  assert.deepEqual(r.tokens, { freshInput: 950_000, cachedInput: 750_000, output: 110_000 });
  assert.equal(r.usd, 0.4215);
  assert.equal(r.unmeasured, 0);
  assert.equal(r.priceTable.id, L.REFERENCE_PRICES.id);
  // What the provider billed does not enter it: the table is the point.
  assert.notEqual(r.usd, 14);
  // An attempt with no token counts is counted as unmeasured, never priced at zero as if it were.
  const gap = L.referenceSpend({ tasks: [{ id: 'x', order: 1, title: 'x', attemptUsage: [{ attempt: 1, runner: 'r', totals: {} }] }] });
  assert.equal(gap.unmeasured, 1);
  assert.equal(gap.usd, null);
  const none = L.referenceSpend(null);
  assert.deepEqual([none.usd, none.planner, none.attempts, none.unmeasured, none.priceTable.id], [null, null, [], 0, L.REFERENCE_PRICES.id], 'a run with no plan holds the table and no spend');
});

test('a result carries referenceSpend beside the recorded spend, and batch.json sums it per arm', () => {
  const window = L.judgeWindow({ listed: 1048576, snapshot: 1048576 });
  const spend = { tokens: { freshInput: 1, cachedInput: 2, output: 3 }, usd: 0.5, planner: null, attempts: [], unmeasured: 0, priceTable: L.REFERENCE_PRICES };
  const r = L.resultRecord({ lib: lib(), arm: L.ARMS.B, window, ordewell: { sha: 'abc' }, referenceSpend: spend, startedAt: 'a', endedAt: 'b', dryRun: true });
  assert.deepEqual(r.referenceSpend, spend);
  assert.equal(r.referenceUsd, 0.5);
  assert.equal(L.resultRecord({ lib: lib(), arm: L.ARMS.B, window, ordewell: { sha: 'abc' }, startedAt: 'a', endedAt: 'b', dryRun: true }).referenceUsd, null);
  const run = (lib, arm, recordedUsd, referenceUsd, tokens) => ({ lib, arm, recordedUsd, referenceUsd, referenceTokens: tokens });
  const b = L.batchRecord({ jobs: 2, overlapped: true, runs: [
    run('x', 'A', 1, 0.25, { freshInput: 10, cachedInput: 20, output: 5 }),
    run('x', 'B', 4, 0.5, { freshInput: 1, cachedInput: 2, output: 3 }),
    run('y', 'A', 2, 0.75, { freshInput: 10, cachedInput: 0, output: 5 }),
    run('y', 'B', 3, null, null),
  ] });
  assert.deepEqual(b.perArm.A, { runs: 2, efforts: {}, recordedUsd: 3, referenceUsd: 1, referenceTokens: { freshInput: 20, cachedInput: 20, output: 10 }, unpricedAtReference: [] });
  assert.deepEqual(b.perArm.B, { runs: 2, efforts: {}, recordedUsd: 7, referenceUsd: 0.5, referenceTokens: { freshInput: 1, cachedInput: 2, output: 3 }, unpricedAtReference: ['y B'] });
  assert.equal(b.referencePriceTable.id, L.REFERENCE_PRICES.id);
});

test('the rehearsal fails a result that does not record the call budget it ran with or its spend at the reference price table', () => {
  const base = { aborted: null, valid: true, scoredFrom: 'task-worktree', steps: { run: { exit: 0, ended: 'by itself' } }, ending: { by: 'completion', status: 'done', reason: null, modelCalls: { used: 3, limitPerAttempt: 10, reachedLimit: false } }, providerSwitches: { attempts: 1, attemptsSwitched: 0, switches: 0 } };
  const f = (extra) => R.judgeRehearsal('a-done', { ...base, ...extra }).join('\n');
  assert.match(f({}), /budget the arm ran with is not recorded/);
  assert.match(f({}), /no spend at the reference price table/);
  const fields = { callBudget: 10, stepLimit: 10, referenceUsd: 0.1, referenceSpend: { priceTable: L.REFERENCE_PRICES } };
  assert.doesNotMatch(f(fields), /budget the arm|reference price table/);
});

// --- The control arm: arm A, continued until the caps -------------------------

test('--continue-a makes arm A a continued arm under its own label, which no run of plain A can carry', () => {
  const d = L.parseArgs(['--dry-run', '--libs', 'l.json', '--continue-a']);
  assert.equal(d.continueA, true);
  assert.equal(L.parseArgs(['--dry-run', '--libs', 'l.json']).continueA, false);
  assert.deepEqual(L.armsOf('both', true).map((a) => a.id), ['A-continued', 'B']);
  assert.deepEqual(L.armsOf('A', true).map((a) => a.id), ['A-continued']);
  assert.deepEqual(L.armsOf('both').map((a) => a.id), ['A', 'B'], 'without the flag nothing changes');
  assert.deepEqual(L.armsOf('B', true).map((a) => a.id), ['B'], 'the flag has nothing to continue in arm B');
  // Arm A's box: the same settings, supervisor off, nothing merged on its behalf.
  const settings = L.armSettings(L.ARMS['A-continued']);
  assert.deepEqual(settings, L.armSettings(L.ARMS.A));
  assert.deepEqual(L.boxSettings(L.ARMS['A-continued']), L.boxSettings(L.ARMS.A));
  assert.ok(L.isSingleAgent('A') && L.isSingleAgent('A-continued') && !L.isSingleAgent('B'));
  assert.notEqual(L.runIdFor({ stamp: '2026-01-01T00-00-00', lib: 'x', arm: 'A-continued' }), L.runIdFor({ stamp: '2026-01-01T00-00-00', lib: 'x', arm: 'A' }));
  assert.equal(L.runIdFor({ stamp: '2026-01-01T00-00-00', lib: 'x', arm: 'A-continued' }), '2026-01-01t00-00-00-x-a-continued');
  // It is arm A's flag: asked of arm B alone, or of a plan, it is refused rather than ignored.
  assert.throws(() => L.parseArgs(['--dry-run', '--libs', 'l.json', '--continue-a', '--arm', 'B']), /--continue-a.*arm A/);
  assert.throws(() => L.parseArgs(['--run', '--libs', 'l.json', '--provider-pin', 'p', '--continue-a', '--plan-only']), /--continue-a.*no plan/);
  // A batch carries it to each A run as the flag, and to none of B's.
  const b = L.parseBatchArgs(['--dry-run', '--libs', 'l.json', '--continue-a']);
  assert.equal(b.continueA, true);
  assert.deepEqual(L.armsOf(b.arm, b.continueA).map((a) => a.id), ['A-continued', 'B']);
  assert.deepEqual(L.driveArmArgs(L.ARMS['A-continued']), ['--arm', 'A', '--continue-a']);
  assert.deepEqual(L.driveArmArgs(L.ARMS.A), ['--arm', 'A']);
  assert.deepEqual(L.driveArmArgs(L.ARMS.B), ['--arm', 'B']);
  const cmds = (arm) => L.armCommands(arm, { workspace: '/w', goal: 'g', sessionId: 's1' }).map((c) => c.join(' '));
  assert.equal(cmds(L.ARMS['A-continued']).length, cmds(L.ARMS.A).length + 1);
  assert.match(cmds(L.ARMS['A-continued'])[2], /^ordewell continue 1 <the continuation message.*> --session-id s1 --workspace \/w$/);
  assert.throws(() => L.parseBatchArgs(['--dry-run', '--libs', 'l.json', '--continue-a', '--arm', 'B']), /--continue-a.*arm A/);
});

test('the continuation message is one neutral constant: the limits are not reached, context compacts by itself, calls remain, keep going', () => {
  assert.equal(typeof L.CONTINUE_MESSAGE, 'string');
  assert.match(L.CONTINUE_MESSAGE, /time and spend limits/i);
  assert.match(L.CONTINUE_MESSAGE, /not been reached/i);
  assert.match(L.CONTINUE_MESSAGE, /context is compacted automatically/i);
  assert.match(L.CONTINUE_MESSAGE, /calls remain/i);
  assert.match(L.CONTINUE_MESSAGE, /continue the task until its goal is met/i);
  // It names nothing of the work or of another arm: no library, test, file, plan or task.
  assert.doesNotMatch(L.CONTINUE_MESSAGE, /implement|tests?\b|fail|\.py|module|planner|ordewell|\barm\b|parallel/i);
  assert.ok(L.CONTINUE_MESSAGE.length < 400);
});

test('attemptEnded reads an attempt that has ended with a verdict, never one at work or waiting on a person', () => {
  const task = (over = {}) => ({ id: 't1', order: 1, title: 'Implement', type: 'ai', status: 'failed', dependencies: [], attemptUsage: [{ attempt: 1 }], verdict: { outcome: 'fail', reported: 'failed' }, handoff: { summary: 'the imports do not resolve' }, ...over });
  const ended = (t, activity = null) => L.attemptEnded({ plan: { tasks: [t], approved: true }, activity });
  assert.deepEqual(ended(task()), { verdict: 'failed', summary: 'the imports do not resolve', attempts: 1, status: 'failed' });
  assert.equal(ended(task({ status: 'completed', verdict: { outcome: 'pass', reported: 'done' } })).verdict, 'done');
  assert.equal(ended(task({ verdict: { outcome: 'fail', reported: 'blocked' } })).verdict, 'blocked');
  // No report: an attempt that ended in prose, the runner having said nothing through task_complete.
  const none = ended(task({ verdict: { outcome: 'fail', reason: 'no report' }, handoff: undefined, outputSummary: { report: 'I think I am done.', reviewReason: '', logTail: '', capturedAt: 'x' } }));
  assert.deepEqual([none.verdict, none.summary], ['no report', 'I think I am done.']);
  assert.equal(ended(task({ status: 'completed', verdict: undefined })).verdict, 'done', 'a completed task nothing else was kept for reports done, as the ending reads it');
  assert.equal(ended(task({ handoff: undefined, outputSummary: undefined })).summary, null);
  assert.equal(ended(task({ handoff: { summary: 'x'.repeat(2000) } })).summary.length, 600);
  // Not ended: at work, starting, waiting to advance on its own, parked on a person, or not begun.
  assert.equal(ended(task({ status: 'in_progress' })), null);
  assert.equal(ended(task(), { running: true }), null);
  assert.equal(ended(task(), { starting: true }), null);
  assert.equal(ended(task(), { advancesOnItsOwn: true }), null);
  assert.equal(ended(task(), { advancesOnItsOwn: false }).verdict, 'failed');
  assert.equal(ended(task({ status: 'awaiting_user', awaitingReason: 'checkpoint' })), null, 'a checkpoint is the agent asking, which the stall rule judges');
  // A turn that ended in prose with no report leaves the built-in runner's task parked on input: an end with no report, which a reply continues.
  const parked = ended(task({ status: 'awaiting_user', awaitingReason: 'input', verdict: undefined, handoff: undefined, outputSummary: { report: 'Nothing to report.', reviewReason: '', logTail: '', capturedAt: 'x' } }));
  assert.deepEqual(parked, { verdict: 'no report', summary: 'Nothing to report.', attempts: 1, status: 'awaiting_user' });
  assert.equal(ended(task({ status: 'awaiting_user', awaitingReason: 'input' }), { running: true }).verdict, 'no report', 'the parked task holds its live session, which the run view counts as running');
  assert.equal(ended(task({ status: 'awaiting_user', awaitingReason: 'usage-limit' })), null, 'a usage limit waits on the clock');
  assert.equal(ended(task({ status: 'pending', attemptUsage: [] })), null);
  assert.equal(L.attemptEnded({ plan: null, activity: null }), null);
  assert.equal(L.attemptEnded({ plan: { tasks: [task(), task({ id: 't2', order: 2 })] }, activity: null }), null, 'arm A is one task: two is not its shape');
});

test('continueDecision keeps room for a call, bounds the continuations, and gives up on three that do nothing', () => {
  const room = { elapsedMs: 60 * 60_000, spentUsd: 2, capUsd: 8, wallCapMs: 3 * 60 * 60_000 };
  const idle = { calls: 2, treeChanged: false };
  const busy = { calls: 40, treeChanged: true };
  assert.deepEqual(L.CONTINUATION, { minWallMs: 180_000, minUsd: 0.1, max: 40, giveUpRun: 3, giveUpCalls: 2 });
  assert.deepEqual(L.continueDecision({ ...room, history: [] }), { go: true, why: null });
  // The margins are inclusive: exactly 3 minutes and exactly $0.10 left is room.
  assert.equal(L.continueDecision({ ...room, history: [], elapsedMs: 3 * 60 * 60_000 - 180_000 }).go, true);
  assert.deepEqual(L.continueDecision({ ...room, history: [], elapsedMs: 3 * 60 * 60_000 - 179_999 }), { go: false, why: 'no-room-wall' });
  assert.equal(L.continueDecision({ ...room, history: [], spentUsd: 7.9 }).go, true);
  assert.deepEqual(L.continueDecision({ ...room, history: [], spentUsd: 7.901 }), { go: false, why: 'no-room-spend' });
  // At most 40 continuations.
  assert.equal(L.continueDecision({ ...room, history: Array.from({ length: 39 }, () => busy) }).go, true);
  assert.deepEqual(L.continueDecision({ ...room, history: Array.from({ length: 40 }, () => busy) }), { go: false, why: 'max-continuations' });
  // Three in a row within two calls and the tree unchanged: given up. One that did something, or a busy one among them, is not.
  assert.deepEqual(L.continueDecision({ ...room, history: [busy, idle, idle, idle] }), { go: false, why: 'gave-up' });
  assert.equal(L.continueDecision({ ...room, history: [idle, idle] }).go, true, 'two are not three');
  assert.equal(L.continueDecision({ ...room, history: [idle, idle, { calls: 2, treeChanged: true }] }).go, true, 'a changed tree is work');
  assert.equal(L.continueDecision({ ...room, history: [idle, idle, { calls: 3, treeChanged: false }] }).go, true, 'three calls are not within two');
  assert.equal(L.continueDecision({ ...room, history: [idle, idle, idle, busy] }).go, true, 'it is the last three in a row');
  assert.equal(L.continueDecision({ ...room, history: [{ calls: 0, treeChanged: false }, { calls: 1, treeChanged: false }, idle] }).go, false);
  // An attempt whose calls or tree could not be read is not evidence of idleness.
  assert.equal(L.continueDecision({ ...room, history: [idle, idle, { calls: null, treeChanged: null }] }).go, true);
  // The caps come first: no room is no room, however idle.
  assert.equal(L.continueDecision({ ...room, history: [idle, idle, idle], spentUsd: 7.95 }).why, 'no-room-spend');
});

test('the continuation record follows each attempt: when it ended, its verdict and summary, calls and spend so far, and what the next one did', () => {
  const state = L.createContinuation();
  const end = (over = {}) => ({ verdict: 'failed', summary: 'cannot import', attempts: 1, ...over });
  const at = (n) => `2026-11-21T10:0${n}:00.000Z`;
  const step = (over) => L.continuationStep(state, { ended: end(), fingerprint: 'tree-0', usageLines: 12, spentUsd: 0.4, elapsedMs: 600_000, capUsd: 8, wallCapMs: 3 * 3_600_000, now: at(0), ...over });

  // The first attempt ended failed with 12 calls: continue, and say so.
  const first = step();
  assert.equal(first.action, 'send');
  assert.deepEqual(first.record, { n: 1, at: at(0), atMs: 600_000, mode: 'session', after: { attempt: 1, verdict: 'failed', summary: 'cannot import' }, callsSoFar: 12, spentUsd: 0.4, calls: null, treeChanged: null });
  assert.deepEqual(state.first, { verdict: 'failed', summary: 'cannot import', attempts: 1, atMs: 600_000, callsSoFar: 12, spentUsd: 0.4 });
  L.markSent(state, first.record, { fingerprint: 'tree-0', usageLines: 12, attempts: 1 });

  assert.equal(L.markSent(L.createContinuation(), { n: 1 }, { fingerprint: 'x', usageLines: 1, attempts: 1 }).via, 'continue');
  assert.deepEqual(['session', 'message'], (() => { const r = L.markSent(L.createContinuation(), { n: 1 }, { fingerprint: 'x', usageLines: 1, attempts: 1 }, { via: 'message' }); return [r.mode, r.via]; })(), 'the reply to a parked task goes into the live session');

  // The new attempt has not begun (its status is still the old one's): wait.
  assert.deepEqual(step({ ended: end() }), { action: 'wait' });
  // It began and ended: 40 calls, the tree changed; the second continuation names that attempt's verdict.
  const second = step({ ended: end({ attempts: 2, verdict: 'done', summary: 'all done' }), fingerprint: 'tree-1', usageLines: 52, spentUsd: 1.1, elapsedMs: 1_200_000, now: at(1) });
  assert.equal(second.action, 'send');
  assert.deepEqual([first.record.calls, first.record.treeChanged], [40, true], 'the first continuation is closed with what its attempt did');
  assert.deepEqual(second.record.after, { attempt: 2, verdict: 'done', summary: 'all done' });
  assert.deepEqual([second.record.n, second.record.callsSoFar, second.record.spentUsd], [2, 52, 1.1]);
  L.markSent(state, second.record, { fingerprint: 'tree-1', usageLines: 52, attempts: 2 });

  // A running attempt seen in between counts as begun even where its count and calls have not moved yet.
  state.sawLive = true;
  assert.equal(step({ ended: end({ attempts: 2 }), fingerprint: 'tree-1', usageLines: 52 }).action, 'send');
});

test('the continuation record gives up on three idle attempts and stops where the caps leave no room', () => {
  const idle = (calls = 1) => ({ calls, treeChanged: false });
  const run = (history, over = {}) => {
    const state = L.createContinuation();
    state.continuations = history.map((h, i) => ({ n: i + 1, ...h }));
    if (history.length) state.sent = { record: state.continuations.at(-1), fingerprint: 'same', usageLines: 100, attempts: history.length };
    state.continuations.at(-1) && Object.assign(state.continuations.at(-1), { calls: null, treeChanged: null });
    return [state, L.continuationStep(state, { ended: { verdict: 'done', summary: 's', attempts: history.length + 1 }, fingerprint: 'same', usageLines: 100 + (over.lastCalls ?? 1), spentUsd: 1, elapsedMs: 1000, capUsd: 8, wallCapMs: 3 * 3_600_000, now: 't', ...over })];
  };
  // The last attempt made one call and left the tree: with two idle before it, three in a row.
  const [state, d] = run([idle(), idle(), { calls: null, treeChanged: null }]);
  assert.deepEqual([d.action, d.why], ['stop', 'gave-up']);
  assert.deepEqual(state.stop, { why: 'gave-up', atMs: 1000, spentUsd: 1, callsSoFar: 101 });
  assert.equal(run([idle(), idle(), { calls: null, treeChanged: null }], { lastCalls: 5 })[1].action, 'send', 'five calls are work');
  assert.equal(run([idle(), { calls: null, treeChanged: null }])[1].action, 'send', 'two idle attempts are not three');
  assert.equal(run([{ calls: null, treeChanged: null }], { spentUsd: 7.95 })[1].why, 'no-room-spend');
  assert.equal(run([{ calls: null, treeChanged: null }], { elapsedMs: 3 * 3_600_000 - 1000 })[1].why, 'no-room-wall');
  // No tree reading (the box could not be asked) is not an idle attempt.
  assert.equal(run([idle(), idle(), { calls: null, treeChanged: null }], { fingerprint: null })[1].action, 'send');
});

test('continuationRecord is what result.json holds of a continued run, the message and margins included', () => {
  const state = L.createContinuation();
  assert.deepEqual(L.continuationRecord(state), { message: L.CONTINUE_MESSAGE, margins: L.CONTINUATION, first: null, continuations: [], count: 0, fresh: 0, stop: null });
  state.continuations = [{ n: 1, mode: 'session' }, { n: 2, mode: 'fresh' }, { n: 3, mode: 'session' }];
  state.stop = { why: 'gave-up' };
  const r = L.continuationRecord(state);
  assert.deepEqual([r.count, r.fresh, r.stop.why], [3, 1, 'gave-up']);
  assert.equal(L.continuationRecord(null), null, 'a plain arm has none');
});

test('runEnding says a continued run ended by its own continuation rule, apart from a cap, and counts its attempts\' calls like arm A\'s', () => {
  const use = (n) => Array.from({ length: n }, () => ({ type: 'usage', record: { source: 'openrouter', inputTokens: 5 } }));
  const plan = { tasks: [{ id: 't1', order: 1, title: 'task 1', type: 'ai', status: 'failed', dependencies: [], attemptUsage: [], verdict: { outcome: 'fail', reported: 'failed' } }] };
  const taskLogs = { t1: { 1: use(3), 2: use(2), 3: use(1) } };
  const stop = { why: 'gave-up', atMs: 5000, spentUsd: 1.25, callsSoFar: 6 };
  const e = L.runEnding({ arm: 'A-continued', plan, taskLogs, stopped: null, stalled: null, continuation: { stop, count: 2 } });
  assert.deepEqual([e.by, e.why, e.continuations, e.spentUsd, e.atMs], ['continuation', 'gave-up', 2, 1.25, 5000]);
  assert.deepEqual(e.modelCalls.perAttempt, [{ attempt: 1, calls: 3 }, { attempt: 2, calls: 2 }, { attempt: 3, calls: 1 }]);
  assert.equal(e.modelCalls.used, 6);
  // A cap still names itself: the existing stop rules win across continuations.
  assert.equal(L.runEnding({ arm: 'A-continued', plan, taskLogs, stopped: { why: 'spend', atMs: 9, spentUsd: 8.01 }, stalled: null, continuation: { stop: null, count: 4 } }).by, 'cap');
  // A continued run that ended with no continuation rule reads like arm A's: its completion.
  assert.equal(L.runEnding({ arm: 'A-continued', plan, taskLogs, stopped: null, stalled: null, continuation: { stop: null, count: 0 } }).by, 'completion');
});

test('the control arm\'s rehearsal scenarios run arm A-continued, and the judge reads what each continuation recorded and what the runner was sent', () => {
  for (const name of ['a-continued', 'a-continued-cap']) {
    assert.equal(R.scenario(name).arm, 'A-continued');
    // The scripted agent ends its attempt early and is continued in the same attempt: one script, the steps after its last turn.
    assert.equal(R.scenario(name).attempts({ src: 'pkg', tests: 'tests', longSec: 1 }).A.length, 1);
  }
  const message = L.CONTINUE_MESSAGE;
  const rec = (n, verdict, extra = {}) => ({ n, at: `2026-11-21T10:0${n}:00.000Z`, atMs: n * 1000, mode: 'session', via: n === 3 ? 'message' : 'continue', after: { attempt: n, verdict, summary: verdict === 'no report' ? null : 's' }, callsSoFar: n * 10, spentUsd: n / 10, calls: 12, treeChanged: true, ...extra });
  const result = {
    arm: 'A-continued',
    continuation: {
      message, margins: L.CONTINUATION, first: { verdict: 'failed' }, count: 4, fresh: 0, stop: { why: 'gave-up' },
      continuations: [rec(1, 'failed'), rec(2, 'done', { calls: 1, treeChanged: false }), rec(3, 'no report', { calls: 1, treeChanged: false }), rec(4, 'done', { calls: 2, treeChanged: false })],
    },
  };
  const goal = 'Implement the library.';
  const request = (users, attempt = 1) => ({ turn: { role: 'runner', key: 'A', attempt, round: 0 }, messages: [{ role: 'system', content: 's' }, ...users.map((content) => ({ role: 'user', content }))] });
  const requests = [request([goal]), request([goal, message]), request([goal, message, message, message, message])];
  assert.deepEqual(R.judgeContinued('a-continued', result, requests, message), []);
  assert.deepEqual(R.judgeContinued('a-done', result, requests, message), [], 'a scenario that continues nothing has nothing to judge');

  const f = (r, reqs = requests, name = 'a-continued') => R.judgeContinued(name, r, reqs, message).join('\n');
  assert.match(f({ ...result, arm: 'A' }), /not A-continued/);
  assert.match(f({ ...result, continuation: undefined }), /no continuation record/);
  assert.match(f({ ...result, continuation: { ...result.continuation, message: 'Please continue.' } }), /not the harness's constant/);
  assert.match(f({ ...result, continuation: { ...result.continuation, continuations: result.continuation.continuations.slice(0, 3) } }), /followed \["failed","done","no report"\]/);
  assert.match(f({ ...result, continuation: { ...result.continuation, continuations: result.continuation.continuations.map((c, i) => (i === 1 ? { ...c, mode: 'fresh', via: 'retry' } : c)) } }), /continuation 2 was fresh \(retry\)/);
  assert.match(f({ ...result, continuation: { ...result.continuation, continuations: result.continuation.continuations.map((c, i) => (i === 2 ? { ...c, via: 'continue' } : c)) } }), /continuation 3 went in by "continue", wanted "message"/);
  assert.match(f({ ...result, continuation: { ...result.continuation, continuations: result.continuation.continuations.map((c, i) => (i === 0 ? { ...c, after: { verdict: 'failed', summary: null } } : c)) } }), /continuation 1 records no summary/);
  assert.match(f({ ...result, continuation: { ...result.continuation, continuations: result.continuation.continuations.map((c, i) => (i === 3 ? { ...c, calls: 9 } : c)) } }), /continuation 4's attempt made 9 calls.*busy, wanted idle/);
  assert.match(f({ ...result, continuation: { ...result.continuation, continuations: result.continuation.continuations.map((c, i) => (i === 2 ? { ...c, callsSoFar: 5 } : c)) } }), /continuation 3: 5 calls so far/);
  assert.match(f({ ...result, continuation: { ...result.continuation, stop: null } }), /stopped for null, wanted "gave-up"/);
  // The runner: the message once per continuation, in the one session whose first message stays the task's.
  assert.match(f(result, [request([goal]), request([goal, message])]), /sent the message 1 time\(s\) in its session, wanted 4/);
  assert.match(f(result, [request([goal]), request(['another goal', message, message, message, message])]), /does not open on the task's own first message/);
  assert.match(f(result, requests.map((r, i) => (i === 2 ? request([goal, message, message, message, message], 2) : r))), /second attempt/);
  // The cap scenario stops on a cap, so it holds no continuation rule's stop, and its last continuation is cut.
  const capped = { ...result, continuation: { ...result.continuation, count: 2, stop: null, continuations: [rec(1, 'failed'), rec(2, 'done', { calls: null, treeChanged: null })] } };
  assert.deepEqual(R.judgeContinued('a-continued-cap', capped, [request([goal]), request([goal, message, message])], message), []);
});

// --- Module-level skips are not test outcomes --------------------------------
// pytest reports a module that calls pytest.importorskip at import as one
// skipped outcome, though none of its tests is a collected item. The numbers
// below are synthetic: a library of 10 collected tests plus 3 such modules.

const progress = (chars) => chars.match(/.{1,6}/g).map((l, i, all) => `${l.padEnd(6)} [${String(Math.round(((i + 1) / all.length) * 100)).padStart(3)}%]`).join('\n');
const pytestOutput = (chars, summary) => `${progress(chars)}\n\n=== warnings summary ===\nx.py:1: Warning\n\n${summary}\n`;

test('judgeValidity: a reference-like score, every collected test reporting plus module-level skips, is valid', () => {
  // 10 collected: 8 pass, 1 fails, 1 skips in the test; 3 modules skip at import: 4 skipped in all.
  const out = pytestOutput('........Fs', '1 failed, 8 passed, 4 skipped, 2 warnings in 1.20s');
  const tests = { ...L.parseEvaluation(1, out), collected: 10 };
  assert.equal(tests.moduleSkipped, 3, 'a skipped outcome the progress line never printed is a module\'s');
  assert.deepEqual(L.judgeValidity({ aborted: null, checks: [], tests, freshness: { stale: false } }), { valid: true, invalidReasons: [] });
});

test('judgeValidity: more per-test outcomes than collected ids is still invalid, whatever module-level skips there are', () => {
  const out = pytestOutput('.........Fs', '1 failed, 9 passed, 4 skipped in 1.20s');
  const tests = { ...L.parseEvaluation(1, out), collected: 10 };
  assert.equal(tests.moduleSkipped, 3);
  const v = L.judgeValidity({ aborted: null, checks: [], tests, freshness: { stale: false } });
  assert.equal(v.valid, false);
  assert.deepEqual(v.invalidReasons, ['more outcomes than the reference collected: 11 > 10 (3 module-level skips not counted)']);
});

test('judgeValidity: fewer outcomes than collected is valid, with or without module-level skips', () => {
  const some = { ...L.parseEvaluation(1, pytestOutput('.....F', '1 failed, 5 passed, 2 skipped in 0.5s')), collected: 10 };
  assert.equal(some.moduleSkipped, 2);
  assert.equal(L.judgeValidity({ aborted: null, checks: [], tests: some, freshness: { stale: false } }).valid, true);
  const none = { ...L.parseEvaluation(1, pytestOutput('.....F', '1 failed, 5 passed in 0.5s')), collected: 10 };
  assert.equal(none.moduleSkipped, 0);
  assert.equal(L.judgeValidity({ aborted: null, checks: [], tests: none, freshness: { stale: false } }).valid, true);
});

test('judgeValidity: skipped outcomes it cannot place stay counted, so a tree it cannot read is never loosened', () => {
  // No progress lines: nothing says which skips belong to a module.
  const bare = { ...L.parseEvaluation(1, '1 failed, 9 passed, 3 skipped in 1.2s'), collected: 10 };
  assert.equal(bare.moduleSkipped, null);
  assert.deepEqual(L.judgeValidity({ aborted: null, checks: [], tests: bare, freshness: { stale: false } }).invalidReasons, ['more outcomes than the reference collected: 13 > 10']);
  // Progress characters that disagree with the summary (3 dots, 5 passed) are not read.
  const odd = L.parseEvaluation(0, pytestOutput('...', '5 passed in 0.1s'));
  assert.equal(odd.moduleSkipped, null);
  // The records of runs made before the count was taken carry none.
  assert.equal(L.judgeValidity({ aborted: null, checks: [], tests: { passed: 8, failed: 1, skipped: 4, collected: 10 }, freshness: { stale: false } }).valid, false);
});

test('parseEvaluation: module-level skips are the summary\'s skipped outcomes the progress lines did not print', () => {
  const out = pytestOutput('.x.Xs.Fs.', '1 failed, 4 passed, 3 skipped, 1 xfailed, 1 xpassed in 0.3s');
  const t = L.parseEvaluation(1, out);
  assert.deepEqual([t.passed, t.failed, t.skipped, t.xfailed, t.xpassed, t.moduleSkipped], [4, 1, 3, 1, 1, 1]);
});

test('judgeScore: the dry run\'s reference score is judged by the function a real run is', () => {
  const ok = { ...L.parseEvaluation(0, pytestOutput('.....s', '5 passed, 4 skipped in 0.1s')), collected: 6 };
  assert.deepEqual(L.judgeScore(ok), []);
  const tooMany = { passed: 7, failed: 0, skipped: 0, xfailed: 0, xpassed: 0, collected: 6, moduleSkipped: 0 };
  assert.deepEqual(L.judgeScore(tooMany), ['more outcomes than the reference collected: 7 > 6']);
  // A dry run reports the score's reasons beside its own.
  assert.deepEqual(L.judgeValidity({ checks: [], tests: tooMany, freshness: { stale: false }, dryRun: true }).invalidReasons,
    ['dry run: no arm ran', 'more outcomes than the reference collected: 7 > 6']);
});

test('rejudge: a recorded run is judged again by today\'s rules and written beside its result, which stays as it was', async () => {
  const { rejudgeRun } = await import('./rejudge.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit0-'));
  // As the run recorded it: judged invalid by the rule before module-level skips were told apart.
  const result = { library: 'synthetic', arm: 'B', dryRun: false, planOnly: false, valid: false,
    invalidReasons: ['more outcomes than the reference collected: 13 > 10'],
    tests: { passed: 8, collected: 10, failed: 1, errors: 0, skipped: 4, exit: 1, timedOut: false },
    checks: [{ ok: true, scope: 'synthetic', name: 'egress' }], distFreshness: { stale: false }, stopped: null, aborted: null, scoredSource: { ok: true, failures: [] } };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result));
  fs.writeFileSync(path.join(dir, 'tests.log'), pytestOutput('........Fs', '1 failed, 8 passed, 4 skipped in 1.20s'));
  const before = fs.readFileSync(path.join(dir, 'result.json'), 'utf8');
  const r = rejudgeRun(dir);
  assert.deepEqual([r.valid, r.invalidReasons, r.was.valid, r.moduleSkipped], [true, [], false, 3]);
  assert.equal(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'), before, 'the recorded result is never rewritten');
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'rejudged.json'), 'utf8'));
  assert.deepEqual([written.valid, written.invalidReasons], [true, []]);
  // A real excess is still invalid, with the reason.
  fs.writeFileSync(path.join(dir, 'tests.log'), pytestOutput('.........Fs', '1 failed, 9 passed, 4 skipped in 1.20s'));
  assert.deepEqual(rejudgeRun(dir).invalidReasons, ['more outcomes than the reference collected: 11 > 10 (3 module-level skips not counted)']);
  // Without the log nothing places a skip: the recorded counts are judged as they stand.
  fs.rmSync(path.join(dir, 'tests.log'));
  const bare = rejudgeRun(dir);
  assert.deepEqual([bare.valid, bare.moduleSkipped, bare.scoreSource], [false, null, 'result.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a session the CLI says cannot be continued ends the continuing: no fresh attempt is asked of core, which would score a new worktree', () => {
  const said = { code: 1, stdout: '', stderr: 'Failed to continue task: Task "Third" cannot be continued: its runner left no saved session to resume. Use Retry instead.' };
  const gone = L.continueRefusal(said);
  assert.equal(gone.cannotContinue, true);
  assert.match(gone.detail, /cannot be continued/);
  const other = L.continueRefusal({ code: 2, stdout: '', stderr: 'connect ECONNREFUSED 127.0.0.1:3000' });
  assert.equal(other.cannotContinue, false, 'any other failure is a refusal, read again at the next poll');
  assert.match(other.detail, /ECONNREFUSED/);
  assert.equal(L.continueRefusal({ code: 3, stdout: '', stderr: '' }).detail, 'exit 3');

  // Core runs a fresh attempt in a new worktree cut from the integration tip; the arm is scored on the kept worktree.
  const drive = fs.readFileSync(path.join(here, 'drive.mjs'), 'utf8');
  assert.doesNotMatch(drive, /from: 'fresh'/, 'the control arm never asks for a fresh attempt');
  assert.match(drive, /why: 'cannot-continue'/);
});
