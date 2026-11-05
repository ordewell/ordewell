/**
 * The visual tour: every state the desktop app is designed to show, captured in
 * both themes at three sizes, with layout checks on each capture, for a design
 * review to start from. It walks the acceptance test's offline run (mock
 * planner, fake runner) and then a second launch that meets a session a VS Code
 * window holds, joins one another daemon holds, and loses a daemon.
 *
 * Output, all under test-results/tour (gitignored): `<state>--<theme>--<w>x<h>.png`,
 * report.json with every check and probe, and index.html, a contact sheet.
 * A state the tour cannot reach fails the test; a failing layout check fails it
 * only with TOUR_STRICT=1, since the checks describe the app as it is today.
 *
 * Sizes larger than the screen are drawn by Chromium's device-metrics
 * emulation, so a 1920x1080 capture does not need a 1920x1080 display.
 */
import { expect, test, type CDPSession, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bandDefaults, paneBounds } from '../src/renderer/frame/layout';
import { appEnv, DESKTOP, freePort, launchApp, makeSandbox, openFolder, removeSandbox, ROOT, startMock, untilListening, type Sandbox } from './fixtures';
import { CARD_SELECTORS, LIFT_MIN, liftChecks, TEXT_MIN, type LiftResult } from './surfaces';

const OUT = path.join(DESKTOP, 'test-results', 'tour');
const SIZES = [{ width: 1280, height: 800 }, { width: 1512, height: 982 }, { width: 1920, height: 1080 }] as const;
/** Too narrow to dock the plan panel beside the centre's minimum, so it opens as a drawer. */
const NARROW = { width: 900, height: 800 } as const;
const THEMES = ['dark', 'light'] as const;
const STRICT = process.env.TOUR_STRICT === '1';
// "Waiting for merge" is a task's status (docs/desktop/design.md, status table), and "Waiting for a merge"
// the Changes heading over the tasks in that status: neither is a wait that should end.
const LOADING_WORDS = '\\b(Detecting|Loading|Checking|Waiting for(?! (a )?merge))\\b';
const LOADING_GRACE_MS = 15_000;
const GOAL = 'Add greeting and farewell modules';
/** The mock planner answers this goal with its widest cards (bench/live/mock-provider.mjs, DESKTOP_FIT_PLAN). */
const FIT_GOAL = 'Check that the plan cards fit';
const COMMENT = 'Export it as a named constant, please.';

type Theme = typeof THEMES[number];
interface Size { readonly width: number; readonly height: number }
type CheckId = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i';

const CHECK_NAMES: Record<CheckId, string> = {
  a: 'title bar controls visible, in the viewport, unclipped and unobscured',
  b: 'every visible button, link, task card and graph node is hit-testable at its centre',
  c: 'nothing overflows horizontally',
  d: 'targets are at least 24x24',
  e: `no loading text still visible ${LOADING_GRACE_MS / 1000} s after the state settles`,
  f: 'no console errors',
  g: 'a chat with messages spans its tab: a long message and the composer fill at least 90% of the chat (1920x1080, plan panel closed)',
  h: 'no element of a graph card overflows the card or overlaps a sibling',
  i: `every card's fill stands off its backdrop by at least ${LIFT_MIN}:1, and its text reads at ${TEXT_MIN}:1 (e2e/surfaces.ts)`,
};
const CHAT_FILL = 0.9;

interface Check { readonly id: CheckId; readonly name: string; readonly pass: boolean; readonly count: number; readonly details: string[] }
interface Shot { readonly file: string; readonly theme: Theme; readonly width: number; readonly height: number; readonly png: Size; readonly checks: Check[] }
interface StateRecord {
  readonly id: string;
  readonly title: string;
  reached: boolean;
  error?: string;
  readonly notes: string[];
  readonly shots: Shot[];
  loadingSettledMs?: number;
}

/** What the page reports about itself; computed in the renderer, so it uses nothing from this module. */
interface PageChecks {
  readonly viewport: Size;
  readonly titleBar: { present: boolean; controls: string[]; problems: string[] };
  readonly hit: { checked: number; covered: number; failures: string[] };
  readonly overflow: string[];
  readonly small: { checked: number; failures: string[] };
  readonly loading: string[];
  readonly cards: string[];
}

interface ConsoleError { readonly at: number; readonly page: string; readonly text: string }

let sandbox: Sandbox | undefined;
let mock: ChildProcess | undefined;
const apps: ElectronApplication[] = [];
const daemons: ChildProcess[] = [];
const ports: number[] = [];
const states: StateRecord[] = [];
const consoleErrors: ConsoleError[] = [];
const probes: Record<string, unknown> = {};
const cdps = new WeakMap<Page, CDPSession>();

// ---------------------------------------------------------------- in the page

/**
 * Runs in the renderer. The visible part of an element is its box cut by every
 * ancestor that clips, and by the viewport: an element pushed out of a clipping
 * title bar has no visible part even though it is laid out and displayed.
 */
