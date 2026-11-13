import { statSync } from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

/** The one path call a launch needs: `path.win32`'s in the tests, to read Windows paths on any host. */
type PathApi = Pick<typeof nodePath, 'resolve'>;

/** The switch that asks for an empty window, as `code --new-window` does; the Dock menu, jump list and Linux Action pass it. */
export const NEW_WINDOW_SWITCH = '--new-window';

/** What a launch's command line asked for, once Electron's own arguments are set aside. */
export interface LaunchRequest {
  /** Folders to open, absolute, in the order given. */
  folders: string[];
  newWindow: boolean;
  /** Arguments that named no folder: logged, then ignored. */
  ignored: string[];
}

export interface LaunchArgs {
  /** The launch's whole argv, the executable first. */
  argv: readonly string[];
  /** The directory it was launched from, which a relative folder is read against. */
  cwd: string;
  /**
   * `process.defaultApp`: an unpackaged run (`electron <app dir> …`), whose
   * first argument after the executable is the app itself, not a folder.
   */
  defaultApp: boolean;
  isDirectory?: (path: string) => boolean;
  /** For the tests: Windows paths are checked on any host with `path.win32`. */
  path?: PathApi;
}

/**
 * Read a launch's arguments as `code <folder>` does. Every switch but
 * `--new-window` is Electron's, Chromium's or the OS's (macOS adds `-psn_…`;
 * Playwright adds `--inspect=0`), so it is skipped; what is left is a folder,
 * a path relative to the launch's directory, or a `file://` URI (a Linux
 * launcher's `%U`). Anything that is not a folder on disk is set aside.
 */
export function parseLaunchArgs(args: LaunchArgs): LaunchRequest {
  const path = args.path ?? nodePath;
  const isDirectory = args.isDirectory ?? directoryOnDisk;
  const request: LaunchRequest = { folders: [], newWindow: false, ignored: [] };
  let appSkipped = !args.defaultApp;
  for (const raw of args.argv.slice(1)) {
    if (typeof raw !== 'string' || raw === '') continue;
    if (raw === NEW_WINDOW_SWITCH) { request.newWindow = true; continue; }
    if (raw.startsWith('-')) continue;
    if (!appSkipped) { appSkipped = true; continue; }
    const folder = folderOf(raw, args.cwd, path);
    if (folder !== undefined && isDirectory(folder)) {
      if (!request.folders.includes(folder)) request.folders.push(folder);
    } else {
      request.ignored.push(raw);
    }
  }
  return request;
}

function folderOf(raw: string, cwd: string, path: PathApi): string | undefined {
  if (raw.length > 4096 || raw.includes('\0')) return undefined;
  if (/^file:/i.test(raw)) {
    try {
      return fileURLToPath(raw);
    } catch {
      return undefined;
    }
  }
  // Any other scheme (an `ordewell://` link, a web address) is not a folder.
  if (/^[a-z][a-z0-9+.-]+:\/\//i.test(raw)) return undefined;
  return path.resolve(cwd, raw);
}

function directoryOnDisk(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What a second launch hands the running app through `requestSingleInstanceLock`.
 * Chromium may reorder or add to the argv the `second-instance` event carries,
 * so the launch's own argv and directory travel here too.
 */
export interface LaunchData {
  argv: string[];
  cwd: string;
}

/** The launch data a second launch sent, or undefined for anything malformed. */
export function launchDataOf(value: unknown): LaunchData | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { argv, cwd } = value as Record<string, unknown>;
  if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === 'string') || typeof cwd !== 'string' || cwd === '') return undefined;
  return { argv, cwd };
}

export type LaunchAction =
  /** Open each folder in its own window, or focus the one it is open in. */
  | { kind: 'open'; folders: string[] }
  | { kind: 'welcome' }
  /** Bring back the last window used, as the Dock and the tray do. */
  | { kind: 'show' };

export interface LaunchFacts {
  request: LaunchRequest;
  /** The app's first launch, not a second one handed over to it. */
  first: boolean;
  /** Whether the user lets a plain launch reopen their projects ('Reopen projects on launch'). */
  reopen: boolean;
  /** The project windows open when the app last quit. */
  remembered: readonly string[];
  isDirectory?: (path: string) => boolean;
}

/**
 * What a launch opens. A folder argument wins, then `--new-window`; a plain
 * first launch reopens last session's projects that still exist, or the
 * welcome window; a plain second launch brings the app forward.
 */
export function launchAction(facts: LaunchFacts): LaunchAction {
  const { request } = facts;
  if (request.folders.length > 0) return { kind: 'open', folders: request.folders };
  if (request.newWindow) return { kind: 'welcome' };
  if (!facts.first) return { kind: 'show' };
  const isDirectory = facts.isDirectory ?? directoryOnDisk;
  const restore = facts.reopen ? facts.remembered.filter((folder) => isDirectory(folder)) : [];
  return restore.length > 0 ? { kind: 'open', folders: restore } : { kind: 'welcome' };
}

/**
 * The project windows to reopen next launch. It follows the windows as they
 * open, close and switch, except when the last window closes: that close is
 * the app going away (or idling in the Dock or tray), so what was open just
 * before it is what is kept.
 */
export class OpenProjectsMemory {
  private kept: string[] = [];

  /** The workspaces with a window now, and how many windows of any kind are left. */
  changed(open: readonly string[], windowsLeft: number): void {
    if (open.length === 0 && windowsLeft === 0) return;
    this.kept = [...open];
  }

  list(): string[] {
    return [...this.kept];
  }
}
