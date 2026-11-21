#!/usr/bin/env node
// Several Commit0 runs at once on one OpenRouter key. Each run is drive.mjs
// in a process of its own, so one run's crash or signal cannot take the
// others down, and drive.mjs keeps its one-run state and its signal handlers
// as they are; this file only schedules the runs, holds the key's lock for
// the batch, watches the key against the batch budget and writes batch.json.
// See bench/README.md, "Commit0".
//
//   node bench/commit0/batch.mjs --dry-run --libs <libraries.json> --jobs 2
//   node bench/commit0/batch.mjs --run --libs <libraries.json> --provider-pin <p> --batch-budget-usd <usd>
//   node bench/commit0/batch.mjs --run --plan-only --libs <libraries.json> --provider-pin <p> --batch-budget-usd <usd> --seed 1   (arm B's plans alone)
//   node bench/commit0/batch.mjs --rehearse <scenario> --libs <libraries.json> --arm A   (rehearse.mjs starts these)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkedBenchDir } from '../lib/data-dir.mjs';
import * as L from './lib.mjs';
import * as R from './rehearsal.mjs';

const DRIVE = path.join(import.meta.dirname, 'drive.mjs');
const POLL_MS = 30_000;

const HELP = `Usage: node bench/commit0/batch.mjs (--dry-run | --run | --rehearse <scenario>) --libs <file> [options]

  --jobs <n>               runs at once (default ${L.JOBS}); refused when n × --cpus exceeds the host's CPUs
                           or n × --memory exceeds ${L.BATCH_MEMORY_SHARE * 100}% of its memory. With both arms
                           and 2 or more, a library's A and B start together and the next library's pair
                           starts only once both have ended
  --batch-budget-usd <usd> stop every run once the key's usage since the batch began reaches it
                           (required with --run)
  --only <a,b>             only these libraries of --libs
  --arm A|B|both           which arms of each library (default both)
  --plan-only              only arm B's planning: each run makes its plan, records its shape and stops, with
                           nothing run, merged or scored (arm A has no plan: --arm A is refused, both means B).
                           Its results go in plan-runs/ and plans.jsonl, never runs/ or results.jsonl
  --seed <label>           a label for this repetition, in every run's result.json and directory name
  --sweep                  sweep boxes and networks of drivers no longer running before the batch

Passed to every run: --dry-run, --run, --rehearse, --libs, --provider-pin, --cap-usd, --call-budget, --parallel, --cpus,
--memory, --stall-min, --settle-min, --no-start-min, --poll-sec, --wall-min, --ordewell-root,
--allow-stale-dist, --keep, --plan-only (node bench/commit0/drive.mjs --help).

The batch takes the key's lock once; its runs and batch.json go in one directory under the
bench data directory. batch.json is written whole when the batch starts and after every run
ends, with the key's usage as read at each of those points when a key is present, so a host
stop loses at most the runs that were going. Results are appended to results.jsonl once every
run has ended;
a dry run's, a rehearsal's and a plan-only run's never are (a plan-only run's go to plans.jsonl).`;

const opts = (() => {
  try {
    return L.parseBatchArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    process.exit(2);
  }
})();
if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

const children = new Set();
/** The signal that cancelled the batch: no queued run starts after it. */
let cancelledBy = null;
const forward = (signal) => {
  for (const c of children) c.kill(signal);
};
// A run's drive.mjs removes its own box on a signal; the batch passes it on, waits for them and starts no other.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cancelledBy ??= signal;
    forward(signal);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runChild(args, logFile, prefix) {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(logFile);
    const child = spawn(process.execPath, [DRIVE, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    const relay = (stream, out) => {
      let rest = '';
      stream.on('data', (chunk) => {
        log.write(chunk);
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const line of lines) out.write(`${prefix} ${line}\n`);
      });
      stream.on('end', () => { if (rest) out.write(`${prefix} ${rest}\n`); });
    };
    relay(child.stdout, process.stdout);
    relay(child.stderr, process.stderr);
    child.on('close', (code, signal) => {
      children.delete(child);
      log.end();
      resolve({ code, signal });
    });
  });
}

/** The result.json a run wrote under the batch's directory, found by its library and arm. */
function findResult(batchDir, lib, arm) {
  for (const name of fs.readdirSync(batchDir)) {
    const file = path.join(batchDir, name, 'result.json');
    if (!fs.existsSync(file)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (r.library === lib && r.arm === arm) return { dir: path.join(batchDir, name), result: r };
    } catch { /* a run that died mid-write has no result to report */ }
  }
  return null;
}

