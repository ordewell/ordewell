#!/usr/bin/env node
/**
 * What real runs left behind, as numbers: the sizes the benchmarks are
 * calibrated to. Reads a `.ordewell/sessions` folder and prints aggregates only.
 *
 *   node bench/scale/real.mjs <path to .ordewell/sessions>
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.floor(values.length * p)];
const line = (name, values, fmt = (x) => x.toFixed(1)) => console.log(`${name}: n=${values.length} p10 ${fmt(quantile(values, 0.1))} p50 ${fmt(quantile(values, 0.5))} p90 ${fmt(quantile(values, 0.9))} p99 ${fmt(quantile(values, 0.99))} max ${fmt(Math.max(...values))}`);
const walk = (list, into = []) => { for (const t of list ?? []) { into.push(t); walk(t.subtasks, into); } return into; };

const sessions = [];
const seen = new Set();
for (const file of fs.readdirSync(root).filter((f) => f.endsWith('.json'))) {
  const raw = fs.readFileSync(path.join(root, file), 'utf8');
  const data = JSON.parse(raw);
  if (seen.has(data.meta.id)) continue;
  seen.add(data.meta.id);
  const tasks = walk(data.plan.tasks);
  sessions.push({ data, tasks, bytes: raw.length, perTask: JSON.stringify(data.plan.tasks, null, 2).length / Math.max(1, tasks.length), research: JSON.stringify(data.plan.researchLog ?? null, null, 2).length });
}
line('session file KB', sessions.map((s) => s.bytes / 1024), (x) => x.toFixed(0));
line('tasks in a session', sessions.map((s) => s.tasks.length), (x) => x.toFixed(0));
line('bytes of task JSON per task', sessions.filter((s) => s.tasks.length >= 10).map((s) => s.perTask), (x) => x.toFixed(0));
line('researchLog KB in the file', sessions.map((s) => s.research / 1024), (x) => x.toFixed(0));

const [attach, walls, linesPerS, bytesPerS, usagePerS, sizes, lineCounts, usages, tools] = [[], [], [], [], [], [], [], [], []];
const plain = [];
const types = {};
let [lineTotal, byteTotal] = [0, 0];
for (const { data, tasks } of sessions) {
  for (const task of tasks) {
    for (const usage of task.attemptUsage ?? []) {
      const file = path.join(root, data.meta.id, 'tasks', task.id, `${usage.attempt}.jsonl`);
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      let [usageLines, toolLines, said] = [0, 0, 0];
      for (const l of lines) {
        let type;
        let event;
        try { event = JSON.parse(l); ({ type } = event); } catch { continue; }
        // What the plain output channel keeps of it: the reply's text, and a line per tool call.
        if (type === 'text') said += event.text?.length ?? 0;
        if (type === 'tool_call') said += 80;
        types[type] = (types[type] ?? 0) + 1;
        if (type === 'usage') usageLines += 1;
        if (type === 'tool_call') toolLines += 1;
      }
      lineTotal += lines.length;
      byteTotal += raw.length;
      sizes.push(raw.length / 1024);
      lineCounts.push(lines.length);
      usages.push(usageLines);
      plain.push(said / 1024);
      tools.push(toolLines);
      // The log is opened as the spawn returns, once the runner has attached.
      const attached = fs.statSync(file).birthtimeMs - Date.parse(usage.startedAt);
      if (attached >= 0 && attached < 600_000) attach.push(attached);
      if (usage.wallTimeMs > 1000) {
        const seconds = usage.wallTimeMs / 1000;
        walls.push(seconds);
        linesPerS.push(lines.length / seconds);
        bytesPerS.push(raw.length / seconds);
        usagePerS.push(usageLines / seconds);
      }
    }
  }
}
line('attempt log KB', sizes, (x) => x.toFixed(0));
line('log lines per attempt', lineCounts, (x) => x.toFixed(0));
line('usage events per attempt', usages, (x) => x.toFixed(0));
line('tool calls per attempt', tools, (x) => x.toFixed(0));
line('plain output KB per attempt', plain, (x) => x.toFixed(1));
line('attempt start to runner attached ms', attach, (x) => x.toFixed(0));
line('attempt wall s', walls, (x) => x.toFixed(0));
line('log lines per second', linesPerS, (x) => x.toFixed(2));
line('log bytes per second', bytesPerS, (x) => x.toFixed(0));
line('usage events per second', usagePerS, (x) => x.toFixed(3));
console.log(`bytes per log line: ${Math.round(byteTotal / lineTotal)}; attempts ${sizes.length}; total ${(byteTotal / 1048576).toFixed(0)} MB`);
console.log(Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}=${v}`).join(' '));
