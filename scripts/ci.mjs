#!/usr/bin/env node
// Run what .github/workflows/ci.yml runs, in its order, so a local pass means
// CI passes. `npm run lint && npm run typecheck && npm run test:coverage` left
// out the verify scripts, the planner e2e, the VS Code integration test, the
// desktop e2e and packaging, and each of those can fail a push on its own.
//
// Every named step of ci.yml must appear below, either run here or listed as
// CI-only with the reason: a step added to the workflow and not here fails
// this script before anything runs, so the two cannot drift apart unnoticed.
// ci.yml's jobs run side by side and each sets up and builds what it needs, so
// what several jobs share runs here once: the first job's two builds, which
// build every package the later jobs' setup builds again.
//
// `--list` prints the steps a run would take, in order, and runs none.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import { npm as runNpm } from './npm.mjs';
import { onPath } from './host-tools.mjs';
import { platformKey, resolveShellcheck } from './shellcheck.mjs';

const MOCK_PROVIDER_PORT = 3799;

// Nothing in a CI run may reach ordewell.ai (ADR-0048); every step below
// inherits this. ci.yml sets it for the job too.
process.env.ORDEWELL_NO_VERSION_CHECK = '1';

export const sh = (cmd, args, env) => spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;
const npm = (...args) => runNpm(args);

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
function sandboxReady() {
  if (process.platform !== 'linux') {
    console.log('Skipping the real bubblewrap suite: it runs on Linux, where bubblewrap is the backend (macOS uses Seatbelt).');
    return false;
  }
  const installed = sh('sh', ['-c', 'command -v bwrap >/dev/null']) === 0;
  const restricted = spawnSync('sysctl', ['-n', 'kernel.apparmor_restrict_unprivileged_userns'], { encoding: 'utf8' }).stdout?.trim() === '1';
  if ((!installed || restricted) && sh('sudo', ['-n', 'true']) !== 0) {
    console.log('Skipping the real bubblewrap suite: installing bubblewrap or lifting the user-namespace restriction needs sudo, and sudo would prompt for a password here.');
    return false;
  }
  return true;
}

// Judged before the script's setup installs zsh or rg: one it installs then runs unrequired, and main() names any still missing.
export function sandboxStep(step, { ready = sandboxReady, run = sh, has = hostHasTool } = {}) {
  return ready() ? run('bash', ['scripts/linux-sandbox-e2e.sh'], toolsEnv(step, has)) : 0;
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
  return headlessLinux ? sh('xvfb-run', ['-a', 'npm', ...args], env) : runNpm(args, env);
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
  console.error('Reinstall them: `npm ci`.');
  return false;
}

/**
 * `npm run test:coverage` runs every workspace and exits 1 without saying which
 * one failed, and the middle of its output is what a saved log loses. So run
 * the workspaces one by one, in the order it would, and name each that fails.
 */
export function testWithCoverage(runs) {
  const { workspaces } = JSON.parse(readFileSync('package.json', 'utf8'));
  const failed = (runs ?? workspaces.map((dir) => ({ dir, script: 'test:coverage' })))
    .filter(({ dir, script }) => npm('run', script, '-w', dir, '--', '--maxWorkers=2', '--minWorkers=1') !== 0)
    .map(({ dir }) => dir);
  if (failed.length) console.error(`\nCoverage run failed in: ${failed.join(', ')}`);
  return failed.length ? 1 : 0;
}

/**
 * The standalone binary (ADR-0065) is built for this host, as CI builds it for
 * its linux-x64 runner. Windows has none: it installs the CLI with npm.
 */
const SEA_BINARY = join('dist-sea', `${process.platform}-${process.arch}`, 'ordewell');
function seaStep(run) {
  return () => {
    if (process.platform === 'win32') {
      console.log('Skipping the standalone binary: it is built for macOS and Linux, and Windows installs the CLI with npm.');
      return 0;
    }
    return run();
  };
}

/** The tools a ci.yml step names in ORDEWELL_REQUIRE_TOOLS, failing a test that would skip without one. */
export const requiredTools = (step) => String(step.env?.ORDEWELL_REQUIRE_TOOLS ?? '').split(/[\s,]+/).filter(Boolean);

