import type { ConversationRequest, ConversationTurn, IAiService } from './AiService';
import { repairLoop, taskOpsRejectedPrompt } from './PlanRepair';
import { renderTaskQueryAnswer, taskQuerySignature, TASK_QUERY_ANSWER_OR_OPS, TASK_QUERY_REMINDER, type LiveOutputLookup, type TaskQuery, type TaskQueryCatalog } from './TaskQuery';
import { taskOpsProtocol, type ApplyTaskOpsResult, type TaskOp } from './TaskOps';
import { resolveDefaultMode } from './ModeResolver';
import type { SessionBroadcaster } from './SessionMessage';
import type { ForkedDialogue } from './conversationFork';
import { condensedNotice, extractSummary, keptTail, summaryRequest } from './conversationSummary';
import type { ConversationMessage, LegacyPlanState, ResearchLogEntry, ResearchProgress, RunnerId, Task } from '../models/Task';

/**
 * Per-runner model cap for the always-on catalog block. Generous enough that
 * a typical single-agent catalog (dozens of models) is never truncated —
 * only runners that aggregate hundreds of models (e.g. OpenRouter) hit it.
 */
const CATALOG_MODEL_CAP = 100;

/**
 * Reads a planner gets per user turn before every answer also carries an
 * instruction to land the turn. Three covers the realistic shape of a read —
 * look at a task, look at the catalog, look at a neighbour it now suspects —
 * without letting a confused planner explore on the user's tokens forever.
 */
const MAX_TASK_QUERIES = 3;

/**
 * Reads answered per user turn, full stop. The soft limit above still answers,
 * so without a hard stop a planner that ignores the instruction loops until
 * something else breaks.
 */
const MAX_TASK_QUERIES_HARD = 6;

/** Per-user-turn read state. Shared across the repair loop so retries don't reset it. */
interface ReadBudget {
  answered: number;
  /** Query signatures already answered this turn — a repeat is a loop, not a read. */
  seen: Set<string>;
}

function freshReadBudget(): ReadBudget {
  return { answered: 0, seen: new Set() };
}

/** A turn with every read already drained — what the settle path actually commits. */
type SettleableTurn = Exclude<ConversationTurn, { kind: 'task_query' }>;
type CommitTurn = Exclude<SettleableTurn, { kind: 'task_ops' }>;

/** Everything (re)opening a conversation needs besides the dialogue itself. */
export type ConversationOpening = Omit<ConversationRequest, 'goal' | 'onProgress' | 'signal' | 'priorHistory' | 'initialMessage'>;

/**
 * What the conversation needs from the session that hosts it. The session keeps
 * plan state, persistence and scheduling; the conversation reaches them only
 * through here, so a fake host is enough to drive it.
 */
export interface PlannerConversationHost {
  /** The plan the transcript lives on (`conversationHistory`, `researchLog`). */
  plan(): LegacyPlanState | null;
  goal(): string;
  aiService(): IAiService;
  onProgress(progress: ResearchProgress): void;
  /** Fresh discovery, allowlist-filtered the way the system prompt shows it. */
  opening(runners: RunnerId[]): Promise<ConversationOpening>;
  /** What the per-turn catalog block and every read draw from, as of now. */
  catalog(): TaskQueryCatalog;
  tasks(): Task[];
  /**
   * The orchestrator's live capture for a task's latest attempt, backing the
   * `output` field of a read. Injected the same way as the catalog so the
   * conversation never reaches into execution state directly.
   */
  liveOutput: LiveOutputLookup;
  hasLiveWork(): boolean;
  /** The session's single mutation ritual: op → persist → notify (default: the plan). */
  mutate(op: () => boolean, notify?: () => void): LegacyPlanState | null;
  broadcast: SessionBroadcaster;
  broadcastPlan(): void;
  /** Validate a batch against live state. Pure — nothing is applied. */
  validateOps(ops: TaskOp[]): ApplyTaskOpsResult;
  /** Load planner-produced tasks: an edit keeps run state, a commit starts over. Returns how many landed. */
  adoptTasks(tasks: Task[], how: 'edit' | 'commit'): number;
  capturePrd(text: string): void;
  /** Park a structural edit until the next batch boundary. Returns the queue length. */
  queueEdit(userMessage: string): number;
  /** Wake a scheduler an applied edit may have unblocked. */
  afterEdit(): Promise<void>;
}

