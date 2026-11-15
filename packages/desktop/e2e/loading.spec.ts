import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DAEMON_CONTRACT, DEFAULT_MAX_PARALLEL, RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import { appEnv, closeApp, launchApp, makeSandbox, openFolder, removeSandbox } from './fixtures';

// Playwright reads fixtures from a destructured first parameter, including when only TestInfo is needed.
// eslint-disable-next-line no-empty-pattern
test('a pending catalog shows progress through the daemon bridge and settings stay usable', async ({}, info) => {
  const sandbox = makeSandbox();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const models = [{ modelId: 'claude-sonnet', modelLabel: 'Claude Sonnet', variants: [] }];
  const token = 'offline-loading-test-token';
  let port = 0;
  // Hold the actual HTTP response, so the renderer's bridge, progress messages and paints all take part.
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      let body: unknown = { ok: true };
      switch (path) {
        case '/api/server': body = { pid: process.pid, port, version: '0.13.1', contract: DAEMON_CONTRACT, live: [] }; break;
        case '/api/runners': body = { runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true, auth: { state: 'signed-in' } }] }; break;
        case '/api/settings': body = { aiProvider: 'claude-code', orchestratorModel: 'claude-sonnet', autonomousMode: false, maxParallel: DEFAULT_MAX_PARALLEL, run: RUN_SETTINGS_DEFAULTS, modelAllowlist: {} }; break;
        case '/api/sessions': body = []; break;
        case '/api/git/repos': body = { repos: [{ repo: '.', branch: 'main' }] }; break;
        case '/api/models':
          await gate;
          body = { models, modelsByRunner: { 'claude-code': models }, modesByRunner: {}, providers: [], orchestratorModel: 'claude-sonnet', orchestratorModels: [] };
          break;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    })().catch(() => response.destroy());
  });
  let app: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test daemon address');
    port = address.port;
    const state = join(sandbox.home, '.ordewell');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, `server-${port}.token`), token, { mode: 0o600 });
    app = await launchApp(sandbox, appEnv(sandbox, port, 0, { noProvider: true }));
    const welcome = await app.firstWindow();
    const page = await openFolder(app, welcome, sandbox.repo);
    await expect(page.getByText('Loading models…', { exact: true })).toBeVisible();
    await expect(page.getByText(/No models discovered/)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('models-loading.png') });

    await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Run', exact: true })).toBeVisible();
    await expect(page.getByText('Loading models…', { exact: true }).last()).toBeVisible();
    await expect(page.getByRole('textbox', { name: /Parallel tasks/ })).toBeEnabled();
    await page.screenshot({ path: info.outputPath('settings-loading.png') });

    release();
    await expect(page.getByText('Loading models…', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Planner model' })).toBeEnabled();
    await expect(page.getByRole('combobox', { name: 'Planner model' })).toHaveValue('claude-sonnet');
    await closeApp(app);
    app = undefined;
  } finally {
    release();
    await closeApp(app);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeSandbox(sandbox);
  }
});
