import type { ResearchStepOutcome, SkillLoadNotice, SubagentOutcome } from '../models/Task';
import type { UsageTotals } from '../models/Usage';
import type { ApprovalKind } from '../interfaces/IApproval';
import type { ApprovalSource } from '../services/ApprovalPolicy';

/**
 * What a surface draws for one planner conversation (#51): an ordered list of
 * display blocks, built once in core from the `SessionMessage` stream and drawn
 * per surface. Every block carries an `id` that stays the same for as long as
 * the block exists, so a surface can key its own UI state on it — whether a
 * block is expanded is that UI state, and deliberately not part of a block.
 */
export type DisplayBlock = MessageBlock | ThinkingDisplayBlock | ToolBlock | SubagentBlock | ApprovalBlock | PlanBlock | SkillLoadBlock | UsageBlock;

/** `agent` is a task runner speaking in a structured task's log (ADR-0018); the planner is `planner`. */
export type MessageRole = 'user' | 'planner' | 'agent' | 'system' | 'error';

export interface MessageBlock {
  type: 'message';
  id: string;
  role: MessageRole;
  text: string;
  /** Deltas are still arriving. */
  streaming: boolean;
  turnId?: string;
  /**
   * Present while the text is the streamed segment of a reply rather than a
   * settled message: provisional, replaced by the turn's `planner_message` when
   * it is the final segment, and never saved to the transcript.
   */
  segmentId?: string;
  /** A user's message: the skills its `/name` tokens loaded, for a surface to mark those tokens (see `loadedSkillTokens`). */
  skills?: readonly string[];
}

export interface ThinkingDisplayBlock {
  type: 'thinking';
  id: string;
  text: string;
  streaming: boolean;
  turnId?: string;
  segmentId?: string;
  /** Set when a subagent thought it; the block then sits among that subagent's children. */
  subagentId?: string;
}

/** The two halves of a Claude Code-style command row: `Name(keyArg)`. */
export interface ToolHeadline {
  name: string;
  keyArg: string;
}

export type ToolStatus = 'pending' | 'ok' | 'error' | 'denied' | 'interrupted';

/** What a file edit changed, counted from its diff. */
export interface DiffStat {
  added: number;
  removed: number;
}

export interface ToolBlock {
  type: 'tool';
  id: string;
  toolCallId?: string;
  tool: string;
  toolLabel?: string;
  headline: ToolHeadline;
  /** The arguments exactly as announced (JSON), for the expanded view. */
  args: string;
  status: ToolStatus;
  /** How the call ended, finer than `status`: a refused command and a denied path both read `denied`. */
  outcome?: ResearchStepOutcome;
  output: string;
  /** Every line of `output`, counted as {@link outputPreview} counts them. */
  outputLineCount: number;
  /** Present when the call edited a file and `output` is its diff: a surface draws it as one. */
  diff?: DiffStat;
  turnId?: string;
  /**
   * The subagent this call starts. The call becomes that subagent's block once
   * the subagent announces itself, so the two never show as separate rows.
   */
  spawns?: string;
}

export type SubagentStatus = 'running' | SubagentOutcome;

export type SubagentChild = ToolBlock | ThinkingDisplayBlock | MessageBlock;

export interface SubagentBlock {
  type: 'subagent';
  id: string;
  subagentId: string;
  /** The planner's call that started it, when one was announced. */
  toolCallId?: string;
  brief: string;
  model?: string;
  status: SubagentStatus;
  children: readonly SubagentChild[];
  /** What it handed back to the planner. */
  digest: string;
  /** Its own share, already counted in the usage line. */
  usage?: UsageTotals;
  turnId?: string;
}

/** `withdrawn`: a runner's request that went unanswered — the runner cancelled it, or its process ended. */
export type ApprovalStatus = 'pending' | 'granted' | 'denied' | 'withdrawn';

export interface ApprovalBlock {
  type: 'approval';
  id: string;
  /** The request's id, which a surface answers through. Absent for a decision nobody was asked about. */
  approvalId?: string;
  kind: ApprovalKind;
  subject: string;
  scope: string;
  detail?: string;
  status: ApprovalStatus;
  /** Absent while pending. */
  decidedBy?: ApprovalSource;
  turnId?: string;
  /** A runner's request (`runner_tool`) that can also be allowed for the rest of its task. */
  allowForTask?: boolean;
  /** Granted for the rest of the task, not this call alone. */
  forTask?: boolean;
  /** What a denial told the agent. */
  note?: string;
  /** The runner's tool call the request is about. */
  toolCallId?: string;
}

export type PlanMarkerStatus = 'building' | 'generated' | 'updated';

export interface PlanBlock {
  type: 'plan';
  id: string;
  status: PlanMarkerStatus;
  /** The plan envelope streamed so far — `parsePartialPlan` reads rows from it. Empty once settled. */
  text: string;
  taskCount?: number;
  turnId?: string;
  /** While building: the segment whose envelope is streaming, which a retraction of that segment takes back. */
  segmentId?: string;
}

/** A skill loaded into the conversation: one line naming it and the SKILL.md that won. Its body is never shown. */
export interface SkillLoadBlock extends SkillLoadNotice {
  type: 'skill_load';
  id: string;
  turnId?: string;
}

/** The token line. There is at most one, and it is always the last block. */
export interface UsageBlock {
  type: 'usage';
  id: string;
  totals: UsageTotals;
  contextFill?: { usedTokens: number; windowTokens: number };
  bySubagent?: Record<string, UsageTotals>;
}
