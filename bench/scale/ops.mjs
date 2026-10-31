#!/usr/bin/env node
/**
 * One operation against plan size: the scheduler's tick, a mutation, a save,
 * the view the surfaces get, a wake-up, a start's prompt.
 *
 *   node bench/scale/ops.mjs [--sizes 100,1000,10000] [--shape dag] [--slots 100]
 *     [--only scheduler,store,saves,view,wake-up,start]
 *
 * In-process, no runner: every number here is core's own work on one thread.
 */
import fs from 'node:fs';
import path from 'node:path';
import { arg, captureConsole, core, countReaddirs, hostSession, loadAverage, makeTasks, ms, now, numbers, planOf, quietNotifications, table, tempWorkspace, timed } from './lib.mjs';

const { count: printed, say } = captureConsole();
const readdirs = countReaddirs();
const sizes = numbers('sizes', '100,1000,10000');
const shape = arg('shape', 'dag');
const SLOTS = Number(arg('slots', '100'));
const USER = { kind: 'user' };
/** Past this size an operation takes seconds: once is what the time allows. */
const budget = (n, normal = 400) => (n >= 5000 ? 0 : normal);

/** A runner that starts and never ends: the run sits with every ready task started. */
const idleRunner = () => {
  let spawned = 0;
  return {
    spawn: async ({ taskId }) => new core.FakeRunnerSession(`s${(spawned += 1)}`, taskId),
    stop: async () => {},
    stopAll() {},
    get activeCount() { return 0; },
  };
};

const results = new Map();
const put = (name, i, value) => {
  if (!results.has(name)) results.set(name, []);
  results.get(name)[i] = value;
};
const bytes = (v) => (v >= 1048576 ? `${(v / 1048576).toFixed(2)} MB` : v >= 1024 ? `${(v / 1024).toFixed(1)} KB` : `${v} B`);

async function scheduler(i, n) {
  const store = new core.PlanStore();
  const orchestrator = core.TaskOrchestrator.compose({
    config: core.fakeConfig({ maxParallelSessions: Math.min(SLOTS, n), worktreeIsolation: false }),
    notifications: quietNotifications,
    runner: idleRunner(),
    store,
    workspaceRoot: tempWorkspace,
    workspaceEnv: async () => ({ env: {}, refused: [] }),
  });
  orchestrator.loadPlan(makeTasks(n, { shape, done: Math.floor(n / 2) }), ['claude-code']);
  const t = now();
  await orchestrator.approveReview();
  put('run start, every ready task claimed (ms)', i, ms(t));
  const tick = () => orchestrator.tick();
  put('tick, nothing to start, console muted (ms)', i, (await timed(tick, budget(n))).ms);
  const lines = printed.lines;
  await tick();
  put('console lines per tick', i, printed.lines - lines);
  printed.sink = fs.openSync(path.join(tempWorkspace(), 'daemon-stdout.log'), 'a');
  const before = printed.bytes;
  const written = await timed(tick, budget(n));
  put('tick, console to a file (ms)', i, written.ms);
  put('console bytes per tick', i, (printed.bytes - before) / written.runs);
  fs.closeSync(printed.sink);
  printed.sink = null;
  const rule = orchestrator.startRule();
  put('  selectReadyTasks (ms)', i, (await timed(() => core.selectReadyTasks({ ...rule, active: 0, maxParallel: 100 }), budget(n))).ms);
  put('  checkOf over every task (ms)', i, (await timed(() => { for (const task of store.allTasks) core.checkOf(store.allTasks, task.id); }, budget(n))).ms);
  put('  planBlocks, once (ms)', i, (await timed(() => core.planBlocks(store.allTasks))).ms);
  put('  startWaits, one task (ms)', i, (await timed(() => orchestrator.startWaits(store.allTasks[n - 1]))).ms);
  orchestrator.stop('restart');
}

