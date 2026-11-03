#!/usr/bin/env node
// Run what .github/workflows/ci.yml runs, in its order, so a local pass means
// CI passes. `npm run lint && npm run typecheck && npm run test:coverage` left
// out the verify scripts, the planner e2e, the VS Code integration test, the
// desktop e2e and packaging, and each of those can fail a push on its own.
//
// Every named step of ci.yml must appear below, either run here or listed as
// CI-only with the reason: a step added to the workflow and not here fails
// this script before anything runs, so the two cannot drift apart unnoticed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MOCK_PROVIDER_PORT = 3799;

// Nothing in a CI run may reach ordewell.ai (ADR-0048); every step below
// inherits this. ci.yml sets it for the job too.
process.env.ORDEWELL_NO_VERSION_CHECK = '1';

const sh = (cmd, args, env) => spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;
const npm = (...args) => sh('npm', args);

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

async function plannerE2e() {
  // A mock left over from an aborted run holds the port, and the drive would
  // silently talk to it instead of the one started here.
  if (await portOpen(MOCK_PROVIDER_PORT)) {
    console.error(`Port ${MOCK_PROVIDER_PORT} is already taken; stop whatever holds it (an old mock-provider?) and rerun.`);
    return 1;
  }
  const mock = spawn('node', ['bench/live/mock-provider.mjs'], { stdio: 'inherit' });
  try {
    for (let i = 0; i < 50 && !(await portOpen(MOCK_PROVIDER_PORT)); i++) await new Promise((r) => setTimeout(r, 200));
    return sh('node', ['bench/live/drive-conversation.mjs']);
  } finally {
    mock.kill();
  }
}

/**
 * The real Linux sandbox, not just the arguments it is given: bubblewrap and
 * the user-namespace fix are the point of the step, and a skip in CI would be
 * green without either. A local Linux box whose sudo would prompt is skipped
 * with that reason rather than left waiting for a password.
 */
function linuxSandboxE2e() {
  if (process.platform !== 'linux') {
    console.log('Skipping the real bubblewrap suite: it runs on Linux, where bubblewrap is the backend (macOS uses Seatbelt).');
    return 0;
  }
  const installed = sh('sh', ['-c', 'command -v bwrap >/dev/null']) === 0;
  const restricted = spawnSync('sysctl', ['-n', 'kernel.apparmor_restrict_unprivileged_userns'], { encoding: 'utf8' }).stdout?.trim() === '1';
  if ((!installed || restricted) && sh('sudo', ['-n', 'true']) !== 0) {
    console.log('Skipping the real bubblewrap suite: installing bubblewrap or lifting the user-namespace restriction needs sudo, and sudo would prompt for a password here.');
    return 0;
  }
  return sh('bash', ['scripts/linux-sandbox-e2e.sh']);
}

/**
 * Electron needs a display: a headless Linux box gets a virtual one, as CI
 * does. `what` names the test in the message when xvfb is missing.
 */
function withDisplay(what, args, env) {
  const headlessLinux = process.platform === 'linux' && !process.env.DISPLAY;
  if (headlessLinux && sh('sh', ['-c', 'command -v xvfb-run >/dev/null']) !== 0) {
    console.error(`No display and no xvfb-run: install xvfb to run ${what}.`);
    return 1;
  }
  return headlessLinux ? sh('xvfb-run', ['-a', 'npm', ...args], env) : sh('npm', args, env);
}

function integrationTest() {
  const workspace = mkdtempSync(join(tmpdir(), 'ordewell-integration-workspace-'));
  return withDisplay('the VS Code integration test', ['run', 'test:integration', '-w', 'ordewell'], { ORDEWELL_TEST_WORKSPACE: workspace });
}

/**
 * CI installs exactly the lockfile with `npm ci`; a local run uses whatever
 * node_modules holds, which can drift from it without npm noticing (its own
 * node_modules/.package-lock.json may still claim the locked version). A
 * stale @vscode/test-electron 2.x, for one, fails the integration test minutes
 * in with `spawn .../Contents/MacOS/Electron ENOENT`. A package absent from
 * disk is an optional or other-platform one and is not checked.
 */
function installedMatchesLockfile() {
  const { packages } = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const drifted = [];
  for (const [dir, locked] of Object.entries(packages)) {
    if (!dir.includes('node_modules/') || locked.link || !locked.version) continue;
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
    if (version !== locked.version) drifted.push(`${dir}: installed ${version}, locked ${locked.version}`);
  }
  if (!drifted.length) return true;
  console.error('node_modules does not match package-lock.json, so this run would not test what CI installs:');
  for (const d of drifted) console.error(`  ${d}`);
  console.error('Reinstall them: `npm ci`, or off Linux, where ci.yml explains why that fails, delete each directory above and run `npm install`.');
  return false;
}

