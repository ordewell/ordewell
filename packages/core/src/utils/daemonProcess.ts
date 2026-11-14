/**
 * How a client finds, probes and stops the local daemon: its port, its PID
 * file, its log, and the `GET /api/server` handshake. The CLI and the desktop
 * app both read these files, and they must read them the same way, or one of
 * them stops a daemon the other cannot see (ADR-0063 H2).
 *
 * Starting a daemon is not here: the CLI spawns its own Node binary and the
 * desktop app forks a utility process, and neither can do the other's.
 */

import http from 'http';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { globalDataDir } from './globalDataDir';
import { bearerHeaderValue, clearDaemonToken, readDaemonToken } from './daemonToken';

export const DEFAULT_DAEMON_PORT = 3742;

/**
 * The daemon contract's number, answered by `GET /api/server` and compared by
 * a client before it drives a daemon it did not start (ADR-0063 H3). Raise it
 * whenever a body in `daemonContract.ts` or a socket frame changes in a way an
 * older client or daemon would misread, and whenever a client comes to need a
 * route, or a value on an existing route, that an older daemon lacks or
 * refuses: the same contract attaches, so such a client would drive that
 * daemon into a 404 or a refusal it cannot tell from a real one. A field only
 * added, which an older side ignores or does without, need not.
 *
 * 2: the desktop's card edits go to `plans.cardEdit`, which no contract-1
 * daemon serves.
 * 3: the desktop's Explorer reads the workspace folder itself, as repo `.`,
 * which a contract-2 daemon refuses in a folder that is not a repository.
 */
export const DAEMON_CONTRACT = 3;

// Paths are read at call time, not import time: a test (and a shell that
// re-exports HOME) changes the home directory after this module loads.

/**
 * One PID file per port so a second daemon doesn't clobber the first one's
 * entry (and `stop --server --port N` kills the daemon the user meant).
 */
export function daemonPidFilePath(port: number): string {
  return pidFileIn(globalDataDir(), port);
}

/**
 * Pre-`.ordewell` install: a daemon spawned by old code wrote its PID file
 * here, so a stop falls back to it rather than orphaning that daemon behind a
 * path it doesn't know moved.
 */
export function legacyDaemonPidFilePath(port: number): string {
  return pidFileIn(join(homedir(), '.config', 'ordewell'), port);
}

function pidFileIn(dir: string, port: number): string {
  return port === DEFAULT_DAEMON_PORT ? join(dir, 'server.pid') : join(dir, `server-${port}.pid`);
}

export function daemonLogPath(): string {
  return join(globalDataDir(), 'server.log');
}

