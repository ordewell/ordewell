import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { load } from 'js-yaml';
import { verifyReleaseSource } from './release-source.mjs';

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
  write('.github/workflows/release.yml', 'original delivery\n');
  commit(); git('tag', 'v0.14.0');
  const released = git('rev-parse', 'HEAD');
  const run = { headSha: released, headBranch: 'main', event: 'push', conclusion: 'success', databaseId: 42,
    url: 'https://github.com/ordewell/ordewell/actions/runs/42' };
  const options = { cwd, recovery: true, ref: 'refs/heads/main',
    findRuns: () => JSON.stringify([run]), readPublishedCommit: async () => released };
  return { cwd, git, write, commit, released, run, options };
}

test('a tag push proves the checkout is exactly that tag without requiring a prior publication', async () => {
  const { cwd, git, write, commit } = repository();
  const result = await verifyReleaseSource('v0.14.0', { cwd, readPublishedCommit: () => { throw new Error('not published yet'); } });
  assert.equal(result.sourceCommit, git('rev-parse', 'HEAD'));
  write('.github/workflows/release.yml', 'new delivery\n'); commit();
  await assert.rejects(verifyReleaseSource('v0.14.0', { cwd }), /tagged commit/);
});

test('recovery retains the original CI-proven published tag when application work lands on main', async () => {
  const { git, write, commit, released, options, run } = repository();
  write('packages/desktop/src/main.ts', 'new work for a later release\n');
  write('README.md', 'new main documentation\n'); commit();
  const lookedUp = [];
  const result = await verifyReleaseSource('v0.14.0', { ...options,
    findRuns: (sha) => { lookedUp.push(sha); return JSON.stringify([run]); },
    readPublishedCommit: async (version) => { assert.equal(version, '0.14.0'); return released; },
  });
  assert.deepEqual(lookedUp, [released]);
  assert.equal(result.sourceCommit, released);
  assert.equal(git('rev-parse', 'v0.14.0'), released);
  assert.notEqual(result.workflowCommit, released);
  assert.equal(result.proof, run.url);
  assert.equal(result.publishedSource, released);
});

for (const [field, value] of [['headSha', 'f'.repeat(40)], ['headBranch', 'other'], ['event', 'pull_request'], ['conclusion', 'failure']]) {
  test(`recovery rejects a CI proof with the wrong ${field}`, async () => {
    const { options, run } = repository();
    await assert.rejects(verifyReleaseSource('v0.14.0', { ...options,
      findRuns: () => JSON.stringify([{ ...run, [field]: value }]),
      readPublishedCommit: () => { throw new Error('must not reach publication lookup'); },
    }), /no verified main CI proof/);
  });
}

test('recovery fails closed when CI proof cannot be found or read', async () => {
  const { options } = repository();
  await assert.rejects(verifyReleaseSource('v0.14.0', { ...options, findRuns: () => '[]' }), /no verified main CI proof/);
  await assert.rejects(verifyReleaseSource('v0.14.0', { ...options, findRuns: () => { throw new Error('offline'); } }), /offline/);
});

test('moving a tag to a different, even CI-proven, commit cannot replace the published source', async () => {
  const { options, git, write, commit, run } = repository();
  write('packages/desktop/src/main.ts', 'changed application\n'); commit(); git('tag', '-f', 'v0.14.0');
  const moved = git('rev-parse', 'HEAD');
  await assert.rejects(verifyReleaseSource('v0.14.0', { ...options,
    findRuns: () => JSON.stringify([{ ...run, headSha: moved }]),
  }), /already-published npm source commit/);
});

test('recovery fails closed when published source metadata is unavailable', async () => {
  const { options } = repository();
  await assert.rejects(verifyReleaseSource('v0.14.0', { ...options,
    readPublishedCommit: async () => { throw new Error('registry unavailable'); },
  }), /registry unavailable/);
  await assert.rejects(verifyReleaseSource('v0.14.0', { ...options, readPublishedCommit: async () => undefined }), /npm source commit/);
});

test('recovery refuses another branch, missing tags, wrong versions and arbitrary refs', async () => {
  const { cwd, options, git } = repository();
  await assert.rejects(verifyReleaseSource('v0.14.0', { ...options, ref: 'refs/heads/other' }), /main only/);
  await assert.rejects(verifyReleaseSource('v9.0.0', options), /does not exist/);
  git('tag', 'v0.15.0');
  await assert.rejects(verifyReleaseSource('v0.15.0', options), /version in its own sources/);
  for (const tag of ['main', 'HEAD', '--help', 'v0.14.0;echo test', 'v0.14.0/other']) {
    await assert.rejects(verifyReleaseSource(tag, { cwd }), /existing version tag/);
  }
});

test('recovery gates publishing and every build checks out the requested tag', () => {
  const workflow = (name) => load(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
  const release = workflow('release');
  assert.ok(release.on.workflow_dispatch.inputs.tag.required);
  assert.equal(release.jobs.ci.needs, 'release-source');
  assert.deepEqual(release.jobs['release-source'].permissions, { contents: 'read', actions: 'read' });
  assert.equal(release.jobs['release-source'].steps.at(-1).env.GH_TOKEN, '${{ github.token }}');
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