/**
 * `npm run test:coverage` runs every workspace and exits 1 without saying which
 * one failed, and the middle of its output is what a saved log loses. So run
 * the workspaces one by one, in the order it would, and name each that fails.
 */
function testWithCoverage() {
  const { workspaces } = JSON.parse(readFileSync('package.json', 'utf8'));
  const failed = workspaces.filter((ws) => npm('run', 'test:coverage', '-w', ws, '--if-present') !== 0);
  if (failed.length) console.error(`\nCoverage run failed in: ${failed.join(', ')}`);
  return failed.length ? 1 : 0;
}

/** Run here, keyed by the step's name in ci.yml. */
const STEPS = {
  'Build (core first — cli, web and vscode compile against its dist/)': () => npm('run', 'build:core'),
  'Planner sandbox — real bubblewrap e2e': linuxSandboxE2e,
  'Verify scripts (offline, against the built core)': () => {
    for (const f of readdirSync('scripts').filter((f) => /^verify-.*\.mjs$/.test(f)).sort()) {
      if (sh('node', [join('scripts', f)]) !== 0) return 1;
    }
    return 0;
  },
  'Repository-wide guards': () => npm('run', 'test:guards'),
  'Planner conversation loop — offline e2e (mock model, no API key)': plannerE2e,
  'Bench harness tests (offline, against the built core)': () => npm('run', 'test:bench'),
  'Build (ui, vscode, cli, web & desktop)': () => npm('run', 'build', '-w', 'packages/ui', '-w', 'packages/vscode', '-w', 'packages/cli', '-w', 'packages/web', '-w', 'packages/desktop', '--if-present'),
  'VS Code integration test (synthetic runner — no API key)': integrationTest,
  'Desktop app — offline e2e (mock planner, fake runner)': () => withDisplay('the desktop e2e', ['run', 'test:desktop-e2e']),
  'Typecheck': () => npm('run', 'typecheck'),
  'Test with coverage': testWithCoverage,
  'Lint': () => npm('run', 'lint'),
  'Package VS Code Extension': () => npm('run', 'package', '-w', 'packages/vscode'),
  'Package the desktop app': () => npm('run', 'desktop:package'),
  'Verify packaged npm and VS Code artifacts': () => sh('node', ['scripts/package-check.mjs']),
};

/** Named in ci.yml but not run here, and why. */
const CI_ONLY = {
  'Work out what this change needs': 'a local run does not select: it runs every step here',
  'Confirm every step this change owed ran': 'nothing is skipped here for it to confirm',
  'Require every check this change owed': 'a GitHub required status',
  'Use Node.js 22.x': 'the local Node is what you have',
  // ci.yml explains why the lockfile does not install cleanly off Linux, and
  // `npm ci` would also wipe the node_modules you are working in.
  'Install dependencies': 'run `npm ci` yourself after a lockfile change',
  'Cache the VS Code download': 'packages/vscode/.vscode-test is already kept between runs',
  'Resolve the VS Code version under test': 'the workflow asks the update service which stable it will download; a local run keeps the .vscode-test it has',
  'Install xvfb if the image lacks it': 'the VS Code and desktop steps check for a display themselves',
  'Upload the desktop e2e report': 'a failed run leaves it in packages/desktop/test-results/',
  'Append coverage summaries to the job summary': 'a GitHub job summary',
  'Upload coverage reports': 'reports stay in packages/*/coverage/',
  'Upload .vsix': 'the .vsix stays in packages/vscode/',
  'Real engine — every harness in a real container': 'it needs an engine and a large image: run `npm run test:containers`',
};

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const named = [...workflow.matchAll(/^\s+- name: (.+?)\s*$/gm)].map((m) => m[1].replace(/^(['"])(.*)\1$/, '$2'));
const unknown = named.filter((n) => !(n in STEPS) && !(n in CI_ONLY));
const stale = [...Object.keys(STEPS), ...Object.keys(CI_ONLY)].filter((n) => !named.includes(n));
if (unknown.length || stale.length) {
  for (const n of unknown) console.error(`ci.yml step not covered by scripts/ci.mjs: "${n}"`);
  for (const n of stale) console.error(`scripts/ci.mjs names a step ci.yml no longer has: "${n}"`);
  process.exit(1);
}
if (!installedMatchesLockfile()) process.exit(1);

for (const name of named.filter((n) => n in STEPS)) {
  console.log(`\n=== ${name}`);
  if ((await STEPS[name]()) !== 0) {
    console.error(`\n✗ ${name} failed, as it would in CI.`);
    process.exit(1);
  }
}
console.log('\n✓ Every ci.yml step that runs locally passed.');
