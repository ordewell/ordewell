/**
 * The marketing capture studio: the real desktop app, built and offline (the
 * acceptance test's mock planner and fake runner, a temp HOME, a hermetic
 * PATH), drawn on the private Xvfb screen xrun.sh starts, and grabbed from that
 * screen with x11grab, so a capture holds what a user sees: the page and the
 * window controls the title bar overlay draws beside it, which a page capture
 * leaves out.
 *
 * One launch draws at one device scale factor: 2 for stills, so a 1440x900
 * window is a 2880x1800 PNG drawn at that density rather than scaled up, and
 * 1 for video, so a 1920x1080 recording is the window's own pixels. The
 * screen is 3840x2160, which holds a 1920x1080 window at 2x whole.
 *
 * What a run shows is pinned: the page's clock (and so every "2 hours ago") is
 * MARKETING_CLOCK and runs on from there, the time zone is UTC unless the
 * scenario's env sets its own, the locale en-US, and a still is grabbed with
 * the caret hidden, transitions off,
 * animations finished or held, the pointer and its tooltips gone, and two
 * grabs in a row identical. Only the page's clock moves: what main or the
 * daemon stamps (a folder's "opened", a session's start) is real time, which
 * the page reads as a moment ahead of its own and shows as "just now". A
 * scenario that runs tasks, whose elapsed times are the daemon's, takes the
 * real clock instead (`clock: 'real'`) and dates what it seeds from now.
 */
import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { appEnv, DESKTOP, freePort, openFolder, removeSandbox, startMock, type Sandbox } from '../fixtures';
import { ffmpeg, ffmpegStart, type Running } from './ffmpeg';
import { pngSize, record, STILLS, type Entry, type Theme } from './manifest';

export type { Theme } from './manifest';
export interface Size { width: number; height: number }

/** The sizes every still is captured at, in CSS pixels. */
export const STILL_SIZES: readonly Size[] = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }];
export const THEMES: readonly Theme[] = ['dark', 'light'];
export const VIDEO_SIZE: Size = { width: 1920, height: 1080 };
export const FPS = 30;

/** The instant the page is shown as now. A Tuesday afternoon, so ages read as a working day's. */
export const CLOCK = process.env.MARKETING_CLOCK ?? '2026-03-17T14:30:00.000Z';
const CLOCK_MS = Date.parse(CLOCK);
if (Number.isNaN(CLOCK_MS)) throw new Error(`MARKETING_CLOCK=${CLOCK} is not a date`);

/** The switch main's testWindows.ts reads: dialogs, the tray and links stay suppressed, as in every e2e run. */
const TEST_WINDOWS_ENV = 'ORDEWELL_DESKTOP_TEST_WINDOWS';

/**
 * The daemon's port when it is free, so the status bar names the same one in
 * every shot and take. Not the default 3742: an install on this machine would
 * attach to a daemon there.
 */
const STEADY_PORT = 47_420;

/** STEADY_PORT, or any free port while another daemon, an earlier take's or anyone's, still holds it. */
function daemonPort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => { void freePort().then(resolve); });
    server.listen(STEADY_PORT, '127.0.0.1', () => { server.close(() => resolve(STEADY_PORT)); });
  });
}

/** The Xvfb display xrun.sh started; a capture refuses any other, so it never grabs a developer's screen. */
export function display(): string {
  const xvfb = process.env.MARKETING_XVFB;
  if (!xvfb || process.env.DISPLAY !== xvfb) {
    throw new Error('marketing captures run on the private display xrun.sh starts: npm run marketing:capture -w packages/desktop');
  }
  return xvfb;
}

/** An ISO instant `minutes` before the page's now, for a seeded commit, recent or session. */
export function ago(minutes: number): string {
  return new Date(CLOCK_MS - minutes * 60_000).toISOString();
}

