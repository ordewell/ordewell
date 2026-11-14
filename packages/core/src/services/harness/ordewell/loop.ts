import type { AgentEvent } from '../AgentAdapter';
import type { UsageRecord } from '../../../models/Usage';
import { isModelError, type ModelError } from '../../model';
import type { EffortLevel, ModelClient, ModelMessage, ModelRequest, ModelToolCall, ModelUsage, SystemPart, ToolChoice, ToolDefinition, ToolResult as ModelToolResult } from '../../model';
import { findTool, ordewellTools, runTool, type ToolContext, type ToolGate } from './tools';
import type { ModelInfo } from './models';
import type { TaskTools } from './taskTools';
import type { LoadedTranscript, TranscriptStore } from './transcript';
import { REPEAT_FAIL_AT, REPEAT_NUDGE_AT, RepeatGuard, repeatFailure, repeatNudge } from './repeatGuard';

/**
 * SEAM (b), the step boundary: called before every step's request, with the
 * conversation as the store holds it. The lifecycle task hangs message
 * delivery (`inject`), the step limit (`toolChoice: { name: 'task_complete' }`
 * on the last step, or `stop`) and a usage-limit pause (awaiting the reset
 * here) on it. Returning nothing runs the step as assembled.
 */
export type StepBoundaryHook = (boundary: StepBoundary) => StepPlan | void | Promise<StepPlan | void>;

export interface StepBoundary {
  /** The step about to run, from 1 across the whole session, resumes included. */
  step: number;
  /** Steps run in this turn before this one. */
  turnSteps: number;
  transcript: Readonly<LoadedTranscript>;
  signal: AbortSignal;
}

export interface StepPlan {
  /** User messages to append, and record, before the step's request. */
  inject?: readonly string[];
  /** Overrides the step's tool choice; the tool list itself never changes in an attempt. */
  toolChoice?: ToolChoice;
  /** End the turn here without a request, as a turn the model ended. */
  stop?: boolean;
}

/**
 * SEAM (c), request assembly: the one place a step's request is built from the
 * transcript. The compaction task folds old messages here (or in the store's
 * `load`), and the caching task places its breakpoints here.
 */
export type RequestAssembler = (input: AssemblyInput) => ModelRequest;

export interface AssemblyInput {
  model: ModelInfo;
  system: readonly SystemPart[];
  transcript: Readonly<LoadedTranscript>;
  tools: readonly ToolDefinition[];
  toolChoice?: ToolChoice;
  effort?: EffortLevel;
}

export const assembleRequest: RequestAssembler = (input) => ({
  model: input.model.model,
  system: [...input.system],
  messages: [...input.transcript.messages],
  tools: [...input.tools],
  ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
  ...(input.effort ? { effort: input.effort } : {}),
  maxOutputTokens: input.model.maxOutputTokens,
  cache: { afterTools: true, atLastMessage: true },
});

export interface LoopOptions {
  client: ModelClient;
  model: ModelInfo;
  system: readonly SystemPart[];
  store: TranscriptStore;
  taskTools: TaskTools;
  /** Every field of a tool's context but the signal, which is the turn's. */
  toolContext: Omit<ToolContext, 'signal'>;
  /** SEAM (a): asked before every neutral tool runs; none runs every call (Full). */
  gate?: ToolGate;
  onStepBoundary?: StepBoundaryHook;
  assemble?: RequestAssembler;
  effort?: EffortLevel;
  /**
   * Model calls the attempt may make. The last is forced to `task_complete`,
   * so the attempt ends on a report rather than mid-edit; none is no limit.
   */
  stepLimit?: number;
  /** Redacts held secrets (ADR-0061) from everything emitted or written. */
  hide: <T>(value: T) => T;
  emit: (event: AgentEvent) => void;
}

/** How a turn ended. `interrupted` is a stop the user or the session asked for. */
export interface TurnOutcome {
  interrupted: boolean;
}

/** What a step left behind: the tool calls it made, if any, and a repeat that ends the attempt. */
interface StepResult {
  calls: number;
  interrupted: boolean;
  repeated?: string;
}

const INTERRUPTED = 'Interrupted: the call was stopped before it finished.';

/**
 * The runner's agent loop (ADR-0070). A turn is steps until one ends with no
 * tool call. Every step is one stream call whose request is rebuilt from the
 * transcript store, so what the model sees is always what is on disk; a tool
 * call starts the moment the stream completes it, calls run side by side, and
 * their results are recorded in call order.
 *
 * Stopping is in two stages: `stop` (the cooperative one) lets the step in
 * flight finish but starts no new step or tool, and `hard` aborts the stream
 * and every running tool. The adapter fires `hard` a short grace after `stop`.
 */
