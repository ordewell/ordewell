#!/usr/bin/env node
/**
 * The terminal UI without a terminal: a daemon's messages folded through the
 * TUI's own inbound stream and reducer, drawn by its own render, on a virtual
 * clock, so a long session's lag and growth can be judged by figures.
 *
 *   node bench/scale/build-tui.mjs        # after any change to packages/cli or core
 *   node bench/scale/tui.mjs [--tasks 300 --settled 280 --entries 400 --minutes 10] [--no-sweep] [--profile] [--out file]
 *
 * Offline: the bundle holds core's source too, no dist. The clock is virtual
 * (`setTimeout`, `setInterval` and `Date.now` only), so ten minutes of stream
 * cost what their folds and frames cost, not ten minutes. Costs are real
 * `hrtime`, never virtual.
 */
import fs from 'node:fs';
import inspector from 'node:inspector';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFeed } from './tui-feed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// The heap figures need a collector on demand: the other scripts are run with
// the flag by hand, this one asks for itself.
if (typeof globalThis.gc !== 'function') {
  const again = spawnSync(process.execPath, ['--expose-gc', ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(again.status ?? 1);
}

const bundle = path.join(here, '.build', 'tui.mjs');
const tui = await import(pathToFileURL(bundle).href).catch((err) => {
  console.error(`Run \`node bench/scale/build-tui.mjs\` first (${err.message}).`);
  process.exit(2);
});

// ---------- arguments ----------

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const num = (name, fallback) => Number(arg(name, fallback));

const options = {
  tasks: num('tasks', 300),
  settled: num('settled', 280),
  entries: num('entries', 400),
  minutes: num('minutes', 10),
  sweepMinutes: num('sweep-minutes', 3),
  seed: num('seed', 1),
  running: num('running', 2),
  cols: num('cols', 200),
  rows: num('rows', 50),
  narrowCols: num('narrow-cols', 60),
  narrowRows: num('narrow-rows', 40),
  keys: num('keys', 20),
  session: arg('session', null),
  taskView: flag('task-view'),
  stream: {
    turnEvery: num('turn-every', 40),
    turnLen: num('turn-len', 20),
    delta: num('delta', 30),
    rotate: num('rotate', 60),
    mutateEvery: num('mutate-every', 30),
    logTasks: num('log-tasks', 2),
  },
};
options.settled = Math.min(options.settled, options.tasks);
const sweep = !flag('no-sweep') && options.session === null;
const log = (line) => process.stderr.write(`${line}\n`);

// ---------- clocks ----------

const hr = () => process.hrtime.bigint();
const since = (t) => Number(process.hrtime.bigint() - t) / 1e6;
const round = (v, digits = 3) => (Number.isFinite(v) ? Number(v.toFixed(digits)) : v);

function percentile(values, p) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
const mean = (values) => (values.length === 0 ? NaN : values.reduce((s, v) => s + v, 0) / values.length);
const median = (values) => percentile(values, 50);

/**
 * `setTimeout`, `setInterval` and `Date.now` on a clock that moves only when
 * told to. What a timer's callback costs is measured as it runs, by what it
 * was: the app's `paint` (a frame), its spinner interval, or a held burst of
 * deltas going out. Nothing here changes how long anything takes.
 */
function virtualClock() {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, now: Date.now };
  let now = real.now();
  let next = 1;
  let timers = [];
  const cost = { frame: [], spinner: [], flush: [] };
  const hooks = { onFlush: null, drawn: () => 0 };

  const handle = (timer) => Object.assign(timer, { unref() { return timer; }, ref() { return timer; }, hasRef: () => true });
  const add = (fn, ms, every) => {
    const timer = handle({ id: next++, at: now + Math.max(0, Number(ms) || 0), fn, every, dead: false });
    timers.push(timer);
    return timer;
  };
  globalThis.setTimeout = (fn, ms) => add(fn, ms, null);
  globalThis.setInterval = (fn, ms) => add(fn, ms, Math.max(1, Number(ms) || 1));
  globalThis.clearTimeout = globalThis.clearInterval = (timer) => { if (timer && typeof timer === 'object') timer.dead = true; };
  Date.now = () => now;

  function run(timer) {
    const before = hooks.drawn();
    const t = hr();
    timer.fn();
    const ms = since(t);
    // The loop is single-threaded: while a callback ran, time went by.
    now += ms;
    if (timer.every !== null) cost.spinner.push(ms);
    else if (hooks.drawn() > before) cost.frame.push(ms);
    else {
      cost.flush.push(ms);
      hooks.onFlush?.(ms);
    }
  }

  return {
    now: () => now,
    spend(ms) {
      now += ms;
    },
    cost,
    hooks,
    pending: () => timers.filter((t) => !t.dead).length,
    advanceTo(target) {
      for (;;) {
        timers = timers.filter((t) => !t.dead);
        let first = null;
        for (const t of timers) if (t.at <= target && (first === null || t.at < first.at || (t.at === first.at && t.id < first.id))) first = t;
        if (first === null) break;
        now = Math.max(now, first.at);
        if (first.every === null) first.dead = true;
        else first.at = now + first.every;
        run(first);
      }
      now = Math.max(now, target);
    },
    resetCosts() {
      for (const k of Object.keys(cost)) cost[k] = [];
    },
    stop() {
      timers = [];
    },
    restore() {
      Object.assign(globalThis, { setTimeout: real.setTimeout, clearTimeout: real.clearTimeout, setInterval: real.setInterval, clearInterval: real.clearInterval });
      Date.now = real.now;
    },
  };
}

function heapMb() {
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed / 1048576;
}

/** The fastest, the median and the 95th of `fn` over at least `min` runs and `budgetMs`. */
function sample(fn, { budgetMs = 400, min = 5, max = 300 } = {}) {
  const times = [];
  const started = performance.now();
  do {
    const t = hr();
    fn();
    times.push(since(t));
  } while ((times.length < min || performance.now() - started < budgetMs) && times.length < max);
  return { min: Math.min(...times), median: median(times), p95: percentile(times, 95), runs: times.length };
}

/** Least-squares slope of y on x. */
function slope(xs, ys) {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  return den === 0 ? NaN : xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / den;
}

// ---------- one configuration ----------

const microtask = () => new Promise((resolve) => queueMicrotask(resolve));

async function measure({ tasks, settled, entries, minutes }) {
  const clock = virtualClock();
  try {
    globalThis.gc();
    const base = heapMb();
    const feed = makeFeed({ tasks, settled, entries, seed: options.seed, running: options.running, session: options.session });
    let drawn = 0;
    let lastFrame = [];
    clock.hooks.drawn = () => drawn;
    const make = (initial) => tui.createApp({
      initial,
      draw: (frame) => { drawn += 1; lastFrame = frame; },
      perform: async () => {},
      onExit: () => {},
    });
    const app = make({ rows: options.rows, cols: options.cols, focus: 'chat' });
    let actions = 0;
    let unchanged = 0;
    // An action the reducer hands the same state back for paints nothing.
    const dispatch = (action) => {
      const before = app.getState();
      app.dispatch(action);
      actions += 1;
      if (app.getState() === before) unchanged += 1;
    };
    app.start();

    const out = { tasks, settled, entries, load: {} };
    const timeOf = (fn) => {
      const t = hr();
      const result = fn();
      return [since(t), result];
    };

    // ----- the first load, as a surface opens a session: the read, then what the socket greets with -----
    const inbound = tui.createInbound(dispatch, 'bench');
    let load = feed.load(clock.now());
    Object.assign(out, load.shape);
    dispatch({ type: 'sessionLoaded', sessionId: 'bench', goal: load.goal });
    let frames = load.frames;
    await inbound.openFrom(async () => ({
      apply() {
        out.load.chatRestored = timeOf(() => dispatch({ ...load.chat, sessionId: 'bench' }))[0];
        out.load.planRefreshed = timeOf(() => dispatch({ type: 'planRefreshed', plan: load.plan, sessionId: 'bench' }))[0];
        if (load.run) out.load.runSnapshot = timeOf(() => dispatch({ type: 'runSnapshot', view: load.run, sessionId: 'bench' }))[0];
      },
    }));
    let seq = 0;
    // A burst of deltas is held for the stream's own timer to send; only the load's frames are flushed at once.
    const receive = (json, { flush = false } = {}) => {
      const t = hr();
      const message = JSON.parse(json);
      const parsed = since(t);
      message.stream = 'bench';
      message.seq = ++seq;
      const [folded] = timeOf(() => { inbound.receive(message); if (flush) inbound.flush(); });
      return { parsed, folded, type: message.type };
    };
    if (frames) {
      out.load.snapshotFrame = receive(frames.snapshot, { flush: true }).folded;
      out.load.wholePlanFrame = receive(frames.wholePlan, { flush: true }).folded;
    }
    load = null;
    frames = null;
    // The paint the load asked for, before any frame has drawn the transcript: what a surface attaching waits for.
    out.load.firstPaint = timeOf(() => tui.render({ ...app.getState(), now: clock.now() }))[0];
    clock.advanceTo(clock.now() + 1000);
    out.load.heapMb = heapMb();
    out.load.heapAboveBaseMb = out.load.heapMb - base;
    out.blocks = app.getState().conversation.blocks.length;
    out.planRows = app.getState().tasks.length;

    if (options.taskView) {
      const running = app.getState().tasks.find((t) => t.status === 'in_progress');
      if (running) {
        dispatch({ type: 'taskViewRequested', sessionId: 'bench', taskId: running.id });
        dispatch({ type: 'taskLogLoaded', sessionId: 'bench', taskId: running.id, attempt: 1, events: [] });
        out.taskView = running.id;
      }
    }

    // ----- a frame, wide and narrow -----
    const frameAt = (state) => () => tui.render({ ...state, now: clock.now() });
    const wide = sample(frameAt(app.getState()));
    out.render = { wide: wide.median, wideMin: wide.min, wideP95: wide.p95, wideRows: tui.render({ ...app.getState(), now: clock.now() }).length };
    dispatch({ type: 'resize', cols: options.narrowCols, rows: options.narrowRows });
    const narrow = sample(frameAt(app.getState()));
    out.render.narrow = narrow.median;
    out.render.narrowMin = narrow.min;
    out.render.narrowP95 = narrow.p95;
    out.render.narrowRows = tui.render({ ...app.getState(), now: clock.now() }).length;
    dispatch({ type: 'resize', cols: options.cols, rows: options.rows });
    clock.advanceTo(clock.now() + 1000);

    // ----- a keypress that scrolls: reduce, then the paint it asks for at once -----
    out.keys = {};
    for (const [name, focus, down, up] of [['planScroll', 'plan', 'pagedown', 'pageup'], ['chatScroll', 'chat', 'pageup', 'pagedown']]) {
      const keyApp = make({ ...app.getState(), focus });
      const total = [];
      const reduceOnly = [];
      for (let i = 0; i < options.keys; i += 1) {
        // Out and back, so the viewport stays inside its content.
        const action = { type: 'key', key: { name: Math.floor(i / 4) % 2 === 0 ? down : up } };
        const [r] = timeOf(() => tui.reduce(keyApp.getState(), action));
        reduceOnly.push(r);
        const [t] = timeOf(() => keyApp.dispatch(action));
        total.push(t);
        await microtask();
      }
      // Its spinner would go on ticking in the stream's time.
      keyApp.dispatch({ type: 'key', key: { name: 'ctrl-d' } });
      out.keys[name] = median(total);
      out.keys[`${name}Reduce`] = median(reduceOnly);
      out.keys[`${name}P95`] = percentile(total, 95);
    }
    clock.advanceTo(clock.now() + 1000);

    // ----- the stream, at one virtual second a step -----
    clock.resetCosts();
    const foldBy = new Map();
    const note = (type, ms) => {
      if (!foldBy.has(type)) foldBy.set(type, []);
      foldBy.get(type).push(ms);
    };
    clock.hooks.onFlush = (ms) => note('(deltas flushed)', ms);
    const total = Math.round(minutes * 60);
    // Heap after a collection at the load, every half virtual minute and the end, with the minute it was taken.
    const heap = [{ at: 0, mb: out.load.heapMb }];
    const framesBefore = drawn;
    const actionsBefore = actions;
    const unchangedBefore = unchanged;
    let parseMs = 0;
    let messages = 0;
    const t0 = clock.now();
    let behindMs = 0;
    let worstBehindMs = 0;
    for (let s = 0; s < total; s += 1) {
      const scheduled = t0 + s * 1000;
      const arriving = feed.second(s, scheduled, options.stream).map(({ at, frame }) => ({ due: scheduled + at, frame }));
      let i = 0;
      while (i < arriving.length) {
        // Idle until the next frame arrives, with timers firing as they fall due; or, already behind, one
        // timers phase and then everything that has arrived is read in one go, as the event loop does.
        clock.advanceTo(Math.max(arriving[i].due, clock.now()));
        const cutoff = clock.now();
        do {
          const { parsed, folded, type } = receive(arriving[i].frame);
          clock.spend(parsed + folded);
          parseMs += parsed;
          messages += 1;
          note(type, folded);
          i += 1;
        } while (i < arriving.length && arriving[i].due <= cutoff);
      }
      clock.advanceTo(scheduled + 1000);
      behindMs = Math.max(0, clock.now() - (scheduled + 1000));
      worstBehindMs = Math.max(worstBehindMs, behindMs);
      if ((s + 1) % 30 === 0 && s + 1 < total) heap.push({ at: (s + 1) / 60, mb: heapMb() });
    }
    heap.push({ at: total / 60, mb: heapMb() });
    const seconds = Math.max(1, total);
    const frameCost = clock.cost.frame;
    const spinnerCost = clock.cost.spinner;
    const foldTotal = [...foldBy.values()].flat().reduce((s, v) => s + v, 0);
    const state = app.getState();
    out.stream = {
      seconds,
      messages,
      frames: drawn - framesBefore,
      framesPerSecond: (drawn - framesBefore) / seconds,
      actions: actions - actionsBefore,
      unchangedActions: unchanged - unchangedBefore,
      frameMs: mean(frameCost),
      frameP95Ms: percentile(frameCost, 95),
      frameMaxMs: Math.max(0, ...frameCost),
      spinnerTicks: spinnerCost.length,
      spinnerMs: mean(spinnerCost),
      parseMs: parseMs / Math.max(1, messages),
      // What the stream costs the event loop per second of stream: frames, folds and parsing.
      behindSeconds: behindMs / 1000,
      busyMsPerSecond: (frameCost.reduce((s, v) => s + v, 0) + spinnerCost.reduce((s, v) => s + v, 0) + foldTotal + parseMs) / seconds,
      heapMb: heap.at(-1).mb,
      heapSlopeMbPerMin: slope(heap.map((h) => h.at), heap.map((h) => h.mb)),
      heapSamples: heap.map((h) => round(h.mb, 2)),
      blocks: state.conversation.blocks.length,
    };
    out.fold = Object.fromEntries([...foldBy].map(([type, values]) => [type, { n: values.length, mean: mean(values), p95: percentile(values, 95), max: Math.max(...values), total: values.reduce((s, v) => s + v, 0) }]));
    out.frameBytes = lastFrame.reduce((n, row) => n + row.length, 0);
    out.keep = {
      state: app.getState(),
      status: JSON.stringify(feed.second(1, clock.now(), options.stream).map((f) => JSON.parse(f.frame)).find((m) => m.type === 'status_update')),
      now: clock.now(),
    };
    return out;
  } finally {
    clock.stop();
    clock.restore();
  }
}

// ---------- the profile ----------

const moduleLines = (() => {
  const lines = fs.readFileSync(bundle, 'utf8').split('\n');
  const marks = [];
  lines.forEach((line, i) => {
    const m = /^\/\/ (\.\.\/.*|[^ ]*\.ts)$/.exec(line);
    if (m) marks.push([i + 1, m[1].replace(/^(\.\.\/)+/, '').replace(/^packages\//, '')]);
  });
  return marks;
})();
const moduleOf = (line) => {
  let found = '';
  for (const [at, name] of moduleLines) {
    if (at > line) break;
    found = name;
  }
  return found;
};

async function profiled(fn) {
  const session = new inspector.Session();
  session.connect();
  const post = (method, params) => new Promise((resolve, reject) => session.post(method, params, (err, result) => (err ? reject(err) : resolve(result))));
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: 100 });
  await post('Profiler.start');
  await fn();
  const { profile } = await post('Profiler.stop');
  session.disconnect();
  return profile;
}

/** The package a script of node_modules is, or the file's own name. */
function packageOf(url) {
  if (!url) return 'native';
  const rest = url.replace(/^.*node_modules\//, '');
  if (rest === url) return path.basename(url);
  const parts = rest.split('/');
  return parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/');
}

/** Self time by function, as a share of what the profile saw outside idle. */
function selfTime(profile, top = 10) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  profile.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
  const byFunction = new Map();
  let busy = 0;
  for (const [id, us] of self) {
    const { callFrame } = byId.get(id);
    if (callFrame.functionName === '(idle)' || callFrame.functionName === '(program)' || callFrame.functionName === '(root)') continue;
    // The harness's own frames and the inspector's are not the TUI's cost.
    if (callFrame.url === pathToFileURL(fileURLToPath(import.meta.url)).href || callFrame.url === 'node:inspector') continue;
    const where = callFrame.url === pathToFileURL(bundle).href ? moduleOf(callFrame.lineNumber + 1) : packageOf(callFrame.url);
    const key = `${callFrame.functionName || '(anonymous)'} ${where}`;
    byFunction.set(key, (byFunction.get(key) ?? 0) + us);
    busy += us;
  }
  return [...byFunction].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, us]) => ({ name, share: busy > 0 ? us / busy : 0 }));
}

