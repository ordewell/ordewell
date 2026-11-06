import { spawn } from 'child_process';
import { existsSync, mkdirSync, openSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { createServer } from 'net';
import {
  DAEMON_CONTRACT,
  DEFAULT_DAEMON_PORT,
  daemonLogPath,
  daemonPidFilePath,
  globalDataDir,
  isDaemonRunning,
  isSea,
  probeDaemon,
  readPidFile,
  resolveDaemonPort,
  stopDaemonAt,
  type DaemonProbe,
} from '@ordewell/core';
import { flag } from './utils/args';
import { cliVersion } from './version';

// The probe, token and PID-file helpers live in core so the desktop app reads
// the same files the same way (ADR-0063 H2); this module keeps the CLI's
// spawning and its wording.
export const DEFAULT_PORT = DEFAULT_DAEMON_PORT;
export { isConnectionRefused, isDaemonRunning } from '@ordewell/core';

// The server ships as its own package (`@ordewell/web`) that this CLI depends
// on, so the installed layout resolves it like any other dependency. The
// relative path is the source-checkout case, where nothing is in node_modules
// yet — it is a fallback, not the primary, because it silently resolves to the
// wrong scope directory under a non-flat install.
function getWebServerPath(): string {
  const candidates: string[] = [];
  try {
    candidates.push(join(dirname(require.resolve('@ordewell/web/package.json')), 'dist', 'server', 'main.js'));
  } catch {
    // Not installed as a dependency — a source checkout, handled below.
  }
  candidates.push(resolve(__dirname, '..', '..', 'web', 'dist', 'server', 'main.js'));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Ordewell server not found (looked in: ${candidates.join(', ')}). `
    + `In a source checkout, run: npm run build -w packages/web`
  );
}

/**
 * The process that runs a daemon with `daemonArgs`. Outside the binary that is
 * the web package's server file under this Node. The standalone binary has no
 * server file and no Node beside it: it is its own daemon, entered as
 * `<binary> __daemon ...` (ADR-0065), so `serverPath` is never consulted there.
 */
export function daemonCommand(
  daemonArgs: string[],
  serverPath: () => string,
  sea: boolean = isSea(),
): { file: string; args: string[] } {
  return { file: process.execPath, args: sea ? ['__daemon', ...daemonArgs] : [serverPath(), ...daemonArgs] };
}

export async function startDaemon(
  port: number = DEFAULT_PORT,
  opts?: { detached?: boolean; quiet?: boolean; cwd?: string },
): Promise<void> {
  // A raw-mode full-screen client cannot afford stray writes to stdout: they
  // land inside the frame it is painting. `quiet` is for a revive that happens
  // while the TUI is on screen, not for startup, where the messages are useful.
  const say = opts?.quiet ? () => {} : (msg: string) => console.log(msg);
  if (await isDaemonRunning(port)) {
    say(`Server already running on http://127.0.0.1:${port}`);
    return;
  }

  const pidFile = daemonPidFilePath(port);
  // detached=false puts the daemon in the caller's own process group, so a
  // terminal hangup (closing the tab) reaches it via the same kernel-delivered
  // SIGHUP as the caller — no JS-level signal relay required, and none of the
  // native stdio-teardown races a JS handler is exposed to on that path. Only
  // the TUI opts into this; every other command wants the default detached,
  // outlives-this-invocation daemon.
  const detached = opts?.detached ?? true;

  // Belt-and-braces for the not-detached case: process-group SIGHUP covers a
  // closed terminal tab, but not a caller killed by PID directly (`kill -9`)
  // or a multiplexer that doesn't relay the signal. `--watch-parent` has the
  // daemon poll for that and self-terminate, so an owned daemon never
  // outlives the CLI that spawned it and orphans don't accumulate.
  const command = daemonCommand([
    '--port', String(port),
    // The daemon writes the file itself once it is listening, and removes it
    // on shutdown. A CLI-side write before the bind would leave the loser of a
    // two-CLI race owning the winner's entry, or a dead PID after a crash.
    '--pid-file', pidFile,
    ...(detached ? [] : ['--watch-parent', String(process.pid)]),
  ], getWebServerPath);

  const dir = globalDataDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const logFd = openSync(daemonLogPath(), 'a');
  const child = spawn(command.file, command.args, {
    detached,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
    // A daemon owned by a workspace client must ask that workspace's account
    // about a login (ADR-0016), not the directory the client was launched from.
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
  });

  if (detached) child.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isDaemonRunning(port)) {
      // The daemon's own PID, not the child's: a child that lost the bind race
      // has exited, and the winner is what the message must name.
      say(`Server started on http://127.0.0.1:${port} (PID ${readPidFile(pidFile) ?? child.pid})`);
      return;
    }
  }

  const failure = `Server did not respond within 15s. Check logs: ${daemonLogPath()}`;
  // A quiet caller is a live TUI: killing its process would drop the user out
  // of a full-screen app with a half-restored terminal, so it gets a throw to
  // handle instead. Every other caller keeps the exit it has always had.
  if (opts?.quiet) throw new Error(failure);
  console.error(failure);
  process.exit(1);
}

