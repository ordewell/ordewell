import { randomUUID } from 'crypto';
import type { SubagentOutcome } from '../../models/Task';
import { partedPromptUsage, type UsageRecord } from '../../models/Usage';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import { claudeThinkingArgs } from '../../plugins/resolveArgs';
import type { AgentEvent, AgentStartOptions, TaskModeAgentAdapter, TaskStartOptions } from './AgentAdapter';
import { StdioAgentAdapter, type SpawnSpec } from './StdioAgentAdapter';
import { markedLines, structuredPatchText } from './fileDiff';
import { ORDEWELL_MCP_SERVER_NAME, type McpClientConfig, type OwnerOnlyFile } from '../mcp';
import { CLAUDE_ORDEWELL } from './claudeOrdewell';
import { settleWithin } from './settleWithin';
import { awaitAttach, type OrdewellToolRole } from './ordewellBinding';

/**
 * Native plan mode permits Bash writes to its plan file, and `dontAsk` still
 * honors saved shell allow rules. Withhold shell tools and native plan-mode
 * transitions as well as direct edits so neither can reopen that write path.
 */
const DISALLOWED_TOOLS = [
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'KillShell',
  'Bash', 'PowerShell', 'EnterPlanMode', 'ExitPlanMode',
];

const PLANNER_PERMISSION_MODE = 'dontAsk';

/**
 * `AskUserQuestion` reaches us as a tool request whose allow must carry the
 * user's `answers`, which no surface collects yet. Left on, the agent gets an
 * empty answer and carries on guessing; off, it asks in plain text and ends its
 * turn, which the task reads as "waiting for input" (ADR-0018, W1).
 */
const TASK_DISALLOWED_TOOLS = ['AskUserQuestion'];

/**
 * The flags that make Claude Code speak its bidirectional protocol, the same
 * for a planner and a task. `--verbose` because stream-json output is rejected
 * without it.
 */
const PROTOCOL_ARGS = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--include-partial-messages',
];

/**
 * A task's stdin messages come back as `isReplay` echoes, and a steered one's
 * echo is the only sign the model has it (ADR-0023): the CLI echoes it once
 * it attaches the message to a tool result, or once it opens a turn for it.
 */
const TASK_PROTOCOL_ARGS = [...PROTOCOL_ARGS, '--replay-user-messages'];

/**
 * How Claude Code reports an `Agent` call it decided to run in the background.
 * The tool *input* carries no flag — backgrounding is the CLI's own choice,
 * announced only in the result — so this string is the sole signal. If a future
 * release rewords it the planner is no more lossy than it was before, which is
 * why nothing downstream treats its absence as "no agents are running".
 */
const ASYNC_LAUNCH_MARKER = 'Async agent launched successfully';

/**
 * After the last background task finishes behind a held `result`, how long the
 * CLI has to start the follow-on turn it normally opens itself. Past it, the
 * agent is taken to have nothing more to say.
 */
const FOLLOW_ON_TURN_GRACE_MS = 5000;

/**
 * How long a planner's Ordewell server has to connect. The CLI connects its
 * MCP servers as it starts, before any turn; a loopback server that is not up
 * by then is not coming, and the planner falls back to the envelopes.
 */
const MCP_ATTACH_TIMEOUT_MS = 10_000;
const MCP_STATUS_POLL_MS = 100;

/** A denial's `message` is required by the CLI; this stands in when nobody wrote a note. */
const DEFAULT_DENIAL = 'Denied in Ordewell. Continue without it, or say what you need.';

interface ClaudeBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** One Anthropic Messages streaming event, as `--include-partial-messages` relays it. */
interface ClaudeStreamEvent {
  type: string;
  message?: { model?: string };
  usage?: ClaudeUsage;
  content_block?: { type: string };
  delta?: { type?: string; text?: string; thinking?: string };
}

