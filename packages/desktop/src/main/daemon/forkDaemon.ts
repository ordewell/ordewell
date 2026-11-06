import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { utilityProcess } from 'electron';
import { daemonLogPath, daemonPidFilePath } from '@ordewell/core/daemon-client';
import type { OwnedProcess } from './DaemonManager';

/**
 * A utility process is a separate Node process: it reads the script from disk
 * and cannot see inside `app.asar`. electron-builder.yml unpacks the daemon's
 * files next to the archive, so a path `require.resolve` found inside it is
 * the same path with `app.asar.unpacked`.
 */
export function unpackedFromAsar(path: string): string {
  return path.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked');
}

/**
 * The daemon entry this app bundles: @ordewell/web's built server. A source
 * checkout without a linked package falls back to the sibling workspace.
 */
export function bundledDaemonEntry(): string {
  try {
    return unpackedFromAsar(join(dirname(require.resolve('@ordewell/web/package.json')), 'dist', 'server', 'main.js'));
  } catch {
    return join(__dirname, '..', '..', '..', 'web', 'dist', 'server', 'main.js');
  }
}

/**
 * Start the bundled daemon as a utility process the app owns (ADR-0063 H2):
 * never `process.execPath`, which in a packaged app is the app itself, and
 * with `RunAsNode` fused off could not be made to run a script anyway.
 *
 * No `--watch-parent`: a utility process ends with the app that forked it,
 * and that flag would have a lease refusal name this app as a TUI (ADR-0049).
 */
export function forkBundledDaemon(port: number): OwnedProcess {
  const entry = bundledDaemonEntry();
  if (!existsSync(entry)) throw new Error(`The bundled daemon is missing at ${entry}; build @ordewell/web first.`);
  const pidFile = daemonPidFilePath(port);
  mkdirSync(dirname(pidFile), { recursive: true });

  const child = utilityProcess.fork(entry, ['--port', String(port), '--pid-file', pidFile], {
    serviceName: 'Ordewell daemon',
    stdio: 'pipe',
    // main has already widened PATH with the login shell's (index.ts): a GUI
    // launch inherits launchd's, which finds none of the runners.
    env: { ...process.env },
    // A daemon asks the runners about logins from its cwd (ADR-0016); the
    // app's own directory is inside its bundle, the home folder is neutral.
    cwd: homedir(),
  });

  // The same log the CLI's daemon writes to, so `Check logs` names one file.
  const log = createWriteStream(daemonLogPath(), { flags: 'a' });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  let exited = false;
  let exitWaiters: Array<() => void> = [];
  const exitListeners: Array<(code: number) => void> = [];
  child.on('exit', (code) => {
    exited = true;
    log.end();
    for (const resolve of exitWaiters) resolve();
    exitWaiters = [];
    for (const listener of exitListeners) listener(code);
  });

  return {
    get pid() {
      return child.pid;
    },
    onExit(cb) {
      exitListeners.push(cb);
    },
    stop() {
      if (exited) return Promise.resolve();
      return new Promise<void>((resolve) => {
        exitWaiters.push(resolve);
        // SIGTERM runs the daemon's own shutdown, which removes its token and
        // PID file; kill() on a utility process sends exactly that.
        child.kill();
        setTimeout(() => {
          if (exited) return;
          if (child.pid !== undefined) {
            try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
          }
          resolve();
        }, 5_000).unref();
      });
    },
  };
}
