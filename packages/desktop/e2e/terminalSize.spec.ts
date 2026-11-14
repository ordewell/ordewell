/**
 * Every terminal tab's shell is told the grid its own xterm is drawn at, in the
 * real app: the real preload, main, node-pty and the user's login shell. The
 * panel changes size behind a hidden tab, the tab is shown again, and the
 * shell's own `stty size` must match what the xterm draws, Backspace across the
 * line's wrap must leave exactly the shell's line on screen, and the grid must
 * fit inside the visible part of the panel. A shell left at another tab's width
 * fails the first two; a grid fitted to the panel's padding as well fails the
 * last (terminalStore.ts, terminal.css).
 */
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { appEnv, closeApp, freePort, launchApp, makeSandbox, openFolder, removeSandbox, startMock, untilListening, type Sandbox } from './fixtures';

let sandbox: Sandbox | undefined;
let mock: ChildProcess | undefined;
let app: ElectronApplication | undefined;
let daemonPort = 0;

/** What the shown terminal's rows read, one string per row. */
const rows = (screen: Locator): Promise<string[]> => screen.locator('.xterm-rows > div').allInnerTexts();

test.beforeAll(async () => {
  sandbox = makeSandbox('ordewell-desktop-terminal-size-');
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

// Its commands are POSIX shell; Windows' terminal is PowerShell, whose ConPTY redraws the line itself.
test.skip(process.platform === 'win32', 'drives a POSIX shell');

test('a tab shown again after the panel changed size has its shell at its own grid', async () => {
  if (!app || !sandbox) throw new Error('the app did not launch');
  const electronApp = app;
  let win: Page = await electronApp.firstWindow();
  win = await openFolder(electronApp, win, sandbox.repo);
  const shown = await electronApp.browserWindow(win);
  /** Resizes the window and waits for the page to lay out at the new size. */
  async function setSize(width: number, height: number): Promise<void> {
    await shown.evaluate((w, [x, y]) => { w.setContentSize(x as number, y as number); }, [width, height]);
    await expect.poll(() => win.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([width, height]);
  }
  // The host holds only the shown tab's terminal.
  const screen = win.locator('.terminal-host .xterm');
  const tabs = win.getByRole('tablist', { name: 'Terminals' }).getByRole('tab');

  /** Runs `command` in the shown shell, after clearing it, so its output starts at the top row. */
  async function run(command: string): Promise<void> {
    await screen.click();
    await win.keyboard.type(`clear; ${command}`);
    await win.keyboard.press('Enter');
  }

  /** A fresh shell with a short, known prompt. */
  async function ready(): Promise<void> {
    await expect(screen).toBeVisible();
    await expect.poll(async () => (await rows(screen)).some((row) => row.trim() !== '')).toBe(true);
    await run("PS1='$ '; echo ready");
    await expect.poll(async () => (await rows(screen)).map((row) => row.trim())).toContain('ready');
  }

  let checks = 0;
  /**
   * The shown shell's `stty size` against the xterm's grid: its row count, and
   * a run of exactly as many x's as the shell believes the width is, then END.
   * Only when the two agree do the x's fill one row and END start the next: a
   * wider grid draws END after them on the same row, a narrower one carries x's
   * into the next.
   */
  async function expectInSync(): Promise<{ cols: number; rows: number }> {
    // Numbered, so the previous check's output, still on screen until clear runs, is never read as this one's.
    const mark = `S${++checks}`;
    await run(`printf '${mark} %s E\\n' "$(stty size)"; printf '%*s' "$(tput cols)" '' | tr ' ' x; echo END`);
    let size: { cols: number; rows: number } | undefined;
    await expect.poll(async () => {
      const match = new RegExp(`^${mark} (\\d+) (\\d+) E$`).exec((await rows(screen))[0]?.trim() ?? '');
      size = match ? { rows: Number(match[1]), cols: Number(match[2]) } : undefined;
      return size;
    }).toBeDefined();
    if (!size) throw new Error('the shell printed no size');
    const cols = size.cols;
    await expect.poll(async () => (await rows(screen)).slice(1, 3).map((row) => row.trim())).toEqual(['x'.repeat(cols), 'END']);
    expect(await screen.locator('.xterm-rows > div').count()).toBe(size.rows);
    return size;
  }

  /** The grid ends inside the panel's padding and short of the scrollbar's lane, where nothing is clipped or covered. */
  async function expectWithinPanel(): Promise<void> {
    const box = await win.evaluate(() => {
      const host = document.querySelector('.terminal-host');
      const grid = document.querySelector('.terminal-host .xterm-screen');
      if (!host || !grid) return undefined;
      const outer = host.getBoundingClientRect();
      const style = getComputedStyle(host);
      const drawn = grid.getBoundingClientRect();
      return {
        right: outer.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth),
        bottom: outer.bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth),
        gridRight: drawn.right,
        gridBottom: drawn.bottom,
      };
    });
    if (!box) throw new Error('no terminal grid in the panel');
    // The fit addon keeps 14px for the scrollbar; half a pixel absorbs rounding of fractional cells.
    expect(box.gridRight).toBeLessThanOrEqual(box.right - 14 + 0.5);
    expect(box.gridBottom).toBeLessThanOrEqual(box.bottom + 0.5);
  }

  await test.step('open two terminals at one size', async () => {
    await setSize(1200, 800);
    await expect(win.getByRole('contentinfo')).toContainText('Claude Code');
    await win.keyboard.press('Control+Backquote');
    await expect(win.getByRole('tablist', { name: 'Terminals' })).toBeVisible();
    await ready();
    await win.getByRole('button', { name: 'New terminal in your checkout' }).click();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await ready();
    await expectInSync();
    await expectWithinPanel();
  });

  let resized = { cols: 0, rows: 0 };
  await test.step('resize the window while the second tab is shown', async () => {
    const wide = await expectInSync();
    await setSize(820, 640);
    resized = await expectInSync();
    // The layout gives the panel another width here; which way does not matter, only that the first tab's shell missed it.
    expect(resized.cols).not.toBe(wide.cols);
    await expectWithinPanel();
  });

  await test.step('show the first tab again: its shell is told the grid it is drawn at', async () => {
    await tabs.nth(0).click();
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    expect(await expectInSync()).toEqual(resized);
    await expectWithinPanel();
  });

  await test.step('Backspace across the line\'s wrap leaves exactly the shell\'s line', async () => {
    const typed = Array.from({ length: resized.cols + 10 }, (_, i) => 'abcdefghij'[i % 10]).join('');
    const erased = 20;
    const left = `$ echo ${typed.slice(0, typed.length - erased)}`;
    await run('true');
    await expect.poll(async () => (await rows(screen))[0]?.trim()).toBe('$');
    await win.keyboard.type(`echo ${typed}`);
    // The line is drawn across two rows before any of it is erased.
    await expect.poll(async () => (await rows(screen))[1]?.trim() ?? '').not.toBe('');
    for (let i = 0; i < erased; i++) await win.keyboard.press('Backspace');
    await expect.poll(async () => (await rows(screen)).map((row) => row.trimEnd()).filter(Boolean).join('|'), { timeout: 10_000 })
      .toBe(left.length > resized.cols ? `${left.slice(0, resized.cols)}|${left.slice(resized.cols)}` : left);
    await win.keyboard.press('Enter');
    await expect.poll(async () => (await rows(screen)).map((row) => row.trim())).toContain(left.slice('$ echo '.length));
  });

  await test.step('rapid resizes and switches leave each shell in step once shown', async () => {
    // Nothing is checked between steps: each switch follows the resize as soon as the page has laid it out.
    for (const [width, height, tab] of [[1000, 700, 1], [760, 520, 0], [960, 600, 1], [880, 760, 0], [1100, 560, 1]] as const) {
      await setSize(width, height);
      await tabs.nth(tab).click();
    }
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    const last = await expectInSync();
    await expectWithinPanel();
    await tabs.nth(0).click();
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    expect(await expectInSync()).toEqual(last);
    await expectWithinPanel();
  });
});
