import type { AgentEvent } from '../AgentAdapter';
import type { UsageRecord } from '../../../models/Usage';
import { DEFAULT_RETRY_POLICY, isModelError, retryDelay, type ModelError, type RetryPolicy } from '../../model';
import type { EffortLevel, ModelClient, ModelMessage, ModelRequest, ModelToolCall, ModelUsage, SystemPart, ToolChoice, ToolDefinition, ToolResult as ModelToolResult } from '../../model';
import { ordewellTools, runTool, type OrdewellTool, type ToolContext, type ToolGate } from './tools';
import type { ModelInfo } from './models';
import type { TaskTools } from './taskTools';
import { Compactor, fillOfWindow, OVERFLOW_FRACTIONS } from './compaction';
import type { LoadedTranscript, TranscriptStore } from './transcript';
import { REPEAT_FAIL_AT, REPEAT_NUDGE_AT, RepeatGuard, repeatFailure, repeatNudge } from './repeatGuard';
import { writtenToolCall } from './textCall';

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
  /**
   * Model calls the attempt may make. The last is forced to `task_complete`,
   * so the attempt ends on a report rather than mid-edit; none is no limit.
   */
  stepLimit?: number;
  /** Where compaction starts, from a `taskCompactAt` number held within bounds; the capacity guard alone when absent. */
  compactAt?: number;
  /**
   * The policy a step whose stream failed part way is sent again under; the
   * client's `withRetry` should share it, as it retries the failures before any
   * event. `random` is the jitter's, for a test to fix.
   */
  retry?: { policy?: Partial<RetryPolicy>; random?: () => number };
  /** Redacts held secrets (ADR-0061) from everything emitted or written. */
  hide: <T>(value: T) => T;
  emit: (event: AgentEvent) => void;
}

/**
 * How a turn ended. `interrupted` is a stop the user or the session asked for;
 * `failed` is why the runner ended the attempt itself where the turn has no
 * finished reply to end on, so it is never recorded as a completed one (ADR-0070).
 */
export interface TurnOutcome {
  interrupted: boolean;
  failed?: string;
}

/**
 * What a step left behind: the tool calls it made, if any, a repeat that ends
 * the attempt, and the output limit its reply was cut off at, when it was.
 */
interface StepResult {
  calls: number;
  interrupted: boolean;
  repeated?: string;
  cutOffAt?: number;
  /** The tool a reply with no call wrote out as text instead of calling. */
  writtenCall?: string;
}

/** A step whose stream failed: what it left behind, and whether any event had reached the loop. */
interface FailedStep extends StepResult {
  error: unknown;
  streamed: boolean;
}

const INTERRUPTED = 'Interrupted: the call was stopped before it finished.';

/** Replies in a row cut off at the output limit with no tool call before the runner ends the attempt (ADR-0070). */
export const CUT_OFF_FAIL_AT = 3;

function cutOffNote(limit: number): string {
  return `[Ordewell] Your last reply was cut off at the output limit of ${limit} tokens before it made a tool call. Go on with the task: act through tool calls, and keep your text and thinking short.`;
}

function cutOffLog(limit: number, calls: number, inARow: number): string {
  return calls > 0
    ? `[Ordewell] The model's reply stopped at the output limit of ${limit} tokens; its ${calls} complete tool call${calls === 1 ? ' runs' : 's run'} and the turn goes on.`
    : `[Ordewell] The model's reply stopped at the output limit of ${limit} tokens with no tool call (cut-off ${inARow} of ${CUT_OFF_FAIL_AT} in a row); the turn goes on.`;
}

function writtenCallNote(name: string): string {
  return `[Ordewell] Your last reply wrote a tool call (${name}) as text, so it was not made. Make the call through the tool-calling interface, not in your reply text, and go on with the task.`;
}

function writtenCallLog(name: string, inARow: number): string {
  return `[Ordewell] The model's reply wrote a ${name} call as text instead of making it (${inARow} of ${CUT_OFF_FAIL_AT} in a row); the turn goes on.`;
}

function writtenCallFailure(name: string): string {
  return `The model wrote its ${name} call as text in its reply ${CUT_OFF_FAIL_AT} times in a row instead of making it through the tool-calling interface, so the built-in runner ended the attempt.`;
}

