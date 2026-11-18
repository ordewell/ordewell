import { randomUUID } from 'crypto';
import type { AgentEvent, AgentProcessDeps, AgentStartOptions, TaskModeAgentAdapter } from './AgentAdapter';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import { StdioAgentAdapter, type SpawnSpec } from './StdioAgentAdapter';
import { PermissionLedger } from './permissionLedger';
import { readOnlyTask, readOnlyTaskPolicy } from './plannerPermissions';
import { awaitAttach, listed, MCP_ATTACH_TIMEOUT_MS, type AttachState } from './ordewellBinding';
import { PI_ORDEWELL } from './piOrdewell';
import { piExtensionSource, piReadAsk } from './piExtension';
import { taskCompletionContract, type McpClientConfig } from '../mcp';
import { UsageRecordBuilder } from './usageBuilder';
import { settleWithin } from './settleWithin';
import { TurnOutcome } from './turnOutcome';
import { taskCompactAtOf } from '../taskCompactWindow';
import { privateTempDir } from '../../utils/privateTempDir';
import { spawnedCommand } from '../../plugins/types';
import { PI_MANIFEST } from '../../plugins/builtin/pi.manifest';

/** What a restricted start may run: Pi's read tools and Ordewell's, none that writes or runs a command (ADR-0009, ADR-0046). */
const RESTRICTED_TOOLS = ['read', 'grep', 'find', 'ls', `${PI_ORDEWELL.toolName('')}*`];

/** Pi's dialogs that wait for an answer; the rest of its extension UI is fire-and-forget. */
const DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number; totalFromProvider?: boolean };
}

interface PiContent {
  type?: string;
  text?: string;
  thinking?: string;
}

interface PiMessage {
  role?: string;
  content?: PiContent[] | string;
  provider?: string;
  model?: string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
}

/** One record of Pi's RPC stdout, as far as the adapter reads it. */
interface PiLine {
  type?: string;
  id?: string;
  command?: string;
  success?: boolean;
  error?: string;
  /** The message of a `message_*` event; the text of an extension's `confirm`. */
  message?: PiMessage | string;
  assistantMessageEvent?: { type?: string; contentIndex?: number; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  /** A tool's result, or a compaction's. */
  result?: { content?: PiContent[]; tokensBefore?: number; estimatedTokensAfter?: number };
  reason?: string;
  isError?: boolean;
  aborted?: boolean;
  method?: string;
  title?: string;
  placeholder?: string;
}

/** How a dialog Pi forwarded is answered: an Ordewell read ask takes the decision, an extension's `confirm` a yes or no. */
type PiDialog = { id: string; kind: 'read' | 'confirm' };

/**
 * Pi over its RPC mode (`pi --mode rpc`): JSONL commands on stdin, one
 * process per session, a turn per `prompt` that ends at `agent_settled`.
 *
 * Pi asks for nothing: what a start may do is the tool set it starts with. A
 * writable task runs Pi's own tools natively, with no per-tool approval, as
 * ADR-0001 lets a writable mode under Full and Guarded. A planner and a
 * read-only task start with Pi's read tools and Ordewell's alone, without the
 * user's extensions or the repository's `.pi` files (ADR-0028), a planner
 * without its context files too, and with Ordewell's extension asking before
 * every read: the
 * planner's envelope decides a planner's (ADR-0026), and
 * `decideReadOnlyTaskPermission` a read-only task's, with nobody asked
 * (ADR-0046). The extension also hands Pi the Ordewell server; Pi connects to
 * it as its session starts, so the server's record of the token's first use
 * is the attach (ADR-0022, S4).
 *
 * A `confirm` an extension of the user's raises in a writable task is a
 * permission request like any runner's, answered through the ledger; any other
 * dialog is dismissed, as Pi itself would at a timeout.
 */
export class PiAdapter extends StdioAgentAdapter implements TaskModeAgentAdapter {
  readonly agentId = PI_MANIFEST.name;
  private started: AgentStartOptions & { mcp: McpClientConfig } | null = null;
  private restricted = false;
  private readonly usage = new UsageRecordBuilder(PI_MANIFEST.name);
  private readonly ledger = new PermissionLedger<PiDialog>(
    (dialog, decision) => this.answerDialog(dialog, decision),
    () => {
      const started = this.started;
      return { role: started?.kind ?? 'task', autoApprove: false, decide: readOnlyTaskPolicy(started) };
    },
  );
  private readonly outcome = new TurnOutcome();
  private turns = 0;
  private messages = 0;
  /** The turn's assistant message as Pi streams it, by its own number; null between messages. */
  private message: string | null = null;
  /** Pi's last word on the turn's model call when that call failed: Pi retries before it settles, so only the last one counts. */
  private failure: string | null = null;
  /** Settles when the open turn has: Pi said `agent_settled`, refused the prompt, or exited. */
  private settled: Promise<void> | null = null;
  private settle: (() => void) | null = null;

