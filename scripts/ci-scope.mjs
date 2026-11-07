#!/usr/bin/env node
// ci.yml's hands on scripts/change-scope.mjs, which holds the decisions.
//   select   what this event needs, as job outputs
//   confirm  the job it runs in (JOB) ran what it owed
//   gate     the required status: every job did what the change owed it
//   windows-tests  this windows shard's part of every suite the scope owes Windows
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { CHECKS, coverageLegs, gateFailures, missedSteps, parseScope, readWorkspaces, scopeForEvent, windowsRuns } from './change-scope.mjs';
import { npm } from './npm.mjs';

const { EVENT, GITHUB_OUTPUT, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_STEP_SUMMARY, JOB, NEEDS, REUSE_MAIN_PROOF, SCOPE, SHARD, STEPS } = process.env;

// ci.yml's workflow_call input, which only release.yml sets; every other event leaves it empty.
const reuseMainProof = REUSE_MAIN_PROOF === 'true';

/** gh's own list of successful push runs of ci.yml on main at `sha`; change-scope.mjs checks every field. */
function findMainRuns(sha) {
  try {
    return execFileSync('gh', [
      'run', 'list', '--repo', GITHUB_REPOSITORY ?? '', '--workflow', 'ci.yml', '--branch', 'main', '--event', 'push',
      '--commit', sha, '--status', 'success', '--json', 'databaseId,url,headSha,event,headBranch,conclusion',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (error) {
    throw new Error(String(error.stderr ?? '').trim() || error.message);
  }
}

function report(problems, passed) {
  for (const problem of problems) console.error(`::error::${problem}`);
  if (problems.length) process.exit(1);
  console.log(passed);
}

const output = (lines) => appendFileSync(GITHUB_OUTPUT, lines.map((line) => `${line}\n`).join(''));

const commands = {
  select() {
    const scope = scopeForEvent(EVENT, '.', readWorkspaces(), { reuseMainProof, sha: GITHUB_SHA, findMainRuns });
    console.log(`${scope.mode}: ${scope.reason}`);
    output([
      `scope=${JSON.stringify(scope)}`,
      // build-and-test runs unless this names the run that proved the commit.
      `proof=${scope.proof?.url ?? ''}`,
      ...CHECKS.map((check) => `${check}=${scope.checks[check]}`),
      // The coverage job's matrix: one leg per workspace the scope reaches.
      `coverage=${JSON.stringify(coverageLegs(scope))}`,
    ]);
    const off = CHECKS.filter((check) => !scope.checks[check]);
    if (GITHUB_STEP_SUMMARY) {
      const reused = scope.proof ? `\n\nReused: [main's CI run](${scope.proof.url}) proved \`${scope.proof.sha}\`; nothing ran again.` : '';
      appendFileSync(GITHUB_STEP_SUMMARY, `**${scope.mode}**: ${scope.reason}\n\nLeft out: ${off.join(', ') || 'nothing'}${reused}\n`);
    }
  },
  confirm() {
    // No default job: a confirm step that names none would prove build-and-test's steps in another job.
    report(missedSteps(parseScope(SCOPE), JSON.parse(STEPS), JOB ?? ''), `Every step this change owed ${JOB} ran and passed.`);
    output(['confirmed=true']);
  },
  gate() {
    report(gateFailures(EVENT, JSON.parse(NEEDS), { reuseMainProof }), 'Every job did what this change owed it.');
  },
  'windows-tests'() {
    // Every suite runs even after one fails, so one red run names them all.
    // A lost scope reads as null, which owes every suite in full.
    const failed = windowsRuns(parseScope(SCOPE ?? '')).filter(({ dir, script }) => {
      console.log(`::group::${script} in ${dir} (shard ${SHARD})`);
      const status = npm(['run', script, '-w', dir, '--if-present', '--', `--shard=${SHARD}`]);
      console.log('::endgroup::');
      return status !== 0;
    });
    report(failed.map(({ dir, script }) => `${script} failed in ${dir}`), `Every suite this change owed Windows passed on shard ${SHARD}.`);
  },
};

const command = commands[process.argv[2]];
if (!command) {
  console.error(`usage: ci-scope.mjs ${Object.keys(commands).join('|')}`);
  process.exit(2);
}
command();
