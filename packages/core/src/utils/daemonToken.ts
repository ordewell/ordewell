/**
 * The daemon's bearer token: minted at startup, written beside the per-port
 * process-id file, read by the CLI.
 *
 * Header validation defends against browsers and nothing else. This is what
 * stops another process running as the same user — an install script in the
 * very repository the planner was pointed at, say — from driving the daemon
 * just because it can see the port.
 *
 * Both ends of the wire live here so the carrier encodings cannot drift: the
 * daemon extracts with the same functions the CLI attaches with.
 */

import { randomBytes, timingSafeEqual } from 'crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'fs';
import { join } from 'path';
import { globalDataDir } from './globalDataDir';

const BEARER_PREFIX = 'bearer ';

/**
 * The subprotocol the token rides on during the WebSocket upgrade. A query
 * parameter would land in access logs and in `ps`; a subprotocol travels in a
 * request header like the HTTP `Authorization` it stands in for.
 */
export const DAEMON_TOKEN_SUBPROTOCOL_PREFIX = 'ordewell.token.';

/**
 * Offered alongside the token subprotocol, and the one the server selects, so
 * the 101 response never echoes the secret back.
 */
export const DAEMON_SUBPROTOCOL = 'ordewell.v1';

function configDir(): string {
  return globalDataDir();
}

/**
 * One token file per port, with no default-port special case: unlike the
 * process-id file there is no legacy name to preserve, and naming every file
 * after its port is what stops a second daemon clobbering the first's token.
 */
export function daemonTokenPath(port: number): string {
  return join(configDir(), `server-${port}.token`);
}

/**
 * Mint this daemon's token and hand it off through the filesystem.
 *
 * Unlink-then-create-exclusively rather than a plain write: `mode` is ignored
 * when the file already exists, so writing over a pre-created file would leave
 * the token at whatever permissions that file already had, and an existing
 * symlink would carry the write somewhere else entirely.
 */
export function mintDaemonToken(port: number): { token: string; file: string } {
  const token = randomBytes(32).toString('base64url');
  const file = daemonTokenPath(port);

  mkdirSync(configDir(), { recursive: true });
  try {
    unlinkSync(file);
  } catch {
    // Nothing there is the normal case.
  }
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }

  return { token, file };
}

/** The token a client should present to the daemon on `port`, if one has been minted. */
export function readDaemonToken(port: number): string | undefined {
  try {
    const token = readFileSync(daemonTokenPath(port), 'utf8').trim();
    return token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}

/** Best-effort cleanup on shutdown, so a dead daemon leaves no usable-looking token behind. */
export function clearDaemonToken(port: number): void {
  try {
    unlinkSync(daemonTokenPath(port));
  } catch {
    // Already gone, or never written.
  }
}

/** The `Authorization` header value for HTTP requests. */
export function bearerHeaderValue(token: string): string {
  return `Bearer ${token}`;
}

/** What a client offers on the upgrade: the real subprotocol first, the token second. */
export function tokenSubprotocols(token: string): string[] {
  return [DAEMON_SUBPROTOCOL, `${DAEMON_TOKEN_SUBPROTOCOL_PREFIX}${token}`];
}

export interface TokenCarriers {
  /** `Authorization: Bearer <token>` — the HTTP carrier. */
  authorization?: string | null;
  /** `Sec-WebSocket-Protocol` — the upgrade carrier. */
  secWebSocketProtocol?: string | null;
}

/** Pull the token out of whichever carrier it arrived on. */
export function extractPresentedToken(carriers: TokenCarriers): string | undefined {
  const authorization = carriers.authorization;
  if (authorization && authorization.toLowerCase().startsWith(BEARER_PREFIX)) {
    const value = authorization.slice(BEARER_PREFIX.length).trim();
    if (value !== '') return value;
  }

  for (const offered of (carriers.secWebSocketProtocol ?? '').split(',')) {
    const value = offered.trim();
    if (!value.startsWith(DAEMON_TOKEN_SUBPROTOCOL_PREFIX)) continue;
    const token = value.slice(DAEMON_TOKEN_SUBPROTOCOL_PREFIX.length);
    if (token !== '') return token;
  }

  return undefined;
}

/** Constant-time comparison, so a wrong token leaks no information about the right one. */
export function tokensMatch(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch; the length is not the secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
