#!/usr/bin/env node
/**
 * A long session as the daemon holds it: hundreds of tasks most of which
 * settled and landed, a planner conversation of hundreds of turns, and a few
 * tasks live beside them, measured as it loads, streams, saves, is edited and
 * talked to.
 *
 *   node --expose-gc bench/scale/long.mjs [--out run.json]       # the grid: settled 0, a third, all; turns 0, all
 *   node --expose-gc bench/scale/long.mjs --point [--settled 280 --turns 400]   # one point, one JSON line
 *   node bench/scale/long.mjs --compare before.json after.json
 *
 * Sizes: --tasks 300 --settled 280 --turns 400 --log-kb 178 --prompt-chars 2400
 *   --handoff-chars 1200 --findings 4 --attempts 1.5 --skill-share 0.33
 *   --skill-chars 1100 --research-per-turn 3.7 --decisions 150 --isolated 8, or
 *   --from <a .ordewell/sessions folder> [--from-session <id>] to take them from
 *   a saved session, read and never written, and nothing of it printed but sizes.
 * The run: --live 6 --events 120 --rate 6 --mutations 8 --planner-turns 4
 *   --host pool|core --budget 300 --checkout <dir>.
 *
 * `--host pool` (the default) opens the session through packages/web's
 * OrchestratorPool and subscribes one client to it, a socket that counts what it
 * is sent; `--host core` through hostSession, as the other benchmarks do, with
 * no wire. Neither opens a port, and each point runs in a process of its own
 * under a throwaway home.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    point: { type: 'boolean', default: false },
    generate: { type: 'string' },
    'sizes-json': { type: 'string' },
    compare: { type: 'boolean', default: false },
    out: { type: 'string' },
    checkout: { type: 'string' },
    from: { type: 'string' },
    'from-session': { type: 'string' },
    host: { type: 'string', default: 'pool' },
    tasks: { type: 'string' },
    settled: { type: 'string' },
    turns: { type: 'string' },
    'log-kb': { type: 'string' },
    'prompt-chars': { type: 'string' },
    'handoff-chars': { type: 'string' },
    findings: { type: 'string' },
    attempts: { type: 'string' },
    'skill-share': { type: 'string' },
    'skill-chars': { type: 'string' },
    'research-per-turn': { type: 'string' },
    decisions: { type: 'string' },
    isolated: { type: 'string' },
    live: { type: 'string', default: '6' },
    events: { type: 'string', default: '120' },
    rate: { type: 'string', default: '6' },
    mutations: { type: 'string', default: '8' },
    'planner-turns': { type: 'string', default: '4' },
    level: { type: 'string', default: 'off' },
    budget: { type: 'string', default: '300' },
  },
});

/** This repository's longest saved session, by median: what a long session is when nothing else is said. */
const DEFAULTS = {
  tasks: 300, settled: 280, turns: 400, logKb: 178, promptChars: 2400, handoffChars: 1200, findings: 4, attempts: 1.5,
  skillShare: 0.33, skillChars: 1100, researchPerTurn: 3.7, resultScale: 1, decisions: 150, isolated: 8,
  userChars: 105, replyChars: 1300, wakeChars: 330, supervisorChars: 580, compactionChars: 17600, compactEvery: 130,
};
const FLAGS = { tasks: 'tasks', settled: 'settled', turns: 'turns', logKb: 'log-kb', promptChars: 'prompt-chars', handoffChars: 'handoff-chars', findings: 'findings', attempts: 'attempts', skillShare: 'skill-share', skillChars: 'skill-chars', researchPerTurn: 'research-per-turn', decisions: 'decisions', isolated: 'isolated' };

// ---------- sizes from a saved session ----------

const median = (xs) => {
  const kept = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  return kept.length ? kept[Math.floor((kept.length - 1) / 2)] : 0;
};

/**
 * The sizes of a saved session, never its words: counts and median lengths,
 * read from the folder and nothing written there. The largest session is
 * taken unless `id` names one.
 */
