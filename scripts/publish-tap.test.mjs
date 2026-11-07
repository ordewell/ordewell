// scripts/publish-tap.sh against a real git: a bare tap served by git's own
// http-backend behind a server that, as GitHub does for a public repository,
// lets anyone read and asks for credentials to push, and over a fake ssh that
// hands git to the same bare repository. desktop-release.test.mjs drives the
// release.yml step that calls it; this holds what the script does to a tap.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'publish-tap.sh');
const posixOnly = process.platform === 'win32' ? 'a bash script release.yml runs only on ubuntu-latest' : false;
const TOKEN = 'ghs_faketoken0123456789';
const HEADER = `basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake deploy key\n-----END OPENSSH PRIVATE KEY-----';
const BOT = 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>';

/** A git with no user, global or system config, and so no credential helper. */
const isolated = (home) => ({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C', LC_ALL: 'C' });

const formula = (version) => `class Ordewell < Formula\n  desc "Ordewell"\n  url "https://github.com/ordewell/ordewell/releases/download/v${version}/ordewell-${version}-linux-x64.tar.gz"\nend\n`;
const desktopCask = (version) => `cask "ordewell-desktop" do\n  version "${version}"\nend\n`;

describe('scripts/publish-tap.sh (ADR-0063 H11, ADR-0065 C8)', { skip: posixOnly }, () => {
  let root;
  let repos;
  let server;
  let url;
  let requests;
  let env;
  let bin;
  let log;
  let runnerTemp;
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', env: isolated(root) });
  const bare = () => join(repos, 'tap.git');
  const tapGit = (...args) => git('--git-dir', bare(), ...args);
  const tapFile = (name) => tapGit('show', `main:${name}`);
  const tapFiles = () => tapGit('ls-tree', '-r', '--name-only', 'main').trim().split('\n').sort();
  const commits = () => Number(tapGit('rev-list', '--count', 'main'));
  const pushRequests = () => requests.filter(({ query, path }) => query.includes('git-receive-pack') || path.endsWith('/git-receive-pack'));

  before(async () => {
    const backend = join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git-http-backend');
    root = mkdtempSync(join(tmpdir(), 'publish-tap-'));
    repos = join(root, 'repos');
    mkdirSync(repos);
    server = createServer((req, res) => {
      const { pathname, search } = new URL(req.url, 'http://tap');
      const entry = { method: req.method, path: pathname, query: search, authorization: req.headers.authorization ?? null };
      requests.push(entry);
      const pushing = search.includes('service=git-receive-pack') || pathname.endsWith('/git-receive-pack');
      const authorized = req.headers.authorization === undefined ? !pushing : req.headers.authorization.toLowerCase() === HEADER.toLowerCase();
      if (!authorized) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' });
        res.end();
        return;
      }
      const child = spawn(backend, [], {
        env: {
          ...isolated(root),
          GIT_PROJECT_ROOT: repos,
          GIT_HTTP_EXPORT_ALL: '1',
          REMOTE_USER: 'x-access-token',
          REQUEST_METHOD: req.method,
          PATH_INFO: pathname,
          QUERY_STRING: search.slice(1),
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
          HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
          GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
        },
      });
      const out = [];
      child.stdout.on('data', (chunk) => out.push(chunk));
      req.pipe(child.stdin);
      child.on('close', () => {
        const all = Buffer.concat(out);
        const split = all.indexOf('\r\n\r\n');
        const head = all.subarray(0, split).toString('latin1').split('\r\n');
        const headers = Object.fromEntries(head.map((line) => line.split(/: (.*)/s).slice(0, 2)));
        const status = Number((headers.Status ?? '200').split(' ')[0]);
        delete headers.Status;
        res.writeHead(status, headers);
        res.end(all.subarray(split + 4));
      });
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${server.address().port}/tap.git`;
  });

  after(() => {
    server?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /**
   * A fresh tap holding `files`, a rendered folder, and a git on PATH that
   * records each command line and, at the push, the clone's own config and
   * whether the credential is still in git's environment.
   */
  const setUp = (files = { 'README.md': 'tap\n' }) => {
    requests = [];
    for (const name of readdirSync(repos)) rmSync(join(repos, name), { recursive: true, force: true });
    for (const name of ['seed', 'rendered', 'bin', 'log', 'runner-temp', 'ssh-log']) rmSync(join(root, name), { recursive: true, force: true });
    git('init', '--quiet', '--bare', '--initial-branch', 'main', bare());
    const seed = join(root, 'seed');
    git('init', '--quiet', '--initial-branch', 'main', seed);
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(seed, name)), { recursive: true });
      writeFileSync(join(seed, name), text);
    }
    git('-C', seed, 'add', '.');
    git('-C', seed, '-c', 'user.name=maintainer', '-c', 'user.email=m@example.com', 'commit', '--quiet', '-m', 'seed');
    git('-C', seed, 'push', '--quiet', bare(), 'main');
    bin = join(root, 'bin');
    log = join(root, 'log');
    runnerTemp = join(root, 'runner-temp');
    for (const dir of [bin, log, runnerTemp]) mkdirSync(dir);
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}/argv'
if [ "$1" = -C ] && [ "$3" = push ]; then
  cp "$2/.git/config" '${log}/config-at-push'
  env | grep '^HOMEBREW_TAP_' >> '${log}/inherited' || true
