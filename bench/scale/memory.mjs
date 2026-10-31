#!/usr/bin/env node
/**
 * Heap per plan task, per idle Session, and what a lease's heartbeat costs.
 *
 *   node --expose-gc bench/scale/memory.mjs [--sizes 1000,10000,100000] [--sessions 100,1000]
 *
 * Tasks are parsed from JSON first, as a plan read off disk or from a planner
 * is: built here they would share one prompt string and read as next to nothing.
 */
import fs from 'node:fs';
import { captureConsole, core, heapMb, hostSession, makeTasks, ms, now, numbers, tempWorkspace } from './lib.mjs';

const { say } = captureConsole();
const sizes = numbers('sizes', '1000,10000,100000');
const counts = numbers('sessions', '100,1000');
const fromDisk = (tasks) => tasks.map((task) => JSON.parse(JSON.stringify(task)));
const IDLE = { spawn: async () => { throw new Error('nothing starts here'); }, stop: async () => {}, stopAll() {}, activeCount: 0 };

say('\n## Heap per plan task');
say('| tasks | state | PlanStore KB/task | with the copy a Session keeps KB/task |');
say('| --- | --- | --- | --- |');
for (const n of sizes) {
  for (const [state, done] of [['not started', 0], ['finished', n]]) {
    const base = heapMb();
    const store = new core.PlanStore();
    store.load(fromDisk(makeTasks(n, { done })), ['claude-code']);
    const stored = heapMb();
    const copy = store.snapshot();
    const copied = heapMb();
    say(`| ${n} | ${state} | ${(((stored - base) * 1024) / n).toFixed(2)} | ${(((copied - base) * 1024) / n).toFixed(2)} |`);
    store.load([], ['claude-code']);
    copy.length = 0;
  }
}

say('\n## Idle Sessions in one process');
say('| sessions | heap KB/session | createSession ms/session |');
say('| --- | --- | --- |');
for (const count of counts) {
  const base = heapMb();
  const t = now();
  const hosts = Array.from({ length: count }, () => hostSession({ runner: IDLE, workspace: '/tmp' }));
  const spent = ms(t);
  say(`| ${count} | ${(((heapMb() - base) * 1024) / count).toFixed(1)} | ${(spent / count).toFixed(3)} |`);
  for (const host of hosts) host.session.destroy();
}

say('\n## Lease heartbeat: one host holding S sessions, every 10 s, synchronously on the event loop');
say('| sessions | beat ms | share of the 10 s period |');
say('| --- | --- | --- |');
for (const count of [...counts, 10000]) {
  const workspace = tempWorkspace();
  const lease = new core.LeaseHost({ runnerGroups: () => [] });
  for (let i = 0; i < count; i += 1) lease.lease(() => {}).claim(`session-${i}`, workspace);
  lease.stopHeartbeat();
  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    const t = now();
    lease.beat();
    runs.push(ms(t));
  }
  const best = Math.min(...runs);
  say(`| ${count} | ${best.toFixed(1)} | ${((best / 10000) * 100).toFixed(2)}% |`);
  lease.releaseAll();
  fs.rmSync(workspace, { recursive: true, force: true });
}
process.exit(0);
