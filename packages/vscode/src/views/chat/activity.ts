import type { ResearchStepOutcome } from '@ordewell/core';

/**
 * One unit of live planner activity, rendered in arrival order inside the
 * planner's chat bubble: a thinking block (collapsible, streams open) or a
 * command execution (tool call, folded together with its result).
 */
export interface Activity {
  id: string;
  type: 'thinking' | 'tool_call' | 'tool_result' | 'subagent';
  text: string;
  tool?: string;
  toolArgs?: string;
  /** The model's tool_call id, so the matching result settles this exact line. */
  toolCallId?: string;
  /** For tool calls: the result has arrived and `text` is the summary. For subagents: the digest has arrived. */
  done?: boolean;
  /** How the call ended — drives the icon. Absent while pending. */
  outcome?: ResearchStepOutcome;
  /** Subagent activities only: the nested tool calls it made, in arrival order. */
  children?: Activity[];
  /** The result body, shown under a chevron: a tool call's output, a subagent's digest. */
  resultText?: string;
}

export interface ToolResultUpdate {
  tool: string;
  toolCallId?: string;
  summary: string;
  resultText?: string;
  outcome?: ResearchStepOutcome;
  /** Id for the entry appended when no pending call matches. */
  fallbackId: string;
}

const RESULT_PREVIEW_CHARS = 2000;

/** The head of a tool result, capped so one `grep` cannot flood the bubble. */
export function previewResult(text: string, max = RESULT_PREVIEW_CHARS): string {
  const trimmed = text.trimEnd();
  return trimmed.length > max
    ? `${trimmed.slice(0, max)}\n… [${trimmed.length - max} more characters]`
    : trimmed;
}

/**
 * Settle the pending tool_call this result belongs to, or append a completed
 * entry when none matches. Shared by the top-level activity list and a
 * subagent's nested children.
 */
export function applyToolResult(activities: Activity[], update: ToolResultUpdate): Activity[] {
  const index = pendingIndex(activities, update);
  const settled = {
    text: update.summary,
    done: true,
    outcome: update.outcome,
    resultText: update.resultText,
  };
  if (index < 0) {
    return [...activities, { id: update.fallbackId, type: 'tool_call', tool: update.tool, ...settled }];
  }
  const next = [...activities];
  next[index] = { ...activities[index], ...settled };
  return next;
}

/**
 * Id match first: matching by tool name alone mislabels a parallel round,
 * where several calls to the same tool are pending at once and the results
 * come back in any order. The name-based scan survives only for calls that
 * announced no id — those cannot be identified any other way, and skipping
 * identified entries keeps an unidentified result from stealing their line.
 */
function pendingIndex(activities: Activity[], { tool, toolCallId }: ToolResultUpdate): number {
  if (toolCallId) {
    const byId = activities.findIndex((a) => a.type === 'tool_call' && !a.done && a.toolCallId === toolCallId);
    if (byId >= 0) return byId;
    return lastPending(activities, tool, true);
  }
  return lastPending(activities, tool, false);
}

function lastPending(activities: Activity[], tool: string, unidentifiedOnly: boolean): number {
  for (let i = activities.length - 1; i >= 0; i--) {
    const act = activities[i];
    if (act.type !== 'tool_call' || act.done || act.tool !== tool) continue;
    if (unidentifiedOnly && act.toolCallId) continue;
    return i;
  }
  return -1;
}

const OUTCOME_ICON: Record<ResearchStepOutcome, string> = {
  success: '✓',
  failure: '✗',
  refused: '⊘',
  denied: '⊘',
  not_executed: '–',
};

/** A refused `rm` and a successful `rm` must not both render a `✓`. */
export function activityIcon(activity: Activity): string {
  if (!activity.done) return '⚙';
  return (activity.outcome && OUTCOME_ICON[activity.outcome]) ?? '✓';
}

export function outcomeLabel(outcome: ResearchStepOutcome | undefined): string {
  if (!outcome || outcome === 'success') return '';
  return outcome === 'not_executed' ? 'not executed' : outcome;
}