function inPageChecks(loadingSource: string): PageChecks {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const loading = new RegExp(loadingSource);
  const describe = (el: Element): string => {
    const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' && el.className.trim() !== '' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const name = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 48);
    return `${role}${cls} "${name}"`;
  };
  const visibleRect = (el: Element): DOMRect | undefined => {
    const r = el.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    let right = r.right;
    let bottom = r.bottom;
    let fixed = getComputedStyle(el).position === 'fixed';
    for (let a = el.parentElement; a && !fixed; a = a.parentElement) {
      const s = getComputedStyle(a);
      const ar = a.getBoundingClientRect();
      if (s.overflowX !== 'visible') { left = Math.max(left, ar.left); right = Math.min(right, ar.right); }
      if (s.overflowY !== 'visible') { top = Math.max(top, ar.top); bottom = Math.min(bottom, ar.bottom); }
      fixed = s.position === 'fixed';
    }
    left = Math.max(left, 0);
    top = Math.max(top, 0);
    right = Math.min(right, vw);
    bottom = Math.min(bottom, vh);
    if (right - left < 1 || bottom - top < 1) return undefined;
    return new DOMRect(left, top, right - left, bottom - top);
  };
  const shown = (el: Element): boolean => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  // Monaco parks its screen-reader live region off-screen on purpose: it is the editor's, not a layout fault.
  const foreignSelector = '.monaco-editor, .monaco-aria-container, .xterm';
  const foreign = (el: Element): boolean => el.closest(foreignSelector) !== null;
  const overlay = '[role="dialog"], [role="menu"], [role="listbox"], .frame-popover';

  const titleBar = { present: false, controls: [] as string[], problems: [] as string[] };
  const header = document.querySelector('.frame-title');
  if (header) {
    titleBar.present = true;
    if (header.scrollWidth > header.clientWidth + 1) titleBar.problems.push(`the title bar's content is ${header.scrollWidth}px wide in ${header.clientWidth}px`);
    const hr = header.getBoundingClientRect();
    if (hr.right > vw + 1) titleBar.problems.push(`the title bar ends at ${Math.round(hr.right)}px, past the ${vw}px viewport`);
    for (const control of header.querySelectorAll('button, [role="button"], a[href]')) {
      if (!shown(control)) continue;
      const name = describe(control);
      titleBar.controls.push(name);
      const r = control.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) { titleBar.problems.push(`${name} has collapsed to ${Math.round(r.width)}x${Math.round(r.height)}`); continue; }
      if (r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh + 1) {
        titleBar.problems.push(`${name} is outside the viewport (${Math.round(r.left)}–${Math.round(r.right)} of ${vw})`);
        continue;
      }
      const v = visibleRect(control);
      if (!v || v.width * v.height < r.width * r.height - 2) {
        titleBar.problems.push(`${name} is clipped to ${v ? `${Math.round(v.width)}x${Math.round(v.height)}` : 'nothing'} of ${Math.round(r.width)}x${Math.round(r.height)}`);
        continue;
      }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !(hit === control || control.contains(hit))) titleBar.problems.push(`${name} is covered by ${hit ? describe(hit) : 'nothing'}`);
    }
  }

  const targets = [...document.querySelectorAll('button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="treeitem"], .graph-card')]
    // An inert subtree (the frame while it is read-only) takes no pointer and no focus, so it holds no target.
    .filter((el) => !foreign(el) && shown(el) && el.closest('[inert]') === null);
  const hit = { checked: 0, covered: 0, failures: [] as string[] };
  const small = { checked: 0, failures: [] as string[] };
  for (const el of targets) {
    const v = visibleRect(el);
    if (!v) continue;
    // A target scrolled to a sliver at its scroller's edge is not on offer yet, and a sash's grip may lie over it.
    const whole = el.getBoundingClientRect();
    if ((v.width < 24 && v.width < whole.width - 1) || (v.height < 24 && v.height < whole.height - 1)) continue;
    hit.checked += 1;
    const at = document.elementFromPoint(v.left + v.width / 2, v.top + v.height / 2);
    if (!at || !(at === el || el.contains(at))) {
      // Under an open popover or menu, being covered is the design.
      if (at?.closest(overlay) && !el.closest(overlay)) hit.covered += 1;
      else hit.failures.push(`${describe(el)} → ${at ? describe(at) : 'nothing'}`);
    }
    // A link inside running text is exempt from the target size, as WCAG 2.5.8 has it.
    if (el.tagName === 'A' && el.closest('p')) continue;
    small.checked += 1;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) small.failures.push(`${describe(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }

  const overflow: string[] = [];
  const root = document.documentElement;
  if (root.scrollWidth > vw + 1) overflow.push(`the document is ${root.scrollWidth}px wide in a ${vw}px viewport`);
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest(foreignSelector)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const s = getComputedStyle(el);
    // A container that cuts its own content off, other than a deliberate ellipsis.
    if ((s.overflowX === 'hidden' || s.overflowX === 'clip') && s.textOverflow !== 'ellipsis' && el.children.length > 0
      && el.scrollWidth > el.clientWidth + 1 && shown(el)) {
      overflow.push(`${describe(el)} cuts off ${el.scrollWidth - el.clientWidth}px of its content`);
    }
    if (r.right <= vw + 1 && r.left >= -1) continue;
    const parent = el.parentElement;
    if (parent) {
      const pr = parent.getBoundingClientRect();
      if (pr.right > vw + 1 || pr.left < -1) continue;
    }
    let scrolls = false;
    for (let a = el.parentElement; a; a = a.parentElement) {
      const ox = getComputedStyle(a).overflowX;
      if (ox === 'auto' || ox === 'scroll') { scrolls = true; break; }
    }
    if (!scrolls && shown(el)) overflow.push(`${describe(el)} spans ${Math.round(r.left)}–${Math.round(r.right)} of a ${vw}px viewport`);
  }

  const loadingTexts = new Set<string>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? '').trim();
    const parent = node.parentElement;
    if (!text || !parent || !loading.test(text) || foreign(parent) || !shown(parent) || !visibleRect(parent)) continue;
    loadingTexts.add(text.replace(/\s+/g, ' ').slice(0, 80));
  }

  // A graph card holds its parts in a fixed height (design W5): a long title, model or badge row must
  // shorten inside it, never spill past its edge, run into a neighbour or slide under the chat button.
  const cards: string[] = [];
  const overlap = (a: DOMRect, b: DOMRect): boolean =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  for (const card of document.querySelectorAll('.graph-card')) {
    if (!shown(card) || !visibleRect(card)) continue;
    const order = card.querySelector('.graph-card-order')?.textContent ?? describe(card);
    const cr = card.getBoundingClientRect();
    // The peek is a popover that sits beside the card on purpose; an icon's own paths are its drawing.
    const parts = [...card.querySelectorAll('*')].filter((el) => el.closest('.graph-peek') === null && el.parentElement?.closest('svg') == null && shown(el));
    for (const el of parts) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.left < cr.left - 1 || r.right > cr.right + 1 || r.top < cr.top - 1 || r.bottom > cr.bottom + 1) {
        cards.push(`${order}: ${describe(el)} runs past the card (${Math.round(r.left - cr.left)},${Math.round(r.top - cr.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${Math.round(cr.width)}x${Math.round(cr.height)})`);
      }
      const flow = [...el.children].filter((c) => c.closest('.graph-peek') === null && el.closest('svg') === null && shown(c) && !['absolute', 'fixed'].includes(getComputedStyle(c).position));
      for (let i = 0; i < flow.length; i++) {
        for (let j = i + 1; j < flow.length; j++) {
          if (overlap(flow[i]!.getBoundingClientRect(), flow[j]!.getBoundingClientRect())) cards.push(`${order}: ${describe(flow[i]!)} overlaps ${describe(flow[j]!)}`);
        }
      }
    }
    const chat = card.querySelector('.graph-card-chat');
    if (chat && shown(chat)) {
      const hr = chat.getBoundingClientRect();
      for (const leaf of card.querySelectorAll('.graph-card-face *')) {
        if (leaf.children.length > 0 && leaf.tagName.toLowerCase() !== 'svg') continue;
        if (leaf.parentElement?.closest('svg') != null || !shown(leaf)) continue;
        if (overlap(hr, leaf.getBoundingClientRect())) cards.push(`${order}: the chat button covers ${describe(leaf)}`);
      }
    }
  }

  return { viewport: { width: vw, height: vh }, titleBar, hit, overflow, small, loading: [...loadingTexts], cards };
}

// ----------------------------------------------------------------- capturing

function watchConsole(app: ElectronApplication, label: string): void {
  const attach = (page: Page): void => {
    const name = `${label}:${app.windows().indexOf(page)}`;
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push({ at: Date.now(), page: name, text: message.text().slice(0, 300) });
    });
    page.on('pageerror', (error) => consoleErrors.push({ at: Date.now(), page: name, text: `uncaught: ${error.message.slice(0, 300)}` }));
  };
  app.windows().forEach(attach);
  app.on('window', attach);
}

async function cdpOf(page: Page): Promise<CDPSession> {
  const known = cdps.get(page);
  if (known) return known;
  const cdp = await page.context().newCDPSession(page);
  cdps.set(page, cdp);
  return cdp;
}

async function emulate(page: Page, size: Size): Promise<void> {
  const cdp = await cdpOf(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
  await page.waitForFunction(({ width, height }) => window.innerWidth === width && window.innerHeight === height, size, { timeout: 5_000 });
}

async function unemulate(page: Page): Promise<void> {
  await (await cdpOf(page)).send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
}

interface PrefsBridge { ordewell: { prefs: { set(key: string, value: string): Promise<unknown> } } }

/**
 * Playwright pins an Electron page's prefers-color-scheme to light, which hides
 * nativeTheme: the pref still goes through main, for what main draws and
 * broadcasts, and the page's media follows it by emulation.
 */
async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate(async (t) => { await (window as unknown as PrefsBridge).ordewell.prefs.set('theme', t); }, theme);
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForFunction((t) => window.matchMedia('(prefers-color-scheme: light)').matches === (t === 'light'), theme, { timeout: 5_000 });
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.waitForTimeout(ms);
}

function pngSize(buffer: Buffer): Size {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function limited(items: readonly string[], max = 15): string[] {
  const unique = [...new Set(items)];
  return unique.length > max ? [...unique.slice(0, max), `… and ${unique.length - max} more`] : unique;
}

function judge(raw: PageChecks, errors: readonly ConsoleError[], lift: LiftResult): Check[] {
  const check = (id: CheckId, problems: readonly string[], details?: string[]): Check =>
    ({ id, name: CHECK_NAMES[id], pass: problems.length === 0, count: new Set(problems).size, details: details ?? limited(problems) });
  return [
    check('a', raw.titleBar.present ? raw.titleBar.problems : [], raw.titleBar.present ? limited(raw.titleBar.problems) : ['no title bar in this window']),
    check('b', raw.hit.failures),
    check('c', raw.overflow),
    check('d', raw.small.failures),
    check('e', raw.loading),
    check('f', errors.map((e) => `${e.page}: ${e.text}`)),
    check('h', raw.cards),
    // A passing lift check keeps what it measured, so the report shows how far each card stands off.
    check('i', lift.problems, lift.problems.length ? undefined : limited(lift.measured)),
  ];
}

/**
 * How much of a chat's width its longest message and its composer use. The
 * chat's width is its scrolling body's inner box: the box the messages and the
 * composer are meant to fill, whatever gutter they keep.
 */
async function chatFill(chat: Locator, parts: { body: string; composer: string }): Promise<Check> {
  const probe = await chat.evaluate((root, selectors) => {
    const box = (el: Element | null): { width: number } | undefined => (el ? { width: el.getBoundingClientRect().width } : undefined);
    const width = root.querySelector(selectors.body)?.clientWidth ?? 0;
    let longest: Element | undefined;
    for (const el of root.querySelectorAll('.chat-msg-bubble .chat-msg-content')) {
      if (!longest || (el.textContent ?? '').length > (longest.textContent ?? '').length) longest = el;
    }
    return { width, message: box(longest ?? null), messageChars: (longest?.textContent ?? '').length, composer: box(root.querySelector(selectors.composer)) };
  }, parts);
  const problems: string[] = [];
  if (probe.width < 1) problems.push(`the chat's body (${parts.body}) has no width`);
  if (!probe.message) problems.push('no message in the chat');
  else if (probe.message.width < probe.width * CHAT_FILL) problems.push(`the longest message (${probe.messageChars} chars) is ${Math.round(probe.message.width)}px wide in a ${probe.width}px chat`);
  if (!probe.composer) problems.push(`no composer (${parts.composer})`);
  else if (probe.composer.width < probe.width * CHAT_FILL) problems.push(`the composer is ${Math.round(probe.composer.width)}px wide in a ${probe.width}px chat`);
  return { id: 'g', name: CHECK_NAMES.g, pass: problems.length === 0, count: problems.length, details: problems };
}

/** Polls until no loading text shows, for at most the grace period; the shots then judge what is left. */
async function waitForLoading(page: Page): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < LOADING_GRACE_MS) {
    const raw = await page.evaluate(inPageChecks, LOADING_WORDS);
    if (raw.loading.length === 0) break;
    await page.waitForTimeout(500);
  }
  return Date.now() - start;
}

