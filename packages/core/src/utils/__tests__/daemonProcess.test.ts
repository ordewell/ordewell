import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import type { AddressInfo } from 'net';

let home = '';

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home };
});

import {
  DEFAULT_DAEMON_PORT,
  daemonPidFilePath,
  legacyDaemonPidFilePath,
  daemonLogPath,
  readPidFile,
  resolveDaemonPort,
  isConnectionRefused,
  isDaemonRunning,
  probeDaemon,
  stopDaemonAt,
} from '../daemonProcess';
import { daemonTokenPath, mintDaemonToken } from '../daemonToken';

/** A port nothing listens on: bound once to learn it, then released. */
async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface FakeServer { port: number; seen: http.IncomingHttpHeaders[]; close: () => Promise<void> }

async function serve(answer: (req: http.IncomingMessage) => { status: number; body: string }): Promise<FakeServer> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    const { status, body } = answer(req);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

const REFUSAL = JSON.stringify({ error: 'Unauthenticated: this request did not present the daemon\'s bearer token.' });

describe('daemon files', () => {
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-daemon-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('keeps the default port\'s legacy PID file name and names every other after its port', () => {
    expect(daemonPidFilePath(DEFAULT_DAEMON_PORT)).toBe(path.join(home, '.ordewell', 'server.pid'));
    expect(daemonPidFilePath(4100)).toBe(path.join(home, '.ordewell', 'server-4100.pid'));
    expect(legacyDaemonPidFilePath(4100)).toBe(path.join(home, '.config', 'ordewell', 'server-4100.pid'));
    expect(daemonLogPath()).toBe(path.join(home, '.ordewell', 'server.log'));
  });

  it('reads a PID only when the file names a positive integer', () => {
    const file = path.join(home, 'pid');
    expect(readPidFile(file)).toBeUndefined();
    fs.writeFileSync(file, '1234\n');
    expect(readPidFile(file)).toBe(1234);
    fs.writeFileSync(file, 'garbage');
    expect(readPidFile(file)).toBeUndefined();
    fs.writeFileSync(file, '-3');
    expect(readPidFile(file)).toBeUndefined();
  });
});

describe('resolveDaemonPort', () => {
  it.each<[string | number | undefined, NodeJS.ProcessEnv, number]>([
    [undefined, {}, DEFAULT_DAEMON_PORT],
    [undefined, { ORDEWELL_PORT: '9001' }, 9001],
    ['4242', { ORDEWELL_PORT: '9001' }, 4242],
    [4243, {}, 4243],
    ['nope', {}, DEFAULT_DAEMON_PORT],
    [undefined, { ORDEWELL_PORT: 'nope' }, DEFAULT_DAEMON_PORT],
    ['0', { ORDEWELL_PORT: '-1' }, DEFAULT_DAEMON_PORT],
  ])('resolves %s with %o to %d', (explicit, env, expected) => {
    expect(resolveDaemonPort(explicit, env)).toBe(expected);
  });
});

describe('isConnectionRefused', () => {
  it('trusts only a refusal, never a reset', () => {
    expect(isConnectionRefused(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isConnectionRefused('connect ECONNREFUSED 127.0.0.1:1')).toBe(true);
    expect(isConnectionRefused(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isConnectionRefused(null)).toBe(false);
  });
});

describe('probeDaemon', () => {
  let server: FakeServer | undefined;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-daemon-')); });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('is unreachable when nothing listens', async () => {
    expect(await probeDaemon(await freePort())).toEqual({ kind: 'unreachable' });
    expect(await isDaemonRunning(await freePort())).toBe(false);
  });

  it('names the daemon, its version and contract, presenting the token file and no Origin', async () => {
    server = await serve(() => ({ status: 200, body: JSON.stringify({ pid: 42, port: 1, version: '1.2.3', contract: 7 }) }));
    const { token } = mintDaemonToken(server.port);
    expect(await probeDaemon(server.port)).toEqual({ kind: 'daemon', identity: { pid: 42, version: '1.2.3', contract: 7 } });
    expect(server.seen[0].authorization).toBe(`Bearer ${token}`);
    expect(server.seen[0].origin).toBeUndefined();
    expect(server.seen[0].host).toBe(`127.0.0.1:${server.port}`);
  });

  it('leaves out the version and contract a daemon older than them never sends', async () => {
    server = await serve(() => ({ status: 200, body: JSON.stringify({ pid: 42, port: 1 }) }));
    expect(await probeDaemon(server.port)).toEqual({ kind: 'daemon', identity: { pid: 42 } });
  });

  it('tells a daemon that refuses the token from one that was never shown one', async () => {
    server = await serve(() => ({ status: 401, body: REFUSAL }));
    expect(await probeDaemon(server.port)).toEqual({ kind: 'unauthorized', tokenPresented: false });
    mintDaemonToken(server.port);
    expect(await probeDaemon(server.port)).toEqual({ kind: 'unauthorized', tokenPresented: true });
    expect(await isDaemonRunning(server.port)).toBe(true);
  });

  it.each<[string, number, string]>([
    ['a stranger\'s 401', 401, 'go away'],
    ['a 404 from a daemon older than the route', 404, '{}'],
    ['a body that is not JSON', 200, '<html>'],
    ['a body with no PID', 200, JSON.stringify({ port: 1 })],
  ])('is unverifiable on %s', async (_label, status, body) => {
    server = await serve(() => ({ status, body }));
    expect(await probeDaemon(server.port)).toEqual({ kind: 'unverifiable' });
  });
});

describe('stopDaemonAt', () => {
  let server: FakeServer | undefined;
  let child: ChildProcess | undefined;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-daemon-')); });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    child?.kill('SIGKILL');
    child = undefined;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writePid(port: number, pid: string, file = daemonPidFilePath(port)): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, pid);
    return file;
  }

  it('reports a missing PID file', async () => {
    expect(await stopDaemonAt(await freePort())).toEqual({ kind: 'no-pid-file' });
  });

  it('removes an unreadable PID file and the token beside it', async () => {
    const port = await freePort();
    const file = writePid(port, 'garbage');
    mintDaemonToken(port);
    expect(await stopDaemonAt(port)).toEqual({ kind: 'unreadable-pid-file' });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(daemonTokenPath(port))).toBe(false);
  });

  it('clears a stale PID file, falling back to the legacy location', async () => {
    const port = await freePort();
    const file = writePid(port, '99999', legacyDaemonPidFilePath(port));
    expect(await stopDaemonAt(port)).toEqual({ kind: 'stale' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('signals nothing when the port\'s owner cannot name itself', async () => {
    server = await serve(() => ({ status: 401, body: REFUSAL }));
    writePid(server.port, '12345');
    expect(await stopDaemonAt(server.port)).toEqual({ kind: 'unverifiable', filePid: 12345 });
  });

  it('signals the PID the daemon reports, not the one the file names', async () => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid ?? 0;
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child?.once('exit', (_code, signal) => resolve(signal)));
    server = await serve(() => ({ status: 200, body: JSON.stringify({ pid, port: 1 }) }));
    const file = writePid(server.port, '777');
    expect(await stopDaemonAt(server.port)).toEqual({ kind: 'stopped', pid, filePid: 777 });
    expect(await exited).toBe('SIGTERM');
    expect(fs.existsSync(file)).toBe(false);
  });
});
