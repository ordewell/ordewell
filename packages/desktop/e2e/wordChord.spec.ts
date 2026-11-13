/**
 * Option+Left/Right in the real app on macOS, through the real preload, main,
 * node-pty and the login shell, in its emacs and its vi mode. In vi mode the
 * old bytes did their damage to what was typed next (ESC f swallowed it, and
 * ESC[1;3C deleted the rest of the line), so each step types and deletes after
 * the chord and checks what the shell ran (wordKeys.ts).
 */
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
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

test('Option+Left/Right moves a word in emacs and vi mode, and typing and deleting go on as usual', async () => {
  if (!app || !sandbox) throw new Error('the app did not launch');
  let win: Page = await app.firstWindow();
  win = await openFolder(app, win, sandbox.repo);
  const screen = win.locator('.terminal-host .xterm');

  async function run(command: string): Promise<void> {
    await screen.click();
    await win.keyboard.type(`clear; ${command}`);
    await win.keyboard.press('Enter');
  }
  /** Presses the chord once the shell has drawn the last key, since the chord reads the word off the screen, as the user does. */
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

  // The login shell is the developer's, zsh or bash: each is put in the mode by its own command.
  for (const [mode, setup] of [['emacs', 'bindkey -e'], ['vi', 'bindkey -v']] as const) {
    await test.step(`${mode} mode`, async () => {
      const bash = mode === 'emacs' ? 'set -o emacs' : 'set -o vi';
      await run(`PS1='$ '; if [ -n "$ZSH_VERSION" ]; then ${setup}; else ${bash}; fi; echo ${mode}-ready`);
      await expect.poll(async () => (await rows(screen)).map((row) => row.trim())).toContain(`${mode}-ready`);

      await win.keyboard.type('echo one two three');
      await option('ArrowLeft');
      await option('ArrowLeft');
      await win.waitForTimeout(300);
      await win.keyboard.type('X');
      await ran('one Xtwo three');

      await win.keyboard.type('echo one two three');
      for (let i = 0; i < 3; i++) await option('ArrowLeft');
      await option('ArrowRight');
      await win.waitForTimeout(300);
      await win.keyboard.type('YZ');
      await win.keyboard.press('Backspace');
      await ran('oneY two three');

      // Past the last word the chord sends nothing, so the next key is typed, not read as a vi command.
      await win.keyboard.type('echo one two');
      await option('ArrowRight');
      await win.waitForTimeout(300);
      await win.keyboard.type('.x');
      await ran('one two.x');
    });
  }
});
