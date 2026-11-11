/**
 * The one ffmpeg the marketing captures grab and encode with: a static build
 * with libx264, libvpx and x11grab, pinned in ffmpeg.json by the sha256 of its
 * release asset and kept under the repository's .tools/ (gitignored), as
 * scripts/shellcheck.mjs keeps shellcheck. A distribution's ffmpeg may lack
 * x11grab or libx264, and a root-less machine has none, so PATH is never read.
 * ORDEWELL_FFMPEG names another binary to use instead.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ROOT } from '../fixtures';

interface Pin { version: string; source: string; archives: Record<string, { file: string; sha256: string } | undefined> }

const PIN = JSON.parse(fs.readFileSync(path.join(__dirname, 'ffmpeg.json'), 'utf8')) as Pin;
export const OVERRIDE_ENV = 'ORDEWELL_FFMPEG';

const platformKey = (): string => `${process.platform}-${process.arch}`;
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function cached(): { binary: string; archive: string; sha256: string; url: string } {
  const entry = PIN.archives[platformKey()];
  if (!entry) throw new Error(`ffmpeg ${PIN.version} is pinned for ${Object.keys(PIN.archives).join(', ')}, not ${platformKey()}; set ${OVERRIDE_ENV}`);
  const dir = path.join(ROOT, '.tools', 'ffmpeg', PIN.version, platformKey());
  return { binary: path.join(dir, 'ffmpeg'), archive: path.join(dir, entry.file), sha256: entry.sha256, url: PIN.source + entry.file };
}

/**
 * The pin records the asset's sha256, not the binary's, so the cache keeps the
 * asset beside the binary, and a hit is the binary that verified asset holds.
 */
function cacheHolds(where: ReturnType<typeof cached>): boolean {
  if (!fs.existsSync(where.binary) || !fs.existsSync(where.archive)) return false;
  const bytes = fs.readFileSync(where.archive);
  return sha256(bytes) === where.sha256 && gunzipSync(bytes).equals(fs.readFileSync(where.binary));
}

function writeAtomically(target: string, bytes: Buffer, mode: number): void {
  const partial = `${target}.${process.pid}.partial`;
  try {
    fs.writeFileSync(partial, bytes);
    fs.chmodSync(partial, mode);
    fs.renameSync(partial, target);
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

/** The ffmpeg to run: the override, or the pinned build, fetched and verified on first use. */
export async function ffmpegPath(log: (line: string) => void = () => undefined): Promise<string> {
  const chosen = process.env[OVERRIDE_ENV];
  if (chosen) {
    if (!fs.existsSync(chosen)) throw new Error(`${OVERRIDE_ENV}=${chosen} does not exist`);
    return chosen;
  }
  const where = cached();
  if (cacheHolds(where)) return where.binary;
  log(`fetching ffmpeg ${PIN.version} from ${where.url}`);
  let bytes: Buffer | undefined;
  for (let attempt = 1; !bytes; attempt++) {
    try {
      const response = await fetch(where.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt >= 4) throw new Error(`could not download ${where.url}: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
  const got = sha256(bytes);
  // A wrong digest is refused outright: fetching again would fetch the same wrong bytes.
  if (got !== where.sha256) throw new Error(`${where.url} has sha256 ${got}, not the pinned ${where.sha256}: refusing it`);
  fs.mkdirSync(path.dirname(where.binary), { recursive: true });
  writeAtomically(where.archive, bytes, 0o644);
  writeAtomically(where.binary, gunzipSync(bytes), 0o755);
  return where.binary;
}

/** Runs ffmpeg to completion, failing with the tail of its log. */
export async function ffmpeg(args: readonly string[]): Promise<void> {
  const binary = await ffmpegPath();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    child.stderr.on('data', (chunk: Buffer) => { log = (log + chunk.toString()).slice(-4000); });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg ${args.join(' ')} exited ${code ?? signal}: ${log.trim()}`));
    });
  });
}

/** A long-running ffmpeg, stopped by its own PID with `q` on stdin, which lets it finish the file. */
export interface Running { child: ChildProcess; stop(): Promise<void> }

export async function ffmpegStart(args: readonly string[]): Promise<Running> {
  const binary = await ffmpegPath();
  const child = spawn(binary, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['pipe', 'ignore', 'pipe'] });
  let log = '';
  child.stderr?.on('data', (chunk: Buffer) => { log = (log + chunk.toString()).slice(-4000); });
  const exited = new Promise<number | null>((resolve) => { child.on('exit', (code) => resolve(code)); });
  return {
    child,
    async stop() {
      if (child.exitCode === null) {
        child.stdin?.end('q');
        const late = setTimeout(() => child.kill('SIGINT'), 10_000);
        const code = await exited;
        clearTimeout(late);
        if (code !== 0 && code !== null) throw new Error(`ffmpeg ${args.join(' ')} exited ${code}: ${log.trim()}`);
      }
    },
  };
}

/** The duration of a media file in seconds, read from ffmpeg's own probe of it. */
export async function durationOf(file: string): Promise<number> {
  const binary = await ffmpegPath();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['-hide_banner', '-nostdin', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    child.stderr.on('data', (chunk: Buffer) => { log += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', () => {
      const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
      if (!match) { reject(new Error(`no duration in ffmpeg's probe of ${file}`)); return; }
      resolve(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    });
  });
}
