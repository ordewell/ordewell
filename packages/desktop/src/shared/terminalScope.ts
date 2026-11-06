/**
 * Where a terminal may open, and why not (design: Terminal rule, ADR-0062 G11).
 * One rule, read twice: the renderer's menu disables an option with the reason
 * it returns, and main checks it again before it starts a shell, so a page
 * that skips the menu still cannot open one in a worktree a task is using.
 *
 * Pure: no Electron, no Node.
 */

/** Structurally the frame's ViewScope; shared code cannot import from the renderer. */
export type TerminalScope =
  | { kind: 'checkout' }
  | { kind: 'integration'; sessionId: string }
  | { kind: 'task'; sessionId: string; taskId: string };

/** What the rule needs to know about a task: its number and whether an agent is working in its worktree. */
export interface TerminalTask {
  order: number;
  /** The scope store's task state; `running` and `repairing` are agents at work. */
  state: string;
}

export type ScopeDecision = { ok: true } | { ok: false; reason: string };

export function terminalScopeDecision(scope: TerminalScope, task: TerminalTask | undefined): ScopeDecision {
  switch (scope.kind) {
    case 'checkout':
      return { ok: true };
    case 'integration':
      // The integration branch is a ref, not a directory (design: Scope table).
      return { ok: false, reason: 'The integration branch has no worktree to open a terminal in.' };
    case 'task':
      if (!task) return { ok: false, reason: 'This task has no worktree yet.' };
      if (task.state === 'running' || task.state === 'repairing') {
        return { ok: false, reason: `Task #${task.order} is running; a terminal in its worktree would race the agent. Open one when it stops.` };
      }
      return { ok: true };
  }
}

/** The label a terminal tab carries: the scope it opened in, then the repo when the workspace has several. */
export function terminalLabel(scope: TerminalScope, task: Pick<TerminalTask, 'order'> | undefined, repo: string, repoCount: number): string {
  const where = scope.kind === 'checkout' ? 'Your checkout' : scope.kind === 'task' ? `Task #${task?.order ?? '?'} worktree` : 'Integration branch';
  return repoCount > 1 && repo !== '.' ? `${where} · ${repo}` : where;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ISOLATION_STATES: Readonly<Record<string, string>> = {
  active: 'running', integrated: 'landed', conflict: 'conflict', repairing: 'repairing', kept: 'kept',
};

/**
 * A task as a saved session names it (`sessions.get`), which is how main learns
 * whether the task is running without trusting the page. Subtasks are searched
 * too; a task whose isolation has no state has no worktree and reads as absent.
 */
export function taskOf(sessionData: unknown, taskId: string): TerminalTask | undefined {
  const run = isRecord(sessionData) && isRecord(sessionData.run) ? sessionData.run : undefined;
  if (!run) return undefined;
  let count = 0;
  const visit = (tasks: unknown): TerminalTask | undefined => {
    if (!Array.isArray(tasks)) return undefined;
    for (const task of tasks) {
      if (!isRecord(task)) continue;
      const isolation = isRecord(task.isolation) ? task.isolation : undefined;
      const state = typeof isolation?.state === 'string' ? ISOLATION_STATES[isolation.state] : undefined;
      if (state) {
        const order = typeof task.order === 'number' ? task.order : count + 1;
        count += 1;
        if (task.id === taskId) return { order, state };
      }
      const inner = visit(task.subtasks);
      if (inner) return inner;
    }
    return undefined;
  };
  return visit(run.tasks);
}