/**
 * A conversation edit (rewind, fork) the conversation refused because the
 * request itself is wrong — no such message, nothing to fork. Transport-agnostic
 * like `PlanEditError`: a route maps it to a status, core carries none.
 */
export class ConversationEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationEditError';
  }
}

/**
 * Refused because a planner turn is in flight. Distinct from a bad request:
 * the same call succeeds once the turn settles, and the turn would otherwise
 * append its reply to a transcript that no longer holds the message it
 * answers.
 */
export class ConversationBusyError extends ConversationEditError {
  constructor(operation: string) {
    super(`Cannot ${operation} while the planner is answering — wait for the reply, or stop it first.`);
    this.name = 'ConversationBusyError';
  }
}

/** Width of a rewind target's preview — one picker row, not the whole message. */
const REWIND_PREVIEW_WIDTH = 80;

/** A user message the conversation can be rewound to just before. */
export interface RewindTarget {
  /** Position in the transcript — what {@link PlannerConversation.rewind} takes. */
  index: number;
  preview: string;
  timestamp: string;
}

/** What a compaction left behind. */
export interface ConversationCompaction {
  summary: string;
  /** Transcript entries kept verbatim after the summary entry. */
  keptMessages: number;
}

/** A point a failed turn returns the dialogue to. Opaque outside this module. */
export interface TranscriptSnapshot {
  readonly plan: LegacyPlanState;
  readonly history: ConversationMessage[] | undefined;
  readonly researchLog: ResearchLogEntry[] | undefined;
  readonly persisted: number;
}

export interface ReplyOptions {
  signal?: AbortSignal;
  /** The user's words before skill expansion — what a mid-run queue replays later. */
  verbatim?: string;
}

/**
 * The planner conversation (ADR-0002), end to end: the persisted dialogue
 * record, the live model context behind it, and every turn from the user's
 * message to a settled, persisted outcome.
 *
 * It is the only writer of `conversationHistory` and of the planner's
 * `researchLog`. The writes land on the host's plan object — which is what the
 * session persists and broadcasts — but only ever inside the host's mutation
 * ritual or ahead of a turn that will either reach it or be rolled back.
 *
 * The live model context (a vendor service's message list, a harness planner's
 * process and native session id) is disposable: {@link reset} drops it and the
 * next turn is replayed from the transcript. That is what lets the transcript
 * be edited in place — truncated, replaced by a summary, cloned — without the
 * model's memory drifting from it.
 */
export class PlannerConversation {
  /** Bumped on every persist, so a rollback can tell whether its writes already reached disk. */
  private persisted = 0;
  private turnsInFlight = 0;
  private compacting = false;

  constructor(private readonly host: PlannerConversationHost) {}

  get transcript(): readonly ConversationMessage[] {
    return this.host.plan()?.conversationHistory ?? [];
  }

  /** Whether a user turn is between its transcript append and its settled outcome. */
  get isTurnInFlight(): boolean {
    return this.turnsInFlight > 0;
  }

  /** Whether the model still holds this conversation in memory. */
  get isActive(): boolean {
    return this.host.aiService().hasActiveConversation();
  }

  append(role: ConversationMessage['role'], content: string, opts: { timestamp?: string; kind?: ConversationMessage['kind'] } = {}): void {
    const plan = this.host.plan();
    if (!plan) return;
    plan.conversationHistory = [
      ...(plan.conversationHistory ?? []),
      { role, content, timestamp: opts.timestamp ?? new Date().toISOString(), ...(opts.kind ? { kind: opts.kind } : {}) },
    ];
  }

