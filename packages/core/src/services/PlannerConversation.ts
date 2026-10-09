import { v4 as uuidv4 } from 'uuid';
import type { ConversationRequest, ConversationTurn, IAiService } from './AiService';
import { repairLoop, taskOpsRejectedPrompt } from './PlanRepair';
import { renderTaskQueryAnswer, taskQuerySignature, TASK_QUERY_ANSWER_OR_OPS, TASK_QUERY_REMINDER, TASK_READ_TOOLS_REMINDER, type LiveOutputLookup, type TaskQuery, type TaskQueryCatalog } from './TaskQuery';
import { taskOpsProtocol, refMatchesTask, taskOpRefs, type ApplyTaskOpsResult, type TaskOp } from './TaskOps';
import { resolveDefaultMode } from './ModeResolver';
import type { PlannerTurnOutcome, SessionBroadcaster } from './SessionMessage';
import { TurnStream } from './replyStream';
import type { ForkedDialogue } from './conversationFork';
import { condensedNotice, extractSummary, keptTail, summaryRequest } from './conversationSummary';
import type { ConversationMessage, LegacyPlanState, ResearchLogEntry, ResearchProgress, RunnerId, Task } from '../models/Task';
import { flattenTasks, isUserMessage } from '../models/Task';
import { plannerMessage, plannerTranscript, skillLoadLabel, skillLoadNotice, type SkillInvocation } from './skillInvocation';

/**
 * Per-runner model cap for the always-on catalog block. Generous enough that
 * a typical single-agent catalog (dozens of models) is never truncated —
 * only runners that aggregate hundreds of models (e.g. OpenRouter) hit it.
 */
const CATALOG_MODEL_CAP = 100;

/** Stands in for the catalog block where the planner pulls the catalog itself (ADR-0022, L3). */
const PLANNER_TOOLS_REMINDER =
  'Runners, models and modes may have changed since you last read them: call list_runners and list_models just before submit_plan.';

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

/**
 * Spend one read from the turn's budget, whichever channel it came over.
 * Refused at the hard limit; otherwise answered, and told to land the turn
 * once the soft limit is spent or the planner asks the identical question
 * again — a loop, not a read.
 */
function spendRead(reads: ReadBudget, signature: string): 'refused' | 'answer' | 'land' {
  if (reads.answered >= MAX_TASK_QUERIES_HARD) return 'refused';
  const land = reads.seen.has(signature) || reads.answered >= MAX_TASK_QUERIES;
  reads.seen.add(signature);
  reads.answered++;
  return land ? 'land' : 'answer';
}

/**
 * The planner turn (see CONTEXT.md): the one piece of planner work that holds
 * the conversation, from its claim to its settled outcome. Its signal is what a
 * stop aborts.
 */
export class PlannerTurn {
  private readonly controller = new AbortController();
  private dropped = false;

  get signal(): AbortSignal { return this.controller.signal; }

  /** The plan it was answering was dropped under it, so nothing it settles may land. */
  get abandoned(): boolean { return this.dropped; }

  stop(): void { this.controller.abort(); }

  abandon(): void {
    this.dropped = true;
    this.controller.abort();
  }
}

/**
 * How a turn takes the conversation: a turn that continues the dialogue is
 * refused while another is live, and one that starts a fresh plan supersedes
 * it — the plan the live one was answering is being dropped anyway.
 */
type TurnAdmission = { refuseAs: string } | 'supersede';

/** A turn with every read already drained — what the settle path actually commits. */
type SettleableTurn = Exclude<ConversationTurn, { kind: 'task_query' }>;
type CommitTurn = Exclude<SettleableTurn, { kind: 'task_ops' }>;

/** One user turn, from the message to its settled outcome: every backend call it makes streams through `stream`. */
interface UserTurn {
  stream: TurnStream;
  planner: PlannerTurn;
  signal: AbortSignal;
  /** The plan the turn is answering; a settle that finds another one current lands nothing. */
  plan: LegacyPlanState | null;
  reads: ReadBudget;
  /** Handed in since the backend last answered; see {@link PlannerConversation.submit}. */
  submitted?: PlannerSubmission;
}

