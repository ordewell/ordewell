import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export type DroppedFolder = { ok: true; path: string } | { ok: false; message: string };

const NOT_A_FOLDER = 'Drop one folder.';

/**
 * Whether a dropped path may open as a workspace (design W1). It is the one
 * way a page names a folder the picker did not choose, so main takes nothing
 * on trust: the path must be absolute and be a directory on disk now. A file,
 * or a File the page made itself (the preload hands its empty path on), gets
 * the same answer the page shows.
 */
export function droppedFolder(raw: unknown, isDirectory: (path: string) => boolean = directoryOnDisk): DroppedFolder {
  if (typeof raw !== 'string' || raw === '' || raw.length > 4096 || raw.includes('\0') || !isAbsolute(raw)) {
    return { ok: false, message: NOT_A_FOLDER };
  }
  return isDirectory(raw) ? { ok: true, path: raw } : { ok: false, message: NOT_A_FOLDER };
}

function directoryOnDisk(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
