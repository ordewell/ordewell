/** What the scale benchmarks share: the plan generator, the clocks, and a Session on a real disk. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const core = await import(pathToFileURL(path.join(here, '.build', 'core.mjs')).href).catch((err) => {
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
 * planner writes when work fans out and joins. `long`: a dag over the settled
 * tasks; of the rest, the first `ready` stand on what settled, and every one
 * after them on the first of those, so nothing past them is ready to start.
 */
function dependenciesOf(i, shape, id, done = 0, ready = 0) {
  if (shape === 'long' && i >= done) {
    if (i < done + ready) return done > 0 ? [id(done - 1)] : [];
    return [id(done)];
  }
  if (i === 0 || shape === 'wide') return [];
  if (shape === 'chain') return [id(i - 1)];
  const phase = Math.floor(i / 50);
  if (phase === 0) return [];
  const before = (phase - 1) * 50;
  return [id(before + (i * 7) % 50), id(before + (i * 13 + 3) % 50)].filter((d, at, all) => all.indexOf(d) === at);
}

/** Text of `chars` that differs from one use to the next, as a planner's and a runner's words do. */
function varied(chars, seed) {
  if (chars <= 0) return '';
  return `[${seed}] ${text(chars)}`.slice(0, chars);
}

const AT = '2026-10-20T19:19:52.056Z';

/** A digest as the plan keeps it (ADR-0047): its summary, its first findings, artifacts and the commit. */
function handoffOf(i, { handoffChars, findings }) {
  return {
    commit: { subject: `Change module ${i + 1} and verify it`, body: varied(220, `commit ${i}`) },
    summary: varied(handoffChars, `handoff ${i}`),
    findings: Array.from({ length: findings }, (_, f) => ({
      id: `F${f + 1}`, severity: f === 0 ? 'major' : 'minor', title: varied(90, `finding ${i}.${f}`), detail: varied(300, `detail ${i}.${f}`),
      evidence: [{ kind: 'file', path: `packages/core/src/services/Module${i}.ts`, line: 10 + f }],
    })),
    findingCount: findings,
    artifacts: [{ kind: 'file', path: `packages/core/src/services/Module${i}.ts` }, { kind: 'commit', sha: (i + 1).toString(16).padStart(12, 'a') }],
    attempt: 1,
  };
}

/** How many attempts the `i`th settled task took, so that over the plan they average `attempts`. */
const attemptsOf = (i, attempts) => 1 + Math.floor((i + 1) * (attempts - 1)) - Math.floor(i * (attempts - 1));

/**
 * `done` tasks completed before the run the benchmark looks at. Sizes are the
 * median of this repository's own saved sessions (real.mjs): a finished task
 * is about 11.5 KB of JSON, of it a 3 KB prompt, a 5 KB summary and a 1 KB
 * usage ledger, so a save weighs what a real one does. Those defaults are what
 * the other benchmarks were calibrated with. A long session (long.mjs) asks
 * for today's shape instead: the report in the attempt's log and a handoff
 * digest on the task (`reportChars: 0`, `handoffChars`, `findings`), a second
 * attempt on some (`attempts`, their mean), the skills an attempt was given on
 * a share of them (`skillShare`, `skillChars`), and words that differ from
 * task to task (`vary`). `ready` is the `long` shape's.
 */