export class OrdewellLoop {
  private readonly tools: readonly ToolDefinition[];
  private readonly repeats = new RepeatGuard();
  /** Requests sent in this attempt, every turn's: what the step limit counts. */
  private modelCalls = 0;
  /** Whether a report stands, a `task_complete` its handler accepted since the last message in. */
  private reported = false;
  private streaming: Promise<void> = Promise.resolve();
  private stops = 0;

  constructor(private readonly options: LoopOptions) {
    // Fixed for the attempt, in a fixed order, so the cached prefix holds.
    this.tools = [
      ...ordewellTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: { ...tool.parameters } })),
      ...options.taskTools.definitions.map(withoutSchemaKey),
    ];
  }

  get toolDefinitions(): readonly ToolDefinition[] {
    return this.tools;
  }

  /**
   * Settles once no model request is streaming: the one in flight ends by
   * itself, its usage recorded, or at once when there is none. Stop waits on
   * it, within its grace, so the step a report was made in is billed in full.
   */
  streamEnded(): Promise<void> {
    return this.streaming;
  }

  async runTurn(userText: string, signals: { stop: AbortSignal; hard: AbortSignal }): Promise<TurnOutcome> {
    const { store } = this.options;
    let transcript = await store.load();
    if (transcript.system === undefined) {
      await this.record({ v: 1, kind: 'session', at: now(), model: this.options.model.id, system: [...this.options.system] });
    }
    let step = transcript.steps;
    const last = transcript.messages.at(-1);
    if (last?.role === 'assistant' && last.toolCalls?.length) {
      // A step cut off between its calls and their results (the process
      // ended): a provider refuses a call with no result, so each gets one.
      const results = last.toolCalls.map((call) => ({ callId: call.id, name: call.name, output: INTERRUPTED, isError: true }));
      await this.recordMessage(step, { role: 'tool', results });
    }
    await this.recordMessage(step + 1, { role: 'user', text: userText });
    // A message in voids a report made before it (ADR-0023 D6).
    this.reported = false;

    for (let turnSteps = 0; ; turnSteps++) {
      if (signals.stop.aborted || signals.hard.aborted) return { interrupted: true };
      step += 1;
      // Past the limit no hook runs, so a message waiting for this boundary is
      // dropped rather than delivered to a model that can no longer answer it.
      if (this.limitReached()) return this.endAtLimit(step, signals);
      transcript = await store.load();
      const plan = (await this.options.onStepBoundary?.({ step, turnSteps, transcript, signal: signals.hard })) ?? {};
      if (signals.stop.aborted || signals.hard.aborted) return { interrupted: true };
      if (plan.stop) return { interrupted: false };
      if (plan.inject?.length) {
        this.reported = false;
        for (const text of plan.inject) await this.recordMessage(step, { role: 'user', text });
      }
      let toolChoice = plan.toolChoice;
      if (this.isLastCall() && this.options.taskTools.has('task_complete')) {
        // Every tool stays offered, so the cached prefix holds; only the choice narrows.
        toolChoice = { name: 'task_complete' };
        await this.recordMessage(step, { role: 'user', text: lastCallInstruction(this.limit()) });
      }
      if (plan.inject?.length || toolChoice !== plan.toolChoice) transcript = await store.load();
      const request = (this.options.assemble ?? assembleRequest)({
        model: this.options.model,
        system: transcript.system ?? this.options.system,
        transcript,
        tools: this.tools,
        ...(toolChoice ? { toolChoice } : {}),
        ...(this.options.effort ? { effort: this.options.effort } : {}),
      });
      this.modelCalls += 1;
      const result = await this.runStep(step, request, signals);
      if (result.interrupted) return { interrupted: true };
      if (result.repeated !== undefined) {
        if (!this.reported) await this.endAttempt(step, result.repeated, signals);
        return { interrupted: false };
      }
      if (result.calls === 0) return this.limitReached() ? this.endAtLimit(step, signals) : { interrupted: false };
    }
  }

  private limit(): number {
    return this.options.stepLimit ?? Number.POSITIVE_INFINITY;
  }

  private limitReached(): boolean {
    return this.modelCalls >= this.limit();
  }

  private isLastCall(): boolean {
    return this.modelCalls === this.limit() - 1;
  }

  /** The limit is spent: a report stands, or the runner makes the failed one itself. */
  private async endAtLimit(step: number, signals: { hard: AbortSignal }): Promise<TurnOutcome> {
    if (!this.reported) {
      const limit = this.limit();
      await this.endAttempt(step, `The Ordewell runner reached its step limit of ${limit} model call${limit === 1 ? '' : 's'} without a report through task_complete.`, signals);
    }
    return { interrupted: false };
  }

  /**
   * Ends the attempt as failed with the reason, through the attempt's own
   * `task_complete`: the verdict then carries why, where an exit without a
   * report would only say that none was made. The call is the runner's, not
   * the model's, so it goes to the log and never into the transcript.
   */
  private async endAttempt(step: number, reason: string, signals: { hard: AbortSignal }): Promise<void> {
    if (!this.options.taskTools.has('task_complete')) throw new Error(reason);
    const id = `ordewell-stop-${step}-${++this.stops}`;
    const args = { status: 'failed', summary: reason, reason };
    this.emit({ type: 'tool_call', id, name: 'task_complete', args });
    const reply = await this.options.taskTools.call('task_complete', args, signals.hard);
    this.emit({ type: 'tool_result', id, name: 'task_complete', output: reply.text, success: reply.isError !== true });
    if (reply.isError === true) throw new Error(`${reason} Its report was refused: ${reply.text}`);
    this.reported = true;
  }

  private async runStep(step: number, request: ModelRequest, signals: { stop: AbortSignal; hard: AbortSignal }): Promise<StepResult> {
    const runId = `step-${step}`;
    let text = '';
    let thinking = '';
    let usage: ModelUsage | undefined;
    let providerState: Extract<ModelMessage, { role: 'assistant' }>['providerState'];
    const calls: ModelToolCall[] = [];
    const running: Promise<ModelToolResult>[] = [];
    let streamError: unknown;
    let repeated: string | undefined;
    let streamed!: () => void;
    this.streaming = new Promise((resolve) => {
      streamed = resolve;
    });

    try {
      for await (const event of this.options.client.stream(request, signals.hard)) {
        if (event.type === 'text-delta') {
          text += event.text;
          this.emit({ type: 'assistant_text_delta', runId, text: event.text });
        } else if (event.type === 'thinking-delta') {
          thinking += event.text;
          this.emit({ type: 'thinking_delta', text: event.text });
        } else if (event.type === 'tool-call-complete') {
          calls.push(event.call);
          this.emit({ type: 'tool_call', id: event.call.id, name: event.call.name, args: event.call.arguments });
          const times = this.repeats.see(event.call);
          if (repeated !== undefined || times >= REPEAT_FAIL_AT) {
            repeated ??= repeatFailure(event.call);
            running.push(Promise.resolve(this.settle(event.call, `Not run: ${repeated}`, true)));
          } else {
            running.push(this.startCall(event.call, signals, times === REPEAT_NUDGE_AT ? repeatNudge(event.call) : ''));
          }
        } else if (event.type === 'usage') {
          usage = event.usage;
        } else if (event.type === 'provider-state') {
          providerState = event.state;
        }
      }
    } catch (err) {
      streamError = err;
    }
    // Recorded before the calls are waited on, so a stop that ends them still keeps the step's bill.
    if (usage) await this.recordUsage(step, usage);
    streamed();

    if (thinking) this.emit({ type: 'thinking', text: thinking });
    if (text) this.emit({ type: 'assistant_text', runId, text });

    const aborted = signals.hard.aborted;
    if (streamError !== undefined && !aborted) {
      // Nothing of a failed step is recorded but the calls already running,
      // whose results the transcript needs to stay a valid conversation.
      if (calls.length > 0) await this.recordStep(step, text, calls, providerState, running);
      throw streamError;
    }
    if (calls.length === 0) {
      if (text) await this.recordMessage(step, { role: 'assistant', text, ...(providerState ? { providerState } : {}) });
    } else {
      await this.recordStep(step, text, calls, providerState, running);
    }
    return { calls: calls.length, interrupted: aborted || signals.stop.aborted, ...(repeated !== undefined ? { repeated } : {}) };
  }

  private async recordStep(
    step: number,
    text: string,
    calls: ModelToolCall[],
    providerState: Extract<ModelMessage, { role: 'assistant' }>['providerState'],
    running: Promise<ModelToolResult>[],
  ): Promise<void> {
    await this.recordMessage(step, { role: 'assistant', text, toolCalls: calls, ...(providerState ? { providerState } : {}) });
    const results = await Promise.all(running);
    await this.recordMessage(step, { role: 'tool', results });
  }

  /** Starts one call now; settles to its result, never rejects. */
  private async startCall(call: ModelToolCall, signals: { stop: AbortSignal; hard: AbortSignal }, nudge: string): Promise<ModelToolResult> {
    const settle = (output: string, isError: boolean): ModelToolResult => this.settle(call, output + nudge, isError);
    if (signals.stop.aborted || signals.hard.aborted) return settle(INTERRUPTED, true);
    if (call.argumentsError) return settle(`Invalid arguments for ${call.name}: ${call.argumentsError}`, true);
    try {
      if (this.options.taskTools.has(call.name)) {
        const reply = await this.options.taskTools.call(call.name, call.arguments, signals.hard);
        if (call.name === 'task_complete' && reply.isError !== true) this.reported = true;
        return settle(reply.text, reply.isError === true);
      }
      const tool = findTool(call.name);
      if (!tool) return settle(`Unknown tool "${call.name}". The tools are: ${this.tools.map((t) => t.name).join(', ')}.`, true);
      const result = await runTool(tool, call.arguments, { ...this.options.toolContext, signal: signals.hard }, this.options.gate ? { gate: this.options.gate } : {});
      return settle(result.text, result.isError);
    } catch (err) {
      if (signals.hard.aborted) return settle(INTERRUPTED, true);
      return settle(`${call.name} failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  private settle(call: ModelToolCall, output: string, isError: boolean): ModelToolResult {
    const shown = this.options.hide(output);
    this.emit({ type: 'tool_result', id: call.id, name: call.name, output: shown, success: !isError });
    return { callId: call.id, name: call.name, output: shown, ...(isError ? { isError: true } : {}) };
  }

  private async recordUsage(step: number, usage: ModelUsage): Promise<void> {
    await this.record({ v: 1, kind: 'usage', at: now(), step, usage });
    const { model } = this.options;
    const record: UsageRecord = {
      source: 'ordewell',
      model: model.id,
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.cacheReadTokens !== undefined ? { cachedInputTokens: usage.cacheReadTokens } : {}),
      // Only the provider's own figure (ADR-0070): no price table makes one up.
      ...(usage.cost ? { reportedCost: { amount: usage.cost.amount, currency: usage.cost.currency, kind: 'billed' as const } } : {}),
      ...(model.known.contextWindow ? { contextWindow: model.contextWindow } : {}),
    };
    this.emit({ type: 'usage', record });
  }

  private recordMessage(step: number, message: ModelMessage): Promise<void> {
    return this.record({ v: 1, kind: 'message', at: now(), step, message });
  }

  private record(entry: Parameters<TranscriptStore['append']>[0]): Promise<void> {
    // A key a tool printed, or the model echoed, never reaches the disk (ADR-0061).
    return this.options.store.append(this.options.hide(entry));
  }

  private emit(event: AgentEvent): void {
    this.options.emit(this.options.hide(event));
  }
}

function lastCallInstruction(limit: number): string {
  return `[Ordewell] This is your last model call: the attempt has reached its step limit of ${limit} model calls. Call task_complete now and report what is done and what is not, so the next attempt can continue from there.`;
}

/**
 * A failed step as the event the session routes. A usage limit pauses the task
 * until its reset (ADR-0018 U1). Every other failure says in its field that it
 * was not the limit, so no word of a provider's message ("quota exceeded per
 * minute") reads as one, and its words are put the way E1's reader
 * (runnerExit.classifyRunnerStop) takes them: a provider still failing or
 * throttling after the client's own retries is a turn a later try may pass,
 * and anything else (a bad key, a bad request) fails the same way every time.
 */
export function stepFailure(err: unknown): Extract<AgentEvent, { type: 'error' }> {
  if (!isModelError(err)) return { type: 'error', message: err instanceof Error ? err.message : String(err) };
  if (err.kind === 'usage-limit') {
    return { type: 'error', message: err.message, usageLimit: err.resetsAt !== undefined ? { resetsAt: new Date(err.resetsAt).toISOString() } : {} };
  }
  return { type: 'error', message: failureWords(err), usageLimit: false };
}

function failureWords(err: ModelError): string {
  const status = err.status !== undefined ? `HTTP ${err.status}` : undefined;
  switch (err.kind) {
    case 'transient':
      return `The provider is failing (${status ?? (err.network ? 'unreachable' : 'stream error')}, service unavailable) after retries: ${err.message}`;
    case 'rate-limited':
      return `The provider is rate limiting requests (${status ?? 'HTTP 429'}) after retries: ${err.message}`;
    case 'auth':
      return `The provider refused the key${status ? ` (${status})` : ''}: ${err.message}. Check it, or replace it with /key.`;
    default:
      return status ? `${err.message} (${status})` : err.message;
  }
}

/** A zod-made schema's `$schema` key, which some providers refuse in a tool definition. */
function withoutSchemaKey(definition: ToolDefinition): ToolDefinition {
  const parameters = { ...definition.parameters };
  delete parameters.$schema;
  return { ...definition, parameters };
}

function now(): string {
  return new Date().toISOString();
}
