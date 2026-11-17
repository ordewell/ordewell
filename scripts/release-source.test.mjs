import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { load } from 'js-yaml';
import { DELIVERY_FILES, verifyReleaseSource } from './release-source.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repository() {
  const cwd = mkdtempSync(join(tmpdir(), 'ordewell-release-source-'));
  roots.push(cwd);
  const config = join(cwd, '.gitconfig-test');
  writeFileSync(config, '');
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(cwd, 'no-hooks')}`, ...args,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config,
  } }).trim();
  const write = (file, body) => { mkdirSync(dirname(join(cwd, file)), { recursive: true }); writeFileSync(join(cwd, file), body); };
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); };
  git('init', '-q', '-b', 'main', '--template=');
  write('package.json', '{"version":"0.14.0"}\n');
  write('packages/desktop/src/main.ts', 'released application\n');
  for (const file of DELIVERY_FILES) write(file, 'original delivery\n');
  commit();
  git('tag', 'v0.14.0');
  return { cwd, git, write, commit };
}

test('a tag push proves the checkout is exactly that tag', () => {
  const { cwd, git, write, commit } = repository();
  assert.equal(verifyReleaseSource('v0.14.0', { cwd }).sourceCommit, git('rev-parse', 'HEAD'));
  write('.github/workflows/desktop-build.yml', 'new delivery\n'); commit();
  assert.throws(() => verifyReleaseSource('v0.14.0', { cwd }), /tagged commit/);
});

test('recovery permits delivery repairs while preserving the original tag and application', () => {
  const { cwd, git, write, commit } = repository();
  const released = git('rev-parse', 'v0.14.0');
  for (const file of DELIVERY_FILES) write(file, 'repaired delivery\n');
  commit();
  const result = verifyReleaseSource('v0.14.0', { cwd, recovery: true, ref: 'refs/heads/main' });
  assert.equal(result.sourceCommit, released);
  assert.equal(git('rev-parse', 'v0.14.0'), released);
  assert.notEqual(result.workflowCommit, released);
  assert.equal(result.deliveryChanges.length, DELIVERY_FILES.size);
});

for (const file of ['packages/desktop/src/main.ts', 'package.json', 'scripts/desktop-package-check.mjs', 'README.md']) {
  test(`recovery refuses a change to ${file}`, () => {
    const { cwd, write, commit } = repository();
    write(file, 'changed released source\n'); commit();
    assert.throws(() => verifyReleaseSource('v0.14.0', { cwd, recovery: true, ref: 'refs/heads/main' }), /change released sources/);
  });
}

test('renaming a delivery file into application sources is refused', () => {
  const { cwd, git, commit } = repository();
  git('mv', '.github/workflows/release.yml', 'packages/desktop/src/release.ts'); commit();
  assert.throws(() => verifyReleaseSource('v0.14.0', { cwd, recovery: true, ref: 'refs/heads/main' }), /packages\/desktop\/src\/release.ts/);
});

test('recovery refuses another branch, missing tags and arbitrary refs', () => {
  const { cwd } = repository();
  assert.throws(() => verifyReleaseSource('v0.14.0', { cwd, recovery: true, ref: 'refs/heads/other' }), /main only/);
  assert.throws(() => verifyReleaseSource('v9.0.0', { cwd, recovery: true, ref: 'refs/heads/main' }), /does not exist/);
  for (const tag of ['main', 'HEAD', '--help', 'v0.14.0;echo test', 'v0.14.0/other']) {
    assert.throws(() => verifyReleaseSource(tag, { cwd }), /existing version tag/);
  }
});

test('recovery gates publishing and every build checks out the requested tag', () => {
  const workflow = (name) => load(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
  const release = workflow('release');
  assert.ok(release.on.workflow_dispatch.inputs.tag.required);
  assert.equal(release.jobs.ci.needs, 'release-source');
  assert.equal(release.jobs['release-source'].steps.find((s) => s.uses?.startsWith('actions/checkout@')).with['fetch-depth'], 0);
  for (const [name, job] of Object.entries(release.jobs)) {
    if (name === 'release-source') continue;
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with.ref, '${{ inputs.tag || github.ref }}', name);
    }
  }
  for (const name of ['cli-build', 'desktop-build']) {
    for (const job of Object.values(workflow(name).jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with.ref, '${{ inputs.tag || github.ref }}', name);
      }
    }
  }
  const desktop = workflow('desktop-build').jobs.build;
  assert.equal(desktop.env.NODE_OPTIONS, '--max-old-space-size=4096');
  const verify = desktop.steps.find((s) => s.name === 'Verify the installers and the unpacked app');
  assert.equal(verify.shell, 'bash');
  assert.match(verify.run, /env -u PSModulePath powershell/);
  assert.match(verify.run, /Import-Module Microsoft.PowerShell.Security/);
  assert.match(verify.run, /env -u PSModulePath node scripts\/desktop-package-check.mjs/);
});