interface CaptureOptions {
  /** Puts back what a resize or a theme change may close, such as a popover. */
  readonly ensure?: () => Promise<void>;
  /** A check of this state's own, judged on the shots it applies to (undefined skips the size). */
  readonly measure?: (size: Size) => Promise<Check | undefined>;
}

async function capture(page: Page, record: StateRecord, started: number, options: CaptureOptions = {}): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  record.loadingSettledMs = await waitForLoading(page);
  try {
    for (const theme of THEMES) {
      await setTheme(page, theme);
      for (const size of SIZES) {
        await emulate(page, size);
        await settle(page);
        if (options.ensure) { await options.ensure(); await settle(page, 200); }
        const { data } = await (await cdpOf(page)).send('Page.captureScreenshot', { format: 'png' });
        const buffer = Buffer.from(data, 'base64');
        const file = `${record.id}--${theme}--${size.width}x${size.height}.png`;
        fs.writeFileSync(path.join(OUT, file), buffer);
        const raw = await page.evaluate(inPageChecks, LOADING_WORDS);
        const lift = await page.evaluate(liftChecks, { selectors: CARD_SELECTORS, liftMin: LIFT_MIN, textMin: TEXT_MIN });
        const png = pngSize(buffer);
        if (png.width !== size.width || png.height !== size.height) record.notes.push(`${file} came out ${png.width}x${png.height}`);
        const extra = await options.measure?.(size);
        record.shots.push({ file, theme, ...size, png, checks: [...judge(raw, consoleErrors.filter((e) => e.at >= started), lift), ...(extra ? [extra] : [])] });
      }
    }
  } finally {
    await unemulate(page);
  }
}

/**
 * One state of the tour: `reach` drives the app there, then every theme and
 * size is captured. A state that cannot be reached is recorded with why, and
 * the tour moves on to the next one.
 */
async function state(page: Page | undefined, id: string, title: string, reach: (record: StateRecord) => Promise<void>, options?: CaptureOptions): Promise<StateRecord> {
  const record: StateRecord = { id, title, reached: false, notes: [], shots: [] };
  states.push(record);
  const started = Date.now();
  try {
    if (!page) throw new Error('no window to draw this state in');
    await reach(record);
    record.reached = true;
    await capture(page, record, started, options);
  } catch (error) {
    record.error = error instanceof Error ? error.message.split('\n').slice(0, 6).join('\n') : String(error);
    if (page) {
      fs.mkdirSync(path.join(OUT, 'unreached'), { recursive: true });
      await page.screenshot({ path: path.join(OUT, 'unreached', `${id}.png`) }).catch(() => undefined);
    }
  }
  return record;
}

/** Banner titles and the status bar's text, sampled for `ms`: what a user sees come and go. */
async function sampleChrome(page: Page, ms: number): Promise<string[]> {
  const seen: string[] = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const now = await page.evaluate(() => {
      const banners = [...document.querySelectorAll('section h2')].map((h) => h.textContent ?? '');
      const status = document.querySelector('[role="contentinfo"]')?.textContent ?? '';
      return `banners: [${banners.join(' | ')}] status: ${status.replace(/\s+/g, ' ').trim()}`;
    }).catch((error: unknown) => `unreadable: ${String(error)}`);
    if (seen.at(-1) !== now) seen.push(now);
    await page.waitForTimeout(250);
  }
  return seen;
}

async function stubDialogs(app: ElectronApplication): Promise<void> {
  // A native message box cannot be clicked from here: main answers the first
  // button (confirm, or quit anyway), and keeps what it was asked.
  await app.evaluate(({ dialog }) => {
    const asked: string[] = [];
    (globalThis as unknown as { tourAsked: string[] }).tourAsked = asked;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.find((a): a is { message?: unknown; detail?: unknown } => typeof a === 'object' && a !== null && 'message' in a);
      asked.push(`${String(options?.message ?? '')} — ${String(options?.detail ?? '')}`);
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
}

async function dialogsAsked(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { tourAsked?: string[] }).tourAsked ?? []);
}

function pidOfDaemon(home: string, port: number): number | undefined {
  for (const name of [`server-${port}.pid`, 'server.pid']) {
    const file = path.join(home, '.ordewell', name);
    if (fs.existsSync(file)) {
      const pid = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  }
  return undefined;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function startDaemon(box: Sandbox, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, [path.join(ROOT, 'packages/web/dist/server/main.js'), '--port', String(port), '--pid-file', path.join(box.home, '.ordewell', `server-${port}.pid`)], {
    env: appEnv(box, port, 0, { noProvider: true }),
    cwd: box.tmp,
    stdio: 'ignore',
  });
  daemons.push(child);
  ports.push(port);
  if (!await untilListening(port, true)) throw new Error(`the daemon on ${port} never listened`);
  return child;
}

async function daemonCall(box: Sandbox, port: number, method: 'GET' | 'POST', route: string): Promise<unknown> {
  const token = fs.readFileSync(path.join(box.home, '.ordewell', `server-${port}.token`), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Authorization: `Bearer ${token}` } });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

/** The workspace window, whether the app reopened it or the welcome window has to. */
async function workspaceWindow(app: ElectronApplication, dir: string): Promise<Page> {
  const welcome = await app.firstWindow();
  await welcome.waitForLoadState('domcontentloaded');
  await welcome.waitForTimeout(1_500);
  for (const page of app.windows()) {
    if (await page.getByRole('navigation', { name: 'Views' }).count() > 0) return page;
  }
  return openFolder(app, welcome, dir);
}

// --------------------------------------------------------------------- probes

async function titleBarProblems(page: Page): Promise<string[]> {
  return (await page.evaluate(inPageChecks, LOADING_WORDS)).titleBar.problems;
}

