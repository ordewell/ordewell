/** What the scale benchmarks share: the plan generator, the clocks, and a Session on a real disk. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const core = await import(path.join(here, '.build', 'core.mjs')).catch((err) => {
  console.error(`Run \`node bench/scale/build.mjs\` first (${err.message}).`);
  process.exit(2);
});

// ---------- arguments ----------

export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
export const flag = (name) => process.argv.includes(`--${name}`);
export const numbers = (name, fallback) => arg(name, fallback).split(',').map(Number);

// ---------- what core prints ----------

/**
 * The scheduler prints a line per excluded task on every tick. Muted, a
 * benchmark measures the work; with `sink` the lines go to a real file, as a
 * daemon's stdout does, and the writing is in the time.
 */
export function captureConsole() {
  const real = { log: console.log };
  const count = { lines: 0, bytes: 0, sink: null };
  const take = (...args) => {
    const line = `${args.map(String).join(' ')}\n`;
    count.lines += 1;
    count.bytes += line.length;
    if (count.sink !== null) fs.writeSync(count.sink, line);
  };
  console.log = take;
  console.warn = take;
  console.error = take;
  return { count, say: (...args) => real.log(...args) };
}

// ---------- clocks ----------

export const now = () => process.hrtime.bigint();
export const ms = (from) => Number(process.hrtime.bigint() - from) / 1e6;

/**
 * What `fn` costs, in ms, on a machine other work may be taking the CPU from.
 * Repeated until `budgetMs` is spent: the fastest run is the one nothing
 * preempted. A slow one runs once or twice, and its CPU time stands in for
 * that, which counts GC threads too, so the lesser of the two is reported.
 */
export async function timed(fn, budgetMs = 400, maxRuns = 200) {
  let fastest = Infinity;
  let runs = 0;
  const started = Date.now();
  const cpu = process.cpuUsage();
  do {
    const t = now();
    await fn();
    fastest = Math.min(fastest, ms(t));
    runs += 1;
  } while (Date.now() - started < budgetMs && runs < maxRuns);
  const used = process.cpuUsage(cpu);
  const cpuMs = (used.user + used.system) / 1000 / runs;
  return { ms: runs < 3 ? Math.min(fastest, cpuMs) : fastest, runs };
}

/** Least-squares slope of log(y) on log(x): the growth order between the sizes measured. */
export function order(xs, ys) {
  const points = xs.map((x, i) => [Math.log(x), Math.log(ys[i])]).filter(([, y]) => Number.isFinite(y));
  if (points.length < 2) return NaN;
  const mx = points.reduce((s, [x]) => s + x, 0) / points.length;
  const my = points.reduce((s, [, y]) => s + y, 0) / points.length;
  const num = points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0);
  const den = points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  return num / den;
}

export function table(say, title, sizes, rows) {
  say(`\n## ${title}`);
  say(`| operation | ${sizes.map((n) => `n=${n}`).join(' | ')} | order |`);
  say(`| --- | ${sizes.map(() => '---').join(' | ')} | --- |`);
  for (const { name, values, fmt = (v) => v.toFixed(2) } of rows) {
    const known = sizes.map((_, i) => values[i]);
    const seen = sizes.filter((_, i) => known[i] !== undefined);
    const fit = order(seen, known.filter((v) => v !== undefined));
    say(`| ${name} | ${known.map((v) => (v === undefined ? '-' : fmt(v))).join(' | ')} | ${Number.isNaN(fit) ? '-' : `n^${fit.toFixed(2)}`} |`);
  }
}

export const loadAverage = () => os.loadavg().map((v) => v.toFixed(1)).join(' ');

// ---------- plans ----------

const PROSE = 'Read the module, change what the task names, keep the surrounding idiom, run the tests that cover it, and report what changed and what was left. ';

function text(chars) {
  return PROSE.repeat(Math.ceil(chars / PROSE.length)).slice(0, chars);
}

/**
 * Dependencies by shape. `wide`: none. `chain`: each on the one before.
 * `dag`: phases of 50, each task on two of the phase before, the shape a
 * planner writes when work fans out and joins.
 */
function dependenciesOf(i, shape, id) {
  if (i === 0 || shape === 'wide') return [];
  if (shape === 'chain') return [id(i - 1)];
  const phase = Math.floor(i / 50);
  if (phase === 0) return [];
  const before = (phase - 1) * 50;
  return [id(before + (i * 7) % 50), id(before + (i * 13 + 3) % 50)].filter((d, at, all) => all.indexOf(d) === at);
}

/**
 * `done` tasks completed before the run the benchmark looks at. Sizes are the
 * median of this repository's own saved sessions (real.mjs): a finished task
 * is about 11.5 KB of JSON, of it a 3 KB prompt, a 5 KB summary and a 1 KB
 * usage ledger, so a save weighs what a real one does. A real session also
 * carries the planner's `researchLog` and transcript, which these plans do not.
 */