/** A commit in `dir` dated `minutes` before the page's now, so its age reads the same on every run. */
export function commitAgo(sandbox: Sandbox, dir: string, minutes: number, file: string, message: string, content = `${message}\n`): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.appendFileSync(path.join(dir, file), content);
  const date = ago(minutes);
  const env = { ...process.env, HOME: sandbox.home, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  execFileSync('git', ['-C', dir, 'add', '.'], { env });
  execFileSync('git', ['-C', dir, 'commit', '-qm', message], { env });
}

/**
 * Seeds the welcome window's recent folders (main's recents.json, as
 * src/main/recents.ts reads it), each opened `minutes` before the page's now,
 * with the branch its card shows before the daemon answers. Every path must
 * exist: the card of a folder that is gone reads as missing.
 */
export function seedRecents(sandbox: Sandbox, recents: ReadonlyArray<{ path: string; minutes: number; branch?: string }>): void {
  fs.mkdirSync(sandbox.userData, { recursive: true });
  const entries = recents.map((r) => ({ path: r.path, openedAt: ago(r.minutes), ...(r.branch ? { git: { kind: 'branch', name: r.branch } } : {}) }));
  fs.writeFileSync(path.join(sandbox.userData, 'recents.json'), `${JSON.stringify({ entries }, null, 2)}\n`);
}

/**
 * A frame preload, registered on the app's session, that runs in every page
 * before its own scripts: Date reads as CLOCK plus the time since the page
 * loaded, so ages are fixed and a timer still sees time pass. The windows are
 * sandboxed and context-isolated, so the preload reaches the page's own world
 * through contextBridge.executeInMainWorld. Playwright's init scripts (and CDP's
 * Page.addScriptToEvaluateOnNewDocument) never ran in these app:// windows.
 */
function clockPreload(at: number): string {
  return `require('electron').contextBridge.executeInMainWorld({
  args: [${at}],
  func: (at) => {
    const Real = Date;
    const offset = at - Real.now();
    class Pinned extends Real {
      constructor(...args) { if (args.length === 0) super(Real.now() + offset); else super(...args); }
      static now() { return Real.now() + offset; }
    }
    globalThis.Date = Pinned;
  },
});
`;
}

interface PrefsBridge { ordewell: { prefs: { set(key: string, value: string): Promise<unknown> } } }

export interface Studio {
  readonly app: ElectronApplication;
  readonly sandbox: Sandbox;
  readonly scale: number;
  /** The welcome window, once the app has drawn it. */
  welcome(): Promise<Page>;
  /** Opens `dir` from the welcome window, as the folder picker would answer, and returns the workspace window. */
  openFolder(dir: string): Promise<Page>;
  /** Shows `page`'s window alone, at the screen's top left, at `size`, and waits for the page to take that size. */
  present(page: Page, size: Size): Promise<void>;
  setTheme(page: Page, theme: Theme): Promise<void>;
  /** Grabs the presented window, or one region of it, as a still, and records it in the manifest. */
  still(page: Page, shot: { view: string; theme: Theme; size: Size; region?: { name: string; locator: Locator } }): Promise<Entry>;
  close(): Promise<void>;
}

export interface StudioOptions {
  /** 2 for stills, 1 for video. */
  scale: number;
  /** Makes the repository and HOME the app opens, before it launches. */
  sandbox: Sandbox;
  /** Mock planner persona, as appEnv takes it. */
  persona?: string;
  /** The planner the app talks to, listening before it resolves; bench/live's mock provider when absent. */
  planner?: () => Promise<{ port: number; process: ChildProcess }>;
  /** The app's environment, given the one the studio would launch it with. */
  env?: (base: Record<string, string>) => Record<string, string>;
  /** 'pinned' (the default) shows MARKETING_CLOCK as now; 'real' leaves the page on the machine's clock. */
  clock?: 'pinned' | 'real';
}

/**
 * Launches the app for capturing. Like launchApp in the fixtures, with its
 * windows hidden until {@link Studio.present} shows one, but without its
 * watch for shown windows: here a window is shown on purpose, on a screen no
 * one sees.
 */
