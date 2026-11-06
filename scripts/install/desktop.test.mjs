// The one-line desktop installers and the release assets they read (ADR-0063
// H10). desktop.sh runs for real against a fake release directory in a temp
// HOME. The pieces that need another OS than this one's are stood in for by
// shims on PATH (`uname`, `dpkg`, `sudo`), so the Linux flow is exercised on a
// Mac; what cannot be exercised here is skipped, and reported as skipped.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { CLI_FIXED_ASSETS, FIXED_ASSETS, INSTALL_SCRIPT, readInstallers, writeReleaseAssets } from '../desktop-release-assets.mjs';

const SH = resolve('scripts/install/desktop.sh');
const PS1 = resolve('scripts/install/desktop.ps1');
const VERSION = '9.8.7';

const has = (command) => spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
const sandboxes = [];
const scratch = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `o48-${label}-`));
  sandboxes.push(dir);
  return dir;
};
after(() => sandboxes.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const write = (path, text, mode) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  if (mode) chmodSync(path, mode);
};

/** Every installer electron-builder writes for a release, with contents that differ per file. */
const INSTALLERS = [
  `Ordewell-${VERSION}-mac-arm64.dmg`,
  `Ordewell-${VERSION}-mac-x64.dmg`,
  `Ordewell-${VERSION}-mac-arm64.zip`,
  `Ordewell-${VERSION}-mac-x64.zip`,
  `Ordewell-${VERSION}-win-x64.exe`,
  `Ordewell-${VERSION}-linux-x64.AppImage`,
  `Ordewell-${VERSION}-linux-x64.deb`,
];

/** The CLI's four archives and the installer script, which the release also carries (ADR-0065). */
const CLI_ARCHIVES = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map((target) => `ordewell-${VERSION}-${target}.tar.gz`);
const CLI_FIXED = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map((target) => `ordewell-${target}.tar.gz`);

/** Writes the CLI archives and install.sh a release holds next to the desktop installers. */
function writeCli(dir) {
  for (const name of [...CLI_ARCHIVES, 'install.sh']) write(join(dir, name), `contents of ${name}\n`);
}

/** A fake `uname`, so one machine can play every OS and architecture. */
function unameShim(os, machine) {
  const bin = scratch('shim');
  write(join(bin, 'uname'), `#!/bin/sh\ncase "$1" in -s) echo ${os};; -m) echo ${machine};; *) echo ${os};; esac\n`, 0o755);
  return bin;
}

/** The fake AppImage: a shell script that, like a real one, can extract its icon in two sizes, the larger listed last. */
const FAKE_APPIMAGE = `#!/bin/sh
case "$1" in
  --appimage-extract)
    mkdir -p squashfs-root/usr/share/icons/hicolor/16x16/apps squashfs-root/usr/share/icons/hicolor/512x512/apps
    printf 'p' > squashfs-root/usr/share/icons/hicolor/16x16/apps/ordewell.png
    printf 'png' > squashfs-root/usr/share/icons/hicolor/512x512/apps/ordewell.png
    ;;
esac
`;

async function release(contents = {}) {
  const dir = scratch('release');
  for (const name of INSTALLERS) {
    write(join(dir, name), contents[name] ?? (name.endsWith('.AppImage') ? FAKE_APPIMAGE : `contents of ${name}\n`));
  }
  writeCli(dir);
  await writeReleaseAssets(dir);
  return dir;
}

function runSh(args, { env = {}, shims = [] } = {}) {
  const home = env.HOME ?? scratch('home');
  const path = [...shims, process.env.PATH].join(delimiter);
  const result = spawnSync('sh', [SH, ...args], {
    env: { PATH: path, HOME: home, TMPDIR: tmpdir(), ...env },
    encoding: 'utf8',
  });
  return { ...result, home };
}

