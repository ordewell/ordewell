#!/usr/bin/env node
// What a user of the desktop app installs: the installers `npm run
// desktop:package` leaves in packages/desktop/release/, and the unpacked app
// beside them. Nothing else in CI looks inside either, so an installer that was
// never built, a daemon closure left inside app.asar (the utility process
// cannot read it) or a fuse that did not flip is otherwise first found by a
// user. Run after the package step, as package-check.mjs runs after the VSIX's.
//
// The current OS is checked: each runner of desktop-build.yml proves its own platform.
// Whether the build was signed is read from release/signing.json, which
// scripts/package.mjs writes: a signed build has its signatures verified, and
// every build has its baked update gate held to what it was (ADR-0063 H9).
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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

/** ADR-0063 H4, as electron-builder.yml sets them: fuse name -> whether it is on. */
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

/**
 * The CPU architectures a native binary holds, read from its header so the
 * same check runs on every OS (`file` and `lipo` exist on one each): Mach-O
 * (thin or fat), ELF and PE. Names are electron-builder's: arm64, x64. An
 * unrecognised file gives none.
 */
export function binaryArchs(buffer) {
  const name = (machine, table) => table[machine] ?? `unknown(${machine.toString(16)})`;
  const macho = { 0x0100000c: 'arm64', 0x01000007: 'x64' };
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0xcafebabe) {
    // Fat header, big-endian: a count, then 20-byte entries led by the cputype.
    const count = buffer.readUInt32BE(4);
    return Array.from({ length: Math.min(count, 8) }, (_, i) => 8 + i * 20)
      .filter((at) => at + 4 <= buffer.length)
      .map((at) => name(buffer.readUInt32BE(at), macho));
  }
  if (buffer.length >= 8 && buffer.readUInt32LE(0) === 0xfeedfacf) return [name(buffer.readUInt32LE(4), macho)];
  if (buffer.length >= 20 && buffer.readUInt32BE(0) === 0x7f454c46) return [name(buffer.readUInt16LE(18), { 0x3e: 'x64', 0xb7: 'arm64' })];
  if (buffer.length >= 0x40 && buffer.readUInt16LE(0) === 0x5a4d) {
    const pe = buffer.readUInt32LE(0x3c);
    if (pe + 6 <= buffer.length && buffer.readUInt32LE(pe) === 0x00004550) {
      return [name(buffer.readUInt16LE(pe + 4), { 0x8664: 'x64', 0xaa64: 'arm64' })];
    }
  }
  return [];
}

/**
 * The architecture the native binaries under `resources` must be. Only macOS
 * builds two: electron-builder lays them out as mac-arm64/ and mac/ (x64), and
 * the arm64 runner has to rebuild node-pty for the second. Every other target
 * is x64.
 */
export function expectedArch(resources, platform = process.platform) {
  if (platform !== 'darwin') return 'x64';
  // release/<dir>/Ordewell.app/Contents/Resources
  return basename(dirname(dirname(dirname(resources)))) === 'mac-arm64' ? 'arm64' : 'x64';
}

/**
 * Whether an unpacked closure file is where Node would find it from the
 * daemon. electron-builder hoists a dependency to the top node_modules or, when
 * versions of it differ across the tree, nests it under the package that needs
 * it (@ordewell/web/node_modules/hono): either resolves from web's dist, and
 * which one a runner gets follows its npm tree, not this package.
 */
function unpackedAt(resources, entry, exists) {
  const unpacked = join(resources, 'app.asar.unpacked');
  if (exists(join(unpacked, entry))) return true;
  const bare = /^node_modules\/([^@/][^/]*)\/package\.json$/.exec(entry);
  return Boolean(bare) && ['web', 'core'].some((owner) => exists(join(unpacked, 'node_modules/@ordewell', owner, 'node_modules', bare[1], 'package.json')));
}

