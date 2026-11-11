import { v4 as uuidv4 } from 'uuid';
import type { ConversationMessage, PlannerCompaction, PlannerCompactionOutcome } from '../models/Task';
import type { UsageRecord } from '../models/Usage';
import type { ContextCondenseRequest } from './AiService';
import type { ResearchChat, ResearchTurn, ToolCall, ToolResult } from './BaseAiService';
import { ChatHistory, historyProblem, messageChars, type CompactableMessage } from './contextCompaction';
import { condensedNotice } from './conversationSummary';
import { callKey, condense, effectLedger, effectReceipts, summaryLimits, turnProgressNote, ContextSummaryError, type SummaryCall, type SummaryLimits, type SummarySubject } from './contextSummary';
import { CONTEXT_BUDGET, PlannerContextExhaustedError, callBudget, replyTokens, type CallBudget, type ChatBudget, type ContextExhaustion, type ContextSummaryAttempt, type ModelLimits } from './plannerContextBudget';

/** What one call sends after the history: a user message, or the results of the last call's tools. */
export interface CallInput<M> {
  kind: 'message' | 'results';
  messages: M[];
}

/**
 * What an API planner's chat is told by the conversation it serves, so it can
 * condense its context in the middle of a turn (ADR-0002). The chat holds the
 * live context; the conversation holds the transcript a checkpoint goes to.
 */
export interface ConversationCompactionHost {
  /** The user turn open now: what the chat sends while it is open is that turn's. Undefined while none is. */
  turnId(): string | undefined;
  /**
   * What landed before the open turn, where a checkpoint may cut it: from the
   * last checkpoint's cut up to where the open turn's inputs will land. Null
   * while no turn is open to commit a checkpoint during.
   */
  landed(): LandedHistory | null;
  /**
   * Append a checkpoint whose `content` stands for the transcript before
   * `keptFrom`, in a save of its own, under `id`. Throws, writing nothing,
   * when the turn it was made during is no longer the open one.
   */
  checkpoint(content: string, keptFrom: number, id: string): void;
  /** The current plan's lines: what a summary is told outranks its own account of task state. */
  planLines(): readonly string[] | null;
  /** The decision record a summary of the history is written beside and its checkpoint restates (ADR-0067); null when nothing in it stands. */
  record(): string | null;
}

export interface LandedHistory {
  /** Where the open turn's held inputs land: no cut passes it. */
  heldFrom: number;
  /** The exchanges since the last cut, oldest first: each opens at a user message, with what replaying it from there sends. */
  exchanges: Array<{ from: number; messages: Array<Pick<ConversationMessage, 'role' | 'content'>> }>;
}

/** How the planner conversation's own chat condenses its context: through the conversation, by its provider's own calls, saying so as it goes. */
export interface ChatCompaction {
  host: ConversationCompactionHost;
  summarize: SummaryCall;
  /** One phase of a compaction, for the turn's stream. */
  onCompaction: (compaction: PlannerCompaction) => void;
}

export interface BudgetedChatOptions {
  /** Resolved per call: a model picked mid-conversation must reach the next call, even within a tool loop. */
  model: () => string;
  /** The serving provider id, stamped on the usage records the chat writes itself. */
  source: () => string;
  /** One report per API call — the only way a call's usage leaves this chat. */
  onUsage?: (record: UsageRecord) => void;
  budget?: ChatBudget;
  /** Set on the planner conversation's chat alone: where pruning cannot make room, a summary does. */
  compaction?: ChatCompaction;
}

const NOT_EXECUTED = 'Not executed: the turn that asked for this ended first.';

