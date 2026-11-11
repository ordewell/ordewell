/**
 * Before any capture: refuses to run anywhere but the private display xrun.sh
 * starts, fetches the pinned ffmpeg (the only step that needs the network, and
 * only on a machine whose .tools/ lacks it), and checks it can grab the screen
 * and write every format the captures promise.
 */
import { execFileSync } from 'node:child_process';
import { ffmpegPath } from './ffmpeg';
import { ensureOut } from './manifest';
import { display } from './studio';

export default async function setup(): Promise<void> {
  display();
  const binary = await ffmpegPath((line) => console.log(`[marketing] ${line}`));
  const has = (what: string, list: string): boolean => new RegExp(`\\s${what}\\s`).test(list);
  const devices = execFileSync(binary, ['-hide_banner', '-devices'], { encoding: 'utf8' });
  const encoders = execFileSync(binary, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  const filters = execFileSync(binary, ['-hide_banner', '-filters'], { encoding: 'utf8' });
  const missing = [
    ...['x11grab'].filter((d) => !has(d, devices)),
    ...['libx264', 'libx264rgb', 'libvpx-vp9', 'libwebp', 'gif', 'png'].filter((e) => !has(e, encoders)),
    ...['palettegen', 'paletteuse', 'fade', 'overlay', 'trim', 'setpts', 'concat', 'scale', 'crop'].filter((f) => !has(f, filters)),
  ];
  if (missing.length) throw new Error(`${binary} lacks ${missing.join(', ')}, which the captures need`);
  ensureOut();
  console.log(`[marketing] ffmpeg ${binary}, display ${process.env.DISPLAY}`);
}
