#!/usr/bin/env node
// Fast local loop: run only the tests affected by uncommitted changes.
// scripts/change-scope.mjs decides, so a path is judged as CI judges it.
import { localRuns, readWorkspaces, uncommittedPaths } from './change-scope.mjs';
import { npm as runNpm } from './npm.mjs';

const npm = (...args) => runNpm(args);

const { note, rebuild, runs } = localRuns(uncommittedPaths(), readWorkspaces());
if (note) console.log(note);
for (const dir of rebuild) {
  if (npm('run', 'build', '-w', dir) !== 0) process.exit(1);
}
const failed = runs.filter(({ dir, script }) => npm('run', script, '-w', dir) !== 0);
process.exit(failed.length ? 1 : 0);