  /** Swap the whole transcript. The live context no longer matches it, so pair with {@link reset}. */
  replace(messages: readonly ConversationMessage[]): void {
    const plan = this.host.plan();
    if (plan) plan.conversationHistory = [...messages];
  }

  snapshot(): TranscriptSnapshot | null {
    const plan = this.host.plan();
    if (!plan) return null;
    return { plan, history: plan.conversationHistory, researchLog: plan.researchLog, persisted: this.persisted };
  }

  /**
   * Put the dialogue back where {@link snapshot} found it — unless anything
   * was persisted since, because then memory already matches disk and every
   * surface, and undoing it would erase work the user has seen land. Also a
   * no-op once a different plan has been adopted.
   */
  restore(snapshot: TranscriptSnapshot): boolean {
    if (this.host.plan() !== snapshot.plan || this.persisted !== snapshot.persisted) return false;
    snapshot.plan.conversationHistory = snapshot.history;
    snapshot.plan.researchLog = snapshot.researchLog;
    return true;
  }

  /** The host calls this after every persist. */
  markPersisted(): void {
    this.persisted++;
  }

  /**
   * Drop the live model context. Idempotent; the harness backend holds an OS
   * process here, so callers never gate it on {@link isActive}.
   */
  reset(): void {
    this.host.aiService().reset();
  }

  /**
   * The user messages a rewind may land before. The opening message is the
   * goal: cutting it leaves a conversation about nothing, which is a new
   * session, not a rewind. After a compaction the summary entry, always
   * first, plays the goal's part: what it replaced is gone, so a rewind stops
   * at it.
   */
  rewindTargets(): RewindTarget[] {
    return this.transcript.flatMap((m, index) => {
      if (m.role !== 'user' || index === 0) return [];
      const line = m.content.split('\n')[0];
      const preview = line.length > REWIND_PREVIEW_WIDTH ? `${line.slice(0, REWIND_PREVIEW_WIDTH - 1)}…` : line;
      return [{ index, preview, timestamp: m.timestamp }];
    });
  }

  /**
   * Cut the dialogue back to just before the user message at `index` (a
   * position in the transcript), discarding it and everything after. The task
   * list is the host's and rides along untouched — rewinding moves where the
   * conversation resumes, not what the plan is. The planner's research trace
   * goes back to the same point, by time: its entries carry no link to the
   * message that caused them.
   */
  rewind(index: number): LegacyPlanState {
    this.assertIdle('rewind the conversation');
    const plan = this.requirePlan();
    if (!this.rewindTargets().some((t) => t.index === index)) {
      if (index > 0) throw new ConversationEditError(`No user message at position ${index} to rewind to.`);
      throw new ConversationEditError(this.transcript[0]?.kind === 'compaction'
        ? 'The conversation was condensed there — a rewind cannot reach back past the summary.'
        : 'The first message is the goal — start a new session to change it.');
    }
    const cutoff = this.transcript[index].timestamp;
    const rewound = this.host.mutate(() => {
      plan.conversationHistory = this.transcript.slice(0, index);
      plan.researchLog = (plan.researchLog ?? []).filter((e) => e.timestamp < cutoff);
      return true;
    }, () => this.host.broadcastPlan());
    this.reset();
    return rewound!;
  }

