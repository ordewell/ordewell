import { randomUUID } from 'crypto';
import * as path from 'path';
import type { AgentEvent, AgentProcessDeps, AgentStartOptions, TaskModeAgentAdapter } from '../AgentAdapter';
import type { AttachState } from '../ordewellBinding';
import { SessionNotResumable } from '../ordewellBinding';
import { HeldSecrets } from '../../HeldSecrets';
import { VENDORS } from '../../apiProviders';
import { withHostCredentials } from '../../hostCredentials';
import { createModelClient, DEFAULT_STREAM_TIMEOUTS, withRetry } from '../../model';
import type { EffortLevel, ModelClient, RetryPolicy, StreamTimeouts } from '../../model';
import type { ApprovalDecision } from '../../../interfaces/IApproval';
import type { AiProvider } from '../../../interfaces/IConfig';
import { attemptModeOf, GuardedShell, toolsOf } from './modes';
import { lookupModelInfo, parseModelId, providerCredentials } from './models';
import { buildSystemPrompt } from './prompt';
import { taskToolsOf } from './taskTools';
import { FileTranscriptStore, ordewellSessionsRoot, type LoadedTranscript, type TranscriptStore } from './transcript';
import { OrdewellLoop, retryNote, stepFailure, type RequestAssembler, type StepBoundary, type StepBoundaryHook, type StepPlan } from './loop';
import { SettingsService } from '../../SettingsService';
import type { GateDecision, ToolGate } from './tools';

/** The longest a cooperative stop waits for the step in flight before the stream and tools are aborted. */
const HARD_ABORT_AFTER_MS = 2_000;

/**
 * The model calls an attempt makes when the settings file names no
 * `ordewellStepLimit`: room for a long task, yet a model that never reports
 * is stopped, on a report, before it spends the account.
 */
export const DEFAULT_ORDEWELL_STEP_LIMIT = 200;

const EFFORTS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Seams the later slices fill (ADR-0070): a test, or the modes and lifecycle
 * work, hands them in here rather than through every start option.
 */
export interface OrdewellAdapterOptions {
  /** Where transcripts live; the global data dir's by default, never the workspace (ADR-0032). */
  sessionsRoot?: string;
  createClient?: (provider: AiProvider, apiKey: string, baseUrl: string | undefined) => ModelClient;
  gate?: ToolGate;
  onStepBoundary?: StepBoundaryHook;
  assemble?: RequestAssembler;
  /** How long a slow catalog may hold up a start before the model's info is defaulted. */
  modelInfoTimeoutMs?: number;
  openStore?: (sessionId: string, root: string) => TranscriptStore;
  /** The step limit, over the settings file's `ordewellStepLimit`. */
  stepLimit?: number;
  /** How long a stream may go quiet, over the settings file's `ordewellStreamTimeouts`. */
  streamTimeouts?: StreamTimeouts;
  /** The retry policy, for a test to shorten its gaps; the default one otherwise. */
  retry?: { policy?: Partial<RetryPolicy>; random?: () => number };
}

interface PendingMessage {
  id: string;
  text: string;
}

interface RunningTurn {
  stop: AbortController;
  hard: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * The built-in runner on one provider (ADR-0070): a task-mode adapter whose
 * agent is a loop in this process, not a child. Nothing is spawned, so the
 * spawn deps go unused; its task tools are the attempt's token's own handlers,
 * called directly (ADR-0022 S2), so it is attached the moment it starts, and
 * its verdict still comes only from that token's `task_complete`.
 */
export class OrdewellAdapter implements TaskModeAgentAdapter {
  /** The runner id, which is its provider's (ADR-0070). */
  readonly agentId: AiProvider;
  private loop: OrdewellLoop | null = null;
  private store: TranscriptStore | null = null;
  private turn: RunningTurn | null = null;
  private onEvent: ((event: AgentEvent) => void) | null = null;
  private onActivity: (() => void) | null = null;
  private exitListeners: ((code: number, lastWords?: string) => void)[] = [];
  private attached = false;
  private disposed = false;
  /** Messages `steer` accepted that no step boundary has delivered yet (ADR-0023). */
  private pending: PendingMessage[] = [];
  private ended!: () => void;
  private readonly gone = new Promise<void>((resolve) => {
    this.ended = resolve;
  });
  private guard: GuardedShell | null = null;
  private readonly held: HeldSecrets;
  /** Said once, as the attempt's first log line: no events reach anyone before its first turn. */
  private startNotice: string | null = null;