function sizesFrom(folder, id) {
  const dir = fs.existsSync(path.join(folder, '.ordewell', 'sessions')) ? path.join(folder, '.ordewell', 'sessions') : folder;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  let chosen = null;
  for (const file of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
    if (!data?.meta?.id || !Array.isArray(data.plan?.tasks)) continue;
    if (id ? data.meta.id === id : (chosen === null || data.plan.tasks.length > chosen.plan.tasks.length)) chosen = data;
  }
  if (!chosen) throw new Error(`--from found no saved session${id ? ' with that id' : ''} in that folder`);
  const walk = (list, into = []) => { for (const t of list ?? []) { into.push(t); walk(t.subtasks, into); } return into; };
  const tasks = walk(chosen.plan.tasks);
  const settled = tasks.filter((t) => ['completed', 'skipped', 'failed'].includes(t.status));
  const history = chosen.plan.conversationHistory ?? [];
  const of = (pick) => median(history.filter(pick).map((e) => e.content.length));
  const replies = history.filter((e) => e.role === 'assistant' && (e.kind === undefined || e.kind === 'supervisor')).length;
  const compactions = history.filter((e) => e.kind === 'compaction').length;
  let research = [];
  try { research = JSON.parse(fs.readFileSync(path.join(dir, chosen.meta.id, 'research-log.json'), 'utf8')); } catch { research = chosen.plan.researchLog ?? []; }
  const steps = research.filter((e) => !('type' in e));
  const logs = [];
  for (const task of tasks) {
    for (const usage of task.attemptUsage ?? []) {
      try { logs.push(fs.statSync(path.join(dir, chosen.meta.id, 'tasks', task.id, `${usage.attempt}.jsonl`)).size / 1024); } catch { /* an attempt with no log */ }
    }
  }
  return {
    tasks: tasks.length,
    settled: settled.length,
    turns: replies,
    logKb: Math.round(median(logs)),
    promptChars: median(tasks.map((t) => t.prompt?.length ?? 0)),
    handoffChars: median(settled.map((t) => t.handoff?.summary?.length ?? 0)),
    findings: median(settled.map((t) => t.handoff?.findings?.length ?? 0)),
    attempts: +(settled.reduce((s, t) => s + (t.attemptUsage?.length ?? 0), 0) / Math.max(1, settled.length)).toFixed(2) || 1,
    skillShare: +(settled.filter((t) => t.attemptSkills?.length).length / Math.max(1, settled.length)).toFixed(2),
    skillChars: median(settled.flatMap((t) => (t.attemptSkills ?? []).map((s) => s.content.length))),
    researchPerTurn: +(research.length / Math.max(1, replies)).toFixed(2),
    // The generator's mix averages about 3 KB a step.
    resultScale: +(steps.reduce((s, e) => s + (e.result?.length ?? 0), 0) / Math.max(1, steps.length) / 3000).toFixed(2) || 1,
    decisions: (chosen.plan.decisionRecord ?? []).length,
    isolated: Object.keys(chosen.plan.isolation?.run?.tasks ?? {}).length,
    userChars: of((e) => e.role === 'user' && !e.kind) || DEFAULTS.userChars,
    replyChars: of((e) => e.role === 'assistant' && !e.kind) || DEFAULTS.replyChars,
    wakeChars: of((e) => e.kind === 'wake_up') || DEFAULTS.wakeChars,
    supervisorChars: of((e) => e.kind === 'supervisor') || DEFAULTS.supervisorChars,
    compactionChars: of((e) => e.kind === 'compaction') || DEFAULTS.compactionChars,
    compactEvery: compactions > 0 ? Math.round(replies / compactions) : 0,
  };
}

function sizes() {
  if (opt['sizes-json']) return JSON.parse(opt['sizes-json']);
  const base = opt.from ? { ...DEFAULTS, ...sizesFrom(opt.from, opt['from-session']) } : { ...DEFAULTS };
  for (const [key, flag] of Object.entries(FLAGS)) if (opt[flag] !== undefined) base[key] = Number(opt[flag]);
  base.settled = Math.min(base.settled, base.tasks);
  return base;
}

// ---------- one point ----------

const percentile = (xs, p) => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};
const r1 = (v) => +v.toFixed(1);
const r2 = (v) => +v.toFixed(2);
const kb = (bytes) => r1(bytes / 1024);
const mb = (bytes) => r2(bytes / 1048576);

