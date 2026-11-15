import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DAEMON_CONTRACT } from '@ordewell/core/daemon-client';
import type { OrdewellBridge } from '../src/shared/bridge';
import { appEnv, closeApp, freePort, launchApp, makeSandbox, removeSandbox, untilListening } from './fixtures';

test('opens the welcome window while the login shell is still resolving', async () => {
  test.skip(process.platform === 'win32', 'Windows does not resolve PATH through a login shell.');
  const sandbox = makeSandbox();
  const port = await freePort();
  const release = join(sandbox.tmp, 'release-shell');
  const marker = join(sandbox.tmp, 'login-path');
  const shell = join(sandbox.tmp, 'slow-shell');
  writeFileSync(shell, '#!/bin/sh\nwhile [ ! -f "$ORDEWELL_RELEASE_SHELL" ]; do sleep 0.05; done\nexport PATH="$PATH:$ORDEWELL_LOGIN_PATH"\nexec /bin/sh -c "$3"\n', { mode: 0o755 });
  const env: Record<string, string> = {
    ...appEnv(sandbox, port, 0, { noProvider: true }),
    SHELL: `'${shell.replaceAll("'", "'\\''")}'`,
    ORDEWELL_RELEASE_SHELL: release,
    ORDEWELL_LOGIN_PATH: marker,
  };
  let app: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    app = await launchApp(sandbox, env);
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Open folder…' })).toBeVisible();
    expect(existsSync(release)).toBe(false);
    expect(await app.evaluate(() => process.env.PATH)).toBe(env.PATH);
    writeFileSync(release, 'ready');
    const running = app;
    await expect.poll(() => running.evaluate(() => process.env.PATH)).toContain(marker);
    await closeApp(app);
    app = undefined;
    await untilListening(port, false);
    const stages = readFileSync(join(sandbox.userData, 'startup.log'), 'utf8').trim().split('\n')
      .map((line) => (JSON.parse(line) as { stage: string }).stage);
    expect(stages).toContain('window.loaded');
    expect(stages).toContain('shell-path.finished');
    expect(stages.indexOf('window.loaded')).toBeLessThan(stages.indexOf('shell-path.finished'));
  } finally {
    writeFileSync(release, 'ready');
    await closeApp(app);
    await untilListening(port, false);
    removeSandbox(sandbox);
  }
});

test('authenticates automatically when the startup handshake read the preceding token', async () => {
  const sandbox = makeSandbox();
  let token = 'preceding-startup-token';
  let port = 0;
  let rejections = 0;
  const tokenFile = (): string => join(sandbox.home, '.ordewell', `server-${port}.token`);
  const server = createServer((request, response) => {
    if (request.url === '/api/server' && rejections === 0) {
      token = 'current-startup-token';
      writeFileSync(tokenFile(), token, { mode: 0o600 });
      rejections++;
      response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Unauthenticated: this request did not present the daemon\'s bearer token.' }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    const body = request.url === '/api/server'
      ? { pid: process.pid, port, version: '0.13.1', contract: DAEMON_CONTRACT, live: false }
      : { runners: [] };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
  let app: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test daemon address');
    port = address.port;
    mkdirSync(join(sandbox.home, '.ordewell'), { recursive: true });
    writeFileSync(tokenFile(), token, { mode: 0o600 });
    app = await launchApp(sandbox, appEnv(sandbox, port, 0, { noProvider: true }));
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => (window as unknown as { ordewell: OrdewellBridge }).ordewell.daemon.status().then((status) => status.state))).toBe('connected');
    expect(rejections).toBe(1);
    await expect(page.getByText('Could not authenticate with the daemon', { exact: true })).toHaveCount(0);
    await closeApp(app);
    app = undefined;
    const stages = readFileSync(join(sandbox.userData, 'startup.log'), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { stage: string; state?: string });
    expect(stages.some((entry) => entry.stage === 'daemon.status' && entry.state === 'unauthorized')).toBe(false);
  } finally {
    await closeApp(app);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeSandbox(sandbox);
  }
});

test('records a stalled renderer separately from the main process and daemon reads', async () => {
  const sandbox = makeSandbox();
  const port = await freePort();
  let app: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    app = await launchApp(sandbox, appEnv(sandbox, port, 0, { noProvider: true }));
    const page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Open folder…' })).toBeVisible();
    await page.evaluate(() => {
      // The test's OS window stays hidden; the probe must exercise a foreground page's rule.
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      const start = performance.now();
      while (performance.now() - start < 2200) { /* an intentionally blocked renderer */ }
    });
    await expect.poll(() => readFileSync(join(sandbox.userData, 'startup.log'), 'utf8')).toContain('renderer.delayed');
  } finally {
    await closeApp(app);
    await untilListening(port, false);
    removeSandbox(sandbox);
  }
});