/** A read made through a planner tool: refused once the turn's budget is gone, else answered, told to land when the budget asks it to. */
export type ToolRead<T> = { status: 'refused' } | { status: 'answered'; value: T; landNow: boolean };

/** A plan or task edit handed to the open turn over a channel other than its reply (ADR-0022). */
export type PlannerSubmission =
  | { kind: 'plan'; tasks: Task[] }
  | { kind: 'task_ops'; ops: TaskOp[] };

interface SettledTurn {
  plan: LegacyPlanState;
  outcome: Exclude<PlannerTurnOutcome, 'stopped' | 'error'>;
}

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
  tasks(): readonly Task[];
  /**
   * The orchestrator's live capture for a task's latest attempt, backing the
   * `output` field of a read. Injected the same way as the catalog so the
   * conversation never reaches into execution state directly.
   */
  liveOutput: LiveOutputLookup;
  isExecuting(): boolean;
  /** The session's single mutation ritual: op → persist → notify (default: the plan). */
  mutate(op: () => boolean, notify?: () => void): LegacyPlanState | null;
  broadcast: SessionBroadcaster;
  /** `turnId`: the planner turn whose commit this is, when one is. */
  broadcastPlan(turnId?: string): void;
  /** Validate a batch against live state. Pure — nothing is applied. */
  validateOps(ops: TaskOp[]): ApplyTaskOpsResult;
  /** Load planner-produced tasks: an edit keeps run state, a commit starts over. Returns how many landed. */
  adoptTasks(tasks: readonly Task[], how: 'edit' | 'commit'): number;
  capturePrd(text: string): void;
  /** Park a structural edit until the next batch boundary. Returns the queue length. */
  queueEdit(userMessage: string): number;
  /** Wake a scheduler an applied edit may have unblocked. */
  afterEdit(): Promise<void>;
  /** The planner turn was stopped or abandoned: whatever it is waiting on (a parked approval) will never be answered. */
  turnAborted(): void;
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

/**
 * A planner turn that settled after the plan it was answering was dropped (a
 * new plan, another session adopted, the session closed), or after its call
 * was cut off by something other than its own stop. Nothing it produced was
 * committed: landing it would write one session's reply into another's
 * transcript.
 */
export class PlannerTurnDiscardedError extends Error {
  constructor(options?: ErrorOptions) {
    super('The planner turn was discarded: the plan it was answering is no longer the current one.', options);
    this.name = 'PlannerTurnDiscardedError';
  }
}

/**
 * The user stopped the turn and the backend reported that as a thrown error
 * rather than a settled reply. Typed so a surface can stay quiet for it without
 * reading the message: some SDKs' abort errors are plain `Error`s by name, and
 * a real failure can mention "aborted" too.
 */
export class PlannerTurnStoppedError extends Error {
  constructor(options?: ErrorOptions) {
    super('The planner turn was stopped.', options);
    this.name = 'PlannerTurnStoppedError';
  }
}

/**
 * What a turn that threw should surface. Its own stop or abandonment is why it
 * ended, whatever the backend called the error it threw on the way out; the
 * original is kept as the cause, since the turn may also have failed for real.
 */
function interrupted(planner: PlannerTurn, err: unknown): unknown {
  if (err instanceof PlannerTurnDiscardedError) return err;
  if (planner.abandoned) return new PlannerTurnDiscardedError({ cause: err });
  if (planner.signal.aborted) return new PlannerTurnStoppedError({ cause: err });
  return err;
}

/** Width of a rewind target's preview — one picker row, not the whole message. */
const REWIND_PREVIEW_WIDTH = 80;

/** A user message a rewind can fork the conversation from just before. */
export interface RewindTarget {
  /** Position in the transcript — what {@link PlannerConversation.cloneBefore} takes. */
  index: number;
  preview: string;
  /** The whole message — the preview cuts it to one line, and a surface confirming the rewind quotes it. */
  content: string;
  timestamp: string;
}

/** What a rewind forks from, and the message it lands just before. */
export interface RewoundDialogue {
  dialogue: ForkedDialogue;
  rewoundMessage: string;
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
  readonly savedInBackground: number;
}

