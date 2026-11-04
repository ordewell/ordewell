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
  /** A device that reads nothing and writes nowhere but the command's own streams: `/dev/null`. */
  device?: true;
  /**
   * A path the shell reads by rules this check cannot follow (`HostPath`), so
   * it is judged to be nowhere: a command naming it is refused, not asked about,
   * since no folder an approval could name is the one it reaches.
   */
  unfollowable?: true;
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

/**
 * Where a path a command names lands on the host, run from the host folder
 * `from`, for a shell that reads paths its own way (`ResearchShell.hostPath`):
 * Git Bash's `/c/x` is `C:\x`. Undefined when the shell's reading of it cannot
 * be followed for certain.
 */
export type HostPath = (spelled: string, from: string) => string | undefined;

/**
 * `from` is where a relative `target` starts; containment is still judged against `root`.
 * `hostPath` reads `target` as the shell running it will, which also knows its devices.
 */
export function resolveWithin(root: string, target: string, from: string = root, hostPath?: HostPath): ResolvedPath {
  const spelled = hostPath ? hostPath(target, from) : target;
  if (spelled === undefined) return { abs: target, inside: false, unfollowable: true };
  // The shell's own device, which is no place on the host's disk to resolve.
  if (hostPath && isInertDevice(spelled)) return { abs: spelled, inside: false, device: true };
  const abs = path.resolve(from, expandHome(spelled));
  const rel = path.relative(root, abs);
  return { abs, inside: rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)), ...(isInertDevice(abs) ? { device: true as const } : {}) };
}

/**
 * Where a `PathRef` is relative to: the workspace root with each `cd` target
 * applied in turn. The chain may leave the workspace; the path is then judged
 * from where the shell will be, and the `cd` that left was asked about itself.
 */
export function resolveRef(root: string, ref: { path: string; cwd: string[] }, hostPath?: HostPath): ResolvedPath {
  let from = root;
  for (const target of ref.cwd) {
    const dir = resolveWithin(root, target, from, hostPath);
    // After a `cd` nobody can follow, no path is anywhere certain.
    if (dir.unfollowable) return { abs: ref.path, inside: false, unfollowable: true };
    from = dir.abs;
  }
  return resolveWithin(root, ref.path, from, hostPath);
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

/**
 * Device files that read nothing and write nowhere but the command's own
 * streams. `curl -o /dev/null` discards a response; it is not a reach outside
 * the workspace, and asking about it taught people to approve `/dev/*`.
 */
const INERT_DEVICES = ['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr'];

export function isInertDevice(abs: string): boolean {
  return INERT_DEVICES.includes(abs);
}
