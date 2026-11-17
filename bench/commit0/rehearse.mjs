#!/usr/bin/env node
/*
 * The rehearsal: every scenario of rehearsal.mjs through drive.mjs on a real
 * library image, the model a scripted fake in the box. It costs nothing and
 * goes before any paid run, since a dry run starts no agent and so cannot see
 * how the driver follows, stops and scores a live one.
 *
 *   node bench/commit0/rehearse.mjs --libs <libraries.json> [--only <library>] [--scenario a,b]
 *
 * Each scenario's result.json is judged against what the scenario expects,
 * and no box or network of the bench may be left behind. Exit 0 when all pass.
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
const names = (arg('--scenario') ?? R.scenarioNames().join(',')).split(',').filter(Boolean);
if (!libs) {
  console.error('usage: node bench/commit0/rehearse.mjs --libs <libraries.json> [--only <library>] [--scenario a,b]');
  process.exit(2);
}
for (const n of names) R.scenario(n);
const keys = R.realKeysIn(process.env);
if (keys.length) {
  console.error(`a rehearsal never runs with a real key in the environment: unset ${keys.join(', ')}`);
  process.exit(2);
}

const DRIVE = path.join(import.meta.dirname, 'drive.mjs');
const rehearsals = path.join(checkedBenchDir('commit0'), 'rehearsals');

/** The bench's boxes and networks: this rehearsal's must all be gone when it ends. */
function leftovers() {
  const ids = (kind) => execFileSync('docker', [kind, 'ls', '-q', ...(kind === 'container' ? ['-a'] : []), '--filter', 'label=commit0-bench=1'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  return { containers: ids('container'), networks: ids('network') };
}

function drive(argv, logFile) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [DRIVE, ...argv], { stdio: ['ignore', out, out] });
    child.on('exit', (code, signal) => { fs.closeSync(out); resolve(code ?? signal); });
  });
}

const before = leftovers();
const outcome = [];
for (const name of names) {
  const s = R.scenario(name);
  const seed = `rehearsal-${name}-${Date.now().toString(36)}`;
  const argv = ['--rehearse', name, '--libs', libs, '--only', only, '--arm', s.arm, '--seed', seed, ...R.windowArgs(s)];
  fs.mkdirSync(rehearsals, { recursive: true });
  const log = path.join(rehearsals, `${seed}.log`);
  console.log(`\n== ${name}: ${s.about}\n   node bench/commit0/drive.mjs ${argv.join(' ')}\n   log: ${log}`);
  const startedAt = Date.now();
  const exit = await drive(argv, log);
  const runDir = fs.readdirSync(rehearsals).find((d) => d.includes(seed) && fs.existsSync(path.join(rehearsals, d, 'result.json')));
  const result = runDir ? JSON.parse(fs.readFileSync(path.join(rehearsals, runDir, 'result.json'), 'utf8')) : null;
  const failures = R.judgeRehearsal(name, result);
  const left = leftovers();
  const stray = [...left.containers.filter((c) => !before.containers.includes(c)), ...left.networks.filter((n) => !before.networks.includes(n))];
  if (stray.length) failures.push(`left behind: ${stray.join(', ')}`);
  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
  outcome.push({ name, passed: failures.length === 0, failures, runDir: runDir ? path.join(rehearsals, runDir) : null, exit, minutes });
  console.log(failures.length ? `   FAIL (${minutes} min, driver exit ${exit})\n     - ${failures.join('\n     - ')}` : `   pass (${minutes} min)`);
  if (runDir) console.log(`   ${R.describeResult(result)}`);
}

console.log('\nRehearsal:');
for (const o of outcome) console.log(`  ${o.passed ? 'pass' : 'FAIL'}  ${o.name}${o.runDir ? `  ${o.runDir}` : ''}`);
process.exit(outcome.every((o) => o.passed) ? 0 : 1);
