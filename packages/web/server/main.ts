#!/usr/bin/env node
import { createApp, attachWsHandler } from './app';
import { createRequestListener } from './nodeAdapter';
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
const app = createApp(pool, port);

// Warm the model caches at startup (same as the VS Code extension's activation
// refresh): runner model discovery + provider routing lists, so the first
// request/plan doesn't pay the discovery latency and stale caches are rebuilt.
pool.getProviderModels().catch((err) => {
  console.error(`[web] model discovery warmup failed: ${err?.message ?? err}`);
});

app.get('/', (c) => c.json({ message: 'Ordewell API', docs: '/api/workspaces' }));

const server = createServer(createRequestListener(app));

attachWsHandler(server, pool, port);

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
