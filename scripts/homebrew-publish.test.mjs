// The manual re-publish to the Homebrew tap (homebrew-publish.yml), the brew
// install both it and release.yml prove the tap with, and the install check
// they run, scripts/verify-brew-install.sh (ADR-0063 H11, ADR-0065 C8).
// publish-tap.test.mjs holds the publish script itself, desktop-release.test.mjs
// release.yml's homebrew job.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import yaml from 'js-yaml';

const WORKFLOWS = '.github/workflows';
const read = (name) => yaml.load(readFileSync(join(WORKFLOWS, name), 'utf8'));
const publishText = readFileSync(join(WORKFLOWS, 'homebrew-publish.yml'), 'utf8');
const release = read('release.yml');
const manual = read('homebrew-publish.yml');
const RUNNERS = ['macos-latest', 'macos-15-intel', 'ubuntu-latest', 'ubuntu-24.04-arm'];
const posixOnly = process.platform === 'win32' ? 'bash that runs only on GitHub\'s macOS and Linux runners' : false;

/** Each step's `uses`, for the actions a job runs. */
const actions = (job) => job.steps.flatMap(({ uses }) => (uses ? [uses] : []));
/** The step of a job by its name. */
const step = (job, name) => {
  const found = job.steps.find((entry) => entry.name === name);
  assert.ok(found, `no step "${name}"`);
  return found;
};
/** The `${{ secrets.X }}` names a value reads. */
const secretsIn = (value) => [...new Set([...JSON.stringify(value).matchAll(/secrets\.(\w+)/g)].map(([, name]) => name))].sort();

describe('every workflow', () => {
  it('parses as YAML, with jobs GitHub can read', () => {
    const names = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
    assert.ok(names.includes('release.yml') && names.includes('homebrew-publish.yml'));
    for (const name of names) {
      const workflow = read(name);
      assert.equal(typeof workflow, 'object', name);
      assert.ok(workflow.on ?? workflow.true, `${name} has no trigger`);
      assert.ok(Object.keys(workflow.jobs ?? {}).length > 0, `${name} has no jobs`);
      for (const [id, job] of Object.entries(workflow.jobs)) assert.ok(job['runs-on'] || job.uses, `${name}: ${id} runs nowhere`);
    }
  });
});

