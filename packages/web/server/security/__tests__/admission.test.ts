import { describe, it, expect } from 'vitest';
import { DAEMON_TOKEN_SUBPROTOCOL_PREFIX, DAEMON_SUBPROTOCOL } from '@ordewell/core';
import { decideAdmission } from '../admission';

const PORT = 3742;
const TOKEN = 'a-minted-token';
const TOKEN_FILE = '/home/dev/.config/ordewell/server-3742.token';

const CONTEXT = { port: PORT, token: TOKEN, tokenFile: TOKEN_FILE };

/** Every case that is not about the token presents a valid one. */
const admit = (headers: Parameters<typeof decideAdmission>[0]) =>
  decideAdmission({ authorization: `Bearer ${TOKEN}`, ...headers }, CONTEXT);

describe('decideAdmission', () => {
  it('admits the shape the CLI sends: a loopback host, no origin, and the token', () => {
    expect(admit({ host: `127.0.0.1:${PORT}` })).toEqual({ admit: true });
  });

  it.each([
    ['localhost by name', `localhost:${PORT}`],
    ['uppercase hostname', `LOCALHOST:${PORT}`],
    ['bracketed IPv6 loopback', `[::1]:${PORT}`],
  ])('admits %s', (_label, host) => {
    expect(admit({ host }).admit).toBe(true);
  });

  describe('origin', () => {
    // The daemon has no browser front end, so any origin at all is a browser
    // reaching somewhere it has no business being.
    it.each([
      ['a hostile site', 'http://evil.example'],
      ['the daemon itself', `http://127.0.0.1:${PORT}`],
      ['a former allowlist entry', 'http://localhost:5173'],
      ['an opaque origin from a sandboxed frame', 'null'],
      ['an empty value', ''],
    ])('rejects a request whose origin is %s', (_label, origin) => {
      const decision = admit({ origin, host: `127.0.0.1:${PORT}` });
      expect(decision.admit).toBe(false);
      expect(decision.admit === false && decision.status).toBe(403);
    });

    it('treats an absent origin as absent, not as a value to match', () => {
      expect(admit({ origin: undefined, host: `127.0.0.1:${PORT}` }).admit).toBe(true);
      expect(admit({ origin: null, host: `127.0.0.1:${PORT}` }).admit).toBe(true);
    });
  });

  describe('host', () => {
    it.each([
      ['a rebound hostname', `evil.example:${PORT}`],
      ['a rebound hostname without a port', 'evil.example'],
      ['a subdomain of localhost', `evil.localhost:${PORT}`],
      ['a hostname that merely contains localhost', `localhost.evil.example:${PORT}`],
      ['loopback at another port', '127.0.0.1:9999'],
      ['loopback with no port at all', '127.0.0.1'],
      ['a non-loopback address', `10.0.0.1:${PORT}`],
      ['a 127/8 address that is not the bound one', `127.0.0.2:${PORT}`],
      ['an unbracketed IPv6 literal', '::1:3742'],
      ['an unterminated bracket', `[::1:${PORT}`],
      ['a non-numeric port', '127.0.0.1:abc'],
      ['trailing junk after the bracket', '[::1]x'],
      ['an empty host', ''],
    ])('rejects %s', (_label, host) => {
      const decision = admit({ host });
      expect(decision.admit).toBe(false);
      expect(decision.admit === false && decision.status).toBe(403);
    });

    it('rejects a request with no host header', () => {
      expect(admit({}).admit).toBe(false);
      expect(admit({ host: null }).admit).toBe(false);
    });

    it('names the expected port so a misconfigured client is diagnosable', () => {
      const decision = admit({ host: 'evil.example' });
      expect(decision.admit === false && decision.reason).toContain(String(PORT));
    });
  });

  describe('bearer token', () => {
    // Header validation stops browsers. The token is what stops every other
    // process on the machine that can see the port.
    const LOOPBACK = { host: `127.0.0.1:${PORT}` };

    it('rejects a local caller that presents no token at all', () => {
      const decision = decideAdmission(LOOPBACK, CONTEXT);
      expect(decision.admit).toBe(false);
      expect(decision.admit === false && decision.status).toBe(401);
    });

    it.each([
      ['a guessed value', 'Bearer not-the-token'],
      ['the right token under the wrong scheme', `Basic ${TOKEN}`],
      ['an empty bearer value', 'Bearer '],
      ['a token with trailing junk', `Bearer ${TOKEN}x`],
      ['a prefix of the real token', `Bearer ${TOKEN.slice(0, -1)}`],
    ])('rejects %s', (_label, authorization) => {
      expect(decideAdmission({ ...LOOPBACK, authorization }, CONTEXT).admit).toBe(false);
    });

    it('accepts the scheme spelled in any case, as the standard allows', () => {
      expect(decideAdmission({ ...LOOPBACK, authorization: `bearer ${TOKEN}` }, CONTEXT).admit).toBe(true);
      expect(decideAdmission({ ...LOOPBACK, authorization: `BEARER ${TOKEN}` }, CONTEXT).admit).toBe(true);
    });

    it('accepts the token offered as a subprotocol on the upgrade', () => {
      const decision = decideAdmission({
        ...LOOPBACK,
        secWebSocketProtocol: `${DAEMON_SUBPROTOCOL}, ${DAEMON_TOKEN_SUBPROTOCOL_PREFIX}${TOKEN}`,
      }, CONTEXT);
      expect(decision).toEqual({ admit: true });
    });

    it('rejects an upgrade offering the plain subprotocol without a token', () => {
      const decision = decideAdmission({ ...LOOPBACK, secWebSocketProtocol: DAEMON_SUBPROTOCOL }, CONTEXT);
      expect(decision.admit === false && decision.status).toBe(401);
    });

    it('rejects an upgrade offering a wrong token', () => {
      const decision = decideAdmission({
        ...LOOPBACK,
        secWebSocketProtocol: `${DAEMON_SUBPROTOCOL}, ${DAEMON_TOKEN_SUBPROTOCOL_PREFIX}wrong`,
      }, CONTEXT);
      expect(decision.admit).toBe(false);
    });

    it('names the token file, so a stale token is diagnosable', () => {
      const decision = decideAdmission(LOOPBACK, CONTEXT);
      expect(decision.admit === false && decision.reason).toContain(TOKEN_FILE);
    });

    // Order matters: a browser that somehow learned the token must still be
    // refused, and a rebound host must not be told whether its token was right.
    it('refuses a browser carrying a valid token', () => {
      const decision = decideAdmission({
        ...LOOPBACK,
        origin: 'http://evil.example',
        authorization: `Bearer ${TOKEN}`,
      }, CONTEXT);
      expect(decision.admit === false && decision.status).toBe(403);
    });

    it('refuses a rebound host carrying a valid token', () => {
      const decision = decideAdmission({
        host: 'evil.example',
        authorization: `Bearer ${TOKEN}`,
      }, CONTEXT);
      expect(decision.admit === false && decision.status).toBe(403);
    });
  });

  it('follows the port the daemon was actually started on', () => {
    const at = (port: number) => ({ ...CONTEXT, port });
    expect(decideAdmission({ host: 'localhost:8080', authorization: `Bearer ${TOKEN}` }, at(8080)).admit).toBe(true);
    expect(decideAdmission({ host: `localhost:${PORT}`, authorization: `Bearer ${TOKEN}` }, at(8080)).admit).toBe(false);
  });

  it('follows the token the daemon actually minted', () => {
    const other = { ...CONTEXT, token: 'a-different-daemons-token' };
    expect(decideAdmission({ host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` }, other).admit).toBe(false);
  });
});
