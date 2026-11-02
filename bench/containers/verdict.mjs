/*
 * What a run of the real-engine suites may claim. Pure, so the rule that a skip
 * is never a pass is tested without an engine; `scripts/container-e2e.mjs` runs
 * the suites and hands their report here.
 */

const VERIFIED_ON = {
  colima: 'Colima',
  'docker-desktop': 'Docker Desktop',
  'native-linux': 'a native Linux engine',
};

/**
 * vitest reports a skipped test as `skipped`, `pending`, `todo` or `disabled`
 * depending on how it was skipped, so a pass is the one status counted as one.
 * A file that failed to load holds no tests at all, and is a failure itself.
 * `success` is vitest's own word, which also covers what fails no single test.
 */
export function tally(report) {
  const counts = { passed: [], failed: [], skipped: [], success: report.success === true };
  for (const { name: path, status, message, assertionResults = [] } of report.testResults ?? []) {
    const file = path.split('/').pop();
    if (status === 'failed' && !assertionResults.some((test) => test.status === 'failed')) {
      counts.failed.push({ file, name: `${file}: ${message ?? 'failed to run'}` });
    }
    for (const test of assertionResults) {
      const bucket = test.status === 'passed' ? counts.passed : test.status === 'failed' ? counts.failed : counts.skipped;
      bucket.push({ file, name: test.fullName ?? test.title });
    }
  }
  return counts;
}

function harnessesProven(counts, proofs) {
  const harnesses = {};
  for (const { harness } of proofs) harnesses[harness] = 'verified';
  for (const { harness, file, test } of proofs) {
    const proven = counts?.passed.some((passed) => passed.file === file && test.test(passed.name));
    if (!proven) harnesses[harness] = 'unverified';
  }
  return harnesses;
}

/**
 * `suites` are the test files this run was to hold, and one with no passed test
 * did not run, so naming a suite here is what stops it going missing unseen. A
 * clean end is asked of both vitest's report and its exit status, and only `0`
 * reads as one: an unknown status is a run nobody saw finish.
 */
export function verdict({ engine, counts, proofs, suites, vitestStatus, reason }) {
  const harnesses = harnessesProven(counts, proofs);
  const unproven = Object.values(harnesses).includes('unverified');
  const failed = counts?.failed.length ?? 0;
  const skipped = counts?.skipped.length ?? 0;
  const missing = counts ? suites.filter((suite) => !counts.passed.some(({ file }) => file === suite)) : [];
  const vitestFailed = counts !== null && (!counts.success || vitestStatus !== 0);
  const outcome = failed || vitestFailed ? 'failed'
    : !engine || !counts || !counts.passed.length || skipped || unproven || missing.length ? 'unverified'
      : 'verified';
  return { outcome, exitCode: outcome === 'verified' ? 0 : 1, engine, counts, harnesses, missing, vitestFailed, vitestStatus, reason };
}

/** What a run on one engine says nothing about, stated on every run however it went. */
function notVerifiedHere(result) {
  const lines = [];
  for (const [kind, label] of Object.entries(VERIFIED_ON)) {
    if (result.engine?.kind !== kind) lines.push(`${label}: not run here.`);
  }
  lines.push(
    'Windows: never run; containers are unproven there.',
    'A live provider: every model here is a controlled stand-in, so no real account, sign-in or refresh is proven (docs/containers.md lists the manual checks).',
    'One kernel per task: a shared engine gives none, on any host.',
  );
  return lines;
}

export function describeVerdict(result) {
  const { engine, counts, harnesses, missing, vitestFailed, vitestStatus, outcome, reason } = result;
  const lines = [];
  lines.push(engine
    ? `Engine: ${VERIFIED_ON[engine.kind] ?? engine.kind} (context ${engine.context}, ${engine.os}, ${engine.arch}, kernel ${engine.kernel}, cgroup v${engine.cgroup}, server ${engine.server})`
    : 'Engine: none answered.');
  if (reason) lines.push(`Why: ${reason}`);
  if (counts) lines.push(`Tests: ${counts.passed.length} passed, ${counts.failed.length} failed, ${counts.skipped.length} skipped.`);
  for (const [harness, state] of Object.entries(harnesses)) lines.push(`  ${harness}: ${state === 'verified' ? 'real binary proven' : 'NOT PROVEN'}`);
  for (const { name } of counts?.failed ?? []) lines.push(`  failed: ${name}`);
  for (const { name } of counts?.skipped ?? []) lines.push(`  skipped, so not verified: ${name}`);
  for (const suite of missing) lines.push(`  did not run, so not verified: ${suite}`);
  if (vitestFailed) lines.push(`  failed: vitest ended with status ${vitestStatus}, and its report ${counts.success ? 'says it succeeded' : 'does not say it succeeded'}`);
  lines.push('Not verified by this run:');
  for (const line of notVerifiedHere(result)) lines.push(`  ${line}`);
  lines.push(`Outcome: ${outcome.toUpperCase()}`);
  return lines;
}

/**
 * Docker Desktop names itself as the system on both hosts, so it is asked first.
 * A VM this does not know stays `other`: calling it native Linux, or Colima, would
 * claim a run nobody made. So does an engine this Linux host only talks to:
 * `endpoint` is `docker context inspect`'s, and `unix://` is the same test of
 * local that `inspectEngine` makes, with the same forwarded socket taken on trust.
 */
export function classifyEngine({ context, name, operatingSystem, platform, endpoint }) {
  if (/docker desktop/i.test(operatingSystem ?? '')) return 'docker-desktop';
  if (/^colima/.test(context ?? '') || /^colima/.test(name ?? '')) return 'colima';
  if (platform === 'linux' && endpoint?.startsWith('unix://')) return 'native-linux';
  return 'other';
}

/**
 * The image is `task.Dockerfile` with its OpenCode line on. A reworded line must
 * stop the check: it would otherwise build an image with no OpenCode, and read as
 * a failure of OpenCode.
 */
export function withOpenCode(dockerfile) {
  const line = /^# (RUN npm install -g @opencode\/cli)$/m;
  if (!line.test(dockerfile)) throw new Error('task.Dockerfile no longer holds its commented OpenCode line, so the check cannot add OpenCode to the image.');
  return dockerfile.replace(line, '$1');
}