export interface ReplyOptions {
  signal?: AbortSignal;
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
 * be replaced by a summary, or copied into a fork, without the model's memory
 * drifting from it.
 */
export class PlannerConversation {
  /** Bumped on every persist, so a rollback can tell whether its writes already reached disk. */
  private persisted = 0;
  /** Saves an execution event made while a turn may be in flight; see {@link restore}. */
  private savedInBackground = 0;
  private live: PlannerTurn | null = null;
  private openTurn: UserTurn | null = null;

  constructor(private readonly host: PlannerConversationHost) {}

  get transcript(): readonly ConversationMessage[] {
    return this.host.plan()?.conversationHistory ?? [];
  }

  /** Whether a planner turn holds the conversation. */
  get isTurnInFlight(): boolean {
    return this.live !== null;
  }

  /** Stop the planner turn in flight; it settles as stopped. False when none is. */
  stopTurn(): boolean {
    if (!this.live) return false;
    this.live.stop();
    return true;
  }

  /**
   * Drop the planner turn in flight together with the plan it was answering:
   * it is stopped, whatever it settles is discarded, and the conversation is
   * free at once rather than when the abandoned turn finishes unwinding.
   */
  abandonTurn(): void {
    const turn = this.live;
    if (!turn) return;
    this.live = null;
    turn.abandon();
  }

  /**
   * Run planner work that is not a conversation turn — one-shot plan
   * generation — as the planner turn, so it is stopped, refused and superseded
   * like one. It starts a fresh plan, so it supersedes the turn in flight.
   */
  async hold<T>(signal: AbortSignal | undefined, body: (turn: PlannerTurn) => Promise<T>): Promise<T> {
    const { turn, release } = this.claim('supersede', signal);
    try {
      return await body(turn);
    } catch (err) {
      throw interrupted(turn, err);
    } finally {
      release();
    }
  }

  /**
   * Take the conversation for a new planner turn. A caller's own signal stops
   * the turn too; the relay is detached on release because a caller may reuse
   * that signal, and a stale listener would stop the next turn with it.
   */
  private claim(admission: TurnAdmission, callerSignal?: AbortSignal): { turn: PlannerTurn; release: () => void } {
    if (admission === 'supersede') this.abandonTurn();
    else if (this.live) throw new ConversationBusyError(admission.refuseAs);
    const turn = new PlannerTurn();
    this.live = turn;
    turn.signal.addEventListener('abort', () => this.host.turnAborted(), { once: true });
    const relay = () => turn.stop();
    if (callerSignal?.aborted) turn.stop();
    else callerSignal?.addEventListener('abort', relay, { once: true });
    return {
      turn,
      release: () => {
        callerSignal?.removeEventListener('abort', relay);
        // An abandoned turn gave the slot up already, maybe to its successor.
        if (this.live === turn) this.live = null;
      },
    };
  }

  /** The user turn being answered, for what the host raises during it — an approval the turn's research asks for. */
  get currentTurnId(): string | undefined {
    return this.openTurn?.stream.turnId;
  }

  /**
   * Hand the open turn a plan (already validated) or a task edit. The turn
   * settles with it exactly as with the same plan or ops parsed out of its
   * reply, and it wins over any envelope that reply carries. A later
   * submission replaces an earlier one. False when no user turn is open.
   */
  submit(submission: PlannerSubmission): boolean {
    if (!this.openTurn) return false;
    this.openTurn.submitted = submission;
    return true;
  }

  /**
   * The edit the open turn already holds, for a further edit in the same reply
   * to join rather than replace. Empty when it holds nothing; null when it holds
   * a whole plan, which an edit cannot be layered on.
   */
  pendingOps(): TaskOp[] | null {
    const held = this.openTurn?.submitted;
    if (!held) return [];
    return held.kind === 'task_ops' ? held.ops : null;
  }

  /** Whether the turn would park this edit until a batch boundary instead of applying it as it settles. */
  editWouldQueue(ops: TaskOp[]): boolean {
    return this.editTouchesLiveWork({ kind: 'task_ops', ops, text: '', researchLog: [] });
  }

