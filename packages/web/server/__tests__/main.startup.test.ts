import { execFileSync, spawn } from 'child_process';
import { createServer } from 'http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer as createNetServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { daemonBuild, daemonBuildFailure } from './daemonBuild';
import { patient } from '@ordewell/core/testing';

// These spawn the built daemon, but `test:quick` on a fresh checkout has no
// dist yet, and the missing build then fails as a fifteen-second "timed out
// waiting for the daemon". Building it here also keeps a stale bundle from
// deciding what the tests see.
beforeAll(() => {
  const build = daemonBuild();
  try {
    execFileSync(build.file, build.args, { cwd: build.cwd, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  } catch (error) {
    throw daemonBuildFailure(error);
  }
}, patient(60_000));

function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the daemon');
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
}

/** A daemon with a PID file, started in a home of its own; `close` kills it and removes the home. */
async function daemonWithPidFile(name: string, ...extra: string[]) {
  const home = mkdtempSync(join(tmpdir(), `ordewell-daemon-${name}-`));
  mkdirSync(join(home, '.ordewell'));
  const port = await freePort();
  const pidFile = join(home, '.ordewell', `server-${port}.pid`);
  const child = spawn(process.execPath, [
    resolve(__dirname, '../../dist/server/main.js'),
    '--port', String(port),
    '--pid-file', pidFile,
    ...extra,
  ], {
    env: { HOME: home, USERPROFILE: home, PATH: '', AI_PROVIDER: 'codex', ORDEWELL_ENABLED_RUNNERS: 'codex' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const close = () => {
    child.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  return { child, pidFile, close };
}

// A signal on Windows is TerminateProcess, which runs no handler: the daemon
// can neither clean up on SIGTERM nor live through a SIGINT there, and
// `ordewell stop --server` removes the PID file itself.
const signalsRunNoHandler = process.platform === 'win32';

describe('daemon startup', () => {
  it('writes its PID file only once listening', async () => {
    const { child, pidFile, close } = await daemonWithPidFile('pid');
    try {
      await waitFor(() => {
        try { return readFileSync(pidFile, 'utf8').trim() === String(child.pid); } catch { return false; }
      });
      expect(readFileSync(pidFile, 'utf8').trim()).toBe(String(child.pid));
    } finally {
      close();
    }
  });

  it.skipIf(signalsRunNoHandler)('removes its PID file on shutdown', async () => {
    const { child, pidFile, close } = await daemonWithPidFile('pid-removed');
    try {
      await waitFor(() => {
        try { return readFileSync(pidFile, 'utf8').trim() === String(child.pid); } catch { return false; }
      });

      child.kill('SIGTERM');
      await new Promise<void>((resolveExit) => child.once('close', () => resolveExit()));
      expect(() => readFileSync(pidFile, 'utf8')).toThrow();
    } finally {
      close();
    }
  });

  it.skipIf(signalsRunNoHandler)('keeps an owned daemon alive through a SIGINT, so cancelling a login does not stop it', async () => {
    // The TUI ignores Ctrl-C while its login child owns the tty, but the tty
    // delivers SIGINT to the whole foreground group — this daemon included.
    // Treating it as a stop would kill every in-memory session under the login
    // the user only meant to cancel.
    const { child, pidFile, close } = await daemonWithPidFile('sigint', '--watch-parent', String(process.pid));
    let closed = false;
    child.once('close', () => { closed = true; });
    try {
      await waitFor(() => {
        try { return readFileSync(pidFile, 'utf8').trim() === String(child.pid); } catch { return false; }
      });

      child.kill('SIGINT');
      await new Promise((resolveTick) => setTimeout(resolveTick, 500));

      expect(closed).toBe(false);
      expect(readFileSync(pidFile, 'utf8').trim()).toBe(String(child.pid));

      child.kill('SIGTERM');
      await new Promise<void>((resolveExit) => child.once('close', () => resolveExit()));
    } finally {
      close();
    }
  });

  it('preserves the listening daemon token when another daemon cannot bind its port', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ordewell-daemon-start-'));
    const incumbent = createServer((_req, res) => res.end('incumbent'));
    await new Promise<void>((resolve) => incumbent.listen(0, '127.0.0.1', resolve));
    const address = incumbent.address();
    if (!address || typeof address === 'string') throw new Error('No listening port');
    const dataDir = join(home, '.ordewell');
    mkdirSync(dataDir);
    const tokenFile = join(dataDir, `server-${address.port}.token`);
    writeFileSync(tokenFile, 'incumbent-token');
    const child = spawn(process.execPath, [resolve(__dirname, '../../dist/server/main.js'), '--port', String(address.port)], {
      env: { HOME: home, USERPROFILE: home, PATH: '', AI_PROVIDER: 'codex', ORDEWELL_ENABLED_RUNNERS: 'codex' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(exit).not.toBe(0);
      expect(stderr).toContain('EADDRINUSE');
      expect(readFileSync(tokenFile, 'utf8')).toBe('incumbent-token');
      expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe('incumbent');
    } finally {
      child.kill();
      await new Promise<void>((resolve) => incumbent.close(() => resolve()));
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
