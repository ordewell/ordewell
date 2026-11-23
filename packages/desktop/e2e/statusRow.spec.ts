import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appEnv, closeApp, DESKTOP, freePort, launchApp, makeSandbox, openFolder, removeSandbox, untilListening } from './fixtures';

const OUT = join(DESKTOP, 'test-results', 'status-row');
const WIDTHS = [800, 1000, 1200, 1400, 1600] as const;
/** What Cmd + and Cmd - set: 100%, 150% and 200%. */
const ZOOMS = [1, 1.5, 2] as const;
const HEIGHT = 800;

interface RowBoxes {
  row: DOMRect;
  daemon: DOMRect;
  label: { box: DOMRect; truncated: boolean };
  update: { box: DOMRect; scrollWidth: number; clientWidth: number; text: string } | null;
  lines: number;
  /** Points along the row's middle where something other than the row is drawn on top. */
  covered: string[];
}

/** Where the row and its items sit, read in the window. */
async function boxes(page: Page): Promise<RowBoxes> {
  return page.evaluate(() => {
    const need = (selector: string): HTMLElement => {
      const found = document.querySelector<HTMLElement>(selector);
      if (!found) throw new Error(`no ${selector}`);
      return found;
    };
    const row = need('footer.frame-status');
    const label = need('.frame-status-daemon .ow-status-label');
    const update = document.querySelector<HTMLElement>('.frame-status-update');
    // Every child's top, rounded: one line is one distinct top.
    const tops = new Set([...row.querySelectorAll<HTMLElement>(':scope > *')].map((child) => Math.round(child.getBoundingClientRect().top + child.getBoundingClientRect().height / 2)));
    return {
      row: row.getBoundingClientRect().toJSON() as DOMRect,
      daemon: need('.frame-status-daemon').getBoundingClientRect().toJSON() as DOMRect,
      label: { box: label.getBoundingClientRect().toJSON() as DOMRect, truncated: label.scrollWidth > label.clientWidth },
      update: update ? { box: update.getBoundingClientRect().toJSON() as DOMRect, scrollWidth: update.scrollWidth, clientWidth: update.clientWidth, text: update.textContent ?? '' } : null,
      lines: tops.size,
      covered: (() => {
        const box = row.getBoundingClientRect();
        const y = box.top + box.height / 2;
        const found: string[] = [];
        for (let x = box.left + 2; x < box.right - 2; x += 8) {
          const top = document.elementFromPoint(x, y);
          if (top && !row.contains(top)) found.push(`${Math.round(x)}: ${top.tagName.toLowerCase()}.${[...top.classList].join('.')}`);
        }
        return found;
      })(),
    };
  });
}

/**
 * The status row holds the daemon and a newer version on one line at every
 * window width from 800 to 1600 px, at 100%, 150% and 200% zoom: no item
 * overlaps another or leaves the row, and the update notice is never cut.
 * Each size is captured under test-results/status-row.
 */
test('the status row stays one line, the update notice whole, at every width and zoom', async () => {
  const sandbox = makeSandbox();
  const port = await freePort();
  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  mkdirSync(join(sandbox.home, '.ordewell'), { recursive: true });
  // A version the day's check already found, so the row carries the update notice and nothing is sent.
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
  mkdirSync(OUT, { recursive: true });
  let app: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    app = await launchApp(sandbox, env);
    const electronApp = app;
    const welcome = await app.firstWindow();
    const page = await openFolder(app, welcome, sandbox.repo);
    const row = page.getByRole('contentinfo');
    await expect(row.locator('.frame-status-daemon[data-status="passed"]')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Ordewell 999.0.0 is available' })).toBeVisible();
    await expect(row).not.toContainText(/lease|started by this app|✓|% used/);
    const cdp = await page.context().newCDPSession(page);
    const report: Record<string, unknown>[] = [];

    for (const zoom of ZOOMS) {
      await electronApp.evaluate(({ BrowserWindow }, factor) => {
        for (const window of BrowserWindow.getAllWindows()) window.webContents.setZoomFactor(factor);
      }, zoom);
      for (const width of WIDTHS) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
        // The zoomed page lays out in width / zoom CSS pixels, as a window that size at that zoom does.
        await page.waitForFunction((expected) => Math.abs(window.innerWidth - expected) <= 1, Math.round(width / zoom));
        await page.waitForTimeout(100);
        const at = await boxes(page);
        const name = `row--${width}--${Math.round(zoom * 100)}`;
        // The window as drawn: Playwright's own capture does not follow the zoom factor.
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(OUT, `${name}.png`), Buffer.from(shot.data, 'base64'));
        report.push({ name, ...at });

        expect(at.lines, `${name}: one line`).toBe(1);
        expect(at.covered, `${name}: nothing drawn over the row`).toEqual([]);
        expect(at.daemon.left, `${name}: the daemon item inside the row`).toBeGreaterThanOrEqual(at.row.left);
        expect(at.label.box.right, `${name}: the label inside its item`).toBeLessThanOrEqual(at.daemon.right + 0.5);
        if (!at.update) throw new Error(`${name}: no update notice`);
        expect(at.update.text).toBe('↑ 999.0.0 available');
        expect(at.daemon.right, `${name}: the daemon item clear of the update notice`).toBeLessThanOrEqual(at.update.box.left + 0.5);
        expect(at.update.box.right, `${name}: the update notice inside the row`).toBeLessThanOrEqual(at.row.right + 0.5);
        expect(at.update.scrollWidth, `${name}: the update notice whole`).toBeLessThanOrEqual(at.update.clientWidth);
      }
    }

    // The daemon item's detail, opened from the keyboard at the narrowest width and the largest zoom: above the row, inside the window.
    await page.keyboard.press('Escape');
    await row.locator('.frame-status-daemon').focus();
    const detail = page.getByRole('tooltip');
    await expect(detail).toContainText(/started by this app|attached: started outside this app/);
    await expect(detail).toContainText('Lease: this window');
    const placed = await detail.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const footer = document.querySelector('footer.frame-status')?.getBoundingClientRect();
      return { left: box.left, right: box.right, bottom: box.bottom, rowTop: footer?.top ?? 0, width: window.innerWidth };
    });
    expect(placed.left).toBeGreaterThanOrEqual(0);
    expect(placed.right).toBeLessThanOrEqual(placed.width);
    expect(placed.bottom).toBeLessThanOrEqual(placed.rowTop);
    const open = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, 'row-detail--1600--200.png'), Buffer.from(open.data, 'base64'));
    writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await closeApp(app);
    await untilListening(port, false);
    removeSandbox(sandbox);
  }
});