async function main() {
  const capacity = L.capacityCheck({ jobs: opts.jobs, cpus: opts.cpus, memory: opts.memory, hostCpus: os.cpus().length, hostMemBytes: os.totalmem() });
  if (!capacity.ok) {
    console.error(`refused: the batch does not fit this host\n  ${capacity.failures.join('\n  ')}`);
    process.exitCode = 2;
    return;
  }
  if (opts.sweep) {
    const s = await runChild(['--sweep'], path.join(os.tmpdir(), `commit0-sweep-${process.pid}.log`), '[sweep]');
    if (s.code !== 0) throw new Error('the sweep failed');
  }
  const raw = JSON.parse(fs.readFileSync(opts.libs, 'utf8'));
  const listed = (Array.isArray(raw) ? raw : raw.libraries ?? []).map(L.validateLibrary).map((l) => l.name);
  const names = opts.only.length ? listed.filter((n) => opts.only.includes(n)) : listed;
  const missing = opts.only.filter((n) => !listed.includes(n));
  if (missing.length) throw new Error(`not in ${opts.libs}: ${missing.join(', ')}`);
  const runs = L.batchPlan({ libs: names, arms: L.armsOf(opts.arm).map((a) => a.id), seed: opts.seed });
  if (runs.length === 0) throw new Error('no run in the batch');
  if (opts.run && !process.env.OPENROUTER_API_KEY) throw new Error('--run needs OPENROUTER_API_KEY');
  const realKeys = opts.rehearse ? R.realKeysIn(process.env) : [];
  if (realKeys.length) throw new Error(`a rehearsal never runs with a real key in the environment: unset ${realKeys.join(', ')}`);

  const dataDir = checkedBenchDir('commit0');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const batchDir = path.join(dataDir, L.runsDirName(opts), `batch-${stamp.slice(0, 19)}${opts.seed ? `-${opts.seed}` : ''}`.toLowerCase());
  fs.mkdirSync(batchDir, { recursive: true });
  const overlapped = opts.jobs > 1 && runs.length > 1;
  const key = process.env.OPENROUTER_API_KEY;
  console.log(`Commit0 batch: ${opts.dryRun ? 'DRY RUN, no model call' : opts.rehearse ? `REHEARSAL ${opts.rehearse}, on a scripted fake provider` : 'RUN, spending on the key'}${opts.planOnly ? ', PLAN ONLY: arm B plans, nothing runs or is scored' : ''}; ${runs.length} runs, ${Math.min(opts.jobs, runs.length)} at once (${opts.cpus} CPUs, ${opts.memory} each); budget ${opts.budgetUsd === null ? 'none' : `$${opts.budgetUsd}`}; in ${batchDir}`);

  // One lock for the whole batch: its runs share the key with each other and with nothing else.
  const release = opts.run ? L.lockKey(dataDir) : () => {};
  process.on('exit', release);
  const startedAt = new Date().toISOString();
  const keyReadings = [];
  let keyBeforeUsd = null;
  if (opts.run) {
    try {
      keyBeforeUsd = await L.startingKeyUsage({ read: () => L.keyUsage(key) });
    } catch (err) {
      fs.rmdirSync(batchDir);
      throw err;
    }
    keyReadings.push({ at: startedAt, usd: keyBeforeUsd, after: null });
  }
  let stoppedByBudget = null;
  const stopFile = path.join(batchDir, L.BATCH_STOP_FILE);
  let running = true;
  const watcher = (async () => {
    while (running && opts.run) {
      await sleep(POLL_MS);
      if (!running || stoppedByBudget) continue;
      const d = L.budgetDecision({ keyBeforeUsd, keyNowUsd: await L.keyUsage(key), budgetUsd: opts.budgetUsd });
      if (d.stop) {
        stoppedByBudget = { spentUsd: d.spentUsd, at: new Date().toISOString() };
        // Every run polls for this file and stops through its own stop path, merging what landed.
        fs.writeFileSync(stopFile, `${JSON.stringify(stoppedByBudget)}\n`);
        console.log(`[batch] the key has spent $${d.spentUsd} of the batch's $${opts.budgetUsd}: stopping every run`);
      }
    }
  })();

  const outcomes = [];
  /** batch.json as the outcomes so far make it, each run's result read from its directory. */
  const writeRecord = ({ endedAt = null, keyAfterUsd = null } = {}) => {
    const reported = [];
    const results = [];
    for (const o of outcomes) {
      const found = findResult(batchDir, o.lib, o.arm);
      if (found) results.push(found.result);
      reported.push({
        lib: o.lib, arm: o.arm, exit: o.exit, signal: o.signal ?? null, skipped: o.skipped ?? null,
        resultDir: found?.dir ?? null,
        startedAt: found?.result.startedAt ?? null,
        endedAt: found?.result.endedAt ?? null,
        recordedUsd: found?.result.recordedUsd ?? null,
        referenceUsd: found?.result.referenceUsd ?? null,
        referenceTokens: found?.result.referenceSpend?.tokens ?? null,
        billedUsd: found?.result.billedUsd ?? null,
        billedSource: found?.result.billedSource ?? null,
        valid: found?.result.valid ?? null,
        callBudget: found?.result.callBudget ?? null,
        planOnly: found?.result.planOnly ?? null,
        planned: found?.result.planned ?? null,
      });
    }
    const record = L.batchRecord({
      keyBeforeUsd, keyAfterUsd, budgetUsd: opts.budgetUsd, stoppedByBudget, jobs: opts.jobs, overlapped,
      seed: opts.seed, dryRun: opts.dryRun, rehearsal: opts.rehearse ?? null, planOnly: opts.planOnly, startedAt, endedAt, keyReadings, runs: reported,
    });
    L.writeJsonAtomic(path.join(batchDir, 'batch.json'), record);
    return { record, reported, results };
  };
  writeRecord();
  const worker = async (queue) => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      if (cancelledBy) {
        outcomes.push({ ...r, exit: null, skipped: `the batch was cancelled by ${cancelledBy} before it started` });
        continue;
      }
      if (fs.existsSync(stopFile)) {
        outcomes.push({ ...r, exit: null, skipped: 'the batch budget was spent before it started' });
        continue;
      }
      const tag = `${r.lib}-${r.arm}`.toLowerCase();
      const args = [...opts.driveArgs, '--only', r.lib, '--arm', r.arm, ...(opts.seed ? ['--seed', opts.seed] : []), '--batch-dir', batchDir, ...(overlapped ? ['--batch-shared'] : [])];
      const { code, signal } = await runChild(args, path.join(batchDir, `${tag}.log`), `[${r.lib} ${r.arm}]`);
      outcomes.push({ ...r, exit: code, signal: signal ?? null });
      // Read once the run has ended and written before anything else can be lost: a host stop costs the runs still going.
      if (opts.run) keyReadings.push({ at: new Date().toISOString(), usd: await L.keyUsage(key), after: `${r.lib} ${r.arm}` });
      writeRecord();
    }
  };
  try {
    // A wave ends before the next starts: a library's A and B are one wave when the jobs hold a pair.
    for (const segment of L.batchSegments({ runs, jobs: opts.jobs })) {
      const queue = [...segment.runs];
      await Promise.all(Array.from({ length: Math.min(segment.jobs, queue.length) }, () => worker(queue)));
    }
  } finally {
    running = false;
  }
  await watcher;
  const keyAfterUsd = opts.run && keyBeforeUsd !== null ? await L.settledKeyUsage(key) : null;
  release();

  if (keyAfterUsd !== null) keyReadings.push({ at: new Date().toISOString(), usd: keyAfterUsd, after: 'settled' });
  const { record, reported, results } = writeRecord({ endedAt: new Date().toISOString(), keyAfterUsd });
  // Appended here, one after another, so concurrent runs never interleave a line; only a paid run's are results,
  // and a plan-only run's go to a file of their own, since none of them is scored.
  if (opts.run) {
    for (const r of results) fs.appendFileSync(path.join(dataDir, L.resultsFileName(opts)), `${JSON.stringify(r)}\n`);
  }

  console.log(`\nbatch: ${reported.length} runs in ${batchDir}`);
  for (const r of reported) {
    console.log(`  ${r.lib} ${r.arm}: ${r.skipped ?? `exit ${r.exit ?? r.signal}`}${r.recordedUsd !== null ? `, recorded $${r.recordedUsd}` : ''}${r.planOnly ? `; ${L.describePlanned(r.planned)}` : r.valid === null ? '' : r.valid ? ', valid' : ', not valid'}`);
  }
  const badPairs = record.pairs.filter((p) => !p.valid);
  for (const [arm, t] of Object.entries(record.perArm)) console.log(`  arm ${arm}: recorded ${t.recordedUsd ?? '?'}, at the reference prices (${record.referencePriceTable.id}) ${t.referenceUsd ?? '?'}`);
  for (const p of badPairs) console.log(`  ${p.lib}: the pair is not valid: ${p.invalidReasons.join('; ')}`);
  if (opts.run) console.log(`  key:$${record.keyDeltaUsd ?? '?'} spent; recorded $${record.recordedSumUsd ?? '?'}; gap $${record.gapUsd ?? '?'}${stoppedByBudget ? '; stopped by the batch budget' : ''}`);
  process.exitCode = reported.some((r) => r.exit !== 0) || badPairs.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  forward('SIGTERM');
  process.exitCode = 1;
});
