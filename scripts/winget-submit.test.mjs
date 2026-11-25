// scripts/winget-submit.mjs against a fake gh and a fake wingetcreate on PATH,
// each holding a winget-pkgs of the test's making. desktop-release.test.mjs
// pins the release.yml step that runs it.
//
// The fakes are this Node started under another name with a preload that
// answers in its place, not shell scripts: the job runs on Windows, where
// Node starts a native gh.exe from PATH but no .cmd shim, so this is how the
// script's own spawn reaches a fake there too.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { hostHas, onPath } from './host-tools.mjs';
import { submissionTitle, supersededBy, supersededComment, syncAdvice } from './winget-submit.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'winget-submit.mjs');
const TOKEN = 'ghp_fakewingettoken0123456789';
const LOGIN = 'ordewell-bot';
const FORK = `${LOGIN}/winget-pkgs`;
const VERSION = '0.14.13';
const MANIFESTS = `rendered/winget/manifests/o/Ordewell/Ordewell/${VERSION}`;
const NEW_PR = 490001;
const exe = process.platform === 'win32' ? '.exe' : '';
const release = readFileSync(resolve(dirname(SCRIPT), '../.github/workflows/release.yml'), 'utf8');

// Runs in every process the script starts: in gh and wingetcreate it answers
// from world.json and logs the call, and in anything else it does nothing.
// Node has already resolved the first argument into a path when this runs.
const FAKE = String.raw`
const { appendFileSync, readFileSync } = require('node:fs');
const { basename } = require('node:path');
const tool = basename(process.argv0).replace(/\.exe$/i, '');
if (tool === 'gh' || tool === 'wingetcreate') {
  const dir = process.env.FAKE_WINGET_DIR;
  const world = JSON.parse(readFileSync(dir + '/world.json', 'utf8'));
  const args = [basename(process.argv[1]), ...process.argv.slice(2)];
  const input = args.includes('--input') ? JSON.parse(readFileSync(0, 'utf8')) : null;
  const entry = { tool, args, input, ghToken: process.env.GH_TOKEN === world.token, wingetToken: process.env.WINGET_CREATE_GITHUB_TOKEN === world.token };
  appendFileSync(dir + '/calls.jsonl', JSON.stringify(entry) + '\n');
  const reply = (status, body) => {
    if (status < 400) {
      if (!args.includes('--silent')) process.stdout.write(JSON.stringify(body));
      process.exit(0);
    }
    process.stdout.write(JSON.stringify(body));
    process.stderr.write('gh: ' + body.message + ' (HTTP ' + status + ')\n');
    process.exit(1);
  };
  const notFound = { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' };
  if (tool === 'wingetcreate') {
    process.stdout.write('Submitting pull request for manifest...\n\n');
    if (world.wingetcreate.code === 0) process.stdout.write('Pull request can be found here: https://github.com/microsoft/winget-pkgs/pull/' + world.wingetcreate.pr + '\n');
    else process.stdout.write('The forked repository could not be synced with the upstream commits. Sync your fork manually and try again.\n');
    process.exit(world.wingetcreate.code);
  }
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : 'GET');
  const path = args.filter((arg) => /^(user|repos\/|search\/)/.test(arg))[0];
  const method = flag('-X');
  let match;
  if (path === 'user') reply(world.user.status, world.user.status === 200 ? { login: world.login } : { message: 'Bad credentials' });
  if (path === 'repos/' + world.login + '/winget-pkgs' && method === 'GET') reply(world.fork ? 200 : 404, world.fork ?? notFound);
  if (path === 'repos/' + world.login + '/winget-pkgs/merge-upstream' && method === 'POST') reply(world.sync.status, world.sync.body);
  if (path === 'repos/microsoft/winget-pkgs/contents/manifests/o/Ordewell/Ordewell') reply(world.packageExists ? 200 : 404, world.packageExists ? [{ name: '0.14.12', type: 'dir' }] : notFound);
  if (path === 'search/issues' && method === 'GET') reply(world.search.status, world.search.status === 200 ? { total_count: world.search.items.length, items: world.search.items } : { message: 'Validation Failed' });
  if ((match = /^repos\/microsoft\/winget-pkgs\/issues\/(\d+)\/comments$/.exec(path)) && method === 'POST') {
    reply(world.failComment.includes(Number(match[1])) ? 403 : 201, world.failComment.includes(Number(match[1])) ? { message: 'Resource not accessible by personal access token' } : { id: 1 });
  }
  if ((match = /^repos\/microsoft\/winget-pkgs\/pulls\/(\d+)$/.exec(path)) && method === 'PATCH') {
    reply(world.failClose.includes(Number(match[1])) ? 422 : 200, world.failClose.includes(Number(match[1])) ? { message: 'Validation Failed' } : { number: Number(match[1]), state: 'closed' });
  }
  process.stderr.write('fake gh: no answer for ' + JSON.stringify(args) + '\n');
  process.exit(99);
}
`;