async function profileDefault({ state, status, now }) {
  const out = {};
  const frameProfile = await profiled(async () => {
    for (let i = 0; i < 150; i += 1) tui.render({ ...state, now });
  });
  out.frame = selfTime(frameProfile);
  // One status update folded into the state the stream left: the work every second pays.
  const foldProfile = await profiled(async () => {
    for (let i = 0; i < 150; i += 1) tui.reduce(state, { type: 'runMessage', sessionId: 'bench', message: JSON.parse(status) });
  });
  out.statusFold = selfTime(foldProfile);
  // The reducer's half of a key that scrolls the plan.
  const planFocused = { ...state, focus: 'plan' };
  const keyProfile = await profiled(async () => {
    for (let i = 0; i < 40; i += 1) tui.reduce(planFocused, { type: 'key', key: { name: 'pagedown' } });
  });
  out.planScrollReduce = selfTime(keyProfile);
  if (arg('profile-out', null)) {
    fs.writeFileSync(arg('profile-out'), JSON.stringify(frameProfile));
    out.file = arg('profile-out');
  }
  return out;
}

// ---------- output ----------

const fmt = (v, digits = 2) => (v === undefined ? '-' : Number.isFinite(v) ? v.toFixed(digits) : String(v));

function tables(runs, extra) {
  const lines = [];
  const say = (line = '') => lines.push(line);
  const head = runs.map((r) => `N=${r.tasks} D=${r.settled} T=${r.entries}`);
  const row = (name, pick, digits = 2) => say(`| ${name} | ${runs.map((r) => fmt(pick(r), digits)).join(' | ')} |`);

  say(`## Terminal UI: ${runs[0].tasks} tasks, ${options.minutes} min of stream, ${options.cols}x${options.rows} and ${options.narrowCols}x${options.narrowRows}`);
  say(`| figure | ${head.join(' | ')} |`);
  say(`| --- | ${head.map(() => '---').join(' | ')} |`);
  row('blocks in the chat after load', (r) => r.blocks, 0);
  row('load: chatRestored, ms', (r) => r.load.chatRestored);
  row('load: planRefreshed, ms', (r) => r.load.planRefreshed);
  row('load: runSnapshot action, ms', (r) => r.load.runSnapshot);
  row('load: run_snapshot frame, ms', (r) => r.load.snapshotFrame);
  row('load: whole-plan frame, ms', (r) => r.load.wholePlanFrame);
  row('load: first paint, ms', (r) => r.load.firstPaint);
  row('heap after load, MB', (r) => r.load.heapMb, 1);
  row('frame wide, ms (median)', (r) => r.render.wide);
  row('frame wide, ms (p95)', (r) => r.render.wideP95);
  row('frame narrow (stacked), ms (median)', (r) => r.render.narrow);
  row('key scrolling the plan, ms (reduce + paint)', (r) => r.keys.planScroll);
  row('  of it the reducer, ms', (r) => r.keys.planScrollReduce);
  row('key scrolling the chat, ms (reduce + paint)', (r) => r.keys.chatScroll);
  row('  of it the reducer, ms', (r) => r.keys.chatScrollReduce);
  row('stream: actions folded', (r) => r.stream.actions, 0);
  row('  of them changing nothing, so painting nothing', (r) => r.stream.unchangedActions, 0);
  row('stream: frames a second', (r) => r.stream.framesPerSecond);
  row('stream: frame, ms (mean)', (r) => r.stream.frameMs);
  row('stream: frame, ms (p95)', (r) => r.stream.frameP95Ms);
  row('stream: event-loop ms a second', (r) => r.stream.busyMsPerSecond, 1);
  row('stream: behind the daemon at the end, s', (r) => r.stream.behindSeconds, 1);
  row('stream: heap at the end, MB', (r) => r.stream.heapMb, 1);
  row('stream: heap slope, MB a minute', (r) => r.stream.heapSlopeMbPerMin);
  row('stream: blocks at the end', (r) => r.stream.blocks, 0);

  const main = runs.find((r) => r.settled === options.settled && r.entries === options.entries) ?? runs[0];
  say();
  say(`## Folding by message type at D=${main.settled} T=${main.entries} (per message, ms; ${fmt(main.stream.parseMs, 3)} of JSON.parse not in them)`);
  say('| message | n | mean | p95 | max | total |');
  say('| --- | --- | --- | --- | --- | --- |');
  for (const [type, f] of Object.entries(main.fold).sort((a, b) => b[1].total - a[1].total)) {
    say(`| ${type} | ${f.n} | ${fmt(f.mean, 3)} | ${fmt(f.p95, 3)} | ${fmt(f.max, 3)} | ${fmt(f.total, 1)} |`);
  }

  if (extra.slopes) {
    say();
    say('## Growth');
    say('| figure | per +100 settled tasks | per +100 entries | per +100 tasks (settled in proportion) |');
    say('| --- | --- | --- | --- |');
    for (const [name, s] of Object.entries(extra.slopes)) say(`| ${name} | ${fmt(s.perHundredSettled, 3)} | ${fmt(s.perHundredEntries, 3)} | ${fmt(s.perHundredTasks, 3)} |`);
  }
  if (extra.profile) {
    for (const [name, rows] of [['a frame', extra.profile.frame], ['a status update folded', extra.profile.statusFold], ['the reducer on a key that scrolls the plan', extra.profile.planScrollReduce]]) {
      say();
      say(`## Self time in ${name} at D=${main.settled} T=${main.entries}`);
      say('| function | share |');
      say('| --- | --- |');
      for (const { name: fn, share } of rows) say(`| ${fn} | ${(share * 100).toFixed(1)}% |`);
    }
  }
  return lines.join('\n');
}

