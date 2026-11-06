/**
 * Switching project from a project window, end to end and offline (ADR-0063 H6).
 *
 * The app opens one repository from the welcome window, then goes to others
 * through the title bar's project switcher: a window with nothing live
 * switches in place, a folder already open is focused rather than opened
 * twice, and a window whose run is live is never switched away. It offers a
 * new window instead, and Cancel leaves everything as it was. The run is the
 * desktop-e2e persona's, whose task #1 holds its turn open, so it stays live.
 *
 * The switcher drives this rather than the File menu: a menu item acts on the
 * focused window, and a test window is never focused. Both reach main's same
 * ProjectOpener. The native picker and message box cannot be driven, so main's
 * dialog answers for them, and records what it was asked.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appEnv, closeApp, freePort, launchApp, makeSandbox, openFolder, removeSandbox, startMock, untilListening, type Sandbox } from './fixtures';

const GOAL = 'Add greeting and farewell modules';

let sandbox: Sandbox | undefined;
let mock: ChildProcess | undefined;
let app: ElectronApplication | undefined;
let daemonPort = 0;

/** Another repository beside the sandbox's, with one commit. */
function repository(name: string): string {
  if (!sandbox) throw new Error('no sandbox');
  const dir = path.join(sandbox.tmp, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  const env = { ...process.env, HOME: sandbox.home };
  for (const args of [['init', '-q'], ['add', '.'], ['commit', '-qm', 'init']]) execFileSync('git', args, { cwd: dir, env });
  return dir;
}

/** The next folder main's picker answers with. */
async function pickerAnswers(electronApp: ElectronApplication, folder: string): Promise<void> {
  await electronApp.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, folder);
}

/** Main's message box answers with `response` and keeps each message it was asked. */
async function messageBoxAnswers(electronApp: ElectronApplication, response: number): Promise<void> {
  await electronApp.evaluate(({ dialog }, answer) => {
    const slot = globalThis as unknown as { ordewellAsked?: string[] };
    slot.ordewellAsked = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.find((arg): arg is { message: string } => typeof arg === 'object' && arg !== null && 'message' in arg);
      slot.ordewellAsked?.push(options?.message ?? '');
      return { response: answer, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, response);
}

async function asked(electronApp: ElectronApplication): Promise<string[]> {
  return electronApp.evaluate(() => (globalThis as unknown as { ordewellAsked?: string[] }).ordewellAsked ?? []);
}

const switcher = (win: Page) => win.locator('header.frame-title').getByRole('button', { name: /, Switch project$/ });
const switchMenu = (win: Page) => win.getByRole('menu', { name: 'Switch project' });

/** The window's project, by the name its switcher carries. */
async function expectProject(win: Page, name: string): Promise<void> {
  await expect(switcher(win)).toHaveAccessibleName(`${name}, Switch project`);
}

test.beforeAll(async () => {
  sandbox = makeSandbox('ordewell-desktop-switch-');
  const started = await startMock();
  mock = started.process;
  daemonPort = await freePort();
  app = await launchApp(sandbox, appEnv(sandbox, daemonPort, started.port));
  await app.context().tracing.start({ screenshots: true, snapshots: true });
});

// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  const failed = testInfo.status !== testInfo.expectedStatus;
  await app?.context().tracing.stop(failed ? { path: testInfo.outputPath('trace.zip') } : undefined).catch(() => undefined);
  if (failed) {
    for (const [i, page] of (app?.windows() ?? []).entries()) {
      await page.screenshot({ path: testInfo.outputPath(`window-${i}.png`) }).catch(() => undefined);
    }
  }
});

test.afterAll(async () => {
  // Quitting with the run live asks first; the test's answer is to quit.
  if (app) await messageBoxAnswers(app, 0).catch(() => undefined);
  const closed = await closeApp(app).then(() => undefined, (error: unknown) => ({ error }));
  mock?.kill();
  if (daemonPort) await untilListening(daemonPort, false);
  if (closed) throw closed.error;
  if (sandbox) removeSandbox(sandbox);
});