/** The PID a file names, or undefined when it is missing or not a positive integer. */
export function readPidFile(file: string): number | undefined {
  try {
    const pid = parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which daemon a client should talk to: an explicit port, else ORDEWELL_PORT,
 * else the default. Lets a client target an isolated second daemon instead of
 * whatever is already on 3742.
 */
export function resolveDaemonPort(
  explicit?: string | number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const parsedArg = typeof explicit === 'number' ? explicit : parseInt(explicit ?? '', 10);
  if (Number.isInteger(parsedArg) && parsedArg > 0) return parsedArg;
  const fromEnv = parseInt(env.ORDEWELL_PORT ?? '', 10);
  if (!isNaN(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_DAEMON_PORT;
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

export interface DaemonHttpResponse {
  status: number;
  data: string;
}

/**
 * A GET to the daemon on `port`, carrying the token file's bearer when there
 * is one. No `Origin` is ever sent: admission refuses any request with one.
 */
export function daemonHttpGet(
  port: number,
  path: string,
  timeoutMs: number = 2000,
): Promise<DaemonHttpResponse> {
  const token = readDaemonToken(port);
  const headers: Record<string, string> = token ? { Authorization: bearerHeaderValue(token) } : {};
  return new Promise((resolvePromise, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs, headers }, (res) => {
      // Decoded once the body is whole: a multi-byte character split across two
      // chunks would otherwise turn into U+FFFD at the seam.
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => resolvePromise({ status: res.statusCode || 0, data: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

export async function isDaemonRunning(port: number = DEFAULT_DAEMON_PORT): Promise<boolean> {
  try {
    const res = await daemonHttpGet(port, '/api/workspaces');
    // 401 still means a daemon owns this port. Reporting it as absent would
    // send a caller to spawn a second one that cannot bind; reporting it as
    // present lets the next real request answer with the token-file message.
    return res.status === 200 || res.status === 401;
  } catch {
    return false;
  }
}

/** What `GET /api/server` said about the process that owns the port. */
export interface DaemonIdentity {
  pid: number;
  /** The daemon's package version; absent from a daemon older than the field. */
  version?: string;
  /** The daemon contract it speaks (ADR-0063 H3); absent from a daemon older than the field. */
  contract?: number;
  /** Work is under way in a session it holds; absent from a daemon older than the field, which cannot say. */
  live?: boolean;
}

export type DaemonProbe =
  | { kind: 'daemon'; identity: DaemonIdentity }
  /** Nothing owns the port: a stale PID file and token are safe to remove. */
  | { kind: 'unreachable' }
  /**
   * The daemon's own refusal of the token presented, or of none: it runs, but
   * for another user or install, or its token file has gone stale.
   */
  | { kind: 'unauthorized'; tokenPresented: boolean }
  /** Something owns the port, but it cannot prove which process it is. Never signal it. */
  | { kind: 'unverifiable' };

// The daemon's 401 body names its token file; a stranger's 401 does not. That
// is what tells "a daemon that refuses us" from "some other server".
const DAEMON_REFUSAL_MARK = 'bearer token';

/**
 * Ask the daemon on `port` which process it is. A daemon older than this
 * route answers 404, and anything that is not a daemon answers whatever it
 * answers: both are `unverifiable`.
 */
export async function probeDaemon(port: number, timeoutMs: number = 2000): Promise<DaemonProbe> {
  let res: DaemonHttpResponse;
  try {
    res = await daemonHttpGet(port, '/api/server', timeoutMs);
  } catch (err) {
    return isConnectionRefused(err) ? { kind: 'unreachable' } : { kind: 'unverifiable' };
  }
  if (res.status === 401 && res.data.includes(DAEMON_REFUSAL_MARK)) {
    return { kind: 'unauthorized', tokenPresented: readDaemonToken(port) !== undefined };
  }
  if (res.status !== 200) return { kind: 'unverifiable' };
  const identity = parseIdentity(res.data);
  return identity ? { kind: 'daemon', identity } : { kind: 'unverifiable' };
}

function parseIdentity(body: string): DaemonIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const fields = parsed as Partial<Record<'pid' | 'version' | 'contract' | 'live', unknown>>;
  const { pid, version, contract, live } = fields;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  return {
    pid,
    ...(typeof version === 'string' ? { version } : {}),
    ...(typeof contract === 'number' && Number.isInteger(contract) ? { contract } : {}),
    ...(typeof live === 'boolean' ? { live } : {}),
  };
}

export type DaemonStopOutcome =
  | { kind: 'no-pid-file' }
  /** The file named no PID; it and the token were removed. */
  | { kind: 'unreadable-pid-file' }
  /** Something owns the port but cannot name itself: nothing was signalled. */
  | { kind: 'unverifiable'; filePid: number }
  /** Nothing was running; the stale PID file (and token) were removed. */
  | { kind: 'stale' }
  | { kind: 'stopped'; pid: number; filePid: number };

/**
 * Stop the daemon on `port` the way `ordewell stop --server` does: signal the
 * PID the daemon itself reports, and only when the PID file can be checked
 * against it, so a stale file never terminates an unrelated process.
 */
export async function stopDaemonAt(port: number = DEFAULT_DAEMON_PORT): Promise<DaemonStopOutcome> {
  let pidFile = daemonPidFilePath(port);
  if (!existsSync(pidFile) && existsSync(legacyDaemonPidFilePath(port))) pidFile = legacyDaemonPidFilePath(port);
  if (!existsSync(pidFile)) return { kind: 'no-pid-file' };

  const filePid = readPidFile(pidFile);
  if (!filePid) {
    removeQuietly(pidFile);
    clearDaemonToken(port);
    return { kind: 'unreadable-pid-file' };
  }

  const probe = await probeDaemon(port);
  if (probe.kind === 'unreachable') {
    removeQuietly(pidFile);
    // A daemon killed outright never ran its own shutdown, so its token file
    // may still be sitting there looking usable.
    clearDaemonToken(port);
    return { kind: 'stale' };
  }
  if (probe.kind !== 'daemon') {
    // A PID from an unverified file may now belong to any process the OS has
    // recycled it for. Refuse rather than risk killing something unrelated.
    return { kind: 'unverifiable', filePid };
  }

  const pid = probe.identity.pid;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code !== 'ESRCH') throw err;
    removeQuietly(pidFile);
    return { kind: 'stale' };
  }
  removeQuietly(pidFile);
  return { kind: 'stopped', pid, filePid };
}

function removeQuietly(file: string): void {
  try { unlinkSync(file); } catch { /* already gone */ }
}
