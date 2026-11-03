import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintDaemonToken, readDaemonToken } from '@ordewell/core';
import { homeEnv, setEnv } from '@ordewell/core/testing';
import { DEFAULT_PORT, findFreePort, stopDaemon } from '../daemon';

/**
 * A stop must never signal a PID it cannot tie to the daemon on the port: PIDs
 * are recycled, and the file outlives a crash by design.
 */
describe('stopDaemon', () => {
  let home = '';
  let restoreHome: () => void;
  const children: ChildProcess[] = [];
  const servers: http.Server[] = [];

  function lingeringProcess(): ChildProcess {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    return child;
  }

  function pidFile(port: number, pid: number): string {
    const dir = path.join(home, '.ordewell');
    fs.mkdirSync(dir, { recursive: true });
    // The default port keeps the legacy unsuffixed name; any other gets its own.
    const file = path.join(dir, port === DEFAULT_PORT ? 'server.pid' : `server-${port}.pid`);
    fs.writeFileSync(file, String(pid));
    return file;
  }

  async function answerWith(status: number, body: string): Promise<number> {
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no listening port');
    return address.port;
  }

  function alive(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-stop-daemon-'));
    restoreHome = setEnv(homeEnv(home));
  });

  afterEach(() => {
    restoreHome();
    for (const child of children.splice(0)) if (alive(child)) child.kill('SIGKILL');
    for (const server of servers.splice(0)) server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('removes a stale PID file without signalling the process it names', async () => {
    const port = await findFreePort();
    const unrelated = lingeringProcess();
    const file = pidFile(port, unrelated.pid!);

    expect(await stopDaemon(port)).toBe(true);

    expect(fs.existsSync(file)).toBe(false);
    expect(alive(unrelated)).toBe(true);
  });

  it('does not signal an unverifiable daemon\'s PID file, and keeps its token', async () => {
    const port = await answerWith(401, JSON.stringify({ error: 'unauthenticated' }));
    const unrelated = lingeringProcess();
    pidFile(port, unrelated.pid!);
    const { token } = mintDaemonToken(port);

    expect(await stopDaemon(port)).toBe(false);

    expect(alive(unrelated)).toBe(true);
    expect(readDaemonToken(port)).toBe(token);
  });

  it('stops the daemon that owns the port, not a stale PID beside it', async () => {
    const daemon = lingeringProcess();
    const port = await answerWith(200, JSON.stringify({ pid: daemon.pid, port: 0 }));
    const unrelated = lingeringProcess();
    pidFile(port, unrelated.pid!);

    const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()));
    expect(await stopDaemon(port)).toBe(true);
    await exited;

    expect(alive(unrelated)).toBe(true);
  });
});
