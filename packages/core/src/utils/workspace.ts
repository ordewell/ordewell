import * as fs from 'fs';

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
