#!/usr/bin/env node
/*
 * The rehearsal: every scenario of rehearsal.mjs through batch.mjs and
 * drive.mjs, as a paid batch runs, on a real library image, the model a
 * scripted fake in the box. It costs nothing and goes before any paid run,
 * since a dry run starts no agent and so cannot see how the driver follows,
 * stops and scores a live one.
 *
 *   node bench/commit0/rehearse.mjs --libs <libraries.json> [--only <library>] [--scenario a,b] [--ordewell-root <dir>]
 *
 * Each scenario's result.json is judged against what the scenario expects,
 * its batch.json must hold the run, results.jsonl must not grow, and no box or
 * network of the bench may be left behind. Exit 0 when all pass.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkedBenchDir } from '../lib/data-dir.mjs';
import * as R from './rehearsal.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const libs = arg('--libs');
const only = arg('--only', 'tlslite-ng');
const ordewellRoot = arg('--ordewell-root');
const names = (arg('--scenario') ?? R.scenarioNames().join(',')).split(',').filter(Boolean);
if (!libs) {
  console.error('usage: node bench/commit0/rehearse.mjs --libs <libraries.json> [--only <library>] [--scenario a,b] [--ordewell-root <dir>]');
  process.exit(2);
}
for (const n of names) R.scenario(n);
const keys = R.realKeysIn(process.env);
if (keys.length) {
  console.error(`a rehearsal never runs with a real key in the environment: unset ${keys.join(', ')}`);
  process.exit(2);
}

const BATCH = path.join(import.meta.dirname, 'batch.mjs');
const dataDir = checkedBenchDir('commit0');
const rehearsals = path.join(dataDir, 'rehearsals');
const resultsFile = path.join(dataDir, 'results.jsonl');
const resultsSize = () => (fs.existsSync(resultsFile) ? fs.statSync(resultsFile).size : 0);
const plansFile = path.join(dataDir, 'plans.jsonl');
const plansSize = () => (fs.existsSync(plansFile) ? fs.statSync(plansFile).size : 0);

/** The bench's boxes and networks, by id and name. */
function leftovers() {
  const rows = (args, field) => execFileSync('docker', [...args, '--filter', 'label=commit0-bench=1', '--format', `{{.ID}} {{.${field}}}`], { encoding: 'utf8' })
    .split('\n').filter(Boolean).map((l) => { const [id, ...name] = l.split(' '); return { id, name: name.join(' ') }; });
  return { containers: rows(['container', 'ls', '-a'], 'Names'), networks: rows(['network', 'ls'], 'Name') };
}

/**
 * What a scenario left behind: boxes and networks that were not there before
 * and carry its seed in their name (every run names its own after the seed).
 * Another driver's, started meanwhile on this host, is not this rehearsal's.
 */
function strays(before, after, seed) {
  const known = new Set([...before.containers, ...before.networks].map((x) => x.id));
  return [...after.containers, ...after.networks].filter((x) => !known.has(x.id) && x.name.includes(seed.toLowerCase())).map((x) => x.id);
}

/** The turns the fake played, from its request log. */
function turnsOf(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).turn).filter(Boolean);
}

/** The context the fake was started with, for reading its scripts back: only the step tools matter here. */
function playCtx(file, name) {
  const lib = JSON.parse(fs.readFileSync(file, 'utf8')).libraries.find((l) => l.name === name) ?? {};
  const trim = (d) => String(d ?? '').replace(/^\.\//, '').replace(/\/+$/, '');
  return { src: trim(lib.srcDir), tests: trim(lib.testDir), longSec: 0 };
}

function batch(argv, logFile) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [BATCH, ...argv], { stdio: ['ignore', out, out] });
    child.on('exit', (code, signal) => { fs.closeSync(out); resolve(code ?? signal); });
  });
}

/** The batch directory a scenario's batch.mjs wrote, found by its seed, and the one run in it. */
function findBatch(seed) {
  const dir = fs.readdirSync(rehearsals).find((d) => d.startsWith('batch-') && d.endsWith(seed.toLowerCase()));
  if (!dir) return { batchDir: null, runDir: null, batchRecord: null };
  const batchDir = path.join(rehearsals, dir);
  const runDir = fs.readdirSync(batchDir).map((d) => path.join(batchDir, d)).find((d) => fs.existsSync(path.join(d, 'result.json'))) ?? null;
  const file = path.join(batchDir, 'batch.json');
  return { batchDir, runDir, batchRecord: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
}

const before = leftovers();
const outcome = [];
for (const name of names) {
  const s = R.scenario(name);
  const seed = `rehearsal-${name}-${Date.now().toString(36)}`;
  const argv = ['--rehearse', name, '--libs', libs, '--only', only, '--arm', s.arm, '--seed', seed, '--jobs', '1', ...(ordewellRoot ? ['--ordewell-root', ordewellRoot] : []), ...(s.planOnly ? ['--plan-only'] : []), ...R.windowArgs(s)];
  fs.mkdirSync(rehearsals, { recursive: true });
  const log = path.join(rehearsals, `${seed}.log`);
  console.log(`\n== ${name}: ${s.about}\n   node bench/commit0/batch.mjs ${argv.join(' ')}\n   log: ${log}`);
  const startedAt = Date.now();
  const sizeBefore = resultsSize();
  const plansBefore = plansSize();
  const exit = await batch(argv, log);
  const { runDir, batchRecord } = findBatch(seed);
  const result = runDir ? JSON.parse(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8')) : null;
  const failures = R.judgeRehearsal(name, result);
  failures.push(...R.judgeBatch(batchRecord, { lib: only, arm: s.arm, rehearsal: name }));
  if (resultsSize() !== sizeBefore) failures.push(`${resultsFile} grew: a rehearsal's result was appended to the paid runs' results`);
  if (runDir) failures.push(...R.judgePlayed(name, turnsOf(path.join(runDir, 'rehearsal-requests.jsonl')), playCtx(libs, only)));
  if (runDir && s.planOnly) {
    const digestFile = path.join(runDir, 'plan.json');
    failures.push(...R.judgePlanOnlyDir({
      names: fs.readdirSync(runDir),
      digest: fs.existsSync(digestFile) ? JSON.parse(fs.readFileSync(digestFile, 'utf8')) : null,
      expectedTitles: s.plan().tasks.map((t) => t.title),
    }));
    if (plansSize() !== plansBefore) failures.push('plans.jsonl grew: a rehearsal\'s plan was appended to the plan-only results');
  }
  const left = leftovers();
  const stray = strays(before, left, seed);
  if (stray.length) failures.push(`left behind: ${stray.join(', ')}`);
  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
  outcome.push({ name, passed: failures.length === 0, failures, runDir, exit, minutes });
  console.log(failures.length ? `   FAIL (${minutes} min, batch exit ${exit})\n     - ${failures.join('\n     - ')}` : `   pass (${minutes} min)`);
  if (runDir) console.log(`   ${R.describeResult(result)}`);
}

console.log('\nRehearsal:');
for (const o of outcome) console.log(`  ${o.passed ? 'pass' : 'FAIL'}  ${o.name}${o.runDir ? `  ${o.runDir}` : ''}`);
process.exit(outcome.every((o) => o.passed) ? 0 : 1);