  /**
   * Replace the transcript with a summary of it, keeping the last two
   * exchanges as they were, and drop the live context so the next message
   * replays from the shorter record.
   *
   * The summary is one hidden turn through whichever planner is configured —
   * on the live context when it still matches, replayed from the transcript
   * when not — so the compaction is the same for a vendor API and a harness
   * agent. Whatever the turn emits besides the summary is discarded, ops
   * included: it condenses the conversation, never the plan. Nothing is
   * written until the summary is in hand, so a failed or stopped turn leaves
   * the transcript exactly as it was.
   */
  async compact(signal?: AbortSignal): Promise<ConversationCompaction> {
    this.assertIdle('condense the conversation');
    const plan = this.host.plan();
    if (!plan) throw new ConversationEditError('No planning conversation to condense');
    if (!keptTail(this.transcript)) {
      throw new ConversationEditError('The conversation is too short to condense — it takes more than two exchanges before a summary saves anything.');
    }
    return this.inTurn(async () => {
      this.compacting = true;
      try {
        const summary = await this.summarize(signal);
        const tail = keptTail(this.transcript);
        if (this.host.plan() !== plan || !tail) throw new ConversationEditError('The conversation changed while it was being condensed — nothing was replaced.');
        const now = new Date().toISOString();
        const content = condensedNotice(summary);
        this.host.mutate(() => {
          plan.conversationHistory = [{ role: 'assistant', content, timestamp: now, kind: 'compaction' }, ...tail];
          return true;
        }, () => {
          this.host.broadcast({ type: 'planner_message', content, timestamp: now });
          this.host.broadcastPlan();
        });
        return { summary, keptMessages: tail.length };
      } finally {
        this.compacting = false;
        // Success and failure alike: the live context either holds the
        // conversation this replaced or a summary exchange nobody kept.
        this.reset();
      }
    });
  }

  private async summarize(signal?: AbortSignal): Promise<string> {
    const ai = this.host.aiService();
    const request = summaryRequest(this.currentPlanLines());
    // Only liveness gets through: streamed prose or research steps from this
    // turn would land in the chat as if the planner had said them.
    const onProgress = (p: ResearchProgress) => { if (p.type === 'liveness') this.host.onProgress(p); };
    const canContinueLive = ai.hasActiveConversation() && (ai.conversationMatchesConfig?.() ?? true);
    let turn: ConversationTurn;
    if (canContinueLive) {
      ai.pruneContext?.();
      turn = await ai.continueConversation(request, onProgress, signal);
    } else {
      turn = await this.resume(request, [...this.transcript], signal, onProgress);
    }
    if (signal?.aborted) throw new ConversationEditError('Condensing was stopped — the conversation is unchanged.');
    const summary = extractSummary(turn.text);
    if (!summary) throw new ConversationEditError('The planner returned no summary, so the conversation is unchanged. Try again.');
    return summary;
  }

  /**
   * A copy of the dialogue record for a forked session to carry. Refused
   * mid-turn: the copy would hold the user's message without the reply to it.
   * The live context is not part of it — the fork replays from this record on
   * its first turn, like any adopted session.
   */
  clone(): ForkedDialogue {
    this.assertIdle('fork the conversation');
    const plan = this.host.plan();
    return structuredClone({
      conversationHistory: plan?.conversationHistory ?? [],
      researchLog: plan?.researchLog ?? [],
    });
  }

  /** A one-shot `modifyPlan` exchange. Call inside the host's mutation ritual. */
  recordModification(request: string, requestedAt: string, taskCount: number): void {
    this.append('user', request, { timestamp: requestedAt });
    this.append('assistant', `Plan updated — now ${taskCount} task${taskCount === 1 ? '' : 's'}.`, { kind: 'plan_generated' });
  }

  /**
   * Queued mid-run edits applied between batches. The user's message is
   * already in the transcript from when it was queued; this records that it
   * finally took effect, so a replay does not read the plan as never changed.
   * Call inside the host's mutation ritual.
   */
  recordQueuedEdits(messages: string[], taskCount: number): void {
    this.append('assistant', [
      'Queued change applied between task batches:',
      ...messages.map((m) => `- ${m}`),
      `The plan now has ${taskCount} task${taskCount === 1 ? '' : 's'}.`,
    ].join('\n'), { kind: 'system' });
  }

  /** Open the conversation on a fresh plan: the goal is its first message. */
  async start(goal: string, opening: ConversationOpening, signal?: AbortSignal): Promise<LegacyPlanState> {
    return this.inTurn(async () => {
      this.recordUser(goal, new Date().toISOString());
      const turn = await this.host.aiService().startConversation({
        ...opening,
        goal,
        onProgress: (p) => this.host.onProgress(p),
        signal,
      });
      return this.settle(turn, signal);
    });
  }

