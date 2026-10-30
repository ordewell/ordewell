import type { ApprovalDecision } from '../interfaces/IApproval';
import type { ScriptRun, ScriptStatus, StructuredEvent, StructuredTurnEnd, TaskMessageFrom } from '../interfaces/IRunner';
import { commandLine } from './ScriptTask';
import type { SubagentOutcome, TaskSkillNotice, TaskSkillSnapshot } from './Task';
import type { UsageRecord } from './Usage';
import type { RunnerCommand, RunnerMcpServer, RunnerModelRef } from './RunnerCommand';
import type { StoredHandoff } from './Handoff';

/**
 * One entry of a structured task's log (ADR-0018, P1): what a runner did,
 * normalized and serializable, streamed live as `task_log` and appended to
 * the attempt's `.jsonl` file. The live view and the reload fold the same
 * events through `reduceTaskLog`, so the two cannot disagree.
 *
 * Readers skip a type they do not know, which is how later events join
 * without a format version.
 */
export type TaskLogEvent =
  /**
   * The task skills this attempt's prompt carried, as read at its spawn
   * (ADR-0024): first in its log. The file keeps their bodies; a surface is
   * sent notices ({@link taskLogForSurface}).
   */
  | { type: 'task_skills'; skills: TaskSkillSnapshot[] | TaskSkillNotice[] }
  /**
   * A turn began by delivering `message`; `messageId` names it when it had been
   * queued, `forced` when it was force sent. `from` on this and the other
   * message events marks one Ordewell sent rather than the user. `startedAt`
   * (ISO) is when it began, which a reload needs to date its open turn (#81);
   * a log saved before it was kept has none.
   */
  | { type: 'turn_start'; message: string; messageId?: string; forced?: boolean; from?: TaskMessageFrom; startedAt?: string }
  /**
   * A turn began by running the runner's own command `/name args` (#66): the
   * `turn_start` of a command turn. `messageId` names it when it had been queued.
   */
  | { type: 'command'; name: string; args?: string; messageId?: string; startedAt?: string }
  /** What the running command printed, for one that runs without the model. */
  | { type: 'command_output'; text: string }
  /** The runner compacted its own context, asked to or on its own. */
  | { type: 'compaction'; trigger: 'manual' | 'auto'; preTokens?: number; postTokens?: number }
  /**
   * The runner's main thread moved to another model, and what the plan says
   * once the write-back settled (#106): written from its outcome, not from the
   * runner's event, so the line never claims an edit that did not land.
   * `kept` says why the plan did not follow, when it did not. A log saved
   * before the plan's side was recorded has no `plan`: it says nothing of it.
   */
  | { type: 'model_switched'; from: RunnerModelRef; to: RunnerModelRef; plan?: { model?: RunnerModelRef; effort?: string }; kept?: string }
  /** What the runner loaded from the user's and the project's setup, as its process started. */
  | { type: 'runner_loaded'; commands: RunnerCommand[]; mcpServers: RunnerMcpServer[] }
  | { type: 'turn_end'; reason: StructuredTurnEnd }
  /**
   * A piece of the run `runId` of the agent's reply (see `AgentEvent`). A log
   * saved before runs carried an id has none, and opens each later run of a
   * turn with the paragraph break that joined it.
   */
  | { type: 'text_delta'; runId?: string; text: string }
  /** A complete run of the agent's reply, authoritative over the deltas streamed under its `runId`. */
  | { type: 'text'; runId?: string; text: string }
  | { type: 'thinking_delta'; text: string; subagentId?: string }
  | { type: 'thinking'; text: string; subagentId?: string }
  /** `args` is the call's arguments as JSON, exactly as the runner announced them. */
  | { type: 'tool_call'; id: string; name: string; args: string; subagentId?: string }
  /** `omittedLines` is set when {@link trimToolOutput} cut the middle of `output`. */
  | { type: 'tool_result'; id: string; output: string; success: boolean; omittedLines?: number; subagentId?: string }
  | { type: 'subagent_started'; subagentId: string; brief: string; model?: string }
  | { type: 'subagent_finished'; subagentId: string; outcome: SubagentOutcome; digest: string }
  | { type: 'usage'; record: UsageRecord }
  /**
   * Waiting in Ordewell's queue — again, for a message the runner was handed
   * and let go of (ADR-0023, D4). `forced` moves it ahead of the rest (F2).
   */
  | { type: 'message_queued'; messageId: string; text: string; forced?: boolean; from?: TaskMessageFrom }
  | { type: 'message_removed'; messageId: string }
  | { type: 'message_undelivered'; messageId: string; text: string; from?: TaskMessageFrom }
  /** The runner accepted a queued message into its running turn; it can no longer be taken back. */
  | { type: 'message_handed_over'; messageId: string }
  /**
   * The model read a message inside its running turn (ADR-0023, Q2), logged
   * where it read it. A message that opened a turn is that turn's `turn_start`.
   */
  | { type: 'message_delivered'; messageId: string; text: string; from?: TaskMessageFrom }
  /** The agent's own words for a failed turn. */
  | { type: 'error'; message: string }
  /**
   * The runner asked to use a tool its mode does not cover (ADR-0018, A1).
   * `approvalId` is what the answer is given under; `args` is the call's
   * arguments as JSON; `allowForTask` says the runner offered its own
   * session-scoped grant. `decided` is set when the request was never left
   * open — an Ordewell tool or an auto-approving mode — so a surface does not
   * offer to answer what is already answered (it is still followed by the
   * matching `approval_decided`, which a reader may rely on).
   */
  | { type: 'approval_requested'; approvalId: string; tool: string; args: string; allowForTask: boolean; toolCallId?: string; decided?: ApprovalDecision['decision'] }
  | { type: 'approval_decided'; approvalId: string; decision: ApprovalDecision['decision']; note?: string }
  /** The request went unanswered: the runner withdrew it, or its process ended. */
  | { type: 'approval_withdrawn'; approvalId: string }
  /**
   * The runner's process ended. A call it had not reported back on is not
   * running any more: a stopped runner can end with a call still open, a
   * killed turn or a process that exits before its last result.
   */
  | { type: 'runner_ended' }
  /** A script task's command as it ran (ADR-0035): its argument vector, or its script, once. */
  | ({ type: 'script_run' } & ScriptRun)
  /** What it printed; `omittedChars` on the tail of an output too long to keep, for the middle left out. */
  | { type: 'script_output'; text: string; omittedChars?: number }
  /** How it ended — exit code, or the signal that ended it — and after how long; `timedOut` when the task's limit ended it. */
  | ({ type: 'script_exit'; durationMs: number; timedOut?: true } & ScriptStatus)
  /**
   * The handoff the attempt ended with (ADR-0047), whole: every finding and
   * the report, which the plan's digest leaves out. Written once, as its
   * verdict settles.
   */
  | { type: 'handoff'; handoff: StoredHandoff };