/**
 * Runs in the renderer: every way a plan-list card leaves the plan panel's
 * content box, or cuts what it shows with no way to read the rest. A scroller
 * (a code block, the prompt's editor) keeps what it holds reachable, so only
 * its own box is held to the panel; a truncation is fine with an ellipsis and
 * a tooltip that says it all.
 */
function cardOverflow(): string[] {
  const body = document.querySelector('.frame-plan-body');
  if (!body) return ['the plan panel is not drawn'];
  const style = getComputedStyle(body);
  const outer = body.getBoundingClientRect();
  const left = outer.left + body.clientLeft + parseFloat(style.paddingLeft);
  const right = outer.left + body.clientLeft + body.clientWidth - parseFloat(style.paddingRight);
  const px = (n: number): number => Math.round(n);
  const describe = (el: Element): string => {
    const cls = typeof el.className === 'string' && el.className.trim() !== '' ? `.${el.className.trim().split(/\s+/)[0]}` : '';
    const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${cls} "${name}"`;
  };
  const problems: string[] = [];
  const cards = [...body.querySelectorAll('.task-card')];
  if (cards.length === 0) problems.push('no task card is drawn');
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const name = card.querySelector('.task-heading')?.getAttribute('aria-label')?.split(',')[0] ?? describe(card);
    if (box.left < left - 0.5 || box.right > right + 0.5) problems.push(`${name}: the card spans ${px(box.left)}–${px(box.right)}, past the panel's ${px(left)}–${px(right)}`);
    const from = Math.max(left, box.left);
    const to = Math.min(right, box.right);
    const walk = (el: Element, clipped: boolean): void => {
      for (const child of el.children) {
        if (!child.checkVisibility({ checkVisibilityCSS: true })) continue;
        const r = child.getBoundingClientRect();
        // A visually hidden label is a 1px box that clips on purpose.
        if (r.width <= 1 || r.height <= 1) continue;
        const s = getComputedStyle(child);
        if (!clipped && (r.left < from - 0.5 || r.right > to + 0.5)) {
          problems.push(`${name}: ${describe(child)} spans ${px(r.left)}–${px(r.right)}, past ${px(from)}–${px(to)}`);
        }
        const scroller = s.overflowX === 'auto' || s.overflowX === 'scroll';
        if (scroller) continue;
        const over = child.clientWidth > 0 && child.scrollWidth > child.clientWidth + 1;
        if (over && s.overflowX !== 'visible') {
          if (s.textOverflow !== 'ellipsis') problems.push(`${name}: ${describe(child)} is clipped (${child.scrollWidth}px in ${child.clientWidth}px)`);
          else if (!child.closest('[title]') || !card.contains(child.closest('[title]'))) problems.push(`${name}: ${describe(child)} is cut to an ellipsis with no tooltip`);
        } else if (over) {
          problems.push(`${name}: ${describe(child)}'s content spills (${child.scrollWidth}px in ${child.clientWidth}px)`);
        }
        // What overflows a clipping box is reported once, on that box.
        walk(child, clipped || (over && s.overflowX !== 'visible'));
      }
    };
    walk(card, false);
  }
  return problems;
}

const fitFailures: string[] = [];

/** Sets a pane to `size` exactly: Home takes it to its minimum, then a drag of the difference (a drag moves the sash by the pointer's travel). */
async function setPane(page: Page, label: string, size: number): Promise<string | undefined> {
  const sash = page.getByRole('separator', { name: label });
  if (await sash.count() === 0) return undefined;
  await sash.focus();
  await page.keyboard.press('Home');
  const min = Number(await sash.getAttribute('aria-valuenow'));
  const box = await sash.boundingBox();
  if (size !== min && box) {
    // The plan panel grows leftwards.
    const dx = (size - min) * (label === 'Resize plan panel' ? -1 : 1);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 8 });
    await page.mouse.up();
  }
  const now = Number(await sash.getAttribute('aria-valuenow'));
  return now === size ? undefined : `${label} was asked for ${size}px and is ${now}px`;
}

/**
 * The plan cards at the panel's minimum and default widths at every tour
 * size, then in the drawer a narrow window opens instead. What it finds fails
 * the tour under TOUR_STRICT.
 */
async function planCardFit(page: Page, where: string): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  const measure = async (key: string, preset: (string | undefined)[]): Promise<void> => {
    await settle(page, 200);
    const found = [...preset.filter((p): p is string => p !== undefined), ...await page.evaluate(cardOverflow)];
    result[key] = found;
    fitFailures.push(...found.map((f) => `${where} ${key}: ${f}`));
  };
  for (const size of SIZES) {
    await emulate(page, size);
    await settle(page);
    if (await page.getByRole('button', { name: 'Expand the plan panel' }).isVisible()) await page.getByRole('button', { name: 'Expand the plan panel' }).click();
    const defaults = bandDefaults(size.width);
    const sidebar = await setPane(page, 'Resize sidebar', defaults.sidebar);
    for (const [name, width] of [['minimum', paneBounds('plan', size).min], ['default', defaults.plan]] as const) {
      await measure(`${size.width}x${size.height}, plan panel at its ${name} ${width}px`, [sidebar, await setPane(page, 'Resize plan panel', width)]);
    }
  }
  await emulate(page, NARROW);
  await settle(page);
  await page.getByRole('button', { name: 'Show the plan' }).click();
  await expect(page.locator('.frame-drawer-right')).toBeVisible();
  await measure(`${NARROW.width}x${NARROW.height}, the plan drawer`, []);
  await page.getByRole('button', { name: 'Close the plan' }).click();
  await unemulate(page);
  return result;
}

async function sashProbe(page: Page): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  await emulate(page, SIZES[0]);
  await settle(page);
  result.before = await titleBarProblems(page);
  const separators: Record<string, number> = { 'Resize sidebar': 900, 'Resize plan panel': -900 };
  for (const [label, dx] of Object.entries(separators)) {
    const sash = page.getByRole('separator', { name: label });
    const box = await sash.boundingBox();
    if (!box) { result[`${label}: drag`] = 'the separator is not on screen'; continue; }
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 12 });
    await page.mouse.up();
    await settle(page);
    result[`${label}: after drag`] = {
      valueNow: await sash.getAttribute('aria-valuenow'),
      titleBar: await titleBarProblems(page),
    };
  }
  // The keyboard reaches each pane's maximum exactly, which a drag can stop short of.
  for (const label of Object.keys(separators)) {
    const sash = page.getByRole('separator', { name: label });
    if (await sash.count() === 0) continue;
    await sash.focus();
    await page.keyboard.press('End');
  }
  await settle(page);
  result.afterEnd = {
    sidebar: await page.getByRole('separator', { name: 'Resize sidebar' }).getAttribute('aria-valuenow').catch(() => null),
    plan: await page.getByRole('separator', { name: 'Resize plan panel' }).getAttribute('aria-valuenow').catch(() => null),
    titleBar: await titleBarProblems(page),
  };
  await unemulate(page);
  return result;
}

