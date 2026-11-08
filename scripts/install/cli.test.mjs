// The one-line CLI installer (ordewell.ai/install.sh, released as install.sh).
// cli.sh runs for real against a fake release directory in a temp HOME, with a
// PATH holding only the tools it needs, so what it reports about git and the
// coding agents is what the test put there. `uname` is faked to play other
// systems. Written on the desktop.test.mjs pattern; the release archives are
// stand-ins (a tar.gz holding a script that prints a version), not a real build.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import { hostHas, pinnedShellcheck } from '../host-tools.mjs';

const SH = resolve('scripts/install/cli.sh');
const VERSION = '9.8.7';
const FAKE_BINARY = `#!/bin/sh\necho "ordewell ${VERSION}"\n`;

const whichSh = (command) => spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim();
const sandboxes = [];
const scratch = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `o65-${label}-`));
  sandboxes.push(dir);
  return dir;
};
after(() => sandboxes.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const write = (path, text, mode) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  if (mode) chmodSync(path, mode);
};

/**
 * A folder of links to the tools cli.sh uses and nothing else, so git and the
 * coding agents on the machine running the test cannot leak into what it
 * reports. The real sha256sum is optional: macOS has shasum instead.
 */
const TOOLS = ['awk', 'basename', 'cat', 'chmod', 'cp', 'cut', 'gzip', 'head', 'id', 'mkdir', 'mktemp', 'mv', 'readlink', 'rm', 'sed', 'sh', 'sha256sum', 'shasum', 'tar', 'tr'];
const toolbox = (() => {
  const dir = scratch('tools');
  for (const tool of TOOLS) {
    const path = whichSh(tool);
    if (path.startsWith('/')) symlinkSync(path, join(dir, tool));
  }
  return dir;
})();

/** A fake `uname`, so one machine can play every OS and architecture. */
function unameShim(os, machine) {
  const bin = scratch('uname');
  write(join(bin, 'uname'), `#!/bin/sh\ncase "$1" in -s) echo ${os};; -m) echo ${machine};; *) echo ${os};; esac\n`, 0o755);
  return bin;
}

/** A directory holding one fake executable per name, to put on PATH. */
function commands(table) {
  const bin = scratch('cmds');
  for (const [name, body] of Object.entries(table)) write(join(bin, name), `#!/bin/sh\n${body}\n`, 0o755);
  return bin;
}