const HEAD_LINES = 60;
const TAIL_LINES = 40;
const MAX_LINE_CHARS = 2000;
const DIGEST_ARGS_CHARS = 120;
const DIGEST_MESSAGE_CHARS = 1000;

function capLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

/**
 * Keep a tool result's head and tail. A build log or a whole file read can
 * run to megabytes, and every attempt's file keeps it for good; the ends are
 * where a reader looks — the command's start, and how it finished.
 */
export function trimToolOutput(output: string): { output: string; omittedLines?: number } {
  const lines = output.split('\n');
  const long = lines.some((l) => l.length > MAX_LINE_CHARS);
  if (lines.length <= HEAD_LINES + TAIL_LINES) return long ? { output: lines.map(capLine).join('\n') } : { output };
  const omittedLines = lines.length - HEAD_LINES - TAIL_LINES;
  const kept = [
    ...lines.slice(0, HEAD_LINES),
    `… ${omittedLines} line${omittedLines === 1 ? '' : 's'} omitted …`,
    ...lines.slice(-TAIL_LINES),
  ];
  return { output: kept.map(capLine).join('\n'), omittedLines };
}

function sender({ from }: { from?: TaskMessageFrom }): { from?: TaskMessageFrom } {
  return from ? { from } : {};
}

function withSubagent<E extends TaskLogEvent>(event: E, subagentId: string | undefined): E {
  return subagentId ? { ...event, subagentId } : event;
}

/**
 * The log entry for one structured event, or null for what the log does not
 * keep: background-agent launches, which the subagent's own events already
 * show, and a model change, which is logged with what the plan made of it.
 */