describe('homebrew-publish.yml', () => {
  const publish = manual.jobs.publish;
  const homebrew = release.jobs.homebrew;

  it('runs only when dispatched, with a required tag', () => {
    // js-yaml reads a bare `on` as the key `true`, as YAML 1.1 does; GitHub as `on`.
    const on = manual.on ?? manual.true;
    assert.deepEqual(Object.keys(on), ['workflow_dispatch']);
    assert.deepEqual(on.workflow_dispatch.inputs, { tag: { description: 'The release to publish, as vX.Y.Z', required: true, type: 'string' } });
    assert.match(publishText, /^# {3}gh workflow run homebrew-publish\.yml --ref main -f tag=v0\.13\.0$/m);
  });

  it('grants nothing at the top and a read of the contents to each job, the tap credential being its own', () => {
    assert.deepEqual(manual.permissions, {});
    for (const job of Object.values(manual.jobs)) assert.deepEqual(job.permissions, { contents: 'read' });
  });

  it('checks the tag first, and reads it only from the environment', () => {
    assert.equal(publish.steps[0].name, 'Check the tag');
    assert.deepEqual(publish.steps[0].env, { TAG: '${{ inputs.tag }}' });
    for (const job of Object.values(manual.jobs)) {
      for (const { run } of job.steps) assert.ok(!run?.includes('${{'), `a script expands an expression: ${run}`);
    }
  });

  it('accepts a release tag and nothing else', { skip: posixOnly }, () => {
    const { run } = publish.steps[0];
    const check = (tag) => spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', run], { encoding: 'utf8', env: { PATH: process.env.PATH, TAG: tag } });
    for (const tag of ['v0.13.0', 'v10.0.123']) assert.equal(check(tag).status, 0, tag);
    for (const tag of ['0.13.0', 'v0.13', 'v0.13.0-rc.1', 'v0.13.0 ', 'v0.13.0\nv0.12.0', 'v1.2.3$(id)', 'main', '']) {
      const out = check(tag);
      assert.equal(out.status, 1, JSON.stringify(tag));
      assert.match(out.stdout, /^::error::".*" is not a release tag of the form vX\.Y\.Z$/ms);
    }
  });

  it('fails, rather than publishing nothing quietly, without either credential', () => {
    const credential = step(publish, 'Check for a credential');
    assert.equal(credential.if, "env.HOMEBREW_TAP_TOKEN_SET != 'true' && env.HOMEBREW_TAP_DEPLOY_KEY_SET != 'true'");
    assert.match(credential.run, /::error::neither HOMEBREW_TAP_TOKEN nor HOMEBREW_TAP_DEPLOY_KEY is set/);
    assert.match(credential.run, /exit 1\n$/);
    assert.ok(publish.steps.indexOf(credential) < publish.steps.findIndex(({ uses }) => uses?.startsWith('actions/checkout')));
  });

  it('pins the same actions to the same commits as release.yml\'s homebrew job', () => {
    const pins = Object.fromEntries(actions(homebrew).map((uses) => uses.split('@')));
    for (const job of Object.values(manual.jobs)) {
      for (const uses of actions(job)) {
        const [action, ref] = uses.split('@');
        assert.match(ref, /^[0-9a-f]{40}$/, uses);
        assert.equal(ref, pins[action], `${action} is pinned apart from release.yml`);
      }
    }
    for (const job of Object.values(manual.jobs)) {
      for (const { uses, with: options } of job.steps) if (uses?.startsWith('actions/checkout')) assert.equal(options['persist-credentials'], false);
    }
  });

  it('writes the tap one run at a time with release.yml', () => {
    assert.deepEqual(publish.concurrency, { group: 'homebrew-tap', 'cancel-in-progress': false });
    assert.deepEqual(homebrew.concurrency, publish.concurrency);
  });

  it('renders the formula alone from the Release\'s SHA256SUMS and publishes it with scripts/publish-tap.sh', () => {
    const names = publish.steps.map(({ name, uses }) => name ?? uses.split('@')[0]);
    assert.deepEqual(names, ['Check the tag', 'Check for a credential', 'actions/checkout', 'Use Node.js 22.x', 'Download SHA256SUMS from the Release', 'Render the formula', 'Publish to ordewell/homebrew-tap']);
    assert.equal(step(publish, 'Download SHA256SUMS from the Release').run, 'gh release download "$TAG" --pattern SHA256SUMS --dir sums --repo "$REPO"');
    assert.equal(step(publish, 'Render the formula').run, 'node scripts/render-package-manifests.mjs --version "${TAG#v}" --sums sums/SHA256SUMS --only formula --out rendered');
    const write = step(publish, 'Publish to ordewell/homebrew-tap');
    assert.equal(write.run, 'scripts/publish-tap.sh rendered "${TAG#v}"');
    assert.doesNotMatch(publishText, /--cask/, 'a re-publish has no notarized build to publish a cask from');
  });

  it('hands the tap credential to the publish step alone, as release.yml does', () => {
    const write = step(publish, 'Publish to ordewell/homebrew-tap');
    const released = step(homebrew, 'Publish to ordewell/homebrew-tap');
    assert.deepEqual({ ...write.env, TAG: undefined }, { ...released.env, TAG: undefined });
    assert.equal(write.env.TAG, '${{ inputs.tag }}');
    assert.deepEqual(publish.env, { HOMEBREW_TAP_TOKEN_SET: homebrew.env.HOMEBREW_TAP_TOKEN_SET, HOMEBREW_TAP_DEPLOY_KEY_SET: homebrew.env.HOMEBREW_TAP_DEPLOY_KEY_SET });
    for (const entry of publish.steps) {
      const expected = entry === write ? ['HOMEBREW_TAP_DEPLOY_KEY', 'HOMEBREW_TAP_TOKEN'] : entry.name === 'Download SHA256SUMS from the Release' ? ['GITHUB_TOKEN'] : [];
      assert.deepEqual(secretsIn(entry), expected, entry.name ?? entry.uses);
    }
  });
});

describe('the brew install check of release.yml and homebrew-publish.yml', () => {
  const verifies = [['release.yml', release.jobs['homebrew-verify'], 'homebrew'], ['homebrew-publish.yml', manual.jobs.verify, 'publish']];

  it('runs on a runner of each archive the formula names, letting one fail without cancelling the others', () => {
    for (const [name, job] of verifies) {
      assert.deepEqual(job.strategy, { 'fail-fast': false, matrix: { runner: RUNNERS } }, name);
      assert.equal(job['runs-on'], '${{ matrix.runner }}', name);
      assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 60, name);
    }
  });

  it('holds no credential: it reads the tap as anyone does', () => {
    for (const [name, job] of verifies) {
      assert.deepEqual(job.permissions, { contents: 'read' }, name);
      assert.deepEqual(secretsIn(job), [], name);
      assert.ok(!job.environment, name);
    }
  });

  it('is the same steps in both, installing with scripts/verify-brew-install.sh the version of the tag', () => {
    const [[, released], [, manually]] = verifies;
    assert.deepEqual(released.steps, manually.steps);
    assert.deepEqual(released.steps.map(({ name, uses }) => name ?? uses.split('@')[0]), ['actions/checkout', 'Install ordewell with brew and test it']);
    assert.deepEqual(released.steps[0].with, { 'persist-credentials': false });
    assert.equal(released.steps[1].run, 'scripts/verify-brew-install.sh "${TAG#v}"');
    assert.deepEqual(released.env, { TAG: '${{ github.ref_name }}' });
    assert.deepEqual(manually.env, { TAG: '${{ inputs.tag }}' });
  });

  it('waits for the publish, and in a release runs only when the homebrew job put the formula in the tap', () => {
    for (const [name, job, publisher] of verifies) assert.equal(job.needs, publisher, name);
    assert.equal(release.jobs['homebrew-verify'].if, "${{ !cancelled() && needs.homebrew.result == 'success' && needs.homebrew.outputs.published == 'true' }}");
    assert.deepEqual(release.jobs.homebrew.outputs, { published: '${{ steps.publish.outputs.published }}' });
    // A re-publish without a credential fails its publish job, so verify waits on that alone.
    assert.equal(manual.jobs.verify.if, undefined);
    assert.ok(!Object.values(release.jobs).some((job) => [job.needs].flat().includes('homebrew-verify')), 'a failed brew install holds up another publish');
  });
});