  constructor(private readonly provider: AiProvider, private readonly deps: AgentProcessDeps, private readonly options: OrdewellAdapterOptions = {}) {
    this.agentId = provider;
    // The session's own, when it passes one, so its event redaction knows the keys too (ADR-0061).
    this.held = deps.held ?? new HeldSecrets();
  }

  get exited(): boolean {
    return this.disposed;
  }

  /** The name the runner goes by, its provider's: no runner is called Ordewell (ADR-0070). */
  private get label(): string {
    return VENDORS[this.provider].label;
  }

  async start(opts: AgentStartOptions): Promise<void> {
    const label = this.label;
    if (opts.kind !== 'task') throw new Error(`The built-in runner does not plan: the ${label} planner is the API planner, on the same key.`);
    const mode = attemptModeOf(opts);
    const parsed = opts.model ? parseModelId(opts.model) : undefined;
    if (!opts.model || !parsed) {
      throw new Error(`The ${label} runner needs a model as ${this.provider}:<model>${opts.model ? `, not "${opts.model}"` : ''}.`);
    }
    // Refused, never rewritten: the plan names the model it runs (ADR-0001), and
    // another provider's model belongs to that provider's runner.
    if (parsed.provider !== this.provider) {
      throw new Error(`The ${label} runner runs only ${this.provider}:<model> models, not "${opts.model}": assign the task to the ${VENDORS[parsed.provider].label} runner instead.`);
    }
    // With what the host holds for the runner over it, as its listing read it, so a runner that is listed can start.
    const env: NodeJS.ProcessEnv = withHostCredentials({ ...process.env, ...(await this.deps.workspaceEnv?.(opts.cwd)) });
    const credentials = providerCredentials(env, this.provider);
    if (!credentials) {
      const missing = this.provider === 'openai_compatible'
        ? `No ${label} endpoint is set for the built-in runner: set ${VENDORS.openai_compatible.baseUrlEnvVar}.`
        : `No ${label} key is set for the built-in runner: add one with /key-set.`;
      throw new Error(missing);
    }
    const { apiKey } = credentials;
    // Every key in reach, not just this provider's: a tool can print any of them (ADR-0061).
    if (apiKey) this.held.hold(apiKey);
    this.held.holdEnv(env);

    const root = this.options.sessionsRoot ?? ordewellSessionsRoot();
    const sessionId = opts.resumeSessionId ?? randomUUID();
    const store = (this.options.openStore ?? ((id, dir) => new FileTranscriptStore(id, dir)))(sessionId, root);
    const saved = opts.resumeSessionId ? await this.savedSession(store, opts.resumeSessionId) : undefined;
    const settings = new SettingsService().getAll();
    const stepLimit = this.options.stepLimit ?? settings.ordewellStepLimit ?? DEFAULT_ORDEWELL_STEP_LIMIT;
    const system = saved?.system ?? buildSystemPrompt({ cwd: opts.cwd, commits: opts.commits === true, stepLimit });
    const timeouts = this.options.streamTimeouts ?? streamTimeoutsOf(settings.ordewellStreamTimeouts);

    const inProcess = opts.mcp?.inProcess;
    const baseUrl = credentials.baseUrl || undefined;
    const emit = (event: AgentEvent): void => {
      this.onActivity?.();
      this.onEvent?.(event);
    };
    const retry = this.options.retry ?? {};
    const client = withRetry((this.options.createClient ?? defaultClient(this.deps, timeouts))(this.provider, apiKey, baseUrl), {
      ...retry,
      // In the task log, so a step that took minutes says why (ADR-0070).
      onRetry: ({ attempt, delayMs, error }) => emit(this.held.hideIn({ type: 'command_output', text: retryNote(error.message, delayMs, attempt) })),
    });
    const model = await lookupModelInfo(opts.model, env, {
      fetchImpl: this.deps.fetch,
      ...(this.options.modelInfoTimeoutMs !== undefined ? { timeoutMs: this.options.modelInfoTimeoutMs } : {}),
      ...(settings.ordewellContextWindows ? { windows: settings.ordewellContextWindows } : {}),
    });
    this.startNotice = model.contextWindowSource === 'assumed' ? assumedWindowNote(model.id, model.contextWindow) : null;
    const effort = EFFORTS.find((level) => level === opts.flags.effort);

    this.store = store;
    this.attached = inProcess !== undefined;
    // Its requests carry the command line, which may spell out a key the model read (ADR-0061).
    this.guard = mode === 'guarded' ? new GuardedShell((event) => emit(this.held.hideIn(event))) : null;
    const gate = composeGates(this.options.gate, this.guard?.gate);
    this.loop = new OrdewellLoop({
      client,
      model,
      system,
      store,
      tools: toolsOf(mode),
      taskTools: inProcess ? taskToolsOf(inProcess) : { definitions: [], has: () => false, call: async () => ({ text: 'No task tools in this session.', isError: true }) },
      toolContext: {
        worktree: opts.cwd,
        // The tools filter keys out of the shell's env themselves (Full: no key reaches a child).
        env,
        outputDir: path.join(store.dir, 'tool-output'),
        ...(opts.workspaceRoot && path.resolve(opts.workspaceRoot) !== path.resolve(opts.cwd) ? { extraReadRoots: [opts.workspaceRoot] } : {}),
      },
      ...(gate ? { gate } : {}),
      onStepBoundary: (boundary) => this.atBoundary(boundary),
      stepLimit,
      retry,
      ...(this.options.assemble ? { assemble: this.options.assemble } : {}),
      ...(effort ? { effort } : {}),
      hide: (value) => this.held.hideIn(value),
      emit,
    });
  }