/** A home of its own and the daemon's settings by environment, before core is loaded: nothing of the user's is read or written. */
function sealProcess(live) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ordewell-long-home-'));
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    ORDEWELL_DIRENV: 'false', ORDEWELL_MAX_PARALLEL: String(Math.max(1, live)), ORDEWELL_WORKTREE_ISOLATION: 'false', ORDEWELL_ENABLED_RUNNERS: 'claude-code',
    // The planner gate asks for a key and a model; the turns themselves go to the fake below.
    OPENROUTER_API_KEY: 'bench-not-a-key', ORCHESTRATOR_MODEL: 'bench/planner',
  });
  return home;
}

/** A planner that streams a little of what a real one does and answers in words, with a research step of its own. */
function fakePlanner(replyChars, resultChars) {
  const said = 'Reading where the run stands before answering. ';
  const reply = 'The run holds: the tasks that landed are merged, and the live ones are on their way. '.repeat(Math.ceil(replyChars / 84)).slice(0, replyChars);
  let calls = 0;
  const turn = async (_message, progress) => {
    calls += 1;
    const pause = () => new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 20; i++) { progress?.({ type: 'thinking', text: said }); await pause(); }
    const toolCallId = `bench-call-${calls}`;
    const step = { id: `bench-step-${calls}`, tool: 'read_file', args: JSON.stringify({ path: 'packages/core/src/services/PlanStore.ts' }), result: said.repeat(Math.ceil(resultChars / said.length)).slice(0, resultChars), success: true, outcome: 'success', toolCallId, timestamp: new Date().toISOString() };
    progress?.({ type: 'tool_call', tool: 'read_file', toolArgs: step.args, toolCallId });
    await pause();
    progress?.({ type: 'tool_result', step, toolCallId });
    for (let at = 0; at < reply.length; at += 200) { progress?.({ type: 'text_delta', segmentId: `bench-seg-${calls}`, text: reply.slice(at, at + 200) }); await pause(); }
    return { kind: 'message', text: reply, researchLog: [step] };
  };
  return {
    startConversation: (req) => turn(req.initialMessage ?? req.goal, req.onProgress),
    continueConversation: (message, progress) => turn(message, progress),
    hasActiveConversation: () => true,
    reset() {}, restart() {},
  };
}

