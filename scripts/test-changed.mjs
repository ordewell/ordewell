#!/usr/bin/env node
// Fast local loop: run only the tests affected by uncommitted changes.
// scripts/change-scope.mjs decides, so a path is judged as CI judges it.
import { spawnSync } from 'node:child_process';
import { localRuns, readWorkspaces, uncommittedPaths } from './change-scope.mjs';

const npm = (...args) => spawnSync('npm', args, { stdio: 'inherit' }).status ?? 1;

const { note, rebuild, runs } = localRuns(uncommittedPaths(), readWorkspaces());
if (note) console.log(note);
for (const dir of rebuild) {
  if (npm('run', 'build', '-w', dir) !== 0) process.exit(1);
}
const failed = runs.filter(({ dir, script }) => npm('run', script, '-w', dir) !== 0);
process.exit(failed.length ? 1 : 0);