function stopped(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

function charsOf(messages: readonly CompactableMessage[]): number {
  return messages.reduce((n, m) => n + messageChars(m), 0);
}

/** What lines add to a note, each on its own line. */
function linesChars(lines: readonly string[]): number {
  return lines.reduce((n, line) => n + line.length + 1, 0);
}

/** What one stage of condensing would do, decided before any call is made. */
interface LandedPlan {
  /** The live context that landed before the turn, which the summary condenses. */
  live: readonly CompactableMessage[];
  keptFrom: number;
  /** The exchanges from the cut on, as they replay. */
  kept: Array<Pick<ConversationMessage, 'role' | 'content'>>;
}

interface TurnPlan {
  /** The turn's rounds the summary condenses: after its opening message, before `cut`. */
  condensed: readonly CompactableMessage[];
  cut: number;
}

/** How one call is fitted: the budget on the model's known window, and the estimate of its characters to a token. */
interface Fitting {
  limits: ModelLimits | undefined;
  budget: CallBudget;
  perToken: number;
  /** Without the margin, from a measurement or a refusal; undefined while there is neither, when a guess alone never holds a call. */
  plain: number | undefined;
  /** The user's Retry, which sends once whatever the estimate. */
  explicit: boolean;
}

/**
 * An API planner's chat: its message list, and each call budgeted on its
 * model's known window before it is made (`plannerContextBudget`). Older
 * workspace reads are pruned first; where that leaves the call over its
 * ceiling, the planner conversation's own chat condenses by summary — the
 * history that landed before the turn into a checkpoint, then the turn's own
 * older rounds in the live context alone — and only once neither can make
 * the call fit is its input held and the turn ended on a typed error. Every
 * step runs between calls, after the tools a call asked for have returned,
 * and leaves a history the provider accepts.
 */
export abstract class BudgetedChat<M extends CompactableMessage> implements ResearchChat {
  protected readonly history: ChatHistory<M>;
  /**
   * The input of a call that could not fit: held out of the history, so a
   * history too long for the window does not fail every later call, and sent
   * again whole by {@link resend}, so no tool runs twice.
   */
  private held: CallInput<M> | null = null;
  /** The open turn, and where its messages begin: its own context is never condensed as history that landed. */
  private turn: { id: string; at: number } | null = null;
  /** The calls the open turn made that its condensed rounds no longer show, carried from one condensing to the next. */
  private done: string[] = [];
  /** The same calls by {@link callKey}, each to the head of what it returned: what answers one asked for again (see {@link answered}). */
  private readonly receipts = new Map<string, string>();
  /** Windows the provider stated, per model, in refusing a call as too long: its own word on them. */
  private readonly stated = new Map<string, ModelLimits>();
  /** The smallest prompt, in characters, the provider refused per model: whatever its window says, it takes less. */
  private readonly refusedAt = new Map<string, number>();

  protected constructor(
    seed: readonly M[],
    /** What the tool schemas add to every request: they never change within a chat. */
    protected readonly toolsChars: number,
    /** The reply a call asks for when nothing smaller is known. */
    private readonly wantedReply: number,
    private readonly chat: BudgetedChatOptions,
  ) {
    this.history = new ChatHistory(seed, (m) => this.messageSize(m));
  }

  protected abstract userMessage(text: string): M;
  protected abstract resultMessages(results: ToolResult[]): M[];
  /** A result for a call nothing ran. */
  protected abstract notExecuted(callId: string, name: string, text: string): M;
  /** Transcript entries as this provider's chat is seeded with them on a replay. */
  protected abstract replayed(messages: ReadonlyArray<Pick<ConversationMessage, 'role' | 'content'>>): M[];
  /** The provider refused the call as too long for the model's window: its own signal for that, and nothing broader. */
  protected abstract isContextOverflow(err: unknown): boolean;
  /** The window a refusal as too long states, in the provider's terms; undefined when it states none. */
  protected abstract statedLimits(err: unknown): ModelLimits | undefined;
  /** What a message adds to a request as this provider sends it. */
  protected messageSize(m: M): number {
    return messageChars(m);
  }
  /** Make the call, and on success add its input and the reply to the history. */
  protected abstract callApi(input: CallInput<M>, model: string, maxTokens: number, signal?: AbortSignal): Promise<ResearchTurn>;

  async sendMessage(text: string, signal?: AbortSignal): Promise<ResearchTurn> {
    if (signal?.aborted) throw stopped();
    this.supersedeHeld();
    this.answerAbandonedCalls();
    this.follow();
    return this.send({ kind: 'message', messages: [this.userMessage(text)] }, signal);
  }

  async sendToolResults(results: ToolResult[], signal?: AbortSignal): Promise<ResearchTurn> {
    const input: CallInput<M> = { kind: 'results', messages: this.resultMessages(results) };
    // The tools ran: what they returned answers their calls whatever stopped
    // the turn, so no later message tells the model a call that ran never did.
    if (signal?.aborted) {
      this.history.append(...input.messages);
      throw stopped();
    }
    return this.send(input, signal);
  }

  holdsInput(): boolean { return this.held !== null; }

  /** Sent again in a later turn, the input carries on the turn it was held in: that turn's messages are still what it answers. */
  async resend(signal?: AbortSignal): Promise<ResearchTurn> {
    return this.sendHeld(signal, false);
  }

  /**
   * Whether {@link retry} can send the held input: it is held, and the
   * model's window is known — from a catalog, or from what the provider
   * stated in refusing the call — so a compaction knows how far to go.
   */
  retryable(): boolean {
    return this.held !== null && callBudget(this.limitsFor(this.chat.model(), true), this.wantedReply) !== undefined;
  }

  /**
   * The user's Retry compaction (ADR-0002): condense what can be condensed,
   * with their consent whatever the settings file says, then send the held
   * input once. Nothing else is retried: refused again, it is held again.
   */
  async retry(signal?: AbortSignal): Promise<ResearchTurn> {
    return this.sendHeld(signal, true);
  }

  private async sendHeld(signal: AbortSignal | undefined, explicit: boolean): Promise<ResearchTurn> {
    if (!this.held) throw new Error('No planner input is held to send again.');
    const open = this.chat.compaction?.host.turnId();
    if (this.turn && open !== undefined) this.turn = { id: open, at: this.turn.at };
    return this.send(this.held, signal, explicit);
  }

  /** A history swapped in from outside says nothing of where the open turn's messages are, so nothing of it is condensed until the next turn. */
  reseed(next: readonly CompactableMessage[]): void {
    this.history.replace(next as M[]);
    this.turn = null;
    this.done = [];
    this.receipts.clear();
    this.chat.budget?.onCompacted();
  }

  compactHistory(): number {
    const freed = this.prune(Infinity, 0);
    this.announcePruned(freed);
    return freed;
  }

  /** What a summary of this whole context reads: everything after its system prompt, and held results, which ran. */
  liveContext(): readonly CompactableMessage[] {
    return [...this.history.view().slice(1), ...(this.held?.kind === 'results' ? this.held.messages : [])];
  }

  /**
   * A new message takes the place of a held one, which the model never heard
   * and whose turn already failed. Held tool results ran, so they answer their
   * calls in the history, as a turn before this one, where pruning reaches them.
   */
  private supersedeHeld(): void {
    if (this.held?.kind === 'results') this.history.append(...this.held.messages);
    this.held = null;
  }

  /**
   * A turn that gave up on its tool budget, or was stopped, can end on calls
   * nothing answered — and the providers refuse every later request over a
   * history like that. They are answered as never run before the next message.
   */
  private answerAbandonedCalls(): void {
    const last = this.history.last();
    if (last?.role !== 'assistant' || !last.tool_calls?.length) return;
    this.history.append(...last.tool_calls.map((call) => this.notExecuted(call.id ?? '', call.function?.name ?? '', NOT_EXECUTED)));
  }

  /** A message sent in a turn the chat has not seen opens that turn's messages. */
  private follow(): void {
    const id = this.chat.compaction?.host.turnId();
    if (this.turn?.id === id && id !== undefined) return;
    this.turn = id === undefined ? null : { id, at: this.history.length };
    this.done = [];
    this.receipts.clear();
  }

  /**
   * The answer to a call the open turn already made in rounds condensed out
   * of the model's sight (ADR-0002): what that call returned. The note in
   * their place lists them, but only the model's compliance would act on it;
   * this is what keeps one from running twice. Undefined for any other call,
   * which runs as it would have.
   */
  answered(call: ToolCall): string | undefined {
    const outcome = this.receipts.get(callKey(call.name, call.args));
    if (outcome === undefined) return undefined;
    return `Not run again: this exact call already ran earlier in this turn, in rounds condensed out of your context since. What it returned began: ${outcome}`;
  }

  /**
   * Make the call, fitted first where a budget is known. A refusal as too
   * long, classified narrowly by the provider's own signal, is answered once:
   * one more compaction below the prompt it refused, then the same input once
   * more. An explicit retry is that one attempt. Any other failure keeps its
   * input in the history and is never retried here.
   */
  private async send(input: CallInput<M>, signal: AbortSignal | undefined, explicit = false): Promise<ResearchTurn> {
    this.held = null;
    const model = this.chat.model();
    const auto = explicit || (this.chat.budget?.autoCompaction() ?? false);
    let summary: ContextSummaryAttempt = 'not_tried';
    const fitted = async (): Promise<void> => {
      const fitting = auto ? this.fitting(model, explicit) : undefined;
      if (!fitting) return;
      try {
        const attempt = await this.fit(input, model, fitting, signal);
        if (attempt !== 'not_tried') summary = attempt;
      } catch (err) {
        if (err instanceof PlannerContextExhaustedError) throw err;
        throw this.committed(input, err);
      }
    };
    await fitted();
    // A window the provider stated sizes the reply whether or not anything is compacted on it.
    let maxTokens = replyTokens(this.limitsFor(model, true), this.wantedReply);
    const call = (): Promise<ResearchTurn> => this.callApi(input, model, maxTokens, signal);
    try {
      return await call();
    } catch (err) {
      if (!this.isContextOverflow(err)) throw this.committed(input, err);
      const refused = this.charsWith(input);
      this.learnRefusal(model, err, refused, maxTokens);
      const budgeted = this.chat.budget !== undefined;
      const untried = explicit || !budgeted ? undefined : !auto ? 'off' : this.fitting(model, false) === undefined ? 'unknown_window' : undefined;
      if (explicit || !budgeted || untried) throw this.exhausted(input, model, err, { summary, ...(untried ? { untried } : {}) });
      // Fitted below the prompt refused: one the compaction could not make smaller is not sent again.
      await fitted();
      maxTokens = replyTokens(this.limitsFor(model, true), this.wantedReply);
      try {
        return await call();
      } catch (again) {
        if (!this.isContextOverflow(again)) throw this.committed(input, again);
        this.learnRefusal(model, again, this.charsWith(input), maxTokens);
        throw this.exhausted(input, model, again, { summary });
      }
    }
  }

  /**
   * What a refusal teaches about the model: the window, where the provider
   * stated it, and that the prompt it refused ran to more tokens than fit —
   * so its characters went to tokens more densely than any estimate said.
   */
  private learnRefusal(model: string, err: unknown, chars: number, maxTokens: number): void {
    const stated = this.statedLimits(err);
    if (stated) this.stated.set(model, stated);
    this.refusedAt.set(model, Math.min(this.refusedAt.get(model) ?? Infinity, chars));
    const limits = this.limitsFor(model, true);
    const window = stated?.inputTokenLimit ?? stated?.contextWindow;
    const tokens = stated?.inputTokenLimit ?? (window !== undefined ? window - maxTokens : callBudget(limits, this.wantedReply)?.promptLimit);
    if (tokens !== undefined) this.chat.budget?.gauge.refused(model, chars, tokens);
  }

  /**
   * The model's limits as a call is budgeted on them: the catalog's, with the
   * window a provider stated in refusing a call in its place. A window no
   * catalog states is compacted against only by an explicit retry —
   * automatic compaction stays off for it — though it always sizes the reply.
   */
  private limitsFor(model: string, explicit: boolean): ModelLimits | undefined {
    const catalog = this.chat.budget?.limits(model);
    const stated = this.stated.get(model);
    if (!stated || (!explicit && callBudget(catalog, this.wantedReply) === undefined)) return catalog;
    return { ...catalog, ...stated };
  }

  /** How a call on `model` is fitted now; undefined where no window is known, or nothing budgets this chat. */
  private fitting(model: string, explicit: boolean): Fitting | undefined {
    const gauge = this.chat.budget?.gauge;
    const limits = this.limitsFor(model, explicit);
    const budget = callBudget(limits, this.wantedReply);
    if (!budget || !gauge) return undefined;
    const perToken = gauge.charsPerToken(model);
    const plain = gauge.plainCharsPerToken(model);
    return { limits, budget: this.belowRefused(model, budget, plain ?? perToken), perToken, plain, explicit };
  }

  /**
   * Past how many characters a fitted call is held rather than sent, and the
   * characters to a token that is judged on; undefined where nothing holds
   * it, as on the user's Retry. A call a summary was committed for is held
   * to the ceiling it was condensed for, on the model's own measurement or,
   * with none, the estimate the condensing was planned on: summaries were
   * paid for to bring it under the budget, and one still past it is not sent
   * on the chance the model takes it. Any other call is held only past what
   * the model takes, and only on a measurement.
   */
  private holdLimit(fitting: Fitting, condensed: boolean): { chars: number; basis: number } | undefined {
    const { budget, perToken, plain, explicit } = fitting;
    if (explicit) return undefined;
    if (condensed) return { chars: budget.ceiling * (plain ?? perToken), basis: plain ?? perToken };
    return plain === undefined ? undefined : { chars: budget.promptLimit * plain, basis: plain };
  }

  /**
   * A prompt the provider refused bounds every later one on the same model,
   * whatever window it states or a catalog does: the budget stays below it,
   * at the same share of it as of a known window, so the turn's next calls
   * are compacted before they are sent rather than refused one by one.
   */
  private belowRefused(model: string, budget: CallBudget, perToken: number): CallBudget {
    const refused = this.refusedAt.get(model);
    if (refused === undefined) return budget;
    const promptLimit = Math.min(budget.promptLimit, Math.floor(refused / perToken) - 1);
    const ceiling = Math.min(budget.ceiling, Math.floor(promptLimit * CONTEXT_BUDGET.fillShare));
    return { ...budget, promptLimit, ceiling, lowWater: Math.floor(ceiling * CONTEXT_BUDGET.lowWaterShare) };
  }

  private charsWith(input: CallInput<M>): number {
    return this.history.chars + this.history.charsOf(input.messages) + this.toolsChars;
  }

  /**
   * Bring the call under its model's ceiling before it is made. Prune down to
   * low water — older rounds, keeping the newest anywhere; then, if that is not
   * enough, the rounds of turns before this one — and where even that leaves
   * the call over, condense by summary. Still past what {@link holdLimit}
   * allows, the call is not made: the input is held and the turn ends on a
   * typed error.
   */
  private async fit(input: CallInput<M>, model: string, fitting: Fitting, signal?: AbortSignal): Promise<ContextSummaryAttempt> {
    const { budget, perToken } = fitting;
    const over = (): boolean => this.charsWith(input) / perToken > budget.ceiling;
    if (!over()) return 'not_tried';
    const toLowWater = (): number => this.charsWith(input) - budget.lowWater * perToken;
    let freed = this.prune(toLowWater(), 0);
    if (over()) freed += this.prune(toLowWater(), this.turnStart(input));
    this.announcePruned(freed);
    let summary: ContextSummaryAttempt = 'not_tried';
    let cause: unknown;
    if (over()) ({ summary, cause } = await this.condense(input, model, fitting, signal));
    const hold = this.holdLimit(fitting, summary === 'condensed');
    if (hold && this.charsWith(input) > hold.chars) {
      this.held = input;
      // What a Retry cannot send either: past what the model takes, not past the budget.
      const tooLong = this.tooLong(input, budget.promptLimit * hold.basis);
      throw new PlannerContextExhaustedError(model, false, { cause, summary, done: this.turnLedger(), ...(tooLong ? { tooLong } : {}) });
    }
    return summary;
  }

  /** What no compaction can shorten that is by itself past `limit` characters: the instructions and tools, or with them the input. */
  private tooLong(input: CallInput<M>, limit: number): 'instructions' | 'message' | 'results' | undefined {
    const head = this.history.view()[0];
    const fixed = (head ? this.history.sizeOf(head) : 0) + this.toolsChars;
    if (fixed > limit) return 'instructions';
    return fixed + this.history.charsOf(input.messages) > limit ? input.kind : undefined;
  }

  /**
   * Condense what pruning could not free, in two stages, each committed whole
   * or not at all: the history that landed before the open turn, into a
   * checkpoint the transcript keeps; then, if the turn itself still fills the
   * window, its older rounds, in the live context alone. One compaction is
   * announced for both, under the checkpoint's id, and its end always follows
   * its start — `paused` when the call still cannot be made.
   */
  private async condense(input: CallInput<M>, model: string, fitting: Fitting, signal?: AbortSignal): Promise<{ summary: ContextSummaryAttempt; cause?: unknown }> {
    const { limits, budget, perToken } = fitting;
    const compaction = this.chat.compaction;
    const turn = this.turn;
    if (!compaction || !turn || compaction.host.turnId() !== turn.id) return { summary: 'not_tried' };
    const summaries = summaryLimits(limits, this.wantedReply, perToken);
    const allowance = Math.ceil(summaries.maxOutputTokens * perToken) + NOTE_CHARS;
    const room = budget.lowWater * perToken;
    const over = (): boolean => this.charsWith(input) / perToken > budget.ceiling;
    const landed = this.planLanded(input, room, allowance);
    if (!landed && !this.planTurn(input, room, allowance)) return { summary: 'not_tried' };

    const id = uuidv4();
    const phase = { id, origin: 'ordewell', trigger: 'auto' } as const;
    compaction.onCompaction({ phase: 'started', ...phase, at: new Date().toISOString() });
    let version = this.history.version;
    const current = (): boolean => !signal?.aborted && compaction.host.turnId() === turn.id && this.chat.model() === model && this.history.version === version;
    const summarize = (subject: SummarySubject, messages: readonly CompactableMessage[]): Promise<string> => condense(compaction.summarize, {
      model, subject, messages, planLines: compaction.host.planLines(), record: subject === 'history' ? compaction.host.record() : null, limits: summaries, signal, current,
      // Spend, counted like any call's, that measures nothing of the live context.
      onUsage: (record) => this.chat.onUsage?.({ ...record, aggregate: true }),
    });

    let condensed = false;
    let cause: unknown;
    // A stage that fails leaves what it was to replace as it was; only a stop ends the rest.
    const stage = async (run: () => Promise<boolean>): Promise<void> => {
      try {
        if (await run()) {
          condensed = true;
          version = this.history.version;
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        cause ??= err;
      }
    };
    let outcome: PlannerCompactionOutcome = 'stopped';
    try {
      if (landed) await stage(() => this.condenseLanded(landed, id, summarize, compaction.host));
      if (over()) await stage(async () => {
        const plan = this.planTurn(input, room, allowance);
        return plan ? this.condenseTurn(plan, summarize) : false;
      });
      const hold = this.holdLimit(fitting, condensed);
      const fits = !hold || this.charsWith(input) <= hold.chars;
      outcome = !fits ? 'paused' : condensed ? 'condensed' : cause ? 'failed' : 'unchanged';
    } finally {
      if (outcome === 'stopped' && condensed) outcome = 'condensed';
      compaction.onCompaction({ phase: 'ended', ...phase, outcome, at: new Date().toISOString() });
      // The context the meter showed is gone; the next call says how full the new one is.
      if (condensed) this.chat.onUsage?.({ source: this.chat.source(), model, compacted: true });
    }
    return { summary: condensed ? 'condensed' : cause ? 'failed' : 'not_tried', cause };
  }

  /**
   * The history that landed before the open turn, condensed into a summary
   * that stands for it, with the newest exchanges that fit under low water
   * beside the turn kept as they replay. Nothing, when there is too little of
   * it for a summary to be worth its call.
   */
  private planLanded(input: CallInput<M>, room: number, allowance: number): LandedPlan | null {
    const turn = this.turn!;
    const live = this.history.view().slice(1, turn.at);
    const liveChars = this.history.charsOf(live);
    if (liveChars <= allowance * 2) return null;
    const landed = this.chat.compaction!.host.landed();
    if (!landed) return null;
    const besides = this.charsWith(input) - liveChars + allowance;
    let keep = landed.exchanges.length;
    let keptChars = 0;
    while (keep > 0) {
      const chars = charsOf(landed.exchanges[keep - 1].messages);
      if (besides + keptChars + chars > room) break;
      keptChars += chars;
      keep--;
    }
    if (keptChars + allowance >= liveChars) return null;
    const kept = landed.exchanges.slice(keep);
    return { live, keptFrom: kept[0]?.from ?? landed.heldFrom, kept: kept.flatMap((e) => e.messages) };
  }

  private async condenseLanded(
    plan: LandedPlan, id: string, summarize: (subject: SummarySubject, messages: readonly CompactableMessage[]) => Promise<string>, host: ConversationCompactionHost,
  ): Promise<boolean> {
    const summary = await summarize('history', plan.live);
    const notice = condensedNotice(summary, 'auto', host.record());
    const view = this.history.view();
    const at = this.turn!.at;
    // The checkpoint's projection, then the turn's own messages as they are.
    const next = [view[0], ...this.replayed([{ role: 'assistant', content: notice }, ...plan.kept]), ...view.slice(at)];
    const problem = historyProblem(next);
    if (problem) throw new ContextSummaryError(`The condensed context would not be accepted: ${problem}.`);
    host.checkpoint(notice, plan.keptFrom, id);
    this.replace(next, next.length - (view.length - at));
    return true;
  }

  /**
   * The open turn's older rounds, condensed into a note after the user's
   * message, with the newest rounds that fit under low water kept as they
   * are, and the call whose results are being sent always among them. A round
   * is never split from the results that answer it. The note lists every
   * call the condensed rounds made that changed something, in full, so the
   * room is counted with that list: a round kept whole takes its lines out
   * of it.
   */
  private planTurn(input: CallInput<M>, room: number, allowance: number): TurnPlan | null {
    const at = this.turn!.at;
    const view = this.history.view();
    const starts: number[] = [];
    for (let i = at + 1; i < view.length; i++) if (view[i].role !== 'tool') starts.push(i);
    if (starts.length === 0) return null;
    const unit = (u: number): readonly M[] => view.slice(starts[u], starts[u + 1] ?? view.length);
    const unitChars = (u: number): number => this.history.charsOf(unit(u));
    const unitListed = (u: number): number => linesChars(effectLedger(unit(u)));
    const pending = input.kind === 'results' ? 1 : 0;
    const besides = this.history.charsOf(view.slice(0, at + 1)) + allowance + linesChars(this.done) + this.history.charsOf(input.messages) + this.toolsChars;
    let keep = starts.length - pending;
    let keptChars = 0;
    let listed = 0;
    for (let u = keep; u < starts.length; u++) keptChars += unitChars(u);
    for (let u = 0; u < keep; u++) listed += unitListed(u);
    while (keep > 0 && besides + keptChars + unitChars(keep - 1) + listed - unitListed(keep - 1) <= room) {
      keptChars += unitChars(keep - 1);
      listed -= unitListed(keep - 1);
      keep--;
    }
    if (keep === 0) return null;
    const cut = starts[keep] ?? view.length;
    const condensed = view.slice(at + 1, cut);
    if (this.history.charsOf(condensed) <= allowance * 2) return null;
    return { condensed, cut };
  }

  private async condenseTurn(plan: TurnPlan, summarize: (subject: SummarySubject, messages: readonly CompactableMessage[]) => Promise<string>): Promise<boolean> {
    // An earlier note's list is in what is condensed now only as text: it is carried, never asked of the summary.
    const done = [...this.done, ...effectLedger(plan.condensed)];
    const summary = await summarize('turn', plan.condensed);
    const view = this.history.view();
    const at = this.turn!.at;
    const next = [...view.slice(0, at + 1), this.userMessage(turnProgressNote(summary, done)), ...view.slice(plan.cut)];
    const problem = historyProblem(next);
    if (problem) throw new ContextSummaryError(`The condensed turn would not be accepted: ${problem}.`);
    this.replace(next, at);
    this.done = done;
    for (const [key, outcome] of effectReceipts(plan.condensed)) this.receipts.set(key, outcome);
    return true;
  }

  private replace(next: M[], turnAt: number): void {
    this.history.replace(next);
    if (this.turn) this.turn = { ...this.turn, at: turnAt };
    this.chat.budget?.onCompacted();
  }

  private prune(charsToFree: number, protectFrom: number): number {
    const { removedChars } = this.history.prune(charsToFree, protectFrom);
    if (removedChars > 0) this.chat.budget?.onCompacted();
    return removedChars;
  }

  /** Pruning changes only what the model is sent, at once: it has an end and no start. */
  private announcePruned(freed: number): void {
    if (freed > 0) this.chat.compaction?.onCompaction({ phase: 'ended', id: uuidv4(), origin: 'ordewell', trigger: 'auto', outcome: 'pruned', at: new Date().toISOString() });
  }

  /** Where the turn this input belongs to starts: a message opens one of its own. */
  private turnStart(input: CallInput<M>): number {
    return input.kind === 'message' ? this.history.length : Math.max(0, this.history.lastUserIndex);
  }

  /** A call that failed for another reason keeps its input, as the history always has. */
  private committed(input: CallInput<M>, err: unknown): unknown {
    this.history.append(...input.messages);
    return err;
  }

  private exhausted(input: CallInput<M>, model: string, cause: unknown, details: Omit<ContextExhaustion, 'cause' | 'done'>): PlannerContextExhaustedError {
    this.held = input;
    return new PlannerContextExhaustedError(model, true, { ...details, cause, done: this.turnLedger() });
  }

  /**
   * The calls the open turn made that changed something or reached out,
   * held results included: what a pause shows already ran, and what keeps a
   * retry from starting the turn again from the transcript (ADR-0002).
   */
  private turnLedger(): string[] {
    const from = this.turn?.at ?? Math.max(0, this.history.lastUserIndex);
    const results = this.held?.kind === 'results' ? this.held.messages : [];
    return [...this.done, ...effectLedger([...this.history.view().slice(from), ...results])];
  }
}

/** Room kept beside a summary for the words around it: the notice it is replayed in, or the note it stands in. */
const NOTE_CHARS = 600;

/** What a summary of an API planner's context is written with, as of now. */
export interface ContextSummarizer {
  model: string;
  limits: ModelLimits | undefined;
  /** The reply the planner's calls ask for when nothing smaller is known. */
  wantedReply: number;
  charsPerToken: number;
  call: SummaryCall;
}

/**
 * A summary of an API planner's whole context for `/compact`, written the way
 * an automatic one is: by calls offering no tools, so a manual summary cannot
 * run one either. It reads the live context when it is asked to, or the model
 * context replayed from the transcript.
 */
export async function condenseConversation(live: ResearchChat | undefined, request: ContextCondenseRequest, summarizer: () => ContextSummarizer): Promise<string> {
  const messages = request.replay?.map(({ role, content }) => ({ role, content }))
    ?? (live instanceof BudgetedChat ? live.liveContext() : undefined);
  if (!messages) throw new Error('No planner context to condense.');
  const { model, limits, wantedReply, charsPerToken, call } = summarizer();
  const summaries: SummaryLimits = summaryLimits(limits, wantedReply, charsPerToken);
  return condense(call, {
    model,
    subject: 'history',
    messages,
    planLines: request.planLines,
    record: request.record ?? null,
    limits: summaries,
    signal: request.signal,
    current: () => summarizer().model === model,
    onUsage: (record) => request.onProgress({ type: 'usage', record: { ...record, aggregate: true } }),
  });
}
