import * as fs from 'fs';
import * as path from 'path';
import type { IsolationRun } from '../interfaces/IWorktreeIsolation';
import { STATE_DIR } from '../utils/fsHelpers';

/*
 * The state root, apart from the code root (ADR-0055 D11). Not in
 * `isolationRecord`, which a webview bundles and which must not reach `fs`.
 */

/** Where a run's own files live: one path with its code root on a flat run. */
export function stateRootOf(run: Pick<IsolationRun, 'workspaceRoot' | 'stateRoot'>): string {
  return run.stateRoot ?? run.workspaceRoot;
}

/** The directory every run under a state root keeps its worktrees in, at any depth. */
export function worktreesDirOf(stateRoot: string): string {
  return path.join(stateRoot, STATE_DIR, 'worktrees');
}

function resolved(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

/**
 * Whether `codeRoot` is a task's workspace under `stateRoot` and not the user's
 * checkout. Git cannot tell: to it a task worktree is a repository like any
 * other, and `mergeIntoCheckedOut` merges into whatever is checked out.
 */
export function isTaskWorkspaceOf(stateRoot: string, codeRoot: string): boolean {
  const rel = path.relative(resolved(worktreesDirOf(stateRoot)), resolved(codeRoot));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Only the root touches the user's branch (ADR-0055 D12): a child's code root is a delegated task's worktree, or the child is not built. */
export function refuseUsersCheckout(codeRoot: string, stateRoot: string): void {
  if (!isTaskWorkspaceOf(stateRoot, codeRoot)) {
    throw new Error(`A child plan runs in its delegated task's worktree, never in the user's checkout: ${codeRoot} is not under ${worktreesDirOf(stateRoot)}.`);
  }
}
