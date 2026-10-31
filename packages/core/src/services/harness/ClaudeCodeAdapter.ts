import { randomUUID } from 'crypto';
import { realpathSync } from 'fs';
import * as path from 'path';
import type { SubagentOutcome } from '../../models/Task';
import { partedPromptUsage, type RunnerSessionCost, type SessionBilling, type UsageRecord } from '../../models/Usage';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import { findRunnerCommand, type RunnerCommand, type RunnerMcpServer, type RunnerModelRef } from '../../models/RunnerCommand';
import { claudeThinkingArgs } from '../../plugins/resolveArgs';
import { claudeConfigDir } from '../../plugins/builtin/claudeModels';
import type { RunnerEnv } from '../../plugins/types';
import { expandRunnerHome } from '../../utils/runnerHome';
import type { AgentEvent, AgentStartOptions, PlannerAsk, PlannerStartOptions, TaskModeAgentAdapter, TaskStartOptions } from './AgentAdapter';
import { StdioAgentAdapter, type SpawnSpec } from './StdioAgentAdapter';
import { markedLines, structuredPatchText } from './fileDiff';
import { ORDEWELL_MCP_SERVER_NAME, taskCompletionContract, type McpClientConfig } from '../mcp';
import { assertNoClaudeTaskCollision, CLAUDE_ORDEWELL } from './claudeOrdewell';
import { PermissionLedger } from './permissionLedger';
import { ReplyRuns } from './replyRuns';
import { settleWithin } from './settleWithin';
import { awaitAttach, MCP_ATTACH_TIMEOUT_MS, type AttachState, type OrdewellToolRole } from './ordewellBinding';
import { claudeLocalServers } from './claudeRepoConfig';
import { readOnlyTaskPolicy, readOnlyTask } from './plannerPermissions';
import { isCredentialVariable } from './credentialEnv';
import type { NativeShellLauncher } from '../sandbox/nativeShellLauncher';

/**
 * Native plan mode permits Bash writes to its plan file, and saved allow rules
 * run shell commands without asking. Withhold shell tools and native plan-mode
 * transitions as well as direct edits so neither can reopen that write path;
 * a planner's commands go through Ordewell's `run_command` (ADR-0026). `Monitor`
 * is a shell too and is withheld for the same reason, unless the user's
 * native-shell opt-in puts both under Ordewell's sandbox (ADR-0036 N6).
 */
const DISALLOWED_TOOLS = [
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'KillShell',
  'Bash', 'Monitor', 'PowerShell', 'EnterPlanMode', 'ExitPlanMode',
];

/** Claude Code's own shell tools: what the opt-in lets through (ADR-0036 N2, N6). */
const NATIVE_SHELL_TOOLS = new Set(['Bash', 'Monitor']);

/**
 * `default`, so what the mode cannot decide — an MCP tool the user configured,
 * a fetch, a read outside the workspace — reaches the planner's envelope over
 * `--permission-prompt-tool stdio` (ADR-0026). `dontAsk` denied it unseen.
 */
const PLANNER_PERMISSION_MODE = 'default';

/**
 * Claude Code sends `can_use_tool` only when its own rules say ask, so an
 * allow rule — the user's own, a saved `additionalDirectories` — would run a
 * web read, an MCP tool or a read outside the workspace past the planner's
 * policy, record and budget. An ask rule beats an allow rule from any source,
 * `--allowedTools` included (checked live on 2.1.296), so these always reach
 * the envelope; Ordewell's own tools and in-workspace reads are then allowed
 * at once. A user's own hook runs on the planner's tool calls and can write,
 * which no planner may (ADR-0028).
 */
const PLANNER_ASK_RULES = ['WebFetch', 'WebFetch(domain:*)', 'WebSearch', 'mcp__*', 'Read', 'Grep', 'Glob', 'LS'];
const PLANNER_SETTINGS = JSON.stringify({
  disableAllHooks: true,
  permissions: { ask: PLANNER_ASK_RULES },
});

/**
 * The planner's settings with the native shell on (ADR-0036 N2, N3): the
 * launcher and its short temporary directory go in the `env` block, because a
 * settings `env` from another layer takes precedence over the process
 * environment, and set here it wins over that. Claude Code's own sandbox is
 * off: it takes extra writable paths from user settings `--settings` cannot
 * remove, so it could not hold N2.1, and Ordewell's profile is around every
 * command instead. `Bash` and `Monitor` are asked so a user's own allow rule
 * cannot skip Ordewell's decision.
 */
function nativeShellSettings(launcher: NativeShellLauncher): string {
  return JSON.stringify({
    disableAllHooks: true,
    permissions: { ask: [...PLANNER_ASK_RULES, 'Bash', 'Monitor'] },
    sandbox: { enabled: false },
    env: launcher.env,
  });
}

/**
 * Claude Code's own memory is off for planners and tasks alike (ADR-0032): a
 * plan or a task depends on the repository, not on notes outside it that no
 * reviewer sees. The variable wins over a setting that turns it on (checked
 * live on 2.1.296), and with it off the CLI leaves the memory instructions
 * and index out of the system prompt.
 */
const NO_AUTO_MEMORY = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };

/**
 * Which settings a task's runner reads. A read-only one reads the user's alone
 * with the planner's hooks-off settings on top (ADR-0046), as ever; `minimal`
 * drops the user's source from it, or for a task that writes keeps the
 * repository's alone. The empty value is the form the account query uses.
 */
function settingSources(readOnly: boolean, minimal: boolean): string[] {
  if (readOnly) return [...(minimal ? ['--setting-sources='] : ['--setting-sources', 'user']), '--settings', PLANNER_SETTINGS];
  return minimal ? ['--setting-sources', 'project,local'] : [];
}

/**
 * Where a task's own context compacts. The 1M window of the large models
 * would otherwise never trigger the CLI's auto-compaction, and past this size
 * each call re-reads a long prefix for little new information. Compaction
 * starts somewhat below the window (the CLI keeps a buffer for its summary).
 * The completion contract rides in the system prompt, where a summary cannot
 * drop it. A planner is left alone: its conversation is the user's. The
 * variable, which an older CLI ignores, is read by 2.1.314 (`--autocompact`
 * is the same setting as a flag); a plain integer, because a `k` suffix is
 * only read by newer ones.
 */
const TASK_COMPACT_WINDOW_TOKENS = 150_000;
const TASK_ENV = { ...NO_AUTO_MEMORY, CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(TASK_COMPACT_WINDOW_TOKENS) };

/**
 * A `minimal` task runner's context (`taskRunnerConfig`). Its setting sources
 * ({@link settingSources}) leave out the user's servers, skills, commands,
 * settings and instructions and keep the repository's, which is the toolchain
 * a task was started to use (ADR-0028), so a task must not lose them to save
 * tokens. Connectors come from the account and no source governs them, hence
 * the variable; a CLI that ignores it costs tokens and breaks nothing.
 */
