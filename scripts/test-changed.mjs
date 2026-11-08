#!/usr/bin/env node
// The same obligations as a pull request, with the checks this host cannot
// prove named at the end. Execution is shared with the full local CI mirror.
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { WINDOWS_JOBS, localRuns, readWorkspaces, uncommittedPaths } from './change-scope.mjs';
import { STEPS, hostHasTool, missingTools, requiredTools, sh, testWithCoverage, workflowSteps } from './ci.mjs';

const SANDBOX_SCRIPT = 'scripts/linux-sandbox-e2e.sh';

function sandboxProblem() {
  const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', 'true'], { encoding: 'utf8' });
  return probe.status === 0 ? undefined : `bubblewrap cannot start: ${probe.error?.message ?? probe.stderr.trim()}`;
}

export function localChecks(plan, workflow = workflowSteps(), host = { platform: process.platform, has: hostHasTool }) {
  if (!plan.scope) return [];
  for (const { job, id } of plan.steps) {
    if (!workflow.some((step) => step.job === job && step.id === id)) throw new Error(`${id}: owed step missing from ci.yml's ${job} job`);
  }
  const unavailable = {
    'vscode-integration': 'needs a display and may download VS Code',
    'desktop-e2e': 'needs a display',
    'desktop-tour': 'needs a display',
    'package-desktop': 'electron-builder may download packaging tools',
    'verify-artifacts': 'needs the desktop installers from package-desktop',
    'upload-vsix': 'uploads a GitHub artifact',
  };
  if (plan.scope.checks.sandbox) unavailable.sandbox = host.platform !== 'linux' ? 'needs Linux and bubblewrap'
    : ('sandbox' in host ? host.sandbox : sandboxProblem());
  if (host.platform === 'win32') {
    unavailable['build-binary'] = unavailable['drive-binary'] = 'the standalone binary is built on Linux and macOS';
  }
  const checks = workflow.filter(({ job, id }) => plan.steps.some((owed) => owed.job === job && owed.id === id)
    || (job === 'build-and-test' && id === 'build-rest'))
    // Whole suites judge these floors locally; CI alone needs to merge shards.
    .filter(({ id }) => id !== 'merge-coverage')
    .map((step) => ({ ...step, reason: unavailable[step.id] }));
  for (const step of checks) {
    if (!step.reason && !(step.name in STEPS)) throw new Error(`${step.id}: no local implementation or unverified reason`);
  }
  // A step runs here even when this host lacks a tool CI requires for it
  // (ORDEWELL_REQUIRE_TOOLS); the tests that need that tool skip, so they are named.
  for (const step of checks.filter((check) => !check.reason)) {
    const missing = missingTools(step, host.has ?? hostHasTool).join(', ');
    if (missing) checks.push({ id: `${step.id}-tools`, name: `${step.name}: the tests that need ${missing}`, reason: 'this host lacks what CI requires them to run with' });
  }
  // The inner loop runs the sandbox script with its setup turned off.
  if (checks.some((step) => step.id === 'sandbox' && !step.reason) && plan.paths?.includes(SANDBOX_SCRIPT)) {
    checks.push({ id: 'sandbox-setup', name: `${SANDBOX_SCRIPT}'s installs and user-namespace fix`, reason: 'the inner loop installs nothing and changes no host policy' });
  }
  for (const [job, check] of Object.entries({ 'real-engine': 'engine', ...WINDOWS_JOBS })) {
    if (plan.scope.checks[check]) checks.push({ id: job, name: job, reason: check === 'engine' ? 'needs a container engine' : 'needs Windows' });
  }
  return checks;
}

export const execute = (step, plan, run = sh) => {
  if (step.id === 'coverage') return testWithCoverage(plan.runs);
  // CI's own script, so a change to it is run, but with its setup off: unlike
  // the full mirror, the inner loop neither installs tools nor changes the
  // host's user-namespace policy, and the probe above establishes readiness.
  if (step.id === 'sandbox') {
    return run('bash', [SANDBOX_SCRIPT, '--maxWorkers=2', '--minWorkers=1'], {
      ORDEWELL_SANDBOX_SETUP: 'none',
      ORDEWELL_REQUIRE_TOOLS: requiredTools(step).filter(hostHasTool).join(' '),
    });
  }
  return STEPS[step.name](step);
};

/** A skipped check is evidence still owed, including after an earlier failure. */
export async function runChecks(checks, plan, run = execute, log = console.log) {
  const pending = [];
  let failed = false;
  for (const step of checks) {
    if (step.reason || failed) {
      pending.push({ ...step, reason: step.reason ?? 'an earlier check failed' });
      continue;
    }
    log(`\n=== ${step.name}`);
    try {
      failed = await run(step, plan) !== 0;
    } catch (error) {
      log(String(error));
      failed = true;
    }
    if (failed) log(`FAILED: ${step.name}`);
  }
  log('\nOwed CI checks not run here (UNVERIFIED):');
  for (const step of pending) log(`  ${step.id}: ${step.name} — ${step.reason}`);
  if (!pending.length) log('  none');
  if (!failed) log('\nAll locally runnable checks passed; unverified checks still belong to CI.');
  return failed ? 1 : 0;
}

async function main() {
  const plan = localRuns(uncommittedPaths(), readWorkspaces());
  console.log(plan.note);
  const checks = localChecks(plan);
  if (process.argv.includes('--list')) {
    for (const step of checks) console.log(`${step.id}: ${step.name}${step.reason ? ` — UNVERIFIED: ${step.reason}` : ''}`);
    return 0;
  }
  return runChecks(checks, plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
