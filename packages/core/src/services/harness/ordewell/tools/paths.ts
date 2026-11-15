import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ToolContext } from './types';

/** A path a tool will not touch; its message is what the model reads. */
export class PathRefusal extends Error {}

const MAX_LINK_HOPS = 40;

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}

function nativeRealpath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch (err) {
    // Some volumes refuse the native call where the JS one answers (utils/realPath.ts).
    if (isMissing(err)) throw err;
    return realpathSync(p);
  }
}

/**
 * Where `p` really is, for a path that may not exist yet: the deepest part
 * that exists is resolved with `realpathSync.native` (symlinks and all), and
 * the rest is appended. A symlink that dangles is followed to where its target
 * would be created, since a write through it lands there.
 */
export function realish(p: string, hops = 0): string {
  try {
    return nativeRealpath(p);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  let isLink = false;
  try {
    isLink = lstatSync(p).isSymbolicLink();
  } catch {
    // Nothing at `p`: its parent decides.
  }
  if (isLink) {
    if (hops >= MAX_LINK_HOPS) throw new PathRefusal(`Too many symbolic links resolving ${p}.`);
    return realish(path.resolve(path.dirname(p), readlinkSync(p)), hops + 1);
  }
  const parent = path.dirname(p);
  if (parent === p) return p;
  return path.join(realish(parent, hops), path.basename(p));
}

/** Whether `child` is `root` or under it, as the platform compares paths (case-blind on Windows). */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** `p` as the model should see it: relative to the worktree when it is inside. */
export function display(context: ToolContext, p: string): string {
  const root = realish(context.worktree);
  return isInside(root, p) ? path.relative(root, p) || '.' : p;
}

function absolute(context: ToolContext, raw: string): string {
  if (raw.includes('\0')) throw new PathRefusal('The path contains a NUL character.');
  return path.resolve(context.worktree, raw);
}

/**
 * The real path `edit` and `write` may change: inside the worktree after every
 * symlink and `..` is resolved, whether or not the file exists yet. Callers
 * operate on the returned path, never the spelling they were given, so what
 * was judged is what is touched.
 */
export function resolveWritable(context: ToolContext, raw: string): string {
  const real = realish(absolute(context, raw));
  if (!isInside(realish(context.worktree), real)) {
    throw new PathRefusal(`${raw} resolves outside the worktree (${real}); edit and write only change files inside ${context.worktree}.`);
  }
  return real;
}

/** The real path `read` may open: the worktree, the saved-output directory, and the roots the context adds. */
export function resolveReadable(context: ToolContext, raw: string): string {
  const real = realish(absolute(context, raw));
  const roots = [context.worktree, context.outputDir, ...(context.extraReadRoots ?? [])];
  if (!roots.some((root) => isInside(realish(root), real))) {
    throw new PathRefusal(`${raw} resolves outside the folders this task may read (${real}); read only opens files inside ${context.worktree}.`);
  }
  return real;
}
