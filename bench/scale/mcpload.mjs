#!/usr/bin/env node
/**
 * What the MCP server alone carries: closed-loop clients in other processes,
 * each call a no-op tool on the daemon, over one connection each.
 *
 *   node bench/scale/mcpload.mjs [--clients 10,100,1000] [--seconds 8]
 */
import { arg, captureConsole, loadAverage, ms, now, numbers } from './lib.mjs';
import { LoadGen, mcpServerWithoutPort, percentile } from './mcp.mjs';

const { say } = captureConsole();
const clients = numbers('clients', '10,100,1000');
const seconds = Number(arg('seconds', '8'));

say(`load ${loadAverage()}`);
say('| clients | tools/call req/s | p50 ms | p99 ms | daemon CPU s per s | CPU ms per request | tools/list req/s |');
say('| --- | --- | --- | --- | --- | --- | --- |');
for (const count of clients) {
  const server = mcpServerWithoutPort();
  const load = new LoadGen(server, count, Math.min(4, count));
  const grants = await Promise.all(Array.from({ length: count }, (_, i) => server.issueTaskToken(
    { sessionId: 'load', taskId: `t${i}`, attempt: 1 },
    { taskComplete: async () => ({ text: 'Recorded. End your turn now.' }) },
  )));
  const loop = async (grant, kind, until, sent) => {
    const headers = { Authorization: `Bearer ${grant.token}` };
    while (Date.now() < until) {
      if (kind === 'list') await load.send({ kind: 'list', path: '/mcp', headers });
      else await load.complete(grant.url, headers, { status: 'done', summary: 'a short report of what changed' });
      sent.count += 1;
    }
  };
  const run = async (kind) => {
    const sent = { count: 0 };
    const cpu = process.cpuUsage();
    const t = now();
    await Promise.all(grants.map((g) => loop(g, kind, Date.now() + seconds * 1000, sent)));
    const wall = ms(t) / 1000;
    const used = process.cpuUsage(cpu);
    return { rate: sent.count / wall, cpuPerSecond: (used.user + used.system) / 1e6 / wall, cpuPerRequest: (used.user + used.system) / 1000 / sent.count };
  };
  const call = await run('complete');
  const list = await run('list');
  say(`| ${count} | ${Math.round(call.rate)} | ${percentile(load.latencies.complete, 0.5).toFixed(1)} | ${percentile(load.latencies.complete, 0.99).toFixed(1)} | ${call.cpuPerSecond.toFixed(2)} | ${call.cpuPerRequest.toFixed(2)} | ${Math.round(list.rate)} |`);
  load.stop();
  server.http.closeAllConnections();
}
process.exit(0);
