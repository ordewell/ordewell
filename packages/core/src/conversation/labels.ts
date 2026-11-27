import type { FindingSeverity } from '../models/Handoff';
import { severityLabel } from '../models/Handoff';
import type { ApprovalKind } from '../interfaces/IApproval';
import type { ApprovalSource } from '../services/ApprovalPolicy';
import type { ApprovalBlock, CompactionBlock, CompactionStatus, PlanBlock } from './blocks';
import { formatTokenCount } from '../models/Usage';

/*
 * The words a conversation block is made of (#51): an approval's kind and
 * state, a plan marker and what a task handed over. A surface joins and styles
 * these parts; it never re-words them, so the TUI and the VS Code webview
 * cannot drift apart again, and a new approval kind or source fails to compile
 * here rather than silently rendering as something else.
 */

const APPROVAL_KIND_TEXT: Record<ApprovalKind, string> = {
  shell_command: 'Run a command',
  url_fetch: 'Fetch a URL',
  web_search: 'Search the web',
  external_path: 'Read outside the workspace',
  mcp_tool: 'Use an MCP tool',
  mcp_server: 'Start a project MCP server',
  runner_tool: 'Use a tool',
  task_start: 'Start work',
};

/** What an approval request is about, before its subject says the specifics. */
export function approvalKindText(kind: ApprovalKind): string {
  return APPROVAL_KIND_TEXT[kind];
}

// The source a policy decided under. `asked` is absent: a request the user
// answered reads "Approved", not "Approved (asked)".
const APPROVAL_SOURCE_TEXT: Record<Exclude<ApprovalSource, 'asked'>, string> = {
  'pre-approved': 'pre-approved',
  remembered: 'remembered',
  mode: 'policy',
  'no-channel': 'no approval channel',
  excluded: 'excluded',
  guard: 'blocked address',
  secret: 'secret check',
  budget: 'web-read budget',
  unsupported: 'not usable on this runner version',
};

/** An approval's state in one phrase, naming the policy when nobody was asked. */
export function approvalStatusText(block: Pick<ApprovalBlock, 'status' | 'decidedBy' | 'forTask'>): string {
  const policy = block.decidedBy && block.decidedBy !== 'asked' ? APPROVAL_SOURCE_TEXT[block.decidedBy] : undefined;
  switch (block.status) {
    case 'pending':
      return 'Waiting for you';
    case 'granted':
      return policy ? `Auto-approved (${policy})` : block.forTask ? 'Approved for this task' : 'Approved';
    case 'denied':
      return policy ? `Auto-denied (${policy})` : 'Denied';
    case 'timed_out':
      return 'Timed out';
    case 'withdrawn':
      return 'Withdrawn';
  }
}

/** A plan marker's parts a surface joins: the change, and the plan's size once it is known. */
export function planMarkerParts(block: Pick<PlanBlock, 'status' | 'taskCount'>): string[] {
  if (block.status === 'building') return ['Building plan…'];
  const count = block.taskCount === undefined ? [] : [`${block.taskCount} task${block.taskCount === 1 ? '' : 's'}`];
  return [`Plan ${block.status}`, ...count];
}

/** "no findings", or "2 findings": a handoff's count as every surface words it. */
export function handoffFindingsText(count: number): string {
  return count === 0 ? 'no findings' : `${count} finding${count === 1 ? '' : 's'}`;
}

/** What a compact handoff row needs (ADR-0047); a task row's handoff satisfies it. */
export interface HandoffPeekSubject {
  commit?: { subject: string };
  summary: string;
  findingCount: number;
  severity: FindingSeverity | null;
  /** The patch its attempt saved (ADR-0050), when it saved one. */
  patch?: { peek: string } | null;
  /** What a done task's work changed as it landed, Ordewell's count from git: "1 file, +1 -1". */
  change?: string | null;
}

/**
 * The first line with words on it: a summary commonly opens with a blank line
 * the model added, and showing that line would show nothing.
 */
function firstNonBlankLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? '';
}

/**
 * A handoff's compact row, as the parts a surface joins after its own lead
 * ("handed over"): the finding count and worst severity, what its landing
 * changed as git counts it, then the commit
 * subject before the summary, since that is what a reviewer reads first.
 */
export function handoffPeekParts(handoff: HandoffPeekSubject): string[] {
  // A handoff's severity is the worst of its findings, so it is absent exactly
  // when there are none.
  const severity = handoff.severity ? [severityLabel(handoff.severity)] : [];
  const commit = handoff.commit ? [`Commit: ${handoff.commit.subject.trim()}`] : [];
  const summary = firstNonBlankLine(handoff.summary);
  return [handoffFindingsText(handoff.findingCount), ...severity, ...(handoff.change ? [handoff.change] : []), ...(handoff.patch ? [handoff.patch.peek] : []), ...commit, ...(summary ? [summary] : [])];
}

// What a compaction that is not plainly done says instead (ADR-0017): each
// one changed nothing, or only what the model is sent.
const COMPACTION_STATUS_TEXT: Partial<Record<CompactionStatus, string>> = {
  running: 'Compacting context…',
  stopped: 'Compaction stopped · nothing changed',
  failed: 'Compaction failed · nothing changed',
  paused: 'Context does not fit · the planner is paused',
  pruned: 'Older tool output trimmed from context',
  unchanged: 'Context unchanged',
};

function compactedBy({ origin, trigger }: CompactionBlock): string {
  if (origin === 'native') return trigger === 'auto' ? 'The planner compacted its context on its own' : 'The planner compacted its context';
  if (origin === 'ordewell') return trigger === 'auto' ? 'Context compacted automatically' : 'Context compacted';
  return trigger === 'auto' ? 'Context compacted by the runner on its own' : 'Context compacted';
}

/** A compaction's one line: how it stands, who compacted, and its sizes when a backend reported both. */
export function compactionText(block: CompactionBlock): string {
  const status = block.status ? COMPACTION_STATUS_TEXT[block.status] : undefined;
  if (status) return status;
  const { preTokens, postTokens } = block;
  const sizes = preTokens !== undefined && postTokens !== undefined ? ` · ${formatTokenCount(preTokens)} → ${formatTokenCount(postTokens)} tokens` : '';
  return `${compactedBy(block)}${sizes}`;
}
