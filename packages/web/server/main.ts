#!/usr/bin/env node
import { createApp, attachWsHandler } from './app';
import { createRequestListener } from './nodeAdapter';
import { OrchestratorPool } from './pool/orchestratorPool';
import { createServer } from 'http';
import { clearDaemonToken, hasTmux, mintDaemonToken, TmuxRunner } from '@ordewell/core';

const args = process.argv.slice(2);
let port = 3742;

const portIdx = args.indexOf('--port');
if (portIdx !== -1 && args[portIdx + 1]) {
  port = parseInt(args[portIdx + 1], 10) || 3742;
}

// Set only for a daemon owned by one CLI invocation (e.g. `ordewell tui`),
// which spawns it non-detached expecting it to die with the caller. A
// closed terminal delivers SIGHUP to both via the shared process group, but
// that misses a caller killed by PID directly or a multiplexer that doesn't
// relay the signal — this poll is the fallback so an owned daemon never
// outlives its CLI and orphans don't accumulate.
const watchParentIdx = args.indexOf('--watch-parent');
const watchParentPid = watchParentIdx !== -1 ? parseInt(args[watchParentIdx + 1], 10) : undefined;

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

// Minted before the socket is listening, so no request can arrive before there
// is a token to check it against.
const { token, file: tokenFile } = mintDaemonToken(port);
const admission = { port, token, tokenFile };

const pool = new OrchestratorPool({ runner: tmuxRunner });
const app = createApp(pool, admission);

// Warm the model caches at startup (same as the VS Code extension's activation
// refresh): runner model discovery + provider routing lists, so the first
// request/plan doesn't pay the discovery latency and stale caches are rebuilt.
pool.getProviderModels().catch((err) => {
  console.error(`[web] model discovery warmup failed: ${err?.message ?? err}`);
});

app.get('/', (c) => c.json({ message: 'Ordewell API', docs: '/api/workspaces' }));

const server = createServer(createRequestListener(app));

attachWsHandler(server, pool, admission);

server.listen(port, '127.0.0.1', () => {
  console.error(`[web] Ordewell API server: http://localhost:${port}`);
});

async function shutdown(): Promise<void> {
  clearDaemonToken(port);
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

if (watchParentPid) {
  const parentCheck = setInterval(() => {
    try {
      process.kill(watchParentPid, 0);
    } catch {
      clearInterval(parentCheck);
      shutdown();
    }
  }, 5000);
}
