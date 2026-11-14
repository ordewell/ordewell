import { type ChildProcess } from 'child_process';
import * as childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_CONTRACT, probeDaemon } from '@ordewell/core';
import { homeEnv, setEnv } from '@ordewell/core/testing';
import { DEFAULT_PORT, ensureDaemonOwned, findFreePort } from '../daemon';
import { cliVersion } from '../version';

/**
 * A daemon process that answers as a given Ordewell would: the two routes a
 * client reads before it drives one, a PID file once it listens, and an exit
 * on SIGTERM. `none` is a daemon older than `/api/server`, which answers 404.
 */
const FAKE_DAEMON = `
const http = require('http');
const fs = require('fs');
const args = process.argv.slice(2);
const at = (name) => args[args.indexOf(name) + 1];
const port = Number(at('--port'));
const identity = at('--identity');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/workspaces') return res.end('{"workspaces":[]}');
  if (req.url === '/api/server' && identity !== 'none') {
    return res.end(JSON.stringify({ pid: process.pid, port, ...JSON.parse(identity) }));
  }
  res.statusCode = 404;
  res.end('{"error":"not found"}');
});
server.listen(port, '127.0.0.1', () => fs.writeFileSync(at('--pid-file'), String(process.pid)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

/** What the daemon this CLI starts says of itself. */
const NEW_DAEMON = { version: 'this', contract: DAEMON_CONTRACT, live: false };

const fake = vi.hoisted(() => ({ script: '', started: [] as ChildProcess[] }));

// The binary is its own daemon (`<binary> __daemon ...`), so that is the one
// command a start runs; here it runs the fake, as this CLI's own daemon.
vi.mock('@ordewell/core', async (importOriginal) => ({ ...(await importOriginal<typeof import('@ordewell/core')>()), isSea: () => true }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[], options: childProcess.SpawnOptions) => {
      if (args[0] !== '__daemon') return actual.spawn(file, args, options);
      const child = actual.spawn(process.execPath, [fake.script, ...args.slice(1), '--identity', JSON.stringify(NEW_DAEMON)], options);
      fake.started.push(child);
      return child;
    }),
  };
});

describe('a CLI meeting a daemon of another version', () => {
  let home = '';
  let restoreHome: () => void;
  let scriptDir = '';
  const running: ChildProcess[] = [];

  beforeAll(() => {
    scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-fake-daemon-'));
    fake.script = path.join(scriptDir, 'daemon.js');
    fs.writeFileSync(fake.script, FAKE_DAEMON);
  });
  afterAll(() => fs.rmSync(scriptDir, { recursive: true, force: true }));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-daemon-upgrade-'));
    restoreHome = setEnv(homeEnv(home));
    vi.mocked(childProcess.spawn).mockClear();
  });

  afterEach(() => {
    restoreHome();
    for (const child of [...running.splice(0), ...fake.started.splice(0)]) if (alive(child)) child.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  });

  function alive(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null;
  }

  function pidFile(port: number): string {
    return path.join(home, '.ordewell', port === DEFAULT_PORT ? 'server.pid' : `server-${port}.pid`);
  }

  /** A daemon some earlier Ordewell started on `port`, which answers `identity`. */
  async function earlierDaemon(port: number, identity: Record<string, unknown> | 'none'): Promise<ChildProcess> {
    fs.mkdirSync(path.join(home, '.ordewell'), { recursive: true });
    const child = childProcess.spawn(process.execPath, [
      fake.script, '--port', String(port), '--pid-file', pidFile(port),
      '--identity', identity === 'none' ? 'none' : JSON.stringify(identity),
    ], { stdio: 'ignore' });
    running.push(child);
    await vi.waitFor(() => expect(fs.existsSync(pidFile(port))).toBe(true));
    return child;
  }

  const daemonStarts = () => vi.mocked(childProcess.spawn).mock.calls.filter(([, args]) => args?.[0] === '__daemon');

  it('drives a daemon with its own contract, whatever its version, and starts none', async () => {
    const port = await findFreePort();
    const earlier = await earlierDaemon(port, { version: '0.13.0', contract: DAEMON_CONTRACT, live: true });

    expect(await ensureDaemonOwned(port, { quiet: true })).toEqual({ port, owned: false });

    expect(alive(earlier)).toBe(true);
    expect(daemonStarts()).toEqual([]);
  });

  it('replaces an idle daemon it cannot drive with one of its own', async () => {
    const port = await findFreePort();
    const earlier = await earlierDaemon(port, { version: '0.12.9', contract: DAEMON_CONTRACT + 1, live: false });

    expect(await ensureDaemonOwned(port, { quiet: true })).toEqual({ port, owned: true });

    await vi.waitFor(() => expect(alive(earlier)).toBe(false));
    const now = await probeDaemon(port);
    expect(now).toMatchObject({ kind: 'daemon', identity: { version: 'this', contract: DAEMON_CONTRACT } });
    expect(daemonStarts()).toHaveLength(1);
  });

  // 0.13.1 builds from before the Explorer read the workspace folder itself
  // answer contract 2 and this version, and refuse repo "." outside a repository.
  it('does not drive a daemon from before workspace-folder reads, though it reports the same version', async () => {
    const port = await findFreePort();
    const idle = await earlierDaemon(port, { version: '0.13.1', contract: 2, live: false });

    expect(await ensureDaemonOwned(port, { quiet: true })).toEqual({ port, owned: true });

    await vi.waitFor(() => expect(alive(idle)).toBe(false));
    expect(await probeDaemon(port)).toMatchObject({ kind: 'daemon', identity: { contract: DAEMON_CONTRACT } });
  });

  it('leaves a daemon from before workspace-folder reads running while it has work under way', async () => {
    const port = await findFreePort();
    const busy = await earlierDaemon(port, { version: '0.13.1', contract: 2, live: true });

    const refusal = await ensureDaemonOwned(port, { quiet: true }).then(() => undefined, (err: Error) => err.message);

    expect(refusal).toContain('It has work under way');
    expect(refusal).toContain(`ordewell stop --server --port ${port}`);
    expect(alive(busy)).toBe(true);
    expect(daemonStarts()).toEqual([]);
  });

  it('leaves a daemon it cannot drive running while work is under way there, and says how to go on', async () => {
    const port = await findFreePort();
    const earlier = await earlierDaemon(port, { version: '0.12.9', contract: DAEMON_CONTRACT + 1, live: true });

    const refusal = await ensureDaemonOwned(port, { quiet: true }).then(() => undefined, (err: Error) => err.message);

    expect(refusal).toContain(`port ${port}`);
    expect(refusal).toContain('0.12.9');
    expect(refusal).toContain(cliVersion());
    expect(refusal).toContain(`ordewell stop --server --port ${port}`);
    expect(alive(earlier)).toBe(true);
    expect(fs.existsSync(pidFile(port))).toBe(true);
    expect(daemonStarts()).toEqual([]);
  });

  it.each([
    ['answers no contract and cannot say whether work is under way, as 0.12.6 does', {}],
    ['predates the route that names it', 'none' as const],
  ])('leaves running a daemon that %s', async (_, identity) => {
    const port = await findFreePort();
    const earlier = await earlierDaemon(port, identity);

    await expect(ensureDaemonOwned(port, { quiet: true })).rejects.toThrow(/left running/);

    expect(alive(earlier)).toBe(true);
    expect(daemonStarts()).toEqual([]);
  });
});