const pr = (number, title, { login = LOGIN, state = 'open', pullRequest = true } = {}) => ({
  number,
  title,
  state,
  user: { login },
  ...(pullRequest ? { pull_request: { url: `https://api.github.com/repos/microsoft/winget-pkgs/pulls/${number}` } } : {}),
});

/** A winget-pkgs with a synced fork, no package yet and nothing to close, changed by `overrides`. */
const world = (overrides = {}) => ({
  token: TOKEN,
  login: LOGIN,
  user: { status: 200 },
  fork: { full_name: FORK, fork: true, default_branch: 'master', parent: { full_name: 'microsoft/winget-pkgs' } },
  sync: { status: 200, body: { message: 'Successfully fetched and fast-forwarded from upstream microsoft:master', merge_type: 'fast-forward', base_branch: 'microsoft:master' } },
  packageExists: false,
  search: { status: 200, items: [pr(NEW_PR, submissionTitle(VERSION, false))] },
  failComment: [],
  failClose: [],
  wingetcreate: { code: 0, pr: NEW_PR },
  ...overrides,
});

describe('scripts/winget-submit.mjs (ADR-0063 H11)', () => {
  let root;
  let bin;
  let state;
  let checkout;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'winget-submit-'));
    bin = join(root, 'bin');
    state = join(root, 'state');
    mkdirSync(bin);
    writeFileSync(join(root, 'fake.cjs'), FAKE);
    // The step's checkout: the script, what it imports, and the downloaded
    // wingetcreate.exe beside them.
    checkout = join(root, 'checkout');
    mkdirSync(join(checkout, 'scripts'), { recursive: true });
    for (const name of ['winget-submit.mjs', 'release-latest.mjs']) copyFileSync(join(dirname(SCRIPT), name), join(checkout, 'scripts', name));
    for (const target of [join(bin, `gh${exe}`), join(bin, `wingetcreate${exe}`), join(checkout, 'wingetcreate.exe')]) {
      if (process.platform !== 'win32') symlinkSync(process.execPath, target);
      else {
        // A hard link where the temporary directory shares Node's volume.
        try {
          linkSync(process.execPath, target);
        } catch {
          copyFileSync(process.execPath, target);
        }
      }
    }
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /**
   * Runs the script, or with `command` another program in `cwd`, against
   * `fakeWorld`; returns its exit, its output and every call the fakes saw.
   */
  const run = (fakeWorld, { command = [process.execPath, SCRIPT, '--version', VERSION, '--manifests', MANIFESTS, '--wingetcreate', join(bin, `wingetcreate${exe}`)], cwd, env: extra = {} } = {}) => {
    rmSync(state, { recursive: true, force: true });
    mkdirSync(state);
    writeFileSync(join(state, 'world.json'), JSON.stringify(fakeWorld));
    const env = {
      ...process.env,
      PATH: [bin, process.env.PATH ?? ''].join(delimiter),
      NODE_OPTIONS: `--require "${join(root, 'fake.cjs').replace(/\\/g, '/')}"`,
      FAKE_WINGET_DIR: state,
      WINGET_TOKEN: TOKEN,
      ...extra,
    };
    delete env.GH_TOKEN;
    delete env.WINGET_CREATE_GITHUB_TOKEN;
    const result = spawnSync(command[0], command.slice(1), { env, cwd, encoding: 'utf8' });
    const log = join(state, 'calls.jsonl');
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
    const output = `${result.stdout}${result.stderr}`;
    // Whatever happened, the token went to each program in its environment
    // and nowhere else.
    assert.ok(!output.includes(TOKEN), 'the token was printed');
    for (const call of calls) {
      assert.ok(!call.args.some((arg) => arg.includes(TOKEN)), `the token was on ${call.tool}'s command line`);
      assert.ok(!call.args.includes('--token'), `${call.tool} was given --token`);
      assert.equal(call.tool === 'gh' ? call.ghToken : call.wingetToken, true, `${call.tool} did not get the token in its environment`);
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, output, calls };
  };
  const step = (call) => (call.tool === 'wingetcreate' ? 'wingetcreate' : `${call.args.includes('-X') ? call.args[call.args.indexOf('-X') + 1] : 'GET'} ${call.args.find((arg) => /^(user|repos\/|search\/)/.test(arg))}`);

  it('syncs the fork, titles a first submission "New package" and submits it', () => {
    const { status, stdout, calls } = run(world());
    assert.equal(status, 0, stdout);
    assert.deepEqual(calls.map(step), [
      'GET user',
      `GET repos/${FORK}`,
      `POST repos/${FORK}/merge-upstream`,
      'GET repos/microsoft/winget-pkgs/contents/manifests/o/Ordewell/Ordewell',
      'wingetcreate',
      'GET search/issues',
    ]);
    assert.deepEqual(calls[2].input, { branch: 'master' });
    assert.deepEqual(calls[4].args, ['submit', '--no-open', '--prtitle', `New package: Ordewell.Ordewell version ${VERSION}`, MANIFESTS]);
    assert.match(stdout, /ordewell-bot\/winget-pkgs:master: Successfully fetched and fast-forwarded from upstream microsoft:master\./);
  });

  it('syncs the fork\'s own default branch, whatever it is called', () => {
    const { status, calls } = run(world({ fork: { ...world().fork, default_branch: 'main' } }));
    assert.equal(status, 0);
    assert.deepEqual(calls.find((call) => step(call).endsWith('/merge-upstream')).input, { branch: 'main' });
  });

  it('titles the submission "New version" once upstream holds the package', () => {
    const { status, calls } = run(world({ packageExists: true }));
    assert.equal(status, 0);
    assert.equal(calls.find(({ tool }) => tool === 'wingetcreate').args[3], `New version: Ordewell.Ordewell version ${VERSION}`);
  });

  it('stops before wingetcreate when GitHub refuses the sync, printing GitHub\'s reason and what to do', () => {
    const message = 'refusing to allow a Personal Access Token to create or update workflow `.github/workflows/spellCheck.yaml` without `workflow` scope';
    const { status, stdout, stderr, calls } = run(world({ sync: { status: 422, body: { message, documentation_url: 'https://docs.github.com/rest/branches/branches#sync-a-fork-branch-with-the-upstream-repository' } } }));
    assert.equal(status, 1);
    assert.ok(!calls.some(({ tool }) => tool === 'wingetcreate'), 'wingetcreate ran after a failed sync');
    assert.equal(step(calls.at(-1)), `POST repos/${FORK}/merge-upstream`);
    assert.ok(stderr.includes(`GitHub refused to sync ${FORK}:master with microsoft/winget-pkgs:`));
    assert.ok(stderr.includes(`gh: ${message} (HTTP 422)`), stderr);
    const errors = stdout.split('\n').filter((line) => line.startsWith('::error::'));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /the `workflow` scope \(classic token\) or Workflows: Read and write on that fork \(fine-grained token\)/);
  });

  it('stops on a sync refused for another reason too, with advice for that reason', () => {
    const { status, stdout, stderr, calls } = run(world({ sync: { status: 409, body: { message: 'There are merge conflicts' } } }));
    assert.equal(status, 1);
    assert.ok(!calls.some(({ tool }) => tool === 'wingetcreate'));
    assert.ok(stderr.includes('gh: There are merge conflicts (HTTP 409)'));
    assert.match(stdout, /^::error::ordewell-bot\/winget-pkgs has commits upstream does not/m);
  });

  it('leaves a fork that does not exist yet to wingetcreate', () => {
    const { status, stdout, calls } = run(world({ fork: null }));
    assert.equal(status, 0, stdout);
    assert.ok(!calls.some((call) => step(call).endsWith('/merge-upstream')), 'it synced a fork that does not exist');
    assert.ok(calls.some(({ tool }) => tool === 'wingetcreate'));
    assert.match(stdout, /ordewell-bot\/winget-pkgs does not exist yet: wingetcreate forks microsoft\/winget-pkgs there\./);
  });

  it('refuses a winget-pkgs of the account that is not a fork of upstream', () => {
    const { status, stdout, calls } = run(world({ fork: { full_name: FORK, fork: false, default_branch: 'master' } }));
    assert.equal(status, 1);
    assert.ok(!calls.some(({ tool }) => tool === 'wingetcreate'));
    assert.match(stdout, /^::error::ordewell-bot\/winget-pkgs is not a fork of microsoft\/winget-pkgs/m);
  });

  it('says the token was refused when GitHub will not say whose it is', () => {
    const { status, stdout, stderr, calls } = run(world({ user: { status: 401 } }));
    assert.equal(status, 1);
    assert.deepEqual(calls.map(step), ['GET user']);
    assert.ok(stderr.includes('gh: Bad credentials (HTTP 401)'));
    assert.match(stdout, /^::error::WINGET_TOKEN was refused: it has expired or been revoked/m);
  });

  it('fails the job when wingetcreate fails, and closes nothing', () => {
    const { status, stdout, calls } = run(world({ wingetcreate: { code: 1 } }));
    assert.equal(status, 1);
    assert.equal(calls.at(-1).tool, 'wingetcreate');
    assert.match(stdout, /^::error::wingetcreate exited with 1: the submission was not opened\.$/m);
  });

  const older = [
    pr(487720, 'New package: Ordewell.Ordewell version 0.14.11'),
    pr(NEW_PR, submissionTitle(VERSION, false)),
    pr(488839, 'New package: Ordewell.Ordewell version 0.14.12'),
    pr(486000, 'New package: Ordewell.Ordewell version 0.14.9', { login: 'someone-else' }),
    pr(486100, 'Ordewell.Ordewell version 0.14.8'),
    pr(486200, 'New version: Ordewell.Ordewell version 0.14.7 (retry)'),
    pr(486300, 'New package: Other.Package version 0.14.6'),
    pr(486400, 'New package: Ordewell.Ordewell version 0.14.5', { state: 'closed' }),
    pr(486500, 'New package: Ordewell.Ordewell version 0.14.4', { pullRequest: false }),
    pr(495000, 'New version: Ordewell.Ordewell version 0.15.0'),
  ];

  it('closes the account\'s two older submissions as superseded, and leaves the new one and everyone else\'s alone', () => {
    const { status, stdout, calls } = run(world({ search: { status: 200, items: older } }));
    assert.equal(status, 0, stdout);
    const search = calls.find((call) => step(call) === 'GET search/issues');
    assert.ok(search.args.includes(`q=repo:microsoft/winget-pkgs is:pr is:open author:${LOGIN} in:title "Ordewell.Ordewell version"`), search.args.join(' '));
    const writes = calls.filter((call) => /^(POST|PATCH) repos\/microsoft\//.test(step(call)));
    assert.deepEqual(writes.map((call) => [step(call), call.input]), [
      ['POST repos/microsoft/winget-pkgs/issues/487720/comments', { body: `Superseded by #${NEW_PR} (Ordewell.Ordewell ${VERSION}).` }],
      ['PATCH repos/microsoft/winget-pkgs/pulls/487720', { state: 'closed' }],
      ['POST repos/microsoft/winget-pkgs/issues/488839/comments', { body: `Superseded by #${NEW_PR} (Ordewell.Ordewell ${VERSION}).` }],
      ['PATCH repos/microsoft/winget-pkgs/pulls/488839', { state: 'closed' }],
    ]);
    assert.match(stdout, /^Closed #487720, superseded by #490001\.$/m);
    assert.match(stdout, /^Closed #488839, superseded by #490001\.$/m);
    assert.doesNotMatch(stdout, /::warning::/);
  });

  it('warns and goes on when a close fails, since the submission has already landed', () => {
    const { status, stdout, calls } = run(world({ search: { status: 200, items: older }, failComment: [487720] }));
    assert.equal(status, 0, stdout);
    assert.ok(!calls.some((call) => step(call) === 'PATCH repos/microsoft/winget-pkgs/pulls/487720'), 'it closed a pull request it could not explain');
    assert.ok(calls.some((call) => step(call) === 'PATCH repos/microsoft/winget-pkgs/pulls/488839'), 'it stopped at the first failure');
    assert.match(stdout, /^::warning::#487720 is still open: it could not be commented on as superseded by #490001: gh: Resource not accessible by personal access token \(HTTP 403\)$/m);
    assert.match(stdout, /^Closed #488839, superseded by #490001\.$/m);

    const closing = run(world({ search: { status: 200, items: older }, failClose: [488839] }));
    assert.equal(closing.status, 0);
    assert.match(closing.stdout, /^::warning::#488839 is still open: it could not be closed as superseded by #490001: gh: Validation Failed \(HTTP 422\)$/m);
  });

  it('warns and succeeds when the older submissions cannot be listed', () => {
    const { status, stdout, calls } = run(world({ search: { status: 422 } }));
    assert.equal(status, 0);
    assert.equal(step(calls.at(-1)), 'GET search/issues');
    assert.match(stdout, /^::warning::#490001 is open, but the older submissions of Ordewell\.Ordewell could not be listed, so none was closed: gh: Validation Failed \(HTTP 422\)$/m);
  });

  it('warns and succeeds when wingetcreate names no pull request', () => {
    const fake = world();
    fake.wingetcreate = { code: 0, pr: 'unknown' };
    const { status, stdout, calls } = run(fake);
    assert.equal(status, 0);
    assert.equal(calls.at(-1).tool, 'wingetcreate');
    assert.match(stdout, /^::warning::wingetcreate named no pull request/m);
  });

  describe('as release.yml runs it', () => {
    const hasPwsh = onPath('pwsh');
    const skip = hasPwsh ? false : 'pwsh is not installed';
    it('has pwsh, or is not required to', () => {
      hostHas('pwsh', { present: hasPwsh });
    });
    const winget = release.slice(release.search(/^  winget:$/m));
    const submit = winget.slice(winget.indexOf('- name: Open the pull request on microsoft/winget-pkgs'), winget.indexOf('- name: Say why no pull request'));
    // The step's script as the runner writes it, with the line GitHub's pwsh
    // shell appends, so a failed node fails the step.
    const script = `${submit.slice(submit.indexOf('run: |\n') + 'run: |\n'.length).replace(/^ {10}/gm, '').trimEnd()}\nif ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }\n`;
    const step = (fakeWorld) => run(fakeWorld, { command: ['pwsh', '-NoProfile', '-NonInteractive', '-Command', script], cwd: checkout, env: { TAG: `v${VERSION}` } });

    it('submits the rendered manifests of the tag\'s version from the downloaded wingetcreate.exe', { skip }, () => {
      const { status, output, calls } = step(world({ packageExists: true }));
      assert.equal(status, 0, output);
      assert.deepEqual(calls.find(({ tool }) => tool === 'wingetcreate').args, ['submit', '--no-open', '--prtitle', `New version: Ordewell.Ordewell version ${VERSION}`, MANIFESTS]);
    });

    it('fails the step when the sync is refused', { skip }, () => {
      const { status, calls } = step(world({ sync: { status: 422, body: { message: 'Unprocessable Entity' } } }));
      assert.equal(status, 1);
      assert.ok(!calls.some(({ tool }) => tool === 'wingetcreate'));
    });
  });

  it('exits 2 without its arguments and 1 without the token', () => {
    assert.equal(spawnSync(process.execPath, [SCRIPT, '--version', VERSION], { encoding: 'utf8' }).status, 2);
    const env = { ...process.env };
    delete env.WINGET_TOKEN;
    const missing = spawnSync(process.execPath, [SCRIPT, '--version', VERSION, '--manifests', MANIFESTS, '--wingetcreate', 'wingetcreate.exe'], { env, encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /^::error::WINGET_TOKEN is not set\.$/m);
  });
});

describe('which submissions a new one supersedes', () => {
  const items = [
    pr(10, 'New package: Ordewell.Ordewell version 0.14.1'),
    pr(11, 'New version: Ordewell.Ordewell version 0.14.2'),
    pr(12, 'New package: Ordewell.Ordewell version 0.14.3'),
    pr(13, 'New package: Ordewell.Ordewell version 0.14.3'),
    pr(14, 'New package: Ordewell.Ordewell version 0.14.4'),
    pr(15, 'New package: Ordewell.Ordewell version latest'),
    pr(16, 'New package: ordewell.ordewell version 0.14.1'),
    pr(17, 'New package: Ordewell.Ordewell version 0.14.1', { login: 'Ordewell-Bot' }),
  ];

  it('are the account\'s earlier ones of a lower version, or of the same version opened before it', () => {
    assert.deepEqual(supersededBy(items, { login: LOGIN, number: 13, version: '0.14.3' }).map(({ number }) => number), [10, 11, 12]);
  });

  it('never include a newer version, so a re-run of an older release closes nothing after it', () => {
    assert.deepEqual(supersededBy(items, { login: LOGIN, number: 20, version: '0.14.0' }), []);
    assert.deepEqual(supersededBy(items, { login: LOGIN, number: 12, version: '0.14.3' }).map(({ number }) => number), [10, 11]);
  });
});

describe('the words the job uses', () => {
  it('titles a submission as wingetcreate\'s own "New package" and "New version" pull requests read', () => {
    assert.equal(submissionTitle('0.14.13', false), 'New package: Ordewell.Ordewell version 0.14.13');
    assert.equal(submissionTitle('0.14.13', true), 'New version: Ordewell.Ordewell version 0.14.13');
    assert.equal(supersededComment(488839, '0.14.12'), 'Superseded by #488839 (Ordewell.Ordewell 0.14.12).');
  });

  it('gives one line of advice for each way GitHub refuses a sync', () => {
    const fork = FORK;
    const lines = {
      workflow: syncAdvice(422, 'refusing to allow a Personal Access Token to create or update workflow `.github/workflows/x.yml` without `workflow` scope', fork),
      unauthorized: syncAdvice(401, 'Bad credentials', fork),
      forbidden: syncAdvice(403, 'Resource not accessible by personal access token', fork),
      conflict: syncAdvice(409, 'There are merge conflicts', fork),
      unprocessable: syncAdvice(422, 'Unprocessable Entity', fork),
      other: syncAdvice(502, 'Bad Gateway', fork),
    };
    for (const [name, line] of Object.entries(lines)) assert.doesNotMatch(line, /\n/, name);
    assert.match(lines.workflow, /`workflow` scope \(classic token\) or Workflows: Read and write/);
    assert.match(lines.unauthorized, /expired or been revoked/);
    assert.match(lines.forbidden, /`public_repo` scope \(classic token\) or Contents: Read and write/);
    assert.match(lines.conflict, /cannot be fast-forwarded/);
    assert.match(lines.unprocessable, /`workflow` scope/);
    assert.match(lines.unprocessable, /gh repo sync ordewell-bot\/winget-pkgs/);
    assert.match(lines.other, /gh repo sync ordewell-bot\/winget-pkgs/);
  });
});
