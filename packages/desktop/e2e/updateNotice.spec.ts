import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appEnv, closeApp, freePort, launchApp, makeSandbox, openFolder, removeSandbox, untilListening } from './fixtures';

const DESKTOP_VERSION = (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;

/**
 * The version check on by default (ADR-0048): with neither switch in the
 * environment and the notice already shown, a version an earlier answer left
 * in ~/.ordewell/version-check.json reaches the banner and the status bar. The
 * day's check is already done, so the run sends nothing.
 */
test('names a newer version remembered in the shared file, in the banner and the status bar', async () => {
  const sandbox = makeSandbox();
  const port = await freePort();
  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  mkdirSync(join(sandbox.home, '.ordewell'), { recursive: true });
  writeFileSync(join(sandbox.home, '.ordewell', 'version-check.json'), JSON.stringify({
    installId: '3f0c1d9e-0000-4000-8000-000000000000',
    installIdAt: earlier,
    noticeShownAt: earlier,
    lastCheckAt: now,
    latest: '999.0.0',
    latestAt: now,
  }));
  const env = appEnv(sandbox, port, 0, { noProvider: true });
  delete env.ORDEWELL_NO_VERSION_CHECK;
  delete env.DO_NOT_TRACK;
  let app: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    app = await launchApp(sandbox, env);
    const welcome = await app.firstWindow();
    const workspace = await openFolder(app, welcome, sandbox.repo);
    const banner = workspace.getByRole('heading', { name: `Ordewell 999.0.0 is available. You have ${DESKTOP_VERSION}.` });
    // An unpackaged app has no updater, so this is the unsigned path: Download.
    await expect(banner).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Download' })).toBeVisible();
    await expect(workspace.getByRole('button', { name: 'Ordewell 999.0.0 is available' })).toHaveText('↑ 999.0.0 available');
    // Later hides the banner; the indicator stays, and brings the banner back.
    await workspace.getByRole('button', { name: 'Later' }).click();
    await expect(banner).toBeHidden();
    await workspace.getByRole('button', { name: 'Ordewell 999.0.0 is available' }).click();
    await expect(banner).toBeVisible();
  } finally {
    await closeApp(app);
    await untilListening(port, false);
    removeSandbox(sandbox);
  }
});