/** What a resources directory must hold; returns the failures, none when whole. */
export function checkResources(resources, exists = existsSync, platform = process.platform, modeOf = (path) => statSync(path).mode, archsOf = (path) => binaryArchs(readFileSync(path))) {
  const failures = [];
  if (!exists(join(resources, 'app.asar'))) failures.push(`${resources}: app.asar is missing`);
  for (const entry of UNPACKED_ENTRIES) {
    if (!unpackedAt(resources, entry, exists)) {
      failures.push(`${resources}: app.asar.unpacked/${entry} is missing, so the owned daemon could not start`);
    }
  }
  for (const entry of ptyEntries(platform)) {
    const path = join(resources, 'app.asar.unpacked', entry);
    if (!exists(path)) failures.push(`${resources}: app.asar.unpacked/${entry} is missing, so the terminal could not start (npmRebuild, asarUnpack)`);
    else {
      if (entry.endsWith('spawn-helper') && (modeOf(path) & 0o111) === 0) failures.push(`${resources}: app.asar.unpacked/${entry} is not executable, so no shell could be forked`);
      // An x64 build made on an arm64 Mac that kept the host's binary would
      // pass every check above and fail to start the terminal on an Intel Mac.
      const want = expectedArch(resources, platform);
      const have = archsOf(path);
      if (!have.includes(want)) failures.push(`${resources}: app.asar.unpacked/${entry} holds ${have.join(', ') || 'no recognisable machine code'}, expected ${want} (npmRebuild must rebuild node-pty for each architecture)`);
    }
  }
  for (const notice of ['LICENSE', 'NOTICE', 'AUTHORS.md', 'THIRD-PARTY-NOTICES.md']) {
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
    if (!exited) {
      child.kill();
      // The daemon still writes under HOME while it shuts down: removing the
      // directory out from under it can leave a file behind (ENOTEMPTY), so
      // wait for it to go first.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

/**
 * A file's contents out of an asar archive, or null. The layout is
 * @electron/asar's: a pickled header whose JSON (at byte 16, its length at
 * byte 12) maps each path to a size and an offset into the data that follows
 * the header (whose size is at byte 4). Read here so the check needs no
 * dependency to open the app's own code.
 */
export function asarFile(buffer, path) {
  if (buffer.length < 16) return null;
  const headerSize = buffer.readUInt32LE(4);
  let node = JSON.parse(buffer.subarray(16, 16 + buffer.readUInt32LE(12)).toString('utf8'));
  for (const part of path.split('/')) {
    node = node?.files?.[part];
    if (!node) return null;
  }
  if (node.unpacked || typeof node.offset !== 'string') return null;
  const start = 8 + headerSize + Number(node.offset);
  return buffer.subarray(start, start + node.size).toString('utf8');
}

/**
 * The update gate tsup baked into main's bundle (src/main/updater.ts), or null
 * when the bundle still asks at run time, as one not built through
 * packages/desktop/tsup.config.ts does. esbuild may suffix the name to keep it
 * unique.
 */
export function bakedAutoUpdate(source) {
  const match = /\bAUTO_UPDATE_ENABLED\d* = (true|false)\b/.exec(source ?? '');
  return match ? match[1] === 'true' : null;
}

/**
 * What is wrong between release/signing.json and the gate the app carries
 * (ADR-0063 H9): updates on only where that platform's build is signed, on
 * macOS signed and notarized, and never on Linux.
 */
export function signingProblems(manifest, baked, platform = process.platform) {
  if (!manifest) return ['release/signing.json is missing: package with "npm run desktop:package", which records how the build was signed'];
  if (manifest.platform !== platform) return [`release/signing.json describes a ${manifest.platform} build, not ${platform}`];
  const problems = [];
  if (baked === null) problems.push('the update gate is not baked into dist/main/index.js, so main was not built by packages/desktop/tsup.config.ts');
  else if (baked !== manifest.autoUpdate) problems.push(`the app was built with updates ${baked ? 'on' : 'off'}, but release/signing.json says ${manifest.autoUpdate ? 'on' : 'off'}`);
  if (manifest.autoUpdate) {
    if (platform === 'linux') problems.push('updates are on for Linux, whose builds are never signed');
    else if (!manifest.signing) problems.push('updates are on but the build is not signed');
    else if (platform === 'darwin' && !manifest.notarized) problems.push('updates are on but the macOS build is not notarized');
  }
  return problems;
}

/**
 * The names an app-update.yml lists, from the `publisherName:` key: a list
 * (`- name`) when electron-builder wrote several, one scalar otherwise. A value
 * may be quoted.
 */
export function publisherNamesIn(yml) {
  const lines = yml.split('\n');
  const at = lines.findIndex((line) => /^publisherName:/.test(line));
  if (at === -1) return [];
  const unquote = (text) => text.trim().replace(/^(['"])(.*)\1$/, (_all, quote, inner) => (quote === "'" ? inner.replaceAll("''", "'") : inner));
  const inline = lines[at].slice('publisherName:'.length).trim();
  if (inline) return [unquote(inline)];
  const names = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (!item) break;
    names.push(unquote(item[1]));
  }
  return names;
}

const authenticode = (path) => ({
  label: `${basename(path)} carries a valid Authenticode signature`,
  file: 'powershell',
  args: ['-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${path.replaceAll("'", "''")}').Status`],
  accept: ({ status, stdout }) => status === 0 && stdout.trim() === 'Valid',
});

/**
 * The commands that prove a signed build is signed, each with what its output
 * must show. None for an unsigned build: the checks before these are its proof.
 */
export function signatureChecks(manifest, releaseDir, version, platform = process.platform) {
  if (!manifest?.signing) return [];
  if (platform === 'win32') {
    return [join(releaseDir, 'win-unpacked', 'Ordewell.exe'), join(releaseDir, expectedInstallers(version, platform)[0])].map(authenticode);
  }
  if (platform !== 'darwin') return [];
  const passed = ({ status }) => status === 0;
  return ['mac-arm64', 'mac'].flatMap((dir) => {
    const app = join(releaseDir, dir, 'Ordewell.app');
    const checks = [
      { label: `${dir}/Ordewell.app verifies deeply and strictly`, file: 'codesign', args: ['--verify', '--deep', '--strict', '--verbose=2', app], accept: passed },
      // codesign --display writes to stderr; notarization needs the runtime flag.
      { label: `${dir}/Ordewell.app runs under the hardened runtime`, file: 'codesign', args: ['--display', '--verbose=2', app], accept: ({ status, stdout, stderr }) => status === 0 && /flags=\S*\(\S*runtime/.test(`${stdout}${stderr}`) },
    ];
    if (!manifest.notarized) return checks;
    return [
      ...checks,
      { label: `${dir}/Ordewell.app is accepted by Gatekeeper`, file: 'spctl', args: ['--assess', '--type', 'execute', '--verbose=2', app], accept: passed },
      { label: `${dir}/Ordewell.app has its notarization ticket stapled`, file: 'xcrun', args: ['stapler', 'validate', app], accept: passed },
    ];
  });
}

function readManifest(releaseDir) {
  try {
    return JSON.parse(readFileSync(join(releaseDir, 'signing.json'), 'utf8'));
  } catch {
    return null;
  }
}

function checkSigning(releaseDir, dirs, version, platform, ok) {
  const failures = [];
  const manifest = readManifest(releaseDir);
  const asar = dirs.map((dir) => join(dir, 'app.asar')).find((path) => existsSync(path));
  const baked = asar ? bakedAutoUpdate(asarFile(readFileSync(asar), 'dist/main/index.js')) : null;
  const problems = signingProblems(manifest, baked, platform);
  failures.push(...problems.map((problem) => `signing: ${problem}`));
  if (!problems.length) ok(`${manifest.signing ? `signed (${manifest.signing})${manifest.notarized ? ' and notarized' : ''}` : 'unsigned'}, so updates are ${manifest.autoUpdate ? 'on' : 'off'} (ADR-0063 H9)`);

  for (const check of signatureChecks(manifest, releaseDir, version, platform)) {
    const result = spawnSync(check.file, check.args, { encoding: 'utf8' });
    if (!result.error && check.accept(result)) ok(check.label);
    else failures.push(`signing: not true that ${check.label}: ${(result.error?.message ?? `${result.stderr}${result.stdout}`).trim().split('\n').slice(0, 4).join(' | ')}`);
  }
  if (platform === 'win32' && manifest?.signing) {
    // electron-updater compares an update's publisher with this one; without
    // it a signed install would accept any update.
    const updateYml = join(releaseDir, 'win-unpacked', 'resources', 'app-update.yml');
    const listed = existsSync(updateYml) ? publisherNamesIn(readFileSync(updateYml, 'utf8')) : [];
    // A certificate file's name comes from the certificate, so the manifest
    // has none to hold the file to; with one, every name must be there.
    const missing = (manifest.publisherNames ?? []).filter((name) => !listed.includes(name));
    if (listed.length === 0) failures.push('signing: win-unpacked/resources/app-update.yml names no publisherName, so updates would not be checked against the signature');
    else if (missing.length > 0) failures.push(`signing: win-unpacked/resources/app-update.yml does not list the publisher name ${missing.map((name) => JSON.stringify(name)).join(', ')} that WIN_PUBLISHER_NAME names (it lists ${listed.map((name) => JSON.stringify(name)).join(', ')})`);
    else ok(`app-update.yml names the publisher an update must be signed by (${listed.join(', ')})`);
  }
  return failures;
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
    if (failures.length === before) ok(`${dir.slice(releaseDir.length + 1)} carries the asar, the unpacked daemon closure, the notices and node-pty built for ${expectedArch(dir, platform)}`);
  }

  failures.push(...checkSigning(releaseDir, dirs, version, platform, ok));

  const target = fuseTarget(releaseDir, platform);
  if (existsSync(target)) {
    const { getCurrentFuseWire, FuseV1Options } = await import('@electron/fuses');
    const drift = fuseDrift(await getCurrentFuseWire(target), FuseV1Options);
    for (const d of drift) failures.push(`fuses: ${d}`);
    if (!drift.length) ok('Electron fuses are flipped as ADR-0063 H4 lists');
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
  console.log('\ndesktop-package-check: the installers and the unpacked app are complete, and signed as recorded');
}