export function toTaskLogEvent(event: StructuredEvent): TaskLogEvent | null {
  switch (event.type) {
    case 'turn_start':
      if (event.command) {
        return { type: 'command', name: event.command.name, ...(event.command.args ? { args: event.command.args } : {}), ...(event.messageId ? { messageId: event.messageId } : {}) };
      }
      return {
        type: 'turn_start', message: event.text, ...(event.messageId ? { messageId: event.messageId } : {}), ...(event.forced ? { forced: true } : {}), ...sender(event),
      };
    case 'turn_end':
      return { type: 'turn_end', reason: event.reason };
    case 'assistant_text_delta':
      return { type: 'text_delta', runId: event.runId, text: event.text };
    case 'assistant_text':
      return { type: 'text', runId: event.runId, text: event.text };
    case 'thinking_delta':
    case 'thinking':
      return withSubagent({ type: event.type, text: event.text }, event.subagentId);
    case 'tool_call':
      return withSubagent({ type: 'tool_call', id: event.id, name: event.name, args: JSON.stringify(event.args) }, event.subagentId);
    case 'tool_result': {
      const { output, omittedLines } = trimToolOutput(event.output);
      return withSubagent({ type: 'tool_result', id: event.id, output, success: event.success, ...(omittedLines ? { omittedLines } : {}) }, event.subagentId);
    }
    case 'subagent_started':
      return { type: 'subagent_started', subagentId: event.subagentId, brief: event.brief, ...(event.model ? { model: event.model } : {}) };
    case 'subagent_finished':
      return { type: 'subagent_finished', subagentId: event.subagentId, outcome: event.outcome, digest: event.digest };
    case 'usage':
      return { type: 'usage', record: event.record };
    case 'message_queued':
      return { type: 'message_queued', messageId: event.messageId, text: event.text, ...(event.forced ? { forced: true } : {}), ...sender(event) };
    case 'message_undelivered':
      return { type: 'message_undelivered', messageId: event.messageId, text: event.text, ...sender(event) };
    case 'message_removed':
      return { type: 'message_removed', messageId: event.messageId };
    case 'message_handed_over':
      return { type: 'message_handed_over', messageId: event.messageId };
    case 'message_delivered':
      return { type: 'message_delivered', messageId: event.messageId, text: event.text, ...sender(event) };
    case 'error':
      return { type: 'error', message: event.message };
    case 'permission_request':
      return {
        type: 'approval_requested',
        approvalId: event.id,
        tool: event.name,
        args: event.detail,
        allowForTask: (event.suggestions?.length ?? 0) > 0,
        ...(event.decided ? { decided: event.decided.decision } : {}),
        ...(event.toolUseId ? { toolCallId: event.toolUseId } : {}),
      };
    case 'permission_decided': {
      const note = event.decision.decision === 'deny' ? event.decision.note : undefined;
      return { type: 'approval_decided', approvalId: event.id, decision: event.decision.decision, ...(note ? { note } : {}) };
    }
    case 'permission_withdrawn':
      return { type: 'approval_withdrawn', approvalId: event.id };
    case 'runner_loaded':
      return { type: 'runner_loaded', commands: event.commands, mcpServers: event.mcpServers };
    case 'compaction':
      return {
        type: 'compaction', trigger: event.trigger,
        ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}), ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}),
      };
    case 'command_output':
      return { type: 'command_output', text: event.text };
    case 'script_run':
      return 'argv' in event ? { type: 'script_run', argv: [...event.argv] } : { type: 'script_run', script: event.script };
    case 'script_output':
      return { type: 'script_output', text: event.text, ...(event.omittedChars ? { omittedChars: event.omittedChars } : {}) };
    case 'script_exit':
      return {
        type: 'script_exit', code: event.code, signal: event.signal, durationMs: event.durationMs,
        ...(event.timedOut ? { timedOut: true } : {}), ...(event.error !== undefined ? { error: event.error } : {}),
      };
    // The call is in the log already; its receipt is the task's state, not an entry.
    case 'completion_received':
      return null;
    // Logged once the plan's write-back settles: see `TaskLogRecorder.note`.
    case 'model_switched':
    case 'model_drifted':
    case 'background_agent':
      return null;
  }
}

/**
 * The model the task's own thread last ran a call on, as its usage reports it
 * (`provider/model` for OpenCode); a subagent's calls and session totals do
 * not say what the task runs on. Undefined when no call in `events` names one.
 */
export function lastServedModel(events: readonly TaskLogEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'usage' && event.record.model && !event.record.subagentId && !event.record.aggregate) return event.record.model;
  }
  return undefined;
}