/** HOME as the script's sh names it: Git Bash's turns a Windows path into its own form, so it prints /tmp/… for C:\…\Temp\…. */
const shHome = (home) => spawnSync('sh', ['-c', 'printf %s "$HOME"'], { env: { ...process.env, HOME: home }, encoding: 'utf8' }).stdout;
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('the release assets script', () => {
  it('reads a fixed name only from an installer that carries a version', () => {
    const { installers, claimed } = readInstallers([...INSTALLERS, 'Ordewell-mac-arm64.dmg', 'latest-mac.yml', `Ordewell-${VERSION}-mac-arm64.dmg.blockmap`]);
    assert.equal(installers.length, INSTALLERS.length);
    assert.deepEqual([...claimed.keys()].sort(), [...FIXED_ASSETS].sort());
    assert.equal(claimed.get('Ordewell-win-x64.exe').name, `Ordewell-${VERSION}-win-x64.exe`);
  });

  it('refuses two versions of one installer, rather than picking one', () => {
    assert.throws(() => readInstallers([`Ordewell-1.0.0-win-x64.exe`, `Ordewell-1.0.1-win-x64.exe`]), /would both become Ordewell-win-x64\.exe/);
  });

  it('writes the five fixed copies and a SHA256SUMS that `sha256sum -c` accepts', async () => {
    const dir = await release();
    for (const name of FIXED_ASSETS) assert.ok(existsSync(join(dir, name)), name);
    const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trimEnd().split('\n');
    const names = sums.map((line) => line.replace(/^[0-9a-f]{64} {2}/, ''));
    for (const name of [...INSTALLERS, ...FIXED_ASSETS, ...CLI_ARCHIVES, ...CLI_FIXED, 'install.sh']) assert.ok(names.includes(name), `${name} is in SHA256SUMS`);
    assert.ok(!names.includes('SHA256SUMS'));
    assert.deepEqual(names, [...names].sort());
    const hash = (name) => sums.find((line) => line.endsWith(`  ${name}`)).slice(0, 64);
    assert.equal(hash('Ordewell-win-x64.exe'), hash(`Ordewell-${VERSION}-win-x64.exe`));
    assert.notEqual(hash('Ordewell-win-x64.exe'), hash('Ordewell-mac-arm64.dmg'));
    if (has('shasum')) {
      const check = spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: dir, encoding: 'utf8' });
      assert.equal(check.status, 0, check.stdout + check.stderr);
    }
  });

  it('names the four CLI fixed copies and the installer script', () => {
    assert.deepEqual([...CLI_FIXED_ASSETS].sort(), [...CLI_FIXED].sort());
    assert.equal(INSTALL_SCRIPT, 'install.sh');
  });

  it('reads the CLI archives, versioned to fixed, and leaves a fixed name or an unknown platform alone', () => {
    const { installers, claimed } = readInstallers([...CLI_ARCHIVES, ...CLI_FIXED, 'ordewell-9.8.7-win32-x64.tar.gz', 'ordewell-9.8.7-linux-x64.zip']);
    assert.equal(installers.length, CLI_ARCHIVES.length);
    assert.deepEqual([...claimed.keys()].sort(), [...CLI_FIXED].sort());
    assert.equal(claimed.get('ordewell-linux-arm64.tar.gz').name, `ordewell-${VERSION}-linux-arm64.tar.gz`);
    assert.equal(claimed.get('ordewell-linux-arm64.tar.gz').version, VERSION);
  });

  it('refuses two versions of one CLI archive', () => {
    assert.throws(() => readInstallers(['ordewell-1.0.0-linux-x64.tar.gz', 'ordewell-1.0.1-linux-x64.tar.gz']), /would both become ordewell-linux-x64\.tar\.gz/);
  });

  it('writes the four CLI fixed copies byte for byte, and lists install.sh', async () => {
    const dir = await release();
    for (const [i, name] of CLI_FIXED.entries()) {
      assert.equal(readFileSync(join(dir, name), 'utf8'), readFileSync(join(dir, CLI_ARCHIVES[i]), 'utf8'));
    }
    const names = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trimEnd().split('\n').map((line) => line.replace(/^[0-9a-f]{64} {2}/, ''));
    assert.equal(names.length, INSTALLERS.length + FIXED_ASSETS.length + CLI_ARCHIVES.length + CLI_FIXED.length + 1);
  });

  it('refuses a release without a CLI archive, without install.sh, or with a CLI version that differs', async () => {
    const noArchive = await release();
    rmSync(join(noArchive, `ordewell-${VERSION}-linux-arm64.tar.gz`));
    await assert.rejects(writeReleaseAssets(noArchive), /missing .*ordewell-linux-arm64\.tar\.gz/);
    const noScript = await release();
    rmSync(join(noScript, 'install.sh'));
    await assert.rejects(writeReleaseAssets(noScript), /missing .*install\.sh/);

    const mixed = await release();
    rmSync(join(mixed, `ordewell-${VERSION}-linux-x64.tar.gz`));
    write(join(mixed, 'ordewell-1.0.0-linux-x64.tar.gz'), 'older');
    await assert.rejects(writeReleaseAssets(mixed), /disagree on the version: .*(9\.8\.7.*1\.0\.0|1\.0\.0.*9\.8\.7)/);
  });

  it('lets --partial skip the CLI and install.sh, and still lists what a local folder has', async () => {
    const dir = scratch('cli-only');
    write(join(dir, `ordewell-${VERSION}-linux-x64.tar.gz`), 'tar');
    write(join(dir, 'install.sh'), 'sh');
    const partial = await writeReleaseAssets(dir, { partial: true });
    assert.deepEqual(partial.fixed, ['ordewell-linux-x64.tar.gz']);
    assert.deepEqual(partial.sums, ['install.sh', 'ordewell-9.8.7-linux-x64.tar.gz', 'ordewell-linux-x64.tar.gz']);
    await assert.rejects(writeReleaseAssets(dir), /the release is missing/);
  });

  it('does not touch the update feeds', async () => {
    const dir = await release();
    write(join(dir, 'latest-mac.yml'), 'feed\n');
    await writeReleaseAssets(dir);
    assert.equal(readFileSync(join(dir, 'latest-mac.yml'), 'utf8'), 'feed\n');
    assert.ok(!readFileSync(join(dir, 'SHA256SUMS'), 'utf8').includes('latest-mac.yml'));
  });

  it('refuses an incomplete or mixed release unless it is partial', async () => {
    const dir = scratch('partial');
    write(join(dir, `Ordewell-${VERSION}-linux-x64.deb`), 'deb');
    await assert.rejects(writeReleaseAssets(dir), /missing Ordewell-mac-arm64\.dmg/);
    const partial = await writeReleaseAssets(dir, { partial: true });
    assert.deepEqual(partial.fixed, ['Ordewell-linux-x64.deb']);

    const mixed = await release();
    write(join(mixed, 'Ordewell-1.0.0-win-x64.exe'), 'older');
    rmSync(join(mixed, `Ordewell-${VERSION}-win-x64.exe`));
    await assert.rejects(writeReleaseAssets(mixed), /disagree on the version/);
  });

  /** A Release with the switch off: the CLI archives and install.sh, and no desktop installer (ADR-0065 C10). */
  const cliOnly = () => {
    const dir = scratch('cli-release');
    writeCli(dir);
    return dir;
  };
  const listed = (dir) => readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trimEnd().split('\n').map((line) => line.replace(/^[0-9a-f]{64} {2}/, ''));

  it('without the desktop app, writes the CLI fixed copies and a SHA256SUMS over exactly the CLI files', async () => {
    const dir = cliOnly();
    const written = await writeReleaseAssets(dir, { withoutDesktop: true });
    assert.deepEqual(written.fixed, [...CLI_FIXED].sort());
    assert.deepEqual(listed(dir), [...CLI_ARCHIVES, ...CLI_FIXED, 'install.sh'].sort());
    for (const [i, name] of CLI_FIXED.entries()) {
      assert.equal(readFileSync(join(dir, name), 'utf8'), readFileSync(join(dir, CLI_ARCHIVES[i]), 'utf8'));
    }
    for (const name of FIXED_ASSETS) assert.ok(!existsSync(join(dir, name)), `${name} was written`);
    if (has('shasum')) {
      const check = spawnSync('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: dir, encoding: 'utf8' });
      assert.equal(check.status, 0, check.stdout + check.stderr);
    }
  });

  it('without the desktop app, leaves out a desktop installer the folder happens to hold', async () => {
    const dir = await release();
    rmSync(join(dir, 'SHA256SUMS'));
    for (const name of FIXED_ASSETS) rmSync(join(dir, name));
    await writeReleaseAssets(dir, { withoutDesktop: true });
    assert.deepEqual(listed(dir), [...CLI_ARCHIVES, ...CLI_FIXED, 'install.sh'].sort());
    for (const name of FIXED_ASSETS) assert.ok(!existsSync(join(dir, name)), `${name} was written`);
  });

  it('without the desktop app, still refuses a missing CLI archive, a missing install.sh or a second version', async () => {
    const noArchive = cliOnly();
    rmSync(join(noArchive, `ordewell-${VERSION}-darwin-x64.tar.gz`));
    await assert.rejects(writeReleaseAssets(noArchive, { withoutDesktop: true }), /the release is missing ordewell-darwin-x64\.tar\.gz$/);
    const noScript = cliOnly();
    rmSync(join(noScript, 'install.sh'));
    await assert.rejects(writeReleaseAssets(noScript, { withoutDesktop: true }), /the release is missing install\.sh$/);
    const mixed = cliOnly();
    rmSync(join(mixed, `ordewell-${VERSION}-linux-x64.tar.gz`));
    write(join(mixed, 'ordewell-1.0.0-linux-x64.tar.gz'), 'older');
    await assert.rejects(writeReleaseAssets(mixed, { withoutDesktop: true }), /disagree on the version/);
    await assert.rejects(writeReleaseAssets(scratch('empty'), { withoutDesktop: true }), /no ordewell-<version>-<os>-<arch>\.tar\.gz/);
  });

  it('is --without-desktop on the command line, and the default still needs the desktop installers', () => {
    const dir = cliOnly();
    const refused = spawnSync('node', ['scripts/desktop-release-assets.mjs', dir], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /missing Ordewell-mac-arm64\.dmg/);
    const run = spawnSync('node', ['scripts/desktop-release-assets.mjs', dir, '--without-desktop'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(listed(dir), [...CLI_ARCHIVES, ...CLI_FIXED, 'install.sh'].sort());
    const unknown = spawnSync('node', ['scripts/desktop-release-assets.mjs', dir, '--without-dekstop'], { encoding: 'utf8' });
    assert.equal(unknown.status, 2);
  });

  it('is the CLI the workflow runs', async () => {
    const dir = await release();
    rmSync(join(dir, 'SHA256SUMS'));
    const run = spawnSync('node', ['scripts/desktop-release-assets.mjs', dir], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(existsSync(join(dir, 'SHA256SUMS')));
    assert.equal(spawnSync('node', ['scripts/desktop-release-assets.mjs'], { encoding: 'utf8' }).status, 2);
  });
});

describe('desktop.sh', () => {
  it('is valid POSIX sh, and shellcheck (when installed) has no complaint', (t) => {
    assert.equal(spawnSync('sh', ['-n', SH]).status, 0);
    if (has('dash')) assert.equal(spawnSync('dash', ['-n', SH]).status, 0);
    if (!has('shellcheck')) return t.skip('shellcheck is not installed');
    const lint = spawnSync('shellcheck', ['--shell=sh', SH], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stdout);
  });

  it('never touches an OS protection', () => {
    for (const path of [SH, PS1]) {
      const code = readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
      assert.doesNotMatch(code, /xattr|com\.apple\.quarantine|spctl|Unblock-File|Set-MpPreference|Zone\.Identifier/i, path);
    }
  });

  it('prints its help and rejects what it does not know', () => {
    const help = runSh(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--version X\.Y\.Z/);
    assert.match(help.stdout, /ORDEWELL_DESKTOP_FROM/);
    const bad = runSh(['--frobnicate']);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /unknown option/);
  });

  it('refuses a version that is not a version, before it reaches a URL', () => {
    for (const version of ['latest', '1.2', '1.2.3/../../x', '1.2.3;rm', '$(id).1.1', '..1.1']) {
      const run = runSh(['--dry-run', '--version', version]);
      assert.notEqual(run.status, 0, version);
      assert.match(run.stderr, /not a version/, version);
    }
  });

  describe('chooses the asset', () => {
    for (const [os, machine, expected] of [
      ['Darwin', 'arm64', 'Ordewell-mac-arm64.dmg'],
      ['Darwin', 'x86_64', 'Ordewell-mac-x64.dmg'],
      ['Linux', 'x86_64', 'Ordewell-linux-x64.AppImage'],
      ['Linux', 'amd64', 'Ordewell-linux-x64.AppImage'],
    ]) {
      it(`${os} ${machine} gets ${expected}`, () => {
        // sysctl would tell an Intel shim apart from Rosetta on a real Apple-silicon Mac.
        const sysctl = scratch('sysctl');
        write(join(sysctl, 'sysctl'), '#!/bin/sh\necho 0\n', 0o755);
        const run = runSh(['--dry-run'], { shims: [unameShim(os, machine), sysctl] });
        assert.equal(run.status, 0, run.stderr);
        assert.match(run.stdout, new RegExp(`File:\\s+${expected.replace('.', '\\.')}`));
        assert.match(run.stdout, new RegExp(`Download:\\s+https://github\\.com/ordewell/ordewell/releases/latest/download/${expected.replace('.', '\\.')}`));
        assert.match(run.stdout, /Checksums:\s+https:\/\/github\.com\/ordewell\/ordewell\/releases\/latest\/download\/SHA256SUMS/);
      });
    }

    it('an Intel shell under Rosetta on Apple silicon gets the native build', () => {
      const shims = scratch('rosetta');
      write(join(shims, 'sysctl'), '#!/bin/sh\necho 1\n', 0o755);
      const run = runSh(['--dry-run'], { shims: [unameShim('Darwin', 'x86_64'), shims] });
      assert.match(run.stdout, /Ordewell-mac-arm64\.dmg/);
    });

    it('--deb picks the .deb on Linux and is an error on a Mac', () => {
      const linux = runSh(['--dry-run', '--deb'], { shims: [unameShim('Linux', 'x86_64')] });
      assert.match(linux.stdout, /File:\s+Ordewell-linux-x64\.deb/);
      const mac = runSh(['--dry-run', '--deb'], { shims: [unameShim('Darwin', 'arm64')] });
      assert.notEqual(mac.status, 0);
      assert.match(mac.stderr, /--deb is for Linux/);
    });

    it('stops where there is no build: Linux arm64, 32-bit, other systems', () => {
      assert.match(runSh(['--dry-run'], { shims: [unameShim('Linux', 'aarch64')] }).stderr, /x64 only/);
      assert.match(runSh(['--dry-run'], { shims: [unameShim('Linux', 'i686')] }).stderr, /no Ordewell desktop build/);
      assert.match(runSh(['--dry-run'], { shims: [unameShim('FreeBSD', 'x86_64')] }).stderr, /desktop\.ps1/);
    });

    it('uses the tagged release for --version and ORDEWELL_VERSION, with or without a v', () => {
      const shims = [unameShim('Linux', 'x86_64')];
      const flag = runSh(['--dry-run', '--version', '1.2.3'], { shims });
      assert.match(flag.stdout, /releases\/download\/v1\.2\.3\/Ordewell-linux-x64\.AppImage/);
      const env = runSh(['--dry-run'], { shims, env: { ORDEWELL_VERSION: 'v1.2.3' } });
      assert.match(env.stdout, /releases\/download\/v1\.2\.3\/SHA256SUMS/);
    });
  });

  describe('on Linux (the OS faked, the install real)', () => {
    const linux = () => [unameShim('Linux', 'x86_64')];
    const install = (dir, home, extra = {}) => runSh([], { shims: linux(), env: { HOME: home, ORDEWELL_DESKTOP_FROM: dir, ...extra } });

    it('installs the AppImage, a launcher entry and an icon, then upgrades in place, then uninstalls', async () => {
      const home = scratch('home');
      const first = install(await release(), home);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, new RegExp(`^Installed Ordewell ${literal(VERSION)} to ${literal(shHome(home))}/\\.local/bin/ordewell-desktop$`, 'm'));
      const bin = join(home, '.local/bin/ordewell-desktop');
      assert.equal(readFileSync(bin, 'utf8'), FAKE_APPIMAGE);
      assert.ok(spawnSync('test', ['-x', bin]).status === 0, 'the AppImage is executable');
      const entry = readFileSync(join(home, '.local/share/applications/ordewell-desktop.desktop'), 'utf8');
      assert.match(entry, /^Exec=.*\/\.local\/bin\/ordewell-desktop %U$/m);
      assert.match(entry, /^Icon=ordewell-desktop$/m);
      assert.equal(readFileSync(join(home, '.local/share/icons/hicolor/512x512/apps/ordewell-desktop.png'), 'utf8'), 'png');
      assert.deepEqual(readdirSync(join(home, '.local/bin')), ['ordewell-desktop'], 'no temporary file is left beside it');

      const newer = await release({ [`Ordewell-${VERSION}-linux-x64.AppImage`]: `${FAKE_APPIMAGE}# newer\n` });
      const upgrade = install(newer, home);
      assert.equal(upgrade.status, 0, upgrade.stderr);
      assert.match(readFileSync(bin, 'utf8'), /# newer/);

      const uninstall = runSh(['--uninstall'], { shims: linux(), env: { HOME: home } });
      assert.equal(uninstall.status, 0, uninstall.stderr);
      assert.ok(!existsSync(bin));
      assert.ok(!existsSync(join(home, '.local/share/applications/ordewell-desktop.desktop')));
      assert.ok(!existsSync(join(home, '.local/share/icons/hicolor/512x512/apps/ordewell-desktop.png')));
      assert.match(uninstall.stdout, /left in place/);

      const again = runSh(['--uninstall'], { shims: linux(), env: { HOME: home } });
      assert.equal(again.status, 0);
      assert.match(again.stdout, /nothing was removed/);
    });

    it('puts everything under ORDEWELL_INSTALL_DIR and leaves HOME alone', async () => {
      const home = scratch('home');
      const prefix = scratch('prefix');
      const run = install(await release(), home, { ORDEWELL_INSTALL_DIR: prefix });
      assert.equal(run.status, 0, run.stderr);
      assert.ok(existsSync(join(prefix, 'bin/ordewell-desktop')));
      assert.deepEqual(readdirSync(home), []);
      assert.equal(runSh(['--uninstall'], { shims: linux(), env: { HOME: home, ORDEWELL_INSTALL_DIR: prefix } }).status, 0);
      assert.ok(!existsSync(join(prefix, 'bin/ordewell-desktop')));
    });

    it('stops on a checksum mismatch and installs nothing', async () => {
      const dir = await release();
      write(join(dir, 'Ordewell-linux-x64.AppImage'), `${FAKE_APPIMAGE}# tampered\n`);
      const home = scratch('home');
      const run = install(dir, home);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /does not match SHA256SUMS/);
      assert.match(run.stderr, /Nothing was installed/);
      assert.ok(!existsSync(join(home, '.local')));
    });

    it('does not leave a previous install changed by a failed upgrade', async () => {
      const home = scratch('home');
      assert.equal(install(await release(), home).status, 0);
      const bad = await release();
      write(join(bad, 'Ordewell-linux-x64.AppImage'), 'tampered');
      assert.equal(install(bad, home).status, 1);
      assert.equal(readFileSync(join(home, '.local/bin/ordewell-desktop'), 'utf8'), FAKE_APPIMAGE);
    });

    it('stops when SHA256SUMS does not list the file, or is missing', async () => {
      const dir = await release();
      writeFileSync(join(dir, 'SHA256SUMS'), `${'0'.repeat(64)}  Ordewell-something-else.AppImage\n`);
      const home = scratch('home');
      const unlisted = install(dir, home);
      assert.equal(unlisted.status, 1);
      assert.match(unlisted.stderr, /no checksum for Ordewell-linux-x64\.AppImage/);
      rmSync(join(dir, 'SHA256SUMS'));
      const missing = install(dir, home);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /no SHA256SUMS/);
      assert.ok(!existsSync(join(home, '.local')));
    });

    it('takes a SHA256SUMS whose hash is upper case or marked binary with *', async () => {
      const dir = await release();
      const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').replace(/^([0-9a-f]{64}) {2}(Ordewell-linux-x64\.AppImage)$/m, (_, hash, name) => `${hash.toUpperCase()} *${name}`);
      writeFileSync(join(dir, 'SHA256SUMS'), sums);
      const run = install(dir, scratch('home'));
      assert.equal(run.status, 0, run.stderr);
    });

    it('refuses an ORDEWELL_DESKTOP_FROM that is not a directory', () => {
      assert.match(runSh([], { shims: linux(), env: { ORDEWELL_DESKTOP_FROM: join(tmpdir(), 'o48-nope') } }).stderr, /not a directory/);
    });

    it('--deb installs the checked .deb through apt with sudo, and --deb --uninstall removes the package', async () => {
      const shims = scratch('tools');
      const log = join(shims, 'calls.log');
      for (const tool of ['sudo', 'apt-get', 'dpkg']) {
        const body =
          tool === 'sudo'
            ? `#!/bin/sh\necho "sudo $*" >> "${log}"\nexec "$@"\n`
            : tool === 'dpkg'
              ? `#!/bin/sh\nif [ "$1" = -S ]; then echo "ordewell-desktop: /usr/bin/ordewell-desktop"; exit 0; fi\necho "dpkg $*" >> "${log}"\n`
              : `#!/bin/sh\necho "apt-get $*" >> "${log}"\n`;
        write(join(shims, tool), body, 0o755);
      }
      // A non-root user is what the sudo shim stands in for; as root there is no sudo call.
      const asRoot = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim() === '0';
      const home = scratch('home');
      const run = runSh(['--deb'], { shims: [...linux(), shims], env: { HOME: home, ORDEWELL_DESKTOP_FROM: await release() } });
      assert.equal(run.status, 0, run.stderr);
      const calls = readFileSync(log, 'utf8');
      assert.match(calls, new RegExp(`${asRoot ? '^' : 'sudo '}apt-get install -y .*Ordewell-linux-x64\\.deb`, 'm'));
      assert.ok(!existsSync(join(home, '.local')), 'the .deb path writes nothing under HOME');

      const removed = runSh(['--deb', '--uninstall'], { shims: [...linux(), shims], env: { HOME: home } });
      assert.equal(removed.status, 0, removed.stderr);
      assert.match(readFileSync(log, 'utf8'), /apt-get remove -y ordewell-desktop/);
    });

    it('--deb with a bad checksum never reaches apt', async () => {
      const shims = scratch('tools');
      const log = join(shims, 'calls.log');
      write(join(shims, 'apt-get'), `#!/bin/sh\necho "apt-get $*" >> "${log}"\n`, 0o755);
      write(join(shims, 'dpkg'), '#!/bin/sh\nexit 0\n', 0o755);
      const dir = await release();
      write(join(dir, 'Ordewell-linux-x64.deb'), 'tampered');
      const run = runSh(['--deb'], { shims: [...linux(), shims], env: { ORDEWELL_DESKTOP_FROM: dir } });
      assert.equal(run.status, 1);
      assert.ok(!existsSync(log));
    });
  });

  describe('on macOS (a real dmg, mounted with hdiutil)', () => {
    const onMac = process.platform === 'darwin' && has('hdiutil');

    /** A dmg holding a minimal Ordewell.app, shaped like the packaged one where it counts: the bundle id. */
    function dmgWith(marker) {
      const staging = scratch('app');
      write(join(staging, 'Ordewell.app/Contents/Info.plist'), `<plist><dict><key>CFBundleIdentifier</key><string>ai.ordewell.desktop</string></dict></plist>\n`);
      write(join(staging, 'Ordewell.app/Contents/MacOS/Ordewell'), `#!/bin/sh\n# ${marker}\n`, 0o755);
      const out = join(scratch('dmg'), 'in.dmg');
      const made = spawnSync('hdiutil', ['create', '-quiet', '-volname', 'Ordewell', '-srcfolder', staging, '-format', 'UDZO', '-ov', out], { encoding: 'utf8' });
      assert.equal(made.status, 0, made.stderr);
      return readFileSync(out);
    }

    async function macRelease(marker) {
      const dir = scratch('release');
      const dmg = dmgWith(marker);
      for (const name of INSTALLERS) write(join(dir, name), name.endsWith('.dmg') ? dmg : `contents of ${name}\n`);
      writeCli(dir);
      await writeReleaseAssets(dir);
      return dir;
    }

    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

    it('copies Ordewell.app into ORDEWELL_INSTALL_DIR, upgrades it, unmounts, and uninstalls', { skip: onMac ? false : 'needs macOS (hdiutil)' }, async () => {
      const target = scratch('apps');
      const home = scratch('home');
      const env = { HOME: home, ORDEWELL_INSTALL_DIR: target };
      const first = runSh([], { env: { ...env, ORDEWELL_DESKTOP_FROM: await macRelease('first') } });
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, new RegExp(`Installed Ordewell ${VERSION} to ${target}/Ordewell\\.app`));
      assert.match(first.stdout, /did not add or remove any quarantine attribute/);
      assert.match(readFileSync(join(target, 'Ordewell.app/Contents/MacOS/Ordewell'), 'utf8'), /first/);
      assert.deepEqual(readdirSync(target), ['Ordewell.app'], 'no staging or backup folder is left');
      assert.ok(!spawnSync('hdiutil', ['info'], { encoding: 'utf8' }).stdout.includes('o48-'), 'the dmg is detached');

      const second = runSh([], { env: { ...env, ORDEWELL_DESKTOP_FROM: await macRelease('second') } });
      assert.equal(second.status, 0, second.stderr);
      assert.match(readFileSync(join(target, 'Ordewell.app/Contents/MacOS/Ordewell'), 'utf8'), /second/);
      assert.deepEqual(readdirSync(target), ['Ordewell.app']);

      const removed = runSh(['--uninstall'], { env });
      assert.equal(removed.status, 0, removed.stderr);
      assert.deepEqual(readdirSync(target), []);
      assert.match(removed.stdout, /left in place/);
      assert.match(runSh(['--uninstall'], { env }).stdout, /nothing was removed/);
    });

    it('stops on a checksum mismatch without mounting or installing', { skip: onMac ? false : 'needs macOS (hdiutil)' }, async () => {
      const dir = await macRelease('x');
      write(join(dir, `Ordewell-mac-${arch}.dmg`), 'tampered');
      const target = scratch('apps');
      const run = runSh([], { env: { ORDEWELL_INSTALL_DIR: target, ORDEWELL_DESKTOP_FROM: dir } });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /does not match SHA256SUMS/);
      assert.deepEqual(readdirSync(target), []);
    });

    it('does not replace, or remove, an Ordewell.app that is not Ordewell\'s', { skip: onMac ? false : 'needs macOS (hdiutil)' }, async () => {
      const target = scratch('apps');
      write(join(target, 'Ordewell.app/Contents/Info.plist'), '<plist>someone else</plist>');
      const env = { ORDEWELL_INSTALL_DIR: target };
      const install = runSh([], { env: { ...env, ORDEWELL_DESKTOP_FROM: await macRelease('x') } });
      assert.equal(install.status, 1);
      assert.match(install.stderr, /is not Ordewell's/);
      const removal = runSh(['--uninstall'], { env });
      assert.match(removal.stderr, /Left .* alone/);
      assert.ok(existsSync(join(target, 'Ordewell.app/Contents/Info.plist')));
    });

  });
});