  async send(message: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, onActivity?: () => void): Promise<void> {
    const loop = this.loop;
    if (!loop || this.disposed) throw new Error(`The ${this.label} runner is not started.`);
    if (this.turn) throw new Error(`The ${this.label} runner is already running a turn.`);
    const turn: RunningTurn = { stop: new AbortController(), hard: new AbortController() };
    // The session aborts its own signal only once it has given up on the turn: nothing more to wait for.
    const abandon = (): void => turn.hard.abort();
    if (signal?.aborted) abandon();
    signal?.addEventListener('abort', abandon, { once: true });
    this.turn = turn;
    this.onEvent = onEvent;
    this.onActivity = onActivity ?? null;
    if (this.startNotice) onEvent({ type: 'command_output', text: this.startNotice });
    this.startNotice = null;
    let last: AgentEvent;
    try {
      const outcome = await loop.runTurn(message, { stop: turn.stop.signal, hard: turn.hard.signal });
      last = { type: 'turn_end', ...(outcome.interrupted ? { interrupted: true } : {}) };
    } catch (err) {
      last = turn.stop.signal.aborted || turn.hard.signal.aborted ? { type: 'turn_end', interrupted: true } : this.held.hideIn(stepFailure(err));
    }
    try {
      // Before the turn's end, which closes it: a message the turn never showed the model is the session's to send again (ADR-0023 D4).
      for (const { id } of this.pending.splice(0)) onEvent({ type: 'message_dropped', id });
      onEvent(last);
    } finally {
      signal?.removeEventListener('abort', abandon);
      if (turn.timer) clearTimeout(turn.timer);
      this.turn = null;
      this.onEvent = null;
      this.onActivity = null;
    }
  }

  /** A cooperative stop, then the hard abort inside the session's grace, so the turn ends before it gives up. */
  async interrupt(timeoutMs: number): Promise<boolean> {
    const turn = this.turn;
    if (!turn) return false;
    turn.stop.abort();
    this.guard?.cancelOpen();
    if (!turn.timer) {
      turn.timer = setTimeout(() => turn.hard.abort(), Math.max(0, Math.min(HARD_ABORT_AFTER_MS, Math.floor(timeoutMs / 2))));
      turn.timer.unref?.();
    }
    return true;
  }

  /**
   * Takes a message for the running turn's next step boundary (ADR-0023 D1),
   * the loop's own seam: between steps, never inside one, so a tool call and
   * its result are never parted. Refused once the turn is stopping, as no
   * boundary is left to deliver it at.
   */
  async steer(id: string, text: string): Promise<boolean> {
    const turn = this.turn;
    if (!turn || this.disposed || turn.stop.signal.aborted || turn.hard.signal.aborted) return false;
    this.pending.push({ id, text });
    return true;
  }

  async stepEnded(timeoutMs: number): Promise<boolean> {
    const loop = this.loop;
    if (this.disposed) return false;
    if (!loop) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      loop.streamEnded().then(() => true),
      this.gone.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    return outcome;
  }