  /**
   * A read the planner makes through a tool. It spends the same per-turn budget
   * as an envelope read, so a planner cannot read more by switching channels:
   * past the soft limit, or on a repeated question, the answer still comes but
   * is told to land the turn; at the hard limit it is refused. `signature`
   * names the question, for the repeat check.
   */
  async read<T>(signature: string, answer: () => Promise<T>): Promise<ToolRead<T>> {
    const reads = this.openTurn?.reads;
    if (!reads) return { status: 'answered', value: await answer(), landNow: false };
    const spent = spendRead(reads, signature);
    if (spent === 'refused') return { status: 'refused' };
    return { status: 'answered', value: await answer(), landNow: spent === 'land' };
  }

  /** Whether the model still holds this conversation in memory. */
  get isActive(): boolean {
    return this.host.aiService().hasActiveConversation();
  }

  append(role: ConversationMessage['role'], content: string, opts: { timestamp?: string; kind?: ConversationMessage['kind'] } = {}): void {
    this.appendEntries([{ role, content, timestamp: opts.timestamp ?? new Date().toISOString(), ...(opts.kind ? { kind: opts.kind } : {}) }]);
  }

  private appendEntries(entries: ConversationMessage[]): void {
    const plan = this.host.plan();
    if (plan) plan.conversationHistory = [...(plan.conversationHistory ?? []), ...entries];
  }

  /** Swap the whole transcript. The live context no longer matches it, so pair with {@link reset}. */
  replace(messages: readonly ConversationMessage[]): void {
    const plan = this.host.plan();
    if (plan) plan.conversationHistory = [...messages];
  }

  snapshot(): TranscriptSnapshot | null {
    const plan = this.host.plan();
    if (!plan) return null;
    return {
      plan,
      history: plan.conversationHistory,
      researchLog: plan.researchLog,
      persisted: this.persisted,
      savedInBackground: this.savedInBackground,
    };
  }

  /**
   * Put the dialogue back where {@link snapshot} found it — unless anything
   * was persisted since, because then memory already matches disk and every
   * surface, and undoing it would erase work the user has seen land. Also a
   * no-op once a different plan has been adopted.
   *
   * A background save (a task settling mid-turn) wrote the turn's writes to
   * disk without landing anything the user saw, so it does not stop the undo;
   * the undo is saved in turn, or a reload would bring the writes back.
   */
  restore(snapshot: TranscriptSnapshot): boolean {
    if (this.host.plan() !== snapshot.plan || this.persisted !== snapshot.persisted) return false;
    const undo = (): boolean => {
      snapshot.plan.conversationHistory = snapshot.history;
      snapshot.plan.researchLog = snapshot.researchLog;
      return true;
    };
    if (this.savedInBackground === snapshot.savedInBackground) undo();
    else this.host.mutate(undo, () => {});
    return true;
  }

