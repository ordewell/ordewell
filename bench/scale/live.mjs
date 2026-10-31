#!/usr/bin/env node
/**
 * N sessions live at once in one Session, through the whole pipeline but for
 * the processes (see swarm.mjs): spawn, attach, stream, task_complete over
 * HTTP, verdict, save, next.
 *
 *   node --expose-gc bench/scale/live.mjs --sessions 100 [--tasks 100] [--rate 5]
 *     [--events 40] [--level off] [--budget 180] [--counterfactual no-view]
 *     [--heap] [--text-kb 0] [--attach-ms 0] [--isolate] [--files 1000] [--progress]
 *     [--fast-ramp]
 *
 * One JSON line comes out. `--counterfactual no-view` stubs the status broadcast
 * and every save off: what is left is the event path alone, the rate the rest
 * could carry once those stop costing what they do. It measures no fix anyone
 * wrote. `--fast-ramp` does that only while the sessions come up, so a steady
 * state at a size whose ramp would take too long can be measured as shipped.
 *
 * `--rate 1.6` is what this repository's real attempts report: one usage event
 * in 18 here makes 0.09 a second, their median.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import path from 'node:path';
import { arg, captureConsole, core, countGit, flag, gitRepo, heapMb, hostSession, loadAverage, makeTasks, ms, now, planOf, tempWorkspace } from './lib.mjs';
import { LoadGen, mcpServerWithoutPort, percentile } from './mcp.mjs';
import { pulseReporter } from './pulse.mjs';
import { Swarm } from './swarm.mjs';

const { say } = captureConsole();
const sessions = Number(arg('sessions', '100'));
const tasks = Number(arg('tasks', String(sessions)));
const rate = Number(arg('rate', '5'));
const eventsPerSession = Number(arg('events', '40'));
const level = arg('level', 'off');
const budget = Number(arg('budget', '170'));
const counterfactual = arg('counterfactual', '');
const isolate = flag('isolate');

const pulse = new Int32Array(new SharedArrayBuffer(24));
if (flag('progress')) pulseReporter(pulse.buffer, ['spawned', 'live', 'finished', 'events', 'status'], 10).unref();
const gitCalls = isolate ? countGit() : () => 0;

const lag = monitorEventLoopDelay({ resolution: 10 });
const lagNow = () => ({ p50: +(lag.percentile(50) / 1e6).toFixed(1), p99: +(lag.percentile(99) / 1e6).toFixed(1), max: +(lag.max / 1e6).toFixed(1) });
const server = mcpServerWithoutPort();
const load = new LoadGen(server, Math.min(sessions, 1000), Math.min(4, Math.ceil(sessions / 25)));
const swarm = new Swarm({ rate, eventsPerSession, mcp: load, hold: true, textKb: Number(arg('text-kb', '0')), attachMs: Number(arg('attach-ms', '0')), writes: isolate, pulse });
const fakeClaude = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../pipeline/fake-claude');
const runner = new core.StructuredRunner({
  process: { spawn: swarm.spawn, exists: () => true, resolvePath: async () => `${process.env.PATH}:${fakeClaude}`, isDirectory: () => true },
  mcp: server,
  interruptGraceMs: 200,
});
const workspace = tempWorkspace();
if (isolate) gitRepo(workspace, Number(arg('files', '1000')));
const host = hostSession({
  runner, level, maxParallel: sessions, workspace,
  config: { worktreeIsolation: isolate },
  broadcast: (msg) => { if (msg.type === 'status_update') Atomics.add(pulse, 4, 1); },
});
const { session, stats, muted } = host;
const noView = counterfactual === 'no-view';
const persist = session.persist.bind(session);
const quiet = (on) => {
  muted.status = on;
  muted.saves = on;
  session.persist = on ? () => {} : persist;
};
const fastRamp = flag('fast-ramp');
if (noView || fastRamp) quiet(true);
session.loadPlan(planOf(makeTasks(tasks, { shape: 'wide' })), 'scale', workspace, { sessionId: 'session-live', persist: false });

const before = heapMb();
const wall = now();
const cpu = process.cpuUsage();
const out = { sessions, tasks, rate, eventsPerSession, level, counterfactual: counterfactual || 'none', isolate, loadavg: loadAverage() };
const deadline = Date.now() + budget * 1000;
const expired = () => Date.now() > deadline;
const sleep = (t) => new Promise((resolve) => setTimeout(resolve, t));

lag.enable();
// Not awaited: the scheduler's tick waits out each runner's attach, one at a time.
void session.execute({ command: 'run_plan' }, { kind: 'user' });
const target = Math.min(sessions, tasks);
while (swarm.active.size < target && !expired()) await sleep(50);
out.rampS = +(ms(wall) / 1000).toFixed(2);
out.sessionsUp = swarm.active.size;
out.spawned = swarm.spawned;
out.rampLag = lagNow();
out.rampStatus = { messages: stats.statusMessages, builtS: +(stats.statusBuildMs / 1000).toFixed(2) };
out.rampCpuS = +(Object.values(process.cpuUsage(cpu)).reduce((a, b) => a + b, 0) / 1e6).toFixed(1);
if (flag('heap')) out.heapHeldMb = +(heapMb() - before).toFixed(2);
out.rssAtFullMb = Math.round(process.memoryUsage().rss / 1048576);
if (isolate) out.worktreesMbAtFull = Math.round(Number(execFileSync('du', ['-sk', path.join(workspace, '.ordewell', 'worktrees')], { encoding: 'utf8' }).split('\t')[0]) / 1024);

if (fastRamp && !noView) quiet(false);
lag.reset();
const streamed = now();
const [eventsAtGo, linesAtGo] = [swarm.events, swarm.lines];
swarm.go();
const stampede = { eventsDoneMs: 0 };
while (swarm.finished < tasks && !expired()) {
  await sleep(50);
  if (!stampede.eventsDoneMs && swarm.events >= tasks * eventsPerSession) stampede.eventsDoneMs = ms(streamed);
}
const streamMs = ms(streamed);
out.finished = swarm.finished;
out.streamS = +(streamMs / 1000).toFixed(2);
out.eventsThrough = swarm.events - eventsAtGo;
out.eventsPerS = Math.round((swarm.events - eventsAtGo) / (streamMs / 1000));
out.eventsPerSBeforeStampede = stampede.eventsDoneMs ? Math.round((swarm.events - eventsAtGo) / (stampede.eventsDoneMs / 1000)) : null;
out.linesPerS = Math.round((swarm.lines - linesAtGo) / (streamMs / 1000));
out.offeredPerS = sessions * rate;
out.lag = lagNow();
out.mcp = {
  attachP50: +percentile(load.latencies.attach, 0.5).toFixed(1), attachP99: +percentile(load.latencies.attach, 0.99).toFixed(1),
  completeP50: +percentile(load.latencies.complete, 0.5).toFixed(1), completeP99: +percentile(load.latencies.complete, 0.99).toFixed(1), failures: load.failures, ...(load.firstFailure ? { firstFailure: load.firstFailure } : {}),
};
const used = process.cpuUsage(cpu);
out.cpuS = +((used.user + used.system) / 1e6).toFixed(1);
out.wallS = +(ms(wall) / 1000).toFixed(1);
const per = (v) => +(v / Math.max(1, swarm.finished)).toFixed(1);
out.saves = { count: stats.saves, perTask: per(stats.saves), mb: +(stats.saveBytes / 1048576).toFixed(1), ms: Math.round(stats.saveMs) };
out.status = { messages: stats.statusMessages, perTask: per(stats.statusMessages), jsonMb: +(stats.statusBytes / 1048576).toFixed(1), builtS: +(stats.statusBuildMs / 1000).toFixed(1) };
out.broadcasts = { taskLog: stats.taskLogMessages, other: stats.otherBroadcasts, mb: +(stats.otherBytes / 1048576).toFixed(1) };
const dir = path.join(workspace, '.ordewell', 'sessions');
const sessionFile = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
if (sessionFile) out.saves.lastFileKb = Math.round(fs.statSync(path.join(dir, sessionFile)).size / 1024);
let logBytes = 0;
const tasksDir = path.join(dir, 'session-live', 'tasks');
if (fs.existsSync(tasksDir)) for (const t of fs.readdirSync(tasksDir)) for (const f of fs.readdirSync(path.join(tasksDir, t))) logBytes += fs.statSync(path.join(tasksDir, t, f)).size;
out.logMb = +(logBytes / 1048576).toFixed(1);
out.peakRssMb = Math.round(process.resourceUsage().maxRSS / 1024);
if (flag('heap')) out.heapAfterRunMb = +(heapMb() - before).toFixed(2);
if (isolate) out.git = { commands: gitCalls(), perTask: per(gitCalls()) };
say(JSON.stringify(out));
swarm.stop();
load.stop();
host.dropWorkspace();
process.exit(0);