export async function openStudio(options: StudioOptions): Promise<Studio> {
  display();
  const { sandbox, scale } = options;
  const mock = await (options.planner ?? (() => startMock()))();
  const base = {
    ...appEnv(sandbox, await daemonPort(), mock.port, { persona: options.persona }),
    TZ: 'UTC', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', LANGUAGE: 'en_US',
  };
  const env = { ...(options.env ? options.env(base) : base), [TEST_WINDOWS_ENV]: 'hidden' };
  let app: ElectronApplication;
  try {
    app = await electron.launch({
      args: [
        DESKTOP, `--user-data-dir=${sandbox.userData}`, '--no-sandbox',
        `--force-device-scale-factor=${scale}`, '--lang=en-US',
        // Software compositing on Xvfb paints every frame the same way, and no frame is skipped while one is recorded.
        '--disable-gpu', '--disable-frame-rate-limit',
      ],
      env,
      cwd: sandbox.tmp,
    });
  } catch (error) {
    mock.process.kill();
    throw error;
  }
  const pinned = (options.clock ?? 'pinned') === 'pinned';
  if (pinned) {
    const preload = path.join(sandbox.tmp, 'marketing-clock.preload.js');
    fs.writeFileSync(preload, clockPreload(CLOCK_MS));
    await app.evaluate(({ session }, filePath) => {
      session.defaultSession.registerPreloadScript({ type: 'frame', id: 'ordewell-marketing-clock', filePath });
    }, preload);
  }
  return new StudioImpl(app, sandbox, scale, mock.process, pinned);
}

class StudioImpl implements Studio {
  private readonly clocked = new WeakSet<Page>();
  private presented: { page: Page; size: Size } | undefined;

  constructor(readonly app: ElectronApplication, readonly sandbox: Sandbox, readonly scale: number, private readonly mock: ChildProcess, private readonly pinned: boolean) {}

  async welcome(): Promise<Page> {
    const page = await this.app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await this.clock(page);
    await expect(page.getByRole('button', { name: 'Open folder…' })).toBeVisible({ timeout: 90_000 });
    return page;
  }

  async openFolder(dir: string): Promise<Page> {
    const welcome = await this.welcome();
    const page = await openFolder(this.app, welcome, dir);
    await page.waitForLoadState('domcontentloaded');
    await this.clock(page);
    await expect(page.getByRole('navigation', { name: 'Views' })).toBeVisible({ timeout: 90_000 });
    return page;
  }

  /** A window main opened before the clock's preload was registered (the first welcome window) is reloaded once to take it. */
  private async clock(page: Page): Promise<void> {
    if (!this.pinned || this.clocked.has(page)) return;
    const pinned = (): Promise<boolean> => page.evaluate((at) => Math.abs(Date.now() - at) < 10 * 60_000, CLOCK_MS);
    if (!(await pinned())) {
      await page.reload();
      await page.waitForLoadState('domcontentloaded');
      if (!(await pinned())) throw new Error(`the page's clock did not take MARKETING_CLOCK=${CLOCK}`);
    }
    this.clocked.add(page);
  }

