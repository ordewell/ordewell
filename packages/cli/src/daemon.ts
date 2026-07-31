import { spawn } from 'child_process';
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, openSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import http from 'http';

export const DEFAULT_PORT = 3742;
const CONFIG_DIR = join(homedir(), '.config', 'ordewell');
const LEGACY_PID_FILE = join(CONFIG_DIR, 'server.pid');

// One PID file per port so a second daemon doesn't clobber the first one's
// entry (and `stop --server --port N` kills the daemon the user meant).
function pidFileFor(port: number): string {
  return port === DEFAULT_PORT ? LEGACY_PID_FILE : join(CONFIG_DIR, `server-${port}.pid`);
}

function httpGet(url: string, timeoutMs: number = 2000): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode || 0, data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

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

export async function isDaemonRunning(port: number = DEFAULT_PORT): Promise<boolean> {
  try {
    const res = await httpGet(`http://127.0.0.1:${port}/api/workspaces`);
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function startDaemon(
  port: number = DEFAULT_PORT,
  opts?: { detached?: boolean; quiet?: boolean },
): Promise<void> {
  // A raw-mode full-screen client cannot afford stray writes to stdout: they
  // land inside the frame it is painting. `quiet` is for a revive that happens
  // while the TUI is on screen, not for startup, where the messages are useful.
  const say = opts?.quiet ? () => {} : (msg: string) => console.log(msg);
  if (await isDaemonRunning(port)) {
    say(`Server already running on http://127.0.0.1:${port}`);
    return;
  }

  const serverPath = getWebServerPath();

  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const logFd = openSync(join(CONFIG_DIR, 'server.log'), 'a');
  // detached=false puts the daemon in the caller's own process group, so a
  // terminal hangup (closing the tab) reaches it via the same kernel-delivered
  // SIGHUP as the caller — no JS-level signal relay required, and none of the
  // native stdio-teardown races a JS handler is exposed to on that path. Only
  // the TUI opts into this; every other command wants the default detached,
  // outlives-this-invocation daemon.
  const detached = opts?.detached ?? true;

  const child = spawn(process.execPath, [serverPath, '--port', String(port)], {
    detached,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });

  if (detached) child.unref();
  writeFileSync(pidFileFor(port), String(child.pid));

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isDaemonRunning(port)) {
      say(`Server started on http://127.0.0.1:${port} (PID ${child.pid})`);
      return;
    }
  }

  const failure = `Server did not respond within 15s. Check logs: ${join(CONFIG_DIR, 'server.log')}`;
  // A quiet caller is a live TUI: killing its process would drop the user out
  // of a full-screen app with a half-restored terminal, so it gets a throw to
  // handle instead. Every other caller keeps the exit it has always had.
  if (opts?.quiet) throw new Error(failure);
  console.error(failure);
  process.exit(1);
}

export async function stopDaemon(port: number = DEFAULT_PORT): Promise<boolean> {
  const pidFile = pidFileFor(port);
  if (!existsSync(pidFile)) {
    console.error(`No server PID file found for port ${port}. Is the server running?`);
    return false;
  }
  try {
    const pidStr = readFileSync(pidFile, 'utf8').trim();
    const pid = parseInt(pidStr, 10);
    if (!pid || isNaN(pid)) {
      unlinkSync(pidFile);
      return false;
    }
    process.kill(pid, 'SIGTERM');
    unlinkSync(pidFile);
    console.log(`Server stopped (PID ${pid}).`);
    return true;
  } catch (err) {
    if ((err as Error & { code?: string }).code === 'ESRCH') {
      try { unlinkSync(pidFile); } catch { /* empty */ }
      console.log('Server was not running (stale PID removed).');
      return true;
    }
    throw err;
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
  opts?: { detached?: boolean; quiet?: boolean },
): Promise<{ port: number; owned: boolean }> {
  const p = port || DEFAULT_PORT;
  if (await isDaemonRunning(p)) return { port: p, owned: false };
  if (!opts?.quiet) console.error(`Server not running. Starting daemon on port ${p}...`);
  await startDaemon(p, opts);
  return { port: p, owned: true };
}

/**
 * True when this error means "nothing was listening", as opposed to "the
 * server answered badly" or "the connection broke mid-flight".
 *
 * The distinction is what makes an automatic retry safe. ECONNREFUSED is
 * refused at the TCP handshake, so the request was never delivered and cannot
 * have been half-applied — replaying it is not a second execution. ECONNRESET
 * and EPIPE are deliberately *not* included: those can arrive after the server
 * read the request, so a retry could start a second plan or a second run.
 */
export function isConnectionRefused(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ECONNREFUSED') return true;
  // The code survives a normal reject, but not every layer preserves it —
  // `String(err)` through a worker boundary keeps only the message.
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('ECONNREFUSED');
}

/**
 * What to tell a user whose daemon is not there. Node's own wording — `connect
 * ECONNREFUSED 127.0.0.1:3742` — names a socket, not a thing they can act on.
 */
export function describeConnectionRefused(port: number): string {
  return `No Ordewell server is listening on port ${port}. `
    + `It may have been stopped, or it may have crashed — check ${join(CONFIG_DIR, 'server.log')}. `
    + `Start one with \`ordewell web --daemon\`.`;
}

/**
 * Which daemon a command should talk to: explicit `--port`, else ORDEWELL_PORT,
 * else the default. Lets a CLI invocation target an isolated second daemon
 * instead of whatever is already on 3742.
 */
export function resolvePort(args: string[] = []): number {
  const idx = args.indexOf('--port');
  if (idx !== -1) {
    const parsed = parseInt(args[idx + 1] ?? '', 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  const fromEnv = parseInt(process.env.ORDEWELL_PORT ?? '', 10);
  if (!isNaN(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_PORT;
}
