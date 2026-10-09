import * as fs from 'fs';
import * as path from 'path';
import { SELF_REPO } from './isolationRecord';
import { NEVER_SCANNED } from './worktreeBootstrap';

// A `.git` file rather than a directory marks a linked worktree or a submodule checkout.
export function hasGitEntry(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

/** A `workspaceRepos` entry as a group path, or null for one that is not below the workspace. */
function groupPathOf(listed: string): string | null {
  const slashed = listed.trim().replace(/\\/g, '/');
  if (path.posix.isAbsolute(slashed) || path.win32.isAbsolute(slashed)) return null;
  const rel = path.posix.normalize(slashed).replace(/\/+$/, '');
  return rel === '' || rel === '.' || rel === '..' || rel.startsWith('../') ? null : rel;
}

export function childDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !NEVER_SCANNED.has(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The repos of a folder that is not itself a repository (ADR-0014): exactly
 * the `listed` paths that hold a `.git` when any are listed, otherwise the
 * repositories directly inside it.
 */
export function groupPaths(workspaceRoot: string, listed: readonly string[]): string[] {
  if (listed.length === 0) return childDirs(workspaceRoot).filter((name) => hasGitEntry(path.join(workspaceRoot, name)));
  const paths = listed
    .map(groupPathOf)
    .filter((rel): rel is string => rel !== null && hasGitEntry(path.join(workspaceRoot, rel)));
  return [...new Set(paths)].sort();
}

/**
 * The workspace's repo group as its files show it, without asking git — for
 * what must be known before, or outside, a run. A workspace in a repository
 * is a group of one at `.`; git's own answer (`rev-parse --show-toplevel`)
 * is approximated by a `.git` in it or above it.
 */
export function workspaceRepoGroup(workspaceRoot: string, listed: readonly string[]): string[] {
  for (let dir = path.resolve(workspaceRoot); ; dir = path.dirname(dir)) {
    if (hasGitEntry(dir)) return [SELF_REPO];
    if (path.dirname(dir) === dir) break;
  }
  return groupPaths(workspaceRoot, listed);
}