  async present(page: Page, size: Size): Promise<void> {
    await this.clock(page);
    const target = await this.app.browserWindow(page);
    await this.app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.hide();
    });
    await target.evaluate((win, bounds) => {
      win.setMinimumSize(1, 1);
      win.setContentBounds({ x: 0, y: 0, ...bounds });
      win.showInactive();
    }, size);
    await page.waitForFunction(({ width, height, scale }) => window.innerWidth === width && window.innerHeight === height && window.devicePixelRatio === scale,
      { ...size, scale: this.scale }, { timeout: 10_000 });
    this.presented = { page, size };
    await settle(page);
  }

  async setTheme(page: Page, theme: Theme): Promise<void> {
    await page.evaluate(async (t) => { await (window as unknown as PrefsBridge).ordewell.prefs.set('theme', t); }, theme);
    // Playwright pins an Electron page's prefers-color-scheme to light; the page follows the pref by emulation.
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForFunction((t) => window.matchMedia('(prefers-color-scheme: light)').matches === (t === 'light'), theme, { timeout: 5_000 });
    await settle(page);
  }

  async still(page: Page, shot: { view: string; theme: Theme; size: Size; region?: { name: string; locator: Locator } }): Promise<Entry> {
    if (this.presented?.page !== page || this.presented.size.width !== shot.size.width || this.presented.size.height !== shot.size.height) {
      await this.present(page, shot.size);
    }
    await fontsAsDesigned(page);
    await freeze(page);
    try {
      let box = { x: 0, y: 0, width: shot.size.width, height: shot.size.height };
      if (shot.region) {
        const found = await shot.region.locator.boundingBox();
        if (!found) throw new Error(`${shot.view}: the region ${shot.region.name} is not on screen`);
        // Whole device pixels, inside the window.
        const x = Math.max(0, Math.floor(found.x));
        const y = Math.max(0, Math.floor(found.y));
        box = { x, y, width: Math.min(shot.size.width, Math.ceil(found.x + found.width)) - x, height: Math.min(shot.size.height, Math.ceil(found.y + found.height)) - y };
      }
      const name = `${shot.view}${shot.region ? `.${shot.region.name}` : ''}--${shot.theme}--${shot.size.width}x${shot.size.height}@${this.scale}x.png`;
      const file = path.join(STILLS, name);
      await grabSteady(file, box, this.scale);
      const pixels = pngSize(file);
      return record({
        path: file, kind: 'still', view: shot.view, theme: shot.theme, size: shot.size, scale: this.scale, pixels,
        ...(shot.region ? { region: { ...box, name: shot.region.name } } : {}),
      }, this.pinned ? CLOCK : new Date().toISOString());
    } finally {
      await unfreeze(page);
    }
  }

  async close(): Promise<void> {
    await this.app.close().catch(() => undefined);
    // Stopped by its own handle, never by name: other runs share this machine.
    this.mock.kill();
    removeSandbox(this.sandbox);
  }
}