  /**
   * The host calls this after every persist. `background` is a save no call
   * of the user's made — an execution event landing mid-turn.
   */
  markPersisted(opts: { background?: boolean } = {}): void {
    if (opts.background) this.savedInBackground++;
    else this.persisted++;
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
      if (!isUserMessage(m) || index === 0) return [];
      const line = m.content.split('\n')[0];
      const preview = line.length > REWIND_PREVIEW_WIDTH ? `${line.slice(0, REWIND_PREVIEW_WIDTH - 1)}…` : line;
      return [{ index, preview, content: m.content, timestamp: m.timestamp }];
    });
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
    // A planner turn, so a message sent while it runs is refused: the reply
    // would share the summary turn's live context, which the compaction resets
    // as it lands, and its message would be condensed away or left dangling.
    const { turn, release } = this.claim({ refuseAs: 'condense the conversation' }, signal);
    try {
      const summary = await this.summarize(turn.signal);
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
      // Success and failure alike: the live context either holds the
      // conversation this replaced or a summary exchange nobody kept. An
      // abandoned compaction's context was dropped by whatever abandoned it,
      // and a reset now would cut off the turn that has the backend since.
      if (!turn.abandoned) this.reset();
      release();
    }
  }

  private async summarize(signal: AbortSignal): Promise<string> {
    const ai = this.host.aiService();
    const request = summaryRequest(this.currentPlanLines());
    // Only liveness gets through: streamed prose or research steps from this
    // turn would land in the chat as if the planner had said them.
    const onProgress = (p: ResearchProgress) => { if (p.type === 'liveness') this.host.onProgress(p); };
    let turn: ConversationTurn;
    if (this.canContinueLive()) {
      ai.pruneContext?.();
      turn = await ai.continueConversation(request, onProgress, signal);
    } else {
      turn = await this.resume(request, [...this.transcript], signal, onProgress);
    }
    if (signal.aborted) throw new ConversationEditError('Condensing was stopped — the conversation is unchanged.');
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

  /**
   * A copy of the dialogue as it stood just before the user message at
   * `index` (a position from {@link rewindTargets}) — what a rewind forks
   * from — plus that message's full text, for a surface to offer back. This
   * conversation is not touched. The research trace is cut at the same point
   * by time: its entries carry no link to the message that caused them.
   */
  cloneBefore(index: number): RewoundDialogue {
    this.assertIdle('rewind the conversation');
    if (!this.rewindTargets().some((t) => t.index === index)) {
      if (index > 0) throw new ConversationEditError(`No user message at position ${index} to rewind to.`);
      throw new ConversationEditError(this.transcript[0]?.kind === 'compaction'
        ? 'The conversation was condensed there — a rewind cannot reach back past the summary.'
        : 'The first message is the goal — start a new session to change it.');
    }
    const { content: rewoundMessage, timestamp: cutoff } = this.transcript[index];
    return {
      dialogue: structuredClone({
        conversationHistory: this.transcript.slice(0, index),
        researchLog: (this.host.plan()?.researchLog ?? []).filter((e) => e.timestamp < cutoff),
      }),
      rewoundMessage,
    };
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

  /**
   * Queued edits the between-batches drain could not apply. Recorded so the
   * transcript does not go on promising a change that never landed. Call
   * inside the host's mutation ritual.
   */
  recordQueuedEditsFailed(messages: string[], reason: string): void {
    this.append('assistant', [
      'Queued change NOT applied — the plan is unchanged:',
      ...messages.map((m) => `- ${m}`),
      `Reason: ${reason}`,
    ].join('\n'), { kind: 'system' });
  }

  /**
   * Open the conversation on the host's fresh plan: the goal is its first
   * message. `prepare` (discovery) runs inside the turn, so a stop reaches it.
   */
  async start(goal: SkillInvocation, prepare: () => Promise<ConversationOpening>, signal?: AbortSignal): Promise<LegacyPlanState> {
    return this.userTurn('supersede', goal, signal, async (userTurn) => {
      const opening = await prepare();
      this.assertCurrent(userTurn);
      this.recordUser(goal, new Date().toISOString());
      const turn = await this.host.aiService().startConversation({
        ...opening,
        goal: plannerMessage(goal.text, goal.skills),
        onProgress: userTurn.stream.sink(),
        signal: userTurn.signal,
      });
      return this.settle(await this.drainTaskQueries(turn, userTurn), userTurn);
    });
  }

  /**
   * Every later user message, from the transcript append to a persisted
   * outcome. A turn that throws before anything was persisted takes its own
   * writes back out, so session memory never drifts from disk and the UI.
   */
  async reply(message: string | SkillInvocation, options: ReplyOptions = {}): Promise<LegacyPlanState> {
    const sent = typeof message === 'string' ? { text: message, skills: [] } : message;
    // Refused while any turn is live: two would interleave their transcript
    // appends, and each would settle on the other's open turn.
    return this.userTurn({ refuseAs: 'send a message' }, sent, options.signal, (userTurn) => this.replyTurn(sent, userTurn));
  }

  private async replyTurn(message: SkillInvocation, userTurn: UserTurn): Promise<SettledTurn> {
    const { signal } = userTurn;
    const plan = this.requirePlan();
    const priorHistory = plan.conversationHistory ?? [];
    const checkpoint = this.snapshot();
    this.recordUser(message, new Date().toISOString());

    // The persisted transcript keeps the raw user message; the model gets the
    // live catalog (always) and the current plan (tasks, statuses, edit
    // protocol — once tasks exist) alongside it.
    const contextBlock = [this.catalogBlock(), this.planContextBlock()].filter(Boolean).join('\n\n');
    const said = plannerMessage(message.text, message.skills);
    const outgoing = contextBlock ? `${contextBlock}\n\n${said}` : said;

    const ai = this.host.aiService();
    try {
      const turn = this.canContinueLive()
        ? await ai.continueConversation(outgoing, userTurn.stream.sink(), signal)
        : await this.resume(outgoing, priorHistory, signal, userTurn.stream.sink());

      // Reads settle before the execution gate below, so a query is answered
      // on the spot even mid-run: it mutates nothing, and parking it behind a
      // batch boundary would strand the planner waiting on detail it needs to
      // write the very edit that gets queued.
      let settleable = await this.drainTaskQueries(turn, userTurn);
      this.assertCurrent(userTurn, settleable);

      // Structural changes that reach a task a runner is executing are queued,
      // never applied live — the orchestrator must not have the plan mutated
      // under a running batch in a way that changes that task. The gate is a
      // live runner *and* an edit that touches it: an edit to any other task,
      // or an added task, is reconciled into the plan now and the running batch
      // keeps going. A paused scheduler with no runner live queues nothing.
      if (this.editTouchesLiveWork(settleable)) {
        const queued = this.host.queueEdit(message.text);
        settleable = {
          kind: 'message',
          text: `Execution is running, so I queued your change — it will be applied between task batches (${queued} queued).`,
          researchLog: settleable.researchLog,
        };
      }

      return await this.settle(settleable, userTurn);
    } catch (err) {
      // An abandoned turn gave the conversation up already, and a rollback now
      // could take the next turn's message out along with its own.
      if (checkpoint && !userTurn.planner.abandoned) this.restore(checkpoint);
      throw err;
    }
  }

  /**
   * Whether a settled structural edit reaches work a runner is executing. Only
   * these are queued: a whole-plan commit replaces the plan and would reset the
   * run, and a task-ops batch that names an in-progress task changes it under
   * the runner. An add, or an edit to any other task, is reconciled into the
   * plan in place while the running batch keeps going.
   */
  private editTouchesLiveWork(turn: SettleableTurn): boolean {
    if (turn.kind === 'plan') return this.host.isExecuting();
    if (turn.kind !== 'task_ops') return false;
    const running = flattenTasks(this.host.tasks()).filter((t) => t.status === 'in_progress');
    if (running.length === 0) return false;
    return turn.ops.some((op) => taskOpRefs(op).some((ref) => running.some((task) => refMatchesTask(ref, task))));
  }

  private assertIdle(operation: string): void {
    if (this.isTurnInFlight) throw new ConversationBusyError(operation);
  }

  /**
   * Refuse to land a turn that no longer belongs here: it was abandoned, its
   * plan is no longer the host's, or its call was cut off by something other
   * than its own stop (`IAiService.reset` under a plan change) — what such a
   * call hands back is a fragment of an answer to a dialogue that is gone.
   */
  private assertCurrent(userTurn: UserTurn, turn?: SettleableTurn): void {
    const cutOff = turn?.kind === 'message' && turn.aborted === true && !userTurn.signal.aborted;
    if (userTurn.planner.abandoned || this.host.plan() !== userTurn.plan || cutOff) throw new PlannerTurnDiscardedError();
  }

  /**
   * A live conversation is only safe to continue in-place when it also
   * matches the model/effort configured right now — a harness planner's
   * running process was spawned with the old one baked in and cannot pick up
   * a switch (ADR-0009). Otherwise the turn resumes from the transcript.
   */
  private canContinueLive(): boolean {
    const ai = this.host.aiService();
    return ai.hasActiveConversation() && (ai.conversationMatchesConfig?.() ?? true);
  }

  /**
   * Bracket one user turn with its start and end, under an id minted here:
   * the turn is where the stream a surface draws begins and ends, and only the
   * conversation sees all of it — every backend call, read and retry.
   */
  private async userTurn(admission: TurnAdmission, prompt: SkillInvocation, signal: AbortSignal | undefined, run: (turn: UserTurn) => Promise<SettledTurn>): Promise<LegacyPlanState> {
    const { turn: planner, release } = this.claim(admission, signal);
    const turnId = uuidv4();
    const stream = new TurnStream(turnId, (p) => this.host.onProgress(p));
    const turn: UserTurn = { stream, planner, signal: planner.signal, plan: this.host.plan(), reads: freshReadBudget() };
    this.openTurn = turn;
    const skills = prompt.skills.map(skillLoadNotice);
    this.host.broadcast({ type: 'planner_turn_started', turnId, prompt: prompt.text, ...(skills.length > 0 ? { skills } : {}) });
    let outcome: PlannerTurnOutcome = 'error';
    try {
      const settled = await run(turn);
      outcome = settled.outcome;
      return settled.plan;
    } catch (err) {
      if (err instanceof PlannerTurnDiscardedError) {
        outcome = 'stopped';
        throw err;
      }
      throw interrupted(planner, err);
    } finally {
      if (this.openTurn === turn) this.openTurn = null;
      // Released before the end is announced, so a surface that sends its
      // next message on hearing it is not refused by the turn it heard end.
      release();
      // A stop can still settle — a backend hands back what it had as a
      // message — but the user asked for it to end, and that is what it did.
      this.host.broadcast({ type: 'planner_turn_ended', turnId, outcome: planner.signal.aborted ? 'stopped' : outcome });
    }
  }

  private requirePlan(): LegacyPlanState {
    const plan = this.host.plan();
    if (!plan) throw new Error('No active plan state');
    return plan;
  }

  /** The message as typed, then one entry per skill it loaded, sharing its timestamp so a reload keeps them together. */
  private recordUser({ text, skills }: SkillInvocation, timestamp: string): void {
    this.appendEntries([
      { role: 'user', content: text, timestamp },
      ...skills.map((skill): ConversationMessage => ({ role: 'user', content: skillLoadLabel(skill), timestamp, kind: 'skill_load', skill })),
    ]);
    this.recordResearch([{ id: `up-${Date.now()}`, type: 'user_prompt', content: text, timestamp }]);
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
    signal: AbortSignal,
    onProgress: (progress: ResearchProgress) => void,
  ): Promise<ConversationTurn> {
    const runners = this.requirePlan().runners;
    const opening = await this.host.opening(runners);
    const replayed = plannerTranscript(priorHistory);
    // The opening message as the planner first saw it — skill bodies included,
    // as `start` composed it — unless a compaction has since condensed it away.
    const opener = priorHistory[0] && isUserMessage(priorHistory[0]) ? replayed[0].content : undefined;
    const goal = opener || this.host.goal() || message;
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
      priorHistory: replayed,
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
  private async drainTaskQueries(turn: ConversationTurn, userTurn: UserTurn): Promise<SettleableTurn> {
    const { reads, signal, stream } = userTurn;
    const ai = this.host.aiService();
    const carried: ConversationTurn['researchLog'] = [];
    let current = this.claimSubmission(turn, userTurn);
    while (current.kind === 'task_query') {
      carried.push(...current.researchLog);
      const spent = ai.hasActiveConversation() && !signal.aborted ? spendRead(reads, taskQuerySignature(current.query)) : 'refused';
      if (spent === 'refused') {
        return {
          kind: 'message',
          text: 'The planner kept asking to read tasks instead of answering. Nothing was changed — ask again, or be more specific about the edit you want.',
          researchLog: carried,
        };
      }
      const answer = this.taskQueryAnswer(current.query);
      current = this.claimSubmission(await ai.continueConversation(
        spent === 'land' ? `${answer}\n\n${TASK_QUERY_ANSWER_OR_OPS}` : answer,
        stream.sink(),
        signal,
      ), userTurn);
    }
    return carried.length > 0
      ? { ...current, researchLog: [...carried, ...current.researchLog] }
      : current;
  }

  /**
   * The backend's answer, with what was handed in while it ran standing in
   * for whatever its reply carried. Taken once: a corrective re-send after a
   * rejected edit must not settle on the same submission again. A stopped
   * turn commits nothing, the same as a stopped reply with a plan in it.
   */
  private claimSubmission(turn: ConversationTurn, userTurn: UserTurn): ConversationTurn {
    const submitted = userTurn.submitted;
    userTurn.submitted = undefined;
    if (!submitted || userTurn.signal.aborted) return turn;
    const { text, researchLog } = turn;
    return submitted.kind === 'plan'
      ? { kind: 'plan', tasks: submitted.tasks, text, researchLog }
      : { kind: 'task_ops', ops: submitted.ops, text, researchLog };
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
   * Drive a planner turn, its reads already drained, to a persisted, broadcast
   * outcome. Task edits apply atomically; validation failures are fed back to
   * the model for up to 2 silent retries, then surfaced as a message with the
   * plan untouched. The first turn and every later turn route through here —
   * one path, not two.
   */
  private async settle(turn: SettleableTurn, userTurn: UserTurn): Promise<SettledTurn> {
    type Settled = { plan: LegacyPlanState } | { turn: CommitTurn };
    const { signal, stream } = userTurn;
    const ai = this.host.aiService();
    const invalidOps = (errors: string[], researchLog: ConversationTurn['researchLog']): Settled => ({
      turn: {
        kind: 'message',
        text: `I tried to modify the tasks, but the changes were invalid:\n- ${errors.join('\n- ')}\n\nThe plan is unchanged. Rephrase the request, or adjust the tasks manually.`,
        researchLog,
      },
    });

    const settled = await repairLoop<SettleableTurn, Settled>({
      first: async () => turn,
      resend: async (corrective) => {
        stream.retract();
        return this.drainTaskQueries(await ai.continueConversation(corrective, stream.sink(), signal), userTurn);
      },
      interpret: (t) => {
        if (t.kind !== 'task_ops') return { done: { turn: t } };
        this.assertCurrent(userTurn, t);
        const applied = this.applyTaskOps(t, stream.turnId);
        if ('plan' in applied) return { done: { plan: applied.plan } };
        // No live conversation (or an abort) means no corrective re-send is
        // possible — surface the failure instead of retrying into the void.
        if (!ai.hasActiveConversation() || signal.aborted) {
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
      return { plan: settled.plan, outcome: 'task_ops' };
    }
    this.assertCurrent(userTurn, settled.turn);
    return { plan: this.commit(settled.turn, stream.turnId), outcome: settled.turn.kind };
  }

  /** Validate + commit a task_ops turn atomically. Returns the errors on rejection (plan untouched). */
  private applyTaskOps(turn: Extract<ConversationTurn, { kind: 'task_ops' }>, turnId: string): { plan: LegacyPlanState } | { errors: string[] } {
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
        this.host.broadcast({ type: 'planner_message', content, timestamp: now, turnId });
        this.host.broadcastPlan();
      },
    );
    return { plan: plan! };
  }

  /** Commit a settled (non-task_ops) turn through the host's mutation ritual. */
  private commit(turn: CommitTurn, turnId: string): LegacyPlanState {
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
      }, () => this.host.broadcastPlan(turnId))!;
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
      () => this.host.broadcast({ type: 'planner_message', content: text, timestamp: now, turnId }),
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
   * admitted mid-session by a retarget is shown like every other. A planner
   * with Ordewell's tools gets a reminder to read the catalog instead.
   */
  private catalogBlock(): string | null {
    if (!this.host.plan()) return null;
    if (this.host.aiService().plannerToolsAttached?.()) return PLANNER_TOOLS_REMINDER;
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
    const tools = this.host.aiService().plannerToolsAttached?.() ?? false;
    // Gated on live runners, not on an armed scheduler: a paused-but-armed run
    // takes edits immediately, so promising a queue there is a lie the model
    // plans around (it stops emitting ops and asks the user to wait).
    const locked = tasks.filter((t) => t.status === 'in_progress');
    const execNote = this.host.isExecuting()
      ? `\nExecution is RUNNING${locked.length ? ` — these tasks are locked: ${locked.map((t) => `#${t.order}`).join(', ')}` : ''}. Any task edits you emit will be queued and applied between batches.`
      : '';
    return [
      '<current_plan>',
      ...lines,
      '</current_plan>',
      'The block above is the CURRENT task plan — short fields only. Choose how to respond:',
      '- To answer a question or discuss, reply in plain prose (no JSON).',
      tools ? TASK_READ_TOOLS_REMINDER : TASK_QUERY_REMINDER,
      ...taskOpsProtocol(execNote, tools),
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
      return `#${t.order} id=${t.id} "${t.title}" [${t.status}] type:${isMan ? 'MAN' : t.ops ? 'AI ops' : 'AI'} runner:${t.assignedRunner} ${runFields} autonomy:${t.autonomy ?? '-'} slice:${t.sliceType ?? '-'} deps:[${t.dependencies.map((d) => orderOf.get(d) ?? d).join(', ')}]`;
    });
  }
}