const FIGURES = {
  'first paint after load, ms': (r) => r.load.firstPaint,
  'frame wide, ms (fastest)': (r) => r.render.wideMin,
  'frame narrow, ms (fastest)': (r) => r.render.narrowMin,
  'plan scroll key, ms': (r) => r.keys.planScroll,
  'chat scroll key, ms': (r) => r.keys.chatScroll,
  'status_update fold, ms': (r) => r.fold.status_update?.mean,
  'event-loop ms a second': (r) => r.stream.busyMsPerSecond,
  'heap after load, MB': (r) => r.load.heapMb,
  'heap slope, MB a minute': (r) => r.stream.heapSlopeMbPerMin,
};

function growth(runs) {
  const { tasks, settled, entries } = { tasks: options.tasks, settled: options.settled, entries: options.entries };
  const byD = runs.filter((r) => r.tasks === tasks && r.entries === entries).sort((a, b) => a.settled - b.settled);
  const byT = runs.filter((r) => r.tasks === tasks && r.settled === settled).sort((a, b) => a.entries - b.entries);
  const byN = runs.filter((r) => r.entries === entries && Math.abs(r.settled / r.tasks - settled / tasks) < 0.02).sort((a, b) => a.tasks - b.tasks);
  const out = {};
  for (const [name, pick] of Object.entries(FIGURES)) {
    out[name] = {
      perHundredSettled: slope(byD.map((r) => r.settled), byD.map(pick)) * 100,
      perHundredEntries: slope(byT.map((r) => r.entries), byT.map(pick)) * 100,
      perHundredTasks: slope(byN.map((r) => r.tasks), byN.map(pick)) * 100,
    };
  }
  return out;
}