export function makeTasks(n, { shape = 'dag', done = 0, ready = 0, promptChars = 2958, reportChars = 4800, handoffChars = 0, findings = 0, attempts = 1, skillShare = 0, skillChars = 0, vary = false } = {}) {
  const id = (i) => `t${String(i + 1).padStart(6, '0')}`;
  const prompt = text(promptChars);
  const report = text(reportChars);
  const reason = 'Verified: the runner reported completion through task_complete with status done.';
  const at = AT;
  const totals = { inputTokens: 324883, outputTokens: 2285, cachedInputTokens: 296379, reportedCost: { USD: 0.16 }, costProvenance: { USD: { kind: 'estimate', billing: 'subscription', basis: 'list' } } };
  const usageOf = (attempt) => ({
    attempt, runner: 'claude-code', startedAt: at, wallTimeMs: 68987, endedAt: at, totals,
    byModel: [{ source: 'claude-code', model: 'claude-sonnet-5-5', totals }],
    sessionBilling: { type: 'subscription', plan: 'Claude Max' }, source: 'claude-code', lastPromptTokens: 41415, contextWindow: 1000000, model: 'claude-sonnet-5-5', sessionId: '2ae84370-a459-44c0-a0b9-60b9d8961b1a',
  });
  // Spread evenly, so the share holds at any size.
  const skilled = (i) => skillShare > 0 && Math.floor((i + 1) * skillShare) > Math.floor(i * skillShare);
  return Array.from({ length: n }, (_, i) => {
    const finished = i < done;
    return core.createTask({
      id: id(i),
      order: i + 1,
      title: `Task ${i + 1}: change one module and verify it holds`,
      description: `Slice ${i + 1} of the plan, from the module it touches to the tests that cover it.`,
      prompt: vary ? varied(promptChars, `prompt ${i}`) : prompt,
      type: 'ai',
      status: finished ? 'completed' : 'pending',
      dependencies: dependenciesOf(i, shape, id, done, ready),
      assignedRunner: 'claude-code',
      assignedModel: { modelId: 'sonnet', modelLabel: 'Sonnet', thinkingEffort: 'medium', availableVariants: ['adaptive', 'low', 'medium', 'high', 'xhigh', 'max'] },
      taskMode: 'bypassPermissions',
      sliceType: 'AFK',
      ...(finished ? {
        attempted: true,
        verdict: { outcome: 'pass', reason, checks: [{ name: 'task_complete', passed: true, skipped: false, detail: 'the runner called task_complete with status done' }], decidedAt: at },
        outputSummary: { reviewReason: reason, ...(reportChars > 0 ? { report } : {}), logTail: '', capturedAt: at },
        ...(handoffChars > 0 ? { handoff: handoffOf(i, { handoffChars, findings }) } : {}),
        ...(skilled(i) ? { skills: ['tdd'], attemptSkills: [{ name: 'tdd', source: 'workspace', path: '.ordewell/skills/tdd/SKILL.md', content: varied(skillChars, `skill ${i}`) }] } : {}),
        runnerSessionId: '2ae84370-a459-44c0-a0b9-60b9d8961b1a',
        runnerSessionOwner: 'claude-code',
        attemptUsage: Array.from({ length: attemptsOf(i, attempts) }, (_, a) => usageOf(a + 1)),
      } : {}),
    });
  });
}

export function planOf(tasks, extra = {}) {
  const stamp = new Date().toISOString();
  return { tasks, generatedAt: stamp, status: 'approved', runners: ['claude-code'], lastUpdated: stamp, conversationHistory: [], ...extra };
}

/**
 * What a long planner conversation leaves in `conversationHistory`, `turns`
 * turns of it. The mix is this repository's longest saved session's: a third
 * of the turns answer the user and the rest a wake-up, two in five make a call
 * at the command seam, one in ten carries a host notice, and a compaction
 * checkpoint lands every `compactEvery` turns. A reply keeps its runs beside
 * its content, as a saved one does (ADR-0017 A1).
 */
