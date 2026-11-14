/**
 * The integrated terminal's copy and paste in the real app, through the real
 * preload, main and system clipboard (ADR-0063 H4). The session grants the page
 * no web clipboard permission, so every copy and paste here goes through the
 * bridge. A regression to `navigator.clipboard` fails each step.
 *
 * It uses the chords of the platform it runs on: Cmd+C and Cmd+V on macOS,
 * Ctrl+Shift+C and Ctrl+Shift+V elsewhere. A bare Ctrl+C still interrupts the
 * shell. The run writes the system clipboard, so it puts back what the
 * developer had copied.
 */
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { appEnv, closeApp, freePort, launchApp, makeSandbox, openFolder, removeSandbox, startMock, untilListening, type Sandbox } from './fixtures';

const MAC = process.platform === 'darwin';
const COPY = MAC ? 'Meta+C' : 'Control+Shift+C';
const PASTE = MAC ? 'Meta+V' : 'Control+Shift+V';

let sandbox: Sandbox | undefined;
let mock: ChildProcess | undefined;
let app: ElectronApplication | undefined;
let daemonPort = 0;
let developersClipboard: string | undefined;

const setClipboard = (electronApp: ElectronApplication, text: string): Promise<void> =>
  electronApp.evaluate(({ clipboard }, value) => { clipboard.writeText(value); }, text);
const clipboardText = (electronApp: ElectronApplication): Promise<string> =>
  electronApp.evaluate(({ clipboard }) => clipboard.readText());

/** What the terminal's rows show, one string per row. */
async function rows(screen: Locator): Promise<string[]> {
  return screen.locator('.xterm-rows > div').allInnerTexts();
}

/** How many rows read exactly `text`: a command's output, never the line that typed it. */
async function outputLines(screen: Locator, text: string): Promise<number> {
  return (await rows(screen)).filter((row) => row.trim() === text).length;
}

test.beforeAll(async () => {
  sandbox = makeSandbox('ordewell-desktop-clipboard-');
  const started = await startMock();
  mock = started.process;
  daemonPort = await freePort();
  app = await launchApp(sandbox, appEnv(sandbox, daemonPort, started.port));
  developersClipboard = await clipboardText(app);
});

// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  for (const [i, page] of (app?.windows() ?? []).entries()) {
    await page.screenshot({ path: testInfo.outputPath(`window-${i}.png`) }).catch(() => undefined);
  }
});

test.afterAll(async () => {
  if (app && developersClipboard !== undefined) await setClipboard(app, developersClipboard).catch(() => undefined);
  const closed = await closeApp(app).then(() => undefined, (error: unknown) => ({ error }));
  mock?.kill();
  if (daemonPort) await untilListening(daemonPort, false);
  if (closed) throw closed.error;
  if (sandbox) removeSandbox(sandbox);
});

// Its commands are POSIX shell; Windows' terminal is PowerShell, whose chords are the same code this proves on Linux.
test.skip(process.platform === 'win32', 'drives a POSIX shell');

test('the terminal copies and pastes with the platform\'s chords, and Ctrl+C still interrupts', async () => {
  if (!app || !sandbox) throw new Error('the app did not launch');
  const electronApp = app;
  let win: Page = await electronApp.firstWindow();
  win = await openFolder(electronApp, win, sandbox.repo);
  const screen = win.locator('.xterm').first();

  await test.step('open a terminal', async () => {
    await expect(win.getByRole('contentinfo')).toContainText('Claude Code');
    await win.keyboard.press('Control+Backquote');
    await expect(win.getByRole('tablist', { name: 'Terminals' })).toBeVisible();
    await expect(screen).toBeVisible();
    await screen.click();
    // The shell has drawn its prompt once a row holds anything.
    await expect.poll(async () => (await rows(screen)).some((row) => row.trim() !== '')).toBe(true);
  });

  await test.step(`${PASTE} pastes the clipboard once, as a paste`, async () => {
    // The pasted line holds the arithmetic, its output the answer, so a row reading the answer is the command's output.
    await setClipboard(electronApp, 'echo pasted-$((6*7))');
    await win.keyboard.press(PASTE);
    await win.keyboard.press('Enter');
    await expect.poll(() => outputLines(screen, 'pasted-42')).toBe(1);
    // A paste delivered twice would have run `echo pasted-$((6*7))echo pasted-$((6*7))`.
    expect((await rows(screen)).some((row) => row.includes('pasted-42echo'))).toBe(false);
    await expect(win.getByText('Could not paste')).toHaveCount(0);
  });

  await test.step(`${COPY} copies the selection`, async () => {
    await setClipboard(electronApp, 'nothing copied yet');
    const row = screen.locator('.xterm-rows > div', { hasText: /^pasted-42\s*$/ }).first();
    const box = await row.boundingBox();
    if (!box) throw new Error('the output row has no box');
    await win.mouse.dblclick(box.x + 8, box.y + box.height / 2);
    await win.keyboard.press(COPY);
    await expect.poll(() => clipboardText(electronApp)).toBe('pasted-42');
    await expect(win.getByText('Could not copy the selection')).toHaveCount(0);
  });

  await test.step('with nothing selected, a right-click pastes', async () => {
    await screen.click();
    await setClipboard(electronApp, 'echo menu-$((2+3))');
    await screen.click({ button: 'right' });
    await win.keyboard.press('Enter');
    await expect.poll(() => outputLines(screen, 'menu-5')).toBe(1);
  });

  await test.step('a bare Ctrl+C interrupts the shell, and copies nothing', async () => {
    await setClipboard(electronApp, 'left alone');
    // The job prints once it holds the terminal, so the interrupt cannot land on the shell between Enter and the job's start.
    await win.keyboard.type("sh -c 'echo started-$((3*3)); exec sleep 120'");
    await win.keyboard.press('Enter');
    await expect.poll(() => outputLines(screen, 'started-9')).toBe(1);
    await win.keyboard.press('Control+C');
    // The shell's next prompt below the job: without the interrupt it would be sleeping long past this wait.
    await expect.poll(async () => {
      const lines = await rows(screen);
      const started = lines.findIndex((row) => row.trim() === 'started-9');
      return lines.slice(started + 1).some((row) => row.trim() !== '' && !row.includes('^C'));
    }, { timeout: 20_000 }).toBe(true);
    await win.keyboard.type('echo after-$((1+1))');
    await win.keyboard.press('Enter');
    await expect.poll(() => outputLines(screen, 'after-2')).toBe(1);
    expect(await clipboardText(electronApp)).toBe('left alone');
  });
});
