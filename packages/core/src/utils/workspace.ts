import * as fs from 'fs';
import * as path from 'path';

/**
 * A workspace path that does not exist, or exists but is not a directory.
 * Checked at every surface that starts a planner or spawns an agent inside
 * one: a shell whose own cwd was deleted still reports the stale path from
 * `process.cwd()`, so a stat is the only reliable signal, never the string
 * itself. Left unchecked, the underlying failure is `spawn`'s ENOENT — which
 * reads as a missing binary, not a missing directory. No status code: this is
 * transport-agnostic, and each surface maps it to its own response shape.
 */
export class WorkspaceNotFoundError extends Error {
  constructor(readonly workspace: string) {
    super(`Workspace "${workspace}" does not exist.`);
    this.name = 'WorkspaceNotFoundError';
  }
}

export interface WorkspaceCheckDeps {
  /** True when `candidate` names an existing directory. Defaults to a real `fs.statSync`. */
  isDirectory?: (candidate: string) => boolean;
}

function defaultIsDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Throws {@link WorkspaceNotFoundError} unless `workspace` names an existing directory. */
export function assertWorkspaceExists(workspace: string, deps: WorkspaceCheckDeps = {}): void {
  const isDirectory = deps.isDirectory ?? defaultIsDirectory;
  if (!isDirectory(workspace)) throw new WorkspaceNotFoundError(workspace);
}

/**
 * A workspace whose resolved path carries none of the markers below. Thrown
 * instead of admitting the directory as-is: without this, a request pointed
 * at the filesystem root or an arbitrary system directory becomes the
 * confinement boundary for every read, search and permitted command the
 * planner runs, by definition. A denylist of "dangerous" roots was rejected
 * for the same reason as the other denylists in this project's remediation —
 * it would still admit unlisted system directories.
 */
export class WorkspaceNotAProjectError extends Error {
  constructor(readonly workspace: string) {
    super(`Workspace "${workspace}" is not a project directory (no .ordewell state, version control, or recognized manifest found).`);
    this.name = 'WorkspaceNotAProjectError';
  }
}

/** State and version-control directories that mark a project root. */
const PROJECT_MARKER_DIRS = ['.ordewell', '.git', '.hg', '.svn', '.bzr'];

/**
 * Manifest files from ecosystems common enough to show up as someone's first
 * `ordewell plan` in a freshly cloned repo, before any `.ordewell/` state or
 * even a `.git` checkout exists (e.g. a tarball extract).
 */
const PROJECT_MARKER_FILES = [
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Pipfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'pubspec.yaml',
  'mix.exs',
  'CMakeLists.txt',
];

export interface WorkspaceProjectCheckDeps {
  /** Resolves symlinks/`..` segments to a canonical absolute path. Defaults to `fs.realpathSync`. */
  realpath?: (candidate: string) => string;
  /** True when `candidate` names an existing filesystem entry. Defaults to `fs.existsSync`. */
  exists?: (candidate: string) => boolean;
}

/**
 * Throws {@link WorkspaceNotAProjectError} unless `workspace` resolves to a
 * directory carrying at least one project marker. Resolves the path first —
 * via `realpath`, not string inspection — so a request that traverses
 * through symlinks or `..` segments is judged on where it actually lands,
 * not on the path as written.
 */
export function assertWorkspaceIsProject(workspace: string, deps: WorkspaceProjectCheckDeps = {}): void {
  const realpath = deps.realpath ?? ((candidate: string) => fs.realpathSync(candidate));
  const exists = deps.exists ?? ((candidate: string) => fs.existsSync(candidate));

  let resolved: string;
  try {
    resolved = realpath(workspace);
  } catch {
    throw new WorkspaceNotAProjectError(workspace);
  }

  const hasMarker = [...PROJECT_MARKER_DIRS, ...PROJECT_MARKER_FILES].some((marker) =>
    exists(path.join(resolved, marker)),
  );
  if (!hasMarker) throw new WorkspaceNotAProjectError(workspace);
}