export function conversationOf(turns, { userChars = 105, replyChars = 1300, wakeChars = 330, supervisorChars = 580, executionChars = 140, compactionChars = 17600, compactEvery = 130 } = {}) {
  const history = [];
  const at = (t) => new Date(Date.parse(AT) + t * 60_000).toISOString();
  const runsOf = (content, t) => [{ segmentId: `seg-${t}`, text: content, startedAt: at(t) }];
  for (let t = 0; t < turns; t++) {
    const timestamp = at(t);
    if (t % 3 === 0) {
      history.push({ role: 'user', content: varied(userChars, `user ${t}`), timestamp });
      const content = varied(replyChars, `reply ${t}`);
      history.push({ role: 'assistant', content, timestamp, runs: runsOf(content, t) });
    } else {
      history.push({ role: 'user', kind: 'wake_up', content: varied(wakeChars, `wake ${t}`), timestamp });
      const content = varied(supervisorChars, `supervisor ${t}`);
      history.push({ role: 'assistant', kind: 'supervisor', content, timestamp, runs: runsOf(content, t) });
    }
    if (t % 5 < 2) {
      const ref = (t % 280) + 1;
      const task = { id: `t${String(ref).padStart(6, '0')}`, ref: `#${ref}`, title: `Task ${ref}: change one module and verify it holds` };
      history.push({ role: 'assistant', kind: 'execution', content: `Retried #${ref} with a note.`, timestamp, execution: { command: 'retry_task', actor: 'supervisor', level: 'act', task, outcome: 'done', detail: varied(executionChars, `exec ${t}`), at: timestamp } });
    }
    if (t % 10 === 9) history.push({ role: 'assistant', kind: 'system', actor: 'Ordewell setting', content: 'Supervisor level set to Act.', timestamp });
    if (compactEvery > 0 && t % compactEvery === compactEvery - 1) {
      history.push({ role: 'assistant', kind: 'compaction', content: varied(compactionChars, `compaction ${t}`), timestamp, checkpoint: { id: `cp-${t}`, keptFrom: Math.max(0, history.length - 12), trigger: 'auto' } });
    }
  }
  return history;
}

/**
 * The planner's tool trace: `perTurn` entries a turn, the results the size
 * this repository's are by tool (a file read about 5 KB, a fetch or a
 * subagent's digest past 10 KB), times `resultScale`.
 */
export function researchLogOf(turns, { perTurn = 3.7, resultScale = 1 } = {}) {
  const tools = [['read_file', 4800], ['grep', 1600], ['agent_tool', 1800], ['bash', 1000], ['read_file', 4800], ['grep', 1600], ['agent_tool', 1800], ['glob', 650], ['fetch', 10700]];
  const log = [];
  for (let e = 0; e < Math.round(turns * perTurn); e++) {
    const timestamp = new Date(Date.parse(AT) + e * 15_000).toISOString();
    if (e % 100 === 50) {
      log.push({ id: `sub-${e}`, type: 'subagent', subagentId: `sa-${e}`, brief: varied(400, `brief ${e}`), outcome: 'done', digest: varied(Math.round(11000 * resultScale), `digest ${e}`), timestamp });
    } else if (e % 30 === 0) {
      log.push({ id: `prompt-${e}`, type: 'user_prompt', content: varied(200, `prompt ${e}`), timestamp });
    } else {
      const [tool, chars] = tools[e % tools.length];
      log.push({
        id: `step-${e}`, tool, ...(tool === 'agent_tool' ? { toolLabel: 'Read' } : {}), args: JSON.stringify({ path: `packages/core/src/services/Module${e % 300}.ts` }),
        result: varied(Math.round(chars * resultScale), `result ${e}`), success: true, outcome: 'success', toolCallId: `call-${e}`, timestamp,
      });
    }
  }
  return log;
}

/** The decision record a long planner conversation keeps (ADR-0067). */
export function decisionRecordOf(entries, chars = 380) {
  const kinds = ['decision', 'constraint', 'rejected', 'question'];
  return Array.from({ length: entries }, (_, e) => {
    const kind = kinds[e % kinds.length];
    return { id: `${kind[0].toUpperCase()}${Math.floor(e / 4) + 1}`, kind, text: varied(chars, `record ${e}`), ...(kind === 'decision' || kind === 'rejected' ? { why: varied(120, `why ${e}`) } : {}), at: e * 2, timestamp: AT };
  });
}

/**
 * The plan's isolation run as a long session keeps it: every settled task's
 * landing, and a record for the last `records` of them, landed and not yet
 * merged into the user's branch.
 */
