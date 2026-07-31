import * as os from 'os';
import * as path from 'path';

/**
 * Workspace containment, in one place. Both the filesystem policy layer
 * (which may ask the user to approve an escape) and the research-subagent
 * wrapper (which may not, because nothing can prompt on its behalf) need the
 * same answer to "is this path inside the workspace", so neither re-derives it.
 *
 * Symlinks are resolved lexically, not on disk: a symlink inside the workspace
 * pointing outward still reads as inside. Closing that would mean a `realpath`
 * syscall on every path check, and the threat model here is an LLM wandering,
 * not an adversary planting links in a repo the user already trusts enough to
 * point Ordewell at.
 */
export interface ResolvedPath {
  abs: string;
  inside: boolean;
}

/**
 * `~` is expanded here because the *shell* will expand it later. Left alone,
 * `path.resolve(root, '~/.ssh/id_rsa')` yields `<root>/~/.ssh/id_rsa`, which
 * reads as inside the workspace — so `cat ~/.ssh/id_rsa` passed confinement
 * unprompted and then read the real file once the shell got hold of it.
 */
function expandHome(target: string): string {
  if (!target.startsWith('~')) return target;
  const home = os.homedir();
  if (target === '~' || target.startsWith('~/')) return path.join(home, target.slice(1));
  // `~otheruser/…` resolved as a sibling of this user's home. Wrong on exotic
  // layouts, but it reliably lands outside the workspace, so the access
  // prompts rather than silently passing.
  return path.join(path.dirname(home), target.slice(1));
}

export function resolveWithin(root: string, target: string): ResolvedPath {
  const abs = path.resolve(root, expandHome(target));
  const rel = path.relative(root, abs);
  return { abs, inside: rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) };
}

/** The directory a grant covers for `target` — its parent for files, itself for directories. */
export function grantScopeFor(abs: string, kind: 'file' | 'directory'): string {
  if (kind === 'directory') return path.join(abs, '*');
  const parent = path.dirname(abs);
  // A path immediately under the filesystem root (e.g. `/etc`) has the root as
  // its parent; scoping to `/*` would approve every top-level directory, so
  // scope to the directory itself instead.
  if (parent === path.parse(abs).root) return path.join(abs, '*');
  return path.join(parent, '*');
}