test('a project window switches in place, focuses an open folder, and never leaves a live run', async () => {
  if (!app || !sandbox) throw new Error('the app did not launch');
  const electronApp = app;
  const billing = repository('billing');
  const docs = repository('docs');
  const scratch = repository('scratch');
  const welcome = await electronApp.firstWindow();
  let win: Page = welcome;

  await test.step('welcome: open the first workspace', async () => {
    win = await openFolder(electronApp, welcome, sandbox?.repo ?? '');
    await expect(win.getByRole('contentinfo')).toContainText('Claude Code');
    await expectProject(win, 'repo');
    await expect(switcher(win)).toHaveAttribute('title', sandbox?.repo ?? '');
  });

  await test.step('with nothing live, Open Folder… switches this window to the folder', async () => {
    await pickerAnswers(electronApp, billing);
    await switcher(win).click();
    await switchMenu(win).getByRole('menuitem', { name: 'Open Folder…' }).click();
    await expectProject(win, 'billing');
    await expect(win.getByRole('contentinfo')).toContainText('Claude Code');
    expect(electronApp.windows()).toHaveLength(1);
    // The folder it left is now a recent, and the window's own is not offered.
    await switcher(win).click();
    await expect(switchMenu(win).getByRole('menuitem', { name: 'repo', exact: true })).toBeVisible();
    await expect(switchMenu(win).getByRole('menuitem', { name: 'billing', exact: true })).toHaveCount(0);
  });

  await test.step('a recent switches back, in the same window', async () => {
    await switchMenu(win).getByRole('menuitem', { name: 'repo', exact: true }).click();
    await expectProject(win, 'repo');
    await expect(win.getByRole('contentinfo')).toContainText('Claude Code');
    expect(electronApp.windows()).toHaveLength(1);
  });

  let other: Page = win;
  await test.step('Open in new window gives the folder a window of its own', async () => {
    await switcher(win).click();
    await switchMenu(win).getByRole('menuitemcheckbox', { name: 'Open in new window' }).click();
    await expect(switchMenu(win).getByRole('menuitemcheckbox', { name: 'Open in new window' })).toHaveAttribute('aria-checked', 'true');
    [other] = await Promise.all([
      electronApp.waitForEvent('window'),
      switchMenu(win).getByRole('menuitem', { name: 'billing', exact: true }).click(),
    ]);
    await expectProject(other, 'billing');
    await expectProject(win, 'repo');
  });

  await test.step('a folder open in another window is focused there, not opened twice', async () => {
    await switcher(other).click();
    await switchMenu(other).getByRole('menuitem', { name: 'repo', exact: true }).click();
    await expect(switchMenu(other)).toHaveCount(0);
    expect(electronApp.windows()).toHaveLength(2);
    await expectProject(other, 'billing');
    await expectProject(win, 'repo');
    // The option was this window's: untick it, so a choice switches again.
    await switcher(win).click();
    await switchMenu(win).getByRole('menuitemcheckbox', { name: 'Open in new window' }).click();
    await expect(switchMenu(win).getByRole('menuitemcheckbox', { name: 'Open in new window' })).toHaveAttribute('aria-checked', 'false');
    await win.keyboard.press('Escape');
  });

  const editor = win.getByRole('main', { name: 'Centre' });
  const planPanel = win.getByRole('complementary', { name: 'Plan', exact: true });
  const running = editor.getByRole('grid', { name: 'Plan graph' }).getByRole('button', { name: /^#1 Add a greeting module, running/ });

  await test.step('a run starts in the first workspace', async () => {
    await win.getByRole('button', { name: 'New session' }).click();
    const box = editor.getByRole('textbox', { name: 'Message the planner' });
    await box.fill(GOAL);
    await box.press('Enter');
    const approve = win.locator('header.frame-title').getByRole('button', { name: 'Approve plan' });
    await expect(approve).toBeVisible({ timeout: 60_000 });
    await planPanel.getByRole('button', { name: 'Open the plan graph' }).click();
    await approve.click();
    await expect(running).toBeVisible({ timeout: 60_000 });
  });

  await test.step('with the run live, Cancel leaves the window and the recents as they were', async () => {
    await messageBoxAnswers(electronApp, 1);
    await pickerAnswers(electronApp, scratch);
    await switcher(win).click();
    await switchMenu(win).getByRole('menuitem', { name: 'Open Folder…' }).click();
    await expect.poll(() => asked(electronApp)).toEqual(['This window has work in progress. Open “scratch” in a new window?']);
    expect(electronApp.windows()).toHaveLength(2);
    await expectProject(win, 'repo');
    await expect(running).toBeVisible();
    await switcher(win).click();
    await expect(switchMenu(win).getByRole('menuitem', { name: 'billing', exact: true })).toBeVisible();
    await expect(switchMenu(win).getByRole('menuitem', { name: 'scratch', exact: true })).toHaveCount(0);
    await win.keyboard.press('Escape');
  });

  await test.step('with the run live, Open in New Window opens the folder beside it, and the run goes on', async () => {
    await messageBoxAnswers(electronApp, 0);
    await pickerAnswers(electronApp, docs);
    await switcher(win).click();
    const [opened] = await Promise.all([
      electronApp.waitForEvent('window'),
      switchMenu(win).getByRole('menuitem', { name: 'Open Folder…' }).click(),
    ]);
    expect(await asked(electronApp)).toEqual(['This window has work in progress. Open “docs” in a new window?']);
    await expectProject(opened, 'docs');
    expect(electronApp.windows()).toHaveLength(3);
    await expectProject(win, 'repo');
    await expect(running).toBeVisible();
  });
});