  constructor(deps: AgentProcessDeps) {
    super(deps);
    void this.processEnded.then(() => this.endTurnState());
  }

  override async start(opts: AgentStartOptions): Promise<void> {
    if (!opts.mcp) throw new Error('Pi cannot start without the Ordewell MCP server to carry its tools.');
    if (opts.kind === 'task' && typeof taskCompactAtOf() === 'number') {
      console.warn('Pi: taskCompactAt cannot be honoured: Pi compacts its context on its own terms, and Ordewell has nothing to set it with.');
    }
    this.started = { ...opts, mcp: opts.mcp };
    this.restricted = opts.kind === 'planner' || readOnlyTask(opts);
    this.sessionId = opts.resumeSessionId ?? randomUUID();
    // The token reaches Pi in a file, not its environment, so the process is told to keep it out of its messages too.
    this.runner.withhold(...Object.values(opts.mcp.headers).flatMap((value) => [value, value.replace(/^Bearer\s+/i, '')]));
    await super.start(opts);
  }

  /**
   * The token and the instructions go in two files of the process's own,
   * owner-only, outside the worktree, removed with it (ADR-0022, A5): the
   * extension that registers the server, and the text Pi appends to its own
   * system prompt, never in its place (ADR-0009, T5). The session id is chosen
   * here, so a resume names the one a later process takes up (ADR-0018, K1).
   */
  protected spawnSpec(): SpawnSpec {
    const started = this.requireStarted();
    const dir = privateTempDir('pi');
    this.own('private-dir', dir.remove);
    const { name, url, headers } = started.mcp;
    const extension = dir.write('ordewell.ts', piExtensionSource({ server: { name, url, headers }, asksReads: this.restricted }));
    const prompt = dir.write('instructions.md', this.instructions(started));
    const effort = started.kind === 'planner' ? started.effort : started.flags.effort;
    const args = [
      '--mode', 'rpc',
      '--session-id', this.sessionId!,
      // Named even where built-ins load: a user who turned Pi's MCP support off would leave Ordewell's server unconnected.
      '-e', 'builtin:mcp',
      '-e', extension,
      '--append-system-prompt', prompt,
      ...(this.restricted ? ['--no-approve', '--no-extensions', '--tools', RESTRICTED_TOOLS.join(',')] : []),
      // A planner is given the repository's instruction files by Ordewell's reader, as text in its prompt (ADR-0028).
      ...(started.kind === 'planner' ? ['--no-context-files'] : []),
      ...(started.runnerConfig === 'minimal' ? ['--no-skills', '--no-prompt-templates'] : []),
      ...(started.model ? ['--model', started.model] : []),
      ...(effort ? ['--thinking', effort] : []),
    ];
    return { command: spawnedCommand(PI_MANIFEST), args, files: [extension, prompt] };
  }

