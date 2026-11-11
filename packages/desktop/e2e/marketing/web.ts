/**
 * The website's own set, under the names its pages use (web/): each view it
 * shows as a 2560x1600 WebP per theme, the share card og.png and the hero's
 * poster as WebP, with the lossless PNGs they were encoded from in
 * web/masters/. The site frames every image 16:10 at 2x, so a view is the
 * 1440x900 window's own 2880x1800 still, brought down by one Lanczos step: a
 * whole window, never a crop of a 16:9 one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg } from './ffmpeg';
import { MASTERS, pngSize, record, WEB, type Entry, type Theme } from './manifest';
import type { Studio } from './studio';

export const WEB_IMAGE = { width: 2560, height: 1600 };
const SCALE = `scale=${WEB_IMAGE.width}:${WEB_IMAGE.height}:flags=lanczos+accurate_rnd+full_chroma_int`;

/** Lossy at a quality where UI text keeps its edges; the site's budget is met by a later pass that re-encodes from the masters. */
async function webp(png: string, out: string): Promise<void> {
  await ffmpeg(['-i', png, '-c:v', 'libwebp', '-quality', '90', '-compression_level', '6', '-frames:v', '1', out]);
}

/** `<view>.webp` (dark) or `<view>-light.webp` from a 1440x900 still at 2x, and its PNG master at the same size. */
export async function webImage(still: string, view: string, theme: Theme, clock: string): Promise<Entry[]> {
  const from = pngSize(still);
  if (from.width * WEB_IMAGE.height !== from.height * WEB_IMAGE.width) throw new Error(`${path.basename(still)} is ${from.width}x${from.height}, not 16:10`);
  const name = theme === 'dark' ? view : `${view}-light`;
  const master = path.join(MASTERS, `${name}.png`);
  const out = path.join(WEB, `${name}.webp`);
  await ffmpeg(['-i', still, '-vf', SCALE, '-frames:v', '1', '-update', '1', master]);
  await webp(master, out);
  const base = { kind: 'image' as const, view, theme, size: { width: 1440, height: 900 }, scale: 2, pixels: WEB_IMAGE };
  return [record({ ...base, path: master }, clock), record({ ...base, path: out }, clock)];
}

/** The hero's poster as the site loads it, from the PNG the encode wrote to web/masters/. */
export async function posterWebp(png: string, clock: string): Promise<Entry> {
  const out = path.join(WEB, 'hero-poster.webp');
  await webp(png, out);
  return record({ path: out, kind: 'poster', view: 'hero', theme: 'dark', size: { width: 1440, height: 900 }, scale: 1, pixels: pngSize(png) }, clock);
}

const OG = { width: 1200, height: 630 };

/**
 * The share card, 1200x630: the mark, the wordmark and one line of what
 * Ordewell does, beside the top left of a dark still that runs off the card's
 * edges. Laid out by the app's renderer in Inter, drawn at the studio's scale
 * and brought down to 1200x630, so its edges are smooth. The fill is flat, so
 * nothing bands once a share preview recompresses it.
 */
export async function shareCard(studio: Studio, still: string, clock: string): Promise<Entry> {
  const inter = fs.readFileSync(require.resolve('@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')).toString('base64');
  // A navigation's URL is capped at 2MB, so the still goes in as a WebP the card's size, not as its PNG.
  const shot = path.join(MASTERS, 'og-still.webp');
  await ffmpeg(['-i', still, '-vf', 'scale=1760:1100:flags=lanczos', '-c:v', 'libwebp', '-quality', '96', '-frames:v', '1', shot]);
  const image = fs.readFileSync(shot).toString('base64');
  fs.rmSync(shot, { force: true });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: 'Inter Variable'; src: url(data:font/woff2;base64,${inter}) format('woff2'); font-weight: 100 900; }
    html, body { margin: 0; background: #08090b; }
    #card { position: relative; width: ${OG.width}px; height: ${OG.height}px; overflow: hidden; background: #08090b; color: #e6e8ec; font-family: 'Inter Variable', sans-serif; }
    #words { position: absolute; left: 72px; top: 0; bottom: 0; width: 420px; display: flex; flex-direction: column; justify-content: center; gap: 28px; }
    #lockup { display: flex; align-items: center; gap: 16px; }
    #lockup svg { width: 64px; height: 64px; }
    #wordmark { font-weight: 750; font-size: 52px; letter-spacing: -0.02em; line-height: 1; }
    #wordmark span { color: #0891b2; }
    #line { margin: 0; font-weight: 550; font-size: 34px; line-height: 1.2; letter-spacing: -0.01em; }
    #runners { margin: 0; font-weight: 450; font-size: 19px; line-height: 1.45; color: #a7aeb8; }
    #shot { position: absolute; left: 540px; top: 96px; width: 880px; height: 550px; border-radius: 14px; border: 1px solid rgba(230, 232, 236, .16); background: url(data:image/webp;base64,${image}) 0 0 / 880px 550px no-repeat; }
  </style></head><body><div id="card">
    <div id="words">
      <div id="lockup"><svg viewBox="0 0 512 512" aria-hidden="true"><g fill="none" stroke="#e6e8ec" stroke-width="26" stroke-linecap="round"><path d="M 72 142 C 190 142 232 256 336 256"/><path d="M 72 256 L 336 256"/><path d="M 72 370 C 190 370 232 256 336 256"/></g><circle cx="392" cy="256" r="40" fill="#0891b2"/></svg><div id="wordmark">orde<span>well</span></div></div>
      <p id="line">Turn one goal into an ordered plan of agent tasks.</p>
      <p id="runners">Claude Code, Codex, OpenCode and GitHub Copilot CLI, each task on its own runner and model, run and verified.</p>
    </div>
    <div id="shot"></div>
  </div></body></html>`;
  const [page] = await Promise.all([
    studio.app.waitForEvent('window'),
    studio.app.evaluate(({ BrowserWindow }, { url, width, height }) => {
      const win = new BrowserWindow({ show: false, width, height, useContentSize: true, frame: false, paintWhenInitiallyHidden: true, webPreferences: { sandbox: true, contextIsolation: true } });
      void win.loadURL(url);
    }, { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}`, ...OG }),
  ]);
  const drawn = path.join(MASTERS, 'og@2x.png');
  const out = path.join(WEB, 'og.png');
  try {
    await page.waitForLoadState('load');
    await page.evaluate(() => document.fonts.ready);
    await page.locator('#card').screenshot({ path: drawn });
  } finally {
    await page.close();
  }
  await ffmpeg(['-i', drawn, '-vf', `scale=${OG.width}:${OG.height}:flags=lanczos+accurate_rnd+full_chroma_int`, '-frames:v', '1', '-update', '1', out]);
  record({ path: drawn, kind: 'image', view: 'share card', theme: 'dark', size: OG, scale: studio.scale, pixels: pngSize(drawn) }, clock);
  return record({ path: out, kind: 'image', view: 'share card', theme: 'dark', size: OG, scale: 1, pixels: pngSize(out) }, clock);
}