async function mutations(i, n) {
  const store = new core.PlanStore();
  store.load(makeTasks(n, { shape, done: Math.floor(n / 2) }), ['claude-code']);
  const last = store.allTasks[n - 1].id;
  put('store.update, a field (ms)', i, (await timed(() => store.update(last, { title: 'edited' }))).ms);
  put('store.markCompleted (ms)', i, (await timed(() => store.markCompleted(last))).ms);
  put('store.add + remove (ms)', i, (await timed(() => store.remove(store.add({ title: 'added', type: 'ai', prompt: 'x', assignedRunner: 'claude-code' }).id))).ms);
  put('store.snapshot, deep copy (ms)', i, (await timed(() => store.snapshot())).ms);
  const t = now();
  for (const task of store.allTasks) store.appendToLog({ ...task });
  put('execution log, every task once (ms)', i, ms(t));
}

async function saves(i, n) {
  const workspace = tempWorkspace();
  for (const [name, done] of [['half done', Math.floor(n / 2)], ['all done', n]]) {
    const plan = planOf(makeTasks(n, { shape, done }));
    const id = `session-${name.replace(' ', '')}`;
    try {
      put(`saveSession, ${name} (ms)`, i, (await timed(() => core.saveSession(plan, 'scale', workspace, id), 400, 20)).ms);
    } catch (err) {
      // V8's longest string: the whole plan no longer fits in one.
      say(`saveSession refused at n=${n}, ${name}: ${err.message}`);
      continue;
    }
    const dir = path.join(workspace, '.ordewell', 'sessions');
    const file = fs.readdirSync(dir).find((f) => f.endsWith(`${id.replace('session-', '').slice(0, 8)}.json`));
    put(`saved file, ${name} (bytes)`, i, fs.statSync(path.join(dir, file)).size);
    put(`loadSession, ${name} (ms)`, i, (await timed(() => core.loadSession(id, workspace), 400, 5)).ms);
  }
  fs.rmSync(workspace, { recursive: true, force: true });
}

async function view(i, n) {
  const host = hostSession({ runner: idleRunner(), maxParallel: Math.min(SLOTS, n) });
  const { session } = host;
  host.muted.saves = true;
  host.muted.status = true;
  const plan = planOf(makeTasks(n, { shape, done: Math.floor(n / 2) }));
  session.loadPlan(plan, 'scale', host.workspace, { sessionId: 'session-view', persist: false });
  await session.execute({ command: 'run_plan' }, USER);
  host.muted.saves = false;
  host.muted.status = false;
  const relay = session.events;
  const before = readdirs.calls;
  let message;
  const whole = await timed(() => { message = relay.statusMessage(); }, budget(n));
  put('readdir calls per status message', i, (readdirs.calls - before) / whole.runs);
  put('statusMessage, built (ms)', i, whole.ms);
  put('status_update JSON (bytes)', i, JSON.stringify(message).length);
  put('  JSON.stringify of it (ms)', i, (await timed(() => JSON.stringify(message))).ms);
  put('  escalations() alone (ms)', i, (await timed(() => session.escalations(), budget(n))).ms);
  const { orchestrator } = session;
  put('  getMergeGate, every task (ms)', i, (await timed(() => { for (const t of session.store.allTasks) orchestrator.getMergeGate(t.id); }, budget(n))).ms);
  put('  planUsage(snapshot) (ms)', i, (await timed(() => core.planUsage(session.store.snapshot()))).ms);
  put('session.persist(), real save + lease (ms)', i, (await timed(() => session.persist(), 400, 20)).ms);
  put('whole plan to a surface, plan_generated (bytes)', i, JSON.stringify(core.serializePlan(plan)).length);
  // What a wake-up turn is handed beside its digest: the whole block on a fresh context, the changes after.
  let view;
  put('planner plan view, built (ms)', i, (await timed(() => { view = session.conversation.planView(); }, budget(n))).ms);
  put('plan block, whole, to a fresh planner context (bytes)', i, view.full.length);
  session.stopExecution();
  session.destroy();
  host.dropWorkspace();
}