/** Grabs a box of the screen, in CSS pixels, until two grabs in a row are the same image. */
async function grabSteady(file: string, box: { x: number; y: number; width: number; height: number }, scale: number): Promise<void> {
  const grab = async (to: string): Promise<Buffer> => {
    await ffmpeg([
      '-f', 'x11grab', '-draw_mouse', '0',
      '-video_size', `${box.width * scale}x${box.height * scale}`,
      '-i', `${display()}+${box.x * scale},${box.y * scale}`,
      '-frames:v', '1', '-update', '1', to,
    ]);
    return fs.readFileSync(to);
  };
  const partial = `${file}.${process.pid}.partial.png`;
  try {
    let last = await grab(partial);
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const next = await grab(partial);
      if (next.equals(last)) {
        fs.renameSync(partial, file);
        return;
      }
      last = next;
    }
    throw new Error(`the screen kept changing while ${path.basename(file)} was grabbed`);
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

/**
 * Waits until the page stops changing: its fonts loaded, then no node,
 * attribute or text changed and no finite animation ran for 150ms of frames,
 * for at most two seconds; a finite animation still running then is finished.
 * The tour's settle, with a longer limit, since a capture has time to wait.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async ({ limit, quiet }) => {
    const deadline = performance.now() + limit;
    const frame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
    const finite = (): Animation[] => document.getAnimations().filter((a) => a.playState === 'running' && Number.isFinite(Number(a.effect?.getComputedTiming().endTime)));
    await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, limit))]);
    let changed = performance.now();
    const mark = (): void => { changed = performance.now(); };
    const observer = new MutationObserver(mark);
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    document.addEventListener('scroll', mark, true);
    try {
      await frame();
      await frame();
      while (performance.now() < deadline) {
        if (finite().length) mark();
        if (performance.now() - changed >= quiet) return;
        await frame();
      }
      for (const a of finite()) a.finish();
      await frame();
      await frame();
    } finally {
      observer.disconnect();
      document.removeEventListener('scroll', mark, true);
    }
  }, { limit: 2_000, quiet: 150 });
}

const FREEZE_ID = 'ordewell-marketing-freeze';

/**
 * Holds the page still for a grab: no caret, no transition, every finite
 * animation at its end and every endless one (a spinner, a blinking cursor) at
 * its first frame, the pointer off the window, so no hover or tooltip shows,
 * nothing focused, so no focus ring does, and no scrollbar thumb, which a
 * still cannot scroll (the track keeps its room, so nothing reflows).
 */
async function freeze(page: Page): Promise<void> {
  await page.mouse.move(-50, -50);
  await page.evaluate((id) => {
    if (!document.getElementById(id)) {
      const style = document.createElement('style');
      style.id = id;
      style.textContent = '*, *::before, *::after { caret-color: transparent !important; transition: none !important; scroll-behavior: auto !important; } ::-webkit-scrollbar-thumb { background: transparent !important; }';
      document.head.append(style);
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    for (const animation of document.getAnimations()) {
      const end = Number(animation.effect?.getComputedTiming().endTime);
      if (Number.isFinite(end)) animation.finish();
      else { animation.pause(); animation.currentTime = 0; }
    }
  }, FREEZE_ID);
  await expect(page.locator('[role="tooltip"]:visible')).toHaveCount(0, { timeout: 5_000 });
  await settle(page);
  // Two frames after the last change, so the screen holds what the page now draws.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function unfreeze(page: Page): Promise<void> {
  await page.evaluate((id) => {
    document.getElementById(id)?.remove();
    for (const animation of document.getAnimations()) if (animation.playState === 'paused') animation.play();
  }, FREEZE_ID);
}

/**
 * Fails the capture when the page would draw in a fallback font: the design's
 * faces (docs/desktop/design.md, "Type") are bundled with the renderer, so a
 * miss is a broken build, not a missing install.
 */
export async function fontsAsDesigned(page: Page): Promise<void> {
  const found = await page.evaluate(async () => {
    await document.fonts.ready;
    const loads = async (family: string): Promise<boolean> => (await document.fonts.load(`400 16px "${family}"`)).some((face) => face.family.replace(/["']/g, '') === family && face.status === 'loaded');
    return {
      sans: await loads('Inter Variable'),
      mono: await loads('JetBrains Mono Variable'),
      body: getComputedStyle(document.body).fontFamily,
    };
  });
  const problems = [
    found.sans ? '' : 'Inter Variable did not load',
    found.mono ? '' : 'JetBrains Mono Variable did not load',
    /^["']?Inter Variable/.test(found.body) ? '' : `the body draws in ${found.body}`,
  ].filter(Boolean);
  if (problems.length) throw new Error(`the page would draw in fallback fonts: ${problems.join('; ')}`);
}

// ------------------------------------------------------------------- video

const POINTER_ID = 'ordewell-marketing-pointer';

/**
 * An arrow drawn by the page over everything, where Playwright's input last
 * moved the mouse, with a ring that pulses on a press. x11grab's own pointer is
 * the X server's, which Playwright's events never move.
 */
async function showPointer(page: Page, at: { x: number; y: number }): Promise<void> {
  await page.evaluate(({ id, x, y }) => {
    if (document.getElementById(id)) return;
    const root = document.createElement('div');
    root.id = id;
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText = `position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;transform:translate(${x}px,${y}px);`;
    root.innerHTML = `
      <div data-ring style="position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:50%;background:rgba(120,160,255,.35);opacity:0;transform:scale(.4);transition:opacity .35s ease-out,transform .35s ease-out"></div>
      <svg width="22" height="28" viewBox="0 0 22 28" style="position:absolute;left:-2px;top:-1px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">
        <path d="M2 1.5 L2 22 L7.2 17.4 L10.6 25.6 L14.2 24.1 L10.8 16.1 L17.8 16.1 Z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>`;
    document.documentElement.append(root);
    const ring = root.querySelector<HTMLElement>('[data-ring]');
    window.addEventListener('mousemove', (event) => { root.style.transform = `translate(${event.clientX}px,${event.clientY}px)`; }, true);
    window.addEventListener('mousedown', () => {
      if (!ring) return;
      ring.style.transition = 'none';
      ring.style.opacity = '1';
      ring.style.transform = 'scale(.4)';
      requestAnimationFrame(() => { ring.style.transition = 'opacity .45s ease-out, transform .45s ease-out'; ring.style.opacity = '0'; ring.style.transform = 'scale(1.3)'; });
    }, true);
  }, { id: POINTER_ID, ...at });
}

/** A seeded generator, so a flow's typing rhythm is the same on every run. */
function rhythm(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What a recorded flow drives: a pointer that glides and a keyboard typed at a person's pace. */
export interface Hand {
  /** Glides the pointer to the middle of `target` (or a point), easing in and out. */
  move(target: Locator | { x: number; y: number }, ms?: number): Promise<void>;
  /** Glides to `target` and clicks it. */
  click(target: Locator, ms?: number): Promise<void>;
  /** Types `text` into whatever has focus, a character at a time. */
  type(text: string): Promise<void>;
  /** Holds still, for the viewer to read. */
  wait(ms: number): Promise<void>;
}

function handFor(page: Page, start: { x: number; y: number }): Hand {
  let at = { ...start };
  const random = rhythm(0x0d3e);
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const centre = async (target: Locator | { x: number; y: number }): Promise<{ x: number; y: number }> => {
    if (!('boundingBox' in target)) return target;
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`nothing to point at: ${target.toString()}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const hand: Hand = {
    async move(target, ms = 700) {
      const to = await centre(target);
      const from = at;
      const steps = Math.max(8, Math.round(ms / 16));
      const started = Date.now();
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
        await page.mouse.move(from.x + (to.x - from.x) * eased, from.y + (to.y - from.y) * eased);
        const due = started + (ms * i) / steps - Date.now();
        if (due > 0) await sleep(due);
      }
      at = to;
    },
    async click(target, ms) {
      await hand.move(target, ms);
      await sleep(120);
      await page.mouse.down();
      await sleep(70);
      await page.mouse.up();
    },
    async type(text) {
      for (const char of text) {
        await page.keyboard.type(char);
        // 45-120ms a key, a little longer after a word or a sentence.
        const pause = 45 + random() * 75 + (char === ' ' ? 40 : 0) + (/[.,!?]/.test(char) ? 160 : 0);
        await sleep(pause);
      }
    },
    wait: sleep,
  };
  return hand;
}

/** A recording's timeline: seconds from its first frame, for the edit to cut at. */
export interface Take {
  readonly master: string;
  readonly marks: Readonly<Record<string, number>>;
  readonly duration: number;
}

/**
 * Records the presented window, from the screen, at 30fps, while `flow` drives
 * it, into a lossless RGB master the edit cuts and encodes from. `flow` may
 * call `mark(name)` to name a moment the edit can cut at. The pointer is shown
 * from the start, at `pointerFrom` (the window's centre by default).
 */
export async function recordTake(studio: Studio, page: Page, masterFile: string, flow: (hand: Hand, mark: (name: string) => void) => Promise<void>, pointerFrom?: { x: number; y: number }): Promise<Take> {
  if (studio.scale !== 1) throw new Error('a video is recorded from a scale 1 studio, so it is the window\'s own pixels');
  const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const from = pointerFrom ?? { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };
  await page.mouse.move(from.x, from.y);
  await showPointer(page, from);
  await settle(page);
  fs.mkdirSync(path.dirname(masterFile), { recursive: true });
  const progress: Running = await ffmpegStart([
    '-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(FPS),
    '-video_size', `${size.width}x${size.height}`, '-i', `${display()}+0,0`,
    // libx264rgb at qp 0 keeps every pixel, in RGB, so the one colour conversion is the final encode's.
    '-c:v', 'libx264rgb', '-preset', 'ultrafast', '-qp', '0', '-r', String(FPS),
    '-stats_period', '0.1', '-progress', 'pipe:2',
    masterFile,
  ]);
  const zero = await firstFrame(progress.child);
  const marks: Record<string, number> = {};
  const mark = (name: string): void => { marks[name] = (Date.now() - zero) / 1000; };
  try {
    await flow(handFor(page, from), mark);
  } finally {
    await progress.stop();
  }
  marks.end = (Date.now() - zero) / 1000;
  return { master: masterFile, marks, duration: marks.end };
}

/** The wall-clock time of a recording's first frame, from ffmpeg's progress: now less the output time it reports. */
function firstFrame(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let text = '';
    const late = setTimeout(() => { child.stderr?.off('data', read); reject(new Error(`ffmpeg recorded no frame within ten seconds: ${text.slice(-500)}`)); }, 10_000);
    const read = (chunk: Buffer): void => {
      text = (text + chunk.toString()).slice(-4000);
      const frames = /frame=(\d+)[\s\S]*?out_time_us=(\d+)/g;
      let found: RegExpExecArray | null;
      while ((found = frames.exec(text))) {
        if (Number(found[1]) > 0) {
          clearTimeout(late);
          child.stderr?.off('data', read);
          resolve(Date.now() - Number(found[2]) / 1000);
          return;
        }
      }
    };
    child.stderr?.on('data', read);
    child.once('exit', (code) => { clearTimeout(late); reject(new Error(`ffmpeg exited ${code} before its first frame: ${text.slice(-500)}`)); });
  });
}

/**
 * A pill reading "4× speed" with a fast-forward mark, as a transparent PNG at
 * the studio's scale, drawn by the app's own renderer in Inter, for the edit
 * to lay over a sped-up stretch. ffmpeg's static build has no drawtext.
 */
export async function speedBadge(studio: Studio, speed: number, file: string): Promise<string> {
  const inter = fs.readFileSync(require.resolve('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')).toString('base64');
  const label = `${Number.isInteger(speed) ? speed : speed.toFixed(1)}× speed`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: 'Inter Variable'; src: url(data:font/woff2;base64,${inter}) format('woff2'); font-weight: 100 900; }
    html, body { margin: 0; background: transparent; }
    #badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px 8px 12px; margin: 4px;
      border-radius: 999px; background: rgba(17, 19, 22, .82); color: #f2f3f5; box-shadow: 0 0 0 1px rgba(255,255,255,.14);
      font: 600 15px/1 'Inter Variable', sans-serif; letter-spacing: .01em; font-variant-numeric: tabular-nums; }
    svg { display: block; }
  </style></head><body><div id="badge"><svg width="16" height="12" viewBox="0 0 16 12"><path d="M0 0 L8 6 L0 12 Z M8 0 L16 6 L8 12 Z" fill="currentColor"/></svg><span>${label}</span></div></body></html>`;
  const [page] = await Promise.all([
    studio.app.waitForEvent('window'),
    studio.app.evaluate(({ BrowserWindow }, url) => {
      const win = new BrowserWindow({ show: false, width: 400, height: 120, transparent: true, frame: false, paintWhenInitiallyHidden: true, webPreferences: { sandbox: true, contextIsolation: true } });
      void win.loadURL(url);
    }, `data:text/html;base64,${Buffer.from(html).toString('base64')}`),
  ]);
  try {
    await page.waitForLoadState('load');
    await page.evaluate(() => document.fonts.ready);
    await page.locator('#badge').screenshot({ path: file, omitBackground: true });
  } finally {
    await page.close();
  }
  return file;
}
