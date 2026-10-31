import { taggedReadOnlyMode, unavailableTaskModeMessage } from './ModeResolver';
import { spawnAttached } from './harness/ordewellBinding';
import { EventEmitter } from 'events';
import { spawn as nodeSpawn } from 'child_process';
import type {
  IRunnerSession,
  InvokedCommand,
  QueuedTaskMessage,
  StructuredEvent,
  StructuredTurnEnd,
  TaskMessageFrom,
} from '../interfaces/IRunner';
import type { ApprovalDecision } from '../interfaces/IApproval';
import type { RunnerCommand } from '../models/RunnerCommand';
import type { RunnerSessionCost } from '../models/Usage';
import { checkpointReply, commandReply, type CheckpointAnswer, type ApplyPatchArgs, type McpToolReply, type ReadTaskArgs, type TaskCompleteArgs } from './mcp/tools';
import { sharedMcpServer, type OrdewellMcpServer, type TaskTokenScope } from './mcp/OrdewellMcpServer';
import { mcpClientConfig } from './mcp/clientConfig';
import type { ResearchToolType } from '../models/Task';
import type { TaskShell } from '../interfaces/IFileSystem';
import type { TaskWebReads } from './taskWebReads';
import { resolveTaskRunnerFlags } from '../plugins/resolveArgs';
import { AbstractRunner, AbstractRunnerSession, type RunnerSpawnOptions } from './AbstractRunner';
import type { AgentEvent, AgentProcessDeps, TaskModeAgentAdapter, TaskStartOptions } from './harness/AgentAdapter';
import { mapAgentTool, normalizeAgentArgs } from './harness/agentTools';
import { createTaskAdapter } from './harness/connectors';
import { settleWithin } from './harness/settleWithin';
import { sameMessage } from '../utils/sameMessage';
import { checkHandoff, type HandoffCheck } from '../models/Handoff';

/**
 * How long a soft interrupt may take before the runner is killed and resumed
 * instead, and how long a stopped session may take to wind down before it is killed.
 */
const DEFAULT_INTERRUPT_GRACE_MS = 5000;
const TOOL_ARG_MAX_CHARS = 120;

export interface StructuredRunnerDeps {
  /** The OS boundary the adapters spawn through. `workspaceEnv` is always the spawn's own `env`. */
  process?: Partial<Omit<AgentProcessDeps, 'workspaceEnv'>>;
  /** Overrides adapter construction; production picks by runner id and refuses runners without a connector. */
  createAdapter?: (runner: string, deps: AgentProcessDeps) => TaskModeAgentAdapter;
  interruptGraceMs?: number;
  /** Serves the task tools of the runners that take them (ADR-0022). Defaults to the process's one server. */
  mcp?: OrdewellMcpServer;
}


/**
 * What the agent does only when it is working — the events that open a turn it
 * started itself. Anything else arriving between turns (a subagent's report, a
 * usage line) is the closed turn's tail and must not leave the task "working"
 * with nothing to end it.
 */
const TURN_OPENING_EVENTS = new Set<AgentEvent['type']>(['assistant_text', 'assistant_text_delta', 'thinking', 'thinking_delta', 'tool_call']);

/** The argument that says what a tool call is about: the command, the file, the pattern. */
const KEY_ARGS: Partial<Record<ResearchToolType, string>> = {
  bash: 'command',
  read_file: 'path',
  list_dir: 'path',
  grep: 'pattern',
  glob: 'pattern',
  fetch: 'url',
  web_search: 'query',
};
/** For tools with no Ordewell equivalent, the conventional fields in the order they tend to be most telling. */
const FALLBACK_KEY_ARGS = ['file_path', 'path', 'notebook_path', 'description', 'pattern', 'command', 'url', 'query', 'prompt'];

function toolLine(name: string, args: Record<string, unknown>): string {
  const { tool } = mapAgentTool(name);
  const normalized = normalizeAgentArgs(tool, args);
  const preferred = KEY_ARGS[tool];
  for (const key of preferred ? [preferred, ...FALLBACK_KEY_ARGS] : FALLBACK_KEY_ARGS) {
    const value = normalized[key];
    if (typeof value !== 'string') continue;
    const oneLine = value.replace(/\s+/g, ' ').trim();
    if (!oneLine) continue;
    const shown = oneLine.length > TOOL_ARG_MAX_CHARS ? `${oneLine.slice(0, TOOL_ARG_MAX_CHARS)}…` : oneLine;
    return `› ${name}(${shown})`;
  }
  return `› ${name}`;
}

/**
 * The plain-text channel (ADR-0018, O1a): what the planner's live read and
 * the fallback summary see. Deliberately lossy — no JSON, no ANSI, subagents
 * left out.
 *
 * Deltas are held back until a line completes or their run ends, so output
 * is written a line at a time rather than a token at a time. Output is only
 * ever appended: a run's complete copy writes what that run's own deltas did
 * not, and a run after earlier text of the turn opens a paragraph.
 */
class PlainTextChannel {
  /** The run whose deltas are held in `pending` until their line completes. */
  private open: string | null = null;
  private pending = '';
  /** What each of the turn's runs has written. */
  private readonly written = new Map<string, string>();
  /** The turn's latest complete run. */
  private latest = '';
  private atLineStart = true;
  /** The run whose text was written last; null once a line of the channel's own followed it. */
  private lastWriter: string | null = null;

  constructor(private readonly write: (text: string) => void) {}

  delta(runId: string, text: string): void {
    this.enter(runId);
    this.pending += text;
    const newline = this.pending.lastIndexOf('\n');
    if (newline < 0) return;
    this.say(runId, this.pending.slice(0, newline + 1));
    this.pending = this.pending.slice(newline + 1);
  }

