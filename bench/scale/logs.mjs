#!/usr/bin/env node
/**
 * Task logs on real disk: writing, reading, and what the readers pay.
 *
 *   node bench/scale/logs.mjs [--attempts 100,1000,10000] [--sample FILE]
 *
 * Sizes are this repository's real attempt logs (real.mjs). `--sample` adds
 * one such log, for the parse rate of real content.
 */
import fs from 'node:fs';
import path from 'node:path';
import { arg, captureConsole, core, ms, now, numbers, tempWorkspace, timed } from './lib.mjs';

const { say } = captureConsole();
const attempts = numbers('attempts', '100,1000,10000');

const LINE = { type: 'tool_result', id: 'toolu_1', name: '', output: 'x'.repeat(340), success: true };
const synthetic = (bytes) => {
  const line = `${JSON.stringify(LINE)}\n`;
  return line.repeat(Math.ceil(bytes / line.length));
};

say('\n## Opening and appending (one file per attempt, one directory per task)');
say('| attempts in the session | openTaskLog ms | append 1 batch ms | listTaskLogAttempts ms, task ran | task never ran |');
say('| --- | --- | --- | --- | --- |');
for (const n of attempts) {
  const baseDir = tempWorkspace();
  const location = { baseDir, sessionId: 'session-logs' };
  const t = now();
  const files = Array.from({ length: n }, (_, i) => core.openTaskLog(location, `t${i}`, 1));
  const open = ms(t) / n;
  const append = await timed(() => files[n >> 1].append([LINE, LINE, LINE]));
  const hit = await timed(() => core.listTaskLogAttempts(location, `t${n >> 1}`));
  const miss = await timed(() => core.listTaskLogAttempts(location, 'never-ran'));
  say(`| ${n} | ${open.toFixed(3)} | ${append.ms.toFixed(3)} | ${hit.ms.toFixed(4)} | ${miss.ms.toFixed(4)} |`);
  fs.rmSync(baseDir, { recursive: true, force: true });
}

say('\n## Reading one attempt: every reader reads the whole file, and nothing is cached');
say('| log | size | readTaskLog ms | renderTaskLog ms |');
say('| --- | --- | --- | --- |');
const baseDir = tempWorkspace();
const location = { baseDir, sessionId: 'session-read' };
const sample = arg('sample', '');
const cases = [['p50', 268 * 1024], ['p90', 1282 * 1024], ['p99', 2335 * 1024], ['largest', 4592 * 1024], ...(sample ? [['real sample', 0]] : [])];
for (const [name, bytes] of cases) {
  const id = name.replace(' ', '-');
  core.openTaskLog(location, id, 1);
  const body = bytes ? synthetic(bytes) : fs.readFileSync(sample, 'utf8');
  fs.writeFileSync(path.join(baseDir, '.ordewell', 'sessions', 'session-read', 'tasks', id, '1.jsonl'), body);
  let events = [];
  const read = await timed(() => { events = core.readTaskLog(location, id, 1); });
  const render = await timed(() => core.renderTaskLog(events));
  say(`| ${name} | ${(body.length / 1024).toFixed(0)} KB | ${read.ms.toFixed(2)} | ${render.ms.toFixed(2)} |`);
}
fs.rmSync(baseDir, { recursive: true, force: true });
process.exit(0);
