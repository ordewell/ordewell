/** Verify the macOS word chord through Electron and a real shell (ADR-0069). */
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { appEnv, closeApp, freePort, launchApp, makeSandbox, openFolder, removeSandbox, startMock, untilListening, type Sandbox } from './fixtures';

let sandbox: Sandbox | undefined;
let mock: ChildProcess | undefined;
let app: ElectronApplication | undefined;
let daemonPort = 0;

const rows = (screen: Locator): Promise<string[]> => screen.locator('.xterm-rows > div').allInnerTexts();

test.beforeAll(async () => {
  if (process.platform !== 'darwin') return;
  sandbox = makeSandbox('ordewell-desktop-word-chord-');
  const started = await startMock();
  mock = started.process;
  daemonPort = await freePort();
  app = await launchApp(sandbox, appEnv(sandbox, daemonPort, started.port));
});

// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  for (const [i, page] of (app?.windows() ?? []).entries()) {
    await page.screenshot({ path: testInfo.outputPath(`window-${i}.png`) }).catch(() => undefined);
  }
});

test.afterAll(async () => {
  const closed = await closeApp(app).then(() => undefined, (error: unknown) => ({ error }));
  mock?.kill();
  if (daemonPort) await untilListening(daemonPort, false);
  if (closed) throw closed.error;
  if (sandbox) removeSandbox(sandbox);
});

// Option is the word chord only on macOS; elsewhere it is Ctrl, which xterm sends as it is.
test.skip(process.platform !== 'darwin', 'the Option chord is macOS\'s');

test('Option+Left/Right moves by words in a linked zsh, and otherwise leaves the line and later input intact', async () => {
  if (!app || !sandbox) throw new Error('the app did not launch');
  let win: Page = await app.firstWindow();
  win = await openFolder(app, win, sandbox.repo);
  const screen = win.locator('.terminal-host .xterm');

  async function run(command: string): Promise<void> {
    await screen.click();
    await win.keyboard.type(`clear; ${command}`);
    await win.keyboard.press('Enter');
  }
  /** Press the chord after the shell draws the line. */
  async function option(arrow: 'ArrowLeft' | 'ArrowRight'): Promise<void> {
    await win.waitForTimeout(300);
    await win.keyboard.press(`Alt+${arrow}`);
  }
  async function ran(output: string): Promise<void> {
    await win.waitForTimeout(300);
    await win.keyboard.press('Enter');
    await expect.poll(async () => (await rows(screen)).map((row) => row.trim())).toContain(output);
  }

  // The status bar names a runner once the window is ready for the panel's chord.
  await expect(win.getByRole('contentinfo')).toContainText('Claude Code');
  await win.keyboard.press('Control+Backquote');
  await expect(screen).toBeVisible();
  await expect.poll(async () => (await rows(screen)).some((row) => row.trim() !== '')).toBe(true);
  // macOS's own zsh with no zshenv joins the link (the sandbox's HOME has none); any other
  // login shell keeps the banner, and the chord must do nothing there.
  const dotdir = process.env.ZDOTDIR ?? sandbox.home;
  const linked = (process.env.SHELL || '/bin/zsh') === '/bin/zsh'
    && !['/etc/zshenv', '/etc/zshenv.zwc', join(dotdir, '.zshenv'), join(dotdir, '.zshenv.zwc')].some((path) => existsSync(path));
  await expect(win.locator('#terminal-word-keys')).toHaveCount(linked ? 0 : 1);
  const expected = linked ? 'one two XYthree' : 'one two threeXY';

  // The login shell is the developer's, zsh or bash: each is put in the mode by its own command.
  for (const [mode, setup] of [['emacs', 'bindkey -e'], ['vi', 'bindkey -v']] as const) {
    await test.step(`${mode} mode`, async () => {
      const bash = mode === 'emacs' ? 'set -o emacs' : 'set -o vi';
      await run(`PS1='$ '; if [ -n "$ZSH_VERSION" ]; then ${setup}; else ${bash}; fi; echo ${mode}-ready`);
      await expect.poll(async () => (await rows(screen)).map((row) => row.trim())).toContain(`${mode}-ready`);

      await win.keyboard.type('echo one two three');
      await option('ArrowLeft');
      await option('ArrowRight');
      await option('ArrowLeft');
      await win.keyboard.type('XY');
      await ran(expected);
    });
  }
});