export function isolationOf(tasks, workspace, records = 8) {
  const landed = tasks.filter((t) => t.status === 'completed');
  const tip = (i) => (i + 1).toString(16).padStart(40, '0');
  const ref = (t) => ({ taskId: t.id, order: t.order, title: t.title });
  const worktree = (t) => path.join(workspace, '.ordewell', 'worktrees', t.id);
  const run = {
    id: 'run-long', workspaceRoot: workspace,
    repos: [{ path: '.', root: workspace, baseRef: tip(0), baseBranch: 'main', integrationBranch: 'ordewell/run-long' }],
    shared: [], sharedRepos: [],
    tasks: Object.fromEntries(landed.slice(-records).map((t) => [t.id, {
      ...ref(t), branch: `ordewell/run-long/${t.id}`, workspace: worktree(t), status: 'merged',
      repos: { '.': { baseRef: tip(t.order), taskTip: tip(t.order + 1), worktree: worktree(t), linked: ['node_modules'], changed: true, landedTip: tip(t.order + 2) } },
      commit: { subject: `Change module ${t.order}`, body: 'Why it changed.' },
    }])),
    landings: Object.fromEntries(landed.map((t) => [t.id, { '.': [tip(t.order + 2)] }])),
    keepsEveryLanding: true,
    carried: {},
    landedTasks: Object.fromEntries(landed.map((t) => [t.id, { ...ref(t), commit: { subject: `Change module ${t.order}` } }])),
    landedOn: Object.fromEntries(landed.map((t) => [t.id, t.dependencies])),
  };
  return { run, resolvers: {} };
}

/**
 * Attempt logs on disk as a structured runner leaves them, through core's own
 * writer: `kb` of events per attempt in this repository's mix (thinking
 * deltas, tool calls and results, usage, text), a line about 500 bytes.
 * Returns the bytes written.
 */
export function writeAttemptLogs(location, tasks, kb) {
  let bytes = 0;
  for (const task of tasks) {
    for (const { attempt } of task.attemptUsage ?? []) {
      const events = [{ type: 'turn_start', message: 'Start the task.', startedAt: AT }];
      let size = 0;
      for (let e = 0; size < kb * 1024; e++) {
        const kind = e % 8;
        const event = kind < 4 ? { type: 'thinking_delta', text: varied(420, `${task.id} ${e}`) }
          : kind === 4 ? { type: 'tool_call', id: `call-${e}`, name: 'Read', args: JSON.stringify({ file_path: `src/m${e}.ts` }) }
            : kind === 5 ? { type: 'tool_result', id: `call-${e}`, output: varied(900, `${task.id} out ${e}`), success: true }
              : kind === 6 ? { type: 'usage', record: { source: 'claude-code', model: 'claude-sonnet-5-5', inputTokens: 41415, outputTokens: 228, cachedInputTokens: 39000 } }
                : { type: 'text', text: varied(300, `${task.id} said ${e}`) };
        size += JSON.stringify(event).length + 1;
        events.push(event);
      }
      events.push({ type: 'turn_end', reason: 'completed' });
      core.openTaskLog(location, task.id, attempt).append(events);
      bytes += size;
    }
  }
  return bytes;
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
  // Product code starts git.exe by name, which a batch shim cannot stand in for.
  if (process.platform === 'win32') throw new Error('--isolate counts git calls through a sh shim, which Windows does not start: measure it on Linux or macOS.');
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
export function hostSession({ runner, level = 'off', maxParallel = 3, broadcast = () => {}, workspace = tempWorkspace(), config = {}, aiService, sessionId }) {
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
      broadcast(msg, bytes);
    },
    modelResolver: resolver,
    settings: () => ({ run: { ...core.RUN_SETTINGS_DEFAULTS, supervisorLevel: level } }),
    sessionId: sessionId ?? `session-${Math.random().toString(16).slice(2, 10)}`,
    ...(aiService ? { aiService } : {}),
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
