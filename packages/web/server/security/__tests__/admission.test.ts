import { describe, it, expect } from 'vitest';
import { decideAdmission } from '../admission';

const PORT = 3742;

const admit = (headers: Parameters<typeof decideAdmission>[0]) => decideAdmission(headers, PORT);

describe('decideAdmission', () => {
  it('admits the shape the CLI sends: a loopback host and no origin', () => {
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

  it('follows the port the daemon was actually started on', () => {
    expect(decideAdmission({ host: 'localhost:8080' }, 8080).admit).toBe(true);
    expect(decideAdmission({ host: `localhost:${PORT}` }, 8080).admit).toBe(false);
  });
});
