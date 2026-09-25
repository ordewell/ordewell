import * as fs from 'fs';

/** How a path from the real workspace was made to appear in a task workspace. Only `copy` is not live. */
export type LinkKind = 'symlink' | 'junction' | 'hardlink' | 'copy';

/**
 * Make `source` appear at `target`, live where the platform allows it without
 * privilege (ADR-0010): symlinks on POSIX; on Windows a junction for a
 * directory and a hard link for a file, since a symlink needs Developer Mode or
 * admin there. A hard link cannot cross volumes, so that case falls back to a
 * copy, which the caller must report because edits to it stay in the task.
 */
export function linkPath(
  source: string,
  target: string,
  platform: NodeJS.Platform,
  hardLink: (existing: string, link: string) => void = fs.linkSync,
): LinkKind {
  const isDir = fs.statSync(source).isDirectory();
  if (platform !== 'win32') {
    fs.symlinkSync(source, target, isDir ? 'dir' : 'file');
    return 'symlink';
  }
  if (isDir) {
    fs.symlinkSync(source, target, 'junction');
    return 'junction';
  }
  try {
    hardLink(source, target);
    return 'hardlink';
  } catch {
    fs.copyFileSync(source, target);
    return 'copy';
  }
}
