import { randomUUID } from 'crypto';
import { readdirSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import type { AgentEvent, AgentProcessDeps, AgentStartOptions, TaskModeAgentAdapter } from './AgentAdapter';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import { StdioAgentAdapter, type SpawnSpec } from './StdioAgentAdapter';
import { PermissionLedger } from './permissionLedger';
import { readOnlyTask, readOnlyTaskPolicy } from './plannerPermissions';
import { awaitAttach, listed, MCP_ATTACH_TIMEOUT_MS, RunnerStartupExit, SessionNotResumable, type AttachState, type OrdewellToolRole } from './ordewellBinding';
import { PI_ORDEWELL, piMcpCollision } from './piOrdewell';
import { PI_REPO_CONFIG } from './piRepoConfig';
import { instructionsBlock } from './repoConfig';
import { piExtensionSource, piReadAsk } from './piExtension';
import { taskCompletionContract, type McpClientConfig } from '../mcp';
import { UsageRecordBuilder } from './usageBuilder';
import { settleWithin } from './settleWithin';
import { TurnOutcome } from './turnOutcome';
import { taskCompactAtOf } from '../taskCompactWindow';
import { escapeRegex } from '../symbolPatterns';
import { privateTempDir } from '../../utils/privateTempDir';
import { stripAnsi } from '../../utils/shell';
import { spawnedCommand } from '../../plugins/types';
import { PI_MANIFEST } from '../../plugins/builtin/pi.manifest';

/** Pi's own tools a restricted start keeps: the read tools, none that writes or runs a command (ADR-0009, ADR-0046). */
const READ_TOOLS = ['read', 'grep', 'find', 'ls'];

/** The id of the `get_state` that asks whether turn `n`'s prompt, which Pi handled itself, started a run. */
const idleCheck = (n: number) => `ordewell-idle-check-${n}`;

/** The id of the `get_state` that asks a resumed Pi whether it found the session. */
const RESUME_CHECK = 'ordewell-resume-check';
/** How long Pi has to answer it: Pi answers once it has started, before any prompt. */
const RESUME_CHECK_TIMEOUT_MS = 30_000;

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
  /** A prompt's answer (`handled`: Pi ran it as a command), or Pi's state. */
  data?: { disposition?: string; isStreaming?: boolean; messageCount?: number };
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
 * user's extensions, the repository's `.pi` files or Pi's context files
 * (ADR-0028), and with Ordewell's extension asking before every read: the
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
  /** Whose token's tools the start is handed; decided once, so the tools a start offers and how far it is restricted cannot disagree. */
  private toolRole: OrdewellToolRole = 'task';
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
  /** Whether Pi is in a run: from its `agent_start` to its `agent_settled`. */
  private running = false;
  /** The file of the session a resume forks into its cwd, saved under another; none where Pi takes it up by id. */
  private forkedFrom: string | undefined;
  /** Takes Pi's answer to the resume check, while a resumed start waits for it. */
  private resumeAnswer: ((line: PiLine) => void) | null = null;
  /** Settles when the open turn has: Pi said `agent_settled`, refused the prompt, or exited. */
  private settled: Promise<void> | null = null;
  private settle: (() => void) | null = null;

  constructor(deps: AgentProcessDeps) {
    super(deps);
    void this.processEnded.then(() => this.endTurnState());
  }

  /** A planner or a read-only task: Pi's read tools and Ordewell's alone. */
  private get restricted(): boolean { return this.toolRole !== 'task'; }

  override async start(opts: AgentStartOptions): Promise<void> {
    if (!opts.mcp) throw new Error('Pi cannot start without the Ordewell MCP server to carry its tools.');
    if (opts.kind === 'task' && typeof taskCompactAtOf() === 'number') {
      console.warn('Pi: taskCompactAt cannot be honoured: Pi compacts its context on its own terms, and Ordewell has nothing to set it with.');
    }
    this.started = { ...opts, mcp: opts.mcp };
    this.toolRole = opts.kind === 'planner' ? 'planner' : readOnlyTask(opts) ? 'readOnlyTask' : 'task';
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
  protected spawnSpec(_opts: AgentStartOptions, workspace: Record<string, string>): SpawnSpec {
    const started = this.requireStarted();
    // A placed Pi's agent dir is on the host it was placed on, which this one cannot read.
    const agentDir = this.deps.placement ? undefined : piAgentDir(started.cwd, workspace.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR);
    const displacing = agentDir === undefined ? undefined : piMcpCollision(agentDir, started.mcp.name);
    if (agentDir !== undefined && displacing !== undefined) {
      throw new Error(`${path.join(agentDir, 'mcp.json')} defines an MCP server named "${displacing}", which Pi starts in place of Ordewell's own: rename or remove it there before starting Pi.`);
    }
    const dir = privateTempDir('pi');
    this.own('private-dir', dir.remove);
    const { name, url, headers } = started.mcp;
    const extension = dir.write('ordewell.ts', piExtensionSource({ server: { name, url, headers }, asksReads: this.restricted }));
    const prompt = dir.write('instructions.md', this.instructions(started));
    const effort = started.kind === 'planner' ? started.effort : started.flags.effort;
    const sessions = this.sessionDir(started.cwd, agentDir);
    const elsewhere = started.resumeSessionId && agentDir !== undefined ? savedElsewhere(agentDir, sessions, started.resumeSessionId) : undefined;
    this.forkedFrom = elsewhere;
    const args = [
      '--mode', 'rpc',
      '--session-id', this.sessionId!,
      // Pi takes a `.pi/settings.json` sessionDir from the repository even under `--no-approve`, so a repository could
      // say where every transcript goes. Named here, the directory is Pi's own default, which every process of a session finds.
      '--session-dir', sessions,
      // Pi finds a `--session-id` only among the cwd's own sessions, and a continuation after its run ended works in a new
      // worktree. `--fork` copies the saved conversation into this cwd under the same id; `--session <file>` would open it
      // in the worktree it was saved in, and exits when that one is gone.
      ...(elsewhere ? ['--fork', elsewhere] : []),
      // Named even where built-ins load: a user who turned Pi's MCP support off would leave Ordewell's server unconnected.
      '-e', 'builtin:mcp',
      '-e', extension,
      '--append-system-prompt', prompt,
      // The token's tools by exact name: `mcp__ordewell__*` would also admit a server named `ordewell__x`.
      // `--no-context-files` too: Pi would read every AGENTS.md from the cwd up to the root, its agent dir's and a link's out of the repository,
      // past the read gate. Ordewell's reader hands it the repository's as text instead (ADR-0028).
      ...(this.restricted ? ['--no-approve', '--no-extensions', '--tools', [...READ_TOOLS, ...PI_ORDEWELL.toolNames(this.toolRole, started.mcp.hidden, started.mcp.extraTools)].join(','), '--no-context-files'] : []),
      ...(started.runnerConfig === 'minimal' ? ['--no-skills', '--no-prompt-templates'] : []),
      ...(started.model ? ['--model', started.model] : []),
      ...(effort ? ['--thinking', effort] : []),
    ];
    // Pi loads the extension through jiti, whose file cache would keep it, token and all, in the temp dir after Pi exits.
    const env: Record<string, string> = { JITI_FS_CACHE: 'false' };
    // Without its own copies Pi starts `rg` and `fd` by bare name in the folder it searches, and Windows looks there before PATH,
    // so a repository's rg.exe would run. Node skips that folder when the spawning process's own environment carries this
    // variable, which is Pi's when it is set here (windowsBareNameSearch.test.ts; ADR-0028).
    if ((this.deps.platform ?? process.platform) === 'win32') env.NoDefaultCurrentDirectoryInExePath = '1';
    return { command: spawnedCommand(PI_MANIFEST), args, env, files: [extension, prompt] };
  }

  /**
   * Pi's default directory for a cwd's sessions (its `getDefaultSessionDirPath`).
   * A placed Pi runs where its placement put it, under that host's home, which
   * Pi expands the `~` against.
   */
  private sessionDir(cwd: string, agentDir: string | undefined): string {
    const placed = this.deps.placement;
    const at = placed ? placed.cwd : realCwd(cwd);
    const name = `--${at.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    return agentDir ? path.join(agentDir, 'sessions', name) : path.posix.join('~', '.pi', 'agent', 'sessions', name);
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
      // A planner's are in its system prompt already.
      instructionsBlock(PI_REPO_CONFIG.instructions(started.cwd), 'in this read-only task'),
    ].filter(Boolean).join('\n\n');
  }

  /**
   * Pi answers a `--session-id` it finds under no cwd's directory with a new,
   * empty session of that id, saying so on stderr alone. Asked before the
   * first prompt, an empty session is a resume that did not happen, refused as
   * the other runners refuse one, so the caller falls back: a task's Continue
   * fails and forgets the session, a planner replays its transcript (ADR-0018, K1).
   */
  protected override async handshake(opts: AgentStartOptions): Promise<void> {
    const id = opts.resumeSessionId;
    if (!id) return;
    const answered = new Promise<PiLine>((resolve) => { this.resumeAnswer = resolve; });
    this.writeLine({ id: RESUME_CHECK, type: 'get_state' });
    const answer = await settleWithin(answered, {
      timeoutMs: RESUME_CHECK_TIMEOUT_MS,
      onTimeout: () => { throw new Error(`Pi did not say within ${RESUME_CHECK_TIMEOUT_MS / 1000}s whether it found session ${id}.`); },
      ended: this.processEnded,
      onEnded: () => {
        const said = this.exitMessage();
        // A saved file Pi cannot read a session from is as lost as one that is gone.
        const unforkable = this.forkedFrom && /^.*Cannot fork:.*$/m.exec(stripAnsi(said));
        if (unforkable) throw new SessionNotResumable(`Pi could not take up session ${id} from ${this.forkedFrom}: ${unforkable[0].trim()}`);
        throw new RunnerStartupExit(said);
      },
    }).finally(() => { this.resumeAnswer = null; });
    if (answer.success === false) throw new Error(`Pi could not say whether it found session ${id}: ${answer.error ?? 'get_state failed'}.`);
    if (!answer.data?.messageCount) throw new SessionNotResumable(`Pi has no saved session ${id} to continue.`);
  }

  /** Pi warns on every fresh start that the id Ordewell chose names no session yet: that is the start working, not why it failed. */
  protected override exitMessage(): string {
    const message = super.exitMessage();
    const id = this.started && !this.started.resumeSessionId ? this.sessionId : null;
    if (!id) return message;
    return message.replace(new RegExp(`^(?:\\x1b\\[[0-9;]*m)*Warning: No project session found with id '${escapeRegex(id)}'; creating a new session with that id\\.(?:\\x1b\\[[0-9;]*m)*(?:\\n|$)`, 'm'), '').trimEnd();
  }

  protected turnPayload(message: string): string {
    this.outcome.open();
    this.failure = null;
    this.settled = new Promise((resolve) => { this.settle = resolve; });
    // `followUp` changes nothing for an idle Pi; a run Ordewell did not see start, an extension's, gets the message queued behind it, not refused.
    return `${JSON.stringify({ id: `turn-${++this.turns}`, type: 'prompt', message, streamingBehavior: 'followUp' })}\n`;
  }

  protected handleLine(raw: string, emit: (event: AgentEvent) => void): void {
    const line = StdioAgentAdapter.parse<PiLine>(raw);
    if (!line) return;
    switch (line.type) {
      case 'response': {
        if (line.id === RESUME_CHECK) {
          this.resumeAnswer?.(line);
          return;
        }
        // Only the open turn's answers count: Pi may answer an earlier prompt's command late.
        const open = this.settled !== null;
        if (open && line.id === `turn-${this.turns}` && line.success === false) this.endTurn(emit, { type: 'error', message: line.error ?? 'Pi refused the prompt.' });
        // A command Pi ran itself, as `/mcp`, needs no run and sends no
        // `agent_settled`, but one an extension defines may start a run of its
        // own, so Pi is asked whether one is going before the turn ends.
        else if (open && line.id === `turn-${this.turns}` && line.data?.disposition === 'handled' && !this.running) this.writeLine({ id: idleCheck(this.turns), type: 'get_state' });
        else if (open && line.id === idleCheck(this.turns) && !this.running && line.data?.isStreaming !== true) this.endTurn(emit, this.outcome.settle('completed'));
        return;
      }
      case 'agent_start':
        this.running = true;
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
    this.running = false;
    this.message = null;
    this.failure = null;
    this.settle?.();
    this.settle = null;
    this.settled = null;
  }

  /**
   * Pi's `abort`: the run stops and the session stays, and the turn ends at
   * the `agent_settled` it answers with. The queue goes first, or Pi would run
   * a message queued behind the run after the turn ended interrupted.
   */
  async interrupt(timeoutMs: number): Promise<boolean> {
    const settled = this.settled;
    if (!this.process || this.exited || !settled) return false;
    this.outcome.request();
    this.writeLine({ type: 'clear_queue' });
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

/** Pi's agent directory as Pi resolves `PI_CODING_AGENT_DIR` against its cwd, `~` expanded; `~/.pi/agent` when unset. */
function piAgentDir(cwd: string, set: string | undefined): string {
  if (!set) return path.join(homedir(), '.pi', 'agent');
  if (set === '~') return homedir();
  if (set.startsWith('~/') || (process.platform === 'win32' && set.startsWith('~\\'))) return path.join(homedir(), set.slice(2));
  return path.resolve(realCwd(cwd), set);
}

/**
 * The file a session other than `current`'s cwd saved as `id`, its latest
 * where several did: Pi names each `<time>_<id>.jsonl` in the directory of
 * the cwd it was saved in. None where the cwd's own directory has it, which
 * Pi takes up by id, and none where no directory does, which the resume check
 * then refuses.
 */
function savedElsewhere(agentDir: string, current: string, id: string): string | undefined {
  const root = path.join(agentDir, 'sessions');
  const saved: { file: string; at: number }[] = [];
  for (const dir of entries(root)) {
    for (const name of entries(path.join(root, dir))) {
      if (!name.endsWith(`_${id}.jsonl`)) continue;
      if (path.join(root, dir) === current) return undefined;
      const file = path.join(root, dir, name);
      saved.push({ file, at: statSync(file).mtimeMs });
    }
  }
  return saved.sort((a, b) => b.at - a.at)[0]?.file;
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The cwd as Pi's `process.cwd()` gives it, links followed; as given when it is not on disk. */
function realCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function textOf(content: PiContent[] | undefined): string {
  return (content ?? []).map((part) => (part.type === 'text' ? part.text ?? '' : '')).join('');
}