const MINIMAL_TASK_ENV = { ...TASK_ENV, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };

/**
 * A read-only task loads nothing of the repository's in any case (ADR-0046),
 * so `minimal` can leave it Ordewell's server alone, the explicit
 * `--mcp-config` the strict flag admits. Its skills are written into its
 * prompt, not loaded from here.
 */
const MINIMAL_READ_ONLY_ARGS = ['--strict-mcp-config', '--disable-slash-commands'];

/**
 * Whether `abs` is in the folder Claude Code saves this session's long tool
 * results to, `<config>/projects/<project>/<session>/tool-results/`, before
 * telling the model to read them back (checked live on 2.1.296). The project
 * segment is the CLI's own name for the working directory, so any is taken:
 * the session id alone ties the folder to this planner. `abs` is resolved on
 * disk, so a link planted in the folder is judged where it points (ADR-0032).
 */
function inSavedOutput(abs: string, configDir: string, sessionId: string): boolean {
  let projects: string;
  try { projects = realpathSync.native(path.join(configDir, 'projects')); } catch { return false; }
  const rel = path.relative(projects, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const [project, session, folder] = rel.split(path.sep);
  return Boolean(project) && session === sessionId && folder === 'tool-results';
}

/** Claude Code's read tools, by the input field that names their path. */
const PATH_TOOLS: Record<string, { field: string; directory: boolean }> = {
  Read: { field: 'file_path', directory: false },
  Grep: { field: 'path', directory: true },
  Glob: { field: 'path', directory: true },
  LS: { field: 'path', directory: true },
};

/** What a planner's `can_use_tool` request is for (ADR-0026). Claude names an MCP tool `mcp__<server>__<tool>`. */
function plannerAsk(name: string, input: Record<string, unknown>, server: string | undefined, nativeShell: boolean): PlannerAsk {
  if (name.startsWith('mcp__')) {
    const tool = name.split('__').slice(2).join('__');
    return { kind: 'mcp', scope: name, tool: tool || name, ...(server ? { server } : {}) };
  }
  // Only when the opt-in wired the launcher: otherwise these are withheld, and
  // one that reaches here anyway is an unknown tool, not a sandboxed command.
  if (nativeShell && NATIVE_SHELL_TOOLS.has(name)) {
    return { kind: 'native-shell', tool: name, ...(typeof input.command === 'string' ? { command: input.command } : {}) };
  }
  if (name === 'WebFetch' && typeof input.url === 'string') return { kind: 'fetch', url: input.url };
  if (name === 'WebSearch' && typeof input.query === 'string') return { kind: 'search', query: input.query, provider: 'anthropic' };
  const pathTool = PATH_TOOLS[name];
  // A search with no path runs in the working directory, which is the workspace.
  const target = pathTool ? input[pathTool.field] ?? (pathTool.directory ? '.' : undefined) : undefined;
  if (pathTool && typeof target === 'string') return { kind: 'path', path: target, directory: pathTool.directory };
  return { kind: 'other' };
}

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
 * An account query's launch ({@link ClaudeCodeAdapter.openAccountQuery}): the
 * protocol and nothing else. `--safe-mode` keeps the login — `--bare` would
 * never read OAuth, whose plan the limits belong to — while it, the empty
 * setting sources and the hooks switch stop any user, repository or plugin
 * setup from running; no tools, no MCP server, and no session written to disk.
 */
const ACCOUNT_QUERY_ARGS = [
  '-p',
  '--input-format=stream-json',
  '--output-format=stream-json',
  '--verbose',
  '--safe-mode',
  '--setting-sources=',
  '--settings={"disableAllHooks":true}',
  '--strict-mcp-config',
  '--mcp-config={"mcpServers":{}}',
  '--tools=',
  '--permission-mode=default',
  '--no-session-persistence',
];

const INITIALIZE_TIMEOUT_MS = 10_000;
const MCP_STATUS_POLL_MS = 100;

/** A denial's `message` is required by the CLI; this stands in when nobody wrote a note. */
const DEFAULT_DENIAL = 'Denied in Ordewell. Continue without it, or say what you need.';

/** What a `can_use_tool` answer echoes back. */
interface ClaudeAskHandle {
  id: string;
  input: Record<string, unknown>;
  suggestions: unknown[];
}

/**
 * The answer in the shape the CLI validates: an allow echoes the call's own
 * input (an absent one is warned about and replaced), and "for this task"
 * hands back Claude's own suggestions — never a grant of Ordewell's making.
 */
function canUseToolAnswer({ input, suggestions }: ClaudeAskHandle, decision: ApprovalDecision): Record<string, unknown> {
  if (decision.decision === 'deny') return { behavior: 'deny', message: decision.note?.trim() || DEFAULT_DENIAL };
  return {
    behavior: 'allow',
    updatedInput: input,
    ...(decision.decision === 'allowForTask' && suggestions.length > 0 ? { updatedPermissions: suggestions } : {}),
  };
}

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
  /** The content block a `content_block_*` event is about, by its place in the message. */
  index?: number;
  message?: { id?: string; model?: string };
  usage?: ClaudeUsage;
  delta?: { type?: string; text?: string; thinking?: string };
}

/** One model as `initialize` lists it: the value `--model` and `/model` take, the id it runs as, and its name (2.1.302). */
interface ClaudeModel {
  value?: string;
  resolvedModel?: string;
  displayName?: string;
}

/**
 * The CLI's own command that switches the model. Its turn calls no model; the
 * next turn's `init` and `message_start` name the one it now runs (2.1.302).
 */
const MODEL_COMMAND = 'model';

/** One command as `initialize` and `commands_changed` list it (2.1.299); `builtin` marks the CLI's own. */
interface ClaudeCommand {
  name?: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
  builtin?: boolean;
}

interface ControlResponse {
  subtype?: string;
  request_id?: string;
  error?: string;
  /**
   * `mcp_status`: every MCP server the session has, and whether it connected.
   * `initialize`: every model the CLI offers, and the id each value runs as;
   * every command it offers.
   */
  response?: { account?: { subscriptionType?: string; apiKeySource?: string }; mcpServers?: { name?: string; status?: string }[]; models?: ClaudeModel[]; commands?: ClaudeCommand[] };
}

/**
 * What one control request came to: its answer's payload as the CLI sent it,
 * the CLI's refusal in its own words, or no answer in time — with the
 * process's stderr tail when it ended instead.
 */
export type ClaudeControlAnswer =
  | { kind: 'answered'; response: unknown }
  | { kind: 'refused'; error: string }
  | { kind: 'silent'; lastWords?: string };

