/**
 * The single admission decision for the daemon.
 *
 * Both the HTTP middleware and the WebSocket upgrade handler call this. The
 * sharing is the point: the two paths drifting apart is how the upgrade ended
 * up validating nothing while the HTTP routes had a CORS allowlist.
 */

/** `localhost` is included because clients dial it by name; the daemon binds loopback only. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

export interface AdmissionHeaders {
  /** `null`/`undefined` mean absent. An empty string still counts as present. */
  origin?: string | null;
  host?: string | null;
}

export type AdmissionDecision =
  | { admit: true }
  | { admit: false; status: number; reason: string };

const ADMIT: AdmissionDecision = { admit: true };

export function decideAdmission(headers: AdmissionHeaders, port: number): AdmissionDecision {
  if (headers.origin !== undefined && headers.origin !== null) {
    return {
      admit: false,
      status: 403,
      reason: 'Refused: requests carrying an Origin header are not accepted. The Ordewell daemon has no browser client.',
    };
  }

  if (!isOwnLoopbackAuthority(headers.host, port)) {
    return {
      admit: false,
      status: 403,
      reason: `Refused: the Host header must name loopback (localhost, 127.0.0.1 or [::1]) at port ${port}.`,
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
