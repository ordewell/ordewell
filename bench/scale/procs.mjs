#!/usr/bin/env node
/**
 * Real child processes: N of `bench/pipeline/fake-claude` at once through the
 * real runner, for the spawn, the pipes and the attach. A sealed run can open
 * no loopback port, so each turn ends with `noComplete` and the run is stopped
 * once they have all answered: this measures no MCP call. fake-claude is a
 * Node script, so nothing here says what a real CLI costs.
 *
 *   node bench/scale/procs.mjs [--sessions 10,100,300]
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import path from 'node:path';
import { captureConsole, core, hostSession, loadAverage, makeTasks, ms, now, numbers, planOf } from './lib.mjs';
import { mcpServerWithoutPort } from './mcp.mjs';

const { say } = captureConsole();
const fakeClaude = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../pipeline/fake-claude');
process.env.PATH = `${fakeClaude}:${process.env.PATH}`;

say(`load ${loadAverage()}`);
say('| processes | all answered s | s per spawn | lag p99 ms | lag max ms | daemon RSS growth KB per process | failed |');
say('| --- | --- | --- | --- | --- | --- | --- |');
for (const count of numbers('sessions', '10,100,300')) {
  const started = now();
  const runner = new core.StructuredRunner({ mcp: mcpServerWithoutPort(), interruptGraceMs: 500 });
  const host = hostSession({ runner, maxParallel: count });
  host.muted.status = true;
  host.muted.saves = true;
  const { session, workspace } = host;
  const tasks = makeTasks(count, { shape: 'wide', promptChars: 200 }).map((t) => ({ ...t, prompt: `${t.prompt}<fake-claude>{"noComplete":true}</fake-claude>` }));
  session.loadPlan(planOf(tasks), 'scale', workspace, { sessionId: 'session-procs', persist: false });
  const baseRss = process.memoryUsage().rss;
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  await session.execute({ command: 'run_plan' }, { kind: 'user' });
  const deadline = Date.now() + 150_000;
  const settled = () => session.store.allTasks.filter((t) => t.status === 'awaiting_user' || t.status === 'failed').length;
  while (settled() < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  const spent = ms(started) / 1000;
  lag.disable();
  const rss = process.memoryUsage().rss;
  const failures = session.store.allTasks.filter((t) => t.status === 'failed');
  const failed = failures.length ? `${failures.length}: ${failures[0].outputSummary?.reviewReason?.slice(0, 200)} ${failures[0].outputSummary?.logTail?.slice(0, 700).replace(/\n/g, ' / ')}` : 0;
  say(`| ${count} | ${spent.toFixed(1)} | ${(spent / count).toFixed(3)} | ${(lag.percentile(99) / 1e6).toFixed(0)} | ${(lag.max / 1e6).toFixed(0)} | ${Math.round((rss - baseRss) / 1024 / count)} | ${failed} |`);
  session.stopExecution();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  session.destroy();
  host.dropWorkspace();
}
process.exit(0);
