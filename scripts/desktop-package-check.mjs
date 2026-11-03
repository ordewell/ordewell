#!/usr/bin/env node
// What a user of the desktop app installs: the installers `npm run
// desktop:package` leaves in packages/desktop/release/, and the unpacked app
// beside them. Nothing else in CI looks inside either, so an installer that was
// never built, a daemon closure left inside app.asar (the utility process
// cannot read it) or a fuse that did not flip is otherwise first found by a
// user. Run after the package step, as package-check.mjs runs after the VSIX's.
//
// The current OS is checked: each release.yml runner proves its own platform.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The installers electron-builder.yml asks for, by name (its artifactName). */
export function expectedInstallers(version, platform = process.platform) {
  const name = (os, arch, ext) => `Ordewell-${version}-${os}-${arch}.${ext}`;
  if (platform === 'darwin') {
    return ['arm64', 'x64'].flatMap((arch) => [name('mac', arch, 'dmg'), name('mac', arch, 'zip')]);
  }
  if (platform === 'win32') return [name('win', 'x64', 'exe')];
  return [name('linux', 'x64', 'AppImage'), name('linux', 'x64', 'deb')];
}

/**
 * Where the unpacked app keeps its resources, per OS. On macOS the arm64 build
 * is the one a runner can launch; the x64 one is checked for its files only.
 */
export function resourcesDirs(releaseDir, platform = process.platform) {
  if (platform === 'darwin') {
    return ['mac-arm64', 'mac'].map((dir) => join(releaseDir, dir, 'Ordewell.app', 'Contents', 'Resources'));
  }
  return [join(releaseDir, platform === 'win32' ? 'win-unpacked' : 'linux-unpacked', 'resources')];
}

/** The daemon's production closure as electron-builder.yml unpacks it. */
export const UNPACKED_ENTRIES = [
  'node_modules/@ordewell/web/dist/server/main.js',
  'node_modules/@ordewell/web/package.json',
  'node_modules/@ordewell/core/package.json',
  'node_modules/hono/package.json',
  'node_modules/ws/package.json',
];

/**
 * What the terminal's pty needs beside the daemon closure (ADR-0062 G11):
 * node-pty's addon as electron-builder.yml rebuilds it for Electron, which
 * build/Release holds and node-pty loads before its shipped prebuilds/. On
 * macOS the spawn-helper it forks through must stay an executable file.
 */
export function ptyEntries(platform = process.platform) {
  const release = 'node_modules/node-pty/build/Release';
  return [`${release}/pty.node`, ...(platform === 'darwin' ? [`${release}/spawn-helper`] : [])];
}

/** ADR-0060 H4, as electron-builder.yml sets them: fuse name -> whether it is on. */
export const EXPECTED_FUSES = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
};

/** The binary whose fuse wire is read: the app bundle on macOS, else the executable. */
export function fuseTarget(releaseDir, platform = process.platform) {
  if (platform === 'darwin') return join(releaseDir, 'mac-arm64', 'Ordewell.app');
  return platform === 'win32'
    ? join(releaseDir, 'win-unpacked', 'Ordewell.exe')
    : join(releaseDir, 'linux-unpacked', 'ordewell-desktop');
}

/** Fuses of `wire` (as getCurrentFuseWire returns it) that differ from EXPECTED_FUSES. */
export function fuseDrift(wire, options) {
  return Object.entries(EXPECTED_FUSES).flatMap(([name, expected]) => {
    // '1' is 0x31, enabled; '0' is 0x30, disabled; 'r' (0x72) is removed.
    const raw = wire[options[name]];
    const actual = raw === 49 ? true : raw === 48 ? false : undefined;
    return actual === expected ? [] : [`${name} is ${actual ?? 'not set'}, expected ${expected}`];
  });
}

/** What a resources directory must hold; returns the failures, none when whole. */
export function checkResources(resources, exists = existsSync, platform = process.platform, modeOf = (path) => statSync(path).mode) {
  const failures = [];
  if (!exists(join(resources, 'app.asar'))) failures.push(`${resources}: app.asar is missing`);
  for (const entry of UNPACKED_ENTRIES) {
    if (!exists(join(resources, 'app.asar.unpacked', entry))) {
      failures.push(`${resources}: app.asar.unpacked/${entry} is missing, so the owned daemon could not start`);
    }
  }
  for (const entry of ptyEntries(platform)) {
    const path = join(resources, 'app.asar.unpacked', entry);
    if (!exists(path)) failures.push(`${resources}: app.asar.unpacked/${entry} is missing, so the terminal could not start (npmRebuild, asarUnpack)`);
    else if (entry.endsWith('spawn-helper') && (modeOf(path) & 0o111) === 0) failures.push(`${resources}: app.asar.unpacked/${entry} is not executable, so no shell could be forked`);
  }
  for (const notice of ['LICENSE', 'NOTICE', 'AUTHORS.md']) {
    if (!exists(join(resources, notice))) failures.push(`${resources}: ${notice} is not shipped (extraResources)`);
  }
  return failures;
}