  /**
   * Every later user message, from the transcript append to a persisted
   * outcome. A turn that throws before anything was persisted takes its own
   * writes back out, so session memory never drifts from disk and the UI.
   */
  async reply(message: string, options: ReplyOptions = {}): Promise<LegacyPlanState> {
    // A reply would share the summary turn's live context, which the
    // compaction resets as it lands, and its message would be condensed away
    // unanswered or left dangling after the summary.
    if (this.compacting) throw new ConversationBusyError('send a message');
    return this.inTurn(() => this.replyTurn(message, options));
  }

  private async replyTurn(message: string, options: ReplyOptions): Promise<LegacyPlanState> {
    const { signal } = options;
    const plan = this.requirePlan();
    const priorHistory = plan.conversationHistory ?? [];
    const checkpoint = this.snapshot();
    this.recordUser(message, new Date().toISOString());

    // The persisted transcript keeps the raw user message; the model gets the
    // live catalog (always) and the current plan (tasks, statuses, edit
    // protocol — once tasks exist) alongside it.
    const contextBlock = [this.catalogBlock(), this.planContextBlock()].filter(Boolean).join('\n\n');
    const outgoing = contextBlock ? `${contextBlock}\n\n${message}` : message;

    // A live conversation is only safe to continue in-place when it also
    // matches the model/effort configured right now — a harness planner's
    // running process was spawned with the old one baked in and cannot pick
    // up a switch (ADR-0009). Both cases resume the same way.
    const ai = this.host.aiService();
    const canContinueLive = ai.hasActiveConversation() && (ai.conversationMatchesConfig?.() ?? true);
    try {
      const turn = canContinueLive
        ? await ai.continueConversation(outgoing, (p) => this.host.onProgress(p), signal)
        : await this.resume(outgoing, priorHistory, signal);

      // Reads settle before the execution gate below, so a query is answered
      // on the spot even mid-run: it mutates nothing, and parking it behind a
      // batch boundary would strand the planner waiting on detail it needs to
      // write the very edit that gets queued.
      const reads = freshReadBudget();
      let settleable = await this.drainTaskQueries(turn, reads, signal);

      // Structural changes while tasks execute are queued, never applied live —
      // the orchestrator must not have the plan mutated under a running batch.
      // The gate is live runners, not an armed scheduler: a run paused on a user
      // task keeps executing with nothing reading the plan, and queueing there
      // parks the edit behind a batch boundary that will never arrive.
      if ((settleable.kind === 'task_ops' || settleable.kind === 'plan') && this.host.hasLiveWork()) {
        const queued = this.host.queueEdit(options.verbatim ?? message);
        settleable = {
          kind: 'message',
          text: `Execution is running, so I queued your change — it will be applied between task batches (${queued} queued).`,
          researchLog: settleable.researchLog,
        };
      }

      return await this.settle(settleable, signal, reads);
    } catch (err) {
      if (checkpoint) this.restore(checkpoint);
      throw err;
    }
  }

  private assertIdle(operation: string): void {
    if (this.isTurnInFlight) throw new ConversationBusyError(operation);
  }

  private async inTurn<T>(turn: () => Promise<T>): Promise<T> {
    this.turnsInFlight++;
    try {
      return await turn();
    } finally {
      this.turnsInFlight--;
    }
  }

  private requirePlan(): LegacyPlanState {
    const plan = this.host.plan();
    if (!plan) throw new Error('No active plan state');
    return plan;
  }

  private recordUser(content: string, timestamp: string): void {
    this.append('user', content, { timestamp });
    this.recordResearch([{ id: `up-${Date.now()}`, type: 'user_prompt', content, timestamp }]);
  }

  private recordResearch(entries: ResearchLogEntry[]): void {
    const plan = this.host.plan();
    if (plan) plan.researchLog = [...(plan.researchLog ?? []), ...entries];
  }

