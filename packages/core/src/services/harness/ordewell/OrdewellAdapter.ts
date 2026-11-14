import { randomUUID } from 'crypto';
import * as path from 'path';
import type { AgentEvent, AgentProcessDeps, AgentStartOptions, TaskModeAgentAdapter } from '../AgentAdapter';
import type { AttachState } from '../ordewellBinding';
import { SessionNotResumable } from '../ordewellBinding';
import { HeldSecrets } from '../../HeldSecrets';
import { vendorApiKeyIn, vendorBaseUrlIn, VENDORS } from '../../apiProviders';
import { createModelClient, withRetry } from '../../model';
import type { EffortLevel, ModelClient } from '../../model';
import type { ApprovalDecision } from '../../../interfaces/IApproval';
import type { AiProvider } from '../../../interfaces/IConfig';
import { attemptModeOf, GuardedShell, toolsOf } from './modes';
import { lookupModelInfo, parseModelId } from './models';
import { buildSystemPrompt } from './prompt';
import { taskToolsOf } from './taskTools';
import { FileTranscriptStore, ordewellSessionsRoot, type TranscriptStore } from './transcript';
import { OrdewellLoop, stepFailure, type RequestAssembler, type StepBoundaryHook } from './loop';
import type { GateDecision, ToolGate } from './tools';

/** The longest a cooperative stop waits for the step in flight before the stream and tools are aborted. */
const HARD_ABORT_AFTER_MS = 2_000;

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
}

interface RunningTurn {
  stop: AbortController;
  hard: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * The built-in runner (ADR-0070): a task-mode adapter whose agent is a loop
 * in this process, not a child. Nothing is spawned, so the spawn deps go
 * unused; its task tools are the attempt's token's own handlers, called
 * directly (ADR-0022 S2), so it is attached the moment it starts, and its
 * verdict still comes only from that token's `task_complete`.
 */
export class OrdewellAdapter implements TaskModeAgentAdapter {
  readonly agentId = 'ordewell';
  private loop: OrdewellLoop | null = null;
  private store: TranscriptStore | null = null;
  private turn: RunningTurn | null = null;
  private onEvent: ((event: AgentEvent) => void) | null = null;
  private onActivity: (() => void) | null = null;
  private exitListeners: ((code: number, lastWords?: string) => void)[] = [];
  private attached = false;
  private disposed = false;
  private guard: GuardedShell | null = null;
  private readonly held: HeldSecrets;

  constructor(private readonly deps: AgentProcessDeps, private readonly options: OrdewellAdapterOptions = {}) {
    // The session's own, when it passes one, so its event redaction knows the keys too (ADR-0061).
    this.held = deps.held ?? new HeldSecrets();
  }

  get exited(): boolean {
    return this.disposed;
  }

  async start(opts: AgentStartOptions): Promise<void> {
    if (opts.kind !== 'task') throw new Error('The Ordewell runner does not plan: the API planner plans on the same keys.');
    const mode = attemptModeOf(opts);
    const parsed = opts.model ? parseModelId(opts.model) : undefined;
    if (!opts.model || !parsed) {
      throw new Error(`The Ordewell runner needs a model as <provider>:<model>${opts.model ? `, not "${opts.model}"` : ''}.`);
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ...(await this.deps.workspaceEnv?.(opts.cwd)) };
    const apiKey = vendorApiKeyIn(env, parsed.provider);
    if (apiKey === '') {
      throw new Error(`No ${VENDORS[parsed.provider].label} key is set for the Ordewell runner: add one with /key.`);
    }
    // Every key in reach, not just this provider's: a tool can print any of them (ADR-0061).
    this.held.hold(apiKey);
    this.held.holdEnv(env);

    const root = this.options.sessionsRoot ?? ordewellSessionsRoot();
    const sessionId = opts.resumeSessionId ?? randomUUID();
    const store = (this.options.openStore ?? ((id, dir) => new FileTranscriptStore(id, dir)))(sessionId, root);
    if (opts.resumeSessionId && !(await store.exists())) {
      throw new SessionNotResumable(`The Ordewell runner has no saved session ${opts.resumeSessionId} to continue.`);
    }
    const saved = opts.resumeSessionId ? await store.load() : undefined;
    const system = saved?.system ?? buildSystemPrompt({ cwd: opts.cwd, commits: opts.commits === true });

    const inProcess = opts.mcp?.inProcess;
    const baseUrl = vendorBaseUrlIn(env, parsed.provider) || undefined;
    const client = withRetry((this.options.createClient ?? defaultClient(this.deps))(parsed.provider, apiKey, baseUrl));
    const model = await lookupModelInfo(opts.model, env, {
      fetchImpl: this.deps.fetch,
      ...(this.options.modelInfoTimeoutMs !== undefined ? { timeoutMs: this.options.modelInfoTimeoutMs } : {}),
    });
    const effort = EFFORTS.find((level) => level === opts.flags.effort);

    this.store = store;
    this.attached = inProcess !== undefined;
    const emit = (event: AgentEvent): void => {
      this.onActivity?.();
      this.onEvent?.(event);
    };
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
      ...(this.options.onStepBoundary ? { onStepBoundary: this.options.onStepBoundary } : {}),
      ...(this.options.assemble ? { assemble: this.options.assemble } : {}),
      ...(effort ? { effort } : {}),
      hide: (value) => this.held.hideIn(value),
      emit,
    });
  }

  async send(message: string, onEvent: (event: AgentEvent) => void, signal?: AbortSignal, onActivity?: () => void): Promise<void> {
    const loop = this.loop;
    if (!loop || this.disposed) throw new Error('The Ordewell runner is not started.');
    if (this.turn) throw new Error('The Ordewell runner is already running a turn.');
    const turn: RunningTurn = { stop: new AbortController(), hard: new AbortController() };
    // The session aborts its own signal only once it has given up on the turn: nothing more to wait for.
    const abandon = (): void => turn.hard.abort();
    if (signal?.aborted) abandon();
    signal?.addEventListener('abort', abandon, { once: true });
    this.turn = turn;
    this.onEvent = onEvent;
    this.onActivity = onActivity ?? null;
    try {
      const outcome = await loop.runTurn(message, { stop: turn.stop.signal, hard: turn.hard.signal });
      onEvent({ type: 'turn_end', ...(outcome.interrupted ? { interrupted: true } : {}) });
    } catch (err) {
      if (turn.stop.signal.aborted || turn.hard.signal.aborted) onEvent({ type: 'turn_end', interrupted: true });
      else onEvent(this.held.hideIn(stepFailure(err)));
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
    for (const listener of this.exitListeners.splice(0)) listener(0);
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

function defaultClient(deps: AgentProcessDeps): NonNullable<OrdewellAdapterOptions['createClient']> {
  return (provider, apiKey, baseUrl) => createModelClient({ provider, apiKey, ...(baseUrl ? { baseUrl } : {}), fetch: deps.fetch });
}