/** The installers named in `expected` that `listed` lacks or holds empty. */
export function missingInstallers(expected, listed, sizeOf) {
  return expected.filter((file) => !listed.includes(file) || sizeOf(file) === 0);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Start the unpacked daemon with a plain Node, in a throwaway HOME, and see it
 * answer. It proves the closure resolves from where the packaged app puts it;
 * the launch under Electron itself is what the platform's runner cannot show
 * headlessly.
 */
export async function smokeDaemon(entry) {
  const home = mkdtempSync(join(tmpdir(), 'ordewell-desktop-smoke-'));
  const port = await freePort();
  const child = spawn(process.execPath, [entry, '--port', String(port), '--pid-file', join(home, 'daemon.pid')], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, ORDEWELL_NO_VERSION_CHECK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let exited = false;
  child.once('exit', () => { exited = true; });
  try {
    for (let i = 0; i < 100 && !exited; i++) {
      try {
        // Any HTTP answer is a daemon; without its token this one is a 401.
        const response = await fetch(`http://127.0.0.1:${port}/`);
        return { ok: true, status: response.status };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return { ok: false, message: exited ? `the daemon exited early: ${output.trim().split('\n').filter(Boolean).slice(0, 4).join(' | ')}` : 'the daemon never answered' };
  } finally {
    child.kill();
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Load the unpacked node-pty with a plain Node and run a shell through it. The
 * addon is N-API, so the Node that runs this loads what Electron will; it
 * proves the rebuilt binary opens a real pty from where the package keeps it.
 */
export function smokePty(unpackedModules, platform = process.platform) {
  // node-pty turns "app.asar" into "app.asar.unpacked" in its helper's path, as
  // it must when Electron loads it through the archive; loaded from the
  // unpacked directory itself that gives "app.asar.unpacked.unpacked". So the
  // copy sits under a path with neither.
  const scratch = mkdtempSync(join(tmpdir(), 'ordewell-desktop-pty-'));
  try {
    if (existsSync(join(unpackedModules, 'node-pty'))) cpSync(join(unpackedModules, 'node-pty'), join(scratch, 'node-pty'), { recursive: true, dereference: true });
    return runPty(scratch, platform);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function runPty(scratch, platform) {
  const script = `
    const pty = require(process.argv[1]);
    const win = process.platform === 'win32';
    const term = pty.spawn(win ? 'cmd.exe' : '/bin/sh', win ? ['/c', 'echo ow-pty-ok'] : ['-c', 'echo ow-pty-ok'], { cols: 80, rows: 24, cwd: process.cwd() });
    let seen = '';
    term.onData((d) => { seen += d; if (seen.includes('ow-pty-ok')) { process.stdout.write('ok'); process.exit(0); } });
    term.onExit(() => process.exit(seen.includes('ow-pty-ok') ? 0 : 3));
    setTimeout(() => process.exit(4), 8000);
  `;
  const result = spawnSync(process.execPath, ['-e', script, join(scratch, 'node-pty')], { encoding: 'utf8', timeout: 15000 });
  if (result.status === 0 && result.stdout.includes('ok')) return { ok: true };
  return { ok: false, message: `${(result.stderr || result.stdout || `exit ${result.status}`).trim().split('\n').slice(0, 4).join(' | ')} (${platform})` };
}

export async function checkDesktopPackage(root, platform = process.platform) {
  const failures = [];
  const ok = (message) => console.log(`  ok  ${message}`);
  const desktop = join(root, 'packages/desktop');
  const releaseDir = join(desktop, 'release');
  const { version } = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
  if (!existsSync(releaseDir)) {
    return [`no packages/desktop/release; run "npm run desktop:package" first`];
  }

  const listed = readdirSync(releaseDir);
  const missing = missingInstallers(expectedInstallers(version, platform), listed, (file) => statSync(join(releaseDir, file)).size);
  for (const file of missing) failures.push(`release/${file} was not built, or is empty`);
  if (!missing.length) ok(`${expectedInstallers(version, platform).join(', ')}`);

  const dirs = resourcesDirs(releaseDir, platform).filter((dir) => existsSync(dir));
  if (!dirs.length) failures.push(`no unpacked app under release/ for ${platform}`);
  for (const dir of dirs) {
    const before = failures.length;
    failures.push(...checkResources(dir));
    if (failures.length === before) ok(`${dir.slice(releaseDir.length + 1)} carries the asar, the unpacked daemon closure and the notices`);
  }

  const target = fuseTarget(releaseDir, platform);
  if (existsSync(target)) {
    const { getCurrentFuseWire, FuseV1Options } = await import('@electron/fuses');
    const drift = fuseDrift(await getCurrentFuseWire(target), FuseV1Options);
    for (const d of drift) failures.push(`fuses: ${d}`);
    if (!drift.length) ok('Electron fuses are flipped as ADR-0060 H4 lists');
  } else {
    failures.push(`no app binary at ${target.slice(releaseDir.length + 1)} to read fuses from`);
  }

  const entry = dirs.map((dir) => join(dir, 'app.asar.unpacked', UNPACKED_ENTRIES[0])).find((path) => existsSync(path));
  if (entry) {
    const result = await smokeDaemon(entry);
    if (result.ok) ok(`the unpacked daemon answers (HTTP ${result.status} without its token)`);
    else failures.push(`unpacked daemon: ${result.message}`);
  }

  const unpacked = dirs.map((dir) => join(dir, 'app.asar.unpacked', 'node_modules')).find((path) => existsSync(join(path, 'node-pty')));
  if (unpacked) {
    const result = smokePty(unpacked, platform);
    if (result.ok) ok('the unpacked node-pty opens a pty and runs a shell');
    else failures.push(`unpacked node-pty: ${result.message}`);
  }
  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log('\nDesktop app');
  const root = process.cwd();
  const failures = await checkDesktopPackage(root);
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  if (failures.length) {
    console.error(`\ndesktop-package-check: ${failures.length} check(s) failed`);
    process.exit(1);
  }
  console.log('\ndesktop-package-check: the installers and the unpacked app are complete');
}