// The bench step fetches the pinned shellcheck where one is pinned (none is
// for Windows), so there it counts as present before the fetch.
const pinsShellcheck = platformKey() !== undefined;
// A sealed run reads /bin and /usr, not the user's PATH, so sealedRuns.e2e.test.ts starts a shell only from where it looks.
const SEALED_SHELLS = { zsh: ['/bin/zsh', '/usr/bin/zsh'], fish: ['/usr/bin/fish'] };
export const toolOnHost = ({ exists = existsSync, path = onPath } = {}) => (tool) => {
  if (tool === 'shellcheck') return pinsShellcheck || resolveShellcheck() !== undefined;
  return tool in SEALED_SHELLS ? SEALED_SHELLS[tool].some(exists) : path(tool);
};
export const hostHasTool = toolOnHost();

/**
 * Of the tools CI requires for a step, those this host lacks. A local run
 * requires the rest, as CI does, and names these as unverified: the tests that
 * need them skip here, and a skip is not the pass CI would have to earn.
 */
export const missingTools = (step, has = hostHasTool) => requiredTools(step).filter((tool) => !has(tool));
const toolsEnv = (step, has = hostHasTool) => ({ ORDEWELL_REQUIRE_TOOLS: requiredTools(step).filter(has).join(' ') });

/**
 * test:bench, after fetching the shellcheck scripts/shellcheck.json pins, as
 * CI's step before it does: both local entry points run this, and a lint test
 * without its shellcheck would fail where CI's passes.
 */
export function benchStep(step, { fetch = () => sh('node', ['scripts/shellcheck.mjs']), run = runNpm, has = hostHasTool } = {}) {
  if (pinsShellcheck && fetch() !== 0) return 1;
  return run(['run', 'test:bench'], toolsEnv(step, has));
}

/** Run here, keyed by the step's name in ci.yml, and handed that step. */
export const STEPS = {
  // CI installs exactly the lockfile here; a local run checks what it has against it instead.
  'Install dependencies and build core (cli, web and vscode compile against its dist/)': () => (installedMatchesLockfile() ? npm('run', 'build:core') : 1),
  'Planner sandbox — real bubblewrap e2e': sandboxStep,
  'Verify scripts (offline, against the built core)': () => {
    for (const f of readdirSync('scripts').filter((f) => /^verify-.*\.mjs$/.test(f)).sort()) {
      if (sh('node', [join('scripts', f)]) !== 0) return 1;
    }
    return 0;
  },
  'Repository-wide guards': () => npm('run', 'test:guards', '--', '--maxWorkers=2', '--minWorkers=1'),
  'Planner conversation loop — offline e2e (mock model, no API key)': plannerE2e,
  'Build the standalone CLI binary': seaStep(() => sh('node', ['scripts/sea/build.mjs'])),
  'CLI binary — offline e2e, no Node on PATH': seaStep(() => sh(SEA_BINARY, ['--version']) || sh('node', ['bench/live/drive-binary.mjs', '--bin', SEA_BINARY])),
  'Bench harness tests (offline, against the built core)': benchStep,
  'Build (ui, vscode, cli, web & desktop)': () => npm('run', 'build', '-w', 'packages/ui', '-w', 'packages/vscode', '-w', 'packages/cli', '-w', 'packages/web', '-w', 'packages/desktop', '--if-present'),
  'VS Code integration test (synthetic runner — no API key)': integrationTest,
  'Desktop app — offline e2e (mock planner, fake runner)': () => withDisplay('the desktop e2e', ['run', 'test:desktop-e2e']),
  // ci.yml splits the tour into legs by TOUR_LEG; with none set, this one walk shoots every leg's share.
  'Desktop app — visual tour and layout checks': () => withDisplay('the visual tour', ['run', 'desktop:tour'], { TOUR_STRICT: '1' }),
  'Typecheck': () => npm('run', 'typecheck'),
  'Test with coverage': () => testWithCoverage(),
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
  // `npm ci` would wipe the node_modules you are working in.
  'Install dependencies': 'the first step checks node_modules against the lockfile: run `npm ci` yourself when it does not match',
  'Install bubblewrap, zsh and ripgrep if the image lacks them': 'the sandbox step installs them itself where sudo does not prompt',
  'Install dependencies and build every package': 'the first job’s two build steps build the same packages',
  'Build the Windows suite dependencies': 'the first job’s builds already supply core, ui, cli and web; Windows tests remain unsharded here',
  'Build the Windows harness dependencies': 'the first job’s builds already supply core, ui and the VS Code extension bundle',
  'Cache the VS Code download': 'packages/vscode/.vscode-test is already kept between runs',
  'Download the VS Code under test': 'the integration test downloads the VS Code it lacks itself, into the same .vscode-test',
  'Cache the pinned shellcheck': '.tools/shellcheck is already kept between runs',
  'Fetch the pinned shellcheck': 'the bench step fetches it itself, unless the cache holds it',
  'Resolve the VS Code version under test': 'the workflow asks the update service which stable it will download; a local run keeps the .vscode-test it has',
  'Install xvfb if the image lacks it': 'the VS Code and desktop steps check for a display themselves',
  'Upload the desktop e2e report': 'a failed run leaves it in packages/desktop/test-results/',
  'Upload the desktop tour report': 'a failed run leaves it in packages/desktop/test-results/tour/',
  'Append coverage summaries to the job summary': 'a GitHub job summary',
  'Upload coverage reports': 'reports stay in packages/*/coverage/',
  // CI splits core's suite into shards only to finish sooner; here it runs whole.
  'Upload the shard\'s coverage blob': '`Test with coverage` runs each suite whole, so there are no shards',
  'Download the shards\' coverage blobs': '`Test with coverage` runs each suite whole, so there are no shards',
  'Merge the shards\' coverage and judge its floors': '`Test with coverage` judges the same floors over each whole suite',
  'Upload .vsix': 'the .vsix stays in packages/vscode/',
  'Real engine — every harness in a real container': 'it needs an engine and a large image: run `npm run test:containers`',
  // The Windows jobs run on this host what the steps above run, so a local run
  // on Windows has run them already, and one elsewhere cannot.
  'Test on Windows': '`Test with coverage` runs the Windows job’s core, CLI, web and VS Code suites on this host',
  'Verify scripts on Windows': 'the verify step above runs them on this host',
  'Bench harness tests on Windows': 'the bench step above runs them on this host',
  'Planner conversation loop on Windows': 'the planner loop step above runs it on this host',
  'VS Code integration test on Windows': 'the integration step above runs it on this host',
};

