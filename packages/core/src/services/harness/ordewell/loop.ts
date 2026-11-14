import type { AgentEvent } from '../AgentAdapter';
import type { UsageRecord } from '../../../models/Usage';
import { isModelError } from '../../model';
import type { EffortLevel, ModelClient, ModelMessage, ModelRequest, ModelToolCall, ModelUsage, SystemPart, ToolChoice, ToolDefinition, ToolResult as ModelToolResult } from '../../model';
import { ordewellTools, runTool, type OrdewellTool, type ToolContext, type ToolGate } from './tools';
import type { ModelInfo } from './models';
import type { TaskTools } from './taskTools';
import { Compactor, OVERFLOW_FRACTIONS } from './compaction';
import type { LoadedTranscript, TranscriptStore } from './transcript';

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
 * transcript, and where the cache breakpoints are placed (ADR-0070). Compaction
 * is not here: it rewrites the stored transcript, so what is assembled is
 * always what a resume would load.
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

/**
 * The cached prefix is the tool list, then the system prompt, then the
 * messages. The first two are the attempt's own and never change within it
 * (the system prompt is read back from the transcript, not rebuilt), so a
 * breakpoint after each, and one on the last message, make every step read the
 * previous step's prefix. A system prompt that marks no part gets its last one
 * marked: the hint is the assembler's to guarantee, not the prompt's.
 */
function withSystemBreakpoint(system: readonly SystemPart[]): SystemPart[] {
  if (system.length === 0 || system.some((part) => part.cacheBreakpoint)) return [...system];
  return system.map((part, i) => (i === system.length - 1 ? { ...part, cacheBreakpoint: true } : part));
}

