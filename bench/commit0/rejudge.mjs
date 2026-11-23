#!/usr/bin/env node
// Offline, no key, no Docker: a recorded run judged again by this build's
// validity rules. It reads a run directory's result.json for what the run
// recorded (its checks, stop, freshness and the reference's collected count)
// and tests.log for what the scoring box wrote, parses the counts afresh, and
// prints the verdict with its reasons. The recorded result.json is never
// rewritten: the re-judgement goes beside it as rejudged.json. See
// bench/README.md, "Commit0".
//
//   node bench/commit0/rejudge.mjs <run dir | batch dir> ...
//
// A batch dir stands for each of its run dirs. Exit 1 when a run is judged
// invalid, or has nothing to judge.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as L from './lib.mjs';

/** The counts to judge: tests.log read by today's parser over what result.json recorded. */
function scoreOf(dir, recorded) {
  const log = path.join(dir, 'tests.log');
  const parsed = fs.existsSync(log) ? L.parseEvaluation(recorded?.exit ?? 1, fs.readFileSync(log, 'utf8')) : null;
  if (!parsed) return { tests: recorded ?? null, scoreSource: 'result.json' };
  return { tests: { ...recorded, ...parsed, collected: recorded?.collected, exit: recorded?.exit ?? null, timedOut: recorded?.timedOut ?? false }, scoreSource: 'tests.log' };
}

/** Judges one run directory again and writes rejudged.json beside its result.json. */
export function rejudgeRun(dir) {
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  const { tests, scoreSource } = scoreOf(dir, result.tests);
  const verdict = L.judgeValidity({
    aborted: result.aborted, checks: result.checks, tests, freshness: result.distFreshness, stopped: result.stopped,
    dryRun: result.dryRun, planOnly: result.planOnly, scoring: result.scoredSource,
  });
  const out = {
    library: result.library,
    arm: result.arm,
    ...verdict,
    scoreSource,
    moduleSkipped: tests?.moduleSkipped ?? null,
    tests: tests ? { passed: tests.passed, failed: tests.failed, skipped: tests.skipped, xfailed: tests.xfailed ?? null, xpassed: tests.xpassed ?? null, errors: tests.errors, collected: tests.collected } : null,
    was: { valid: result.valid, invalidReasons: result.invalidReasons ?? [] },
    rejudgedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'rejudged.json'), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

/** The run directories a path stands for: itself, or the children of a batch dir that hold a result. */
export function runDirsOf(dir) {
  if (fs.existsSync(path.join(dir, 'result.json'))) return [dir];
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((n) => path.join(dir, n)).filter((d) => fs.existsSync(path.join(d, 'result.json'))).sort();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.some((a) => a.startsWith('-'))) {
    console.error('usage: node bench/commit0/rejudge.mjs <run dir | batch dir> ...');
    process.exit(2);
  }
  let bad = false;
  for (const arg of args) {
    const dirs = runDirsOf(path.resolve(arg));
    if (dirs.length === 0) { console.log(`${arg}: no result.json to judge`); bad = true; }
    for (const dir of dirs) {
      const r = rejudgeRun(dir);
      if (!r.valid) bad = true;
      const was = r.was.valid === r.valid ? `unchanged from the record` : `the record said ${r.was.valid ? 'valid' : 'invalid'}`;
      console.log(`${dir}\n  ${r.library} arm ${r.arm}: ${r.valid ? 'VALID' : 'INVALID'} (${was}); counts from ${r.scoreSource}; ${r.moduleSkipped === null ? 'module-level skips not told apart' : `${r.moduleSkipped} module-level skip${r.moduleSkipped === 1 ? '' : 's'}`}`);
      for (const reason of r.invalidReasons) console.log(`  - ${reason}`);
      console.log(`  written: ${path.join(dir, 'rejudged.json')}`);
    }
  }
  process.exit(bad ? 1 : 0);
}