  /** A run's authoritative copy, which supersedes its deltas. */
  block(runId: string, text: string): void {
    if (this.open === runId) this.pending = '';
    this.enter(runId);
    this.open = null;
    this.latest = text;
    const streamed = this.written.get(runId) ?? '';
    if (text.startsWith(streamed)) {
      const tail = text.slice(streamed.length);
      // A late copy's tail continues its own run, not whatever spoke since.
      if (tail && this.lastWriter !== runId && !this.atLineStart) this.out('\n');
      this.say(runId, tail);
      return;
    }
    // Its deltas and its copy disagree, as when the stream lost a frame: the
    // copy wins, even at the cost of repeating text — evidence is never dropped.
    if (!this.atLineStart) this.out('\n');
    this.say(runId, text);
  }

  line(text: string): void {
    this.flush();
    if (!this.atLineStart) this.out('\n');
    this.out(`${text}\n`);
    this.lastWriter = null;
  }

  /**
   * A failed turn's message. Claude Code says a usage limit twice — as an
   * assistant message and as the failure — so one that only repeats the
   * turn's latest text is not written again.
   */
  failure(message: string): void {
    this.flush();
    const streaming = this.open === null ? '' : this.written.get(this.open) ?? '';
    if (sameMessage(streaming || this.latest, message)) return;
    this.line(message);
  }

  endTurn(): void {
    this.flush();
    this.open = null;
    this.written.clear();
    this.latest = '';
    if (!this.atLineStart) this.out('\n');
  }

  /** `runId` speaks now: the run held before it is written out, and a run new to the turn opens its paragraph. */
  private enter(runId: string): void {
    if (this.open === runId) return;
    this.flush();
    this.open = runId;
    if (this.written.has(runId)) return;
    if ([...this.written.values()].some(Boolean)) this.out(this.atLineStart ? '\n' : '\n\n');
    this.written.set(runId, '');
  }

  private flush(): void {
    if (!this.pending || this.open === null) return;
    this.say(this.open, this.pending);
    this.pending = '';
  }

  private say(runId: string, text: string): void {
    this.written.set(runId, (this.written.get(runId) ?? '') + text);
    this.out(text);
    if (text) this.lastWriter = runId;
  }

  private out(text: string): void {
    if (!text) return;
    this.atLineStart = text.endsWith('\n');
    this.write(text);
  }
}

interface OpenTurn {
  id: number;
  abort: AbortController;
  ended: boolean;
  reason: StructuredTurnEnd;
  /** The runner refused a message into this turn, so the rest wait for its end too. */
  steerRefused: boolean;
}

/**
 * A message not yet delivered (ADR-0023, Q1). `queued` waits for a turn to end
 * and can be taken back; `steering` is being offered to the running turn;
 * `handed_over` the runner accepted and owes a delivery.
 */
interface PendingMessage {
  id: string;
  text: string;
  stage: 'queued' | 'steering' | 'handed_over';
  /** Force sent (ADR-0023, F1): it opens the turn that replaces the interrupted one. */
  forced?: boolean;
  from?: TaskMessageFrom;
  /** The runner's own command this runs (#66): a turn of its own, never handed into a running one. */
  command?: InvokedCommand;
}

type Opening = Partial<Pick<PendingMessage, 'id' | 'forced' | 'from' | 'command'>>;

interface SessionLaunch {
  runner: string;
  deps: AgentProcessDeps;
  createAdapter: (runner: string, deps: AgentProcessDeps) => TaskModeAgentAdapter;
  startOptions: TaskStartOptions;
  interruptGraceMs: number;
  /** Where this attempt's task tools are served (ADR-0022), and a read-only attempt's shell and web reads (ADR-0046) and patch (ADR-0050). */
  tools: { server: OrdewellMcpServer; scope: TaskTokenScope; shell?: TaskShell; savePatch?: (signal: AbortSignal) => Promise<McpToolReply>; webReads?: TaskWebReads };
  checkHandoff: (completion: TaskCompleteArgs) => HandoffCheck<TaskCompleteArgs>;
  readTask?: (args: ReadTaskArgs) => McpToolReply;
  applyPatch?: (args: ApplyPatchArgs) => Promise<McpToolReply>;
  onNotice?: (message: string) => void;
  onAttaching?: (spawn: 1 | 2) => void;
}

/**
 * One task driven over its runner's programmatic protocol (ADR-0018). It *is*
 * an `IRunnerSession`, with plain output and structured events.
 *
 * Ordewell owns the message queue (M1). A message sent mid-turn is handed to a
 * runner that can take one at its next step (ADR-0023); otherwise it waits for
 * the turn to end rather than being typed into a runner that is busy.
 */
export class StructuredSession extends AbstractRunnerSession {