export async function stopDaemon(port: number = DEFAULT_PORT): Promise<boolean> {
  const outcome = await stopDaemonAt(port);
  switch (outcome.kind) {
    case 'no-pid-file':
      console.error(`No server PID file found for port ${port}. Is the server running?`);
      return false;
    case 'unreadable-pid-file':
      console.error(`Removed an unreadable PID file for port ${port}. Is the server running?`);
      return false;
    case 'unverifiable':
      console.error(
        `A server owns port ${port} but could not name its own process (it may predate this check, or the token file is stale). `
        + `Not signalling PID ${outcome.filePid}. Stop it yourself with: kill ${outcome.filePid}`,
      );
      return false;
    case 'stale':
      console.log('Server was not running (stale PID removed).');
      return true;
    case 'stopped':
      console.log(outcome.pid === outcome.filePid
        ? `Server stopped (PID ${outcome.pid}).`
        : `Server stopped (PID ${outcome.pid}); its PID file named the stale ${outcome.filePid}.`);
      return true;
  }
}

export async function ensureDaemon(port?: number): Promise<number> {
  const { port: p } = await ensureDaemonOwned(port);
  return p;
}

/**
 * Like `ensureDaemon`, but also reports whether this call spawned a fresh
 * daemon vs. found one already running. Callers that want to tie the
 * daemon's life to their own (e.g. the TUI) must only do so when `owned` is
 * true — otherwise they'd kill a daemon some other client (a concurrent
 * `ordewell web` or `ordewell tui`) is relying on.
 */
export async function ensureDaemonOwned(
  port?: number,
  opts?: { detached?: boolean; quiet?: boolean; cwd?: string },
): Promise<{ port: number; owned: boolean }> {
  const p = port || DEFAULT_PORT;
  const note = opts?.quiet ? () => {} : (msg: string) => console.error(msg);
  if (await isDaemonRunning(p)) {
    const found = await probeDaemon(p);
    if (drivable(found)) return { port: p, owned: false };
    await stopIdleDaemon(p, found);
    note(`Stopped the idle server on port ${p}, which ran ${ranBy(found)}. Starting one for Ordewell ${cliVersion()}...`);
  } else {
    note(`Server not running. Starting daemon on port ${p}...`);
  }
  await startDaemon(p, opts);
  return { port: p, owned: true };
}

/**
 * A daemon this CLI may drive: one with the contract it was built against
 * (ADR-0063 H3). A refused token says nothing of the version, and the next
 * request names the token file; a daemon gone since the first probe leaves
 * the port to the start that follows.
 */
function drivable(found: DaemonProbe): boolean {
  return found.kind === 'unauthorized' || found.kind === 'unreachable'
    || (found.kind === 'daemon' && found.identity.contract === DAEMON_CONTRACT);
}

function ranBy(found: DaemonProbe): string {
  return found.kind === 'daemon' && found.identity.version ? `Ordewell ${found.identity.version}` : 'an older Ordewell';
}

/** How long a stopped daemon may take to let go of its port. */
const PORT_RELEASE_MS = 10_000;

/**
 * After an upgrade the daemon left on a port may be an older one this CLI
 * cannot drive (ADR-0048). One idle there is stopped, so a new one can take
 * the port. One with work under way, or too old to say, is left running: a
 * stop would cut that work off, so the user is told how to go on instead.
 */
async function stopIdleDaemon(port: number, found: DaemonProbe): Promise<void> {
  const stopCommand = `ordewell stop --server${port === DEFAULT_PORT ? '' : ` --port ${port}`}`;
  const cannotDrive = `The server on port ${port} runs ${ranBy(found)}, which this Ordewell ${cliVersion()} cannot drive.`;
  const goOn = `Once nothing runs there, stop it with \`${stopCommand}\` and run this again.`;
  const live = found.kind === 'daemon' ? found.identity.live : undefined;
  if (live !== false) {
    const why = live ? 'It has work under way' : 'It cannot say whether work is under way there';
    throw new Error(`${cannotDrive} ${why}, so it was left running. ${goOn}`);
  }
  const outcome = await stopDaemonAt(port);
  if (outcome.kind !== 'stopped' && outcome.kind !== 'stale') {
    throw new Error(`${cannotDrive} It could not be stopped from here (${outcome.kind}), so it was left running. ${goOn}`);
  }
  for (const until = Date.now() + PORT_RELEASE_MS; await isDaemonRunning(port);) {
    if (Date.now() > until) throw new Error(`${cannotDrive} It was asked to stop, but still holds the port after ${PORT_RELEASE_MS / 1000}s. ${goOn}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * What to tell a user whose daemon is not there. Node's own wording — `connect
 * ECONNREFUSED 127.0.0.1:3742` — names a socket, not a thing they can act on.
 */
export function describeConnectionRefused(port: number): string {
  return `No Ordewell server is listening on port ${port}. `
    + `It may have been stopped, or it may have crashed: check ${daemonLogPath()}. `
    + `Start one with \`ordewell web --daemon\`.`;
}

/**
 * An OS-assigned free port, so a caller that wants a private daemon doesn't
 * have to guess one that's actually unused.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolvePromise(port));
    });
  });
}

/**
 * Which daemon a command should talk to: explicit `--port`, else ORDEWELL_PORT,
 * else the default. Lets a CLI invocation target an isolated second daemon
 * instead of whatever is already on 3742.
 */
export function resolvePort(args: string[] = []): number {
  return resolveDaemonPort(flag(args, '--port'));
}