interface ControlResponse {
  subtype?: string;
  request_id?: string;
  error?: string;
  /** `mcp_status`: every MCP server the session has, and whether it connected. */
  response?: { mcpServers?: { name?: string; status?: string }[] };
}

interface ClaudeLine {
  type: string;
  subtype?: string;
  session_id?: string;
  /** `init`: the mode the CLI actually started in. */
  permissionMode?: string;
  result?: string;
  is_error?: boolean;
  /** A failed result's own words when it has no `result` text — a refused `--resume`, say. */
  errors?: string[];
  request_id?: string;
  request?: { subtype?: string; tool_name?: string; input?: Record<string, unknown>; permission_suggestions?: unknown[]; tool_use_id?: string };
  /** `control_response`: the answer to a request Ordewell sent, such as an interrupt. */
  response?: ControlResponse;
  message?: { id?: string; model?: string; usage?: ClaudeUsage; content?: ClaudeBlock[] | string };
  /** Non-null on every line produced inside a subagent the planner spawned. */
  parent_tool_use_id?: string | null;
  event?: ClaudeStreamEvent;
  /** The tool's structured result beside its text; for an `Agent` call it holds the subagent's last call's usage. */
  tool_use_result?: unknown;
  /** Cumulative over the whole agent session — including turns before a `--resume`. */
  total_cost_usd?: number;
  modelUsage?: Record<string, { contextWindow?: number }>;
  /** `background_tasks_changed`: every background task still running, not just the change. */
  tasks?: unknown[];
  /** `task_notification`: which `Agent` call finished, how, and what it reported. */
  tool_use_id?: string;
  status?: string;
  summary?: string;
  /** A `user` line the CLI echoes back from stdin under `--replay-user-messages`, with the `uuid` it was written under. */
  isReplay?: boolean;
  uuid?: string;
}

/** The tool Claude Code delegates to a subagent with — `Task` before it was renamed `Agent`. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

/** Anthropic's `input_tokens` is only the uncached tail of the prompt — see {@link partedPromptUsage}. */
function usageRecord(usage: ClaudeUsage, model: string | undefined, subagentId?: string): UsageRecord {
  const record: UsageRecord = {
    source: 'claude-code',
    ...partedPromptUsage({ uncached: usage.input_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens }),
  };
  if (model) record.model = model;
  if (usage.output_tokens !== undefined) record.outputTokens = usage.output_tokens;
  if (subagentId) record.subagentId = subagentId;
  return record;
}

/** The last call's usage an `Agent` result carries, and the model that made it. */
function subagentFinalCall(result: unknown): { usage: ClaudeUsage; model?: string } | null {
  if (typeof result !== 'object' || result === null) return null;
  const { usage, resolvedModel } = result as { usage?: unknown; resolvedModel?: unknown };
  if (typeof usage !== 'object' || usage === null) return null;
  return { usage: usage as ClaudeUsage, model: typeof resolvedModel === 'string' ? resolvedModel : undefined };
}

/** Anything but a clean finish is not reported as one. */
function notificationOutcome(status: string | undefined): SubagentOutcome {
  if (status === 'completed') return 'done';
  if (status === 'killed' || status === 'stopped') return 'stopped';
  return 'failed';
}

function blocksOf(msg: ClaudeLine): ClaudeBlock[] {
  return Array.isArray(msg.message?.content) ? msg.message.content : [];
}

/** Tool results arrive as a string, or as a content-block array. Flatten both. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === 'string' ? block : typeof (block as ClaudeBlock)?.text === 'string' ? (block as ClaudeBlock).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Claude Code as a planner, over its bidirectional streaming-JSON transport
 * (ADR-0009).
 *
 * `-p --input-format stream-json --output-format stream-json` keeps one process
 * alive across turns: user messages go in as JSON lines, and the session's
 * assistant blocks, tool uses, tool results and turn boundaries come back the
 * same way. It is the richest of the three streams — partial messages and
 * separate thinking blocks — which is why this agent went first.
 */