/** Refuse drift before either local entry point starts a check. */
export function workflowSteps() {
  const workflow = load(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const steps = Object.entries(workflow.jobs).flatMap(([job, value]) => value.steps
    .filter((step) => step.name).map((step) => ({ ...step, job })));
  const named = steps.map((step) => step.name);
  const unknown = named.filter((n) => !(n in STEPS) && !(n in CI_ONLY));
  const stale = [...Object.keys(STEPS), ...Object.keys(CI_ONLY)].filter((n) => !named.includes(n));
  if (unknown.length || stale.length) throw new Error([
    ...unknown.map((n) => `ci.yml step not covered by scripts/ci.mjs: "${n}"`),
    ...stale.map((n) => `scripts/ci.mjs names a step ci.yml no longer has: "${n}"`),
  ].join('\n'));
  return steps;
}

async function main() {
  const local = workflowSteps().filter((step, at, all) => step.name in STEPS && all.findIndex((other) => other.name === step.name) === at);
  if (process.argv.includes('--list')) {
    for (const { name } of local) console.log(name);
    return 0;
  }
  for (const step of local) {
    console.log(`\n=== ${step.name}`);
    if ((await STEPS[step.name](step)) !== 0) {
      console.error(`\n✗ ${step.name} failed, as it would in CI.`);
      return 1;
    }
  }
  console.log('\n✓ Every ci.yml step that runs locally passed.');
  // Asked after the steps ran, since the sandbox step installs what it can.
  const unproven = local.map((step) => [step, missingTools(step)]).filter(([, tools]) => tools.length);
  if (unproven.length) console.log('\nWhat CI requires and this host lacks, so its tests skipped here (UNVERIFIED):');
  for (const [step, tools] of unproven) console.log(`  ${step.id}: ${tools.join(', ')}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