async function graphProbe(page: Page, graph: Locator): Promise<Record<string, unknown>> {
  await emulate(page, SIZES[0]);
  await settle(page);
  // The graph scrolls; it neither zooms nor pans (design W5), so its scroll position is all a gesture can change.
  const scroll = (): Promise<{ left: number; top: number }> => graph.evaluate((el) => ({ left: Math.round(el.scrollLeft), top: Math.round(el.scrollTop) }));
  const result: Record<string, unknown> = {};
  result.chips = await page.locator('.graph-stage-chip').evaluateAll((chips) => chips.map((c) => ({
    name: c.getAttribute('aria-label') ?? '',
    inView: c.getAttribute('data-in-view') === 'true',
    current: c.getAttribute('aria-current') === 'location',
  })));
  result.cards = await graph.locator('.graph-card').evaluateAll((cards) => cards.map((card) => {
    const face = card.querySelector('.graph-card-face') as HTMLElement | null;
    const r = (face ?? card).getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      label: face?.getAttribute('aria-label') ?? '',
      tabIndex: face?.tabIndex ?? null,
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      hit: !!at && !!face && (at === face || face.contains(at)),
    };
  }));
  result.edges = await graph.locator('.graph-edge').count();
  const box = await graph.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const start = await scroll();
    await page.mouse.wheel(0, 240);
    await settle(page, 300);
    result.wheel = { before: start, after: await scroll() };
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, 240);
    await page.keyboard.up('Shift');
    await settle(page, 600);
    result.shiftWheel = await scroll();
    await page.mouse.move(box.x + 20, box.y + box.height - 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 140, box.y + box.height - 60, { steps: 8 });
    await page.mouse.up();
    await settle(page, 300);
    result.drag = await scroll();
  }
  const previous = page.getByRole('button', { name: 'Previous stage' });
  if (await previous.isEnabled()) await previous.click();
  await settle(page, 600);
  result.previousStage = await scroll();
  const first = graph.locator('.graph-card-face[tabindex="0"]');
  await first.focus().catch(() => undefined);
  const keys: { key: string; focused: string }[] = [];
  for (const key of ['ArrowRight', 'Escape', 'ArrowDown', 'End', 'Home']) {
    await page.keyboard.press(key);
    await settle(page, 100);
    keys.push({ key, focused: await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? '') });
  }
  result.keyboard = keys;
  await unemulate(page);
  return result;
}

// ---------------------------------------------------------------------- output

