import { statSync } from 'node:fs';
import type { RouteId, RouteParams } from '../../shared/routes';
import { taskOf, terminalScopeDecision, type TerminalScope } from '../../shared/terminalScope';
import { resolveTarget } from '../shell';

/**
 * The directory a terminal starts in. The page names a repo and a scope and
 * never a path: the checkout is a folder of the window's own workspace, and a
 * task's worktree is the one the daemon's saved isolation records name for it,
 * read here and not taken from the page. The scope rule runs again, against the
 * session as it is now, so a task that started after the menu was drawn is
 * still refused (ADR-0062 G11).
 */

export type Placement = { ok: true; cwd: string; scope: TerminalScope } | { ok: false; message: string };

export interface PlacementDeps {
  call(routeId: RouteId, params: RouteParams): Promise<{ ok: boolean; data?: unknown; error?: string }>;
  isDirectory(path: string): boolean;
}

export const fileSystemPlacement: Pick<PlacementDeps, 'isDirectory'> = {
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length < 1024 && !value.includes('\0');
}

/** A scope the page sent, or undefined when it is not one of the three shapes. */
export function parseScope(raw: unknown): TerminalScope | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.kind === 'checkout') return { kind: 'checkout' };
  if (raw.kind === 'integration' && nonEmpty(raw.sessionId)) return { kind: 'integration', sessionId: raw.sessionId };
  if (raw.kind === 'task' && nonEmpty(raw.sessionId) && nonEmpty(raw.taskId)) {
    return { kind: 'task', sessionId: raw.sessionId, taskId: raw.taskId };
  }
  return undefined;
}

export async function placeTerminal(deps: PlacementDeps, workspace: string, repo: unknown, rawScope: unknown): Promise<Placement> {
  const scope = parseScope(rawScope);
  if (!scope) return { ok: false, message: 'That is not a place a terminal can open.' };

  if (scope.kind === 'checkout') {
    const resolved = resolveTarget(workspace, { repo });
    if (!resolved.ok) return { ok: false, message: resolved.message };
    return deps.isDirectory(resolved.path)
      ? { ok: true, cwd: resolved.path, scope }
      : { ok: false, message: 'That repository is not a folder in the workspace.' };
  }

  const refused = (reason: string): Placement => ({ ok: false, message: reason });
  const decided = terminalScopeDecision(scope, undefined);
  if (scope.kind === 'integration') return refused(decided.ok ? 'No worktree.' : decided.reason);

  // taskId and repo are checked as path segments and a repo name by the route builder and resolveTarget.
  const checked = resolveTarget(workspace, { repo });
  if (!checked.ok) return { ok: false, message: checked.message };
  const session = await deps.call('sessions.get', { id: scope.sessionId, workspace });
  if (!session.ok) return refused('Could not read the run to check that the task is stopped.');
  const task = taskOf(session.data, scope.taskId);
  const decision = terminalScopeDecision(scope, task);
  if (!decision.ok) return refused(decision.reason);

  const branches = await deps.call('git.branches', { workspace, repo: repo as string });
  const worktrees = isRecord(branches.data) && Array.isArray(branches.data.worktrees) ? branches.data.worktrees : [];
  const found = worktrees.find((entry): entry is Record<string, unknown> => (
    isRecord(entry) && entry.main !== true && isRecord(entry.owner)
    && entry.owner.sessionId === scope.sessionId && entry.owner.taskId === scope.taskId && typeof entry.path === 'string'
  ));
  if (!branches.ok || !found) return refused(`Task #${task?.order ?? '?'} has no worktree on disk in this repository.`);
  const cwd = found.path as string;
  if (!deps.isDirectory(cwd)) return refused(`Task #${task?.order ?? '?'}'s worktree is gone from the disk.`);
  return { ok: true, cwd, scope };
}
