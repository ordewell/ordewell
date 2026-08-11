import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let home = '';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home };
});

import {
  daemonTokenPath,
  mintDaemonToken,
  readDaemonToken,
  clearDaemonToken,
  bearerHeaderValue,
  tokenSubprotocols,
  extractPresentedToken,
  tokensMatch,
  DAEMON_SUBPROTOCOL,
} from '../daemonToken';

describe('the daemon token file', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-token-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('lands beside the per-port process-id file', () => {
    expect(daemonTokenPath(3742)).toBe(path.join(home, '.config', 'ordewell', 'server-3742.token'));
  });

  it('is readable by its owner and nobody else', () => {
    const { file } = mintDaemonToken(3742);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('hands the token to a client through the file', () => {
    const { token } = mintDaemonToken(3742);
    expect(readDaemonToken(3742)).toBe(token);
  });

  it('mints something a local process could not guess', () => {
    const first = mintDaemonToken(3742).token;
    clearDaemonToken(3742);
    const second = mintDaemonToken(3742).token;
    expect(first).not.toBe(second);
    // 32 random bytes, base64url — long enough that guessing is not a strategy.
    expect(first.length).toBeGreaterThanOrEqual(43);
  });

  it('replaces a token file left behind by a previous daemon', () => {
    const stale = mintDaemonToken(3742).token;
    const fresh = mintDaemonToken(3742).token;
    expect(readDaemonToken(3742)).toBe(fresh);
    expect(readDaemonToken(3742)).not.toBe(stale);
  });

  // Writing over a file someone else pre-created keeps that file's permissions,
  // and a pre-planted symlink would redirect the write entirely.
  it('does not inherit the permissions of a pre-created file', () => {
    const file = daemonTokenPath(3742);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'planted', { mode: 0o666 });
    fs.chmodSync(file, 0o666);

    mintDaemonToken(3742);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('does not follow a symlink planted where the token goes', () => {
    const file = daemonTokenPath(3742);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const elsewhere = path.join(home, 'elsewhere');
    fs.writeFileSync(elsewhere, 'original');
    fs.symlinkSync(elsewhere, file);

    const { token } = mintDaemonToken(3742);
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('original');
    expect(fs.readFileSync(file, 'utf8')).toBe(token);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
  });

  it('gives a second daemon on another port its own token', () => {
    const first = mintDaemonToken(3742);
    const second = mintDaemonToken(8080);

    expect(second.file).not.toBe(first.file);
    expect(second.token).not.toBe(first.token);
    // The first daemon's clients keep working.
    expect(readDaemonToken(3742)).toBe(first.token);
    expect(readDaemonToken(8080)).toBe(second.token);
  });

  it('leaves the other daemon alone when one shuts down', () => {
    const first = mintDaemonToken(3742);
    mintDaemonToken(8080);

    clearDaemonToken(8080);
    expect(readDaemonToken(3742)).toBe(first.token);
    expect(readDaemonToken(8080)).toBeUndefined();
  });

  it('reports no token when none has been minted', () => {
    expect(readDaemonToken(3742)).toBeUndefined();
  });

  it('shuts down cleanly when the token file is already gone', () => {
    expect(() => clearDaemonToken(3742)).not.toThrow();
  });
});

describe('carrying the token', () => {
  const TOKEN = 'tok-abc';

  it('reads back what the HTTP carrier put on the wire', () => {
    expect(extractPresentedToken({ authorization: bearerHeaderValue(TOKEN) })).toBe(TOKEN);
  });

  it('reads back what the upgrade carrier put on the wire', () => {
    expect(extractPresentedToken({ secWebSocketProtocol: tokenSubprotocols(TOKEN).join(', ') })).toBe(TOKEN);
  });

  it('offers the plain subprotocol first, so the server has one to select', () => {
    expect(tokenSubprotocols(TOKEN)[0]).toBe(DAEMON_SUBPROTOCOL);
  });

  it('finds nothing in an offer that carries no token', () => {
    expect(extractPresentedToken({ secWebSocketProtocol: DAEMON_SUBPROTOCOL })).toBeUndefined();
    expect(extractPresentedToken({})).toBeUndefined();
    expect(extractPresentedToken({ authorization: 'Bearer' })).toBeUndefined();
  });

  it('matches only the exact token', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch('tok-abd', TOKEN)).toBe(false);
    expect(tokensMatch('tok-ab', TOKEN)).toBe(false);
    expect(tokensMatch(undefined, TOKEN)).toBe(false);
    expect(tokensMatch('', TOKEN)).toBe(false);
  });
});