  /**
   * Reopen the model context from the transcript — because the in-memory one
   * is gone (session reload, extension restart), or because it is stale
   * against the planner config now in effect. No LLM call happens for the
   * replayed turns; the first call is the one the user's message opens.
   */
  private async resume(
    message: string,
    priorHistory: ConversationMessage[],
    signal?: AbortSignal,
    onProgress: (progress: ResearchProgress) => void = (p) => this.host.onProgress(p),
  ): Promise<ConversationTurn> {
    const runners = this.requirePlan().runners;
    const opening = await this.host.opening(runners);
    const goal = this.host.goal() || priorHistory.find((m) => m.role === 'user')?.content || message;
    // Explicit rather than left to each backend's start: a replay begins from
    // the transcript alone, which for a harness planner means its native
    // session id goes too — otherwise the agent's own memory of the old
    // dialogue could ride along under the replayed one.
    this.reset();
    return this.host.aiService().startConversation({
      ...opening,
      runners,
      goal,
      onProgress,
      signal,
      priorHistory,
      initialMessage: message,
    });
  }

  /**
   * Answer every read the planner emits until it says something else.
   *
   * The channel is a text envelope rather than a registered tool because the
   * protocol has to be identical on both planner backends (ADR-0009): Ordewell
   * owns a tool loop only in the API case, and a harness planner running as a
   * coding-agent subprocess can only be reached this way.
   *
   * Draining here — outside {@link repairLoop} — is what keeps reads free of
   * the repair budget. A planner that looks a task up and *then* fumbles its
   * ops JSON still gets its two corrective retries; charging it for the read
   * would cost it the chance to fix the edit.
   */
  private async drainTaskQueries(turn: ConversationTurn, reads: ReadBudget, signal?: AbortSignal): Promise<SettleableTurn> {
    const ai = this.host.aiService();
    const carried: ConversationTurn['researchLog'] = [];
    let current = turn;
    while (current.kind === 'task_query') {
      carried.push(...current.researchLog);
      if (reads.answered >= MAX_TASK_QUERIES_HARD || !ai.hasActiveConversation() || signal?.aborted) {
        return {
          kind: 'message',
          text: 'The planner kept asking to read tasks instead of answering. Nothing was changed — ask again, or be more specific about the edit you want.',
          researchLog: carried,
        };
      }
      const signature = taskQuerySignature(current.query);
      // Two reasons to stop being accommodating: the budget is spent, or the
      // planner asked the identical question again — a loop, not a read.
      const insist = reads.seen.has(signature) || reads.answered >= MAX_TASK_QUERIES;
      reads.seen.add(signature);
      reads.answered++;
      const answer = this.taskQueryAnswer(current.query);
      current = await ai.continueConversation(
        insist ? `${answer}\n\n${TASK_QUERY_ANSWER_OR_OPS}` : answer,
        (p) => this.host.onProgress(p),
        signal,
      );
    }
    return carried.length > 0
      ? { ...current, researchLog: [...carried, ...current.researchLog] }
      : current;
  }

  /**
   * Render one read out of live state. Never persisted to the transcript: the
   * detail is context for the planner's next reply, and re-sending it on every
   * later turn is exactly the cost this channel exists to avoid.
   */
  private taskQueryAnswer(query: TaskQuery): string {
    return renderTaskQueryAnswer(query, this.host.tasks(), this.host.catalog(), this.host.liveOutput);
  }

