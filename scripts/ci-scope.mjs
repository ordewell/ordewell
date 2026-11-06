#!/usr/bin/env node
// ci.yml's hands on scripts/change-scope.mjs, which holds the decisions.
//   select   what this event needs, as job outputs
//   confirm  the job it runs in (JOB) ran what it owed
//   gate     the required status: every job did what the change owed it
import { appendFileSync } from 'node:fs';
import { CHECKS, coverageLegs, gateFailures, missedSteps, parseScope, readWorkspaces, scopeForEvent } from './change-scope.mjs';

const { EVENT, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, JOB, NEEDS, SCOPE, STEPS } = process.env;

function report(problems, passed) {
  for (const problem of problems) console.error(`::error::${problem}`);
  if (problems.length) process.exit(1);
  console.log(passed);
}

const output = (lines) => appendFileSync(GITHUB_OUTPUT, lines.map((line) => `${line}\n`).join(''));

const commands = {
  select() {
    const scope = scopeForEvent(EVENT, '.', readWorkspaces());
    console.log(`${scope.mode}: ${scope.reason}`);
    output([
      `scope=${JSON.stringify(scope)}`,
      ...CHECKS.map((check) => `${check}=${scope.checks[check]}`),
      // The coverage job's matrix: one leg per workspace the scope reaches.
      `coverage=${JSON.stringify(coverageLegs(scope))}`,
    ]);
    const off = CHECKS.filter((check) => !scope.checks[check]);
    if (GITHUB_STEP_SUMMARY) {
      appendFileSync(GITHUB_STEP_SUMMARY, `**${scope.mode}**: ${scope.reason}\n\nLeft out: ${off.join(', ') || 'nothing'}\n`);
    }
  },
  confirm() {
    // No default job: a confirm step that names none would prove build-and-test's steps in another job.
    report(missedSteps(parseScope(SCOPE), JSON.parse(STEPS), JOB ?? ''), `Every step this change owed ${JOB} ran and passed.`);
    output(['confirmed=true']);
  },
  gate() {
    report(gateFailures(EVENT, JSON.parse(NEEDS)), 'Every job did what this change owed it.');
  },
};

const command = commands[process.argv[2]];
if (!command) {
  console.error(`usage: ci-scope.mjs ${Object.keys(commands).join('|')}`);
  process.exit(2);
}
command();