/**
 * What a file edit changed, from the structured result the CLI sends beside
 * the text the model reads: an edit's hunks, a created file's lines. The text
 * only says the edit happened.
 */
function editDiff(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const { type, content, structuredPatch } = result as Record<string, unknown>;
  if (type === 'create' && typeof content === 'string') return markedLines(content, '+');
  return structuredPatchText(structuredPatch);
}

export class ClaudeCodeAdapter extends StdioAgentAdapter implements TaskModeAgentAdapter {
  readonly agentId = 'claude-code';

  private controlCount = 0;
  /** Control requests sent and not yet answered, by request id. */
  private readonly pendingControl = new Map<string, (response: ControlResponse | null) => void>();
  /** An interrupt was sent during the current turn, so an aborted result is that interrupt, not a failure. */
  private interruptRequested = false;
  /** A task's tool requests still waiting for an answer, by request id, with what the answer echoes back. */
  private readonly openPermissions = new Map<string, { input: Record<string, unknown>; suggestions: unknown[] }>();

  /** Whether this turn has already emitted reply text — see {@link handleLine}. */
  private turnHasText = false;
  /** The text block streaming now follows earlier reply text, so its first delta opens the paragraph. */
  private pendingBreak = false;
  /** The model answering the planner's current message, as its `message_start` named it. */
  private plannerModel: string | undefined;
  /**
   * The session's `total_cost_usd` as last reported. Undefined after a resume:
   * the CLI restores the resumed session's running total, and what Ordewell
   * already counted of it is not ours to know here.
   */
  private reportedCostUsd: number | undefined = 0;
  /**
   * Subagents started and not yet finished, keyed by the `Agent` call's id.
   * Kept across turns: a backgrounded one reports after its turn has ended.
   */
  private readonly openSubagents = new Map<string, { background: boolean }>();
  /** Subagent messages already counted. A message arrives as one line per content block, each repeating its usage. */
  private readonly countedSubagentMessages = new Set<string>();
  /** Background tasks (shells, agents) the CLI reports as still running, as of its last `background_tasks_changed`. */
  private backgroundTaskCount = 0;
  /**
   * A task's turn whose `result` arrived while background work was still open.
   * The CLI reports that result when the model stops talking, then opens a turn
   * of its own when the work finishes; a turn ended at the first result would
   * lose everything done after it, the `task_complete` call included.
   */
  private resultHeld = false;
  private followOnTimer: ReturnType<typeof setTimeout> | null = null;
  /** The mode a task asked for, to hold the CLI to it once its `init` says what it started in. */
  private requestedMode: string | null = null;
  /** The session `--resume` asked for, until the CLI's `init` shows it was taken up. */
  private pendingResume: string | null = null;
  /** The `--mcp-config` file of the running process, which holds its token; removed with the process. */
  private mcpConfig: OwnerOnlyFile | null = null;
  /** Whether this process was given the server, so its tools' requests are Ordewell's own. */
  private givenOrdewell = false;
  /** Messages written into a running task turn, by the `uuid` their echo will carry, until it does (ADR-0023). */
  private readonly steers = new Map<string, string>();
  /** The last turn's `result` ended it, so a steer's echo now opens a turn the CLI started for that message. */
  private turnClosed = false;