  private instructions(started: AgentStartOptions & { mcp: McpClientConfig }): string {
    const { toolName, toolNames } = PI_ORDEWELL;
    const reads = 'Each read of your read, grep, find and ls tools asks Ordewell first, and one it does not allow fails with the reason.';
    if (started.kind === 'planner') {
      const { hidden = [], extraTools } = started.mcp;
      const web = [
        ...(hidden.includes('fetch') ? [] : [`read web pages with \`${toolName('fetch')}\``]),
        ...(hidden.includes('web_search') ? [] : [`search the web with \`${toolName('web_search')}\``]),
      ];
      return [
        started.systemPrompt,
        [
          `Your Ordewell tools come from the \`${started.mcp.name}\` MCP server: ${listed(toolNames('planner', hidden, extraTools).map((tool) => `\`${tool}\``))}.`,
          `Your own file edits and shell are off in this session: run commands with \`${toolName('run_command')}\`${web.length ? `, ${listed(web)}` : ''}.`,
          reads,
        ].join(' '),
      ].join('\n\n');
    }
    const contract = taskCompletionContract(started.commits ? { commits: true } : {});
    if (!this.restricted) return contract;
    return [
      // Ordewell's own `read` takes a task, not a path, and a small model reached for it in place of Pi's.
      `This task is read-only: your own file edits and shell are off. Run commands and tests with \`${toolName('run_command')}\`, read web pages with \`${toolName('fetch')}\` and search the web with \`${toolName('web_search')}\`. Read files with your read, grep, find and ls tools: \`${toolName('read')}\` reads a task's handoff, not a file. ${reads}`,
      contract,
    ].join('\n\n');
  }

  protected turnPayload(message: string): string {
    this.outcome.open();
    this.failure = null;
    this.settled = new Promise((resolve) => { this.settle = resolve; });
    return `${JSON.stringify({ id: `turn-${++this.turns}`, type: 'prompt', message })}\n`;
  }

  protected handleLine(raw: string, emit: (event: AgentEvent) => void): void {
    const line = StdioAgentAdapter.parse<PiLine>(raw);
    if (!line) return;
    switch (line.type) {
      case 'response':
        if (line.command === 'prompt' && line.success === false) this.endTurn(emit, { type: 'error', message: line.error ?? 'Pi refused the prompt.' });
        return;
      case 'message_start':
        if (typeof line.message === 'object' && line.message.role === 'assistant') this.message = `${this.turns}.${++this.messages}`;
        return;
      case 'message_update': {
        const update = line.assistantMessageEvent;
        if (!this.message || !update?.delta) return;
        if (update.type === 'text_delta') emit({ type: 'assistant_text_delta', runId: `${this.message}.${update.contentIndex ?? 0}`, text: update.delta });
        else if (update.type === 'thinking_delta') emit({ type: 'thinking_delta', text: update.delta });
        return;
      }
      case 'message_end':
        if (typeof line.message === 'object' && line.message.role === 'assistant') this.messageEnded(line.message, emit);
        return;
      case 'tool_execution_start':
        if (line.toolCallId && line.toolName) emit({ type: 'tool_call', id: line.toolCallId, name: line.toolName, args: line.args ?? {} });
        return;
      case 'tool_execution_end':
        if (line.toolCallId && line.toolName) emit({ type: 'tool_result', id: line.toolCallId, name: line.toolName, output: textOf(line.result?.content), success: line.isError !== true });
        return;
      case 'extension_ui_request':
        this.dialog(line, emit);
        return;
      case 'compaction_end': {
        const { result } = line;
        if (!result || line.aborted) return;
        emit({
          type: 'compaction', trigger: line.reason === 'manual' ? 'manual' : 'auto',
          ...(result.tokensBefore !== undefined ? { preTokens: result.tokensBefore } : {}),
          ...(result.estimatedTokensAfter !== undefined ? { postTokens: result.estimatedTokensAfter } : {}),
        });
        return;
      }
      case 'agent_settled':
        this.endTurn(emit, this.outcome.settle(line.aborted ? 'interrupted' : 'completed', !line.aborted && this.failure !== null ? { message: this.failure } : undefined));
        return;
    }
  }

  /** The message's own words replace what streamed of them; a failed call is remembered for the turn's end. */
  private messageEnded(message: PiMessage, emit: (event: AgentEvent) => void): void {
    const run = this.message ?? `${this.turns}.${++this.messages}`;
    this.message = null;
    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((part, index) => {
      if (part.type === 'text' && part.text) emit({ type: 'assistant_text', runId: `${run}.${index}`, text: part.text });
      else if (part.type === 'thinking' && part.thinking) emit({ type: 'thinking', text: part.thinking });
    });
    this.failure = message.stopReason === 'error' ? message.errorMessage ?? 'The model call failed.' : null;
    const usage = message.usage;
    if (!usage) return;
    const cached = usage.cacheRead ?? 0;
    const record = this.usage.call({
      ...(message.provider && message.model ? { model: `${message.provider}/${message.model}` } : {}),
      inputTokens: (usage.input ?? 0) + cached + (usage.cacheWrite ?? 0),
      outputTokens: usage.output ?? 0,
      cachedInputTokens: cached,
      ...(usage.totalTokens ? { contextTokens: usage.totalTokens } : {}),
      ...(usage.cost?.total ? { cost: { amount: usage.cost.total, ...(usage.cost.totalFromProvider ? { kind: 'billed' as const } : { kind: 'estimate' as const, basis: 'list' as const }) } } : {}),
    });
    if (record) emit({ type: 'usage', record });
  }

  /**
   * A dialog Pi forwarded from an extension. Ordewell's read ask is decided by
   * the start's role, and an extension's `confirm` is a request like any
   * runner's; another dialog has no answer Ordewell could give, so it is
   * dismissed at once rather than left to hold the turn.
   */
  private dialog(line: PiLine, emit: (event: AgentEvent) => void): void {
    if (!line.id || !line.method || !DIALOGS.has(line.method)) return;
    const read = line.method === 'input' && this.restricted ? piReadAsk(line) : null;
    if (read) {
      this.ledger.raise({
        id: line.id, name: read.tool, detail: read.path, input: { path: read.path }, toolUseId: read.toolCallId,
        ask: { kind: 'path', path: read.path, directory: read.directory }, ordewell: false,
      }, { id: line.id, kind: 'read' }, emit);
    } else if (line.method === 'confirm') {
      const title = line.title ?? 'An extension asks to go on';
      this.ledger.raise({ id: line.id, name: title, detail: typeof line.message === 'string' ? line.message : title, ask: { kind: 'other' }, ordewell: false }, { id: line.id, kind: 'confirm' }, emit);
    } else {
      this.writeLine({ type: 'extension_ui_response', id: line.id, cancelled: true });
    }
  }

  private answerDialog({ id, kind }: PiDialog, decision: ApprovalDecision): void {
    this.writeLine(kind === 'read'
      ? { type: 'extension_ui_response', id, value: JSON.stringify(decision) }
      : { type: 'extension_ui_response', id, confirmed: decision.decision !== 'deny' });
  }

  private endTurn(emit: (event: AgentEvent) => void, ending: Extract<AgentEvent, { type: 'turn_end' } | { type: 'error' }>): void {
    this.ledger.endTurn(emit);
    emit(ending);
    this.endTurnState();
  }

  private endTurnState(): void {
    this.message = null;
    this.failure = null;
    this.settle?.();
    this.settle = null;
    this.settled = null;
  }

  /** Pi's `abort`: the run stops and the session stays, and the turn ends at the `agent_settled` it answers with. */
  async interrupt(timeoutMs: number): Promise<boolean> {
    const settled = this.settled;
    if (!this.process || this.exited || !settled) return false;
    this.outcome.request();
    this.writeLine({ type: 'abort' });
    return settleWithin(settled.then(() => true), { timeoutMs, onTimeout: () => false, ended: this.processEnded, onEnded: () => false });
  }

  /** Pi ends by itself, keeping its session, once its stdin closes. */
  endInput(): void {
    this.process?.stdin?.end();
  }

  answerPermission(id: string, decision: ApprovalDecision): boolean {
    return this.process ? this.ledger.answer(id, decision) : false;
  }

  /** Connected once Pi used the token, which it does as its session starts; failed if it exited first. */
  async mcpAttached(): Promise<AttachState> {
    const contact = this.started?.mcp.contact;
    if (!contact || !this.process) return 'failed';
    return awaitAttach(() => contact.whenContacted().then((ok): AttachState => (ok ? 'connected' : 'failed')), MCP_ATTACH_TIMEOUT_MS, 0, this.processEnded);
  }

  private requireStarted(): AgentStartOptions & { mcp: McpClientConfig } {
    if (!this.started) throw new Error('Pi has not been started.');
    return this.started;
  }
}

function textOf(content: PiContent[] | undefined): string {
  return (content ?? []).map((part) => (part.type === 'text' ? part.text ?? '' : '')).join('');
}
