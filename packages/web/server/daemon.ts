import { createApp, attachWsHandler } from './app';
import { createRequestListener } from './nodeAdapter';
import { OrchestratorPool } from './pool/orchestratorPool';
import { createServer } from 'http';
import { mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { clearDaemonToken, mintDaemonToken, processLeaseHost, StructuredRunner } from '@ordewell/core';

/**
 * The daemon: the API server the CLI, the TUI and the desktop app drive over
 * 127.0.0.1. `main.ts` runs it with its own argv; the standalone CLI binary
 * runs it in-process as `ordewell __daemon ...`, having no server file to
 * spawn (ADR-0065). It owns the process from here on: its signal handlers end it.
 */
export function runDaemon(args: string[]): void {
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

  // Written by the daemon itself only once it is listening, and removed on
  // shutdown, so `ordewell stop --server` never reads an entry belonging to a
  // process that failed to bind or a daemon that is already gone.
  const pidFileIdx = args.indexOf('--pid-file');
  const pidFile = pidFileIdx !== -1 ? args[pidFileIdx + 1] : undefined;
  let ownsPidFile = false;

  // What another host's refusal names this one as (ADR-0049). Only a TUI starts
  // a daemon it watches, as its private one.
  processLeaseHost().describe({ kind: 'daemon', port, ...(watchParentPid ? { ownerPid: watchParentPid } : {}) });

  // Tasks run on the structured transport (ADR-0018) as plain child processes,
  // so one runner serves every plan whatever the host has.
  const pool = new OrchestratorPool({ runner: new StructuredRunner() });
  // Before listening, so the first request already finds the probe in flight
  // and waits on it rather than reading the openrouter fallback (ADR-0009).
  void pool.detectInstalledPlanner();
  const server = createServer();
  let ownsToken = false;

  server.listen(port, '127.0.0.1', () => {
    // A losing startup must not replace the listening daemon's credential.
    // This callback installs admission before the event loop can serve a request.
    const { token, file: tokenFile } = mintDaemonToken(port);
    ownsToken = true;
    if (pidFile) {
      mkdirSync(dirname(pidFile), { recursive: true });
      writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
      ownsPidFile = true;
    }
    const admission = { port, token, tokenFile };
    const app = createApp(pool, admission);
    app.get('/', (c) => c.json({ message: 'Ordewell API', docs: '/api/workspaces' }));
    server.on('request', createRequestListener(app, admission));
    attachWsHandler(server, pool, admission);
    pool.getProviderModels().catch((err) => {
      console.error(`[web] model discovery warmup failed: ${err?.message ?? err}`);
    });
    console.error(`[web] Ordewell API server: http://localhost:${port}`);
  });

  function shutdown(): void {
    if (ownsToken) clearDaemonToken(port);
    if (ownsPidFile && pidFile) {
      try { unlinkSync(pidFile); } catch { /* already gone */ }
    }
    pool.destroyAll();
    server.close();
    process.exit(0);
  }

  // A stray rejection in one session's background work must not take every
  // session's runners down with the daemon.
  process.on('unhandledRejection', (reason) => {
    console.error(`[web] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });

  // A daemon this CLI owns shares its foreground process group. Ctrl-C while a
  // login child holds the terminal is a SIGINT to that whole group, and the TUI
  // ignores it so the child alone is cancelled; shutting down here would take
  // every in-memory session with it. The owner stops us with SIGTERM, and the
  // parent watch below still catches an owner that dies.
  process.on('SIGINT', () => { if (!watchParentPid) shutdown(); });
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
}