describe('desktop.ps1', () => {
  const hasPwsh = has('pwsh');
  const skip = hasPwsh ? false : 'pwsh is not installed';
  const pwsh = (args, env = {}) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', PS1, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });

  it('parses without errors', { skip }, () => {
    const parse = spawnSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-Command', `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${PS1}', [ref]$null, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { $_.ToString() }; exit 1 }`],
      { encoding: 'utf8' },
    );
    assert.equal(parse.status, 0, parse.stdout + parse.stderr);
  });

  it('prints its help, and a dry run names the file and the stable URL', { skip }, () => {
    assert.match(pwsh(['-Help']).stdout, /-Version X\.Y\.Z/);
    const dry = pwsh(['-DryRun', '-Version', '1.2.3']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /File:\s+Ordewell-win-x64\.exe/);
    assert.match(dry.stdout, /releases\/download\/v1\.2\.3\/Ordewell-win-x64\.exe/);
    assert.match(pwsh(['-DryRun']).stdout, /releases\/latest\/download\/SHA256SUMS/);
  });

  it('rejects a version that is not one', { skip }, () => {
    const run = pwsh(['-DryRun', '-Version', '1.2.3/../x']);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr + run.stdout, /not a version/);
  });

  it('stops on a checksum mismatch before it runs anything', { skip }, async () => {
    const dir = await release();
    write(join(dir, 'Ordewell-win-x64.exe'), 'tampered');
    const run = pwsh([], { ORDEWELL_DESKTOP_FROM: dir, ORDEWELL_INSTALL_DIR: scratch('install') });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr + run.stdout, /does not match SHA256SUMS/);
  });

  it('stops when SHA256SUMS does not list the installer', { skip }, async () => {
    const dir = await release();
    writeFileSync(join(dir, 'SHA256SUMS'), `${'0'.repeat(64)}  Ordewell-other.exe\n`);
    const run = pwsh([], { ORDEWELL_DESKTOP_FROM: dir });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr + run.stdout, /no checksum for Ordewell-win-x64\.exe/);
  });

  it('works under `| iex`: no param block, no exit', () => {
    const text = readFileSync(PS1, 'utf8');
    const code = text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    assert.doesNotMatch(code, /^param\(/m);
    assert.doesNotMatch(code, /\bexit\b\s*\d?/);
    assert.match(code, /\/S \/currentuser/);
    assert.match(code, /\/D=/);
  });
});