  /** Nothing outlives the turn in this process: once told no more is coming, the runner ends at once. */
  endInput(): void {
    this.dispose();
  }

  nativeSessionId(): string | null {
    return this.store?.sessionId ?? null;
  }

  version(): string | null {
    return null;
  }

  async mcpAttached(): Promise<AttachState> {
    return this.attached && !this.disposed ? 'connected' : 'failed';
  }

  onProcessExit(listener: (code: number, lastWords?: string) => void): void {
    this.exitListeners.push(listener);
  }

  /** Only Guarded asks, and only before a shell command; nothing else is ever open. */
  answerPermission(id: string, decision: ApprovalDecision): boolean {
    return this.guard?.answer(id, decision) ?? false;
  }

  /** The runner's own spill files, which a task's file tool may read back. */
  savedOutput(abs: string): boolean {
    const dir = this.store?.dir;
    if (!dir) return false;
    const relative = path.relative(dir, path.resolve(abs));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.guard?.cancelOpen();
    this.turn?.hard.abort();
    this.ended();
    for (const listener of this.exitListeners.splice(0)) listener(0);
  }

  /**
   * The transcript a continuation resumes (ADR-0018 K1), read from disk, so a
   * daemon restarted since the last attempt resumes it the same. One that is
   * missing, or holds no start to continue from, is refused as unresumable:
   * starting fresh under its id would silently drop the work it carried. One
   * that cannot be read now fails the start but keeps the id for a later try.
   */
  private async savedSession(store: TranscriptStore, id: string): Promise<LoadedTranscript> {
    let saved: LoadedTranscript | undefined;
    try {
      saved = (await store.exists()) ? await store.load() : undefined;
    } catch (err) {
      throw new Error(`The ${this.label} runner could not read saved session ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!saved) throw new SessionNotResumable(`The ${this.label} runner has no saved session ${id} to continue.`);
    if (saved.system === undefined) throw new SessionNotResumable(`The ${this.label} runner's saved session ${id} holds no start to continue from.`);
    return saved;
  }

  /** The seam's own hook first; then the messages waiting, unless that hook stopped the turn. */
  private async atBoundary(boundary: StepBoundary): Promise<StepPlan | void> {
    const plan = (await this.options.onStepBoundary?.(boundary)) ?? {};
    const turn = this.turn;
    if (plan.stop || !turn || turn.stop.signal.aborted || boundary.signal.aborted || this.pending.length === 0) return plan;
    const messages = this.pending.splice(0);
    for (const { id } of messages) this.onEvent?.({ type: 'message_delivered', id });
    return { ...plan, inject: [...(plan.inject ?? []), ...messages.map((m) => m.text)] };
  }
}

/** A test's gate, then the mode's: a call runs only when every gate allows it. */
function composeGates(...gates: (ToolGate | undefined)[]): ToolGate | undefined {
  const present = gates.filter((gate): gate is ToolGate => gate !== undefined);
  if (present.length <= 1) return present[0];
  return async (call): Promise<GateDecision> => {
    for (const gate of present) {
      const decision = await gate(call);
      if (!decision.allow) return decision;
    }
    return { allow: true };
  };
}

function defaultClient(deps: AgentProcessDeps, timeouts: StreamTimeouts): NonNullable<OrdewellAdapterOptions['createClient']> {
  return (provider, apiKey, baseUrl) => createModelClient({ provider, apiKey, ...(baseUrl ? { baseUrl } : {}), fetch: deps.fetch, timeouts });
}

/** The settings file's timeouts, in seconds there, over the defaults one by one. */
function streamTimeoutsOf(setting: { firstEventSeconds?: number; idleSeconds?: number } | undefined): StreamTimeouts {
  return {
    firstEventMs: setting?.firstEventSeconds !== undefined ? setting.firstEventSeconds * 1000 : DEFAULT_STREAM_TIMEOUTS.firstEventMs,
    idleMs: setting?.idleSeconds !== undefined ? setting.idleSeconds * 1000 : DEFAULT_STREAM_TIMEOUTS.idleMs,
  };
}

/** How to state a window no catalog or listing gave, so compaction measures against the true one (ADR-0070). */
function assumedWindowNote(id: string, window: number): string {
  return `No catalog or provider listing states ${id}'s context window: assuming ${window.toLocaleString('en-US')} tokens. `
    + `Set it in the settings file as "ordewellContextWindows": { "${id}": <tokens> }.`;
}
