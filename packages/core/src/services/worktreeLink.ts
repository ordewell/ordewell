import * as fs from 'fs';
import * as path from 'path';

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

export interface MirrorOptions {
  platform: NodeJS.Platform;
  /** The checkout `source` lives in, and the one `target` stands in for it. */
  from: string;
  to: string;
  hardLink?: (existing: string, link: string) => void;
}

/**
 * What tools keep in an install's top level for themselves, which is no part
 * of the install. Vite takes `node_modules/.vite` under the nearest
 * `package.json` and reads no environment to say otherwise, so a link here
 * would have a task write the main checkout's cache, which a sealed run cannot
 * (ADR-0013). Left out, each tool makes its own in the worktree's real
 * directory.
 */
const TOOL_CACHES: ReadonlySet<string> = new Set(['.cache', '.vite', '.vite-temp', '.vitest']);

/**
 * Make `source`'s entries appear in a real directory at `target`, one link per
 * entry, going one level into `@scope` and `.bin` directories, and leaving out
 * {@link TOOL_CACHES}. Returns the entries that had to be copied, relative to
 * `target`.
 */
export function mirrorDir(source: string, target: string, opts: MirrorOptions): string[] {
  const copied: string[] = [];
  const links: Array<{ from: string; to: string; name: string }> = [];
  const mirror = (from: string, to: string, prefix: string, top: boolean): void => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (top && TOOL_CACHES.has(entry.name)) continue;
      const name = path.join(prefix, entry.name);
      const at = { from: path.join(from, entry.name), to: path.join(to, entry.name), name };
      if (entry.isSymbolicLink()) links.push(at);
      else if (top && entry.isDirectory() && (entry.name.startsWith('@') || entry.name === '.bin')) mirror(at.from, at.to, name, false);
      else if (linkPath(at.from, at.to, opts.platform, opts.hardLink) === 'copy') copied.push(name);
    }
  };
  mirror(source, target, '', true);

  // On Windows a link is made from what it leads to, which may be another
  // link not made yet, so the links go last and retry until none progresses.
  let pending = links;
  for (let before = Infinity; pending.length > 0 && pending.length < before;) {
    before = pending.length;
    pending = pending.filter((link) => {
      const kind = relink(link.from, link.to, opts);
      if (kind === 'copy') copied.push(link.name);
      return kind === null;
    });
  }
  return copied;
}

/**
 * Recreate the link at `from` at `to`. A relative one keeps its text, so a
 * workspace link such as `../../packages/core` resolves inside the task
 * checkout; an absolute one into the main checkout is moved to the same place
 * in the task checkout, except into a node_modules, which is the shared install.
 * A relative link leading nowhere in the task checkout gets the same place
 * there as the task has, since a package gone from the main checkout is not
 * something a task without it resolves anything through.
 */
function relink(from: string, to: string, opts: MirrorOptions): LinkKind | null {
  const text = fs.readlinkSync(from);
  const pointee = path.isAbsolute(text) ? rebased(text, opts) : text;
  if (opts.platform !== 'win32') {
    if (!fs.existsSync(path.resolve(path.dirname(to), pointee)) && fs.existsSync(path.resolve(path.dirname(from), pointee))) {
      fs.symlinkSync(rebased(path.resolve(path.dirname(from), pointee), opts), to);
      return 'symlink';
    }
    fs.symlinkSync(pointee, to);
    return 'symlink';
  }
  // A junction needs an absolute target, and whether it can be one at all
  // depends on what the link leads to, so resolve it where it will live. One
  // that leads nowhere there has nothing to share.
  const resolved = fs.existsSync(path.resolve(path.dirname(to), pointee))
    ? path.resolve(path.dirname(to), pointee)
    : rebased(path.resolve(path.dirname(from), pointee), opts);
  try { fs.statSync(resolved); } catch { return null; }
  return linkPath(resolved, to, opts.platform, opts.hardLink);
}

function rebased(pointee: string, opts: MirrorOptions): string {
  const rel = path.relative(opts.from, pointee);
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  return inside && !rel.split(/[\\/]/).includes('node_modules') ? path.join(opts.to, rel) : pointee;
}