const linux = () => unameShim('Linux', 'x86_64');
const REAL_SH = whichSh('sh');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** A tar.gz with `ordewell` at its root, made by the system tar like the release's. */
function archive(binary = FAKE_BINARY, member = 'ordewell') {
  const staging = scratch('staging');
  write(join(staging, member), binary, 0o755);
  const out = join(scratch('tgz'), 'a.tar.gz');
  const made = spawnSync('tar', ['-czf', out, '-C', staging, member], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  return readFileSync(out);
}

/**
 * A release folder: the fixed and the versioned archive for every os/arch, and its SHA256SUMS.
 * `desktop` lists the desktop installers in SHA256SUMS too, as a release that carries the app does.
 */
function release({ binary = FAKE_BINARY, omitFromSums = [], desktop = false } = {}) {
  const dir = scratch('release');
  const lines = [];
  const tgz = archive(binary);
  for (const os of ['darwin', 'linux']) {
    for (const arch of ['arm64', 'x64']) {
      for (const name of [`ordewell-${os}-${arch}.tar.gz`, `ordewell-${VERSION}-${os}-${arch}.tar.gz`]) {
        write(join(dir, name), tgz);
        if (!omitFromSums.includes(name)) lines.push(`${sha256(tgz)}  ${name}`);
      }
    }
  }
  if (desktop) {
    for (const name of ['Ordewell-mac-arm64.dmg', `Ordewell-${VERSION}-mac-arm64.dmg`, 'Ordewell-linux-x64.AppImage', `Ordewell-${VERSION}-linux-x64.AppImage`]) lines.push(`${'0'.repeat(64)}  ${name}`);
  }
  writeFileSync(join(dir, 'SHA256SUMS'), `${lines.sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join('\n')}\n`);
  return dir;
}

function run(args, { env = {}, shims = [], script } = {}) {
  const home = env.HOME ?? scratch('home');
  const path = [...shims, toolbox].join(delimiter);
  // `script` plays `curl ... | sh -s -- args`: sh reads the text from its stdin instead of a file.
  const result = spawnSync(REAL_SH, script === undefined ? [SH, ...args] : ['-s', '--', ...args], {
    ...(script === undefined ? {} : { input: script }),
    // The libc is glibc unless a test says otherwise (an empty value leaves the real detection on),
    // so a suite run on Alpine itself still tests the glibc install.
    env: { PATH: path, HOME: home, TMPDIR: tmpdir(), ORDEWELL_TEST_LIBC: 'glibc', ...env },
    encoding: 'utf8',
  });
  return { ...result, home };
}

/** The common case: Linux x64, the fake release as the source, an install folder of its own. */
function install(args = [], { dir = release(), shims = [], env = {}, home = scratch('home'), target = join(home, 'bin') } = {}) {
  return { ...run(args, { shims: [linux(), ...shims], env: { HOME: home, ORDEWELL_CLI_FROM: dir, ORDEWELL_INSTALL_DIR: target, ...env } }), target };
}

/** The heading of the notice about another ordewell, when that copy is what `ordewell` runs. */
const FIRST_HEADING = 'Typing ordewell, even in a new terminal, runs another copy, not the one just installed.';
/** Its heading when the other copy only comes later on PATH. */
const LATER_HEADING = 'This terminal may still run another ordewell, not the one just installed.';
/** Any line of that notice, for a test that expects none. */
const NOTICE = /runs another copy|may still run another ordewell|on your PATH(, after this one)?: |hash -r|To remove it|New terminals/;
const BOLD_RED = '\x1b[1;31m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LATER_HEADING_RE = new RegExp(escaped(LATER_HEADING));

describe('cli.sh', { skip: process.platform === 'win32' ? 'a POSIX sh installer; Windows installs with `npm install -g ordewell`' : false }, () => {
  it('installs the latest release: an executable binary that runs, with no temporary file beside it', () => {
    const { status, stdout, stderr, target } = install();
    assert.equal(status, 0, stderr);
    const bin = join(target, 'ordewell');
    assert.equal(readFileSync(bin, 'utf8'), FAKE_BINARY);
    assert.equal(statSync(bin).mode & 0o777, 0o755);
    assert.match(stdout, new RegExp(`Installed ordewell ordewell ${VERSION} to ${target}/ordewell`));
    assert.equal(spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim(), `ordewell ${VERSION}`);
    assert.deepEqual(readdirSync(target), ['ordewell']);
  });

  it('installs under $HOME/.local/bin when ORDEWELL_INSTALL_DIR is not set', () => {
    const home = scratch('home');
    const result = run([], { shims: [linux()], env: { HOME: home, ORDEWELL_CLI_FROM: release() } });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(home, '.local/bin/ordewell')));
  });

  it('upgrades in place', () => {
    const home = scratch('home');
    assert.equal(install([], { home }).status, 0);
    const newer = release({ binary: `${FAKE_BINARY}# newer\n` });
    const second = install([], { home, dir: newer });
    assert.equal(second.status, 0, second.stderr);
    assert.match(readFileSync(join(home, 'bin/ordewell'), 'utf8'), /# newer/);
  });

  describe('chooses the archive', () => {
    for (const [os, machine, expected] of [
      ['Darwin', 'arm64', 'ordewell-darwin-arm64.tar.gz'],
      ['Darwin', 'x86_64', 'ordewell-darwin-x64.tar.gz'],
      ['Linux', 'x86_64', 'ordewell-linux-x64.tar.gz'],
      ['Linux', 'amd64', 'ordewell-linux-x64.tar.gz'],
      ['Linux', 'aarch64', 'ordewell-linux-arm64.tar.gz'],
    ]) {
      it(`${os} ${machine} gets ${expected}`, () => {
        // sysctl would tell an Intel shim apart from Rosetta on a real Apple-silicon Mac.
        const sysctl = commands({ sysctl: 'echo 0' });
        const result = run(['--dry-run'], { shims: [unameShim(os, machine), sysctl] });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp(`File:\\s+${expected.replaceAll('.', '\\.')}`));
        assert.match(result.stdout, new RegExp(`Download:\\s+https://github\\.com/ordewell/ordewell/releases/latest/download/${expected.replaceAll('.', '\\.')}`));
        assert.match(result.stdout, /Checksums:\s+https:\/\/github\.com\/ordewell\/ordewell\/releases\/latest\/download\/SHA256SUMS/);
      });
    }

    it('an Intel shell under Rosetta on Apple silicon gets the native build', () => {
      const result = run(['--dry-run'], { shims: [unameShim('Darwin', 'x86_64'), commands({ sysctl: 'echo 1' })] });
      assert.match(result.stdout, /ordewell-darwin-arm64\.tar\.gz/);
    });

    it('--version picks the versioned name and the tagged release, with or without a v', () => {
      const flag = run(['--dry-run', '--version', '1.2.3'], { shims: [linux()] });
      assert.match(flag.stdout, /releases\/download\/v1\.2\.3\/ordewell-1\.2\.3-linux-x64\.tar\.gz/);
      assert.match(flag.stdout, /releases\/download\/v1\.2\.3\/SHA256SUMS/);
      const env = run(['--dry-run'], { shims: [linux()], env: { ORDEWELL_VERSION: 'v1.2.3' } });
      assert.match(env.stdout, /File:\s+ordewell-1\.2\.3-linux-x64\.tar\.gz/);
    });

    it('--version installs the versioned archive from the source folder', () => {
      // Only the versioned name is listed and present: the fixed one would not be found.
      const dir = release();
      rmSync(join(dir, 'ordewell-linux-x64.tar.gz'));
      const result = install(['--version', VERSION], { dir });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(join(result.target, 'ordewell')));
      const missing = install(['--version', '1.0.0'], { dir });
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /no ordewell-1\.0\.0-linux-x64\.tar\.gz/);
    });

    it('takes an https base URL as ORDEWELL_CLI_FROM and refuses anything else that is not a folder', () => {
      const url = run(['--dry-run'], { shims: [linux()], env: { ORDEWELL_CLI_FROM: 'https://example.test/rel/' } });
      assert.match(url.stdout, /Download:\s+https:\/\/example\.test\/rel\/ordewell-linux-x64\.tar\.gz/);
      assert.match(url.stdout, /Checksums:\s+https:\/\/example\.test\/rel\/SHA256SUMS/);
      const plain = run(['--dry-run'], { shims: [linux()], env: { ORDEWELL_CLI_FROM: 'http://example.test/rel' } });
      assert.notEqual(plain.status, 0);
      assert.match(plain.stderr, /not a directory or an https URL/);
    });

    it('stops where there is no build, and points Windows at npm', () => {
      const other = run(['--dry-run'], { shims: [unameShim('MINGW64_NT-10.0', 'x86_64')] });
      assert.notEqual(other.status, 0);
      assert.match(other.stderr, /npm install -g ordewell/);
      assert.match(run(['--dry-run'], { shims: [unameShim('FreeBSD', 'x86_64')] }).stderr, /npm install -g ordewell/);
      assert.match(run(['--dry-run'], { shims: [unameShim('Linux', 'i686')] }).stderr, /no Ordewell build for the i686/);
    });
  });

  describe('musl Linux (Alpine)', () => {
    const MUSL_LDD = 'echo "musl libc (x86_64)" >&2; echo "Version 1.2.5" >&2; exit 1';
    const GLIBC_LDD = 'echo "ldd (Debian GLIBC 2.36-9+deb12u7) 2.36"';

    it('refuses to install, says why and points to npm, and leaves nothing behind', () => {
      const { status, stdout, stderr, target } = install([], { env: { ORDEWELL_TEST_LIBC: 'musl' } });
      assert.equal(status, 1);
      assert.equal(stdout, '');
      assert.match(stderr, /glibc/);
      assert.match(stderr, /npm install -g ordewell/);
      assert.match(stderr, /Node\.js 20\.3 or newer/);
      assert.ok(!existsSync(target));
    });

    it('is recognised from ldd saying musl, with no override', () => {
      const result = install([], { shims: [commands({ ldd: MUSL_LDD })], env: { ORDEWELL_TEST_LIBC: '' } });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /npm install -g ordewell/);
      assert.ok(!existsSync(result.target));
    });

    it('installs as before when ldd says glibc, whatever loader files are around', () => {
      const result = install([], { shims: [commands({ ldd: GLIBC_LDD })], env: { ORDEWELL_TEST_LIBC: '' } });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(join(result.target, 'ordewell')));
    });

    it('installs as before on glibc', () => {
      const result = install([], { env: { ORDEWELL_TEST_LIBC: 'glibc' } });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(join(result.target, 'ordewell')));
    });

    it('does not apply to macOS', () => {
      const result = run(['--dry-run'], { shims: [unameShim('Darwin', 'arm64')], env: { ORDEWELL_TEST_LIBC: 'musl' } });
      assert.equal(result.status, 0, result.stderr);
    });

    it('--dry-run reports the same and exits the same way', () => {
      const result = run(['--dry-run'], { shims: [linux()], env: { ORDEWELL_TEST_LIBC: 'musl' } });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /npm install -g ordewell/);
    });

    it('--uninstall still works', () => {
      const home = scratch('home');
      const first = install([], { home });
      assert.equal(first.status, 0, first.stderr);
      const result = run(['--uninstall'], { shims: [linux()], env: { HOME: home, ORDEWELL_INSTALL_DIR: first.target, ORDEWELL_TEST_LIBC: 'musl' } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Removed /);
      assert.ok(!existsSync(join(first.target, 'ordewell')));
    });

    it('runs under dash', (t) => {
      if (!hostHas('dash')) return t.skip('dash is not installed');
      const result = spawnSync(whichSh('dash'), [SH, '--dry-run'], { env: { PATH: [linux(), commands({ ldd: MUSL_LDD }), toolbox].join(delimiter), HOME: scratch('home') }, encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /npm install -g ordewell/);
    });
  });

  describe('reads the whole script before it runs any of it', () => {
    const text = readFileSync(SH, 'utf8');
    // Cut on a line, as a dropped connection that happens to stop there would.
    const lines = text.split('\n');
    const cutAtLine = (n) => `${lines.slice(0, n).join('\n')}\n`;

    /** Plays `curl … | sh` for a cut-off script against a fake release; returns the run and what it left behind. */
    function cutRun(cut) {
      const home = scratch('home');
      const target = join(home, 'bin');
      const result = run([], { script: cut, shims: [linux()], env: { HOME: home, ORDEWELL_CLI_FROM: release(), ORDEWELL_INSTALL_DIR: target } });
      return { ...result, home, target };
    }

    for (const fraction of [0.3, 0.6, 0.9]) {
      it(`a download cut off at ${fraction * 100}% of its bytes fails and installs nothing`, () => {
        const result = cutRun(text.slice(0, Math.floor(text.length * fraction)));
        assert.notEqual(result.status, 0, result.stdout);
        assert.ok(!existsSync(result.target), 'the install folder must not even be created');
        assert.deepEqual(readdirSync(result.home), []);
      });
    }

    it('a script cut off at any line runs none of its steps', () => {
      // Whatever the cut, the steps are in main(), which the last line calls: a cut inside it is a syntax
      // error, and one before the call is a script that defines functions and does nothing.
      for (let n = 1; n < lines.length - 2; n += 7) {
        const result = cutRun(cutAtLine(n));
        assert.equal(result.stdout, '', `cut after line ${n}`);
        assert.ok(!existsSync(result.target), `cut after line ${n}`);
        assert.deepEqual(readdirSync(result.home), [], `cut after line ${n}`);
      }
    });

    it('the whole script, piped in, still installs', () => {
      const result = cutRun(text);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(join(result.target, 'ordewell')));
    });

    it('`… | sh -s -- --help` reads the whole script, so the writer never gets EPIPE (curl error 23)', async () => {
      const child = spawn(REAL_SH, ['-s', '--', '--help'], { env: { PATH: toolbox, HOME: scratch('home') }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      const errors = [];
      child.stdin.on('error', (e) => errors.push(e.code));
      const closed = new Promise((done) => child.on('close', done));
      const bytes = Buffer.from(text);
      for (let at = 0; at < bytes.length; at += 512) {
        await new Promise((done) => child.stdin.write(bytes.subarray(at, at + 512), (e) => { if (e) errors.push(e.code); done(); }));
        await new Promise((done) => setTimeout(done, 2));
      }
      child.stdin.end();
      const status = await closed;
      assert.deepEqual(errors, []);
      assert.equal(status, 0);
      assert.match(stdout, /Usage: install\.sh/);
    });
  });

  describe('input checks', () => {
    it('is valid POSIX sh, under dash too, and the pinned shellcheck has no complaint', (t) => {
      assert.equal(spawnSync('sh', ['-n', SH]).status, 0);
      if (hostHas('dash')) assert.equal(spawnSync('dash', ['-n', SH]).status, 0);
      const shellcheck = pinnedShellcheck(t);
      if (!shellcheck) return;
      const lint = spawnSync(shellcheck, ['-s', 'sh', SH], { encoding: 'utf8' });
      assert.equal(lint.status, 0, lint.stdout);
    });

    it('runs under dash, the sh of Ubuntu', (t) => {
      if (!hostHas('dash')) return t.skip('dash is not installed');
      const result = spawnSync(whichSh('dash'), [SH, '--dry-run'], { env: { PATH: [linux(), toolbox].join(delimiter), HOME: scratch('home') }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    });

    it('never edits a profile, asks for sudo or touches an OS protection', () => {
      const code = readFileSync(SH, 'utf8')
        .split('\n')
        // The hint prints the line to add to a profile; that is text, not a write.
        .filter((line) => !line.trimStart().startsWith('#') && !/^\s*(say|note) /.test(line) && !/^\s*(fish|zsh|bash|\*)\) /.test(line))
        .join('\n');
      assert.doesNotMatch(code, /\bsudo\b|xattr|com\.apple\.quarantine|spctl|>>\s*"?\$?(HOME|~)/);
    });

    it('prints its help and rejects what it does not know', () => {
      const help = run(['--help']);
      assert.equal(help.status, 0);
      for (const text of [/--version X\.Y\.Z/, /--uninstall/, /--dry-run/, /ORDEWELL_CLI_FROM/, /ORDEWELL_INSTALL_DIR/]) assert.match(help.stdout, text);
      // Hidden until a release carries the desktop app (ADR-0065 C10); the option itself still works.
      assert.doesNotMatch(help.stdout, /desktop/i);
      const bad = run(['--frobnicate']);
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /unknown option/);
    });

    it('refuses a version that is not a version, before it reaches a URL', () => {
      for (const version of ['latest', '1.2', '1.2.3/../../x', '1.2.3;rm', '$(id).1.1', '..1.1']) {
        const result = run(['--dry-run', '--version', version]);
        assert.notEqual(result.status, 0, version);
        assert.match(result.stderr, /not a version/, version);
      }
    });

    it('refuses an ORDEWELL_CLI_FROM folder that has no SHA256SUMS or no archive', () => {
      const dir = release();
      rmSync(join(dir, 'SHA256SUMS'));
      const noSums = install([], { dir });
      assert.equal(noSums.status, 1);
      assert.match(noSums.stderr, /no SHA256SUMS/);
      const empty = install([], { dir: scratch('empty') });
      assert.equal(empty.status, 1);
      assert.ok(!existsSync(join(empty.target, 'ordewell')));
    });
  });

  describe('verifies before it installs', () => {
    it('stops on a checksum mismatch and installs nothing', () => {
      const dir = release();
      write(join(dir, 'ordewell-linux-x64.tar.gz'), archive(`${FAKE_BINARY}# tampered\n`));
      const result = install([], { dir });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /does not match SHA256SUMS/);
      assert.match(result.stderr, /Nothing was installed/);
      assert.ok(!existsSync(result.target));
    });

    it('leaves a previous install as it was after a failed upgrade', () => {
      const home = scratch('home');
      assert.equal(install([], { home }).status, 0);
      const bad = release();
      write(join(bad, 'ordewell-linux-x64.tar.gz'), 'tampered');
      assert.equal(install([], { home, dir: bad }).status, 1);
      assert.equal(readFileSync(join(home, 'bin/ordewell'), 'utf8'), FAKE_BINARY);
      assert.deepEqual(readdirSync(join(home, 'bin')), ['ordewell']);
    });

    it('stops when SHA256SUMS does not list the archive', () => {
      const result = install([], { dir: release({ omitFromSums: ['ordewell-linux-x64.tar.gz'] }) });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /no checksum for ordewell-linux-x64\.tar\.gz/);
      assert.ok(!existsSync(result.target));
    });

    it('does not take the checksum of a different archive for this one', () => {
      // The versioned name is listed; the fixed one is asked for.
      const dir = release({ omitFromSums: ['ordewell-linux-x64.tar.gz'] });
      assert.match(readFileSync(join(dir, 'SHA256SUMS'), 'utf8'), /ordewell-9\.8\.7-linux-x64\.tar\.gz/);
      assert.equal(install([], { dir }).status, 1);
    });

    it('takes a SHA256SUMS whose hash is upper case or marked binary with *', () => {
      const dir = release();
      const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').replace(/^([0-9a-f]{64}) {2}(ordewell-linux-x64\.tar\.gz)$/m, (_, hash, name) => `${hash.toUpperCase()} *${name}`);
      writeFileSync(join(dir, 'SHA256SUMS'), sums);
      assert.equal(install([], { dir }).status, 0);
    });

    it('stops when the archive holds no ordewell at its root', () => {
      const dir = release();
      const odd = archive(FAKE_BINARY, 'something-else');
      write(join(dir, 'ordewell-linux-x64.tar.gz'), odd);
      const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').replace(/^[0-9a-f]{64}( {2}ordewell-linux-x64\.tar\.gz)$/m, `${sha256(odd)}$1`);
      writeFileSync(join(dir, 'SHA256SUMS'), sums);
      const result = install([], { dir });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /holds no ordewell/);
      assert.ok(!existsSync(join(result.target, 'ordewell')));
    });

    it('cleans its temporary directory up, on success and on failure', () => {
      const tmp = scratch('tmp');
      assert.equal(install([], { env: { TMPDIR: tmp } }).status, 0);
      const bad = release();
      write(join(bad, 'ordewell-linux-x64.tar.gz'), 'tampered');
      assert.equal(install([], { dir: bad, env: { TMPDIR: tmp } }).status, 1);
      assert.deepEqual(readdirSync(tmp), []);
    });

    it('reports a binary that does not run, instead of calling it installed', () => {
      const result = install([], { dir: release({ binary: '#!/bin/sh\nexit 3\n' }) });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /did not run/);
    });
  });

  describe('--dry-run', () => {
    it('says what it would do and changes nothing', () => {
      const home = scratch('home');
      const target = join(home, 'bin');
      const result = run(['--dry-run'], { shims: [linux()], env: { HOME: home, ORDEWELL_INSTALL_DIR: target } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`Install:\\s+${target}/ordewell`));
      assert.deepEqual(readdirSync(home), []);
    });

    it('with --uninstall removes nothing', () => {
      const home = scratch('home');
      const first = install([], { home });
      assert.equal(first.status, 0);
      write(join(home, '.ordewell/runtime/x'), 'x');
      const result = run(['--uninstall', '--dry-run'], { shims: [linux()], env: { HOME: home, ORDEWELL_INSTALL_DIR: first.target } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Would remove .*\/bin\/ordewell/);
      assert.ok(existsSync(join(first.target, 'ordewell')));
      assert.ok(existsSync(join(home, '.ordewell/runtime/x')));
    });
  });

  describe('--uninstall', () => {
    it('removes the binary and the runtime cache, and leaves sessions and other data', () => {
      const home = scratch('home');
      const first = install([], { home });
      assert.equal(first.status, 0);
      write(join(home, '.ordewell/runtime/0.12.3/node_modules/x.js'), 'x');
      write(join(home, '.ordewell/sessions/s1.json'), '{}');
      write(join(home, '.ordewell/config.json'), '{}');
      write(join(first.target, 'other-tool'), 'not ours');
      const result = run(['--uninstall'], { shims: [linux()], env: { HOME: home, ORDEWELL_INSTALL_DIR: first.target } });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!existsSync(join(first.target, 'ordewell')));
      assert.ok(!existsSync(join(home, '.ordewell/runtime')));
      assert.equal(readFileSync(join(home, '.ordewell/sessions/s1.json'), 'utf8'), '{}');
      assert.ok(existsSync(join(home, '.ordewell/config.json')));
      assert.ok(existsSync(join(first.target, 'other-tool')));
      assert.match(result.stdout, /Removed .*\/bin\/ordewell/);
      assert.match(result.stdout, /left in place/);
    });

    it('is a no-op the second time', () => {
      const home = scratch('home');
      const env = { HOME: home, ORDEWELL_INSTALL_DIR: join(home, 'bin') };
      const result = run(['--uninstall'], { shims: [linux()], env });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /nothing was removed/);
    });

    it('needs no network, no release and no supported OS', () => {
      const result = run(['--uninstall'], { shims: [unameShim('FreeBSD', 'x86_64')] });
      assert.equal(result.status, 0, result.stderr);
    });

    describe('with another ordewell on PATH', () => {
      /** A home with this installer's copy, the runtime folder the binary unpacks, and an older ordewell elsewhere. */
      function withOtherCopy() {
        const home = scratch('home');
        const first = install([], { home });
        assert.equal(first.status, 0, first.stderr);
        write(join(home, '.ordewell/runtime/0.12.3/skills/x.md'), 'x');
        write(join(home, '.ordewell/sessions/s1.json'), '{}');
        const other = commands({ ordewell: 'echo ordewell 0.12.3' });
        return { home, target: first.target, other };
      }

      it('keeps ~/.ordewell/runtime, which that copy uses, and says why', () => {
        const { home, target, other } = withOtherCopy();
        const result = run(['--uninstall'], { shims: [linux(), other], env: { HOME: home, ORDEWELL_INSTALL_DIR: target } });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(!existsSync(join(target, 'ordewell')));
        assert.ok(existsSync(join(home, '.ordewell/runtime/0.12.3/skills/x.md')));
        assert.ok(existsSync(join(home, '.ordewell/sessions/s1.json')));
        assert.match(result.stdout, /Removed .*\/bin\/ordewell/);
        assert.match(result.stdout, new RegExp(`Kept ${escaped(home)}/\\.ordewell/runtime: another ordewell is on your PATH \\(${escaped(other)}/ordewell\\)`));
        assert.doesNotMatch(result.stdout, /Removed .*runtime/);
      });

      it('says the same, and removes nothing, with --dry-run', () => {
        const { home, target, other } = withOtherCopy();
        const result = run(['--uninstall', '--dry-run'], { shims: [linux(), other], env: { HOME: home, ORDEWELL_INSTALL_DIR: target } });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp(`Would keep ${escaped(home)}/\\.ordewell/runtime: another ordewell is on your PATH`));
        assert.doesNotMatch(result.stdout, /Would remove .*runtime/);
        assert.ok(existsSync(join(target, 'ordewell')));
        assert.ok(existsSync(join(home, '.ordewell/runtime/0.12.3/skills/x.md')));
      });

      it('does not count the copy being removed, even with its folder on PATH', () => {
        const home = scratch('home');
        const first = install([], { home });
        assert.equal(first.status, 0, first.stderr);
        write(join(home, '.ordewell/runtime/0.12.3/skills/x.md'), 'x');
        const env = { HOME: home, ORDEWELL_INSTALL_DIR: first.target };
        const dry = run(['--uninstall', '--dry-run'], { shims: [linux(), first.target], env });
        assert.match(dry.stdout, /Would remove .*\.ordewell\/runtime/);
        const result = run(['--uninstall'], { shims: [linux(), first.target], env });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(!existsSync(join(home, '.ordewell/runtime')));
        assert.match(result.stdout, /Removed .*\.ordewell\/runtime/);
      });
    });
  });

  describe('the PATH hint', () => {
    it('is absent when the install folder is on PATH', () => {
      const home = scratch('home');
      const target = join(home, 'bin');
      mkdirSync(target, { recursive: true });
      const result = install([], { home, target, env: { PATH: [linux(), toolbox, target].join(delimiter) } });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /not on your PATH/);
    });

    it('names the line to add for the shell, when it is not on PATH', () => {
      const zsh = install([], { env: { SHELL: '/bin/zsh' } });
      assert.match(zsh.stdout, new RegExp(`${zsh.target} is not on your PATH`));
      assert.match(zsh.stdout, new RegExp(`export PATH="${zsh.target}:\\$PATH"' >> ~/\\.zshrc`));
      assert.match(install([], { env: { SHELL: '/usr/bin/fish' } }).stdout, /fish_add_path ".*\/bin"/);
      assert.match(install([], { env: { SHELL: '/bin/bash' } }).stdout, />> ~\/\.bashrc/);
    });

    it('says nothing about another ordewell when the installed one is the one PATH finds, by any spelling of its folder', () => {
      const home = scratch('home');
      const target = join(home, 'bin');
      mkdirSync(target, { recursive: true });
      const alias = join(scratch('alias'), 'bin');
      symlinkSync(target, alias);
      for (const first of [target, `${target}/`, alias]) {
        const result = install([], { home, target, env: { PATH: [first, linux(), toolbox, target].join(delimiter) } });
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stdout, NOTICE);
      }
    });

    /**
     * An npm global install: `<prefix>/bin/ordewell` links into
     * `<prefix>/lib/node_modules`, and that bin folder comes before the
     * installer's, which is itself on PATH.
     */
    function npmInstall() {
      const prefix = scratch('npm-prefix');
      write(join(prefix, 'lib/node_modules/ordewell/dist/cli.js'), '#!/bin/sh\necho "ordewell 0.12.6"\n', 0o755);
      mkdirSync(join(prefix, 'bin'));
      symlinkSync('../lib/node_modules/ordewell/dist/cli.js', join(prefix, 'bin/ordewell'));
      return join(prefix, 'bin');
    }

    for (const shell of ['sh', 'dash']) {
      it(`names an older ordewell earlier on PATH and how to use the new one, under ${shell}`, (t) => {
        if (!hostHas(shell)) return t.skip(`${shell} is not installed`);
        const home = scratch('home');
        const target = join(home, 'bin');
        mkdirSync(target, { recursive: true });
        const npmBin = npmInstall();
        const PATH = [npmBin, linux(), toolbox, target].join(delimiter);
        const result = spawnSync(whichSh(shell), [SH], { env: { PATH, HOME: home, TMPDIR: tmpdir(), ORDEWELL_CLI_FROM: release(), ORDEWELL_INSTALL_DIR: target }, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        // The case being reported: what the next `ordewell` runs is the old one.
        assert.equal(spawnSync(whichSh(shell), ['-c', 'ordewell --version'], { env: { PATH }, encoding: 'utf8' }).stdout.trim(), 'ordewell 0.12.6');
        assert.match(result.stdout, new RegExp(`${escaped(FIRST_HEADING)}\\nIt comes first on your PATH: ${npmBin}/ordewell\\n`));
        assert.match(result.stdout, new RegExp(`To use ${target}/ordewell instead:\\n  npm uninstall -g ordewell .*# it was installed with npm\\n`));
        assert.match(result.stdout, new RegExp(`put ${target} before ${npmBin} on your PATH`));
        assert.equal(result.stdout.split('\n').filter((line) => line.includes(`${npmBin}/ordewell`)).length, 1, result.stdout);
        assert.equal(result.stdout.match(/npm uninstall -g ordewell/g)?.length, 1, result.stdout);
        // Removing the copy leaves a terminal that ran it pointing at a missing file, so hash -r is still the step.
        assert.match(result.stdout, /this terminal keeps running the copy it ran before until you run:\n  hash -r +# or open a new terminal\n/);
        assert.equal(result.stdout.match(/hash -r/g)?.length, 1, result.stdout);
        assert.doesNotMatch(result.stdout, LATER_HEADING_RE);
      });

      // What a real user saw: npm's 0.12.6 later on a PATH that lists both folders
      // twice, and a terminal that had hashed the npm copy kept running it.
      it(`names an ordewell later on PATH, how to remove it and hash -r, under ${shell}`, (t) => {
        if (!hostHas(shell)) return t.skip(`${shell} is not installed`);
        const home = scratch('home');
        const target = join(home, 'bin');
        mkdirSync(target, { recursive: true });
        const npmBin = npmInstall();
        const PATH = [target, target, linux(), toolbox, npmBin, npmBin].join(delimiter);
        const result = spawnSync(whichSh(shell), [SH], { env: { PATH, HOME: home, TMPDIR: tmpdir(), ORDEWELL_CLI_FROM: release(), ORDEWELL_INSTALL_DIR: target }, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(spawnSync(whichSh(shell), ['-c', 'ordewell --version'], { env: { PATH }, encoding: 'utf8' }).stdout.trim(), `ordewell ${VERSION}`);
        assert.equal(result.stdout.split('\n').filter((line) => line.includes(`${npmBin}/ordewell`)).length, 1, result.stdout);
        assert.match(result.stdout, new RegExp(`${escaped(LATER_HEADING)}\\nAnother ordewell is on your PATH, after this one: ${npmBin}/ordewell\\n  To remove it: npm uninstall -g ordewell .*# it was installed with npm\\n`));
        assert.equal(result.stdout.match(/npm uninstall -g ordewell/g)?.length, 1, result.stdout);
        // Removal alone is not enough for this terminal: it says hash -r, once, on a line of its own.
        assert.match(result.stdout, /New terminals run the new one\.\nThis terminal keeps running the copy it ran before, even once that copy is removed, until you run:\n  hash -r +# or open a new terminal\n$/);
        assert.equal(result.stdout.match(/hash -r/g)?.length, 1, result.stdout);
        assert.doesNotMatch(result.stdout, /comes first|runs another copy/);
        assert.doesNotMatch(result.stdout, /\x1b/, 'no colour when stdout is not a terminal');
      });

      // `command -v` prints a relative PATH entry's match as `old/ordewell`,
      // and an empty entry's (the current folder) as a bare `ordewell` under dash.
      for (const [label, entry] of [['a relative entry', 'old'], ['an empty entry', ''], ['a dot entry', '.']]) {
        it(`names an older ordewell found through ${label} on PATH, under ${shell}`, (t) => {
          if (!hostHas(shell)) return t.skip(`${shell} is not installed`);
          const home = scratch('home');
          const target = join(home, 'bin');
          mkdirSync(target, { recursive: true });
          const cwd = scratch('cwd');
          const old = join(cwd, entry);
          write(join(old, 'ordewell'), '#!/bin/sh\necho "ordewell 0.12.6"\n', 0o755);
          // Joined with ':' by hand: an empty entry is what is being tested, and this suite is POSIX-only.
          const PATH = [entry, linux(), toolbox, target].join(':');
          const result = spawnSync(whichSh(shell), [SH], { cwd, env: { PATH, HOME: home, TMPDIR: tmpdir(), ORDEWELL_CLI_FROM: release(), ORDEWELL_INSTALL_DIR: target }, encoding: 'utf8' });
          assert.equal(result.status, 0, result.stderr);
          assert.equal(spawnSync(whichSh(shell), ['-c', 'ordewell --version'], { cwd, env: { PATH }, encoding: 'utf8' }).stdout.trim(), 'ordewell 0.12.6');
          const shown = join(old, 'ordewell');
          assert.match(result.stdout, new RegExp(`It comes first on your PATH: ${shown}\\n`));
          assert.match(result.stdout, new RegExp(`  delete ${shown}\\n`));
          assert.match(result.stdout, new RegExp(`put ${target} before ${old.replace(/\/$/, '')} on your PATH`));
          assert.match(result.stdout, /relative to the folder you are in/);
        });
      }
    }

    it('says nothing about another ordewell when a relative PATH entry is the install folder', () => {
      const home = scratch('home');
      mkdirSync(join(home, 'bin'), { recursive: true });
      const result = spawnSync(REAL_SH, [SH], { cwd: home, env: { PATH: ['bin', linux(), toolbox].join(':'), HOME: home, TMPDIR: tmpdir(), ORDEWELL_CLI_FROM: release(), ORDEWELL_INSTALL_DIR: join(home, 'bin') }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, NOTICE);
    });

    it('names a Homebrew or any other earlier ordewell, with the way to remove it', () => {
      const brew = join(scratch('brew'), 'homebrew');
      write(join(brew, 'Cellar/ordewell/0.12.6/bin/ordewell'), '#!/bin/sh\necho "ordewell 0.12.6"\n', 0o755);
      mkdirSync(join(brew, 'bin'));
      symlinkSync('../Cellar/ordewell/0.12.6/bin/ordewell', join(brew, 'bin/ordewell'));
      const other = commands({ ordewell: 'echo "ordewell 0.11.0"' });
      for (const [bin, hint] of [[join(brew, 'bin'), /brew uninstall ordewell/], [other, new RegExp(`  delete ${other}/ordewell\\n`)]]) {
        const home = scratch('home');
        const target = join(home, 'bin');
        const result = install([], { home, target, env: { PATH: [bin, linux(), toolbox, target].join(delimiter) } });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp(`${escaped(FIRST_HEADING)}\\nIt comes first on your PATH: ${bin}/ordewell\\n`));
        assert.match(result.stdout, hint);
      }
    });

    it('names a Homebrew and any other ordewell later on PATH, each with the way to remove it', () => {
      const brew = join(scratch('brew'), 'homebrew');
      write(join(brew, 'Cellar/ordewell/0.12.6/bin/ordewell'), '#!/bin/sh\necho "ordewell 0.12.6"\n', 0o755);
      mkdirSync(join(brew, 'bin'));
      symlinkSync('../Cellar/ordewell/0.12.6/bin/ordewell', join(brew, 'bin/ordewell'));
      const other = commands({ ordewell: 'echo "ordewell 0.11.0"' });
      const home = scratch('home');
      const target = join(home, 'bin');
      mkdirSync(target, { recursive: true });
      const result = install([], { home, target, env: { PATH: [target, linux(), toolbox, join(brew, 'bin'), other].join(delimiter) } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stdout,
        new RegExp(
          `${escaped(LATER_HEADING)}\\n`
            + `Another ordewell is on your PATH, after this one: ${brew}/bin/ordewell\\n  To remove it: brew uninstall ordewell .*# it was installed with Homebrew\\n`
            + `Another ordewell is on your PATH, after this one: ${other}/ordewell\\n  To remove it: delete ${other}/ordewell\\n`,
        ),
      );
      assert.equal(result.stdout.match(/hash -r/g)?.length, 1);
      assert.doesNotMatch(result.stdout, /comes first|runs another copy/);
    });

    it('names an ordewell before the install folder and another after it, and says hash -r once', () => {
      const before = commands({ ordewell: 'echo "ordewell 0.11.0"' });
      const npmBin = npmInstall();
      const home = scratch('home');
      const target = join(home, 'bin');
      mkdirSync(target, { recursive: true });
      const result = install([], { home, target, env: { PATH: [before, linux(), toolbox, target, npmBin].join(delimiter) } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`${escaped(FIRST_HEADING)}\\nIt comes first on your PATH: ${before}/ordewell\\n`));
      assert.match(result.stdout, new RegExp(`Another ordewell is also on your PATH: ${npmBin}/ordewell\\n  To remove it: npm uninstall -g ordewell`));
      assert.doesNotMatch(result.stdout, LATER_HEADING_RE);
      assert.equal(result.stdout.split('\n').filter((line) => line.includes(`${before}/ordewell`)).length, 2, result.stdout);
      assert.equal(result.stdout.match(/hash -r/g)?.length, 1, result.stdout);
    });

    it('closes the output with the notice, after what it found about git and the coding agents', () => {
      const npmBin = npmInstall();
      const home = scratch('home');
      const target = join(home, 'bin');
      mkdirSync(target, { recursive: true });
      const result = install([], { home, target, shims: [commands({ git: 'echo "git version 2.43.0"', claude: 'true' })], env: { PATH: [target, linux(), toolbox, npmBin].join(delimiter) } });
      assert.equal(result.status, 0, result.stderr);
      const heading = result.stdout.indexOf(LATER_HEADING);
      assert.ok(heading > result.stdout.indexOf('git: 2.43 found.'), result.stdout);
      assert.ok(heading > result.stdout.indexOf('Coding agents found: Claude Code (claude).'), result.stdout);
      assert.ok(result.stdout.indexOf('git: ') > result.stdout.indexOf('Installed ordewell'), result.stdout);
      assert.match(result.stdout, /hash -r +# or open a new terminal\n$/);
    });

    describe('in colour', () => {
      /** An install with npm's copy later on PATH, so the notice prints, under `env`. */
      const later = (env) => {
        const npmBin = npmInstall();
        const home = scratch('home');
        const target = join(home, 'bin');
        mkdirSync(target, { recursive: true });
        return install([], { home, target, env: { PATH: [target, linux(), toolbox, npmBin].join(delimiter), ...env } });
      };

      it('makes the heading bold red and the commands bold when FORCE_COLOR or CLICOLOR_FORCE asks', () => {
        for (const env of [{ FORCE_COLOR: '1' }, { CLICOLOR_FORCE: '1' }, { FORCE_COLOR: '1', TERM: 'dumb' }]) {
          const result = later(env);
          assert.equal(result.status, 0, result.stderr);
          assert.ok(result.stdout.includes(`\n${BOLD_RED}${LATER_HEADING}${OFF}\n`), JSON.stringify(result.stdout));
          assert.ok(result.stdout.includes(`\n  ${BOLD}hash -r${OFF}`), JSON.stringify(result.stdout));
          assert.ok(result.stdout.includes(`To remove it: ${BOLD}npm uninstall -g ordewell${OFF}`), JSON.stringify(result.stdout));
        }
      });

      it('makes the first-on-PATH heading and the PATH line bold too', () => {
        const npmBin = npmInstall();
        const result = install([], { env: { PATH: [npmBin, linux(), toolbox].join(delimiter), SHELL: '/bin/zsh', FORCE_COLOR: '1' } });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes(`\n${BOLD_RED}${FIRST_HEADING}${OFF}\n`), JSON.stringify(result.stdout));
        assert.ok(result.stdout.includes(`  ${BOLD}echo 'export PATH="${result.target}:$PATH"' >> ~/.zshrc${OFF}\n`), JSON.stringify(result.stdout));
        assert.ok(result.stdout.includes(`  ${BOLD}npm uninstall -g ordewell${OFF}`), JSON.stringify(result.stdout));
      });

      it('has no escape codes when NO_COLOR is set, even with FORCE_COLOR, or when FORCE_COLOR is 0', () => {
        for (const env of [{ FORCE_COLOR: '1', NO_COLOR: '1' }, { CLICOLOR_FORCE: '1', NO_COLOR: '1' }, { FORCE_COLOR: '0' }, { FORCE_COLOR: '' }]) {
          const result = later(env);
          assert.equal(result.status, 0, result.stderr);
          assert.ok(result.stdout.includes(`\n${LATER_HEADING}\n`), result.stdout);
          assert.doesNotMatch(result.stdout, /\x1b/);
        }
      });
    });

    it('says nothing about another ordewell, or hash -r, when there is none', () => {
      const home = scratch('home');
      const target = join(home, 'bin');
      mkdirSync(target, { recursive: true });
      const result = install([], { home, target, env: { PATH: [target, linux(), toolbox, target].join(delimiter) } });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, NOTICE);
    });

    it('names an earlier ordewell beside the PATH hint, when the install folder is not on PATH', () => {
      const npmBin = npmInstall();
      const result = install([], { env: { PATH: [npmBin, linux(), toolbox].join(delimiter), SHELL: '/bin/zsh' } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /is not on your PATH/);
      assert.match(result.stdout, new RegExp(`${escaped(FIRST_HEADING)}\\nIt comes first on your PATH: ${npmBin}/ordewell\\n`));
      // Both things to act on close the output, after what it found about git and the agents.
      const agents = result.stdout.indexOf('No coding agent was found');
      assert.ok(agents > result.stdout.indexOf('git: '), result.stdout);
      assert.ok(result.stdout.indexOf('is not on your PATH') > agents, result.stdout);
      assert.ok(result.stdout.indexOf(FIRST_HEADING) > result.stdout.indexOf('is not on your PATH'), result.stdout);
    });

    it('leaves every profile alone', () => {
      const result = install([], { env: { SHELL: '/bin/zsh' } });
      assert.deepEqual(readdirSync(result.home), ['bin']);
    });
  });

  describe('what it reports about git', () => {
    const git = (output) => commands({ git: `echo "${output}"` });

    it('says git is optional when it is missing, and still succeeds', () => {
      const result = install();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /git: not found\. It is optional/);
      assert.match(result.stdout, /without worktrees/);
      assert.match(result.stdout, /2\.38 or newer is recommended/);
      assert.match(result.stdout, /isolated worktrees, delegated tasks and Merge all/);
    });

    it('says an old git is older than the recommended 2.38, and still succeeds', () => {
      for (const output of ['git version 2.30.2', 'git version 2.37.9', 'git version 1.9.1']) {
        const result = install([], { shims: [git(output)] });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /git: \d\.\d+ is older than the recommended 2\.38/, output);
      }
    });

    it('is content with 2.38 and newer, however the version is written', () => {
      for (const [output, shown] of [['git version 2.38.0', '2.38'], ['git version 2.43.0', '2.43'], ['git version 2.39.3 (Apple Git-145)', '2.39'], ['git version 3.0.1', '3.0']]) {
        const result = install([], { shims: [git(output)] });
        assert.match(result.stdout, new RegExp(`git: ${shown.replace('.', '\\.')} found\\.`), output);
        assert.doesNotMatch(result.stdout, /older than/);
      }
    });

    it('says so when it cannot read the version', () => {
      const result = install([], { shims: [git('something unexpected')] });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /git: found, but its version could not be read/);
    });
  });

  describe('what it reports about coding agents', () => {
    it('lists the supported agents it finds on PATH, by the commands the runners use', () => {
      const all = commands({ claude: 'true', codex: 'true', opencode: 'true', copilot: 'true', qwen: 'true', cline: 'true', gemini: 'true', 'cursor-agent': 'true' });
      const result = install([], { shims: [all] });
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stdout,
        /Coding agents found: Claude Code \(claude\), Codex \(codex\), OpenCode \(opencode\), GitHub Copilot CLI \(copilot\), Qwen Code \(qwen\), Cline \(cline\), Gemini CLI \(gemini\), Cursor \(cursor-agent\)\./,
      );
      assert.doesNotMatch(result.stdout, /No coding agent was found/);
    });

    it('lists only the ones present', () => {
      const result = install([], { shims: [commands({ codex: 'true', somethingelse: 'true' })] });
      assert.match(result.stdout, /Coding agents found: Codex \(codex\)\./);
      assert.doesNotMatch(result.stdout, /Claude Code \(claude\)/);
    });

    it('says none was found and that one is required, without failing the install', () => {
      const result = install();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /No coding agent was found on PATH\. Ordewell needs one, installed and signed in: Claude Code \(claude\), Codex \(codex\)/);
      assert.ok(existsSync(join(result.target, 'ordewell')));
    });

    it('does not install an agent or git', () => {
      const result = install();
      assert.deepEqual(readdirSync(result.target), ['ordewell']);
    });
  });

  describe('--desktop', () => {
    const withDesktop = () => release({ desktop: true });

    /** A desktop installer that records the arguments it was run with. */
    function desktopScript() {
      const dir = scratch('desktop');
      const log = join(dir, 'args.log');
      const script = join(dir, 'desktop.sh');
      write(script, `#!/bin/sh\necho "desktop.sh $*" >> "${log}"\necho "desktop installer ran"\n`);
      return { script, log };
    }

    it('runs the desktop installer after the CLI, with --version passed on', () => {
      const { script, log } = desktopScript();
      const result = install(['--desktop', '--version', VERSION], { dir: withDesktop(), env: { ORDEWELL_DESKTOP_SCRIPT_FROM: script } });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(join(result.target, 'ordewell')));
      assert.match(result.stdout, /desktop installer ran/);
      assert.equal(readFileSync(log, 'utf8'), `desktop.sh --version ${VERSION}\n`);
    });

    it('passes --dry-run on, and installs neither', () => {
      const { script, log } = desktopScript();
      const result = install(['--desktop', '--dry-run', '--version', VERSION], { env: { ORDEWELL_DESKTOP_SCRIPT_FROM: script } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(log, 'utf8'), `desktop.sh --version ${VERSION} --dry-run\n`);
      assert.ok(!existsSync(join(result.target, 'ordewell')));
    });

    it('passes nothing on when there is nothing to pass', () => {
      const { script, log } = desktopScript();
      assert.equal(install(['--desktop'], { dir: withDesktop(), env: { ORDEWELL_DESKTOP_SCRIPT_FROM: script } }).status, 0);
      assert.equal(readFileSync(log, 'utf8'), 'desktop.sh \n');
    });

    /** A desktop installer that records the ORDEWELL_INSTALL_DIR it was run with. */
    function desktopEnvScript() {
      const dir = scratch('desktop');
      const log = join(dir, 'env.log');
      const script = join(dir, 'desktop.sh');
      write(script, `#!/bin/sh\necho "ORDEWELL_INSTALL_DIR=\${ORDEWELL_INSTALL_DIR-<unset>}" >> "${log}"\n`);
      return { script, log };
    }

    for (const args of [[], ['--dry-run'], ['--uninstall']]) {
      it(`does not pass the CLI's ORDEWELL_INSTALL_DIR on to desktop.sh (${args.join(' ') || 'install'})`, () => {
        const { script, log } = desktopEnvScript();
        const result = install(['--desktop', ...args], { dir: withDesktop(), env: { ORDEWELL_DESKTOP_SCRIPT_FROM: script } });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(log, 'utf8'), 'ORDEWELL_INSTALL_DIR=<unset>\n');
      });

      it(`passes ORDEWELL_DESKTOP_INSTALL_DIR on as desktop.sh's ORDEWELL_INSTALL_DIR (${args.join(' ') || 'install'})`, () => {
        const { script, log } = desktopEnvScript();
        const where = join(scratch('desktop-prefix'), 'apps');
        const result = install(['--desktop', ...args], { dir: withDesktop(), env: { ORDEWELL_DESKTOP_SCRIPT_FROM: script, ORDEWELL_DESKTOP_INSTALL_DIR: where } });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(log, 'utf8'), `ORDEWELL_INSTALL_DIR=${where}\n`);
        if (args.length === 0) assert.ok(existsSync(join(result.target, 'ordewell')));
      });
    }

    it('plans the desktop app at desktop.sh\'s default, not in the CLI folder, with the real desktop.sh', () => {
      const home = scratch('home');
      const target = join(home, 'cli-only-bin');
      const result = install(['--desktop', '--dry-run', '--version', VERSION], {
        home,
        target,
        env: { ORDEWELL_DESKTOP_SCRIPT_FROM: join(dirname(SH), 'desktop.sh'), ORDEWELL_DESKTOP_FROM: scratch('desktop-release') },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`Install: +${target}/ordewell\n`));
      assert.match(result.stdout, new RegExp(`Install: +${home}/\\.local/bin/ordewell-desktop\n`));
      assert.doesNotMatch(result.stdout, /cli-only-bin\/bin\/ordewell-desktop/);
    });

    it('installs the CLI from a release without the desktop app, says so plainly and exits non-zero (ADR-0065 C10)', () => {
      const { script, log } = desktopScript();
      const result = install(['--desktop'], { env: { ORDEWELL_DESKTOP_SCRIPT_FROM: script } });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(existsSync(join(result.target, 'ordewell')), 'the CLI is installed');
      assert.match(result.stdout, /^Installed ordewell /m);
      assert.match(result.stderr, /The Ordewell desktop app isn't released yet, so --desktop installed nothing more\. The CLI is installed\./);
      assert.ok(!existsSync(log), 'desktop.sh was run');
    });

    it('takes a desktop installer listed as binary, with *, as the release carrying the app', () => {
      const { script, log } = desktopScript();
      const dir = release();
      writeFileSync(join(dir, 'SHA256SUMS'), `${readFileSync(join(dir, 'SHA256SUMS'), 'utf8')}${'0'.repeat(64)} *Ordewell-win-x64.exe\n`);
      const result = install(['--desktop'], { dir, env: { ORDEWELL_DESKTOP_SCRIPT_FROM: script } });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(log));
    });

    it('is not run without --desktop', () => {
      const { script, log } = desktopScript();
      assert.equal(install([], { env: { ORDEWELL_DESKTOP_SCRIPT_FROM: script } }).status, 0);
      assert.ok(!existsSync(log));
    });

    it('does not run when the CLI install stopped on a bad checksum', () => {
      const { script, log } = desktopScript();
      const dir = release();
      write(join(dir, 'ordewell-linux-x64.tar.gz'), 'tampered');
      assert.equal(install(['--desktop'], { dir, env: { ORDEWELL_DESKTOP_SCRIPT_FROM: script } }).status, 1);
      assert.ok(!existsSync(log));
    });

    it('reports a failing desktop installer, with the CLI installed', () => {
      const dir = scratch('desktop');
      write(join(dir, 'desktop.sh'), '#!/bin/sh\nexit 4\n');
      const result = install(['--desktop'], { dir: withDesktop(), env: { ORDEWELL_DESKTOP_SCRIPT_FROM: join(dir, 'desktop.sh') } });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /desktop app installer failed/);
      assert.ok(existsSync(join(result.target, 'ordewell')));
    });

    it('downloads desktop.sh from the repository when not overridden', () => {
      const bad = run(['--desktop', '--dry-run'], { shims: [linux()], env: { ORDEWELL_DESKTOP_SCRIPT_FROM: 'http://example.test/desktop.sh' } });
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /not a file or an https URL/);
      assert.match(readFileSync(SH, 'utf8'), /https:\/\/raw\.githubusercontent\.com\/\$REPO\/main\/scripts\/install\/desktop\.sh/);
    });
  });
});
