/**
 * Cuts a recorded take and encodes what a page or a store listing embeds:
 * H.264 MP4 and VP9 WebM at the take's 1920x1080 and 30fps, an optimised GIF
 * and a poster frame. Every step reads the lossless RGB master or the cut made
 * from it, so text is converted to YUV once, with the BT.709 matrix the files
 * are tagged with, and stays crisp.
 */
import path from 'node:path';
import { durationOf, ffmpeg } from './ffmpeg';
import { pngSize, record, VIDEOS, WEB, type Entry, type Theme } from './manifest';
import { CLOCK, FPS, type Size } from './studio';

/** A stretch of the master, in its seconds, played at `speed` (1 when absent). */
export interface Segment { from: number; to: number; speed?: number }

export interface Cut {
  segments: readonly Segment[];
  /** Seconds of fade from and to black at the start and the end; 0 for none. */
  fade?: number;
  /** The PNG laid over every stretch played faster than 1x, from speedBadge(); required when one is. */
  badges?: Readonly<Record<number, string>>;
}

const RGB_LOSSLESS = ['-c:v', 'libx264rgb', '-preset', 'veryfast', '-qp', '0'];

/** The edited take, still lossless RGB: the segments in order, each at its speed, with its badge, faded in and out. */
export async function cut(master: string, plan: Cut, out: string): Promise<{ file: string; duration: number }> {
  if (!plan.segments.length) throw new Error('a cut needs at least one segment');
  const inputs = ['-i', master];
  const badgeInput = new Map<number, number>();
  for (const segment of plan.segments) {
    const speed = segment.speed ?? 1;
    if (speed === 1 || badgeInput.has(speed)) continue;
    const badge = plan.badges?.[speed];
    if (!badge) throw new Error(`a stretch at ${speed}x needs its badge: an on-screen speed badge is shown whenever the video is sped up`);
    badgeInput.set(speed, badgeInput.size + 1);
    inputs.push('-loop', '1', '-framerate', String(FPS), '-i', badge);
  }
  const uses = new Map<number, number>();
  for (const segment of plan.segments) if ((segment.speed ?? 1) !== 1) uses.set(segment.speed ?? 1, (uses.get(segment.speed ?? 1) ?? 0) + 1);
  const graph: string[] = [];
  const badgeLabels = new Map<number, string[]>();
  for (const [speed, input] of badgeInput) {
    const count = uses.get(speed) ?? 1;
    const labels = Array.from({ length: count }, (_, i) => `b${input}_${i}`);
    graph.push(`[${input}:v]format=rgba,split=${count}${labels.map((l) => `[${l}]`).join('')}`);
    badgeLabels.set(speed, labels);
  }
  let total = 0;
  const parts: string[] = [];
  plan.segments.forEach((segment, i) => {
    const speed = segment.speed ?? 1;
    if (!(segment.to > segment.from)) throw new Error(`segment ${i} ends at ${segment.to}s, not after its start at ${segment.from}s`);
    const length = (segment.to - segment.from) / speed;
    const timed = `[0:v]trim=start=${segment.from}:end=${segment.to},setpts=(PTS-STARTPTS)/${speed},fps=${FPS}`;
    if (speed === 1) {
      graph.push(`${timed}[s${i}]`);
    } else {
      const label = badgeLabels.get(speed)?.shift();
      // Bottom right, clear of the edge by 32px; the badge's own stream ends with the segment.
      graph.push(`${timed}[t${i}]`, `[t${i}][${label}]overlay=x=W-w-32:y=H-h-32:shortest=1:format=rgb[s${i}]`);
    }
    parts.push(`[s${i}]`);
    total += length;
  });
  const fade = Math.min(plan.fade ?? 0.4, total / 3);
  const fades = fade > 0 ? `,fade=t=in:st=0:d=${fade},fade=t=out:st=${(total - fade).toFixed(3)}:d=${fade}` : '';
  graph.push(`${parts.join('')}concat=n=${parts.length}:v=1:a=0,fps=${FPS}${fades},format=rgb24[out]`);
  await ffmpeg([...inputs, '-filter_complex', graph.join(';'), '-map', '[out]', ...RGB_LOSSLESS, '-r', String(FPS), out]);
  return { file: out, duration: await durationOf(out) };
}

/** RGB to BT.709 limited-range YUV 4:2:0, with full chroma interpolation and Lanczos, tagged as such. */
const TO_YUV = 'scale=out_color_matrix=bt709:out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p';
const TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

export interface Encoded { mp4: Entry; webm: Entry; gif: Entry; poster: Entry }

/**
 * Encodes a cut as `<name>.mp4` and `<name>.webm` under videos/, and
 * `<name>.gif` and `<name>.poster.png` under web/, recording each in the
 * manifest. The poster is the frame at `posterAt` seconds of the cut (the
 * middle by default); the GIF is `gifWidth` wide (960 by default) at 15fps.
 */
export async function encode(edited: string, shot: { name: string; view: string; theme: Theme; size: Size; posterAt?: number; gifWidth?: number }): Promise<Encoded> {
  const duration = await durationOf(edited);
  const mp4 = path.join(VIDEOS, `${shot.name}.mp4`);
  const webm = path.join(VIDEOS, `${shot.name}.webm`);
  const gif = path.join(WEB, `${shot.name}.gif`);
  const poster = path.join(WEB, `${shot.name}.poster.png`);
  await ffmpeg([
    '-i', edited, '-vf', TO_YUV, '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-profile:v', 'high', '-tune', 'animation',
    '-r', String(FPS), '-g', String(FPS * 2), ...TAGS, '-movflags', '+faststart', '-an', mp4,
  ]);
  await ffmpeg([
    '-i', edited, '-vf', TO_YUV, '-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1',
    '-r', String(FPS), '-g', String(FPS * 2), ...TAGS, '-an', webm,
  ]);
  const gifWidth = shot.gifWidth ?? 960;
  await ffmpeg([
    '-i', edited, '-filter_complex',
    `[0:v]fps=15,scale=${gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    '-loop', '0', gif,
  ]);
  await ffmpeg(['-ss', String(shot.posterAt ?? duration / 2), '-i', edited, '-frames:v', '1', '-update', '1', poster]);
  const base = { view: shot.view, theme: shot.theme, size: shot.size, scale: 1 };
  const video = { width: shot.size.width, height: shot.size.height };
  return {
    mp4: record({ ...base, path: mp4, kind: 'video', pixels: video, duration: await durationOf(mp4), fps: FPS }, CLOCK),
    webm: record({ ...base, path: webm, kind: 'video', pixels: video, duration: await durationOf(webm), fps: FPS }, CLOCK),
    gif: record({ ...base, path: gif, kind: 'gif', pixels: { width: gifWidth, height: Math.round((gifWidth * shot.size.height) / shot.size.width) }, duration: await durationOf(gif), fps: 15 }, CLOCK),
    poster: record({ ...base, path: poster, kind: 'poster', pixels: pngSize(poster) }, CLOCK),
  };
}

/** Pulls single frames out of a video, at the given seconds, as PNGs beside `prefix`, for a look at what it holds. */
export async function frames(video: string, at: readonly number[], prefix: string): Promise<string[]> {
  const files: string[] = [];
  for (const second of at) {
    const file = `${prefix}-${second.toFixed(2)}s.png`;
    await ffmpeg(['-ss', String(second), '-i', video, '-frames:v', '1', '-update', '1', file]);
    files.push(file);
  }
  return files;
}
