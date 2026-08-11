/**
 * The single admission decision for the daemon.
 *
 * Both the HTTP middleware and the WebSocket upgrade handler call this. The
 * sharing is the point: the two paths drifting apart is how the upgrade ended
 * up validating nothing while the HTTP routes had a CORS allowlist.
 */

import { extractPresentedToken, tokensMatch } from '@ordewell/core';

/** `localhost` is included because clients dial it by name; the daemon binds loopback only. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

export interface AdmissionHeaders {
  /** `null`/`undefined` mean absent. An empty string still counts as present. */
  origin?: string | null;
  host?: string | null;
  /** `Authorization: Bearer <token>` — how the token travels on HTTP routes. */
  authorization?: string | null;
  /** `Sec-WebSocket-Protocol` — how it travels on the upgrade, so it stays out of logs. */
  secWebSocketProtocol?: string | null;
}

/** What this daemon is: which port it bound, and which token it minted. */
export interface AdmissionContext {
  port: number;
  token: string;
  /** Named in a token rejection, so a stale token is diagnosable rather than a bare failure. */
  tokenFile: string;
}

export type AdmissionDecision =
  | { admit: true }
  | { admit: false; status: number; reason: string };

const ADMIT: AdmissionDecision = { admit: true };

export function decideAdmission(
  headers: AdmissionHeaders,
  context: AdmissionContext,
): AdmissionDecision {
  if (headers.origin !== undefined && headers.origin !== null) {
    return {
      admit: false,
      status: 403,
      reason: 'Refused: requests carrying an Origin header are not accepted. The Ordewell daemon has no browser client.',
    };
  }

  if (!isOwnLoopbackAuthority(headers.host, context.port)) {
    return {
      admit: false,
      status: 403,
      reason: `Refused: the Host header must name loopback (localhost, 127.0.0.1 or [::1]) at port ${context.port}.`,
    };
  }

  if (!tokensMatch(extractPresentedToken(headers), context.token)) {
    return {
      admit: false,
      status: 401,
      reason:
        'Unauthenticated: this request did not present the daemon\'s bearer token. '
        + `Ordewell clients read it from ${context.tokenFile}; if that file is stale, `
        + 'restart the daemon (`ordewell web --daemon`) to mint a fresh one.',
    };
  }

  return ADMIT;
}

/**
 * Rejecting anything but our own loopback authority is what closes DNS
 * rebinding: a page rebinding a hostname it controls to 127.0.0.1 still sends
 * that hostname in `Host`, and same-origin requests to it carry no `Origin`.
 */
function isOwnLoopbackAuthority(host: string | null | undefined, port: number): boolean {
  if (!host) return false;
  const authority = splitAuthority(host);
  if (!authority) return false;
  if (!LOOPBACK_HOSTNAMES.has(authority.hostname.toLowerCase())) return false;
  return authority.port === port;
}

/** Absent port means the scheme default; the daemon only ever speaks http. */
const DEFAULT_HTTP_PORT = 80;

function splitAuthority(host: string): { hostname: string; port: number } | undefined {
  const value = host.trim();
  if (value === '') return undefined;

  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return undefined;
    const hostname = value.slice(1, close);
    const rest = value.slice(close + 1);
    if (rest === '') return { hostname, port: DEFAULT_HTTP_PORT };
    if (!rest.startsWith(':')) return undefined;
    return withPort(hostname, rest.slice(1));
  }

  const colon = value.indexOf(':');
  if (colon === -1) return { hostname: value, port: DEFAULT_HTTP_PORT };
  // An unbracketed second colon is a bare IPv6 literal, which is malformed in a
  // Host header — refuse rather than guess where the port starts.
  if (value.indexOf(':', colon + 1) !== -1) return undefined;
  return withPort(value.slice(0, colon), value.slice(colon + 1));
}

function withPort(hostname: string, port: string): { hostname: string; port: number } | undefined {
  if (!/^\d+$/.test(port)) return undefined;
  return { hostname, port: Number(port) };
}