interface ClaudeLine {
  type: string;
  subtype?: string;
  session_id?: string;
  /** `init`: the mode the CLI actually started in. */
  permissionMode?: string;
  /** `init`: the CLI's own version, named before the first tool call. */
  claude_code_version?: string;
  /** `init`: the model the turn runs on, as the id it resolved to. */
  model?: string;
  result?: string;
  is_error?: boolean;
  /** A failed result's own words when it has no `result` text — a refused `--resume`, say. */
  errors?: string[];
  request_id?: string;
  request?: {
    subtype?: string;
    tool_name?: string;
    input?: Record<string, unknown>;
    permission_suggestions?: unknown[];
    tool_use_id?: string;
    mcp_server?: { name?: string };
  };
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
  /** A turn's own token sum, as its `result` reports it; every call that streamed already reported its own. */
  usage?: ClaudeUsage;
  modelUsage?: Record<string, { contextWindow?: number; costUSD?: number; costBasis?: 'list' | 'managed' | 'unknown' }>;
  apiKeySource?: string;
  /** `background_tasks_changed`: every background task still running, not just the change. */
  tasks?: unknown[];
  /** `task_notification`: which `Agent` call finished, how, and what it reported. */
  tool_use_id?: string;
  status?: string;
  summary?: string;
  /** A `user` line the CLI echoes back from stdin under `--replay-user-messages`, with the `uuid` it was written under. */
  isReplay?: boolean;
  uuid?: string;
  /** `init`: the skills among its commands, by name — a plugin's as `plugin:skill`, which its command lists as an alias. */
  skills?: string[];
  /** `init`: the names of every command it offers, without the descriptions `initialize` has. */
  slash_commands?: string[];
  /** `init`: commands that only work in its own TUI, which `-p` lists all the same. */
  terminal_slash_commands?: string[];
  /** `init`: the session's MCP servers and how far each got. */
  mcp_servers?: { name?: string; status?: string }[];
  /** `commands_changed`: the whole list again, as `initialize` gives it. */
  commands?: ClaudeCommand[];
  /** `compact_boundary`: what asked for the compaction, and the context before and after it. */
  compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number };
}

/** The tool Claude Code delegates to a subagent with — `Task` before it was renamed `Agent`. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

/** A model id's variant suffix, as in `claude-sonnet-5[1m]`. */
const VARIANT_SUFFIX = /^(.*?)(\[[^\]]*\])?$/;

/** Whether two ids name one model, one carrying a variant suffix such as `[1m]`. */
function sameModel(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === b) return true;
  const [, aBase, aVariant] = VARIANT_SUFFIX.exec(a) ?? [];
  const [, bBase, bVariant] = VARIANT_SUFFIX.exec(b) ?? [];
  return aBase === bBase && (aVariant === undefined || bVariant === undefined || aVariant === bVariant);
}

/**
 * Anthropic's `input_tokens` is only the uncached tail of the prompt — see
 * {@link partedPromptUsage}. The main thread's context is the whole prompt
 * and the reply, as Claude Code counts its last message's usage (`input_tokens
 * + cache_creation_input_tokens + cache_read_input_tokens + output_tokens`, read
 * in the 2.1.303 CLI) for its own context warning and auto-compaction.
 */
