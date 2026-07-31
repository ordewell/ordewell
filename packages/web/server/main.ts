#!/usr/bin/env node
import { createApp, attachWsHandler } from './app';
import { OrchestratorPool } from './pool/orchestratorPool';
import { createServer } from 'http';
import { hasTmux, TmuxRunner } from '@ordewell/core';

const args = process.argv.slice(2);
let port = 3742;

const portIdx = args.indexOf('--port');
if (portIdx !== -1 && args[portIdx + 1]) {
  port = parseInt(args[portIdx + 1], 10) || 3742;
}

// Tasks run in a real tmux window (so `ordewell tui` can open a genuine
// interactive terminal on them) whenever tmux is on the host; otherwise this
// falls straight back to today's headless-per-session default (see
// OrchestratorPool's `runner` dep).
const tmuxRunner = hasTmux() ? new TmuxRunner({ port }) : undefined;
if (tmuxRunner) {
  // Failure is not fatal here: ensureSession is memoized and each spawn
  // re-awaits it, so the next task retries the setup rather than giving up.
  tmuxRunner.ensureSession().catch((err) => {
    console.error(`[web] tmux session setup failed (will retry on next task spawn): ${err?.message ?? err}`);
  });
}

const pool = new OrchestratorPool({ runner: tmuxRunner });
const app = createApp(pool);

// Warm the model caches at startup (same as the VS Code extension's activation
// refresh): runner model discovery + provider routing lists, so the first
// request/plan doesn't pay the discovery latency and stale caches are rebuilt.
pool.getProviderModels().catch((err) => {
  console.error(`[web] model discovery warmup failed: ${err?.message ?? err}`);
});

app.get('/', (c) => c.json({ message: 'Ordewell API', docs: '/api/workspaces' }));

const server = createServer(async (req, res) => {
  const bufs: Buffer[] = [];
  for await (const chunk of req) bufs.push(chunk);
  const body = bufs.length > 0 ? Buffer.concat(bufs).toString() : undefined;

  const url = `http://${req.headers.host || 'localhost'}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v) {
      if (Array.isArray(v)) v.forEach(vv => headers.append(k, vv));
      else headers.set(k, v as string);
    }
  }
  if (body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const webReq = new Request(url, {
    method: req.method || 'GET',
    headers,
    body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
  });

  try {
    const webRes = await app.fetch(webReq);
    res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
    if (webRes.body) {
      const reader = webRes.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? (err as Error).message : 'Internal server error' }));
    }
  }
});

attachWsHandler(server, pool);

server.listen(port, '127.0.0.1', () => {
  console.error(`[web] Ordewell API server: http://localhost:${port}`);
});

async function shutdown(): Promise<void> {
  pool.destroyAll();
  // The one cleanup guarantee against leaked tmux processes: killing the
  // shared session takes every window (and whatever's running in it) with it.
  if (tmuxRunner) await tmuxRunner.killSession().catch(() => {});
  server.close();
  process.exit(0);
}

process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });
process.on('SIGHUP', () => { shutdown(); });
