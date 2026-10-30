import { isTaskRunning, STALLED_LABEL, taskStatusKind } from '../taskRow/status';
import type { DisplayBlock, SubagentBlock } from './blocks';

/** What the label reads: a `TaskLogView`'s blocks, which is all a webview holds of one. */
type LoggedBlocks = { readonly blocks: readonly DisplayBlock[] };

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
}

/**
 * The activity line of an open task log, or null when it has none to show: a
 * task not running, and one waiting on a runner request, whose card in the log
 * already asks the user. A running task whose runner has gone quiet is named
 * as the plan pane names it and is never `busy`, so a runner that is not
 * producing anything cannot look as if it were.
 */
export function taskActivity(view: LoggedBlocks, task: { status: string; idleSince?: string | null; awaitingApproval?: number }): TaskActivity | null {
  if (!isTaskRunning(task)) return null;
  if (task.awaitingApproval || view.blocks.some((b) => b.type === 'approval' && b.status === 'pending')) return null;
  if (taskStatusKind(task) === 'quiet') return { label: STALLED_LABEL, busy: false };
  return { label: activityLabel(view), busy: true };
}