describe('scripts/verify-brew-install.sh', { skip: posixOnly }, () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-brew-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  let count = 0;

  /**
   * A fake brew on PATH whose prefix's bin is on PATH too, as `brew shellenv`
   * leaves it: `install` links an ordewell that prints `installed`.
   */
  const run = (version, { installed = version, testFails = false, installFails = false, audit = '', shadow = false, githubPath = false } = {}) => {
    const dir = join(root, String(count++));
    const fake = join(dir, 'fake');
    const prefix = join(dir, 'prefix');
    const other = join(dir, 'other');
    for (const at of [fake, join(prefix, 'bin'), other]) mkdirSync(at, { recursive: true });
    const log = join(dir, 'log');
    writeFileSync(join(fake, 'brew'), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  --version) echo 'Homebrew 4.6.0' ;;
  --prefix) echo '${prefix}' ;;
  update) ;;
  install) ${installFails ? 'exit 1' : `printf '#!/bin/sh\\necho ${installed}\\n' > '${prefix}/bin/ordewell'; chmod +x '${prefix}/bin/ordewell'`} ;;
  test) ${testFails ? "echo 'Error: ordewell: failed' >&2; exit 1" : ':'} ;;
  audit) ${audit ? `cat '${join(dir, 'audit')}'; exit 1` : ':'} ;;
  *) exit 3 ;;
esac
`);
    chmodSync(join(fake, 'brew'), 0o755);
    if (audit) writeFileSync(join(dir, 'audit'), `${audit}\n`);
    if (shadow) {
      writeFileSync(join(other, 'ordewell'), `#!/bin/sh\necho ${version}\n`);
      chmodSync(join(other, 'ordewell'), 0o755);
    }
    const github = join(dir, 'github-path');
    const path = [...(shadow ? [other] : []), join(prefix, 'bin'), fake, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter);
    const out = spawnSync('bash', ['scripts/verify-brew-install.sh', ...[version].flat()], {
      encoding: 'utf8',
      env: { PATH: path, HOME: dir, ...(githubPath ? { GITHUB_PATH: github } : {}) },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    return { ...out, calls, github: existsSync(github) ? readFileSync(github, 'utf8') : null, fake };
  };

  it('installs from the tap, checks the version and runs the formula\'s test, in that order', () => {
    const out = run('1.2.3', { githubPath: true });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(out.calls, ['--version', 'update', 'install ordewell/tap/ordewell', '--prefix', 'test ordewell', 'audit --formula ordewell/tap/ordewell']);
    assert.match(out.stdout, /^brew installed ordewell 1\.2\.3$/m);
    assert.match(out.stdout, /^brew audit reported nothing$/m);
    assert.equal(out.github, `${out.fake}\n`, 'a later step would not find this brew');
  });

  it('prints what audit reports and fails nothing on it', () => {
    const audit = 'ordewell/tap/ordewell\n  * Stable: `version 1.2.3` is redundant with version scanned from URL\n  * line 38, col 3: `livecheck` (line 38) should be put before `on_macos` (line 16)\nError: 2 problems in 1 formula detected.';
    const out = run('1.2.3', { audit });
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes(audit));
    assert.match(out.stdout, /^::warning::brew audit --formula ordewell\/tap\/ordewell reported the lines above/m);
  });

  it('fails when brew installs another version than the one published', () => {
    const out = run('1.2.3', { installed: '1.2.2' });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /brew installed ordewell 1\.2\.2, not the published 1\.2\.3/);
    assert.ok(!out.calls.includes('test ordewell'));
  });

  it('fails when the ordewell on PATH is not the one brew linked', () => {
    const out = run('1.2.3', { shadow: true });
    assert.equal(out.status, 1);
    assert.match(out.stderr, /ordewell on PATH is ".*\/other\/ordewell", not Homebrew's/);
  });

  it('fails when the install or the formula\'s test fails', () => {
    const failed = run('1.2.3', { installFails: true });
    assert.notEqual(failed.status, 0);
    assert.deepEqual(failed.calls, ['--version', 'update', 'install ordewell/tap/ordewell']);
    const tested = run('1.2.3', { testFails: true });
    assert.notEqual(tested.status, 0);
    assert.ok(!tested.calls.some((call) => call.startsWith('audit')));
  });

  it('refuses anything but one x.y.z version, before brew runs', () => {
    for (const version of [[], ['v1.2.3'], ['1.2'], ['1.2.3', '1.2.4'], ['1.2.3; id']]) {
      const out = run(version);
      assert.equal(out.status, 2, JSON.stringify(version));
      assert.deepEqual(out.calls, []);
    }
  });
});
