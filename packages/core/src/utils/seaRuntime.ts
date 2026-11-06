/**
 * What a standalone binary (a Node single executable application) has instead
 * of the files beside its code. Inside one, `__dirname` and `import.meta.url`
 * point into the executable and no package.json exists, so every runtime file
 * the npm package ships next to `dist/` (the built-in skills, the task
 * Dockerfile) is embedded as a SEA asset under `runtime/`, listed by
 * `runtime/manifest.json` with the version, and extracted to the user's data
 * dir on first use. Nothing here changes the npm install: every answer below
 * is the npm one unless `node:sea` says this process is a binary
 * (ADR-0065 C3; the install method and its upgrade, C9).
 */

import { randomBytes } from 'crypto';
import { existsSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, posix } from 'path';
import { globalDataDir } from './globalDataDir';
import { ensurePrivateDir } from './privateFile';

/** The slice of `node:sea` this module reads. */
export interface SeaModule {
  isSea(): boolean;
  getAsset(key: string): ArrayBuffer;
  getAsset(key: string, encoding: string): string;
}

export interface SeaDeps {
  /** `node:sea`, or null where it does not exist; the real module by default. */
  sea?: SeaModule | null;
  /** Where `runtime/<version>/` goes; `globalDataDir()` by default. */
  dataDir?: string;
  /** The running executable; `process.execPath` by default. */
  execPath?: string;
  /** `realpathSync` by default. */
  realpath?: (path: string) => string;
}

function loadSea(): SeaModule | null {
  try {
    // `getBuiltinModule` rather than `require`, which the ESM build lacks.
    // It and `node:sea` are both missing from older Nodes the npm package
    // still runs on (>=20.3), and every binary embeds a Node that has both:
    // a process lacking either is no binary.
    return (process.getBuiltinModule?.('node:sea') as SeaModule | undefined) ?? null;
  } catch {
    return null;
  }
}

function seaOf(deps: SeaDeps): SeaModule | null {
  return deps.sea === undefined ? loadSea() : deps.sea;
}

/** True only inside the standalone binary. */
export function isSea(deps: SeaDeps = {}): boolean {
  const sea = seaOf(deps);
  if (!sea) return false;
  try {
    return sea.isSea();
  } catch {
    return false;
  }
}

const MANIFEST_KEY = 'runtime/manifest.json';

interface Manifest {
  version: string;
  /** Paths relative to packages/core, forward slashes; each is the asset `runtime/<path>`. */
  files: string[];
}

function readManifest(sea: SeaModule): Manifest {
  const raw: unknown = JSON.parse(sea.getAsset(MANIFEST_KEY, 'utf8'));
  const { version, files } = (raw ?? {}) as { version?: unknown; files?: unknown };
  if (typeof version !== 'string' || !version) throw new Error(`${MANIFEST_KEY} names no version`);
  if (!Array.isArray(files) || !files.every((file): file is string => typeof file === 'string')) {
    throw new Error(`${MANIFEST_KEY} lists no files`);
  }
  return { version, files };
}

/** The binary's version, as its build embedded it; undefined outside a binary. */
export function seaVersion(deps: SeaDeps = {}): string | undefined {
  const sea = seaOf(deps);
  if (!sea || !isSea({ sea })) return undefined;
  return readManifest(sea).version;
}

/** Written last, so a folder holding it holds every file. */
const COMPLETE_MARKER = '.complete';

/**
 * The binary's runtime files on disk, extracted on first use to
 * `<data dir>/runtime/<version>/` (`skills/...`, `docker/...`), the layout the
 * npm package has at its root. The TUI and the daemon it starts both reach
 * here at once, so each extracts into a folder of its own and renames it into
 * place: whichever rename lands second finds a complete folder and uses it.
 */
export function seaRuntimeDir(deps: SeaDeps = {}): string {
  const sea = seaOf(deps);
  if (!sea || !isSea({ sea })) throw new Error('seaRuntimeDir: not running as the standalone binary');
  const manifest = readManifest(sea);
  const root = join(deps.dataDir ?? globalDataDir(), 'runtime');
  const dir = join(root, manifest.version);
  if (existsSync(join(dir, COMPLETE_MARKER))) return dir;

  ensurePrivateDir(root);
  const temp = join(root, `.${manifest.version}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    extractInto(temp, sea, manifest.files);
    if (!moveIntoPlace(temp, dir)) throw new Error(`could not extract the runtime files to ${dir}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return dir;
}

function extractInto(temp: string, sea: SeaModule, files: string[]): void {
  ensurePrivateDir(temp);
  for (const file of files) {
    const normal = posix.normalize(file);
    // The manifest is the build's, but a path that climbs out would write
    // anywhere the user can: refuse it rather than trust it.
    if (posix.isAbsolute(normal) || normal === '..' || normal.startsWith('../')) {
      throw new Error(`runtime file ${file} would escape the runtime folder`);
    }
    const target = join(temp, ...normal.split('/'));
    ensurePrivateDir(dirname(target));
    writeFileSync(target, Buffer.from(sea.getAsset(`runtime/${file}`)), { mode: 0o600, flag: 'wx' });
  }
  writeFileSync(join(temp, COMPLETE_MARKER), '', { mode: 0o600, flag: 'wx' });
}

/** True once `dir` holds a complete extraction, this one or another process's. */
function moveIntoPlace(temp: string, dir: string): boolean {
  for (let tries = 0; tries < 2; tries++) {
    try {
      renameSync(temp, dir);
      return true;
    } catch {
      // A rename onto a non-empty folder fails on every platform: the folder
      // is either another process's finished extraction, or a half-filled one
      // something else left there, which is replaced.
      if (existsSync(join(dir, COMPLETE_MARKER))) return true;
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return existsSync(join(dir, COMPLETE_MARKER));
}

/** How this copy of Ordewell was installed, which decides how it is upgraded. */
export type InstallMethod = 'npm' | 'homebrew' | 'binary';

/**
 * Homebrew links its `bin/` into the prefix and keeps the real file in the
 * Cellar, so the real path says brew where the one on PATH may not. `/usr/local`
 * alone is not brew's: the installer may put a binary in its `bin/` too.
 */
const HOMEBREW_PATHS = ['/opt/homebrew/', '/usr/local/Cellar/', '/home/linuxbrew/.linuxbrew/'];

export function installMethod(deps: SeaDeps = {}): InstallMethod {
  if (!isSea(deps)) return 'npm';
  const execPath = deps.execPath ?? process.execPath;
  let real = execPath;
  try {
    real = (deps.realpath ?? realpathSync)(execPath);
  } catch {
    // An executable whose path no longer resolves is judged by the path it ran from.
  }
  const forward = real.replace(/\\/g, '/');
  const brewed = forward.includes('/Cellar/ordewell/') || HOMEBREW_PATHS.some((prefix) => forward.startsWith(prefix));
  return brewed ? 'homebrew' : 'binary';
}

/** The command that upgrades a copy installed this way, for the update line. */
export function upgradeCommand(method: InstallMethod): string {
  switch (method) {
    case 'homebrew': return 'brew upgrade ordewell';
    case 'binary': return 'curl -fsSL https://ordewell.ai/install.sh | sh';
    case 'npm': return 'npm i -g ordewell';
  }
}
