import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import yaml from 'js-yaml';
import { windowsRuns, selectScope, readWorkspaces } from './change-scope.mjs';
import { durationsPath, fileKey, packFiles, parseShard, suiteArgs, suiteFiles } from './windows-shards.mjs';
import { collectDurations, parseDurations } from './refresh-windows-durations.mjs';
import WindowsSequencer from './windows-sequencer.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = yaml.load(readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8'));
const count = workflow.jobs.windows.strategy.matrix.shard.length;
const scratch = mkdtempSync(path.join(tmpdir(), 'windows-shards-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function partition(files, durations) {
  const shards = packFiles(files, count, durations);
  assert.equal(shards.length, count);
  assert.deepEqual(shards.flatMap((shard) => shard.files).sort(), [...files].sort());
  assert.equal(new Set(shards.flatMap((shard) => shard.files)).size, files.length);
  assert.deepEqual(shards, packFiles([...files].reverse(), count, durations), 'discovery order cannot change ownership');
  return shards;
}

describe('Windows duration packing against the real repository', () => {
  for (const tier of ['full', 'quick']) it(`partitions every ${tier} suite's actual Vitest file list, without stale entries`, async () => {
    const runs = windowsRuns(null).map((run) => ({ ...run, script: tier === 'full' ? 'test' : 'test:quick' }));
    const suites = await suiteFiles(runs, root);
    const files = suites.flatMap((suite) => suite.files);
    assert.ok(files.length > 800);
    // git is independent of Vitest discovery: a config accidentally omitting a
    // file must fail this proof too, not merely partition the incomplete list.
    const tracked = execFileSync('git', ['ls-files', '--', ...runs.map(({ dir }) => dir)], { cwd: root, encoding: 'utf8' }).trim().split('\n');
    const expected = tracked.filter((file) => /(?:src|server)\/.*\.test\.tsx?$/.test(file))
      .filter((file) => tier !== 'quick' || !((file.startsWith('packages/core/') || file.startsWith('packages/cli/')) && file.endsWith('.e2e.test.ts')))
      .filter((file) => tier !== 'quick' || file !== 'packages/core/src/services/__tests__/GitWorktreeIsolation.test.ts');
    assert.deepEqual([...files].sort(), expected.sort());
    const durations = JSON.parse(readFileSync(durationsPath, 'utf8')).files;
    const shards = partition(files, { ...durations, 'packages/core/src/deleted.test.ts': 999999 });
    for (const suite of suites) {
      assert.deepEqual(shards.flatMap((shard) => shard.files.filter((file) => suite.files.includes(file))).sort(), [...suite.files].sort());
    }
    if (tier === 'quick') assert.ok(!files.some((file) => file.startsWith('packages/core/') && file.endsWith('.e2e.test.ts')));
    const newFile = fileKey(root, path.join(root, 'packages', 'core', 'src', 'new.test.ts'));
    partition([...files, newFile], durations);
  });

  it('partitions a mixed full/quick PR scope, and owes the assignment tooling to Windows', async () => {
    const scope = selectScope(['packages/web/server/app.ts'], readWorkspaces(root));
    const suites = await suiteFiles(windowsRuns(scope), root);
    assert.ok(suites.some(({ script }) => script === 'test:quick'));
    partition(suites.flatMap(({ files }) => files));
    for (const file of ['scripts/windows-shards.mjs', 'scripts/windows-sequencer.mjs', 'scripts/windows-durations.json']) {
      assert.equal(selectScope([file], readWorkspaces(root)).checks.windows, true, file);
    }
  });

  it('packs longest first, breaks ties by path then shard index, and validates SHARD', () => {
    assert.deepEqual(packFiles(['c', 'b', 'a'], 2, { a: 10, b: 10, c: 2 }).map(({ files }) => files), [['a', 'c'], ['b']]);
    assert.deepEqual(parseShard('2/12'), { index: 2, count: 12 });
    for (const value of [undefined, '0/12', '13/12', '1/0', '1/2garbage']) assert.throws(() => parseShard(value));
    assert.throws(() => suiteArgs('vitest run && echo no'));
    assert.deepEqual(suiteArgs("vitest run --exclude '**/*.e2e.test.ts'"), ['vitest', 'run', '--exclude', '**/*.e2e.test.ts']);
  });
});

describe('Windows execution and refresh', () => {
  it('filters by exact identity and runs the longest assigned file first', () => {
    const assignment = path.join(scratch, 'sequencer.json');
    const files = ['long.test.ts', 'a.test.ts'].map((file) => path.join(scratch, file));
    writeFileSync(assignment, JSON.stringify(files));
    const old = process.env.ORDEWELL_WINDOWS_FILES;
    process.env.ORDEWELL_WINDOWS_FILES = assignment;
    try {
      const sequencer = new WindowsSequencer({});
      const specs = ['a.test.ts', 'a.test.tsx', 'long.test.ts'].map((file) => ({ moduleId: path.join(scratch, file) }));
      assert.deepEqual(sequencer.sort(sequencer.shard(specs)).map(({ moduleId }) => moduleId), files);
      assert.throws(() => sequencer.shard(specs.slice(0, 1)), /differs/);
    } finally {
      if (old === undefined) delete process.env.ORDEWELL_WINDOWS_FILES;
      else process.env.ORDEWELL_WINDOWS_FILES = old;
    }
  });

  it('keeps running owed workspaces after failure, skips empty assignments, and rejects a bad shard', () => {
    const fixture = path.join(scratch, 'execution');
    const log = path.join(fixture, 'ran.log');
    const dirs = ['packages/core', 'packages/web'];
    const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
    write(path.join(fixture, 'package.json'), JSON.stringify({ private: true, workspaces: dirs }));
    for (const [index, dir] of dirs.entries()) {
      write(path.join(fixture, dir, 'src', 'one.test.ts'), '');
      write(path.join(fixture, dir, 'vitest.config.mjs'), 'export default { test: { include: ["src/**/*.test.ts"] } };');
      write(path.join(fixture, dir, 'record.cjs'), `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2),files:JSON.parse(require('fs').readFileSync(process.env.ORDEWELL_WINDOWS_FILES,'utf8'))})+'\\n'); process.exit(${index === 0 ? 1 : 0});`);
      write(path.join(fixture, dir, 'package.json'), JSON.stringify({ name: `w${index}`, scripts: { test: 'vitest run', 'test:quick': 'vitest run', pretest: 'node record.cjs' } }));
    }
    const script = path.join(root, 'scripts', 'ci-scope.mjs');
    const env = { ...process.env, SCOPE: JSON.stringify({ mode: 'selected', checks: {}, windowsSuites: { 'packages/core': 'full', 'packages/web': 'quick' } }), SHARD: '1/1' };
    // Record each assignment before a lifecycle hook or missing binary fails.
    const manifest = path.join(fixture, dirs[1], 'package.json');
    const web = JSON.parse(readFileSync(manifest, 'utf8'));
    web.scripts['pretest:quick'] = 'node record.cjs';
    // Missing vitest in the fixture is allowed to fail after the hook records it.
    writeFileSync(manifest, JSON.stringify(web));
    const result = spawnSync(process.execPath, [script, 'windows-tests'], { cwd: fixture, env, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    const records = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 2, result.stdout + result.stderr);
    assert.deepEqual(records.map(({ files }) => files.length), [1, 1]);
    const empty = spawnSync(process.execPath, [script, 'windows-tests'], { cwd: fixture, env: { ...env, SHARD: '3/3' }, encoding: 'utf8' });
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
    const invalid = spawnSync(process.execPath, [script, 'windows-tests'], { cwd: fixture, env: { ...env, SHARD: '0/12' }, encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Invalid SHARD/);
  });

  it('reads colored raw/gh logs across workspaces, preserves maxima, and ignores test-case timings', () => {
    const log = '##[group]test in packages/core (shard 1/12)\n ✓ src/same.test.ts (2 tests) 123ms\n > a slow test 999ms\n##[group]test:quick in packages/web (shard 1/12)\n \x1b[32m✓\x1b[39m server/same.test.ts (1 test) 5ms\n';
    assert.deepEqual(parseDurations(log), { 'packages/core/src/same.test.ts': 123, 'packages/web/server/same.test.ts': 5 });
    assert.equal(collectDurations([log, log.replace('123ms', '100ms')])['packages/core/src/same.test.ts'], 123);
    assert.equal(parseDurations(log.replaceAll('##[group]', '::group::'))['packages/core/src/same.test.ts'], 123);
  });

  it('builds only what the Windows suites and integration harness consume', () => {
    const build = (job) => workflow.jobs[job].steps.find((step) => step.id === 'setup').with.build.split(' ');
    assert.deepEqual(build('windows'), ['core', 'ui', 'cli', 'web']);
    assert.deepEqual(build('windows-harness'), ['core', 'ui', 'vscode']);
    const list = execFileSync(process.execPath, [path.join(root, 'scripts', 'ci.mjs'), '--list'], { cwd: root, encoding: 'utf8' });
    assert.match(list, /Test with coverage/);
    assert.doesNotMatch(list, /Build the Windows|Test on Windows/);
  });
});