  protected spawnSpec(opts: AgentStartOptions): SpawnSpec {
    if (opts.kind === 'task') return this.taskSpawnSpec(opts);
    const args = [
      ...PROTOCOL_ARGS,
      // The read-only guarantee, enforced at spawn rather than by prompt.
      '--permission-mode', PLANNER_PERMISSION_MODE,
      '--disallowedTools', DISALLOWED_TOOLS.join(','),
      '--append-system-prompt', opts.systemPrompt,
    ];
    if (opts.mcp) args.push(...this.ordewellServerArgs(opts.mcp, 'planner'));
    if (opts.model) args.push('--model', opts.model);
    // `adaptive` is a thinking *type*, not an effort rung: `--effort adaptive`
    // is warned about and ignored, and adaptive is the default for every model
    // that offers it. Passing nothing is the same run without the warning on
    // stderr.
    if (opts.effort && opts.effort !== 'adaptive') args.push('--effort', opts.effort);
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
      this.reportedCostUsd = undefined;
      this.pendingResume = opts.resumeSessionId;
    }
    return { command: 'claude', args };
  }

  /**
   * A task's run: the manifest decides what its mode and effort mean
   * (ADR-0001), and this adds only the protocol around them. No tool list and
   * no system prompt — the task's prompt is its first turn. `--permission-prompt-tool stdio` routes the questions the mode
   * leaves open to the control channel, where the adapter must answer them;
   * without it `-p` refuses them silently and nothing can ever surface one.
   */
  private taskSpawnSpec(opts: TaskStartOptions): SpawnSpec {
    this.requestedMode = opts.flags.permissionMode;
    const args = [
      ...TASK_PROTOCOL_ARGS,
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', opts.flags.permissionMode,
      '--disallowedTools', TASK_DISALLOWED_TOOLS.join(','),
      ...(opts.flags.effort ? claudeThinkingArgs(opts.flags.effort) : []),
    ];
    if (opts.model) args.push('--model', opts.model);
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
      this.reportedCostUsd = undefined;
      this.pendingResume = opts.resumeSessionId;
    }
    if (opts.mcp) args.push(...this.ordewellServerArgs(opts.mcp, 'task'));
    return { command: 'claude', args };
  }

  /** The file holding the token lives exactly as long as the process that reads it. */
  private ordewellServerArgs(mcp: McpClientConfig, role: OrdewellToolRole): string[] {
    this.removeMcpConfig();
    const { args, config } = CLAUDE_ORDEWELL.launch(mcp, role);
    this.mcpConfig = config;
    void this.processEnded.then(() => config.remove());
    this.givenOrdewell = true;
    return args;
  }

  private removeMcpConfig(): void {
    this.mcpConfig?.remove();
    this.mcpConfig = null;
  }

  /** Asks the CLI itself, which reports `pending` until its connection attempt settles. */
  async mcpAttached(): Promise<boolean> {
    if (!this.mcpConfig) return false;
    return awaitAttach(async (left) => {
      const answer = await this.control({ subtype: 'mcp_status' }, left);
      return CLAUDE_ORDEWELL.attachState(answer?.response?.mcpServers?.find((s) => s.name === ORDEWELL_MCP_SERVER_NAME)?.status);
    }, MCP_ATTACH_TIMEOUT_MS, MCP_STATUS_POLL_MS);
  }

  /**
   * Claude Code's soft interrupt: the turn stops, the process and its session
   * stay. The CLI acknowledges on the control channel, then closes the turn
   * with an `error_during_execution` result, which {@link handleLine} reports
   * as an interrupted `turn_end`.
   */
  async interrupt(timeoutMs: number): Promise<boolean> {
    if (!this.process) return false;
    this.interruptRequested = true;
    return (await this.control({ subtype: 'interrupt' }, timeoutMs))?.subtype === 'success';
  }

  /**
   * A `user` line written mid-turn is Claude Code's own queue (ADR-0023): the
   * CLI attaches it to the next tool result, or runs it as a turn of its own
   * after `result` — an interrupted one included — so it never lets go of one,
   * and nothing is ever reported dropped. Refused while an interrupt is in
   * flight, and before a `--resume` is taken up: a refused resume closes stdin
   * with the message unread.
   */
  async steer(id: string, text: string): Promise<boolean> {
    if (this.role !== 'task' || !this.process || this.interruptRequested || this.pendingResume) return false;
    const uuid = randomUUID();
    this.steers.set(uuid, id);
    this.writeLine({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } });
    return true;
  }

  /** Send a control request and wait for its answer; null when none came in time or the process ended. */
  private control(request: { subtype: string }, timeoutMs: number): Promise<ControlResponse | null> {
    if (!this.process) return Promise.resolve(null);
    this.controlCount += 1;
    const requestId = `ordewell-${request.subtype}-${this.controlCount}`;
    const answered = new Promise<ControlResponse | null>((resolve) => { this.pendingControl.set(requestId, resolve); });
    this.writeLine({ type: 'control_request', request_id: requestId, request });
    return settleWithin(answered, { timeoutMs, ended: this.processEnded, onTimeout: () => null, onEnded: () => null })
      .finally(() => { this.pendingControl.delete(requestId); });
  }

  /**
   * A `--resume` the CLI cannot find is answered at once with an error result
   * and no `init`, after which it waits on stdin for input it never reads — a
   * turn sent to it would hang. Closing stdin lets it exit. The id it echoes is
   * not recorded: no session was taken up, and a continue must not offer it again.
   */
  private refuseResume(msg: ClaudeLine, emit: (event: AgentEvent) => void): void {
    const requested = this.pendingResume;
    this.pendingResume = null;
    emit({ type: 'error', message: msg.errors?.join('\n').trim() || msg.result?.trim() || `Claude Code could not resume session ${requested}.` });
    this.process?.stdin?.end();
  }

  /**
   * The answer to an open tool request, in the shape the CLI validates: an
   * allow echoes the call's own input (an absent one is warned about and
   * replaced), and "for this task" hands back Claude's own suggestions — never
   * a grant of Ordewell's making.
   */
  answerPermission(id: string, decision: ApprovalDecision): boolean {
    const open = this.openPermissions.get(id);
    if (!open || !this.process) return false;
    this.openPermissions.delete(id);
    const response = decision.decision === 'deny'
      ? { behavior: 'deny', message: decision.note?.trim() || DEFAULT_DENIAL }
      : {
        behavior: 'allow',
        updatedInput: open.input,
        ...(decision.decision === 'allowForTask' && open.suggestions.length > 0 ? { updatedPermissions: open.suggestions } : {}),
      };
    this.writeLine({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
    return true;
  }

  dispose(): void {
    this.clearFollowOnTimer();
    this.removeMcpConfig();
    super.dispose();
  }

  private clearFollowOnTimer(): void {
    if (this.followOnTimer) clearTimeout(this.followOnTimer);
    this.followOnTimer = null;
  }

  protected turnPayload(message: string): string {
    this.openTurnState();
    return `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: message }] },
    })}\n`;
  }

  private openTurnState(): void {
    this.turnHasText = false;
    this.interruptRequested = false;
    this.resultHeld = false;
    this.turnClosed = false;
    this.clearFollowOnTimer();
  }

  /**
   * The echo of a steered message: the model has it. After a closed turn it
   * opens the CLI's own turn for the message, which then runs like one Ordewell
   * sent. The first prompt is echoed too, and is no steer.
   */
  private steerDelivered(uuid: string | undefined, emit: (event: AgentEvent) => void): void {
    const id = uuid ? this.steers.get(uuid) : undefined;
    if (!uuid || id === undefined) return;
    this.steers.delete(uuid);
    if (this.turnClosed) this.openTurnState();
    else this.clearFollowOnTimer();
    emit({ type: 'message_delivered', id });
  }

  protected handleLine(line: string, emit: (event: AgentEvent) => void): void {
    const msg = StdioAgentAdapter.parse<ClaudeLine>(line);
    if (!msg) return;

    if (this.pendingResume) {
      if (msg.type === 'result' && msg.is_error) {
        this.refuseResume(msg, emit);
        return;
      }
      if (msg.type === 'system' && msg.subtype === 'init') this.pendingResume = null;
    }
    if (msg.session_id) this.sessionId = msg.session_id;

    // Subagent traffic, replayed on the same stream with the spawning tool call
    // named. It is not the planner talking: forwarded as the planner's own, a
    // subagent's running commentary lands in the reply, and the user reads an
    // answer addressed to a prompt they never sent. So its steps are tagged
    // with the subagent and its text is never reply text.
    const subagentId = msg.parent_tool_use_id ?? undefined;

    switch (msg.type) {
      // The control channel: Claude asks whether a tool may run when its mode
      // cannot decide alone. A read-only planner answers "deny", every time —
      // and must answer, because an unacknowledged request stalls the turn.
      // A task's request is left open for someone to answer (ADR-0018, A1).
      case 'control_request': {
        if (msg.request?.subtype !== 'can_use_tool') return;
        const input = msg.request.input ?? {};
        const id = msg.request_id ?? '';
        if (this.role === 'planner') {
          this.writeLine({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: msg.request_id,
              response: { behavior: 'deny', message: 'The Ordewell planner is read-only. Mutation belongs to the runners that execute the plan.' },
            },
          });
          emit({ type: 'permission_request', id, name: msg.request.tool_name ?? 'unknown', detail: JSON.stringify(input) });
          return;
        }
        const name = msg.request.tool_name ?? 'unknown';
        if (this.givenOrdewell && CLAUDE_ORDEWELL.isOrdewellAsk(name)) {
          // `--allowedTools` should have settled it already. A completion that
          // waited on a person would hold the verdict hostage (ADR-0022, S3).
          this.writeLine({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'allow', updatedInput: input } } });
          emit({ type: 'permission_request', id, name, detail: JSON.stringify(input), input, decided: { decision: 'allow' } });
          return;
        }
        const suggestions = msg.request.permission_suggestions ?? [];
        this.openPermissions.set(id, { input, suggestions });
        emit({
          type: 'permission_request',
          id,
          name,
          detail: JSON.stringify(input),
          input,
          suggestions,
          ...(msg.request.tool_use_id ? { toolUseId: msg.request.tool_use_id } : {}),
        });
        return;
      }

      // Claude gave up on a request it asked — an interrupt cancels the call.
      case 'control_cancel_request': {
        const id = msg.request_id;
        if (id && this.openPermissions.delete(id)) emit({ type: 'permission_cancelled', id });
        return;
      }

      case 'control_response': {
        const requestId = msg.response?.request_id;
        if (requestId) this.pendingControl.get(requestId)?.(msg.response ?? null);
        return;
      }

      case 'assistant':
        if (!subagentId) this.clearFollowOnTimer();
        if (subagentId) {
          this.handleSubagentMessage(msg, subagentId, emit);
          return;
        }
        for (const block of blocksOf(msg)) {
          // A turn is several whole messages — narration between tool rounds,
          // then the final answer — not a token stream. Concatenated raw they
          // run together ("…in parallel.That agent returned…"), so each one
          // after the first opens a paragraph.
          if (block.type === 'text' && block.text) {
            emit({ type: 'assistant_text', text: this.turnHasText ? `\n\n${block.text}` : block.text });
            this.turnHasText = true;
          } else if (block.type === 'thinking' && block.thinking) emit({ type: 'thinking', text: block.thinking });
          else if (block.type === 'tool_use' && block.name) {
            const id = block.id ?? block.name;
            emit({ type: 'tool_call', id, name: block.name, args: block.input ?? {} });
            if (SUBAGENT_TOOLS.has(block.name) && block.id) this.startSubagent(block.id, block.input ?? {}, emit);
          }
        }
        return;

      case 'user':
        if (msg.isReplay) {
          this.steerDelivered(msg.uuid, emit);
          return;
        }
        // The transport echoes tool results back as a synthetic user message.
        for (const block of blocksOf(msg)) {
          if (block.type !== 'tool_result') continue;
          const id = block.tool_use_id ?? '';
          const output = flattenContent(block.content);
          const diff = block.is_error === true ? '' : editDiff(msg.tool_use_result);
          const subagent = subagentId ? undefined : this.openSubagents.get(id);
          if (!subagentId && output.includes(ASYNC_LAUNCH_MARKER)) {
            emit({ type: 'background_agent', id });
            if (subagent) subagent.background = true;
          } else if (subagent) {
            this.finishForegroundSubagent(id, msg.tool_use_result, output, block.is_error === true, emit);
          }
          emit({ type: 'tool_result', id, name: '', output: diff || output, success: block.is_error !== true, subagentId });
        }
        return;

      case 'system':
        if (msg.subtype === 'init') {
          this.clearFollowOnTimer();
          if (this.refuseOtherMode(msg, emit)) return;
        }
        if (msg.subtype === 'background_tasks_changed' && Array.isArray(msg.tasks)) {
          this.backgroundTaskCount = msg.tasks.length;
          if (this.resultHeld && this.backgroundTaskCount === 0) this.awaitFollowOnTurn(emit);
        }
        // A backgrounded subagent's only completion signal: its `Agent` call
        // returned at launch, long before the work ended.
        if (msg.subtype === 'task_notification' && msg.tool_use_id && this.openSubagents.get(msg.tool_use_id)?.background) {
          this.openSubagents.delete(msg.tool_use_id);
          emit({ type: 'subagent_finished', subagentId: msg.tool_use_id, outcome: notificationOutcome(msg.status), digest: msg.summary ?? '' });
        }
        return;

      case 'result':
        // `result` closes every turn — success or failure. The final assistant
        // text (which carries the plan JSON) already arrived as assistant
        // blocks, so this only settles the turn.
        this.reportSessionCost(msg, emit);
        if (this.interruptRequested && (msg.is_error || msg.subtype !== 'success')) {
          this.interruptRequested = false;
          this.turnClosed = true;
          emit({ type: 'turn_end', interrupted: true });
        } else if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
          this.turnClosed = true;
          emit({ type: 'error', message: msg.result?.trim() || msg.errors?.join('\n').trim() || `Claude Code ended the turn: ${msg.subtype ?? 'error'}` });
        } else if (this.role === 'task' && this.backgroundTaskCount > 0) {
          this.resultHeld = true;
        } else {
          this.resultHeld = false;
          this.turnClosed = true;
          emit({ type: 'turn_end' });
        }
        return;

      case 'stream_event':
        // Only the planner's own messages stream; a subagent's arrive whole.
        if (msg.event && !subagentId) this.handleStreamEvent(msg.event, emit);
        return;

      default:
        return;
    }
  }

  /**
   * `--permission-mode auto` on a model or account without auto mode is not
   * refused: the CLI says nothing and starts in `default`, then asks about every
   * write — a request nobody is there to answer. The plan, not the CLI, decides
   * the mode (ADR-0001), so a different one fails the turn rather than running.
   */
  private refuseOtherMode(msg: ClaudeLine, emit: (event: AgentEvent) => void): boolean {
    const asked = this.requestedMode;
    if (this.role !== 'task' || !asked || !msg.permissionMode || msg.permissionMode === asked) return false;
    emit({ type: 'error', message: `Claude Code started in "${msg.permissionMode}" mode, not the "${asked}" mode the plan asked for. It does not report why; the model or the account may not offer it.` });
    this.dispose();
    return true;
  }

  private awaitFollowOnTurn(emit: (event: AgentEvent) => void): void {
    this.clearFollowOnTimer();
    this.followOnTimer = setTimeout(() => {
      this.followOnTimer = null;
      this.resultHeld = false;
      this.turnClosed = true;
      emit({ type: 'turn_end' });
    }, FOLLOW_ON_TURN_GRACE_MS);
    this.followOnTimer.unref?.();
  }

  private startSubagent(id: string, input: Record<string, unknown>, emit: (event: AgentEvent) => void): void {
    this.openSubagents.set(id, { background: false });
    const brief = typeof input.description === 'string' ? input.description : typeof input.prompt === 'string' ? input.prompt : '';
    emit({ type: 'subagent_started', subagentId: id, brief, model: typeof input.model === 'string' ? input.model : undefined });
  }

  /**
   * A subagent's messages do not stream, so each line's usage is the snapshot
   * taken before generation: the prompt is real, the output a placeholder.
   * Only the prompt side is reported — an absent output count reads as "not
   * reported", a placeholder would read as a measurement.
   */
  private handleSubagentMessage(msg: ClaudeLine, subagentId: string, emit: (event: AgentEvent) => void): void {
    const messageId = msg.message?.id;
    if (msg.message?.usage && messageId && !this.countedSubagentMessages.has(messageId)) {
      this.countedSubagentMessages.add(messageId);
      emit({ type: 'usage', record: usageRecord({ ...msg.message.usage, output_tokens: undefined }, msg.message.model, subagentId) });
    }
    for (const block of blocksOf(msg)) {
      if (block.type === 'thinking' && block.thinking) emit({ type: 'thinking', text: block.thinking, subagentId });
      else if (block.type === 'tool_use' && block.name) {
        emit({ type: 'tool_call', id: block.id ?? block.name, name: block.name, args: block.input ?? {}, subagentId });
      }
    }
  }

  /**
   * The `Agent` call returned, so the subagent is done. Its last call — the
   * report — never appears as a line of its own; the result carries its
   * complete usage instead.
   */
  private finishForegroundSubagent(id: string, result: unknown, output: string, failed: boolean, emit: (event: AgentEvent) => void): void {
    this.openSubagents.delete(id);
    const finalCall = subagentFinalCall(result);
    if (finalCall) emit({ type: 'usage', record: usageRecord(finalCall.usage, finalCall.model, id) });
    emit({ type: 'subagent_finished', subagentId: id, outcome: failed ? 'failed' : 'done', digest: output });
  }

  /**
   * Partial output of the planner's own message. The complete `assistant` line
   * for each block follows its deltas and is authoritative for that block (see
   * {@link AgentEvent}), so nothing here has to reconcile with it.
   */
  private handleStreamEvent(event: ClaudeStreamEvent, emit: (event: AgentEvent) => void): void {
    // Token counts come from `message_delta` alone. The `assistant` lines carry
    // a usage snapshot taken at `message_start`, before any output — its
    // `output_tokens` is a placeholder — and the result's `usage` re-sums these
    // same calls, so either would count them twice.
    if (event.type === 'message_start') this.plannerModel = event.message?.model;
    else if (event.type === 'message_delta' && event.usage) emit({ type: 'usage', record: usageRecord(event.usage, this.plannerModel) });
    else if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
      this.pendingBreak = this.turnHasText;
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      if (this.pendingBreak) emit({ type: 'assistant_text_delta', text: '\n\n' });
      this.pendingBreak = false;
      emit({ type: 'assistant_text_delta', text: event.delta.text });
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && event.delta.thinking) {
      emit({ type: 'thinking_delta', text: event.delta.thinking });
    }
  }

  /**
   * What only the result line knows: the cost, which covers every call the
   * session made — subagents included, since none of their lines carries one —
   * and the planner model's window. `total_cost_usd` is a running total, so a
   * turn reports its growth. The first turn after a resume only sets the
   * baseline: its total includes turns counted before, and a turn's own share
   * cannot be told apart from them.
   */
  private reportSessionCost(msg: ClaudeLine, emit: (event: AgentEvent) => void): void {
    const record: UsageRecord = { source: 'claude-code' };
    const total = msg.total_cost_usd;
    if (typeof total === 'number') {
      if (this.reportedCostUsd !== undefined && total > this.reportedCostUsd) {
        record.reportedCost = { amount: total - this.reportedCostUsd, currency: 'USD' };
      }
      this.reportedCostUsd = total;
    }
    const contextWindow = this.plannerModel ? msg.modelUsage?.[this.plannerModel]?.contextWindow : undefined;
    if (contextWindow !== undefined) record.contextWindow = contextWindow;
    if (record.reportedCost || record.contextWindow !== undefined) emit({ type: 'usage', record });
  }
}
