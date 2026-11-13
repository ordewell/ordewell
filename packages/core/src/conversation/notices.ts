import { executionSummary, type ExecutionSummary, type RunView, type SessionMessage } from '../services/SessionMessage';
import { walkPlan } from '../services/PlanTree';
import { isTaskRunning } from '../taskRow/status';

/**
 * The built-in runners by the names people know them by. Kept here rather than
 * read from the manifests, which pull in Node-only discovery code this
 * browser-safe module cannot load.
 */
const RUNNER_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** The conversation line for a task starting, worded the same on every surface. */
export function taskStartedNotice(title: string, runner?: string): string {
  if (!runner) return `Started "${title}"`;
  // A runner Ordewell does not ship keeps its id: that is the only name it has.
  return `Started "${title}" · ${Object.hasOwn(RUNNER_NAMES, runner) ? RUNNER_NAMES[runner] : runner}`;
}

/** What a surface says differently from the others about the line a run message earns. */
export interface RunNoticeOptions {
  /**
   * How this surface approves a plan (the TUI's `/approve`). A surface that
   * shows a button for it names nothing, and the line then stops at the ask.
   */
  approveWith?: string;
}

/**
 * The conversation line a run message earns, or null when it earns none.
 * Every surface calls this with each message it receives, so a run reads the
 * same in the TUI, VS Code and the desktop app (ADR-0017): the wording and the
 * decision to speak at all are made here, not rebuilt from the raw message by
 * each surface.
 *
 * `run` is the run as it stood before the message folded into it. A start
 * notice depends on that: a task the run already shows at work has started
 * once, and a second notice for it is a duplicate that slipped through (a
 * retry comes back through pending, so a genuine second start still speaks).
 */
export function runNotice(message: SessionMessage, run: RunView, { approveWith }: RunNoticeOptions = {}): string | null {
  switch (message.type) {
    case 'task_started': {
      const known = [...walkPlan(run.tasks)].find(({ task }) => task.id === message.taskId);
      return known && isTaskRunning(known.task) ? null : taskStartedNotice(message.title, message.runner);
    }
    case 'review_needed':
      return approveWith ? `Plan needs your sign-off: ${approveWith} to continue.` : 'Plan needs your sign-off.';
    case 'review_approved':
      return 'Plan approved.';
    case 'execution_complete':
      return executionNotice('finished', message.summary);
    // A stop sends no tally, and defaulting it to zero reported a run halted
    // after four of five tasks as "0/5 complete". The run holds each task's
    // status as the stream last said it, so count those.
    case 'execution_stopped':
      return executionNotice('stopped', executionSummary([...walkPlan(run.tasks)].map(({ task }) => task)));
    default:
      return null;
  }
}

function executionNotice(verb: 'finished' | 'stopped', { completed, total, failed, blocked, skipped }: ExecutionSummary): string {
  const failures = `${failed > 0 ? ` · ${failed} failed` : ''}${blocked ? ` · ${blocked} blocked` : ''}${skipped ? ` · ${skipped} skipped` : ''}`;
  return `Execution ${verb}: ${completed}/${total} tasks complete${failures}.`;
}
