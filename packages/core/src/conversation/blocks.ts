import type { PlannerCompaction, PlannerCompactionOutcome, ResearchStepOutcome, SkillLoadNotice, SubagentOutcome } from '../models/Task';
import type { StoredHandoff } from '../models/Handoff';
import type { ContextFill, ModelUsage, UsageTotals } from '../models/Usage';
import type { ApprovalKind } from '../interfaces/IApproval';
import type { ApprovalSource } from '../services/ApprovalPolicy';
import type { RunnerCommand, RunnerMcpServer } from '../models/RunnerCommand';
import type { PromptPartKind } from '../models/PromptPart';
import type { RunnerSignIn } from '../services/signInHint';

/**
 * What a surface draws for one planner conversation (#51): an ordered list of
 * display blocks, built once in core from the `SessionMessage` stream and drawn
 * per surface. Every block carries an `id` that stays the same for as long as
 * the block exists, so a surface can key its own UI state on it — whether a
 * block is expanded is that UI state, and deliberately not part of a block.
 */
export type DisplayBlock =
  | MessageBlock | ThinkingDisplayBlock | ToolBlock | SubagentBlock | ApprovalBlock | PlanBlock | SkillLoadBlock | UsageBlock
  | CommandBlock | CompactionBlock | RunnerLoadedBlock | HandoffBlock;

/**
 * `agent` is a task runner speaking in a structured task's log (ADR-0018); the
 * planner is `planner`. In a wake-up turn (ADR-0029) the planner speaks as
 * `supervisor`, and `wake_up` is the run update that woke it.
 */
export type MessageRole = 'user' | 'planner' | 'agent' | 'supervisor' | 'wake_up' | 'system' | 'error';

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
  /** A user's message that was force sent ("Send now"), stopping the turn before it (ADR-0023). */
  forced?: true;
  /**
   * A task's first message whose parts were logged: what Ordewell added
   * around the brief `text` holds, grouped, for a surface to fold.
   */
  sections?: readonly MessageSectionGroup[];
  /**
   * An 'error' that is the planner's runner signed out, as its manifest
   * recognized it: that agent and its ways in, for a surface to offer its
   * sign-in without reading `text` (ADR-0052).
   */
  signIn?: RunnerSignIn;
}

/** One group of a first message's sections: "Handoffs from earlier tasks" or "Ordewell's instructions to the runner". */
export interface MessageSectionGroup {
  title: string;
  sections: readonly MessageSection[];
}

/** A part of a task's first message, its heading left out: `title` names it. */
export interface MessageSection {
  kind: PromptPartKind;
  title: string;
  text: string;
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
  /** A command that ran sealed (ADR-0036 S4): no network, no home, nothing it wrote kept. A surface marks the row. */
  sealed?: true;
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
  /** What a script task runs, verbatim, for a start the user is asked to approve (ADR-0035). */
  body?: string;
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

/** How the turn a runner command opened ended, or `running` while it runs. */
export type CommandStatus = 'running' | 'done' | 'failed' | 'stopped';

/** A runner's own command a user ran in a task (#66): `/name args`, and what it printed. */
export interface CommandBlock {
  type: 'command';
  id: string;
  name: string;
  args?: string;
  status: CommandStatus;
  /** What a command that runs without the model printed; its other outcomes are the turn's own blocks. */
  output: string;
}

/** How a planner compaction stands: `running` until its end is heard. */
export type CompactionStatus = 'running' | PlannerCompactionOutcome;

/**
 * A context compaction: asked for (`/compact`) or done on its own. In a task's
 * log it is the runner's, done when drawn, and carries none of the planner's
 * fields. In the planner conversation it is one compaction's lifecycle,
 * matched by `compactionId` (ADR-0017): a quiet line while it runs and after,
 * its summary there to open, never shown whole.
 */
export interface CompactionBlock {
  type: 'compaction';
  id: string;
  trigger: 'manual' | 'auto';
  /** Only as a backend reported them. */
  preTokens?: number;
  postTokens?: number;
  /** The planner's compaction: its event id, which a checkpoint written by it shares. */
  compactionId?: string;
  /** `native`: a harness planner compacted its own context; `ordewell`: Ordewell condensed or pruned what it replays. */
  origin?: PlannerCompaction['origin'];
  status?: CompactionStatus;
  /** What a condensed compaction's checkpoint says, for a surface to show on request. */
  summary?: string;
  turnId?: string;
}

/**
 * What a task's runner loaded from the user's and the project's own setup, as
 * its process started: its commands and skills, and its MCP servers. Drawn
 * collapsed unless the surface shows detail.
 */
export interface RunnerLoadedBlock {
  type: 'runner_loaded';
  id: string;
  commands: readonly RunnerCommand[];
  mcpServers: readonly RunnerMcpServer[];
}

/**
 * What a task handed over (ADR-0047), as its attempt's log keeps it: the
 * summary, every finding with its evidence, the artifacts and the report. The
 * plan keeps only a digest, so a surface that reads this block may show more
 * than the plan knows. Expanding the report is surface UI state, as it is for
 * every block.
 */
export interface HandoffBlock {
  type: 'handoff';
  id: string;
  handoff: StoredHandoff;
}

/** The usage line (context and cost). Token counts ride in `totals` but are not drawn. There is at most one, and it is always the last block. */
export interface UsageBlock {
  byModel?: ModelUsage[];
  model?: string;
  type: 'usage';
  id: string;
  totals: UsageTotals;
  contextFill?: ContextFill;
  bySubagent?: Record<string, UsageTotals>;
}