/** One client of the daemon's socket: counts each frame by its type, and its bytes. */
function countingClient() {
  const byType = new Map();
  const frames = [];
  const count = (type, bytes) => {
    const entry = byType.get(type) ?? { frames: 0, bytes: 0 };
    entry.frames += 1;
    entry.bytes += bytes;
    byType.set(type, entry);
    frames.push([type, bytes]);
  };
  const client = {
    OPEN: 1, readyState: 1,
    send(payload) { count(/^\{"type":"([^"]+)"/.exec(payload)?.[1] ?? JSON.parse(payload).type, payload.length); },
    close() { client.readyState = 3; },
    on() {}, once() {}, off() {},
  };
  return { client, count, byType, frames };
}

/** Write the long session `s` describes into `workspace`, and say what was written. */
async function generate(workspace, s) {
  const lib = await import('./lib.mjs');
  const { core, ms, now } = lib;
  const { say } = lib.captureConsole();
  const sessionId = 'session-long0001';
  const started = now();
  const tasks = lib.makeTasks(s.tasks, {
    shape: 'long', done: s.settled, ready: s.live, vary: true, promptChars: s.promptChars, reportChars: 0,
    handoffChars: s.handoffChars, findings: s.findings, attempts: s.attempts, skillShare: s.skillShare, skillChars: s.skillChars,
  });
  const plan = lib.planOf(tasks, {
    conversationHistory: lib.conversationOf(s.turns, s),
    researchLog: lib.researchLogOf(s.turns, { perTurn: s.researchPerTurn, resultScale: s.resultScale }),
    decisionRecord: lib.decisionRecordOf(s.decisions),
    ...(s.settled > 0 && s.isolated > 0 ? { isolation: lib.isolationOf(tasks, workspace, s.isolated) } : {}),
    approvedTasks: tasks.slice(0, s.settled).map((t) => t.id),
    runSettings: { mergeAtGatesAutomatically: false, supervisorLevel: opt.level, supervisorRetryLimit: 2, wakeUpReadBudget: 12 },
    plannerUsage: { totals: { inputTokens: s.turns * 41000, outputTokens: s.turns * 900, cachedInputTokens: s.turns * 36000 }, source: 'claude-code', model: 'claude-opus-5-5', lastPromptTokens: 120000, contextWindow: 1000000 },
  });
  core.saveSession(plan, 'Carry the long plan through to the end', workspace, sessionId);
  const logBytes = lib.writeAttemptLogs({ baseDir: workspace, sessionId }, tasks.slice(0, s.settled), s.logKb);
  say(JSON.stringify({ ms: ms(started), logBytes, history: plan.conversationHistory.length, research: plan.researchLog.length }));
  process.exit(0);
}

async function point() {
  const s = sizes();
  const live = Math.min(Number(opt.live), s.tasks - s.settled);
  const home = sealProcess(live);
  const lib = await import('./lib.mjs');
  const { core, heapMb, ms, now } = lib;
  const { LoadGen, mcpServerWithoutPort } = await import('./mcp.mjs');
  const { Swarm } = await import('./swarm.mjs');
  const { say } = lib.captureConsole();
  const host = opt.host;
  if (!['pool', 'core'].includes(host)) throw new Error('--host is pool or core');

  // ---- the session on disk, as a daemon finds it, written by another process so none of it is in this heap ----
  const workspace = lib.tempWorkspace();
  const sessionId = 'session-long0001';
  const made = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--generate', workspace, '--sizes-json', JSON.stringify({ ...s, live }), '--level', opt.level], { encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 ** 2 });
  if (made.status !== 0) throw new Error(`generating the session failed:\n${made.stderr}`);
  const generated = JSON.parse(made.stdout.trim().split('\n').at(-1));
  const dir = path.join(workspace, '.ordewell', 'sessions');
  const sessionFile = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.json')));
  const researchFile = path.join(dir, sessionId, 'research-log.json');
  const fileBytes = () => fs.statSync(sessionFile).size;
  const researchBytes = () => (fs.existsSync(researchFile) ? fs.statSync(researchFile).size : 0);
  const out = {
    sizes: { tasks: s.tasks, settled: s.settled, turns: s.turns, live, history: generated.history, research: generated.research },
    disk: { sessionFileKb: kb(fileBytes()), researchLogKb: kb(researchBytes()), logsMb: mb(generated.logBytes), generatedS: r1(generated.ms / 1000) },
  };

  // ---- the runners, as live.mjs has them ----
  const server = mcpServerWithoutPort();
  const load = new LoadGen(server, Math.max(1, live), 1);
  const swarm = new Swarm({ rate: Number(opt.rate), eventsPerSession: Number(opt.events), mcp: load, hold: true });
  const fakeClaude = fileURLToPath(new URL('../pipeline/fake-claude', import.meta.url));
  const runner = new core.StructuredRunner({
    process: { spawn: swarm.spawn, exists: () => true, platform: 'linux', resolvePath: async () => [process.env.PATH, fakeClaude].join(path.delimiter), isDirectory: () => true },
    mcp: server,
    interruptGraceMs: 200,
  });
  const planner = fakePlanner(1300, 4800);
  const wire = countingClient();

  const baseHeap = heapMb();
  const baseRss = process.memoryUsage().rss;

  // ---- the load: parsed alone, then opened as the host opens it ----
  let t = now();
  let parsed = core.loadSession(sessionId, workspace);
  out.load = { parseMs: r1(ms(t)) };
  if (!parsed) throw new Error('the generated session did not load');
  out.load.parsedHeapMb = r1(heapMb() - baseHeap);
  parsed = null;
  heapMb();

  let session;
  let pool;
  t = now();
  if (host === 'pool') {
    pool = new core.OrchestratorPool({
      runner,
      // No catalog is asked for: no CLI is started, and no request leaves the process.
      modelResolver: new core.ModelResolver(new core.RunnerRegistry(), core.fakeConfig(), { execImpl: async () => ({ stdout: '' }), fetchImpl: async () => { throw new Error('no network in a sealed run'); } }),
      runnerInstallation: { filterInstalled: async (ids) => ids.filter((id) => id === 'claude-code'), plannerUsability: async () => ({ usable: true }), runnerUsability: async () => ({ usable: true }) },
      codexSandbox: { ensure: async () => {}, refresh: async () => {} },
      isolationPreview: { preview: async () => ({ status: 'disabled', repos: [], shared: [] }) },
      accountLimitCollectors: () => [],
    });
    pool.adoptSavedSession(sessionId, workspace);
    session = pool.session(sessionId, workspace);
  } else {
    const saved = core.loadSession(sessionId, workspace);
    const hosted = lib.hostSession({ runner, level: opt.level, maxParallel: Math.max(1, live), workspace, aiService: planner, sessionId, broadcast: (msg, bytes) => wire.count(msg.type, bytes) });
    session = hosted.session;
    session.loadPlan(saved.plan, saved.meta.goal, workspace, { sessionId });
  }
  out.load.openMs = r1(ms(t));
  // A load adopts its isolation run after it returns: let that settle before the heap is read.
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  if (host === 'pool') {
    // The turns go to the fake: the pool builds its planner from the config, which here has no real one.
    session.backend.current = () => planner;
    pool.subscribe(sessionId, wire.client, workspace);
  }
  out.heap = { baselineMb: r1(baseHeap), afterLoadMb: r1(heapMb()), heldMb: 0 };
  out.heap.heldMb = r1(out.heap.afterLoadMb - out.heap.baselineMb);
  out.rss = { baselineMb: Math.round(baseRss / 1048576), afterLoadMb: Math.round(process.memoryUsage().rss / 1048576) };

  // ---- what the run pays, measured where the Session pays it ----
  const saves = [];
  const save = session.save;
  session.save = (...args) => {
    const at = now();
    const meta = save(...args);
    saves.push({ ms: ms(at), bytes: fileBytes() });
    return meta;
  };
  const statuses = [];
  const status = session.events.status.bind(session.events);
  session.events.status = (p) => {
    const before = wire.byType.get('status_update')?.frames ?? 0;
    const at = now();
    status(p);
    const spent = ms(at);
    const sent = wire.frames.length;
    if ((wire.byType.get('status_update')?.frames ?? 0) > before) statuses.push({ ms: spent, bytes: wire.frames.findLast(([type]) => type === 'status_update')?.[1] ?? 0, sent });
  };
  const broadcasts = [];
  const planGenerated = session.events.planGenerated.bind(session.events);
  session.events.planGenerated = (...args) => {
    const at = now();
    planGenerated(...args);
    broadcasts.push({ ms: ms(at), bytes: wire.frames.findLast(([type]) => type === 'plan_generated')?.[1] ?? 0 });
  };

  const LAG_RESOLUTION_MS = 10;
  const lag = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
  // The histogram holds each sample's whole interval: what the loop owes is past the interval.
  const lagMs = (ns) => r1(Math.max(0, ns / 1e6 - LAG_RESOLUTION_MS));
  const sleep = (wait) => new Promise((resolve) => setTimeout(resolve, wait));
  const deadline = Date.now() + Number(opt.budget) * 1000;
  const expired = () => Date.now() > deadline;
  const problems = [];

  const liveIds = Array.from({ length: live }, (_, i) => `t${String(s.settled + i + 1).padStart(6, '0')}`);
  for (const task of liveIds) {
    const outcome = await session.execute({ command: 'run_task', task }, { kind: 'user' });
    if (outcome && outcome.ok === false) problems.push(`run_task ${task}: ${outcome.message ?? JSON.stringify(outcome)}`);
  }
  while (swarm.active.size < live && !expired()) await sleep(20);

  const framesAtGo = wire.frames.length;
  const typesAtGo = new Map([...wire.byType].map(([type, e]) => [type, { ...e }]));
  const savesAtGo = saves.length;
  const statusesAtGo = statuses.length;
  const broadcastsAtGo = broadcasts.length;
  lag.enable();
  const cpu = process.cpuUsage();
  const streamed = now();
  swarm.go();

  // Edits and planner turns spread over the time the stream is expected to take.
  const streamMs = (Number(opt.events) / Number(opt.rate)) * 1000;
  const mutationTimes = [];
  const mutationBytes = [];
  const sentSince = (from) => wire.frames.slice(from).reduce((sum, [, bytes]) => sum + bytes, 0);
  const turnTimes = [];
  const idle = tasksIdle(session, liveIds);
  const edits = editsOf(session, idle);
  const mutationCount = Number(opt.mutations);
  const turnCount = Number(opt['planner-turns']);
  const work = [
    ...Array.from({ length: mutationCount }, (_, k) => ({ at: (streamMs * (k + 0.5)) / mutationCount, run: async () => { const [at, from] = [now(), wire.frames.length]; const ok = await edits(k); mutationTimes.push(ms(at)); mutationBytes.push(sentSince(from)); if (!ok) problems.push(`edit ${k} changed nothing`); } })),
    ...Array.from({ length: turnCount }, (_, k) => ({ at: (streamMs * (k + 0.25)) / turnCount, run: async () => { const at = now(); await session.continueConversation(`How does the run stand, after ${k + 1} checks?`); turnTimes.push(ms(at)); } })),
  ].sort((a, b) => a.at - b.at);
  const driven = (async () => {
    for (const step of work) {
      const wait = step.at - ms(streamed);
      if (wait > 0) await sleep(wait);
      if (expired()) break;
      try { await step.run(); } catch (err) { problems.push(`${err.message}`); }
    }
  })();
  while ((swarm.finished < live || mutationTimes.length + turnTimes.length < work.length) && !expired()) await sleep(50);
  await Promise.race([driven, sleep(1000)]);
  const elapsed = ms(streamed);
  lag.disable();
  const used = process.cpuUsage(cpu);
  if (swarm.finished < live) problems.push(`finished ${swarm.finished} of ${live} live tasks`);
  if (load.failures > 0) problems.push(`${load.failures} failed MCP calls`);

  const inRun = saves.slice(savesAtGo);
  const statusRun = statuses.slice(statusesAtGo);
  const wholePlan = broadcasts.slice(broadcastsAtGo);
  out.stream = { s: r1(elapsed / 1000), events: swarm.events, cpuS: r1((used.user + used.system) / 1e6) };
  out.lag = { p50: lagMs(lag.percentile(50)), p99: lagMs(lag.percentile(99)), max: lagMs(lag.max) };
  out.status = {
    updates: statusRun.length, perMin: r1(statusRun.length / (elapsed / 60000)),
    msP50: r2(percentile(statusRun.map((x) => x.ms), 0.5)), msP99: r2(percentile(statusRun.map((x) => x.ms), 0.99)), msMax: r2(Math.max(0, ...statusRun.map((x) => x.ms))),
    kbP50: kb(percentile(statusRun.map((x) => x.bytes), 0.5)), kbMax: kb(Math.max(0, ...statusRun.map((x) => x.bytes))),
    mb: mb(statusRun.reduce((sum, x) => sum + x.bytes, 0)),
  };
  out.saves = {
    count: inRun.length, perMin: r1(inRun.length / (elapsed / 60000)),
    msP50: r2(percentile(inRun.map((x) => x.ms), 0.5)), msMax: r2(Math.max(0, ...inRun.map((x) => x.ms))),
    kbP50: kb(percentile(inRun.map((x) => x.bytes), 0.5)), mb: mb(inRun.reduce((sum, x) => sum + x.bytes, 0)),
  };
  out.mutations = {
    count: mutationTimes.length, msP50: r2(percentile(mutationTimes, 0.5)), msMax: r2(Math.max(0, ...mutationTimes)), sentKbP50: kb(percentile(mutationBytes, 0.5)),
    wholePlanBroadcasts: wholePlan.length, broadcastMsP50: r2(percentile(wholePlan.map((x) => x.ms), 0.5)), broadcastKbP50: kb(percentile(wholePlan.map((x) => x.bytes), 0.5)),
  };
  out.planner = { turns: turnTimes.length, msP50: r1(percentile(turnTimes, 0.5)), msMax: r1(Math.max(0, ...turnTimes)) };

  // What a surface joining now is sent first: every task's status, whole.
  let whole;
  t = now();
  whole = session.events.statusMessage();
  out.join = { statusMs: r2(ms(t)), statusKb: kb(JSON.stringify(whole).length), planKb: kb(JSON.stringify(core.serializePlan({ ...session.planState, tasks: session.store.snapshot() })).length) };
  whole = null;

  if (host === 'pool') {
    const types = {};
    for (const [type, entry] of wire.byType) {
      const before = typesAtGo.get(type) ?? { frames: 0, bytes: 0 };
      if (entry.frames > before.frames) types[type] = { frames: entry.frames - before.frames, kb: kb(entry.bytes - before.bytes) };
    }
    const runFrames = wire.frames.slice(framesAtGo);
    out.wire = { frames: runFrames.length, mb: mb(runFrames.reduce((sum, [, bytes]) => sum + bytes, 0)), perS: r1(runFrames.length / (elapsed / 1000)), types };
  }
  out.heap.endMb = r1(heapMb());
  out.heap.growthMb = r1(out.heap.endMb - out.heap.afterLoadMb);
  out.rss.endMb = Math.round(process.memoryUsage().rss / 1048576);
  out.rss.peakMb = Math.round(process.resourceUsage().maxRSS / 1024);
  out.disk.sessionFileKbEnd = kb(fileBytes());
  out.problems = problems;
  say(JSON.stringify(out));
  swarm.stop();
  await load.stop();
  await lib.closeSession(session, pool ? () => pool.destroy(sessionId) : undefined);
  lib.removeDir(workspace);
  lib.removeDir(home);
  process.exit(0);
}

/** The tasks no run will touch: pending, not live, standing on a live one. */
function tasksIdle(session, liveIds) {
  return session.planTasks.filter((task) => task.status === 'pending' && !liveIds.includes(task.id)).map((task) => task.id);
}

/**
 * The edits a person or a planner makes mid-run, in turn: a task's words, a
 * task added and removed, a dependency moved. Each is a whole-plan broadcast.
 */
function editsOf(session, idle) {
  let added = null;
  return async (k) => {
    const target = idle[k % Math.max(1, idle.length)];
    switch (k % 4) {
      case 0: return target ? !!(await session.updateTask(target, { description: `Edited mid-run, ${k + 1}: from the module it touches to the tests.` })) : false;
      case 1: {
        const before = new Set(session.planTasks.map((t) => t.id));
        const done = await session.addTask({ title: `Added mid-run ${k + 1}`, description: 'A follow-up the run turned up.', type: 'ai', prompt: 'Follow up on what the run turned up.', assignedRunner: 'claude-code', dependencies: target ? [target] : [] });
        added = session.planTasks.find((t) => !before.has(t.id))?.id ?? null;
        return !!done;
      }
      case 2: return added ? !!(await session.removeTask(added)) : false;
      default: return target ? !!(await session.setTaskDependencies(target, [])) : false;
    }
  };
}

// ---------- the grid ----------

/** Least-squares slope of y on x. */
function slope(xs, ys) {
  const points = xs.map((x, i) => [x, ys[i]]).filter(([, y]) => Number.isFinite(y));
  if (points.length < 2) return null;
  const mx = points.reduce((sum, [x]) => sum + x, 0) / points.length;
  const my = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
  const den = points.reduce((sum, [x]) => sum + (x - mx) ** 2, 0);
  return den === 0 ? null : points.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0) / den;
}