  private adapter: TaskModeAgentAdapter | null = null;
  private adapterStarted = false;
  private adapterAttached = false;
  private startupExit: string | null = null;
  /** Aborted when the session ends, taking back a spawn still attaching. */
  private readonly ended = new AbortController();
  /** Bumped whenever the adapter is replaced, so the old one's late events and exit are ignored. */
  private generation = 0;
  private output = '';
  private readonly text: PlainTextChannel;
  private state: 'working' | 'idle' = 'idle';
  private turn: OpenTurn | null = null;
  /** A `task_complete` report waiting for its turn to close; the verdict is published then. */
  private completionReport: TaskCompleteArgs | null = null;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  /** A terminal event ends the turn before the adapter releases its send. */
  private sending: OpenTurn | null = null;
  private turnCount = 0;
  private queue: PendingMessage[] = [];
  private messageCount = 0;
  private interrupting: Promise<void> | null = null;
  /** The wind-down once {@link stop} was asked for: the same for every caller, and nothing new is sent meanwhile. */
  private stopping: Promise<void> | null = null;
  /** The process is handling its exit: nothing new may be queued, so a held report can still publish. */
  private exiting = false;
  private lastSessionId: string | null = null;
  private lastSessionCost: RunnerSessionCost | null = null;
  private readonly structuredEmitter = new EventEmitter();
  private permissionCount = 0;
  /**
   * Open tool requests by the id this session gave them, with the runner's own
   * id. The runner's ids are only unique to its process — Codex numbers its
   * requests — while an approval must be answerable by id across the session.
   */
  private readonly permissions = new Map<string, { requestId: string; adapter: TaskModeAgentAdapter; event: Extract<AgentEvent, { type: 'permission_request' }>; answering: boolean }>();
  /** The launch's start options, with this attempt's server once its token is issued. */
  private startOptions: TaskStartOptions;
  /** This attempt's MCP token, until the session ends (ADR-0022, A2). */
  private toolToken: string | null = null;
  private checkpointHandler: ((question: string, signal: AbortSignal) => Promise<CheckpointAnswer>) | null = null;

  constructor(id: string, taskId: string, private readonly launch: SessionLaunch) {
    super(id, taskId);
    this.startOptions = launch.startOptions;
    this.text = new PlainTextChannel((text) => {
      this.output += text;
      this.outputEmitter.emit('output', text);
    });
  }

  /**
   * Start the runner with the attempt's tools attached and send the task's
   * prompt as its first turn. `task_complete` is the only way a task reports
   * it is done, so a runner without the tools is never sent the task: it is
   * killed and respawned once, and a second miss is a timeout the task holds.
   */
  async start(prompt: string): Promise<void> {
    await this.startAttached(this.launch.startOptions);
    // Callers attach their listeners once `spawn` resolves, so the first turn
    // waits for that or its opening events reach nobody. Working already, so
    // a message sent in the meantime queues behind the prompt.
    this.state = 'working';
    setImmediate(() => { if (!this.exited && !this.stopping) this.deliver(prompt); });
  }

  getOutput(): string { return this.output; }

  onTaskComplete(listener: (report: TaskCompleteArgs) => void): void {
    this.structuredEmitter.on('taskComplete', listener);
  }

  onToolCheckpoint(handler: (question: string, signal: AbortSignal) => Promise<CheckpointAnswer>): void {
    this.checkpointHandler = handler;
  }

  /** A runner's model reports through `task_complete`; only a script task's session ends on its exit status (ADR-0035). */
  onScriptExit(): void {}

  /**
   * The runner on a fresh token, attached or respawned once (ADR-0025). Done
   * once the runner reports the server connected — or once the session ended
   * meanwhile, which leaves nothing to start. A runner that cannot be spawned
   * at all throws instead: spawning it again would fail the same way.
   */
  private async startAttached(opts: TaskStartOptions): Promise<void> {
    const { server, scope, shell, savePatch, webReads } = this.launch.tools;
    this.launch.onAttaching?.(1);
    const spawned = await spawnAttached({
      runner: this.launch.runner,
      create: () => this.launch.createAdapter(this.launch.runner, this.launch.deps),
      issueToken: () => server.issueTaskToken(scope, {
        taskComplete: async (report) => {
          const checked = this.launch.checkHandoff(report);
          if (!checked.ok) return { text: checked.refusal, isError: true };
          this.completionReport = checked.handoff;
          // The runner ends its turn on this reply. One that keeps it open has
          // its report published at the same grace; the verdict then stops it.
          if (this.completionTimer) clearTimeout(this.completionTimer);
          this.completionTimer = setTimeout(() => this.flushCompletion(), this.launch.interruptGraceMs);
          // Said at once, so the task shows the report arrived while the turn winds down.
          this.emitEvent({ type: 'completion_received', status: checked.handoff.status });
          return { text: 'Recorded. End your turn now.' };
        },
        checkpoint: async ({ question }, { signal }) => {
          if (!this.checkpointHandler) return { text: 'checkpoint is not available in this session.', isError: true };
          return checkpointReply(await this.checkpointHandler(question, signal));
        },
        ...(this.launch.readTask ? { readTask: async (args) => this.launch.readTask!(args) } : {}),
        ...(this.launch.applyPatch ? { applyPatch: async (args) => this.launch.applyPatch!(args) } : {}),
        // The call's signal aborts when the token is revoked, so a command still running ends with the attempt.
        ...(shell ? { runCommand: async ({ command }, { signal }) => commandReply(await shell.run(command, signal)) } : {}),
        ...(savePatch ? { savePatch: async (_args, { signal }) => savePatch(signal) } : {}),
        // The attempt's, not the token's: a respawn on a fresh token keeps its web-read count.
        ...(webReads ? { fetch: async ({ url }, { signal }) => webReads.fetch(url, signal), webSearch: async ({ query }, { signal }) => webReads.search(query, signal) } : {}),
      }),
      revoke: (token) => server.revoke(token),
      start: (adapter, credential) => {
        this.startOptions = { ...opts, mcp: mcpClientConfig(credential) };
        return this.startAdapter(adapter, this.startOptions);
      },
      dispose: (adapter) => {
        // Its exit is this session's doing, not the end of the attempt.
        this.generation += 1;
        adapter.dispose();
      },
      cancelled: this.ended.signal,
      startupExit: () => this.startupExit,
      onRespawn: (failure) => {
        this.launch.onNotice?.(`${this.launch.runner} started without Ordewell's tools (${failure}); respawning once.`);
        this.launch.onAttaching?.(2);
      },
      failed: (first, second) => `Could not start ${this.launch.runner} with Ordewell's tools, so the task was not sent to it. First spawn: ${first}. Respawn: ${second}.`,
    });
    if (!spawned) return;
    this.toolToken = spawned.token;
    this.adapterAttached = true;
  }

