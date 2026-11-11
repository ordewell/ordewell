/**
 * Where the captures land and the manifest that lists them. Everything is
 * under marketing-out/ (gitignored in this package): stills/ for PNGs, videos/
 * for MP4, WebM, GIF and posters, web/ for the website's own set under the
 * names its pages use, with the lossless masters it was encoded from in
 * web/masters/. The manifest is upserted by path as each file is written, so a
 * run that captures one shot keeps every other shot's entry, and an entry
 * whose file is gone is dropped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DESKTOP } from '../fixtures';

export const OUT = process.env.MARKETING_OUT ? path.resolve(process.env.MARKETING_OUT) : path.join(DESKTOP, 'marketing-out');
export const STILLS = path.join(OUT, 'stills');
export const VIDEOS = path.join(OUT, 'videos');
export const WEB = path.join(OUT, 'web');
export const MASTERS = path.join(WEB, 'masters');
const MANIFEST = path.join(OUT, 'manifest.json');

export type Theme = 'dark' | 'light';

export interface Entry {
  /** Relative to marketing-out/, with forward slashes. */
  file: string;
  /** A still is the window as grabbed; an image is made from stills (a web size, the share card). */
  kind: 'still' | 'image' | 'video' | 'gif' | 'poster';
  /** The view or flow it shows, as the capture file names it. */
  view: string;
  theme: Theme;
  /** The window's size in CSS pixels, and the device scale factor it was drawn at. */
  size: { width: number; height: number };
  scale: number;
  /** The file's own pixels. */
  pixels: { width: number; height: number };
  /** Seconds, for a video or a GIF. */
  duration?: number;
  fps?: number;
  /** A region of the window, in CSS pixels, when the still is not the whole window. */
  region?: { x: number; y: number; width: number; height: number; name: string };
  bytes: number;
  capturedAt: string;
}

interface Manifest { generated: string; clock: string; entries: Entry[] }

export function ensureOut(): void {
  for (const dir of [STILLS, VIDEOS, WEB, MASTERS]) fs.mkdirSync(dir, { recursive: true });
}

function read(): Manifest {
  try {
    const parsed = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Partial<Manifest>;
    return { generated: '', clock: '', entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { generated: '', clock: '', entries: [] };
  }
}

/** Records a file just written; `clock` is the instant the app was shown as now. */
export function record(entry: Omit<Entry, 'bytes' | 'capturedAt' | 'file'> & { path: string }, clock: string): Entry {
  const { path: file, ...rest } = entry;
  const full: Entry = {
    ...rest,
    file: path.relative(OUT, file).split(path.sep).join('/'),
    bytes: fs.statSync(file).size,
    capturedAt: new Date().toISOString(),
  };
  const manifest = read();
  const entries = manifest.entries.filter((e) => e.file !== full.file && fs.existsSync(path.join(OUT, e.file)));
  entries.push(full);
  entries.sort((a, b) => a.file.localeCompare(b.file));
  const next: Manifest = { generated: full.capturedAt, clock, entries };
  const partial = `${MANIFEST}.${process.pid}.partial`;
  fs.writeFileSync(partial, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(partial, MANIFEST);
  return full;
}

/** The pixel size a PNG's header records. */
export function pngSize(file: string): { width: number; height: number } {
  const header = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, header, 0, 24, 0); } finally { fs.closeSync(fd); }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}