function cutOffFailure(limit: number): string {
  return `The model's reply was cut off at the output limit of ${limit} tokens ${CUT_OFF_FAIL_AT} times in a row without a tool call, so the built-in runner ended the attempt.`;
}

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
  /** The budget notices this attempt has spent, each at most once (ADR-0070). */
  private readonly noticed = new Set<number>();
  /** Whether a report giving up on a budget not yet near its end has been answered: once an attempt, so nothing loops. */
  private budgetAnswered = false;
  /** The same, once an attempt, for a report giving up on a context with room left. */
  private contextAnswered = false;
  /** Steps in a row whose stream failed part way, and when the first of them failed: the retry policy's attempt and window. */
  private cutStreams = { count: 0, since: 0 };
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
      ...(options.compactAt !== undefined ? { startAt: options.compactAt } : {}),
    });
  }

  /** Where a set start now has compaction begin, after any overflow shrank the window (ADR-0018 C4). */
  get compactStartTokens(): number | undefined {
    return this.compactor.startTokens;
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

    // A reply cut off at the output limit is not a finished one: the turn goes on, within the step limit, until CUT_OFF_FAIL_AT in a row.
    let cutOffs = 0;
    // A reply that writes a call out as text is no finished one either, and is bounded the same way.
    let writtenCalls = 0;
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
      const notice = this.budgetNotice(transcript);
      if (this.isLastCall() && this.options.taskTools.has('task_complete')) {
        // Every tool stays offered, so the cached prefix holds; only the choice narrows.
        toolChoice = { name: 'task_complete' };
        await this.recordMessage(step, { role: 'user', text: lastCallInstruction(this.limit()) });
      } else if (notice) {
        // Appended, never written into the system prompt, so the cached prefix holds.
        await this.recordMessage(step, { role: 'user', text: notice });
      }
      if (plan.inject?.length || toolChoice !== plan.toolChoice || notice) transcript = await store.load();
      // After the boundary hook, its injections, the last-call words and a notice, so the estimate counts what the request carries.
      transcript = await this.compactor.beforeRequest(transcript, step, signals.hard);
      // One step is one call against the limit, however many overflow retries it takes.
      this.modelCalls += 1;
      const result = await this.runStepRecovering(step, transcript, { ...plan, ...(toolChoice ? { toolChoice } : {}) }, signals);
      if (result.interrupted) return { interrupted: true };
      if (result.repeated !== undefined) {
        if (!this.reported) await this.endAttempt(step, result.repeated, signals);
        return { interrupted: false };
      }
      if (result.cutOffAt !== undefined) {
        const limit = result.cutOffAt;
        if (result.calls > 0) {
          cutOffs = 0;
          writtenCalls = 0;
          this.emit({ type: 'command_output', text: cutOffLog(limit, result.calls, 0) });
          continue;
        }
        // The work is reported: the turn ends here, as a finished reply would end it, with no call billed to go on.
        if (this.reported) return { interrupted: false };
        cutOffs += 1;
        if (cutOffs >= CUT_OFF_FAIL_AT) {
          const reason = cutOffFailure(limit);
          await this.endAttempt(step, reason, signals);
          return { interrupted: false, failed: reason };
        }
        this.emit({ type: 'command_output', text: cutOffLog(limit, 0, cutOffs) });
        if (this.limitReached()) return this.endAtLimit(step, signals);
        await this.recordMessage(step, { role: 'user', text: cutOffNote(limit) });
        continue;
      }
      cutOffs = 0;
      if (result.writtenCall !== undefined && !this.reported) {
        writtenCalls += 1;
        if (writtenCalls >= CUT_OFF_FAIL_AT) {
          const reason = writtenCallFailure(result.writtenCall);
          await this.endAttempt(step, reason, signals);
          return { interrupted: false, failed: reason };
        }
        this.emit({ type: 'command_output', text: writtenCallLog(result.writtenCall, writtenCalls) });
        if (this.limitReached()) return this.endAtLimit(step, signals);
        await this.recordMessage(step, { role: 'user', text: writtenCallNote(result.writtenCall) });
        continue;
      }
      writtenCalls = 0;
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

  /**
   * The note due at this boundary, if any: once at about 80% of the step
   * budget and once at about 95%, so the model brings its work to a committed,
   * reportable state before the forced last call (ADR-0070). Each is spent once
   * sent; none goes out while a report stands, or on the last call, whose own
   * instruction says more. Two falling due together send only the later.
   *
   * Between them the exact count goes out every COUNT_EVERY calls, and each
   * notice carries it too: a model left to keep its own tally overestimated it
   * and reported failed with most of its budget unspent.
   */
  private budgetNotice(transcript: LoadedTranscript): string | undefined {
    const limit = this.limit();
    if (this.reported || !Number.isFinite(limit) || this.modelCalls >= limit - 1 || !this.options.taskTools.has('task_complete')) return undefined;
    const due = BUDGET_NOTICES.filter((share) => !this.noticed.has(share) && this.modelCalls >= noticeAt(share, limit));
    for (const share of due) this.noticed.add(share);
    const latest = due.at(-1);
    const count = countLine(this.modelCalls, limit, this.compactor.fillText(transcript));
    if (latest === undefined) return this.modelCalls > 0 && this.modelCalls % COUNT_EVERY === 0 ? count : undefined;
    const notice = latest === BUDGET_NOTICES[0] ? midBudgetNotice(this.modelCalls, limit) : endBudgetNotice(limit - this.modelCalls, limit);
    return `${notice}\n${count}`;
  }

  /**
   * The runner's answer to a report that gives the budget as why it stops
   * while less of it is used than the first notice marks: the model's own
   * tally, not the count, ended such attempts with most calls unspent. It is
   * answered once an attempt with the count and not recorded; a second is
   * recorded as it is, since only the model knows what else may stop it.
   */
  private answerEarlyGiveUp(args: unknown): string | undefined {
    const limit = this.limit();
    if (this.budgetAnswered || !Number.isFinite(limit) || this.modelCalls >= noticeAt(BUDGET_NOTICES[0], limit) || !citesBudget(args)) return undefined;
    this.budgetAnswered = true;
    return earlyGiveUpAnswer(this.modelCalls, limit);
  }

  /**
   * The runner's answer to a report that gives its own context as exhausted
   * while the fill is under where compaction starts (or, with no point set,
   * under CONTEXT_ROOM_SHARE of the window): a model that read "context is
   * compacted as it fills" as a warning ended an attempt at 36% of its window.
   * Once an attempt, with the real figures; a second is recorded as it is.
   */
  private async answerContextGiveUp(args: unknown): Promise<string | undefined> {
    if (this.contextAnswered || !citesContext(args)) return undefined;
    const transcript = await this.options.store.load();
    const fill = this.compactor.fillTokens(transcript);
    const window = this.compactor.contextWindow;
    if (fill >= (this.compactor.startTokens ?? Math.floor(window * CONTEXT_ROOM_SHARE))) return undefined;
    this.contextAnswered = true;
    return contextGiveUpAnswer(fillOfWindow(fill, window), countLine(this.modelCalls, this.limit(), this.compactor.fillText(transcript)));
  }

  /** The limit is spent: a report stands, or the runner makes the failed one itself. */
  private async endAtLimit(step: number, signals: { hard: AbortSignal }): Promise<TurnOutcome> {
    if (!this.reported) {
      const limit = this.limit();
      await this.endAttempt(step, `The built-in runner reached its step limit of ${limit} model call${limit === 1 ? '' : 's'} without a report through task_complete.`, signals);
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

  private assemble(transcript: LoadedTranscript, plan: StepPlan): ModelRequest {
    return (this.options.assemble ?? assembleRequest)({
      // The model's own output limit, held to the room its window leaves a reply (ADR-0070).
      model: { ...this.options.model, maxOutputTokens: this.compactor.replyTokens },
      system: transcript.system ?? this.options.system,
      transcript,
      tools: this.tools,
      ...(plan.toolChoice ? { toolChoice: plan.toolChoice } : {}),
      ...(this.options.effort ? { effort: this.options.effort } : {}),
    });
  }

  /**
   * One step, and two ways it is tried again.
   *
   * When the provider refuses its request as too long, the same step runs again
   * from a conversation compacted to a smaller share of the window (0.85, 0.7,
   * 0.5, then 0.35) before the refusal is the step's failure. Only a refusal
   * that left nothing recorded is retried: a step that got as far as a tool
   * call has moved the conversation on.
   *
   * When its stream fails part way (a stall the client's timeouts cut, a
   * dropped connection) with a failure the retry policy retries, the step is
   * not lost (ADR-0070). If no tool call ran, the partial reply is dropped and
   * the same request is sent again. If one did, nothing runs twice: the calls
   * and their results are already recorded, and the turn goes on to its next
   * step from them. A failure before any event is the client's `withRetry`'s,
   * which has already retried it, so it ends the step here.
   */
  private async runStepRecovering(step: number, transcript: LoadedTranscript, plan: StepPlan, signals: { stop: AbortSignal; hard: AbortSignal }): Promise<StepResult> {
    const fractions = [...OVERFLOW_FRACTIONS];
    let current = transcript;
    for (let resends = 0; ; ) {
      const runId = resends === 0 ? `step-${step}` : `step-${step}.${resends + 1}`;
      const result = await this.runStep(step, runId, this.assemble(current, plan), signals);
      if (!('error' in result)) {
        this.cutStreams = { count: 0, since: 0 };
        return result;
      }
      const err = result.error;
      if (isModelError(err) && err.kind === 'context-overflow' && !signals.hard.aborted) {
        if ((await this.options.store.load()).messages.length !== current.messages.length) throw err;
        let shrunk: LoadedTranscript | undefined;
        // A fraction that changes nothing (the conversation is already that small) falls through to the next.
        while (shrunk === undefined && fractions.length > 0) shrunk = await this.compactor.shrink(current, step, signals.hard, fractions.shift() as number);
        if (shrunk === undefined) throw err;
        current = shrunk;
        continue;
      }
      const delayMs = result.streamed ? this.cutStreamDelay(err) : undefined;
      if (delayMs === undefined) throw err;
      const { calls, repeated } = result;
      this.emit({ type: 'command_output', text: retryNote((err as ModelError).message, delayMs, this.cutStreams.count, calls) });
      try {
        await sleep(delayMs, signals.hard);
      } catch {
        return { calls, interrupted: true };
      }
      if (calls > 0 || signals.stop.aborted) return { calls, interrupted: signals.stop.aborted, ...(repeated !== undefined ? { repeated } : {}) };
      resends += 1;
    }
  }

  /** The gap before a cut step goes on, or `undefined` once the policy gives up on it. */
  private cutStreamDelay(err: unknown): number | undefined {
    if (!isModelError(err)) return undefined;
    if (this.cutStreams.count === 0) this.cutStreams.since = Date.now();
    this.cutStreams.count += 1;
    const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...this.options.retry?.policy };
    return retryDelay(err, this.cutStreams.count, Date.now() - this.cutStreams.since, policy, this.options.retry?.random);
  }

  private async runStep(step: number, runId: string, request: ModelRequest, signals: { stop: AbortSignal; hard: AbortSignal }): Promise<StepResult | FailedStep> {
    let text = '';
    let thinking = '';
    let usage: ModelUsage | undefined;
    let providerState: Extract<ModelMessage, { role: 'assistant' }>['providerState'];
    const calls: ModelToolCall[] = [];
    const running: Promise<ModelToolResult>[] = [];
    let streamError: unknown;
    let streamedAny = false;
    let repeated: string | undefined;
    let cutOff = false;
    let streamed!: () => void;
    this.streaming = new Promise((resolve) => {
      streamed = resolve;
    });

    try {
      for await (const event of this.options.client.stream(request, signals.hard)) {
        streamedAny = true;
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
        } else if (event.type === 'finish') {
          cutOff = event.reason === 'length';
        }
      }
    } catch (err) {
      streamError = err;
    }
    const aborted = signals.hard.aborted;
    // Recorded before the calls are waited on, so a stop that ends them still keeps the step's bill. It
    // covers the request and the assistant message recorded from its reply below, and not the tool
    // results, which the next estimate adds; a failed step with no call records no reply.
    const replied = calls.length > 0 || (text !== '' && (streamError === undefined || aborted));
    if (usage) await this.recordUsage(step, usage, request.messages.length + (replied ? 1 : 0));
    streamed();

    if (thinking) this.emit({ type: 'thinking', text: thinking });
    if (text) this.emit({ type: 'assistant_text', runId, text });

    if (streamError !== undefined && !aborted) {
      // Nothing of a failed step is recorded but the calls already running,
      // whose results the transcript needs to stay a valid conversation.
      if (calls.length > 0) await this.recordStep(step, text, calls, providerState, running);
      return { calls: calls.length, interrupted: false, error: streamError, streamed: streamedAny, ...(repeated !== undefined ? { repeated } : {}) };
    }
    if (calls.length === 0) {
      if (text) await this.recordMessage(step, { role: 'assistant', text, ...(providerState ? { providerState } : {}) });
    } else {
      await this.recordStep(step, text, calls, providerState, running);
    }
    // Only a reply that ended on its own and made no call: never the text of an interrupted or cut-off one.
    const writtenCall = calls.length === 0 && !cutOff && !aborted && !signals.stop.aborted ? writtenToolCall(text, new Set(request.tools.map((tool) => tool.name))) : undefined;
    return {
      calls: calls.length,
      interrupted: aborted || signals.stop.aborted,
      ...(writtenCall !== undefined ? { writtenCall } : {}),
      ...(repeated !== undefined ? { repeated } : {}),
      ...(cutOff ? { cutOffAt: request.maxOutputTokens ?? this.compactor.replyTokens } : {}),
    };
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
        const answer = call.name === 'task_complete' ? this.answerEarlyGiveUp(call.arguments) ?? await this.answerContextGiveUp(call.arguments) : undefined;
        if (answer !== undefined) return settle(answer, true);
        const reply = await this.options.taskTools.call(call.name, call.arguments, signals.hard);
        if (call.name === 'task_complete' && reply.isError !== true) this.reported = true;
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

  private settle(call: ModelToolCall, output: string, isError: boolean): ModelToolResult {
    const shown = this.options.hide(output);
    this.emit({ type: 'tool_result', id: call.id, name: call.name, output: shown, success: !isError });
    return { callId: call.id, name: call.name, output: shown, ...(isError ? { isError: true } : {}) };
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
      ...(usage.provider ? { provider: usage.provider } : {}),
      ...(usage.generationId ? { generationId: usage.generationId } : {}),
      // Always: compaction acts on this window, so the meter must read the same one, an assumed one or one an overflow shrank included.
      contextWindow: this.compactor.contextWindow,
      ...(this.compactor.windowAssumed ? { contextWindowAssumed: true } : {}),
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

/**
 * The task log's line for a model request the runner sends again: the client's
 * `withRetry` before any event, the loop after some. `kept` is the tool calls
 * of a cut step that already ran, whose results the next step reads instead.
 */
export function retryNote(reason: string, delayMs: number, retry: number, kept = 0): string {
  const wait = `${(delayMs / 1000).toFixed(1)} s`;
  const next = kept > 0
    ? `Its ${kept} finished tool call${kept === 1 ? '' : 's'} and their results are kept, and the next step goes on from them in ${wait}`
    : `The step is sent again in ${wait}`;
  return `[Ordewell] The model request failed: ${reason} ${next} (retry ${retry}).`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = (): void => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The shares of the step budget used at which the model is told so, in order. */
const BUDGET_NOTICES = [0.8, 0.95] as const;

/** Model calls between two exact counts sent to the model, notices aside. */
const COUNT_EVERY = 50;

/** The calls used at which a notice falls due. */
function noticeAt(share: number, limit: number): number {
  return Math.max(1, Math.floor(limit * share));
}

/**
 * The phrases a report that blames the attempt's own budget uses. Phrases, not
 * the bare words: a check's verdict ("calls save twice", "two steps remain")
 * and a real block ("network calls", "the API call limit") use those for
 * something else. A budget is the attempt's only unnamed, where a clause starts
 * or after "the", "my" or "your", or named for calls, steps or the attempt:
 * a bundle-size, performance or error budget is a check's subject.
 */
const BUDGET_OWNER = String.raw`(?:^|[.;:!?,]\s*|\b(?:the|my|your)\s+)`;
const BUDGET_PHRASES = [
  /\b(?:attempt|step|model[- ]call|call)s?\s+budget\b/i,
  new RegExp(String.raw`${BUDGET_OWNER}budget\s+(?:is\s+|was\s+|has\s+)?(?:exhausted|spent|used|ran\s+out|running\s+out|nearly|almost|left|remain\w*)`, 'i'),
  /\bout\s+of\s+(?:(?:the|my|your)\s+budget|(?:model\s+)?calls|steps)\b/i,
  /\b(?:model[- ]call|step)s?\s+limit\b/i,
  /\bmodel[- ]calls?\s+(?:left|remain\w*)\b/i,
] as const;

/**
 * Whether a `task_complete` call's arguments end the attempt as `failed` or
 * `blocked` and give the budget as why: one of BUDGET_PHRASES in its reason or
 * its summary, whatever their case.
 */
export function citesBudget(args: unknown): boolean {
  if (typeof args !== 'object' || args === null) return false;
  const { status, reason, summary } = args as Record<string, unknown>;
  if (status !== 'failed' && status !== 'blocked') return false;
  return [reason, summary].some((text) => typeof text === 'string' && BUDGET_PHRASES.some((phrase) => phrase.test(text)));
}

/** Conditional, since the phrases can match a report that stopped for another reason and is owed its record. */
function earlyGiveUpAnswer(used: number, limit: number): string {
  return '[Ordewell] Not recorded: if you stopped because of the call budget, it is not spent, so go on with the brief. '
    + `If you stopped for another reason, call task_complete again and that report is recorded.\n${countLine(used, limit)}`;
}

/** The one status line the model is shown: the call count, and its context fill beside it, one line so the cached prefix pays for one. */
function countLine(used: number, limit: number, context?: string): string {
  const calls = Number.isFinite(limit) ? `calls: ${used} of ${limit}` : undefined;
  return `[${[calls, context].filter((part) => part !== undefined).join('; ')}]`;
}

/**
 * The share of the window under which a context with no compaction point in
 * force is far from full: compaction acts at the capacity guard, well above it.
 */
const CONTEXT_ROOM_SHARE = 0.7;

/**
 * The phrases a report that blames the attempt's own context or memory uses.
 * Phrases, not the bare words: a library's context object, a context-length
 * error a tool returned and a test's "out of memory" are not the model's own
 * window. The model's own is named by "my", "your" or "the attempt's"; a clause
 * that opens on "context" or "the context window" (its usual shorthand) or an
 * "out of context" with a verb of running out before it. No bare "memory": it
 * is a test's subject too. Nor "exceeded" or "length", which a tool's error says.
 */
const CONTEXT_GONE = String.raw`(?:(?:is|was|has\s+been|are|being|now|nearly|almost|completely|fully|practically|currently)\s+)*(?:exhausted|full|used\s+up|spent|depleted|consumed|maxed\s+out|running\s+out|ran\s+out|reached|hit)\b`;
const CONTEXT_PHRASES = [
  new RegExp(String.raw`\b(?:my|your|our|(?:the|this)\s+attempt'?s?)\s+(?:remaining\s+)?(?:context|memory)(?:\s+(?:window|budget|limit))?\s+${CONTEXT_GONE}`, 'i'),
  new RegExp(String.raw`(?:^|[.;:!?,]\s*)(?:the\s+)?context(?:\s+window)?\s+${CONTEXT_GONE}`, 'i'),
  /\b(?:(?:ran|run|running)\s+(?:out\s+of|low\s+on)|(?:am|i'm|im|is|are)\s+(?:nearly\s+|almost\s+)?(?:out\s+of|low\s+on))\s+(?:(?:my|the|available|remaining)\s+)*context\b/i,
] as const;

/**
 * Whether a `task_complete` call's arguments end the attempt as `failed` or
 * `blocked` and give its own context as why: one of CONTEXT_PHRASES in its
 * reason or its summary, whatever their case.
 */
export function citesContext(args: unknown): boolean {
  if (typeof args !== 'object' || args === null) return false;
  const { status, reason, summary } = args as Record<string, unknown>;
  if (status !== 'failed' && status !== 'blocked') return false;
  return [reason, summary].some((text) => typeof text === 'string' && CONTEXT_PHRASES.some((phrase) => phrase.test(text)));
}

/** Conditional, like the budget's: the phrases can match a report that stopped for another reason and is owed its record. */
function contextGiveUpAnswer(fill: string, status: string): string {
  return `[Ordewell] Not recorded: if you stopped because your context is full, it is not: it holds ${fill} and is compacted for you as it fills, so go on with the brief. `
    + `If you stopped for another reason, call task_complete again and that report is recorded.\n${status}`;
}

function midBudgetNotice(used: number, limit: number): string {
  return `[Ordewell] You have used ${used} of the ${limit} model calls this attempt may make. Bring the part you are on to a working state and commit it, if your task lands as a commit, so it stands whenever the attempt ends; then go on with the brief in order.`;
}

function endBudgetNotice(left: number, limit: number): string {
  return `[Ordewell] ${left} model calls are left of the ${limit} this attempt may make, and the last is kept for task_complete. Start nothing new: commit what works, if your task lands as a commit, and call task_complete reporting what is done and what remains. Report done only if the brief's done criterion holds.`;
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
      return `The provider refused the key${status ? ` (${status})` : ''}: ${err.message}. Check it, or replace it with /key-set.`;
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
