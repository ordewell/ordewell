import { isTaskRunning, STALLED_LABEL, taskStatusKind } from '../taskRow/status';
import type { StructuredTurnEnd } from '../interfaces/IRunner';
import type { DisplayBlock, SubagentBlock } from './blocks';

/** What the label reads: a `TaskLogView`'s blocks, which is all a webview holds of one. */
type LoggedBlocks = { readonly blocks: readonly DisplayBlock[]; readonly turnStartedAt?: string };

/** What {@link taskActivity} reads of a log: the view's turn flag, and whether the log is an attempt the runner is no longer in. */
type LoggedTurn = LoggedBlocks & {
  /** A turn is open in the log, as its `turn_start` said; a log that streams without one has open blocks but this unset. Absent where a surface holds no such flag, which reads as open. */
  readonly working?: boolean;
  /** How the last turn ended, as the view says; set means the log has seen a turn end, so what it left open is not a turn. */
  readonly lastTurnEnd?: StructuredTurnEnd;
  /** The log is an earlier attempt, browsed: whatever it left open ended with it. */
  readonly archived?: boolean;
};

/**
 * What a task's runner is busy with, from its log: the latest block still
 * open decides, since that is what the runner is doing now. Several running
 * subagents are counted rather than named, as no one of them is the task's
 * latest work. The label holds runner output — a surface sanitizes it.
 */
export function activityLabel(view: LoggedBlocks): string {
  for (let i = view.blocks.length - 1; i >= 0; i--) {
    const label = openLabel(view.blocks[i], view);
    if (label) return label;
  }
  return 'Working…';
}

/**
 * Whether the runner is at work, which is the one rule for the line showing:
 * a turn is open (`working`, absent reading as open); or a subagent is running,
 * which a turn's end does not stop; or the log has seen no turn end yet and
 * holds an open block (a stream whose `turn_start` this view never saw). Once a
 * turn has ended, a dangling tool call or a late delta is not a turn.
 */
function isAtWork(view: LoggedTurn): boolean {
  if (view.working !== false) return true;
  if (view.blocks.some((b) => b.type === 'subagent' && b.status === 'running')) return true;
  return view.lastTurnEnd === undefined && view.blocks.some((b) => openLabel(b, view) !== null);
}

function openLabel(block: DisplayBlock, view: LoggedBlocks): string | null {
  switch (block.type) {
    case 'thinking': return block.streaming ? 'Thinking…' : null;
    case 'message': return block.streaming ? 'Writing…' : null;
    case 'tool': {
      if (block.status !== 'pending') return null;
      const { name, keyArg } = block.headline;
      return keyArg ? `Running ${name}(${keyArg})…` : `Running ${name}…`;
    }
    case 'subagent': {
      if (block.status !== 'running') return null;
      const running = view.blocks.filter((b): b is SubagentBlock => b.type === 'subagent' && b.status === 'running');
      return running.length > 1 ? `${running.length} subagents running…` : `Subagent: ${block.brief}…`;
    }
    default: return null;
  }
}

/** The line above a composer: `busy` animates, and a quiet task's does not. */
export interface TaskActivity {
  label: string;
  busy: boolean;
  /** When the open turn began (ISO): a surface counts from it on its own ticks (#81). Absent for a log saved before turns were dated. */
  since?: string;
}

/**
 * The activity line of an open task log, or null when it has none to show: a
 * task not running, and one waiting on a runner request, whose card in the log
 * already asks the user. A running task whose runner has gone quiet is named
 * as the plan pane names it and is never `busy`, so a runner that is not
 * producing anything cannot look as if it were. Nor can a runner between
 * turns: `busy` needs an open turn, a running subagent that outlived it, or,
 * in a log that has seen no turn end, a block still open (a stream whose
 * `turn_start` this view never saw).
 * A browsed earlier attempt has no line, whatever its log was left open on.
 */
export function taskActivity(view: LoggedTurn, task: { status: string; idleSince?: string | null; awaitingApproval?: number }): TaskActivity | null {
  if (!isTaskRunning(task) || view.archived) return null;
  if (task.awaitingApproval || view.blocks.some((b) => b.type === 'approval' && b.status === 'pending')) return null;
  const since = view.turnStartedAt ? { since: view.turnStartedAt } : {};
  if (taskStatusKind(task) === 'quiet') return { label: STALLED_LABEL, busy: false, ...since };
  if (!isAtWork(view)) return null;
  return { label: activityLabel(view), busy: true, ...since };
}