/** A log as a surface is sent it, live or read back: everything but the skills' bodies. */
export function taskLogForSurface(events: readonly TaskLogEvent[]): TaskLogEvent[] {
  return events.map((event): TaskLogEvent => event.type === 'task_skills'
    ? { type: 'task_skills', skills: event.skills.map(({ name, source, path }): TaskSkillNotice => ({ name, source, path })) }
    : event);
}

/**
 * Merge consecutive deltas of one stream into one event each: of one run of
 * text, of one voice's thinking, or of what a script's command printed. Deltas arrive a few characters at a time;
 * merged, a batch is one message on the wire and one line on disk, and the
 * view folds to the same blocks either way.
 */
export function coalesceTaskLog(events: readonly TaskLogEvent[]): TaskLogEvent[] {
  const out: TaskLogEvent[] = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (last?.type === 'text_delta' && event.type === 'text_delta' && last.runId === event.runId) {
      out[out.length - 1] = { ...last, text: last.text + event.text };
    } else if (last?.type === 'thinking_delta' && event.type === 'thinking_delta' && last.subagentId === event.subagentId) {
      out[out.length - 1] = { ...last, text: last.text + event.text };
    } else if (last?.type === 'script_output' && event.type === 'script_output' && !last.omittedChars && !event.omittedChars) {
      out[out.length - 1] = { ...last, text: last.text + event.text };
    } else {
      out.push(event);
    }
  }
  return out;
}

/** A script step as one line of a digest or a reader's text: the command as typed, or the script's first line. */
export function scriptRunText(run: ScriptRun): string {
  if ('argv' in run) return commandLine(run.argv);
  const lines = run.script.trim().split('\n');
  return lines.length > 1 ? `${lines[0]} … (${lines.length} lines)` : lines[0];
}

/** A duration as a reader says it: seconds to a tenth. */
export function secondsText(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

/** How a script step ended, as a reader says it. */
export function scriptExitText(exit: Omit<Extract<TaskLogEvent, { type: 'script_exit' }>, 'type'>): string {
  const seconds = secondsText(exit.durationMs);
  if (exit.error !== undefined) return `could not start: ${exit.error}`;
  const how = exit.signal ? `ended by ${exit.signal}` : `exited ${exit.code ?? 'unknown'}`;
  return `${how} after ${seconds}${exit.timedOut ? ': the time limit ran out' : ''}`;
}

/**
 * What an attempt did to the world, for the retry of a task whose effects
 * outlive it (ADR-0020): one line per tool call, or per script step, and how
 * it ended.
 */
export function digestTaskLog(events: readonly TaskLogEvent[], maxCalls: number): string {
  const outcomes = new Map<string, boolean>();
  let lastText: string | undefined;
  let lastError: string | undefined;
  for (const event of events) {
    if (event.type === 'tool_result') outcomes.set(event.id, event.success);
    else if (event.type === 'text') lastText = event.text;
    else if (event.type === 'error') lastError = event.message;
  }
  const lines: string[] = [];
  let step: string | undefined;
  for (const event of events) {
    if (event.type === 'script_run') {
      if (step !== undefined) lines.push(`- ${step} → no result`);
      step = scriptRunText(event);
      continue;
    }
    if (event.type === 'script_exit' && step !== undefined) {
      lines.push(`- ${step} → ${scriptExitText(event)}`);
      step = undefined;
      continue;
    }
    if (event.type !== 'tool_call') continue;
    const outcome = outcomes.get(event.id);
    const args = event.args.length > DIGEST_ARGS_CHARS ? `${event.args.slice(0, DIGEST_ARGS_CHARS)}…` : event.args;
    lines.push(`- ${event.name} ${args} → ${outcome === undefined ? 'no result' : outcome ? 'ok' : 'failed'}`);
  }
  if (step !== undefined) lines.push(`- ${step} → no result`);
  const omitted = lines.length - maxCalls;
  const out = omitted > 0 ? [`… ${omitted} earlier call${omitted === 1 ? '' : 's'} omitted …`, ...lines.slice(omitted)] : lines;
  const gap = (): string[] => (out.length > 0 ? [''] : []);
  const said = lastText?.trim();
  if (said) {
    const end = said.length > DIGEST_MESSAGE_CHARS ? `…${said.slice(-DIGEST_MESSAGE_CHARS)}` : said;
    out.push(...gap(), 'Its last message:', ...end.split('\n').map((l) => `  ${l}`));
  }
  if (lastError) out.push(...gap(), `It stopped with an error: ${lastError}`);
  return out.join('\n');
}