export function makeTasks(n, { shape = 'dag', done = 0, promptChars = 2958 } = {}) {
  const id = (i) => `t${String(i + 1).padStart(6, '0')}`;
  const prompt = text(promptChars);
  const report = text(4800);
  const reason = 'Verified: the runner reported completion through task_complete with status done.';
  const at = '2026-10-20T19:19:52.056Z';
  const totals = { inputTokens: 324883, outputTokens: 2285, cachedInputTokens: 296379, reportedCost: { USD: 0.16 }, costProvenance: { USD: { kind: 'estimate', billing: 'subscription', basis: 'list' } } };
  return Array.from({ length: n }, (_, i) => {
    const finished = i < done;
    return core.createTask({
      id: id(i),
      order: i + 1,
      title: `Task ${i + 1}: change one module and verify it holds`,
      description: `Slice ${i + 1} of the plan, from the module it touches to the tests that cover it.`,
      prompt,
      type: 'ai',
      status: finished ? 'completed' : 'pending',
      dependencies: dependenciesOf(i, shape, id),
      assignedRunner: 'claude-code',
      assignedModel: { modelId: 'sonnet', modelLabel: 'Sonnet', thinkingEffort: 'medium', availableVariants: ['adaptive', 'low', 'medium', 'high', 'xhigh', 'max'] },
      taskMode: 'bypassPermissions',
      sliceType: 'AFK',
      ...(finished ? {
        attempted: true,
        verdict: { outcome: 'pass', reason, checks: [{ name: 'task_complete', passed: true, skipped: false, detail: 'the runner called task_complete with status done' }], decidedAt: at },
        outputSummary: { reviewReason: reason, report, logTail: '', capturedAt: at },
        runnerSessionId: '2ae84370-a459-44c0-a0b9-60b9d8961b1a',
        runnerSessionOwner: 'claude-code',
        attemptUsage: [{
          attempt: 1, runner: 'claude-code', startedAt: at, wallTimeMs: 68987, endedAt: at, totals,
          byModel: [{ source: 'claude-code', model: 'claude-sonnet-5-5', totals }],
          sessionBilling: { type: 'subscription', plan: 'Claude Max' }, source: 'claude-code', lastPromptTokens: 41415, contextWindow: 1000000, model: 'claude-sonnet-5-5', sessionId: '2ae84370-a459-44c0-a0b9-60b9d8961b1a',
        }],
      } : {}),
    });
  });
}

export function planOf(tasks) {
  const stamp = new Date().toISOString();
  return { tasks, generatedAt: stamp, status: 'approved', runners: ['claude-code'], lastUpdated: stamp, conversationHistory: [] };
}

// ---------- the host ----------

/** A committed repository of `files` small files, the work a real run isolates. */
export function gitRepo(dir, files) {
  for (let i = 0; i < files; i += 1) {
    const folder = path.join(dir, 'src', `m${i % 50}`);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `f${i}.ts`), `export const value${i} = ${i};\n`.repeat(40));
  }
  const git = (...args) => execFileSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.com', ...args], { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'base');
}

/** Put a `git` first on PATH that writes its subcommand to the returned file before it runs the real one. */
export function countGit() {
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ordewell-scale-git-'));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\necho "$1" >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0);
}

export function tempWorkspace() {
  return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ordewell-scale-'));
}

/** Count the directory listings core makes: a status update can make one per task. */
export function countReaddirs() {
  const real = fs.readdirSync;
  const count = { calls: 0 };
  fs.readdirSync = (...args) => { count.calls += 1; return real(...args); };
  syncBuiltinESMExports();
  return count;
}

export const quietNotifications = { info() {}, warn() {}, error() {}, confirm: async () => {} };

const resolver = { getCachedRunnerModels: () => [], contextWindowFor: () => undefined, modelsForRunners: async () => ({}) };

/**
 * A real Session on real disk: its saves, lease and task logs are the
 * production ones. `stats` counts them; `muted` lets a benchmark reach a state
 * without paying for what it does not measure on the way.
 */
export function hostSession({ runner, level = 'off', maxParallel = 3, broadcast = () => {}, workspace = tempWorkspace(), config = {} }) {
  const stats = { saves: 0, saveBytes: 0, saveMs: 0, statusMessages: 0, statusBytes: 0, statusBuildMs: 0, otherBroadcasts: 0, otherBytes: 0, taskLogMessages: 0 };
  const muted = { saves: false, status: false };
  const session = core.createSession({
    config: core.fakeConfig({ maxParallelSessions: maxParallel, ...config }),
    notifications: quietNotifications,
    runner,
    registry: new core.RunnerRegistry(),
    workspaceRoot: () => workspace,
    fsAdapter: core.fakeFileSystem(),
    broadcast: (msg) => {
      // What the daemon's pool does with each one before it goes to a socket.
      const bytes = JSON.stringify(msg).length;
      if (msg.type === 'status_update') {
        stats.statusMessages += 1;
        stats.statusBytes += bytes;
      } else {
        stats.otherBroadcasts += 1;
        stats.otherBytes += bytes;
        if (msg.type === 'task_log') stats.taskLogMessages += 1;
      }
      broadcast(msg);
    },
    modelResolver: resolver,
    settings: () => ({ run: { ...core.RUN_SETTINGS_DEFAULTS, supervisorLevel: level } }),
    sessionId: `session-${Math.random().toString(16).slice(2, 10)}`,
  });
  // The default store, wrapped: a saveSession dependency would turn the lease off.
  const save = session.save;
  let file;
  session.save = (plan, goal, baseDir, id) => {
    if (muted.saves) return undefined;
    const t = now();
    const meta = save(plan, goal, baseDir, id);
    stats.saveMs += ms(t);
    stats.saves += 1;
    file ??= fs.readdirSync(path.join(baseDir, '.ordewell', 'sessions')).find((f) => f.endsWith('.json'));
    stats.saveBytes += fs.statSync(path.join(baseDir, '.ordewell', 'sessions', file)).size;
    return meta;
  };
  const relayStatus = session.events.status.bind(session.events);
  session.events.status = (plan) => {
    if (muted.status) return;
    const t = now();
    relayStatus(plan);
    stats.statusBuildMs += ms(t);
  };
  return { session, stats, muted, workspace, dropWorkspace: () => fs.rmSync(workspace, { recursive: true, force: true }) };
}

export function heapMb() {
  global.gc?.();
  global.gc?.();
  return process.memoryUsage().heapUsed / 1048576;
}