fi
exec '${realGit}' "$@"
`);
    chmodSync(join(bin, 'git'), 0o755);
    env = { ...isolated(root), PATH: `${bin}${delimiter}${process.env.PATH}`, RUNNER_TEMP: runnerTemp, ORDEWELL_TAP_TEST_URL: url };
  };

  const render = (version, { cask = false } = {}) => {
    const rendered = join(root, 'rendered');
    rmSync(rendered, { recursive: true, force: true });
    mkdirSync(join(rendered, 'homebrew', 'Formula'), { recursive: true });
    writeFileSync(join(rendered, 'homebrew', 'Formula', 'ordewell.rb'), formula(version));
    if (cask) {
      mkdirSync(join(rendered, 'homebrew', 'Casks'), { recursive: true });
      writeFileSync(join(rendered, 'homebrew', 'Casks', 'ordewell-desktop.rb'), desktopCask(version));
    }
    return rendered;
  };

  /** Runs the script without blocking the event loop the server answers on. */
  const publish = (args, extra = {}) => new Promise((done) => {
    const child = spawn('bash', [SCRIPT, ...args], { env: { ...env, ...extra } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });

  const argv = () => (existsSync(join(log, 'argv')) ? readFileSync(join(log, 'argv'), 'utf8') : '');
  const leaked = (text) => text.includes(TOKEN) || text.includes(HEADER.split(' ')[1]) || text.includes('fake deploy key');

  beforeEach(() => setUp());

  describe('with the token', () => {
    it('pushes the formula as github-actions[bot], the token going in a header on the clone and the push alone', async () => {
      const out = await publish([render('1.2.3'), '1.2.3'], { HOMEBREW_TAP_TOKEN: TOKEN });
      assert.equal(out.status, 0, out.stderr);
      assert.equal(out.stdout, 'published Ordewell 1.2.3 to the tap\n');
      assert.equal(tapFile('Formula/ordewell.rb'), formula('1.2.3'));
      assert.deepEqual(tapFiles(), ['Formula/ordewell.rb', 'README.md']);
      assert.equal(tapGit('log', '-1', '--format=%an <%ae>|%cn <%ce>|%s', 'main').trim(), `${BOT}|${BOT}|Ordewell 1.2.3`);
      // The push the old step lost its credential on: both of its requests
      // carried the header, and the server answered none with a 401.
      const pushes = pushRequests();
      assert.deepEqual(pushes.map(({ method }) => method), ['GET', 'POST']);
      for (const request of pushes) assert.equal(request.authorization?.toLowerCase(), HEADER.toLowerCase());
      assert.ok(requests.every(({ authorization }) => authorization !== null), 'a request went without the header');
      const config = readFileSync(join(log, 'config-at-push'), 'utf8');
      assert.doesNotMatch(config, /extraheader|AUTHORIZATION|x-access-token/i, 'the credential was written to the clone\'s config');
      assert.ok(!leaked(config));
      assert.match(config, new RegExp(`url = ${url.replace(/[.]/g, '\\.')}\n`), 'the clone\'s remote is the plain URL');
      assert.equal(existsSync(join(log, 'inherited')) ? readFileSync(join(log, 'inherited'), 'utf8') : '', '', 'git inherits the token in its environment');
      assert.ok(!leaked(argv()), 'the token was on a git command line');
      assert.ok(!leaked(out.stdout + out.stderr), 'the token was printed');
      assert.deepEqual(readdirSync(runnerTemp), [], 'the clone outlived the script');
    });

    it('pushes nothing when re-run for a version the tap already carries', async () => {
      const rendered = render('1.2.3');
      assert.equal((await publish([rendered, '1.2.3'], { HOMEBREW_TAP_TOKEN: TOKEN })).status, 0);
      const pushed = requests.length;
      const out = await publish([rendered, '1.2.3'], { HOMEBREW_TAP_TOKEN: TOKEN });
      assert.equal(out.status, 0, out.stderr);
      assert.equal(out.stdout, 'the tap already carries Ordewell 1.2.3\n');
      assert.equal(commits(), 2, 'the re-run committed');
      assert.deepEqual(pushRequests().filter((_, at) => at >= 2), [], 'the re-run pushed');
      assert.ok(requests.length > pushed, 'the re-run did not read the tap');
      assert.deepEqual(readdirSync(runnerTemp), []);
    });

    it('fails, prompting for nothing and leaving nothing behind, when the token is refused', async () => {
      const out = await publish([render('1.2.3'), '1.2.3'], { HOMEBREW_TAP_TOKEN: 'ghs_wrong' });
      assert.notEqual(out.status, 0);
      assert.match(out.stderr, /401|Authentication failed|could not read Username/);
      assert.equal(commits(), 1);
      assert.deepEqual(readdirSync(runnerTemp), []);
    });

    it('takes the token over the deploy key when both are set', async () => {
      const out = await publish([render('1.2.3'), '1.2.3'], { HOMEBREW_TAP_TOKEN: TOKEN, HOMEBREW_TAP_DEPLOY_KEY: KEY });
      assert.equal(out.status, 0, out.stderr);
      assert.equal(pushRequests().length, 2);
      assert.doesNotMatch(argv(), /ssh/);
      assert.equal(existsSync(join(log, 'inherited')) ? readFileSync(join(log, 'inherited'), 'utf8') : '', '', 'git inherits the deploy key in its environment');
    });
  });

  describe('the cask (ADR-0065 C8)', () => {
    it('adds ordewell-desktop with --cask, drops the old ordewell cask and maps it in cask_renames.json, keeping other renames', async () => {
      setUp({ 'Casks/ordewell.rb': 'old\n', 'cask_renames.json': '{\n  "other": "another"\n}\n' });
      const out = await publish([render('1.2.3', { cask: true }), '1.2.3', '--cask'], { HOMEBREW_TAP_TOKEN: TOKEN });
      assert.equal(out.status, 0, out.stderr);
      assert.deepEqual(tapFiles(), ['Casks/ordewell-desktop.rb', 'Formula/ordewell.rb', 'cask_renames.json']);
      assert.equal(tapFile('Casks/ordewell-desktop.rb'), desktopCask('1.2.3'));
      assert.deepEqual(JSON.parse(tapFile('cask_renames.json')), { other: 'another', ordewell: 'ordewell-desktop' });
      assert.equal(commits(), 2, 'the formula, the cask and the rename went in more than one commit');
    });

    it('leaves the old cask and writes no rename without --cask, before ordewell-desktop exists', async () => {
      setUp({ 'Casks/ordewell.rb': 'old\n' });
      const out = await publish([render('1.2.3', { cask: true }), '1.2.3'], { HOMEBREW_TAP_TOKEN: TOKEN });
      assert.equal(out.status, 0, out.stderr);
      assert.deepEqual(tapFiles(), ['Casks/ordewell.rb', 'Formula/ordewell.rb']);
    });

    it('keeps a published ordewell-desktop cask as it is when only the formula is re-published', async () => {
      setUp({ 'Casks/ordewell-desktop.rb': desktopCask('1.2.2'), 'cask_renames.json': '{\n  "ordewell": "ordewell-desktop"\n}\n', 'Formula/ordewell.rb': formula('1.2.2') });
      const out = await publish([render('1.2.3'), '1.2.3'], { HOMEBREW_TAP_TOKEN: TOKEN });
      assert.equal(out.status, 0, out.stderr);
      assert.equal(tapFile('Formula/ordewell.rb'), formula('1.2.3'));
      assert.equal(tapFile('Casks/ordewell-desktop.rb'), desktopCask('1.2.2'));
      assert.deepEqual(JSON.parse(tapFile('cask_renames.json')), { ordewell: 'ordewell-desktop' });
      assert.equal(tapGit('diff', '--name-only', 'main~1', 'main').trim(), 'Formula/ordewell.rb');
    });
  });

  describe('with the deploy key', () => {
    /** An ssh that records what git handed it and runs the remote command against the bare tap. */
    const fakeSsh = () => {
      const sshLog = join(root, 'ssh-log');
      mkdirSync(sshLog);
      writeFileSync(join(bin, 'ssh.mjs'), `
        import { spawnSync } from 'node:child_process';
        import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
        const args = process.argv.slice(2);
        const option = (name) => args.flatMap((arg, at) => (args[at - 1] === '-o' && arg.startsWith(name + '=') ? [arg.slice(name.length + 1)] : []))[0];
        const key = args[args.indexOf('-i') + 1];
        const hosts = option('UserKnownHostsFile');
        appendFileSync(${JSON.stringify(join(sshLog, 'calls'))}, JSON.stringify({
          host: args.at(-2), command: args.at(-1), key,
          mode: existsSync(key) ? (statSync(key).mode & 0o777).toString(8) : null,
          text: existsSync(key) ? readFileSync(key, 'utf8') : null,
          identitiesOnly: option('IdentitiesOnly'), strict: option('StrictHostKeyChecking'),
          hosts: hosts && existsSync(hosts) ? readFileSync(hosts, 'utf8') : null,
          inherited: Object.keys(process.env).filter((name) => name.startsWith('HOMEBREW_TAP_')),
        }) + '\\n');
        const exec = ${JSON.stringify(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim())};
        const out = spawnSync('sh', ['-c', args.at(-1)], { cwd: ${JSON.stringify(repos)}, stdio: 'inherit', env: { ...process.env, PATH: exec + ':' + process.env.PATH } });
        process.exit(out.status ?? 1);
      `);
      writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nexec '${process.execPath}' "$(dirname "$0")/ssh.mjs" "$@"\n`);
      chmodSync(join(bin, 'ssh'), 0o755);
      return () => readFileSync(join(sshLog, 'calls'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    };

    it('clones and pushes over ssh with a 0600 key file and GitHub\'s pinned host keys, and deletes them after', async () => {
      const calls = fakeSsh();
      const out = await publish([render('1.2.3'), '1.2.3'], { HOMEBREW_TAP_DEPLOY_KEY: KEY, ORDEWELL_TAP_TEST_URL: 'git@github.com:tap.git' });
      assert.equal(out.status, 0, out.stderr);
      assert.equal(tapFile('Formula/ordewell.rb'), formula('1.2.3'));
      const seen = calls();
      assert.deepEqual(seen.map(({ command }) => command), ["git-upload-pack 'tap.git'", "git-receive-pack 'tap.git'"]);
      for (const call of seen) {
        assert.equal(call.host, 'git@github.com');
        assert.match(call.key, new RegExp(`^${runnerTemp.replace(/[.]/g, '\\.')}/homebrew-tap\\.\\w{6}/ssh/key$`));
        assert.equal(call.mode, '600');
        assert.equal(call.text, `${KEY}\n`);
        assert.equal(call.identitiesOnly, 'yes');
        assert.equal(call.strict, 'yes');
        assert.deepEqual(call.hosts.trim().split('\n').map((line) => line.split(' ').slice(0, 2).join(' ')), ['github.com ssh-ed25519', 'github.com ecdsa-sha2-nistp256', 'github.com ssh-rsa']);
        assert.deepEqual(call.inherited, [], 'ssh inherits the key in its environment');
      }
      assert.deepEqual(requests, [], 'the ssh path went over https');
      assert.ok(!leaked(argv()), 'the key was on a git command line');
      assert.ok(!leaked(out.stdout + out.stderr), 'the key was printed');
      assert.deepEqual(readdirSync(runnerTemp), [], 'the key outlived the script');
    });
  });

  describe('its arguments', () => {
    const refuses = async (args, extra, message) => {
      const out = await publish(args, { HOMEBREW_TAP_TOKEN: TOKEN, ...extra });
      assert.equal(out.status, 2, `${args.join(' ')}: ${out.stdout}${out.stderr}`);
      assert.match(out.stderr, message);
      assert.deepEqual(requests, [], 'the tap was read before the arguments were checked');
      assert.deepEqual(readdirSync(runnerTemp), []);
    };

    it('refuses a bad call before it reads the tap', async () => {
      const rendered = render('1.2.3', { cask: false });
      await refuses([], {}, /^usage: /);
      await refuses([rendered], {}, /^usage: /);
      await refuses([rendered, '1.2.3', '--formula'], {}, /^usage: /);
      await refuses([rendered, 'v1.2.3'], {}, /is not a version of the form x\.y\.z/);
      await refuses([rendered, '1.2.3; rm -rf /'], {}, /is not a version/);
      await refuses([join(root, 'nowhere'), '1.2.3'], {}, /no rendered formula/);
      await refuses([rendered, '1.2.4'], {}, /is not Ordewell 1\.2\.4/);
      await refuses([rendered, '1.2.3', '--cask'], {}, /--cask, but no rendered cask/);
      await refuses([rendered, '1.2.3'], { HOMEBREW_TAP_TOKEN: '' }, /neither HOMEBREW_TAP_TOKEN nor HOMEBREW_TAP_DEPLOY_KEY is set/);
    });
  });

  // Release run 42286454425 (v0.13.0): the step cloned with the token in the
  // URL, reset the remote to the plain URL so the clone's config would not keep
  // the token, and pushed with nothing left to authenticate with. Replayed
  // against the same server, it fails as that run did, which is what the token
  // test's push is held against.
  it('fails as release run 42286454425 did when the token is reset out of the remote before the push', async () => {
    const tap = join(root, 'old-tap');
    rmSync(tap, { recursive: true, force: true });
    const old = `
      set -euo pipefail
      git clone --quiet --depth 1 "\${URL/http:\\/\\//http://x-access-token:\${HOMEBREW_TAP_TOKEN}@}" "$TAP"
      git -C "$TAP" remote set-url origin "$URL"
      echo changed > "$TAP/README.md"
      git -C "$TAP" -c user.name=bot -c user.email=bot@example.com commit --quiet -am change
      git -C "$TAP" push --quiet origin HEAD
    `;
    const out = await new Promise((done) => {
      const child = spawn('bash', ['-c', old], { env: { ...env, GIT_TERMINAL_PROMPT: '0', HOMEBREW_TAP_TOKEN: TOKEN, URL: url, TAP: tap } });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => done({ status, stderr }));
    });
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /could not read Username for 'http:\/\/127\.0\.0\.1:\d+'/);
    assert.equal(commits(), 1);
    rmSync(tap, { recursive: true, force: true });
  });
});