// ---------- main ----------

// The full-size run goes last: what it keeps for the profile must not weigh on the heap of the others.
const smallPlan = Math.max(4, Math.round(options.tasks / 5));
const full = { settled: options.settled, entries: options.entries, minutes: options.minutes };
const configs = sweep
  ? [
    { settled: 0, entries: options.entries, minutes: options.sweepMinutes },
    { settled: Math.round(options.settled / 3), entries: options.entries, minutes: options.sweepMinutes },
    { settled: options.settled, entries: 0, minutes: options.sweepMinutes },
    // A plan a fifth the size, settled in the same proportion: what the plan itself costs.
    { tasks: smallPlan, settled: Math.round(options.settled * smallPlan / options.tasks), entries: options.entries, minutes: options.sweepMinutes },
    full,
  ]
  : [full];

let runs = [];
let kept = null;
for (const config of configs) {
  log(options.session ? 'measuring the saved session ...' : `measuring N=${config.tasks ?? options.tasks} D=${config.settled} T=${config.entries} ...`);
  const run = await measure({ tasks: options.tasks, ...config });
  if (config === full) kept = run.keep;
  delete run.keep;
  runs.push(run);
}
runs = sweep ? [runs[0], runs[1], runs[4], runs[2], runs[3]] : runs;

const extra = {};
if (sweep) extra.slopes = growth(runs);
if (flag('profile') || arg('profile-out', null)) extra.profile = await profileDefault(kept);

const result = { options: { ...options, stream: { ...options.stream } }, node: process.version, runs, ...extra };
console.log(tables(runs, extra));
const json = JSON.stringify(result);
if (arg('out', null)) {
  fs.writeFileSync(arg('out'), `${json}\n`);
  console.log(`\nwrote ${arg('out')}`);
} else {
  console.log(`\n${json}`);
}