function usageRecord(usage: ClaudeUsage, model: string | undefined, subagentId?: string): UsageRecord {
  const record: UsageRecord = {
    source: 'claude-code',
    ...partedPromptUsage({ uncached: usage.input_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens }),
  };
  if (model) record.model = model;
  if (usage.output_tokens !== undefined) record.outputTokens = usage.output_tokens;
  if (subagentId) record.subagentId = subagentId;
  else if (record.inputTokens !== undefined) record.contextTokens = record.inputTokens + (record.outputTokens ?? 0);
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

/**
 * What a command that runs without the model printed: the CLI echoes it as a
 * user line wrapped in `<local-command-stdout>` (or `-stderr`), as `/compact`'s
 * "Compacted" is (2.1.299).
 */
function localCommandOutput(content: ClaudeBlock[] | string | undefined): string {
  const text = typeof content === 'string' ? content : flattenContent(content);
  const match = /^<local-command-(?:stdout|stderr)>([\s\S]*)<\/local-command-(?:stdout|stderr)>$/.exec(text.trim());
  return match ? match[1].trim() : '';
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
  private readonly permissions = new PermissionLedger<ClaudeAskHandle>(
    (handle, decision) => this.writeLine({ type: 'control_response', response: { subtype: 'success', request_id: handle.id, response: canUseToolAnswer(handle, decision) } }),
    () => ({ role: this.role, autoApprove: false, decide: readOnlyTaskPolicy(this.readOnlySite) }),
  );
  private readOnlySite: TaskStartOptions | null = null;
  /** The sealed launcher this process's shell goes through, when the opt-in is on (ADR-0036 N2). */
  private nativeShell: NativeShellLauncher | null = null;

  /** This turn's runs of reply text, each a text block named `<message id>:<block index>`. */
  private replyRuns = new ReplyRuns();
  /** The model answering the planner's current message, and the message's id, as its `message_start` named them. */
  private plannerModel: string | undefined;
  /** The CLI's version, from its first `init`; the native-shell check reads it (ADR-0036 N2). */
  private installedVersion: string | null = null;
  /**
   * The id the turn runs as, as `init` names it. A `[1m]` variant is the
   * selected id, while a message names the API's canonical id without it.
   */
  private sessionModel: string | undefined;
  private billing: SessionBilling | undefined;
  private streamingMessage: string | undefined;
  /** The message the last `assistant` line was part of, and how many of its blocks the lines have carried. */
  private lineMessage: { id: string; blocks: number } | null = null;
  /**
   * What has been counted of the session's running cost: a resume starts from
   * it, and it is undefined without a kept count — the next result then only
   * sets the baseline, since the CLI restores spend from turns before it. It
   * grows by what each result is counted for, never by a total that includes
   * cost the runner marked unknown, so that spend can be counted when its basis
   * is reported; and it never lowers, since counted dollars are not un-spent.
   */
  private reportedCostUsd: number | undefined = 0;
  private reportedModelCostUsd = new Map<string, number>();
  /** What this turn's streamed calls already reported, so its result only adds what did not stream. */
  private turnCallUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
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
  /** Whether this process was given the server, so its tools' requests are Ordewell's own. */
  private givenOrdewell = false;
  /** The `CLAUDE_CONFIG_DIR` a planner runs under, where the CLI saves its long tool results. */
  private configDir: string | null = null;
  /** Messages written into a running task turn, by the `uuid` their echo will carry, until it does (ADR-0023). */
  private readonly steers = new Map<string, string>();
  /** The last turn's `result` ended it, so a steer's echo now opens a turn the CLI started for that message. */
  private turnClosed = false;
  /** The model is working in a turn the CLI opened itself, after the last one closed: a background wake. */
  private runnerTurn = false;
  /** The task's commands as the CLI last listed them, and what its `init` said of them (#66). */
  private listedCommands: ClaudeCommand[] = [];
  private skillNames = new Set<string>();
  private terminalOnly = new Set<string>();
  /** Whether this process's `runner_loaded` went out: its first `init` sends it. */
  private loadedReported = false;
  /** The models `initialize` listed, which turn the ids the CLI reports back into the ones a plan holds. */
  private listedModels: ClaudeModel[] = [];
  /** The id the task's main thread last reported answering on. */
  private mainModel: string | undefined;
  /** What the plan should say the task runs: its spawn's model, then each switch followed. */
  private followedModel: string | undefined;
  /**
   * Model commands sent through the chat whose switch has not been seen yet,
   * oldest first, each with the turns still to end before its own has. Several
   * can be pending: a command's switch is first reported by the next turn's
   * `init`, which can be another `/model`'s.
   */
  private modelCommands: { args: string; turnsLeft: number }[] = [];

  /**
   * Prepare the native shell before the process starts, or fail the start
   * rather than run it outside a sandbox. The launcher is a file this process
   * owns: `CLAUDE_CODE_SHELL_PREFIX` can only name a program, and Claude Code
   * hands it the whole command as one argument (ADR-0036 N2).
   */
  override async start(opts: AgentStartOptions): Promise<void> {
    this.nativeShell = await this.ownNativeShell(opts);
    await super.start(opts);
  }

  protected spawnSpec(opts: AgentStartOptions, workspace: Record<string, string>): SpawnSpec {
    if (opts.kind === 'task') return this.taskSpawnSpec(opts);
    const nativeShell = this.nativeShell;
    const disallowed = nativeShell ? DISALLOWED_TOOLS.filter((tool) => !NATIVE_SHELL_TOOLS.has(tool)) : DISALLOWED_TOOLS;
    const args = [
      ...PROTOCOL_ARGS,
      // The read-only guarantee, enforced at spawn rather than by prompt.
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', PLANNER_PERMISSION_MODE,
      '--disallowedTools', disallowed.join(','),
      // In `-p` a repository's settings apply trusted or not: their hooks,
      // `env` and helper commands run before the first turn (ADR-0028).
      '--setting-sources', 'user',
      '--settings', nativeShell ? nativeShellSettings(nativeShell) : PLANNER_SETTINGS,
      '--append-system-prompt', opts.systemPrompt,
    ];
    if (opts.mcp) args.push(...this.ordewellServerArgs(opts.mcp, 'planner', this.plannerServers(opts, { ...process.env, ...workspace })));
    if (opts.model) args.push('--model', opts.model);
    // `adaptive` is a thinking *type*, not an effort rung: `--effort adaptive`
    // is warned about and ignored, and adaptive is the default for every model
    // that offers it. Passing nothing is the same run without the warning on
    // stderr.
    if (opts.effort && opts.effort !== 'adaptive') args.push('--effort', opts.effort);
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
      this.countFrom(opts.resumeSessionId, opts.resumeCost);
      this.pendingResume = opts.resumeSessionId;
    }
    const env = { ...process.env, ...workspace };
    this.configDir = expandRunnerHome(claudeConfigDir(env), env);
    // N2.2: a sandboxed command can read its parent's environment on macOS, so
    // the credentials must not be in this process at all. The harness's own
    // login stays (N3). The launcher's two variables are here as well as in
    // `--settings` env: the settings block is the one that wins, and this
    // covers whatever reads them before settings are parsed.
    return {
      command: 'claude',
      args,
      env: nativeShell ? { ...NO_AUTO_MEMORY, ...nativeShell.env } : NO_AUTO_MEMORY,
      ...(nativeShell ? { envDrop: isCredentialVariable } : {}),
    };
  }

  sessionCost(): RunnerSessionCost | null {
    const sessionId = this.sessionId ?? this.pendingResume;
    if (!sessionId || this.reportedCostUsd === undefined) return null;
    return { sessionId, usd: this.reportedCostUsd, modelUsd: Object.fromEntries(this.reportedModelCostUsd) };
  }

  version(): string | null { return this.installedVersion; }

  /**
   * A cleared conversation's totals start again from zero, so what follows is
   * all new spend, even for a resume that had no count kept.
   */
  private restartCount(): void {
    this.reportedCostUsd = 0;
    this.reportedModelCostUsd = new Map();
  }

  /** A count kept for another session says nothing of this one's. */
  private countFrom(sessionId: string, counted: RunnerSessionCost | undefined): void {
    const known = counted?.sessionId === sessionId ? counted : undefined;
    this.reportedCostUsd = known?.usd;
    this.reportedModelCostUsd = new Map(Object.entries(known?.modelUsd ?? {}));
  }

  savedOutput(abs: string): boolean {
    return this.configDir !== null && this.sessionId !== null && inSavedOutput(abs, this.configDir, this.sessionId);
  }

  /**
   * A task's run: the manifest decides what its mode and effort mean
   * (ADR-0001). Read-only tasks withhold native writes and shell tools
   * (ADR-0046); other tasks keep the runner's native tools. The prompt is its
   * first turn, and the contract is where the CLI's own compaction cannot
   * summarise it away. `--permission-prompt-tool stdio` routes the questions the mode
   * leaves open to the control channel, where the adapter must answer them;
   * without it `-p` refuses them silently and nothing can ever surface one.
   */
  private taskSpawnSpec(opts: TaskStartOptions): SpawnSpec {
    const readOnly = readOnlyTask(opts);
    const minimal = opts.runnerConfig === 'minimal';
    if (!readOnly) assertNoClaudeTaskCollision(opts.cwd);
    this.readOnlySite = readOnly ? opts : null;
    this.requestedMode = readOnly ? PLANNER_PERMISSION_MODE : opts.flags.permissionMode;
    this.followedModel = opts.model;
    const args = [
      ...TASK_PROTOCOL_ARGS,
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', this.requestedMode,
      '--disallowedTools', [...TASK_DISALLOWED_TOOLS, ...(readOnly ? DISALLOWED_TOOLS : [])].join(','),
      ...settingSources(readOnly, minimal),
      ...(minimal && readOnly ? MINIMAL_READ_ONLY_ARGS : []),
      ...(opts.flags.effort ? claudeThinkingArgs(opts.flags.effort) : []),
    ];
    if (opts.model) args.push('--model', opts.model);
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
      this.countFrom(opts.resumeSessionId, opts.resumeCost);
      this.pendingResume = opts.resumeSessionId;
    }
    if (opts.mcp) args.push('--append-system-prompt', taskCompletionContract(opts), ...this.ordewellServerArgs(opts.mcp, readOnly ? 'readOnlyTask' : 'task'));
    return { command: 'claude', args, env: minimal ? MINIMAL_TASK_ENV : TASK_ENV };
  }

  /**
   * What user-only settings stop the CLI loading that is not the
   * repository's to choose (ADR-0028): the user's own local-scope servers,
   * from the account in the environment the planner runs with, and the
   * project servers approved for it.
   */
  private plannerServers(opts: PlannerStartOptions, env: RunnerEnv): Record<string, unknown> {
    return {
      ...claudeLocalServers(env, opts.cwd),
      ...Object.fromEntries((opts.projectServers ?? []).map((server) => [server.name, server.definition])),
    };
  }

  /** The file holding the token lives exactly as long as the process that reads it. */
  private ordewellServerArgs(mcp: McpClientConfig, role: OrdewellToolRole, servers?: Record<string, unknown>): string[] {
    const { args, config } = CLAUDE_ORDEWELL.launch(mcp, role, servers);
    this.own('mcp-config', () => config.remove());
    this.givenOrdewell = true;
    return args;
  }

  protected override async handshake(): Promise<void> {
    // Before the first turn, `initialize` is the one place the CLI lists its
    // commands with their descriptions and argument hints (checked on
    // 2.1.299); `init` names them only.
    const initialized = (await this.control({ subtype: 'initialize' }, INITIALIZE_TIMEOUT_MS))?.response;
    this.listedCommands = initialized?.commands ?? [];
    this.listedModels = initialized?.models ?? [];
  }

  /**
   * What `-p` can run. The CLI lists commands only its TUI runs (`init`'s
   * `terminal_slash_commands`) and internal ones named `__…` all the same.
   */
  commands(): RunnerCommand[] {
    return this.listedCommands.flatMap((c): RunnerCommand[] => {
      if (!c.name || c.name.startsWith('__') || this.terminalOnly.has(c.name)) return [];
      const aliases = c.aliases?.filter(Boolean) ?? [];
      const skill = this.skillNames.has(c.name) || aliases.some((a) => this.skillNames.has(a));
      return [{
        name: c.name,
        description: c.description ?? '',
        ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
        kind: c.builtin ? 'builtin' : skill ? 'skill' : 'command',
        ...(aliases.length > 0 ? { aliases } : {}),
      }];
    });
  }

  /**
   * Asks the CLI itself, which reports `pending` until its connection attempt
   * settles. A process that exited ends the wait at once: its report is gone
   * with it, and no answer would ever come.
   */
  async mcpAttached(): Promise<AttachState> {
    if (!this.givenOrdewell || this.isDisposed) return 'failed';
    return awaitAttach(async (left) => {
      if (this.exited) return 'failed';
      const answer = await this.control({ subtype: 'mcp_status' }, left);
      if (this.exited) return 'failed';
      if (!answer) return 'pending';
      const server = answer.response?.mcpServers?.find((s) => s.name === ORDEWELL_MCP_SERVER_NAME);
      return server ? CLAUDE_ORDEWELL.attachState(server.status) : 'pending';
    }, MCP_ATTACH_TIMEOUT_MS, MCP_STATUS_POLL_MS, this.processEnded);
  }

  /**
   * Claude Code's soft interrupt: the turn stops, the process and its session
   * stay. The CLI acknowledges on the control channel, then closes the turn
   * with an `error_during_execution` result, which {@link handleLine} reports
   * as an interrupted `turn_end`.
   */
  async interrupt(timeoutMs: number): Promise<boolean> {
    // Between turns there is nothing to stop, and remembering the request
    // would call the next turn the runner opens by itself interrupted.
    if (!this.process || (this.turnClosed && !this.runnerTurn)) return false;
    // A held turn's model is idle and only background work runs: the CLI has
    // no turn to end, so the turn ends here and that work is left alone.
    if (this.resultHeld) {
      this.resultHeld = false;
      this.clearFollowOnTimer();
      this.closeTurn({ type: 'turn_end', interrupted: true }, (event) => this.announce(event));
      return true;
    }
    this.interruptRequested = true;
    return (await this.control({ subtype: 'interrupt' }, timeoutMs))?.subtype === 'success';
  }

  /**
   * On stdin's end the CLI exits by itself once its turn has closed, and only
   * an exit of its own saves the session's running totals for a `--resume` to
   * restore (checked on 2.1.303: about a second later, code 0, or 1 after an
   * interrupted turn).
   */
  endInput(): void {
    this.process?.stdin?.end();
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
    // It runs once the turn it was sent into ends, if the CLI runs it as a command at all.
    this.noteModelCommand(text, 2);
    this.writeLine({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } });
    return true;
  }

  /**
   * Launch the process as an account query rather than a planner or a task,
   * from `cwd`, and ask it who is signed in (`initialize`). Then
   * {@link queryUsage} asks what the plan's limits stand at. Both go on the
   * control channel and no user message is ever written, so no model is
   * called and no turn opens. The caller ends input and disposes.
   */
  async openAccountQuery(cwd: string, timeoutMs: number): Promise<ClaudeControlAnswer> {
    await this.launch(cwd, () => ({ command: 'claude', args: ACCOUNT_QUERY_ARGS }), async () => {});
    return this.controlAnswer(await this.control({ subtype: 'initialize' }, timeoutMs));
  }

  /** The plan's limits, on a process {@link openAccountQuery} opened. */
  async queryUsage(timeoutMs: number): Promise<ClaudeControlAnswer> {
    return this.controlAnswer(await this.control({ subtype: 'get_usage', skip_behaviors: true }, timeoutMs));
  }

  private controlAnswer(response: ControlResponse | null): ClaudeControlAnswer {
    if (response?.subtype === 'success') return { kind: 'answered', response: response.response };
    if (response) return { kind: 'refused', error: response.error ?? '' };
    const lastWords = this.exited ? this.runner.withStderrTail('').trim() : '';
    return { kind: 'silent', ...(lastWords ? { lastWords } : {}) };
  }

  /** Send a control request and wait for its answer; null when none came in time or the process ended. */
  private control(request: { subtype: string; [field: string]: unknown }, timeoutMs: number): Promise<ControlResponse | null> {
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

  answerPermission(id: string, decision: ApprovalDecision): boolean {
    return this.process ? this.permissions.answer(id, decision) : false;
  }

  /**
   * The CLI reads a slash command at the start of a user message, its own
   * and the user's alike, and runs it as that turn (checked on 2.1.299:
   * `/compact` compacts, a project skill runs). There is no control request
   * for it.
   */
  invokeCommand(name: string, args: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.send(args ? `/${name} ${args}` : `/${name}`, onEvent, signal);
  }

  override dispose(): void {
    this.clearFollowOnTimer();
    super.dispose();
  }

  private clearFollowOnTimer(): void {
    if (this.followOnTimer) clearTimeout(this.followOnTimer);
    this.followOnTimer = null;
  }

  protected turnPayload(message: string): string {
    this.openTurnState();
    this.noteModelCommand(message, 1);
    return `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: message }] },
    })}\n`;
  }

  /**
   * The CLI runs a message that starts with a slash command as that command,
   * whether the surface sent it as one or as plain text, so the message
   * itself says a model switch was asked for: every way into the chat counts.
   */
  private noteModelCommand(text: string, turnsLeft: number): void {
    const [, name, args = ''] = /^\/(\S+)\s*([\s\S]*)$/.exec(text) ?? [];
    if (this.role !== 'task' || !name || (findRunnerCommand(this.commands(), name)?.name ?? name) !== MODEL_COMMAND) return;
    this.modelCommands.push({ args: args.trim(), turnsLeft });
  }

  private openTurnState(): void {
    this.replyRuns = new ReplyRuns();
    this.interruptRequested = false;
    this.resultHeld = false;
    this.turnClosed = false;
    this.runnerTurn = false;
    this.clearFollowOnTimer();
    // A turn names its own model on its first call; a command turn makes none,
    // and reading the last turn's id here would report its window against the
    // model the session has since switched to.
    this.plannerModel = undefined;
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
      // cannot decide alone. The request is left open — a task's for someone
      // to answer (ADR-0018, A1), a planner's for its envelope (ADR-0026) —
      // and must be answered, because an unacknowledged request stalls the turn.
      case 'control_request': {
        if (msg.request?.subtype !== 'can_use_tool') return;
        const input = msg.request.input ?? {};
        const id = msg.request_id ?? '';
        const name = msg.request.tool_name ?? 'unknown';
        // A planner's grants are the session policy's, never Claude's own.
        const suggestions = this.role === 'task' ? msg.request.permission_suggestions ?? [] : [];
        // A task's `--allowedTools` should have settled an Ordewell tool already; a planner's arrives through its ask rule.
        this.permissions.raise({
          id,
          name,
          detail: JSON.stringify(input),
          input,
          suggestions,
          ...(msg.request.tool_use_id ? { toolUseId: msg.request.tool_use_id } : {}),
          ...(this.role === 'planner' || this.readOnlySite ? { ask: plannerAsk(name, input, msg.request.mcp_server?.name, this.nativeShell !== null) } : {}),
          ordewell: this.givenOrdewell && CLAUDE_ORDEWELL.isOrdewellAsk(name),
        }, { id, input, suggestions }, emit);
        return;
      }

      // Claude gave up on a request it asked — an interrupt cancels the call.
      case 'control_cancel_request':
        this.permissions.withdraw(msg.request_id, emit);
        return;

      case 'control_response': {
        const account = msg.response?.response?.account;
        if (account) this.reportBilling(account.apiKeySource, account.subscriptionType, emit);
        const requestId = msg.response?.request_id;
        if (requestId) this.pendingControl.get(requestId)?.(msg.response ?? null);
        return;
      }

      case 'assistant':
        if (!subagentId) {
          this.clearFollowOnTimer();
          this.runnerTurn = this.turnClosed;
        }
        if (subagentId) {
          this.handleSubagentMessage(msg, subagentId, emit);
          return;
        }
        for (const block of blocksOf(msg)) {
          // A turn is several whole messages — narration between tool rounds,
          // then the final answer — and each text block in them is a run of its own.
          const runId = this.blockId(msg.message?.id);
          if (block.type === 'text' && block.text) this.replyRuns.complete(runId, block.text, emit);
          else if (block.type === 'thinking' && block.thinking) emit({ type: 'thinking', text: block.thinking });
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
          const printed = localCommandOutput(msg.message?.content);
          if (printed) emit({ type: 'command_output', text: printed });
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

      // `/clear` (and `/reset`, `/new`) emit this top-level line before their
      // own result, and a task's chat can send them. The CLI's totals restart.
      case 'conversation_reset': {
        // A main-session reset; a subagent's own stream never restarts the
        // task's count. `/clear` also discards the context, so the meter must
        // not keep the size of the conversation it replaced.
        if (subagentId) return;
        this.restartCount();
        const resetModel = this.sessionModel ?? (this.plannerModel !== '<synthetic>' ? this.plannerModel : undefined);
        emit({ type: 'usage', record: { source: 'claude-code', ...(resetModel ? { model: resetModel } : {}), compacted: true } });
        return;
      }

      case 'system':
        // A subagent's own init and compaction are replayed on the same stream
        // with its spawning call. Neither names the main model or measures its
        // context, so neither may move the task's meter or model.
        if (subagentId && (msg.subtype === 'init' || msg.subtype === 'compact_boundary')) return;
        if (msg.subtype === 'init') {
          this.clearFollowOnTimer();
          if (msg.claude_code_version) this.installedVersion = msg.claude_code_version;
          if (this.refuseOtherMode(msg, emit)) return;
          if (msg.model && msg.model !== '<synthetic>') this.sessionModel = msg.model;
          this.readLoaded(msg, emit);
          this.followModel(msg.model, emit);
          this.reportBilling(msg.apiKeySource, undefined, emit);
        }
        if (msg.subtype === 'commands_changed' && Array.isArray(msg.commands)) this.listedCommands = msg.commands;
        if (msg.subtype === 'compact_boundary') {
          const meta = msg.compact_metadata;
          emit({
            type: 'compaction',
            trigger: meta?.trigger === 'manual' ? 'manual' : 'auto',
            ...(typeof meta?.pre_tokens === 'number' ? { preTokens: meta.pre_tokens } : {}),
            ...(typeof meta?.post_tokens === 'number' ? { postTokens: meta.post_tokens } : {}),
          });
          const model = this.sessionModel ?? (this.plannerModel !== '<synthetic>' ? this.plannerModel : undefined);
          emit({ type: 'usage', record: { source: 'claude-code', ...(model ? { model } : {}), compacted: true, ...(typeof meta?.post_tokens === 'number' ? { contextTokens: meta.post_tokens } : {}) } });
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
        // `result` closes every turn — success or failure. A subagent's own
        // result is not the task's turn, and its spend is the session's, already
        // counted by the main result.
        if (subagentId) return;
        // The final assistant text (which carries the plan JSON) already arrived as assistant
        // blocks, so this only settles the turn.
        this.reportSessionCost(msg, emit);
        for (const command of this.modelCommands) command.turnsLeft = Math.max(0, command.turnsLeft - 1);
        // The request belongs to the turn this result closes, so a result that
        // finished anyway clears it too: left set, it would call the next turn interrupted.
        if (this.interruptRequested && (msg.is_error || msg.subtype !== 'success')) {
          this.interruptRequested = false;
          this.closeTurn({ type: 'turn_end', interrupted: true }, emit);
        } else if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
          this.closeTurn({ type: 'error', message: msg.result?.trim() || msg.errors?.join('\n').trim() || `Claude Code ended the turn: ${msg.subtype ?? 'error'}` }, emit);
        } else if (this.role === 'task' && this.backgroundTaskCount > 0) {
          this.interruptRequested = false;
          this.resultHeld = true;
        } else {
          this.interruptRequested = false;
          this.resultHeld = false;
          this.closeTurn({ type: 'turn_end' }, emit);
        }
        return;

      case 'stream_event':
        // Only the planner's own messages stream; a subagent's arrive whole.
        if (msg.event && !subagentId) {
          this.runnerTurn = this.turnClosed;
          this.handleStreamEvent(msg.event, emit);
        }
        return;

      default:
        return;
    }
  }

  /**
   * A task's main thread reported the model it answers on. A change is the
   * user's own switch when a model command went out before it: Ordewell never
   * passes `--fallback-model`, so nothing else should move it. A change with
   * no command before it is reported as drift, and the plan does not follow
   * it. A command whose turn ended with the model unchanged switched nothing,
   * and is let go.
   *
   * Effort is never reported (recorded on 2.1.302, `task-effort-command`):
   * `init` names the model alone, its `per_turn_effort_active` says effort is
   * on, not which; `/effort low` only prints that it set it; and `/model`
   * takes no effort (`/model haiku high` is "not found"). So a switch carries
   * no effort and the plan's stays as planned.
   */
  private followModel(reported: string | undefined, emit: (event: AgentEvent) => void): void {
    if (this.role !== 'task' || !reported || reported === '<synthetic>') return;
    const previous = this.mainModel;
    this.mainModel = reported;
    if (previous === undefined || previous === reported) {
      this.modelCommands = this.modelCommands.filter((c) => c.turnsLeft > 0);
      return;
    }
    // The command that asked for this model, else the oldest: an id the CLI
    // takes but `initialize` does not list cannot be matched.
    const matched = this.modelCommands.findIndex((c) => this.runsAs(c.args, reported));
    const command = this.modelCommands[Math.max(matched, 0)];
    this.modelCommands = this.modelCommands.slice(Math.max(matched, 0) + 1);
    const from = this.listedModel(previous, this.followedModel);
    if (!command) {
      emit({ type: 'model_drifted', from, to: this.listedModel(reported, undefined) });
      return;
    }
    const to = this.listedModel(reported, command.args);
    this.followedModel = to.model;
    emit({ type: 'model_switched', from, to });
  }

  /** Whether the model value `asked` runs as the id `resolved`, by what `initialize` lists. */
  private runsAs(asked: string, resolved: string): boolean {
    return asked === resolved || this.listedModels.some((m) => m.value === asked && m.resolvedModel === resolved);
  }

  /**
   * The value `initialize` lists for the id a model runs as. Several can share
   * one (`sonnet`, `default`); the one asked for wins, and `default` only as a
   * last resort, since it names whatever the CLI's default becomes.
   */
  private listedModel(resolved: string, asked: string | undefined): RunnerModelRef {
    const listed = this.listedModels.filter((m) => m.value && (m.resolvedModel === resolved || m.value === resolved));
    const pick = listed.find((m) => m.value === asked && asked !== 'default') ?? listed.find((m) => m.value !== 'default') ?? listed[0];
    if (!pick?.value) return { model: resolved };
    return { model: pick.value, ...(pick.displayName ? { label: pick.displayName } : {}) };
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

  /**
   * `init` comes with every turn (2.1.299); the first says what the process
   * loaded. A task's own Ordewell server is Ordewell's, not the user's setup.
   */
  private readLoaded(msg: ClaudeLine, emit: (event: AgentEvent) => void): void {
    if (this.role !== 'task') return;
    this.skillNames = new Set(msg.skills ?? []);
    this.terminalOnly = new Set(msg.terminal_slash_commands ?? []);
    if (this.listedCommands.length === 0) this.listedCommands = (msg.slash_commands ?? []).map((name) => ({ name }));
    if (this.loadedReported) return;
    this.loadedReported = true;
    const mcpServers = (msg.mcp_servers ?? []).flatMap((server): RunnerMcpServer[] => (server.name && server.name !== ORDEWELL_MCP_SERVER_NAME
      ? [{ name: server.name, ...(server.status ? { status: server.status } : {}) }]
      : []));
    emit({ type: 'runner_loaded', commands: this.commands(), mcpServers });
  }

  private awaitFollowOnTurn(emit: (event: AgentEvent) => void): void {
    this.clearFollowOnTimer();
    this.followOnTimer = setTimeout(() => {
      this.followOnTimer = null;
      this.resultHeld = false;
      this.closeTurn({ type: 'turn_end' }, emit);
    }, FOLLOW_ON_TURN_GRACE_MS);
    this.followOnTimer.unref?.();
  }

  /** A subagent left running in the background outlives the turn, and a request it raised still waits on its answer. */
  private closeTurn(end: AgentEvent, emit: (event: AgentEvent) => void): void {
    this.turnClosed = true;
    this.runnerTurn = false;
    if (this.backgroundTaskCount === 0) this.permissions.endTurn(emit);
    emit(end);
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
   * The id of the next block an `assistant` line carries, `<message>:<index>`.
   * The CLI sends a message as one line per content block, in order, so a
   * block's place among its message's lines is the `index` its stream events
   * carry (checked against every recorded transcript).
   */
  private blockId(messageId = ''): string {
    if (this.lineMessage?.id !== messageId) this.lineMessage = { id: messageId, blocks: 0 };
    return `${messageId}:${this.lineMessage.blocks++}`;
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
    if (event.type === 'message_start') {
      this.plannerModel = this.modelId(event.message?.model);
      this.streamingMessage = event.message?.id;
      this.followModel(this.plannerModel, emit);
    } else if (event.type === 'message_delta' && event.usage) {
      const record = usageRecord(event.usage, this.plannerModel);
      this.turnCallUsage.inputTokens += record.inputTokens ?? 0;
      this.turnCallUsage.cachedInputTokens += record.cachedInputTokens ?? 0;
      this.turnCallUsage.outputTokens += record.outputTokens ?? 0;
      emit({ type: 'usage', record });
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      this.replyRuns.delta(`${this.streamingMessage ?? ''}:${event.index ?? 0}`, event.delta.text, emit);
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && event.delta.thinking) {
      emit({ type: 'thinking_delta', text: event.delta.thinking });
    }
  }

  /**
   * The id a reported model runs as. `init` names the selected value — a
   * `[1m]` variant included — while a message names the API's canonical id
   * without it. Keeping the variant is what lets the meter find the window
   * `modelUsage` keys it by, and keeps that window off the base model.
   */
  private modelId(reported: string | undefined): string | undefined {
    if (!reported) return undefined;
    if (!sameModel(this.sessionModel, reported)) return reported;
    // Both name the same model: keep whichever carries the variant suffix, so
    // the modelUsage key and the window are the exact id that ran.
    return this.sessionModel?.includes('[') ? this.sessionModel : reported;
  }

  private reportBilling(apiKeySource: string | undefined, plan: string | undefined, emit: (event: AgentEvent) => void): void {
    const type = apiKeySource ? (apiKeySource === 'none' ? 'subscription' : 'api-key') : plan ? 'subscription' : undefined;
    if (!type) return;
    const knownPlan = plan ?? (this.billing?.type === type ? this.billing.plan : undefined);
    this.billing = { type, ...(knownPlan ? { plan: knownPlan } : {}) };
    emit({ type: 'usage', record: { source: this.agentId, aggregate: true, sessionBilling: this.billing } });
  }

  /**
   * A turn's `result` states its own token sum. Every call that streamed its
   * `message_delta` usage has already reported, so only the remainder is added:
   * all of it when nothing streamed (a recording without partial messages), or
   * a lost call's share. It is a sum across calls, marked `aggregate` so it
   * never moves the meter — only a call says what the context was left at.
   */
  private reportUnstreamedUsage(msg: ClaudeLine, emit: (event: AgentEvent) => void): void {
    const { inputTokens: streamedInput, cachedInputTokens: streamedCached, outputTokens: streamedOutput } = this.turnCallUsage;
    this.turnCallUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    if (!msg.usage) return;
    const models = Object.keys(msg.modelUsage ?? {});
    const model = this.plannerModel ?? this.mainModel ?? (models.length === 1 ? models[0] : undefined);
    const total = usageRecord(msg.usage, model);
    const inputTokens = (total.inputTokens ?? 0) - streamedInput;
    const cachedInputTokens = (total.cachedInputTokens ?? 0) - streamedCached;
    const outputTokens = (total.outputTokens ?? 0) - streamedOutput;
    if (inputTokens <= 0 && outputTokens <= 0) return;
    emit({
      type: 'usage',
      record: {
        source: 'claude-code',
        ...(model ? { model } : {}),
        aggregate: true,
        ...(inputTokens > 0 ? { inputTokens } : {}),
        ...(inputTokens > 0 && cachedInputTokens > 0 ? { cachedInputTokens } : {}),
        ...(outputTokens > 0 ? { outputTokens } : {}),
      },
    });
  }

  /**
   * What only the result line knows: the cost, which covers every call the
   * session made — subagents included, since none of their lines carries one —
   * and the planner model's window. `total_cost_usd` is a running total, so a
   * turn reports its growth. After a resume it grows from what was counted of
   * the session before; with no count kept, the first turn only sets the
   * baseline: its total includes turns counted before, and a turn's own share
   * cannot be told apart from them.
   *
   * The running total never lowers: money already reported and counted is not
   * un-spent because a later or resumed process remembers less of it, and
   * counting its return would count the same dollars twice. A zero is not a
   * measurement at all — a crash can end with one — and only `/clear` restarts
   * the count, through {@link restartCount}. Per-model baselines never lower
   * either, for the same reason.
   *
   * A report without a model breakdown is counted as a session total; one with
   * a breakdown is counted per model. A breakdown that would count more than
   * the session total's own growth (the count before it had no model split, or
   * a lossy report) is counted as that growth alone, so the two shapes
   * together still add each dollar once.
   */
  private reportSessionCost(msg: ClaudeLine, emit: (event: AgentEvent) => void): void {
    this.reportUnstreamedUsage(msg, emit);
    const total = msg.total_cost_usd;
    const canReport = this.reportedCostUsd !== undefined;
    const modelCosts = Object.entries(msg.modelUsage ?? {}).filter((entry): entry is [string, { contextWindow?: number; costUSD: number; costBasis?: 'list' | 'managed' }] => typeof entry[1].costUSD === 'number' && entry[1].costUSD > 0 && entry[1].costBasis !== 'unknown');
    const growth = canReport && typeof total === 'number' && total > 0 ? total - this.reportedCostUsd! : undefined;
    let emitted = 0;
    const emitCost = (record: { model?: string; amount: number; basis?: 'list' | 'managed' }): void => {
      if (!(record.amount > 0)) return;
      emitted += record.amount;
      emit({ type: 'usage', record: { source: 'claude-code', ...(record.model ? { model: record.model } : {}), aggregate: true, ...(this.billing ? { sessionBilling: this.billing } : {}), reportedCost: { amount: record.amount, currency: 'USD', kind: 'estimate', ...(record.basis ? { basis: record.basis } : {}) } } });
    };
    if (modelCosts.length > 0) {
      // What the breakdown says grew, per model. A model the runner marked
      // unknown is left out entirely — its dollars were not reported.
      const modelGrowth = modelCosts.reduce((sum, [model, usage]) => sum + Math.max(0, usage.costUSD - (this.reportedModelCostUsd.get(model) ?? 0)), 0);
      if (canReport) {
        if (growth !== undefined && modelGrowth > growth + 1e-9) {
          // The breakdown is cumulative further back than the total we already
          // counted (a kept count with no model split, or a report that gained
          // one): only the growth over that total is new.
          emitCost({ amount: growth });
        } else {
          for (const [model, usage] of modelCosts) emitCost({ model, amount: usage.costUSD - (this.reportedModelCostUsd.get(model) ?? 0), ...(usage.costBasis ? { basis: usage.costBasis } : {}) });
        }
      }
      for (const [model, usage] of modelCosts) this.reportedModelCostUsd.set(model, Math.max(this.reportedModelCostUsd.get(model) ?? 0, usage.costUSD));
    } else if (!Object.values(msg.modelUsage ?? {}).some((usage) => usage.costBasis === 'unknown') && typeof total === 'number' && total > 0 && canReport && total >= this.reportedCostUsd!) {
      // Without the model breakdown, a session total cannot be attributed to
      // the last model: it also includes earlier models and subagents.
      emitCost({ amount: total - this.reportedCostUsd! });
    }
    // A resume with no kept count takes this result as its baseline and counts
    // none of it; the rest count what they report. A total that includes cost
    // the runner marks unknown is not counted, so its later reporting can be.
    if (!canReport) {
      if (typeof total === 'number' && total > 0) this.reportedCostUsd = total;
      else if (modelCosts.length > 0) this.reportedCostUsd = modelCosts.reduce((sum, [, usage]) => sum + usage.costUSD, 0);
    } else {
      this.reportedCostUsd = (this.reportedCostUsd ?? 0) + emitted;
    }
    // A command turn (`/compact`, a model switch) can end with a result and no
    // call whose `message_start` named the model; the turn's `init` still did.
    // A synthetic message names no model at all.
    const model = this.plannerModel && this.plannerModel !== '<synthetic>' ? this.plannerModel : this.sessionModel;
    const contextWindow = model ? msg.modelUsage?.[model]?.contextWindow : undefined;
    if (typeof contextWindow === 'number' && contextWindow > 0) emit({ type: 'usage', record: { source: 'claude-code', model, contextWindow } });
  }
}