  private revokeTools(): void {
    if (this.toolToken === null) return;
    this.launch.tools.server.revoke(this.toolToken);
    this.toolToken = null;
  }

  protected override baseHandleExit(code: number): void {
    // Nothing can read the queue now. Set before releasing it, so a listener
    // that answers the notice is undelivered rather than queued ahead of the
    // report. Releasing first lets a completion the verdict engine held behind
    // a queued message publish before exit wins.
    this.exiting = true;
    this.undeliverQueued();
    this.flushCompletion();
    this.ended.abort();
    this.revokeTools();
    this.undeliverQueued();
    super.baseHandleExit(code);
  }

  /**
   * A reply typed at the task — a checkpoint answer, most often — is a user
   * message like any other: into the running turn where the runner takes one,
   * else the next turn. A runner that stopped to ask reads it at once either way.
   */
  write(text: string): void {
    const message = text.trim();
    if (message) this.sendMessage(message);
  }

  kill(): void {
    if (this.exited) return;
    const adapter = this.adapter;
    this.generation += 1;
    this.turn?.abort.abort();
    // An adapter not attached yet belongs to its spawn, which the session's
    // exit cancels: taken back at once while it checks its attach state, or
    // once its start lands.
    if (adapter && this.adapterAttached) adapter.dispose();
    this.withdrawPermissions();
    this.baseHandleExit(-1);
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.exited) return Promise.resolve();
    // Set before the wind-down starts: what it says synchronously — undelivered
    // messages, an exit — reaches listeners that may send, or stop, again.
    let woundDown!: () => void;
    this.stopping = new Promise<void>((resolve) => { woundDown = resolve; });
    // A connector that throws on the way out is killed, never left half stopped.
    void this.windDown().catch(() => this.kill()).then(woundDown);
    return this.stopping;
  }

  /**
   * The attempt is over (ADR-0018, L1), so what is still owed goes undelivered
   * and every tool request unanswered at once. A turn still open is
   * interrupted, and its close — where Claude Code reports the turn's cost and
   * its model's window — is waited for; then the runner is told nothing more
   * is coming and left to exit by itself. All of it within the interrupt
   * grace: a runner still there once it runs out is killed.
   */
  private async windDown(): Promise<void> {
    const adapter = this.adapterAttached ? this.adapter : null;
    const deadline = Date.now() + this.launch.interruptGraceMs;
    this.revokeTools();
    this.undeliverQueued();
    this.withdrawPermissions();
    const open = this.turn && !this.turn.ended ? this.turn : null;
    if (adapter && (!open || await this.turnClosed(open, adapter, deadline)) && adapter.endInput && !this.exited) {
      adapter.endInput();
      await this.within(this.gone(), deadline);
    }
    // Gone by itself, its process group may still hold what it started.
    if (this.exited) adapter?.dispose();
    else this.kill();
  }

  /** Whether `turn` closed within the deadline once interrupted. */
  private async turnClosed(turn: OpenTurn, adapter: TaskModeAgentAdapter, deadline: number): Promise<boolean> {
    const closed = new Promise<void>((resolve) => this.structuredEmitter.once('turnEnd', () => resolve()));
    // The turn's close is what is waited for, acknowledged or not.
    adapter.interrupt(Math.max(0, deadline - Date.now())).catch(() => false);
    return (await this.within(closed, deadline)) && turn.ended;
  }

  /** Whether `done` settled before the deadline, or the session ended meanwhile. */
  private within(done: Promise<void>, deadline: number): Promise<boolean> {
    return settleWithin(done.then(() => true), { timeoutMs: Math.max(0, deadline - Date.now()), onTimeout: () => false, ended: this.gone(), onEnded: () => true });
  }

  private gone(): Promise<void> {
    const { signal } = this.ended;
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  }

  turnState(): 'working' | 'idle' { return this.state; }

  onTurnEnd(listener: (reason: StructuredTurnEnd) => void): void {
    this.structuredEmitter.on('turnEnd', listener);
  }

  onEvent(listener: (event: StructuredEvent) => void): void {
    this.structuredEmitter.on('event', listener);
  }

  sendMessage(text: string, from?: TaskMessageFrom): string {
    return this.enqueue(text, from ? { from } : {});
  }

  commands(): RunnerCommand[] {
    return this.adapter?.commands?.() ?? [];
  }

  invokeCommand(name: string, args = ''): string {
    const given = args.trim();
    const text = given ? `/${name} ${given}` : `/${name}`;
    if (!this.adapter?.invokeCommand) return this.sendMessage(text);
    return this.enqueue(text, { command: { name, ...(given ? { args: given } : {}) } });
  }

  private enqueue(text: string, opening: Pick<Opening, 'from' | 'command'>): string {
    this.messageCount += 1;
    const id = `msg-${this.messageCount}`;
    const sender = opening.from ? { from: opening.from } : {};
    if (this.exited || this.exiting || this.stopping) this.emitEvent({ type: 'message_undelivered', messageId: id, text, ...sender });
    else if (this.state === 'idle' && this.adapterStarted && !this.sending) this.deliver(text, opening);
    else {
      this.state = 'working';
      this.queue.push({ id, text, stage: 'queued', ...opening });
      this.emitEvent({ type: 'message_queued', messageId: id, text, ...sender });
      this.offerNext();
    }
    return id;
  }

  /**
   * Force send (ADR-0023, F1–F3): interrupt the running turn — and the tool
   * call in flight — then deliver this message as the turn that replaces it,
   * ahead of everything still queued. With no turn to interrupt it is a plain
   * {@link sendMessage}.
   */
  forceSend(text: string): string {
    if (!this.runningTurn()) return this.sendMessage(text);
    this.messageCount += 1;
    const message: PendingMessage = { id: `msg-${this.messageCount}`, text, stage: 'queued' };
    this.force(message);
    return message.id;
  }

  /**
   * Force send a message not yet delivered. One the runner already has is not
   * sent again — the model would read it twice. The interrupt alone makes it
   * go first: the runner reads it in the turn that follows, or lets go of it
   * and it is sent as that turn from here (D4). False once delivered, or gone.
   */
  forceSendQueued(id: string): boolean {
    const message = this.queue.find((m) => m.id === id);
    if (!message) return false;
    if (message.forced) return true;
    this.queue = this.queue.filter((m) => m !== message);
    this.force(message);
    return true;
  }

  /**
   * Behind earlier forced messages and ahead of the rest, handed-over ones
   * included: what the runner already has is the runner's to order (F2). Held
   * back from steering while the interrupt runs, it opens the next turn — and
   * a queue that is not empty when the turn ends is what keeps the task out of
   * "waiting for input" between the two (F3).
   */
  private force(message: PendingMessage): void {
    message.forced = true;
    const at = this.queue.findIndex((m) => !m.forced);
    this.queue.splice(at < 0 ? this.queue.length : at, 0, message);
    this.emitEvent({ type: 'message_queued', messageId: message.id, text: message.text, forced: true, ...(message.from ? { from: message.from } : {}) });
    if (!this.runningTurn()) return;
    // Nobody awaits a force send's interrupt. Should it throw, the message
    // still opens the next turn — only later, when this one ends by itself.
    this.interrupt().catch((err: unknown) => {
      console.error(`[structured] Force send could not interrupt task ${this.taskId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private runningTurn(): boolean {
    return !this.exited && !this.exiting && !this.stopping && this.adapter !== null && this.turn !== null && !this.turn.ended;
  }

  /** No runner can recall a message once offered to it, so only a queued one comes back. */
  removeQueued(id: string): boolean {
    const message = this.queue.find((m) => m.id === id);
    if (message?.stage !== 'queued') return false;
    this.queue = this.queue.filter((m) => m !== message);
    this.emitEvent({ type: 'message_removed', messageId: id });
    return true;
  }

  queued(): QueuedTaskMessage[] {
    return this.queue.map(({ id, text, stage, forced, from }) => ({
      id, text, ...(stage === 'queued' ? {} : { handedOver: true }), ...(forced ? { forced: true } : {}), ...(from ? { from } : {}),
    }));
  }

  nativeSessionId(): string | null {
    return this.adapter?.nativeSessionId() ?? this.lastSessionId;
  }

  sessionCost(): RunnerSessionCost | null {
    return this.adapter?.sessionCost?.() ?? this.lastSessionCost;
  }

  answerPermission(id: string, decision: ApprovalDecision): boolean | Promise<boolean> {
    const open = this.permissions.get(id);
    if (!open || open.answering) return false;
    open.answering = true;
    const settle = (accepted: boolean): boolean => {
      if (this.permissions.get(id) !== open) return false;
      this.permissions.delete(id);
      this.emitEvent(accepted ? { type: 'permission_decided', id, decision } : { type: 'permission_withdrawn', id });
      return accepted;
    };
    const retry = (): false => {
      if (this.permissions.get(id) === open) {
        open.answering = false;
        // The approval seam has settled the user's answer; ask under the same
        // id again so its still-pending card can take another delivery attempt.
        this.emitEvent({ ...open.event, id });
      }
      return false;
    };
    try {
      const answer = open.adapter.answerPermission(open.requestId, decision);
      return answer instanceof Promise ? answer.then(settle, retry) : settle(answer);
    } catch { return retry(); }
  }

  /** Every open request goes unanswered once the process that asked is gone. */
  private withdrawPermissions(adapter?: TaskModeAgentAdapter): void {
    for (const [id, open] of [...this.permissions]) {
      if (adapter && open.adapter !== adapter) continue;
      this.permissions.delete(id);
      this.emitEvent({ type: 'permission_withdrawn', id });
    }
  }

  interrupt(): Promise<void> {
    if (this.interrupting) return this.interrupting;
    const turn = this.turn;
    const adapter = this.adapter;
    // A session winding down is interrupting its turn already.
    if (!turn || turn.ended || !adapter || this.stopping) return Promise.resolve();
    this.interrupting = this.interruptTurn(turn, adapter).finally(() => {
      this.interrupting = null;
      this.offerNext();
    });
    return this.interrupting;
  }

  private async interruptTurn(turn: OpenTurn, adapter: TaskModeAgentAdapter): Promise<void> {
    const grace = this.launch.interruptGraceMs;
    const ended = new Promise<void>((resolve) => this.structuredEmitter.once('turnEnd', () => resolve()));
    // An adapter whose request never answers is one that ignored the interrupt, so the grace bounds the ask too.
    const acknowledged = await settleWithin(adapter.interrupt(grace).catch(() => false), { timeoutMs: grace, onTimeout: () => false });
    if (acknowledged) {
      // Acknowledged, but the turn only ends with its result line.
      const settled = await settleWithin(ended.then(() => true), { timeoutMs: grace, onTimeout: () => false });
      if (settled) return;
    }
    // A session winding down is ended, never restarted.
    if (turn.ended || this.exited || this.stopping) return;
    await this.restartInterrupted(turn);
  }

  /**
   * The fallback when the runner ignores a soft interrupt: kill it and resume
   * its session in a fresh process, the way the planner restarts from its
   * session id after an abort.
   */
  private async restartInterrupted(turn: OpenTurn): Promise<void> {
    // A continue interrupted before its runner took the session up still
    // resumes that session, never a fresh one.
    const resumeSessionId = this.nativeSessionId() ?? this.startOptions.resumeSessionId;
    const resumeCost = this.sessionCost() ?? this.startOptions.resumeCost;
    this.generation += 1;
    this.sending = null;
    turn.abort.abort();
    if (this.adapter) {
      this.withdrawPermissions(this.adapter);
      this.adapter.dispose();
    }
    // The killed process takes what it was handed with it; the queue still has the messages.
    for (const message of this.queue) this.requeue(message);
    try {
      this.revokeTools();
      await this.startAttached({ ...this.startOptions, resumeSessionId, resumeCost });
    } catch (err) {
      this.text.line(`Could not restart ${this.launch.runner} after the interrupt: ${err instanceof Error ? err.message : String(err)}`);
      this.withdrawPermissions();
      this.baseHandleExit(-1);
      this.endTurn(turn, 'interrupted');
      return;
    }
    this.endTurn(turn, 'interrupted');
  }

  private async startAdapter(adapter: TaskModeAgentAdapter, opts: TaskStartOptions): Promise<void> {
    this.adapter = adapter;
    this.adapterStarted = false;
    this.adapterAttached = false;
    this.startupExit = null;
    const generation = this.generation;
    await adapter.start(opts);
    this.adapterStarted = true;
    if (this.exited || generation !== this.generation) return;
    adapter.onOutOfTurn?.((event) => this.handleOutOfTurn(adapter, generation, event));
    adapter.onProcessExit((code, lastWords) => {
      if (generation !== this.generation) return;
      if (!this.adapterAttached) {
        this.startupExit = lastWords ?? `${this.launch.runner} exited with code ${code}`;
        return;
      }
      this.lastSessionId = adapter.nativeSessionId() ?? this.lastSessionId;
      this.lastSessionCost = adapter.sessionCost?.() ?? this.lastSessionCost;
      this.withdrawPermissions();
      this.baseHandleExit(code);
    });
  }

  /** `message` is what opened the turn: a queued one has an id, one delivered straight from idle only its sender. */
  private openTurn(text: string, message?: Opening): OpenTurn {
    this.turnCount += 1;
    this.discardCompletion();
    const turn: OpenTurn = { id: this.turnCount, abort: new AbortController(), ended: false, reason: 'completed', steerRefused: false };
    this.turn = turn;
    this.state = 'working';
    this.emitEvent({
      type: 'turn_start', text,
      ...(message?.id ? { messageId: message.id } : {}), ...(message?.forced ? { forced: true } : {}), ...(message?.from ? { from: message.from } : {}),
      ...(message?.command ? { command: message.command } : {}),
    });
    return turn;
  }

  private deliver(text: string, message?: Opening): void {
    const adapter = this.adapter;
    if (!adapter) return;
    const turn = this.openTurn(text, message);
    this.sending = turn;
    const generation = this.generation;
    const onEvent = (event: AgentEvent): void => {
      if (generation !== this.generation) return;
      this.route(adapter, turn, event);
    };
    const command = message?.command;
    const sent = command && adapter.invokeCommand
      ? adapter.invokeCommand(command.name, command.args ?? '', onEvent, turn.abort.signal)
      : adapter.send(text, onEvent, turn.abort.signal);

    void sent.catch((err: unknown) => {
      if (generation !== this.generation || this.exited) return;
      turn.reason = 'failed';
      this.handleEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }).then(() => {
      this.lastSessionId = adapter.nativeSessionId() ?? this.lastSessionId;
      this.lastSessionCost = adapter.sessionCost?.() ?? this.lastSessionCost;
      if (this.sending === turn) this.sending = null;
      if (generation === this.generation) {
        this.endTurn(turn, turn.reason);
        this.deliverNext();
      }
    });
    this.offerNext();
  }

  /**
   * Offer the oldest queued message to the running turn (ADR-0023, D2), one at
   * a time so the runner takes them in the order they were sent. A refusal
   * leaves it, and everything behind it, for the turn's end.
   */
  private offerNext(): void {
    const adapter = this.adapter;
    const turn = this.turn;
    if (!adapter?.steer || !turn || turn.ended || turn.steerRefused || this.interrupting || this.exited || this.exiting || this.stopping) return;
    if (this.queue.some((m) => m.stage === 'steering')) return;
    const next = this.queue.find((m) => m.stage === 'queued');
    // A command handed into the turn would be read as text; it and whatever
    // was sent after it wait for the turn's end.
    if (!next || next.command) return;
    next.stage = 'steering';
    const generation = this.generation;
    adapter.steer(next.id, next.text).catch(() => false).then((accepted) => {
      if (generation === this.generation) this.steered(turn, next, accepted);
    });
  }

  private steered(turn: OpenTurn, message: PendingMessage, accepted: boolean): void {
    // Delivered, dropped or undelivered while the answer was on its way.
    if (message.stage !== 'steering' || !this.queue.includes(message)) {
      this.offerNext();
      this.deliverNext();
      return;
    }
    if (accepted) {
      message.stage = 'handed_over';
      this.emitEvent({ type: 'message_handed_over', messageId: message.id });
      this.offerNext();
      return;
    }
    message.stage = 'queued';
    turn.steerRefused = true;
    this.offerNext();
    this.deliverNext();
  }

  private delivered(id: string): PendingMessage | undefined {
    const message = this.queue.find((m) => m.id === id);
    if (message) this.queue = this.queue.filter((m) => m !== message);
    return message;
  }

  /** Back to waiting in Ordewell's queue, removable again; the log hears of it only if it had shown as handed over. */
  private requeue(message: PendingMessage): void {
    const was = message.stage;
    message.stage = 'queued';
    if (was === 'handed_over') this.emitEvent({ type: 'message_queued', messageId: message.id, text: message.text, ...(message.from ? { from: message.from } : {}) });
  }

  private route(adapter: TaskModeAgentAdapter, turn: OpenTurn | null, event: AgentEvent): void {
    if (event.type === 'turn_end') {
      if (turn) turn.reason = event.interrupted ? 'interrupted' : 'completed';
    } else if (event.type === 'permission_request') this.openPermission(adapter, event);
    else if (event.type === 'permission_cancelled') this.cancelPermission(adapter, event.id);
    else if (event.type === 'message_delivered') {
      // What the runner reported before reading a new message no longer counts
      // (ADR-0023, D6), including a completion still waiting for its turn.
      this.discardCompletion();
      const message = this.delivered(event.id);
      if (message) this.emitEvent({ type: 'message_delivered', messageId: message.id, text: message.text, ...(message.from ? { from: message.from } : {}) });
    } else if (event.type === 'message_dropped') {
      const message = this.queue.find((m) => m.id === event.id);
      if (!message) return;
      this.requeue(message);
      if (turn) turn.steerRefused = true;
      this.deliverNext();
    } else {
      if (event.type === 'error' && turn) turn.reason = 'failed';
      this.handleEvent(event);
    }
    if (turn && (event.type === 'turn_end' || event.type === 'error')) this.endTurn(turn, turn.reason);
  }

  /**
   * The runner spoke with no message of ours in flight. When it is working — a
   * turn it opened itself once background work finished — that is a turn of the
   * task like any other: the state says working, a queued message waits, and its
   * end settles it. A message with no text in `turn_start` marks it as not ours.
   */
  private handleOutOfTurn(adapter: TaskModeAgentAdapter, generation: number, event: AgentEvent): void {
    if (generation !== this.generation || this.exited) return;
    let turn = this.turn && !this.turn.ended ? this.turn : null;
    if (!turn && event.type === 'message_delivered') {
      // The runner opened a turn of its own for a message it was handed as the
      // last one closed, so the message is that turn's, not a mid-turn read.
      const message = this.delivered(event.id);
      if (message) {
        this.openTurn(message.text, message);
        this.offerNext();
      }
      return;
    }
    // A runner winding down opens no turn of the task's: what it still says is the closed one's tail.
    if (!turn && !this.stopping && TURN_OPENING_EVENTS.has(event.type) && !('subagentId' in event && event.subagentId)) {
      turn = this.openTurn('');
      this.offerNext();
    }
    this.route(adapter, turn, event);
  }

  private openPermission(adapter: TaskModeAgentAdapter, event: Extract<AgentEvent, { type: 'permission_request' }>): void {
    this.permissionCount += 1;
    const id = `${this.id}-perm-${this.permissionCount}`;
    if (event.decided) {
      this.emitEvent({ ...event, id });
      this.emitEvent({ type: 'permission_decided', id, decision: event.decided });
      return;
    }
    this.permissions.set(id, { requestId: event.id, adapter, event, answering: false });
    this.emitEvent({ ...event, id });
  }

  private cancelPermission(adapter: TaskModeAgentAdapter, requestId: string): void {
    for (const [id, open] of this.permissions) {
      if (open.adapter !== adapter || open.requestId !== requestId) continue;
      this.permissions.delete(id);
      this.emitEvent({ type: 'permission_withdrawn', id });
      return;
    }
  }

  private handleEvent(event: Exclude<AgentEvent, { type: 'turn_end' | 'permission_request' | 'permission_cancelled' | 'message_delivered' | 'message_dropped' }>): void {
    switch (event.type) {
      case 'assistant_text_delta': this.text.delta(event.runId, event.text); break;
      case 'assistant_text': this.text.block(event.runId, event.text); break;
      case 'tool_call': if (!event.subagentId) this.text.line(toolLine(event.name, event.args)); break;
      case 'error': this.text.failure(event.message); break;
      // The plan follows the switch (#106), so a restart after an interrupt
      // runs what the plan now says rather than what this attempt started on.
      case 'model_switched': this.startOptions = { ...this.startOptions, model: event.to.model }; break;
      default: break;
    }
    this.emitEvent(event);
  }

  /** Publish a `task_complete` report whose turn has closed, or that waited out the grace. */
  private flushCompletion(): void {
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }
    const report = this.completionReport;
    this.completionReport = null;
    if (report) this.structuredEmitter.emit('taskComplete', report);
  }

  /** A message the runner reads, or a turn it opens, voids a report made before it (ADR-0023, D6). */
  private discardCompletion(): void {
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }
    this.completionReport = null;
  }

  /**
   * A queued message goes out as the turn closes, and the state never passes
   * through `idle` on the way, so a listener told the turn ended can already
   * see the task is not waiting. Nor does a message the runner owes, or one
   * still being offered: the runner is about to read it, or Ordewell to send
   * it (ADR-0023, D5).
   */
  private endTurn(turn: OpenTurn, reason: StructuredTurnEnd): void {
    if (turn.ended) return;
    turn.ended = true;
    this.text.endTurn();
    this.emitEvent({ type: 'turn_end', reason });
    // The report waits for the turn to close, so its tool reply lands first.
    this.flushCompletion();
    if (reason === 'failed') this.undeliverQueued();
    this.state = !this.exited && this.queue.length ? 'working' : 'idle';
    this.structuredEmitter.emit('turnEnd', reason);
    this.deliverNext();
  }

  /**
   * Between turns the oldest message opens the next one — but only once it is
   * back in Ordewell's hands: while it is on offer or owed, nothing overtakes it.
   */
  private deliverNext(): void {
    if (this.exited || this.exiting || this.stopping || this.sending || (this.turn && !this.turn.ended)) return;
    const head = this.queue[0];
    if (!head || this.queue.some((message) => message.stage !== 'queued')) return;
    this.queue.shift();
    this.deliver(head.text, head);
  }

  private undeliverQueued(): void {
    const messages = this.queue;
    this.queue = [];
    for (const { id, text, from } of messages) this.emitEvent({ type: 'message_undelivered', messageId: id, text, ...(from ? { from } : {}) });
  }

  private emitEvent(event: StructuredEvent): void {
    this.structuredEmitter.emit('event', event);
  }
}

/**
 * The structured transport (ADR-0018): a task's runner as a plain child
 * process speaking its protocol — no tmux, no `script` (W2). Only runners
 * with a task-mode connector can be spawned here.
 */
export class StructuredRunner extends AbstractRunner<StructuredSession> {
  private spawnCount = 0;
  private readonly processDeps: Partial<Omit<AgentProcessDeps, 'workspaceEnv'>>;
  private readonly createAdapter: (runner: string, deps: AgentProcessDeps) => TaskModeAgentAdapter;
  private readonly interruptGraceMs: number;
  private readonly mcp: OrdewellMcpServer;

  constructor(deps: StructuredRunnerDeps = {}) {
    super();
    this.processDeps = deps.process ?? {};
    this.createAdapter = deps.createAdapter ?? createTaskAdapter;
    this.interruptGraceMs = deps.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
    this.mcp = deps.mcp ?? sharedMcpServer();
  }

  async spawn(opts: RunnerSpawnOptions): Promise<IRunnerSession> {
    const manifest = opts.registry?.get(opts.runner)?.manifest;
    if (!manifest) throw new Error(`No runner manifest is registered for "${opts.runner}".`);
    // Before a process or a worktree's worth of waiting: the task was planned
    // with a mode this host cannot run, and the reason already says how to fix it.
    const unavailable = unavailableTaskModeMessage(manifest, opts.mode);
    if (unavailable) throw new Error(unavailable);

    const readOnly = opts.shell !== undefined || opts.mode !== undefined && opts.mode === taggedReadOnlyMode(manifest.modes);
    this.spawnCount += 1;
    const id = `ordewell-structured-${opts.taskId.slice(0, 8)}-${this.spawnCount}`;
    const env = { ...opts.env };
    const session = new StructuredSession(id, opts.taskId, {
      runner: opts.runner,
      deps: {
        spawn: nodeSpawn,
        fetch: globalThis.fetch,
        ...this.processDeps,
        // Already resolved by the caller (ADR-0016); resolving it again here
        // could disagree with the other tasks in the same run.
        workspaceEnv: async () => env,
      },
      createAdapter: this.createAdapter,
      startOptions: {
        kind: 'task',
        cwd: opts.cwd,
        workspaceRoot: opts.workspaceRoot,
        model: opts.modelId,
        mode: opts.mode ?? 'default',
        flags: resolveTaskRunnerFlags(manifest, { mode: opts.mode ?? 'default', model: opts.modelId, thinkingEffort: opts.thinkingEffort }),
        resumeSessionId: opts.resumeSessionId,
        resumeCost: opts.resumeCost,
        ...(opts.commits ? { commits: true } : {}),
        ...(opts.runnerConfig ? { runnerConfig: opts.runnerConfig } : {}),
      },
      interruptGraceMs: this.interruptGraceMs,
      tools: {
        server: this.mcp,
        scope: { sessionId: opts.planSessionId ?? '', taskId: opts.taskId, attempt: opts.attempt ?? 1, ...(readOnly ? { readOnly: true } : {}) },
        ...(opts.shell ? { shell: opts.shell } : {}),
        ...(opts.shell && opts.savePatch ? { savePatch: opts.savePatch } : {}),
        ...(readOnly && opts.webReads ? { webReads: opts.webReads } : {}),
      },
      checkHandoff: opts.checkHandoff ?? ((completion) => checkHandoff(completion, opts.taskId, [])),
      ...(opts.readTask ? { readTask: opts.readTask } : {}),
      ...(opts.applyPatch ? { applyPatch: opts.applyPatch } : {}),
      onNotice: opts.onNotice,
      onAttaching: opts.onAttaching,
    });

    console.error(`[structured] Starting ${opts.runner} [${opts.mode ?? 'default'}] (${opts.modelId || 'default'}) for task ${opts.taskId.slice(0, 8)}`);
    this.registerSession(id, session);
    // Until the start resolves the caller holds no session to stop, so its
    // cancel is the only way to end a runner still waiting for its tools.
    const cancel = () => void session.stop();
    opts.cancelled?.addEventListener('abort', cancel, { once: true });
    try {
      if (opts.cancelled?.aborted) cancel();
      await session.start(opts.prompt);
    } catch (err) {
      session.kill();
      this.sessions.delete(id);
      throw err;
    } finally {
      opts.cancelled?.removeEventListener('abort', cancel);
    }
    return session;
  }
}