function flatten(value, prefix = '') {
  return Object.entries(value).flatMap(([key, inner]) => {
    if (typeof inner === 'number') return [[`${prefix}${key}`, inner]];
    return inner && typeof inner === 'object' && !Array.isArray(inner) ? flatten(inner, `${prefix}${key}.`) : [];
  });
}

/** The points: settled 0, a third and all at the full conversation, and the full plan with no conversation. */
function gridOf(s) {
  const third = Math.round(s.settled / 3);
  const settledPoints = [...new Set([0, third, s.settled])];
  const points = settledPoints.map((settled) => ({ settled, turns: s.turns }));
  if (s.turns > 0) points.push({ settled: s.settled, turns: 0 });
  return points;
}

const labelOf = ({ settled, turns }) => `settled=${settled} turns=${turns}`;

/** The figures a fix is judged by, first in the table. */
const HEADLINE = ['heap.heldMb', 'heap.growthMb', 'rss.afterLoadMb', 'status.msP50', 'status.kbP50', 'saves.msP50', 'saves.kbP50', 'mutations.broadcastKbP50', 'lag.p99', 'load.openMs'];

function grid() {
  const s = sizes();
  const checkout = path.resolve(opt.checkout ?? path.join(here, '../..'));
  const scale = path.join(checkout, 'bench/scale');
  if (!fs.existsSync(path.join(scale, 'long.mjs'))) {
    console.error(`${checkout} has no bench/scale/long.mjs to measure with.`);
    process.exit(1);
  }
  const node = (args) => {
    const done = spawnSync(process.execPath, args, { cwd: checkout, encoding: 'utf8', maxBuffer: 256 * 1024 ** 2, env: { ...process.env, ORDEWELL_DIRENV: 'false' } });
    if (done.status !== 0) throw new Error(`node ${args.join(' ')} exited ${done.status}:\n${done.stderr}`);
    return done.stdout;
  };
  node([path.join(scale, 'build.mjs')]);
  // Each point is given every size outright: --from is read here once, and its folder never reaches a child.
  const passed = ['host', 'live', 'events', 'rate', 'mutations', 'planner-turns', 'level', 'budget'].flatMap((name) => ['--' + name, String(opt[name])]);
  const points = gridOf(s);
  const results = {};
  for (const p of points) {
    const line = node(['--expose-gc', path.join(scale, 'long.mjs'), '--point', ...passed, '--sizes-json', JSON.stringify({ ...s, ...p })]);
    results[labelOf(p)] = JSON.parse(line.trim().split('\n').at(-1));
    process.stderr.write(`[${labelOf(p)}: heap held ${results[labelOf(p)].heap.heldMb} MB, stream ${results[labelOf(p)].stream.s}s]\n`);
  }
  const bySettled = points.filter((p) => p.turns === s.turns);
  const byTurns = points.filter((p) => p.settled === s.settled);
  const names = [...new Set(points.flatMap((p) => flatten(results[labelOf(p)]).map(([name]) => name)))];
  const valueOf = (p, name) => new Map(flatten(results[labelOf(p)])).get(name);
  const slopes = { perHundredSettled: {}, perHundredTurns: {} };
  for (const name of names) {
    const a = slope(bySettled.map((p) => p.settled), bySettled.map((p) => valueOf(p, name)));
    const b = slope(byTurns.map((p) => p.turns), byTurns.map((p) => valueOf(p, name)));
    // Below a millionth is rounding left in the fit, not a slope.
    const fit = (v) => (Math.abs(v) < 1e-6 ? 0 : +(v * 100).toPrecision(3));
    if (a !== null) slopes.perHundredSettled[name] = fit(a);
    if (b !== null) slopes.perHundredTurns[name] = fit(b);
  }
  const git = (...args) => spawnSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).stdout.trim();
  const run = {
    kind: 'long',
    target: { ...s, live: Number(opt.live), events: Number(opt.events), rate: Number(opt.rate), mutations: Number(opt.mutations), plannerTurns: Number(opt['planner-turns']), level: opt.level, host: opt.host, fromSaved: !!opt.from },
    commit: `${git('rev-parse', '--short', 'HEAD')}${git('status', '--porcelain') ? '+changes' : ''}`,
    host: { platform: os.platform(), arch: os.arch(), cpus: os.cpus().length, memoryGb: Math.round(os.totalmem() / 1024 ** 3), node: process.version },
    load: os.loadavg(),
    long: { ...Object.fromEntries(points.map((p) => [labelOf(p), results[labelOf(p)]])), slope: slopes },
    problems: points.flatMap((p) => (results[labelOf(p)].problems ?? []).map((problem) => `${labelOf(p)}: ${problem}`)),
  };

  const ordered = [...HEADLINE.filter((name) => names.includes(name)), ...names.filter((name) => !HEADLINE.includes(name))];
  const fmt = (v) => (v === undefined || v === null ? '-' : String(v));
  console.log(`# long session: ${s.tasks} tasks, ${opt.live} live, host ${opt.host}${opt.from ? ', sizes from a saved session' : ''}, node ${process.version}, commit ${run.commit}`);
  console.log(`| figure | ${points.map(labelOf).join(' | ')} | per 100 settled | per 100 turns |`);
  console.log(`| --- | ${points.map(() => '---').join(' | ')} | --- | --- |`);
  for (const name of ordered) console.log(`| ${name} | ${points.map((p) => fmt(valueOf(p, name))).join(' | ')} | ${fmt(slopes.perHundredSettled[name])} | ${fmt(slopes.perHundredTurns[name])} |`);
  if (opt.out) fs.writeFileSync(opt.out, `${JSON.stringify(run, null, 2)}\n`);
  console.log(opt.out ? `wrote ${opt.out}` : JSON.stringify(run));
  for (const problem of run.problems) console.error(problem);
  process.exit(run.problems.length > 0 ? 1 : 0);
}

if (opt.compare) {
  const { compareRuns, describeComparison } = await import('./compare.mjs');
  if (positionals.length !== 2) throw new Error('--compare takes two result files: before, then after');
  const [before, after] = positionals.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
  console.log(describeComparison(compareRuns(before, after)).join('\n'));
} else if (opt.generate) {
  await generate(opt.generate, sizes());
} else if (opt.point) {
  await point();
} else {
  grid();
}
