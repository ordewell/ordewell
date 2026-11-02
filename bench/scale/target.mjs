#!/usr/bin/env node
// The laptop-scale target of ADR-0058, as one repeatable command: a tree's
// lifetime with tens of sessions live, and each operation at thousands of tasks.
// --checkout measures another checkout with that checkout's own scripts, so a
// before and an after come from the same command.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg, platform, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compareRuns, describeComparison, medianOf, parseOpsTable, unfinished } from './compare.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    checkout: { type: 'string', default: resolve(dirname(fileURLToPath(import.meta.url)), '../..') },
    out: { type: 'string' },
    repeats: { type: 'string', default: '3' },
    sessions: { type: 'string', default: '30' },
    tasks: { type: 'string', default: '2000' },
    rate: { type: 'string', default: '200' },
    events: { type: 'string', default: '8' },
    budget: { type: 'string', default: '400' },
    sizes: { type: 'string', default: '100,1000,5000' },
    compare: { type: 'boolean', default: false },
  },
});

if (values.compare) {
  if (positionals.length !== 2) throw new Error('--compare takes two result files: before, then after');
  const [before, after] = positionals.map((file) => JSON.parse(readFileSync(file, 'utf8')));
  console.log(describeComparison(compareRuns(before, after)).join('\n'));
  process.exit(0);
}

const checkout = resolve(values.checkout);
const scale = join(checkout, 'bench/scale');
if (!existsSync(join(scale, 'live.mjs'))) {
  console.error(`${checkout} has no bench/scale/live.mjs to measure with.`);
  process.exit(1);
}

const target = {
  sessions: Number(values.sessions),
  tasks: Number(values.tasks),
  rate: Number(values.rate),
  events: Number(values.events),
  budget: Number(values.budget),
  sizes: values.sizes.split(',').map(Number),
};

function node(args) {
  const done = spawnSync(process.execPath, args, { cwd: checkout, encoding: 'utf8', maxBuffer: 256 * 1024 ** 2, env: { ...process.env, ORDEWELL_DIRENV: 'false' } });
  if (done.status !== 0) throw new Error(`node ${args.join(' ')} exited ${done.status}:\n${done.stderr}`);
  return done.stdout;
}

const git = (...args) => spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).stdout.trim();

node([join(scale, 'build.mjs')]);

const repeats = [];
for (let i = 0; i < Number(values.repeats); i++) {
  const out = node(['--expose-gc', join(scale, 'live.mjs'),
    '--sessions', values.sessions, '--tasks', values.tasks, '--rate', values.rate,
    '--events', values.events, '--budget', values.budget, '--heap']);
  repeats.push(JSON.parse(out.trim().split('\n').at(-1)));
}

// ops.mjs reaches into core's internals, so an old checkout's can break on what it
// was never repaired for. The repeats above took minutes and do not depend on it.
function opsOf(problems) {
  try {
    return parseOpsTable(node([join(scale, 'ops.mjs'), '--sizes', values.sizes]));
  } catch (error) {
    problems.push(`ops.mjs measured nothing: ${error.message}`);
    return {};
  }
}

const problems = unfinished(target, repeats);
const run = {
  target,
  commit: `${git('rev-parse', '--short', 'HEAD')}${git('status', '--porcelain') ? '+changes' : ''}`,
  host: { platform: platform(), arch: arch(), cpus: cpus().length, memoryGb: Math.round(totalmem() / 1024 ** 3), node: process.version },
  load: loadavg(),
  repeats: repeats.length,
  live: medianOf(repeats),
  ops: opsOf(problems),
  problems,
};

if (values.out) writeFileSync(values.out, `${JSON.stringify(run, null, 2)}\n`);
console.log(values.out ? `wrote ${values.out}` : JSON.stringify(run, null, 2));
for (const problem of run.problems) console.error(problem);
process.exit(run.problems.length > 0 ? 1 : 0);