  /**
   * Drive a planner turn to a persisted, broadcast outcome. Task edits apply
   * atomically; validation failures are fed back to the model for up to 2
   * silent retries, then surfaced as a message with the plan untouched. The
   * first turn and every later turn route through here — one path, not two.
   */
  private async settle(turn: ConversationTurn, signal?: AbortSignal, reads = freshReadBudget()): Promise<LegacyPlanState> {
    type Settled = { plan: LegacyPlanState } | { turn: CommitTurn };
    const ai = this.host.aiService();
    const invalidOps = (errors: string[], researchLog: ConversationTurn['researchLog']): Settled => ({
      turn: {
        kind: 'message',
        text: `I tried to modify the tasks, but the changes were invalid:\n- ${errors.join('\n- ')}\n\nThe plan is unchanged. Rephrase the request, or adjust the tasks manually.`,
        researchLog,
      },
    });

    const settled = await repairLoop<SettleableTurn, Settled>({
      first: () => this.drainTaskQueries(turn, reads, signal),
      resend: async (corrective) => this.drainTaskQueries(
        await ai.continueConversation(corrective, (p) => this.host.onProgress(p), signal),
        reads,
        signal,
      ),
      interpret: (t) => {
        if (t.kind !== 'task_ops') return { done: { turn: t } };
        const applied = this.applyTaskOps(t);
        if ('plan' in applied) return { done: { plan: applied.plan } };
        // No live conversation (or an abort) means no corrective re-send is
        // possible — surface the failure instead of retrying into the void.
        if (!ai.hasActiveConversation() || signal?.aborted) {
          return { done: invalidOps(applied.errors, t.researchLog) };
        }
        return { retry: { errors: applied.errors, corrective: taskOpsRejectedPrompt(applied.errors) } };
      },
      maxRepairs: 2,
      onExhausted: ({ reply, errors }) => invalidOps(errors, reply.researchLog),
    });

    if ('plan' in settled) {
      // A landed edit can make work ready under a scheduler that is armed but
      // idle-paused, and nothing else will wake it — the queue-drain path never
      // runs, because nothing queued.
      await this.host.afterEdit();
      return settled.plan;
    }
    return this.commit(settled.turn);
  }

  /** Validate + commit a task_ops turn atomically. Returns the errors on rejection (plan untouched). */
  private applyTaskOps(turn: Extract<ConversationTurn, { kind: 'task_ops' }>): { plan: LegacyPlanState } | { errors: string[] } {
    this.requirePlan();
    const result = this.host.validateOps(turn.ops);
    if (!result.ok) return { errors: result.errors };

    const now = new Date().toISOString();
    const content = `Tasks updated:\n- ${result.summary.join('\n- ')}`;
    const plan = this.host.mutate(
      () => {
        this.recordResearch(turn.researchLog);
        this.host.adoptTasks(result.tasks, 'edit');
        this.append('assistant', content, { timestamp: now });
        return true;
      },
      () => {
        this.host.broadcast({ type: 'planner_message', content, timestamp: now });
        this.host.broadcastPlan();
      },
    );
    return { plan: plan! };
  }

  /** Commit a settled (non-task_ops) turn through the host's mutation ritual. */
  private commit(turn: CommitTurn): LegacyPlanState {
    this.requirePlan();
    const now = new Date().toISOString();

    if (turn.kind === 'plan') {
      return this.host.mutate(() => {
        this.recordResearch(turn.researchLog);
        // A cheap model may emit the PRD block and the plan JSON in one turn —
        // capture the PRD here too so it isn't dropped with the plan preamble.
        this.host.capturePrd(turn.text);
        const count = this.host.adoptTasks(turn.tasks, 'commit');
        this.append('assistant', `Plan generated with ${count} task${count === 1 ? '' : 's'}.`, { timestamp: now, kind: 'plan_generated' });
        return true;
      })!;
    }

    // Budget models occasionally return an empty content turn after tool use —
    // surface that visibly instead of rendering a blank bubble.
    const text = turn.text.trim()
      ? turn.text
      : '(The planner returned an empty response. Reply to continue, or rephrase your goal.)';
    return this.host.mutate(
      () => {
        this.recordResearch(turn.researchLog);
        this.append('assistant', text, { timestamp: now });
        this.host.capturePrd(text);
        return true;
      },
      () => this.host.broadcast({ type: 'planner_message', content: text, timestamp: now }),
    )!;
  }