function writeReport(): void {
  fs.mkdirSync(OUT, { recursive: true });
  const failing: Record<CheckId, number> = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0, i: 0 };
  for (const record of states) for (const shot of record.shots) for (const c of shot.checks) if (!c.pass) failing[c.id] += 1;
  const report = {
    generatedAt: new Date().toISOString(),
    strict: STRICT,
    sizes: SIZES,
    themes: THEMES,
    checks: CHECK_NAMES,
    summary: {
      states: states.length,
      reached: states.filter((s) => s.reached).length,
      unreached: states.filter((s) => !s.reached).map((s) => ({ id: s.id, error: s.error })),
      shots: states.reduce((n, s) => n + s.shots.length, 0),
      failingShotsByCheck: failing,
    },
    states,
    probes,
    consoleErrors,
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  const escape = (text: string): string => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  const sections = states.map((record) => {
    const figures = record.shots.map((shot) => {
      const bad = shot.checks.filter((c) => !c.pass);
      const badges = bad.map((c) => `<li title="${escape(c.details.join('\n'))}"><b>${c.id}</b> ${escape(c.name)} (${c.count})</li>`).join('');
      return `<figure class="${shot.theme}"><a href="${escape(shot.file)}"><img loading="lazy" src="${escape(shot.file)}" alt="${escape(`${record.title}, ${shot.theme}, ${shot.width}x${shot.height}`)}"></a>`
        + `<figcaption>${shot.theme} · ${shot.width}x${shot.height}${bad.length ? `<ul>${badges}</ul>` : ' · all checks pass'}</figcaption></figure>`;
    }).join('');
    const notes = record.notes.map((n) => `<li>${escape(n)}</li>`).join('');
    const error = record.error ? `<p class="error">Not reached: ${escape(record.error)}</p>` : '';
    return `<section id="${escape(record.id)}"><h2>${escape(record.title)} <code>${escape(record.id)}</code></h2>${error}${notes ? `<ul class="notes">${notes}</ul>` : ''}<div class="grid">${figures}</div></section>`;
  }).join('\n');
  const nav = states.map((s) => `<a href="#${escape(s.id)}"${s.reached ? '' : ' class="error"'}>${escape(s.id)}</a>`).join(' ');
  fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Ordewell desktop tour</title><style>
body{font:13px/1.4 system-ui,sans-serif;margin:24px;background:#f4f4f5;color:#18181b}
nav{position:sticky;top:0;background:#f4f4f5;padding:8px 0;border-bottom:1px solid #d4d4d8}
nav a{margin-right:8px}
section{margin:32px 0}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
figure{margin:0;background:#fff;border:1px solid #e4e4e7;border-radius:6px;padding:6px}
figure.dark{background:#27272a;color:#e4e4e7}
img{width:100%;display:block;border-radius:3px}
figcaption ul{margin:4px 0 0;padding-left:16px;color:#b91c1c}
figure.dark figcaption ul{color:#fca5a5}
.error{color:#b91c1c}
</style></head><body><h1>Ordewell desktop tour</h1><p>${new Date().toISOString()} · ${STRICT ? 'strict' : 'report only'} · checks: ${Object.entries(CHECK_NAMES).map(([id, name]) => `<b>${id}</b> ${escape(name)}`).join('; ')}</p><nav>${nav}</nav>\n${sections}</body></html>\n`);
}

// ----------------------------------------------------------------------- tour

test.beforeAll(() => {
  fs.rmSync(OUT, { recursive: true, force: true });
});

test.afterAll(async () => {
  for (const app of apps) {
    await stubDialogs(app).catch(() => undefined);
    await app.close().catch(() => undefined);
  }
  for (const daemon of daemons) daemon.kill('SIGKILL');
  mock?.kill();
  for (const port of ports) await untilListening(port, false);
  if (sandbox) removeSandbox(sandbox);
});

test('the visual tour', async () => {
  const box = makeSandbox('ordewell-desktop-tour-');
  sandbox = box;
  const holdFile = path.join(box.tmp, 'hold-planner');
  const started = await startMock(['--hold-file', holdFile]);
  mock = started.process;

  // Recents as a returning user has them: this repository, another project, and one since deleted.
  const other = path.join(box.tmp, 'another-project');
  fs.mkdirSync(other);
  fs.mkdirSync(box.userData, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(box.userData, 'recents.json'), JSON.stringify({
    version: 1,
    entries: [
      { path: box.repo, openedAt: new Date(now - 3_600_000).toISOString() },
      { path: other, openedAt: new Date(now - 86_400_000).toISOString() },
      { path: path.join(box.tmp, 'deleted-project'), openedAt: new Date(now - 7 * 86_400_000).toISOString() },
    ],
  }));

  // ------------------------------------------------------------ first launch
  const ownedPort = await freePort();
  // The tour's plan adds cards with long model names behind the e2e plan's two, for the graph's captures.
  const app = await launchApp(box, appEnv(box, ownedPort, started.port, { persona: 'desktop-tour' }));
  apps.push(app);
  ports.push(ownedPort);
  watchConsole(app, 'launch 1');
  const welcome = await app.firstWindow();

  await state(welcome, 'welcome', 'Welcome window, with recents and the runner check done', async () => {
    await expect(welcome.locator('.welcome-runner[data-state]').first().or(welcome.getByText('The daemon did not list its runners'))).toBeVisible({ timeout: 60_000 });
    // Each live card has its branch and last session from the daemon, so the capture holds no skeletons.
    await expect(welcome.locator('.welcome-recent[data-path]')).toHaveCount(3);
    await expect(welcome.locator('.welcome-recent[data-state="loading"]')).toHaveCount(0, { timeout: 30_000 });
    await expect(welcome.locator('.welcome-recent[data-state="missing"]')).toHaveCount(1);
  });

  const win = await openFolder(app, welcome, box.repo).catch(() => undefined);
  const views = win?.getByRole('navigation', { name: 'Views' });
  const editor = win?.getByRole('main', { name: 'Centre' });
  const planPanel = win?.getByRole('complementary', { name: 'Plan', exact: true });
  const changes = win?.getByRole('navigation', { name: 'Changes' });
  // The planner tab's approval card offers the same Approve: the title bar's is the frame's one.
  const approve = win?.locator('header.frame-title').getByRole('button', { name: 'Approve plan' });
  const graphTab = async (): Promise<Locator> => {
    const tab = need(editor).getByRole('tab', { name: /Plan graph/ });
    if (await tab.count() > 0) await tab.click();
    else await need(planPanel).getByRole('button', { name: 'Open the plan graph' }).click();
    return need(editor).getByRole('grid', { name: 'Plan graph' });
  };
  const need = <T>(value: T | undefined): T => { if (value === undefined) throw new Error('the workspace window did not open'); return value; };

  await state(win, 'planning', 'Session while planning', async (record) => {
    const page = need(win);
    await expect(page.getByRole('contentinfo')).toContainText('Claude Code', { timeout: 60_000 });
    fs.writeFileSync(holdFile, '');
    await page.getByRole('button', { name: 'New session' }).click();
    const box2 = page.getByRole('textbox', { name: 'Message the planner' });
    await box2.fill(GOAL);
    await box2.press('Enter');
    // The mock has streamed its reasoning and holds the answer while the file exists.
    await page.waitForTimeout(2_500);
    record.notes.push('the planner turn is held open by the mock provider\'s --hold-file until the captures are done');
  });
  fs.rmSync(holdFile, { force: true });

  await state(win, 'plan-approval', 'Plan approval', async () => {
    await expect(need(approve)).toBeVisible({ timeout: 90_000 });
  });

  await state(win, 'run-list', 'Run in progress: the planner, with the plan panel beside it', async () => {
    const page = need(win);
    await need(approve).click();
    await expect(need(planPanel).getByRole('button', { name: 'Add a greeting module' })).toBeVisible({ timeout: 60_000 });
    await settle(page, 1_000);
  });

  await state(win, 'run-graph', 'The same run, in the plan graph tab', async () => {
    const page = need(win);
    const graph = await graphTab();
    await expect(graph.getByRole('button', { name: /^#1 Add a greeting module, running/ })).toBeVisible({ timeout: 60_000 });
    await settle(page, 600);
    probes.graphNavigation = await graphProbe(page, graph);
    // The probe scrolled the view: bring the first stage back, as a fresh open shows it.
    await graph.evaluate((el) => el.scrollTo({ left: 0, top: 0 }));
    await expect(graph.locator('.graph-card').first()).toBeVisible();
  });

  await state(win, 'graph-reveal', 'A graph card clicked: its task opens in the plan panel', async () => {
    const graph = await graphTab();
    const tabs = need(editor).getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab');
    const opened = await tabs.count();
    await graph.getByRole('button', { name: /^#1 Add a greeting module, / }).click();
    await expect(need(planPanel).getByRole('button', { name: /^#1 Add a greeting module, / })).toHaveAttribute('aria-expanded', 'true');
    await expect(tabs).toHaveCount(opened);
  });

  await state(win, 'task-details', 'Task Details', async () => {
    // Only a card's Open chat opens the task's tab; Details is a view of it.
    const card = need(planPanel).locator('.task-card').filter({ has: need(win).getByRole('button', { name: /^#1 Add a greeting module, / }) });
    await card.getByRole('button', { name: 'Open chat' }).click();
    await expect(need(editor).getByRole('heading', { name: '#1 Add a greeting module' })).toBeVisible();
    await need(editor).getByRole('tablist', { name: 'Task view' }).getByRole('tab', { name: 'Details' }).click();
  });

  await state(win, 'task-chat', 'Task Chat', async () => {
    await need(editor).getByRole('tablist', { name: 'Task view' }).getByRole('tab', { name: 'Chat' }).click();
    await need(win).waitForTimeout(1_000);
  });

  // The chats with the plan panel closed, so the tab is all the room the chat has (checklist L7).
  const planClosed = async (): Promise<void> => {
    const page = need(win);
    const collapse = page.getByRole('button', { name: 'Collapse the plan panel' });
    if (await collapse.isVisible().catch(() => false)) await collapse.click();
  };
  const fullSize = (size: Size): boolean => size.width === 1920 && size.height === 1080;
  await state(win, 'task-chat-full-width', 'Task Chat across the whole tab, plan panel closed', async () => {
    await planClosed();
    await expect(need(editor).locator('.task-log-container .chat-msg-content').first()).toBeVisible({ timeout: 30_000 });
  }, {
    ensure: planClosed,
    measure: async (size) => fullSize(size)
      ? chatFill(need(editor).locator('.session-task-chat'), { body: '.task-log-body', composer: '.task-log-input' })
      : undefined,
  });

  await state(win, 'planner-chat-full-width', 'Planner chat across the whole tab, plan panel closed', async () => {
    await planClosed();
    await need(editor).getByRole('tab', { name: 'Planner' }).click();
    await expect(need(editor).locator('.chat-layout-conversation .message-list .chat-msg-content').first()).toBeVisible({ timeout: 30_000 });
  }, {
    ensure: planClosed,
    measure: async (size) => fullSize(size)
      ? chatFill(need(editor).locator('.chat-layout-conversation'), { body: '.message-list', composer: '.chat-input textarea' })
      : undefined,
  });
  await need(win).getByRole('button', { name: 'Expand the plan panel' }).click().catch(() => undefined);

  await state(win, 'explorer-file', 'Explorer with a file open', async () => {
    const page = need(win);
    await need(views).getByRole('tab', { name: 'Explorer' }).click();
    await page.getByRole('button', { name: 'Your checkout', exact: true }).click();
    await page.getByRole('menuitemradio', { name: /Task #1 worktree/ }).click();
    const tree = page.getByRole('tree', { name: 'Files in Task #1' });
    await tree.getByRole('treeitem', { name: /^src/ }).click();
    const file = tree.getByRole('treeitem', { name: /greeting\.ts/ });
    await expect(file).toBeVisible({ timeout: 30_000 });
    await file.dblclick();
    await expect(need(editor).locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 });
    await settle(page, 800);
  });

  await state(win, 'changes-comment', 'Changes: a task diff with a line comment', async () => {
    const page = need(win);
    await need(views).getByRole('tab', { name: 'Changes' }).click();
    const taskOne = need(changes).getByRole('region', { name: 'Task #1: Add a greeting module' });
    await taskOne.getByRole('button', { name: /greeting\.ts/ }).click({ timeout: 60_000 });
    const diff = page.getByTestId('monaco-diff-host');
    await expect(diff).toBeVisible();
    await diff.locator('.editor.modified .view-line').filter({ hasText: 'greeting' }).first().click();
    await page.getByRole('button', { name: 'Comment to task #1' }).click();
    await page.getByRole('textbox', { name: 'Comment to task #1' }).fill(COMMENT);
  });
  await need(win).getByRole('button', { name: 'Send to task #1' }).click().catch(() => undefined);

  await state(win, 'needs-you', 'Needs you popover with an approval', async () => {
    const page = need(win);
    await expect(page.getByRole('button', { name: 'Needs you, 1' })).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: 'Needs you, 1' }).click();
    await expect(page.getByRole('dialog', { name: 'Needs you' })).toBeVisible();
  }, {
    ensure: async () => {
      const page = need(win);
      if (await page.getByRole('dialog', { name: 'Needs you' }).isVisible()) return;
      await page.getByRole('button', { name: /^Needs you/ }).click();
    },
  });

  // The rest of the run: answer the checkpoint, and let task #2 pass.
  await (async () => {
    const page = need(win);
    // The popover and the Sessions sidebar each list the item; answer it where the sidebar shows it.
    await page.keyboard.press('Escape');
    const sessions = page.getByRole('navigation', { name: 'Sessions' });
    if (!await sessions.isVisible()) await need(views).getByRole('tab', { name: /^Sessions/ }).click();
    await sessions.getByRole('button', { name: 'Approve: #2 Add a farewell module' }).click();
    const graph = await graphTab();
    await expect(graph.getByRole('button', { name: /^#2 Add a farewell module, waiting for merge/ })).toBeVisible({ timeout: 90_000 });
    await expect(sessions.getByRole('button', { name: /Merge all: / })).toBeVisible({ timeout: 60_000 });
  })().catch((error: unknown) => { probes.runFinish = `the run did not finish: ${String(error)}`; });

  // Every kind of card at once, the tour plan's long model names among them, in each density.
  const density = (name: 'Comfortable' | 'Compact') => need(editor).getByRole('group', { name: 'Density' }).getByRole('button', { name });
  await state(win, 'graph-cards', 'The plan graph with every kind of card, Comfortable', async () => {
    const page = need(win);
    const graph = await graphTab();
    await density('Comfortable').click();
    await expect(graph.getByRole('button', { name: /^#3 Port the tokenizer/ })).toBeVisible({ timeout: 30_000 });
    await settle(page, 600);
  });

  await state(win, 'graph-cards-compact', 'The plan graph with every kind of card, Compact', async () => {
    const page = need(win);
    await graphTab();
    await density('Compact').click();
    await settle(page, 600);
  });
  await density('Comfortable').click().catch(() => undefined);

  await state(win, 'checkout-commit', 'Checkout changes with the commit box', async () => {
    const page = need(win);
    fs.appendFileSync(path.join(box.repo, 'README.md'), '\nA line written in the checkout.\n');
    fs.writeFileSync(path.join(box.repo, 'NOTES.md'), '# notes\n');
    await need(views).getByRole('tab', { name: 'Changes' }).click();
    await need(changes).getByRole('button', { name: 'Refresh changes' }).first().click().catch(() => undefined);
    const message = page.getByRole('textbox', { name: /^Commit message for/ });
    await expect(message).toBeVisible({ timeout: 30_000 });
    await expect(need(changes).getByText('NOTES.md').first()).toBeVisible({ timeout: 30_000 });
    await message.fill('Note what the checkout is for');
  });

  await state(win, 'git-graph', 'Git commit graph', async () => {
    const page = need(win);
    await need(views).getByRole('tab', { name: 'Git' }).click();
    await page.getByRole('navigation', { name: 'Git' }).getByRole('button', { name: 'Show the commit graph', exact: true }).first().click();
    await expect(page.getByRole('list', { name: 'Commits' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('list', { name: 'Commits' }).getByRole('button').first().click();
  });

  await state(win, 'terminal', 'Terminal open', async () => {
    const page = need(win);
    await need(views).getByRole('tab', { name: /^Sessions/ }).click();
    await page.keyboard.press('Control+Backquote');
    await expect(page.getByRole('tablist', { name: 'Terminals' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('.xterm').first().click();
    await page.keyboard.type('git log --oneline -3\n');
    await settle(page, 1_000);
  });

  await state(win, 'settings', 'Settings, grouped in sections with Theme first', async () => {
    const page = need(win);
    if (await page.getByRole('tablist', { name: 'Terminals' }).isVisible()) await page.keyboard.press('Control+Backquote');
    await page.getByRole('button', { name: /^Settings/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Run', exact: true })).toBeVisible({ timeout: 30_000 });
  });

  await state(win, 'squeezed', 'Squeezed: sidebar and plan panel at their maximum widths', async (record) => {
    const page = need(win);
    if (await page.getByRole('tablist', { name: 'Terminals' }).isVisible()) await page.keyboard.press('Control+Backquote');
    if (!await page.getByRole('navigation', { name: 'Sessions' }).isVisible()) await need(views).getByRole('tab', { name: /^Sessions/ }).click();
    probes.sashDrag = await sashProbe(page);
    record.notes.push('panes were dragged at 1280x800, then set to their maximum with End on each separator');
  });

  await state(win, 'plan-card-fit', 'The widest plan cards, expanded, at the plan panel\'s minimum width', async (record) => {
    const page = need(win);
    const panel = need(planPanel);
    // A finished task: its handoff, its badges and Open chat.
    const farewell = panel.getByRole('button', { name: /^#2 Add a farewell module, / });
    if (await farewell.getAttribute('aria-expanded') !== 'true') await farewell.click();
    // A `has` locator is resolved inside each card, so it is rooted at the page, not at the panel.
    const done = panel.locator('.task-card').filter({ has: page.getByRole('button', { name: /^#2 Add a farewell module, / }) });
    for (const fold of ['Prompt', 'Handoff']) await done.getByRole('button', { name: new RegExp(`^${fold}`) }).click();
    probes.planCardFitRun = await planCardFit(page, 'the run\'s #2');

    // A draft at its widest: long titles, a long model and its effort, every badge, the edit controls.
    // The window is narrow enough here that the sidebar is a drawer, over the editor, and the planner a tab behind others.
    if (!await page.getByRole('navigation', { name: 'Sessions' }).isVisible()) await need(views).getByRole('tab', { name: /^Sessions/ }).click();
    await page.getByRole('button', { name: 'New session' }).click();
    if (await page.locator('.frame-drawer').isVisible()) await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+L');
    const box2 = page.getByRole('textbox', { name: 'Message the planner' });
    await box2.fill(FIT_GOAL);
    await box2.press('Enter');
    const widest = panel.getByRole('button', { name: /^#2 Find why the session lease heartbeat/ });
    await expect(widest).toBeVisible({ timeout: 60_000 });
    await widest.click();
    await panel.locator('.task-card').filter({ has: page.getByRole('button', { name: /^#2 Find why the session lease heartbeat/ }) }).getByRole('button', { name: /^Prompt/ }).click();
    probes.planCardFitDraft = await planCardFit(page, 'the draft\'s #2');
    // The capture is the narrowest docked panel, where a card has the least room.
    await emulate(page, SIZES[0]);
    await setPane(page, 'Resize plan panel', paneBounds('plan', SIZES[0]).min);
    await unemulate(page);
    record.notes.push(`plan cards measured at the panel's minimum and default widths at every size, and in the ${NARROW.width}px drawer: ${fitFailures.length} problems`);
  });

  probes.activityBar = win ? await win.evaluate(() => [...document.querySelectorAll('nav[aria-label="Views"] button')].map((b) => {
    const r = b.getBoundingClientRect();
    const icon = b.querySelector('svg')?.getBoundingClientRect();
    return { name: b.getAttribute('aria-label') ?? b.textContent ?? '', button: `${Math.round(r.width)}x${Math.round(r.height)}`, icon: icon ? `${Math.round(icon.width)}x${Math.round(icon.height)}` : 'none' };
  })).catch((error: unknown) => String(error)) : 'no window';

  await state(win, 'daemon-stopped', 'The owned daemon stopped twice', async (record) => {
    const page = need(win);
    const kills: Record<string, unknown>[] = [];
    for (let i = 1; i <= 2; i++) {
      // Wait for the daemon of the moment: the first restart writes a new PID file.
      await expect.poll(() => pidOfDaemon(box.home, ownedPort) !== undefined && alive(pidOfDaemon(box.home, ownedPort) ?? 0), { timeout: 30_000 }).toBe(true);
      await expect(page.getByRole('contentinfo').locator('[data-runners="known"]')).toBeVisible({ timeout: 30_000 });
      const pid = pidOfDaemon(box.home, ownedPort) ?? 0;
      process.kill(pid, 'SIGKILL');
      kills.push({ kill: i, pid, seen: await sampleChrome(page, 8_000) });
    }
    probes.ownedDaemonKilled = kills;
    record.notes.push('the owned daemon was killed once (the app restarted it unasked) and again (no second restart)');
  });

  // The layout persists per workspace, and the second launch should start from the defaults (prefs.ts).
  await win?.evaluate((repo) => {
    const bridge = (window as unknown as { ordewell: { prefs: { set: (key: string, value: unknown) => Promise<unknown> } } }).ordewell;
    return bridge.prefs.set('layouts', { [repo]: {} });
  }, box.repo).catch(() => undefined);
  await stubDialogs(app).catch(() => undefined);
  await app.close().catch(() => undefined);
  apps.splice(apps.indexOf(app), 1);
  await untilListening(ownedPort, false);

  // ----------------------------------------------------------- second launch
  // The app attaches to an external daemon on its own port, with no planner
  // provider. The session is first held by a VS Code window, which the app
  // cannot join, and then by a second daemon, which it joins (ADR-0060 H8).
  const appPort = await freePort();
  const holderPort = await freePort();
  const held: Record<string, unknown> = {};
  probes.held = held;
  let app2: ElectronApplication | undefined;
  let win2: Page | undefined;
  let attached: ChildProcess | undefined;
  let holder: ChildProcess | undefined;
  let sessionId = '';
  const workspace = encodeURIComponent(box.repo);
  try {
    attached = await startDaemon(box, appPort);
    holder = await startDaemon(box, holderPort);
    const sessions = await daemonCall(box, holderPort, 'GET', `/api/sessions?workspace=${workspace}`);
    // The plan-card-fit draft is a second session: the run is the one to hold.
    const listed = Array.isArray(sessions) ? sessions as { id?: unknown; goal?: unknown }[] : [];
    const first = listed.find((s) => s.goal === GOAL) ?? listed[0];
    if (typeof first?.id !== 'string') throw new Error(`the holder listed no session: ${JSON.stringify(sessions)}`);
    sessionId = first.id;
    held.sessionId = sessionId;
    held.holderPid = holder.pid;
    held.attachedPid = attached.pid;

    app2 = await launchApp(box, appEnv(box, appPort, started.port, { noProvider: true }));
    apps.push(app2);
    watchConsole(app2, 'launch 2');
    await stubDialogs(app2);
    win2 = await workspaceWindow(app2, box.repo);
  } catch (error) {
    held.setupError = String(error);
  }

  await state(win2, 'no-provider', 'Workspace with no planner provider configured', async (record) => {
    const page = need(win2);
    await expect(page.getByRole('contentinfo').locator('[data-runners="known"]')).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(LOADING_GRACE_MS);
    const planner = page.getByRole('main', { name: 'Centre' });
    record.notes.push(`planner panel after ${LOADING_GRACE_MS / 1000} s: ${((await planner.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  });

  // A VS Code window holds a session in its own extension host, with no daemon
  // to join: its lease, as that host writes it, names this test's own live pid.
  const lease = path.join(box.repo, '.ordewell', 'sessions', sessionId, 'lease.json');
  const since = new Date().toISOString();
  const writeVsCodeLease = (): void => {
    if (!sessionId) return;
    fs.mkdirSync(path.dirname(lease), { recursive: true });
    fs.writeFileSync(lease, JSON.stringify({ hostId: 'tour-vscode', pid: process.pid, host: { kind: 'vscode' }, since, heartbeatAt: new Date().toISOString(), runnerGroups: [] }));
  };
  writeVsCodeLease();
  // Its heartbeat, so the lease is not judged stale while the states are captured.
  const vscodeHeartbeat = setInterval(writeVsCodeLease, 5_000);
  const openSession = async (page: Page): Promise<void> => {
    // Clicking the activity already shown collapses its sidebar.
    const sidebar = page.getByRole('navigation', { name: 'Sessions' });
    if (!await sidebar.isVisible()) await page.getByRole('navigation', { name: 'Views' }).getByRole('tab', { name: /^Sessions/ }).click();
    await sidebar.locator('button.session-row').filter({ hasText: GOAL }).first().click({ timeout: 30_000 });
  };

  try {
    await state(win2, 'held', 'Session held by a VS Code window', async () => {
      const page = need(win2);
      const banner = page.getByRole('region', { name: 'This session is open in a VS Code window' });
      if (!await banner.isVisible()) await openSession(page);
      await expect(banner).toBeVisible({ timeout: 30_000 });
      held.banner = (await banner.textContent())?.replace(/\s+/g, ' ').trim();
      held.plannerPanel = ((await page.getByRole('main', { name: 'Centre' }).textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    });

    if (win2) {
      const page = win2;
      // The banner's: the read-only chip beside the planner has one too.
      const button = page.getByRole('region', { name: 'This session is open in a VS Code window' }).getByRole('button', { name: 'Refresh', exact: true });
      held.refresh = await button.isVisible()
        ? await button.click().then(async () => ({ clicked: true, seen: await sampleChrome(page, 4_000) }))
        : { clicked: false, why: 'no "Refresh" button' };
    }

    await state(win2, 'held-read-only', 'Held session, Watch read-only', async () => {
      const page = need(win2);
      await page.getByRole('button', { name: 'Watch read-only', exact: true }).click({ timeout: 10_000 });
      await page.waitForTimeout(2_000);
      held.watchReadOnly = {
        seen: await sampleChrome(page, 2_000),
        editorText: ((await page.getByRole('main', { name: 'Centre' }).textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
      };
    });

    if (win2 && app2) {
      const page = win2;
      const button = page.getByRole('button', { name: 'Take over…', exact: true });
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        const outcome = page.getByRole('region', { name: /^(Take over refused|Taken over)$/ });
        await outcome.waitFor({ timeout: 10_000 }).catch(() => undefined);
        held.takeOverWhileVsCodeLives = { outcome: (await outcome.textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim(), asked: await dialogsAsked(app2) };
        await outcome.getByRole('button', { name: 'Dismiss' }).click().catch(() => undefined);
      } else {
        held.takeOverWhileVsCodeLives = { clicked: false, why: 'no "Take over…" button' };
      }
    }
  } finally {
    clearInterval(vscodeHeartbeat);
  }

  // The VS Code window closes the session, and the second daemon opens it.
  try {
    fs.rmSync(lease, { force: true });
    if (sessionId) await daemonCall(box, holderPort, 'POST', `/api/sessions/${encodeURIComponent(sessionId)}/load?workspace=${workspace}`);
  } catch (error) {
    held.holderLoadError = String(error);
  }

  await state(win2, 'joined', 'Session another daemon holds, joined live', async () => {
    const page = need(win2);
    const refresh = page.getByRole('region', { name: 'This session is open in a VS Code window' }).getByRole('button', { name: 'Refresh', exact: true });
    if (await refresh.isVisible()) await refresh.click();
    else await openSession(page);
    await expect(page.getByText(`Live in the daemon on port ${holderPort} (pid ${holder?.pid ?? ''}), shared.`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('contentinfo')).toContainText(`joined :${holderPort}`);
    await expect(page.getByRole('region', { name: /^Held by|^Can't join|VS Code window/ })).toHaveCount(0);
    held.joined = {
      seen: await sampleChrome(page, 2_000),
      plannerPanel: ((await page.getByRole('main', { name: 'Centre' }).textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    };
  });

  await state(win2, 'holder-exited', 'The joined daemon exited: Continue here', async () => {
    const page = need(win2);
    holder?.kill('SIGKILL');
    await untilListening(holderPort, false);
    await expect(page.getByRole('region', { name: `The daemon on :${holderPort} that held this session has exited.` })).toBeVisible({ timeout: 60_000 });
  });

  if (win2) {
    const page = win2;
    const gone = page.getByRole('region', { name: /has exited\.$/ });
    const button = gone.getByRole('button', { name: 'Continue here' });
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      const leasePid: unknown = await gone.waitFor({ state: 'hidden', timeout: 30_000 })
        .then(() => (JSON.parse(fs.readFileSync(lease, 'utf8')) as { pid?: unknown }).pid)
        .catch((error: unknown) => String(error));
      held.continueHere = { seen: await sampleChrome(page, 4_000), leasePid, attachedPid: attached?.pid };
    } else {
      held.continueHere = { clicked: false, why: 'no "Continue here" button' };
    }
  }

  await state(win2, 'reconnecting', 'Reconnecting banner (the attached daemon stopped)', async () => {
    const page = need(win2);
    attached?.kill('SIGKILL');
    await expect(page.getByRole('heading', { name: 'Reconnecting to the daemon…' })).toBeVisible({ timeout: 60_000 });
  });

  writeReport();

  const unreached = states.filter((s) => !s.reached);
  expect(unreached.map((s) => `${s.id}: ${s.error ?? ''}`), 'every state of the tour is reached').toEqual([]);
  if (STRICT) {
    const failures = states.flatMap((s) => s.shots.flatMap((shot) => shot.checks.filter((c) => !c.pass).map((c) => `${shot.file} ${c.id}: ${c.details[0] ?? ''}`)));
    expect([...failures, ...fitFailures], 'TOUR_STRICT: every layout check passes').toEqual([]);
  }
});