async function wakeUps(i, n) {
  const tasks = makeTasks(n, { shape: 'chain', done: 0 });
  tasks[0].status = 'failed';
  const hostOf = (deliver) => ({
    plan: () => ({ runSettings: { supervisorLevel: 'act', mergeAtGatesAutomatically: false, supervisorRetryLimit: 2, wakeUpReadBudget: 12 } }),
    userSettings: () => core.RUN_SETTINGS_DEFAULTS,
    tasks: () => tasks,
    checkpointQuestion: () => undefined,
    landedWork: () => null,
    recentOutput: () => undefined,
    reportTail: () => undefined,
    reported() {}, systemNote() {}, supervisorNote() {}, changed() {}, save() {}, resendHandoff() {},
    deliver: async (digest) => { deliver(digest); },
    pump() {}, restartPlanner() {}, abandonTurn() {}, notice() {},
  });
  const digestOf = async (events) => {
    let digest = '';
    const supervision = new core.RunSupervision(hostOf((d) => { digest = d; }), { debounceMs: 0 });
    supervision.runStarted('user');
    const t = now();
    for (const event of events) supervision.observe(event);
    while (!digest) await new Promise((resolve) => setImmediate(resolve));
    const spent = ms(t);
    supervision.reset();
    return { digest, spent };
  };
  const id = (at) => tasks[at].id;
  const quiet = await digestOf([{ kind: 'task_passed', taskId: id(1) }, { kind: 'task_failed', taskId: id(n - 1), detail: 'no task_complete call' }]);
  put('digest, one failure blocking nothing (bytes)', i, quiet.digest.length);
  const failure = await digestOf([{ kind: 'task_failed', taskId: id(0), detail: 'no task_complete call' }]);
  put('digest, a failure blocking the rest of a chain (bytes)', i, failure.digest.length);
  put('  built in (ms)', i, failure.spent);
  const passes = await digestOf([...tasks.slice(1, Math.ceil(n / 10)).map((t) => ({ kind: 'task_passed', taskId: t.id })), { kind: 'task_failed', taskId: id(n - 1) }]);
  put('digest, a tenth of the plan passed since the last (bytes)', i, passes.digest.length);
  put('  built in (ms) ', i, passes.spent);
  const limit = await digestOf(tasks.slice(0, Math.min(SLOTS, n)).map((t) => ({ kind: 'usage_limit', taskId: t.id, runner: 'claude-code', resumeAt: '2026-11-01T00:00:00Z' })));
  put(`digest, a usage limit stopping ${SLOTS} live tasks (bytes)`, i, limit.digest.length);

  const plain = makeTasks(n, { shape: 'dag', done: Math.floor(n / 2) });
  const supervision = new core.RunSupervision({ ...hostOf(() => {}), tasks: () => plain }, { debounceMs: 60_000 });
  supervision.runStarted('user');
  const task = plain[Math.floor(n / 2) - 1];
  put('taskSettled, the wake decision (ms)', i, (await timed(() => supervision.taskSettled(task))).ms);
  supervision.reset();
}

async function prompts(i, n) {
  // The next task to start: what it depends on has finished, so their reports go in.
  const tasks = makeTasks(n, { shape, done: Math.floor(n / 2) });
  const task = tasks[Math.floor(n / 2)];
  let prompt = '';
  put('composeAugmentedPrompt (ms)', i, (await timed(() => { prompt = core.composeAugmentedPrompt(task, tasks, { planMapEnabled: true }); })).ms);
  put('prompt a runner is sent (bytes)', i, prompt.length);
}

const sections = [
  ['Scheduler', scheduler],
  ['Store', mutations],
  ['Saves', saves],
  ['View', view],
  ['Wake-up', wakeUps],
  ['Start', prompts],
];
say(`# ops: shape=${shape}, half the plan done, ${SLOTS} slots, node ${process.version}, load ${loadAverage()}`);
const only = arg('only', '');
for (const [title, run] of sections) {
  if (only && !only.split(',').includes(title.toLowerCase())) continue;
  for (const [i, n] of sizes.entries()) {
    const t = now();
    await run(i, n);
    say(`[${title} n=${n}: ${(ms(t) / 1000).toFixed(1)}s, load ${loadAverage()}]`);
  }
}
table(say, `all operations (shape=${shape})`, sizes, [...results.keys()].map((name) => ({
  name,
  values: results.get(name),
  fmt: /bytes/.test(name) ? bytes : /lines|calls/.test(name) ? (v) => String(v) : (v) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(4)),
})));
process.exit(0);