  /**
   * The catalog the planner may actually draw from — model ids and task-mode
   * ids, per runner in the plan — emitted on EVERY turn, before any plan exists
   * or after. The system prompt shows this once at conversation start; a long
   * clarifying conversation outlives that single showing and the planner
   * starts misquoting it, so this re-states it per turn instead.
   *
   * The host's catalog is allowlist-filtered, so a restricted allowlist stays a
   * hard bound on every turn, and reads the plan's runners live, so a runner
   * admitted mid-session by a retarget is shown like every other.
   */
  private catalogBlock(): string | null {
    if (!this.host.plan()) return null;
    const { runners, models, modes, autonomousDefault } = this.host.catalog();

    const modelLines = runners.map((runner) => {
      const list = models[runner] ?? [];
      const capped = list.slice(0, CATALOG_MODEL_CAP);
      const remainder = list.length - capped.length;
      const ids = capped.map((m) => m.modelId).join(', ') || '(no models discovered)';
      return `${runner}: ${ids}${remainder > 0 ? ` … +${remainder} more not shown` : ''}`;
    });

    const modeLines = runners.map((runner) => {
      const list = modes[runner] ?? [];
      if (list.length === 0) return `${runner}: (no modes declared)`;
      const defaultId = resolveDefaultMode(list, autonomousDefault);
      const ids = list.map((m) => `${m.id}${m.id === defaultId ? ' (default)' : ''}`).join(', ');
      return `${runner}: ${ids}`;
    });

    return [
      '<available_models>',
      ...modelLines,
      '</available_models>',
      '<available_task_modes>',
      ...modeLines,
      '</available_task_modes>',
    ].join('\n');
  }

  /**
   * The "you are here" block for post-plan chat: current tasks with stable
   * references, plus the read and edit protocols. Injected per turn (never
   * persisted) so the model always sees live statuses — including which tasks
   * are locked by a running execution.
   */
  private planContextBlock(): string | null {
    const tasks = this.host.tasks();
    const lines = this.currentPlanLines();
    if (!lines) return null;
    // Gated on live runners, not on an armed scheduler: a paused-but-armed run
    // takes edits immediately, so promising a queue there is a lie the model
    // plans around (it stops emitting ops and asks the user to wait).
    const locked = tasks.filter((t) => t.status === 'in_progress');
    const execNote = this.host.hasLiveWork()
      ? `\nExecution is RUNNING${locked.length ? ` — these tasks are locked: ${locked.map((t) => `#${t.order}`).join(', ')}` : ''}. Any task edits you emit will be queued and applied between batches.`
      : '';
    return [
      '<current_plan>',
      ...lines,
      '</current_plan>',
      'The block above is the CURRENT task plan — short fields only. Choose how to respond:',
      '- To answer a question or discuss, reply in plain prose (no JSON).',
      TASK_QUERY_REMINDER,
      ...taskOpsProtocol(execNote),
    ].filter(Boolean).join('\n');
  }

  /** One line per task with stable references — null until the plan has tasks. */
  private currentPlanLines(): string[] | null {
    const tasks = this.host.tasks();
    if (!this.host.plan() || tasks.length === 0) return null;
    const orderOf = new Map(tasks.map((t) => [t.id, `#${t.order}`]));
    return tasks.map((t) => {
      const isMan = t.type === 'user';
      // A MAN task has no model or mode to run under — the field that means
      // something there is how many steps the human still has to do.
      const runFields = isMan
        ? `steps:${t.userSteps?.length ?? 0}`
        : `${t.assignedModel ? `model:${t.assignedModel.modelId} ` : ''}mode:${t.taskMode ?? 'build'} effort:${t.thinkingEffort ?? '-'}`;
      return `#${t.order} id=${t.id} "${t.title}" [${t.status}] type:${isMan ? 'MAN' : 'AI'} runner:${t.assignedRunner} ${runFields} autonomy:${t.autonomy ?? '-'} slice:${t.sliceType ?? '-'} deps:[${t.dependencies.map((d) => orderOf.get(d) ?? d).join(', ')}]`;
    });
  }
}
