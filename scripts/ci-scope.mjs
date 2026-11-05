#!/usr/bin/env node
// ci.yml's hands on scripts/change-scope.mjs, which holds the decisions.
//   select   what this event needs, as job outputs
//   confirm  build-and-test ran what it owed
//   gate     the required status: every job did what the change owed it
import { appendFileSync } from 'node:fs';
import { CHECKS, gateFailures, missedSteps, parseScope, readWorkspaces, scopeForEvent } from './change-scope.mjs';

const { EVENT, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY, NEEDS, SCOPE, STEPS } = process.env;

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
      // Empty means every workspace: the root script, or `-ws`.
      `workspace_args=${scope.mode === 'full' ? '' : scope.workspaces.map((dir) => `-w ${dir}`).join(' ')}`,
    ]);
    const off = CHECKS.filter((check) => !scope.checks[check]);
    if (GITHUB_STEP_SUMMARY) {
      appendFileSync(GITHUB_STEP_SUMMARY, `**${scope.mode}**: ${scope.reason}\n\nLeft out: ${off.join(', ') || 'nothing'}\n`);
    }
  },
  confirm() {
    report(missedSteps(parseScope(SCOPE), JSON.parse(STEPS)), 'Every step this change owed ran and passed.');
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