export const assembleRequest: RequestAssembler = (input) => ({
  model: input.model.model,
  system: withSystemBreakpoint(input.system),
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
  /** The attempt's own tools, which its mode decides (ADR-0070); every one when absent (Full). */
  tools?: readonly OrdewellTool[];
  /** Every field of a tool's context but the signal, which is the turn's. */
  toolContext: Omit<ToolContext, 'signal'>;
  /** SEAM (a): asked before every neutral tool runs; none runs every call (Full). */
  gate?: ToolGate;
  onStepBoundary?: StepBoundaryHook;
  assemble?: RequestAssembler;
  effort?: EffortLevel;
  /** Redacts held secrets (ADR-0061) from everything emitted or written. */
  hide: <T>(value: T) => T;
  emit: (event: AgentEvent) => void;
}

/** How a turn ended. `interrupted` is a stop the user or the session asked for. */
export interface TurnOutcome {
  interrupted: boolean;
}

/** What a step left behind: the tool calls it made, if any. */
interface StepResult {
  calls: number;
  interrupted: boolean;
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
  private readonly neutral: readonly OrdewellTool[];
  private readonly compactor: Compactor;

  constructor(private readonly options: LoopOptions) {
    this.neutral = options.tools ?? ordewellTools;
    // Fixed for the attempt, in a fixed order, so the cached prefix holds.
    this.tools = [
      ...this.neutral.map((tool) => ({ name: tool.name, description: tool.description, parameters: { ...tool.parameters } })),
      ...options.taskTools.definitions.map(withoutSchemaKey),
    ];
    this.compactor = new Compactor({
      client: options.client,
      model: options.model,
      store: options.store,
      tools: this.tools,
      fallbackSystem: options.system,
      record: (entry) => this.record(entry),
      emit: (event) => this.emit(event),
    });
  }

  get toolDefinitions(): readonly ToolDefinition[] {
    return this.tools;
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

    for (let turnSteps = 0; ; turnSteps++) {
      if (signals.stop.aborted || signals.hard.aborted) return { interrupted: true };
      step += 1;
      transcript = await store.load();
      const plan = (await this.options.onStepBoundary?.({ step, turnSteps, transcript, signal: signals.hard })) ?? {};
      if (signals.stop.aborted || signals.hard.aborted) return { interrupted: true };
      if (plan.stop) return { interrupted: false };
      if (plan.inject?.length) {
        for (const text of plan.inject) await this.recordMessage(step, { role: 'user', text });
        transcript = await store.load();
      }
      // After the boundary hook and its injections, so the estimate counts what the request carries.
      transcript = await this.compactor.beforeRequest(transcript, step, signals.hard);
      const result = await this.runStepRecovering(step, transcript, plan, signals);
      if (result.interrupted) return { interrupted: true };
      if (result.calls === 0) return { interrupted: false };
    }
  }

  private assemble(transcript: LoadedTranscript, plan: StepPlan): ModelRequest {
    return (this.options.assemble ?? assembleRequest)({
      model: this.options.model,
      system: transcript.system ?? this.options.system,
      transcript,
      tools: this.tools,
      ...(plan.toolChoice ? { toolChoice: plan.toolChoice } : {}),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
    });
  }

  /**
   * One step, and when the provider refuses its request as too long, the same
   * step again from a conversation compacted to a smaller share of the window
   * (0.85, 0.7, 0.5, then 0.35) before the refusal is the step's failure. Only
   * a refusal that left nothing recorded is retried: a step that got as far as
   * a tool call has moved the conversation on.
   */
  private async runStepRecovering(step: number, transcript: LoadedTranscript, plan: StepPlan, signals: { stop: AbortSignal; hard: AbortSignal }): Promise<StepResult> {
    const fractions = [...OVERFLOW_FRACTIONS];
    let current = transcript;
    for (;;) {
      try {
        return await this.runStep(step, this.assemble(current, plan), signals);
      } catch (err) {
        if (!isModelError(err) || err.kind !== 'context-overflow' || signals.hard.aborted) throw err;
        if ((await this.options.store.load()).messages.length !== current.messages.length) throw err;
        let shrunk: LoadedTranscript | undefined;
        // A fraction that changes nothing (the conversation is already that small) falls through to the next.
        while (shrunk === undefined && fractions.length > 0) shrunk = await this.compactor.shrink(current, step, signals.hard, fractions.shift() as number);
        if (shrunk === undefined) throw err;
        current = shrunk;
      }
    }
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
          running.push(this.startCall(event.call, signals));
        } else if (event.type === 'usage') {
          usage = event.usage;
        } else if (event.type === 'provider-state') {
          providerState = event.state;
        }
      }
    } catch (err) {
      streamError = err;
    }

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
    // The usage counts the request and the assistant message recorded from its reply, and not the tool results, which the next estimate adds.
    if (usage) await this.recordUsage(step, usage, request.messages.length + (calls.length > 0 || text ? 1 : 0));
    return { calls: calls.length, interrupted: aborted || signals.stop.aborted };
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
  private async startCall(call: ModelToolCall, signals: { stop: AbortSignal; hard: AbortSignal }): Promise<ModelToolResult> {
    const settle = (output: string, isError: boolean): ModelToolResult => {
      const shown = this.options.hide(output);
      this.emit({ type: 'tool_result', id: call.id, name: call.name, output: shown, success: !isError });
      return { callId: call.id, name: call.name, output: shown, ...(isError ? { isError: true } : {}) };
    };
    if (signals.stop.aborted || signals.hard.aborted) return settle(INTERRUPTED, true);
    if (call.argumentsError) return settle(`Invalid arguments for ${call.name}: ${call.argumentsError}`, true);
    try {
      if (this.options.taskTools.has(call.name)) {
        const reply = await this.options.taskTools.call(call.name, call.arguments, signals.hard);
        return settle(reply.text, reply.isError === true);
      }
      // Only what this attempt was offered: a read-only one has no write path to name (ADR-0046).
      const tool = this.neutral.find((candidate) => candidate.name === call.name);
      if (!tool) return settle(`Unknown tool "${call.name}". The tools are: ${this.tools.map((t) => t.name).join(', ')}.`, true);
      const result = await runTool(tool, call.arguments, { ...this.options.toolContext, signal: signals.hard }, this.options.gate ? { gate: this.options.gate } : {});
      return settle(result.text, result.isError);
    } catch (err) {
      if (signals.hard.aborted) return settle(INTERRUPTED, true);
      return settle(`${call.name} failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  private async recordUsage(step: number, usage: ModelUsage, covers: number): Promise<void> {
    await this.record({ v: 1, kind: 'usage', at: now(), step, usage, covers });
    const { model } = this.options;
    const record: UsageRecord = {
      source: 'ordewell',
      model: model.id,
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.cacheReadTokens !== undefined ? { cachedInputTokens: usage.cacheReadTokens } : {}),
      // Only the provider's own figure (ADR-0070): no price table makes one up.
      ...(usage.cost ? { reportedCost: { amount: usage.cost.amount, currency: usage.cost.currency, kind: 'billed' as const } } : {}),
      // Always: compaction acts on this window, so the meter must read the same one, a default included.
      contextWindow: model.contextWindow,
      // The prompt plus the reply it produced is what the next prompt starts from.
      ...(usage.inputTokens !== undefined ? { contextTokens: usage.inputTokens + (usage.outputTokens ?? 0) } : {}),
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

/** A failed step as the event the session routes: a usage limit pauses the task, the rest fail it. */
export function stepFailure(err: unknown): Extract<AgentEvent, { type: 'error' }> {
  if (isModelError(err)) {
    return {
      type: 'error',
      message: err.message,
      ...(err.kind === 'usage-limit' ? { usageLimit: err.resetsAt !== undefined ? { resetsAt: new Date(err.resetsAt).toISOString() } : {} } : {}),
    };
  }
  return { type: 'error', message: err instanceof Error ? err.message : String(err) };
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
