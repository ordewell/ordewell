import { EventEmitter } from 'events';
import type { IRunner, IRunnerSession, QueuedTaskMessage, StructuredEvent, StructuredTurnEnd, TaskMessageFrom } from '../interfaces/IRunner';
import type { RunnerCommand } from '../models/RunnerCommand';
import type { Task, VerificationCheck } from '../models/Task';
import { checkHandoff, type HandoffCheck, type SubtreeReport } from '../models/Handoff';
import { countChildTasks, underProtectedPath, type ChildTaskCounts } from '../models/Delegation';
import { onOneLine } from '../models/lineBreaks';
import type { UsageRecord } from '../models/Usage';
import { AbstractRunner, AbstractRunnerSession, type RunnerSpawnOptions } from './AbstractRunner';
import type { CheckpointAnswer, McpToolReply, TaskCompleteArgs } from './mcp/tools';

/** Why a node may do nothing more, and the status that ends it with (ADR-0056 M5, M8). */
export interface NodeEnd {
  why: string;
  ends: 'blocked' | 'failed';
}

/** What a parent reads of a child (ADR-0055 D6), all of it read afresh from the child's plan and run. */
export interface NodeState {
  /** What keeps a `done` from being taken, in the words of a refusal; empty once the run has settled and landed. */
  unfinished: readonly string[];
  /** Tasks that finished with a pass. */
  completed: number;
  /** An attempt is live, or a run is opening or merging. */
  live: boolean;
  /** A planner turn holds the conversation, or waits for it. */
  plannerBusy: boolean;
  /** Something gathered for the subplanner will open a turn by itself. */
  wakeOwed: boolean;
  /** Why this node stops now, or null: what ends it with no call of its own. */
  stoppedFor: NodeEnd | null;
  /** Why nothing may start here though what is in flight may finish, or null (ADR-0056 M10). */
  withdrawn: string | null;
  /** Why what is ready cannot start, with nothing live to free room: its subplanner is told first, and it ends `blocked` if nothing comes of that (ADR-0056 M5). */
  startRefused: string | null;
  /** One line per task, as a derived report lists them. */
  tasks: readonly { label: string; status: Task['status'] }[];
}

/** A subplanner's report once Ordewell has read what it names (ADR-0057 R2). */
export type TakenReport = TaskCompleteArgs & { subtree?: SubtreeReport };

/** The child, as its attempt drives it: nothing of the Session it is, or of a surface. */
export interface ChildNode {
  readonly sessionId: string;
  /** Its protected paths, its ancestors' with them (ADR-0056 M4). */
  readonly protectedPaths: readonly string[];
  /** The time it has to run in (ADR-0056 M3). */
  readonly wallClockMs: number | null;
  /** How much of the time since `since` its tree is held on a usage limit, which is not on its clock (M3). */
  heldSince(since: number): number;
  startPlanning(goal: string): Promise<unknown>;
  continueConversation(text: string): Promise<unknown>;
  /** Reopened (ADR-0055 D17): acts as Execute there, and its subplanner goes on with `text`; one that never wrote a plan plans `goal`. */
  goOn(text: string, goal: string): Promise<unknown>;
  /** A line for the subplanner's next turn, which opens none (ADR-0057 R6): a landing is no reason to wake it. */
  hear(line: string): void;
  state(): NodeState;
  /** A report held to its plan and subtree, its references pinned and what crosses a level read verbatim (ADR-0057 R1, R2). */
  takeReport(report: TaskCompleteArgs): HandoffCheck<TakenReport>;
  /** End its subtree (D16). Resolves once nothing of it is left, however long that takes. */
  halt(): Promise<void>;
  /** Let its Session go, and what it did not spend return (ADR-0056 M5). */
  close(): Promise<void>;
}

/** What a subplanner's token calls and what its Session tells of itself, bound to one attempt (ADR-0055 D5). */
export interface SubplannerLink {
  taskComplete(report: TaskCompleteArgs): Promise<McpToolReply>;
  checkpoint(question: string): McpToolReply;
  /** Something changed that a verdict or the completion reminder may read. */
  changed(): void;
  /** A Stop stands over this node, its own or an ancestor's (ADR-0055 D16). */
  stopped(): boolean;
  /** What its planner or a task spent, as it arrives: charged where it was spent, and rolled up to each level for its row (ADR-0055 D20). */
  usage(record: UsageRecord): void;
  /** The attempt is still open, so a person's message has a turn to reach (D20). */
  listening(): boolean;
  /** A turn a person's message opens: the attempt waits for it, and owes it nothing. */
  spoken(turn: () => Promise<unknown>): void;
}

/** The parent, as a child's attempt needs it. */
export interface ChildHost {
  /**
   * Carve the child's mandate and budget, and build it in `cwd` (ADR-0056 M4,
   * M5), or the child `reopening` from its saved file (ADR-0055 D17). Rejects,
   * naming the level, for what cannot be carved.
   */
  openChild(task: Task, cwd: string, link: SubplannerLink, reopening?: string): Promise<ChildNode>;
  /** What the delegated task's branch changed since its base, relative to the workspace root. */
  changedPaths(taskId: string): Promise<string[]>;
  /** A Stop stands over this node: what its children read of their ancestors (D16). */
  stopped(): boolean;
  /** Usage on its way up the tree, past this level's row. */
  passUp(record: UsageRecord): void;
  /** A child's tasks moved, so the row of its delegated task is stale (ADR-0055 D20). */
  moved(): void;
}

/** Once per attempt: a subplanner told this has no second turn to end without the call (ADR-0055 D6). */
const COMPLETION_REMINDER = 'Your turn ended with nothing running and no `task_complete` call. If your child plan reached the goal, call `task_complete` with status `done`; if it cannot, call it with status `blocked` or `failed` and the reason. If work is left, start it now. A second turn that ends like this fails the delegated task.';

/** A subplanner parks on its question: a call that blocked would hold a process and a slot for as long as a person takes (ADR-0056 M8). */
const QUESTION_ASKED = 'Asked. End your turn now: the answer opens your next turn. A question nobody answers ends with your time limit.';

/** One at a time, as a runner's are (ADR-0022 V5). */
const QUESTION_WAITS = 'Your last question has no answer yet: end your turn, and its answer opens your next one.';

/** What opens the subplanner's next turn. */
function answerText(answer: Exclude<CheckpointAnswer, { kind: 'withdrawn' }>): string {
  if (answer.kind === 'rejected') return `The plan above answered your question: rejected. ${answer.reason}`;
  return `The plan above answered your question: approved, so go on.${answer.note ? ` ${answer.note}` : ''}`;
}

/** How many paths a report names of what its branch changed outside its scope. */
const OUTSIDE_SCOPE_PATHS = 20;

/** A child's usage as its delegated task's row reads it: spend, with no context meter, which is one session's and says nothing of a subtree. */
function rolledUp({ contextWindow: _window, contextTokens: _tokens, ...spend }: UsageRecord): UsageRecord {
  return spend;
}

/** How long a `task_complete` waits for the turn that made it to close before it is published anyway. */
const COMPLETION_GRACE_MS = 5000;

interface ChildPlanSetup {
  task: Task;
  cwd: string;
  host: ChildHost;
  /** A Continue (ADR-0055 D17): the child it reopens, and what its parent says to it. */
  resume?: { sessionId: string; message: string };
}

/**
 * One attempt of a delegated task (ADR-0055 D3): a child Session in its
 * worktree, behind the runner seam, so to its parent a subplanner is a runner.
 * The attempt has one turn, from its start to its verdict, whatever the
 * subplanner's own turns: `onTurnEnd` fires when the child ends, so ADR-0018's
 * waiting for input and completion reminder are not read off them. This reads
 * those turns itself, since nobody below the root waits for input (ADR-0056 M8).
 *
 * `task_complete` is the only way to a pass, and a subplanner saying done is
 * necessary and never sufficient: this holds it to D6 at the call.
 */
export class ChildPlanSession extends AbstractRunnerSession {
  private readonly events = new EventEmitter();
  private readonly turnEnds: Array<(reason: StructuredTurnEnd) => void> = [];
  private readonly completes: Array<(report: TaskCompleteArgs, refuted?: VerificationCheck) => void> = [];
  private node: ChildNode | null = null;
  private output = '';
  /** Turns this opened and has not seen end: until they do, a quiet child is one still opening. */
  private opening = 0;
  /** Turns a person's message opened and has not seen end. */
  private heard = 0;
  private reminded = false;
  /** The accepted call, until it is published. */
  private accepted: { report: TaskCompleteArgs; refuted?: VerificationCheck } | null = null;
  /** How the attempt raises a question: as a runner's `checkpoint` does, so the parent's task waits as any task at one. */
  private ask: ((question: string, signal: AbortSignal) => Promise<CheckpointAnswer>) | null = null;
  /** A question went up and has no answer: nothing is stuck, and only the wall clock ends the wait (ADR-0056 M8). */
  private asking = false;
  /** The attempt has its end: nothing after it counts. */
  private ended = false;
  private halting: NodeEnd | null = null;
  /** The Stop, recorded before anything is ended (D16): it is this attempt's, so a later attempt starts clear of it. */
  private tombstone = false;
  /** The child opening, which a Stop waits for: it cannot end what it has not got. */
  private seating: Promise<void> | undefined;
  private checkQueued = false;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private wallClock: ReturnType<typeof setTimeout> | undefined;
  private printed = new Map<string, string>();
  /** Where the child's tasks stood when its row last heard of them. */
  private counts: ChildTaskCounts | undefined;
  private stopping: Promise<void> | null = null;
  private markGone!: () => void;
  private readonly gone = new Promise<void>((resolve) => { this.markGone = resolve; });

  constructor(id: string, taskId: string, private readonly setup: ChildPlanSetup) {
    super(id, taskId);
  }

  /** Whoever spawned it attaches its listeners when the spawn resolves, so the child starts a macrotask later. */
  begin(): void {
    setImmediate(() => { this.seating = this.run(); });
  }

  private async run(): Promise<void> {
    if (this.tombstone) return;
    const { task, cwd, host, resume } = this.setup;
    try {
      this.node = await host.openChild(task, cwd, {
        taskComplete: (report) => this.taskComplete(report),
        checkpoint: (question) => this.checkpoint(question),
        changed: () => this.queueCheck(),
        stopped: () => this.tombstone || this.halting !== null || host.stopped(),
        usage: (record) => {
          this.emitEvent({ type: 'usage', record: rolledUp(record) });
          host.passUp(record);
        },
        listening: () => !this.ended && !this.accepted && !this.tombstone && !this.halting,
        spoken: (turn) => this.spoken(turn),
      }, resume?.sessionId);
    } catch (err) {
      // Refused, not failed: nothing ran, and what can be changed is the plan above (ADR-0056 M4).
      if (!this.tombstone) this.end('blocked', err instanceof Error ? err.message : String(err));
      return;
    }
    if (this.tombstone) return;
    this.watchClock(this.node, Date.now());
    this.opened(resume ? this.node.goOn(resume.message, task.goal ?? '') : this.node.startPlanning(task.goal ?? ''));
  }

  /** Read again as it runs out, so a hold found meanwhile moves it on (ADR-0056 M3). */
  private watchClock(node: ChildNode, started: number): void {
    if (node.wallClockMs === null) return;
    const left = started + node.wallClockMs + node.heldSince(started) - Date.now();
    if (left <= 0) {
      this.haltFor(`its time of ${node.wallClockMs} ms ran out`);
      return;
    }
    this.wallClock = setTimeout(() => this.watchClock(node, started), left);
    this.wallClock.unref?.();
  }

  /** A turn this opened: its end is one a check reads, and a failure in it ends the attempt, since no person reads it (ADR-0056 M8). */
  private opened(turn: Promise<unknown>): void {
    this.opening += 1;
    turn.then(
      () => this.turnSettled(),
      (err: unknown) => {
        this.turnSettled();
        // A turn this ended itself is no failure of its planner, nor is one refused at the gate, whose end the check owes, and a limit's resend opens the next.
        if (this.tombstone || this.halting) return;
        const state = this.node?.state();
        if (state?.stoppedFor || state?.withdrawn || state?.wakeOwed) return;
        this.end('failed', `Its planner could not go on: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
  }

  private turnSettled(): void {
    this.opening -= 1;
    this.queueCheck();
  }

  /**
   * A person is not the plan above: however their turn ends, it costs this
   * attempt nothing, so a reminder already spent is owed again and a turn that
   * failed goes to the check, not to a verdict (ADR-0055 D20).
   */
  private spoken(turn: () => Promise<unknown>): void {
    this.heard += 1;
    const settled = () => {
      this.heard -= 1;
      this.reminded = false;
      this.queueCheck();
    };
    turn().then(settled, settled);
  }

  private queueCheck(): void {
    if (this.checkQueued) return;
    this.checkQueued = true;
    setImmediate(() => {
      this.checkQueued = false;
      this.check();
    });
  }

  /**
   * What the child's state owes its attempt. Read after every change, so no
   * state of a child can sit with nothing to end it (ADR-0056 M8).
   */
  private check(): void {
    const node = this.node;
    if (!node || this.ended || this.tombstone) return;
    const state = node.state();
    this.say(state);
    if (this.accepted) {
      if (!state.plannerBusy) this.publish();
      return;
    }
    // A stop that came while a question waits waits with it: the answer is what can bring room, and M8 gives that wait only the wall clock.
    const stopped = this.halting ?? (this.asking ? null : state.stoppedFor);
    if (stopped) {
      if (!state.live && !state.plannerBusy) this.end(stopped.ends, this.derived(stopped.why, state));
      else this.haltFor(stopped.why, stopped.ends);
      return;
    }
    // Nothing starts now, and what is in flight finishes first (ADR-0056 M10).
    if (state.withdrawn) {
      if (!state.live && !state.plannerBusy) this.end('blocked', this.derived(state.withdrawn, state));
      return;
    }
    if (state.live || state.plannerBusy || state.wakeOwed || this.opening > 0 || this.heard > 0 || this.asking) return;
    if (state.startRefused) {
      this.haltFor(state.startRefused);
      return;
    }
    if (!this.reminded) {
      this.reminded = true;
      this.opened(node.continueConversation(COMPLETION_REMINDER));
      return;
    }
    this.end('failed', this.derived('its subplanner ended a second turn with nothing running and no task_complete call', state));
  }

  /** The node stops as a Stop does, and the attempt ends once it has (ADR-0056 M3, M5). */
  private haltFor(why: string, ends: NodeEnd['ends'] = 'blocked'): void {
    if (this.halting) return;
    this.halting = { why, ends };
    void this.node?.halt().then(() => this.queueCheck(), () => this.queueCheck());
  }

  /** A report nobody wrote, since no one is left to: only what the plan and run show, for the plan above to decide on. */
  private derived(why: string, state: NodeState): string {
    const tasks = state.tasks.map((t) => `${t.label}: ${t.status}`).join('; ');
    const owed = state.completed > 0 && state.unfinished.length === 0
      ? ' Everything it ran finished and only its report is missing: give it room and Continue it, since a fresh attempt starts its child over and discards that work.'
      : '';
    return `The child plan ended without a report: ${why.replace(/\.$/, '')}.${tasks ? ` Its tasks: ${tasks}.` : ' It holds no tasks.'}${owed}`;
  }

  /** The child's activity, as this attempt's log shows it (ADR-0055 D20): what a task became, not what its runner said. */
  private say({ tasks }: NodeState): void {
    const counts = countChildTasks(tasks.map(({ status }) => status));
    if (JSON.stringify(counts) !== JSON.stringify(this.counts)) {
      this.counts = counts;
      this.setup.host.moved();
    }
    for (const { label, status } of tasks) {
      if (this.printed.get(label) === status) continue;
      this.printed.set(label, status);
      this.print(`${label}: ${status}\n`);
    }
  }

  /** In its output and its log alike: what a person opens the task to read is this. */
  private print(text: string): void {
    this.output += text;
    this.outputEmitter.emit('output', text);
    this.emitEvent({ type: 'assistant_text', runId: this.id, text });
  }

  /**
   * The subplanner's `task_complete`, on the token bound to this attempt. D6's
   * first two tests refuse at the call and leave the attempt open; a protected
   * path fails the verdict instead, since that work cannot be taken back here.
   * `blocked` and `failed` are taken at any time: that is how a subtree gives up.
   */
  private async taskComplete(report: TaskCompleteArgs): Promise<McpToolReply> {
    if (this.ended || this.accepted || this.tombstone) return { text: 'This attempt has ended: nothing was recorded.', isError: true };
    // Its references resolve in its own plan and what is below it, never the parent's (ADR-0057 R1).
    const checked: HandoffCheck<TakenReport> = this.node?.takeReport(report) ?? checkHandoff(report, this.taskId, []);
    if (!checked.ok) return { text: checked.refusal, isError: true };
    let refuted: VerificationCheck | undefined;
    if (checked.handoff.status === 'done') {
      const refusal = await this.doneRefusal();
      if (refusal) return { text: refusal, isError: true };
      refuted = await this.protectedPathsTouched();
    }
    const outsideScope = await this.outsideScope();
    if (this.ended || this.accepted || this.tombstone) return { text: 'This attempt has ended: nothing was recorded.', isError: true };
    const { subtree } = checked.handoff;
    const taken = subtree && outsideScope ? { ...checked.handoff, subtree: { ...subtree, outsideScope } } : checked.handoff;
    this.accepted = { report: taken, ...(refuted ? { refuted } : {}) };
    this.emitEvent({ type: 'completion_received', status: checked.handoff.status });
    // The runner ends its turn on this reply; one that keeps it open is published at this grace.
    this.graceTimer = setTimeout(() => this.publish(), COMPLETION_GRACE_MS);
    this.graceTimer.unref?.();
    return { text: 'Recorded. End your turn now.' };
  }

  /**
   * The subplanner's question: it goes up as a checkpoint of this attempt, and
   * the call answers at once. Its answer opens the next turn, and a question
   * withdrawn with the attempt opens none.
   */
  private checkpoint(question: string): McpToolReply {
    if (this.ended || this.accepted || this.tombstone || !this.ask) return { text: 'This attempt has ended: nobody will answer.', isError: true };
    if (this.asking) return { text: QUESTION_WAITS, isError: true };
    this.asking = true;
    void this.ask(question, new AbortController().signal).then((answer) => {
      this.asking = false;
      if (answer.kind === 'withdrawn' || !this.node || this.ended || this.tombstone) this.queueCheck();
      else this.opened(this.node.continueConversation(answerText(answer)));
    });
    return { text: QUESTION_ASKED };
  }

  /** Why a `done` cannot be taken now, naming what is unfinished (D6: 1, 2). */
  private async doneRefusal(): Promise<string | null> {
    const node = this.node;
    if (!node) return 'The child plan has not opened yet.';
    const state = node.state();
    if (state.unfinished.length > 0) return `Not done yet: ${state.unfinished.join('; ')}.`;
    if (state.completed === 0) return 'Not done: no task of the child plan completed, so it did no work. If there was nothing to do, call task_complete with status "blocked" and say so, for the plan above to decide.';
    if (this.setup.task.readOnly) return null;
    const changed = await this.setup.host.changedPaths(this.taskId);
    return changed.length > 0 ? null : 'Not done: the delegated task\'s branch has not changed since its base, so nothing would land. If nothing needed changing, call task_complete with status "blocked" and say so, for the plan above to decide.';
  }

  /** The changes on the branch since its base, against every level's paths (D3, ADR-0056 M4): the one check of the work itself. */
  private async protectedPathsTouched(): Promise<VerificationCheck | undefined> {
    const paths = this.node?.protectedPaths ?? this.setup.task.protectedPaths ?? [];
    if (paths.length === 0 || this.setup.task.readOnly) return undefined;
    const changed = await this.setup.host.changedPaths(this.taskId);
    const touched = changed.filter((file) => paths.some((rule) => underProtectedPath(file, rule)));
    if (touched.length === 0) return undefined;
    return { name: 'protected_paths', passed: false, skipped: false, detail: `The child plan changed protected paths, so its work does not land: ${touched.map(onOneLine).join(', ')}.` };
  }

  /**
   * What its branch changed past the scope its parent declared (ADR-0056 M7),
   * for the parent to decide: scopes are advisory, so this goes in the report
   * and refuses nothing. A read-only task lands nothing to say this of.
   */
  private async outsideScope(): Promise<SubtreeReport['outsideScope']> {
    const { task, host } = this.setup;
    const scope = task.scope?.paths;
    if (!scope?.length || task.readOnly) return undefined;
    const changed = await host.changedPaths(this.taskId).catch(() => []);
    const outside = changed.filter((file) => !scope.some((rule) => underProtectedPath(file, rule)));
    return outside.length > 0 ? { paths: outside.slice(0, OUTSIDE_SCOPE_PATHS), count: outside.length } : undefined;
  }

  private publish(): void {
    const accepted = this.accepted;
    if (!accepted || this.ended) return;
    this.ended = true;
    clearTimeout(this.graceTimer);
    clearTimeout(this.wallClock);
    for (const listener of this.completes) listener(accepted.report, accepted.refuted);
    for (const listener of this.turnEnds) listener('completed');
  }

  /** An end no subplanner reported: its handoff is what the plan and run show, and the verdict comes from there. */
  private end(status: 'blocked' | 'failed', why: string): void {
    if (this.ended || this.accepted) return;
    const report: TaskCompleteArgs = { status, summary: why.slice(0, 1500), reason: why };
    const taken = this.node?.takeReport(report);
    this.accepted = { report: taken?.ok ? taken.handoff : report };
    this.publish();
  }

  private emitEvent(event: StructuredEvent): void {
    this.events.emit('event', event);
  }

  /**
   * A tombstone first (ADR-0055 D16): every start under it reads this at once,
   * before anything has stopped. Then the child goes as an attempt's runner
   * does: its subtree ended, leaves first, then its Session let go, while its
   * parent can still read the lease it depends on (D13), and what it did not
   * spend returned (ADR-0056 M5). Resolves when all of that is done, with no
   * timeout of its own: a runner's grace is the runner's (ADR-0018).
   */
  stop(): Promise<void> {
    this.tombstone = true;
    this.stopping ??= this.wind();
    return this.stopping;
  }

  private async wind(): Promise<void> {
    clearTimeout(this.graceTimer);
    clearTimeout(this.wallClock);
    if (!this.node) await this.seating;
    const node = this.node;
    if (node) {
      await node.halt().catch(() => undefined);
      await node.close().catch(() => undefined);
    }
    this.ended = true;
    this.baseHandleExit(0);
    this.markGone();
  }

  kill(): void {
    void this.stop();
  }

  /** Where its child's tasks stand, as last read; absent before the first read and once the child has gone. */
  progress(): ChildTaskCounts | undefined {
    return this.ended ? undefined : this.counts;
  }

  getOutput(): string { return this.output; }
  /** Nothing reads a child's input but a message. */
  write(): void {}
  /** One turn from its start to its verdict (D3). */
  turnState(): 'working' | 'idle' { return this.ended ? 'idle' : 'working'; }
  onTurnEnd(listener: (reason: StructuredTurnEnd) => void): void { this.turnEnds.push(listener); }
  onEvent(listener: (event: StructuredEvent) => void): void { this.events.on('event', listener); }

  /** A parent's message opens the subplanner's next turn (D3); Ordewell's own line waits for one. */
  sendMessage(text: string, from?: TaskMessageFrom): string {
    if (this.node && !this.ended) {
      if (from === 'ordewell') this.node.hear(text);
      else this.opened(this.node.continueConversation(text));
    }
    return `${this.id}-message`;
  }

  forceSend(text: string): string { return this.sendMessage(text); }
  forceSendQueued(): boolean { return false; }
  removeQueued(): boolean { return false; }
  queued(): QueuedTaskMessage[] { return []; }
  /** A child has no one turn to interrupt: Stop ends it. */
  async interrupt(): Promise<void> {}
  /** What a restart names (D3): the child session, not a runner's. */
  nativeSessionId(): string | null { return this.node?.sessionId ?? null; }
  commands(): RunnerCommand[] { return []; }
  invokeCommand(): string { throw new Error('A delegated task takes no runner commands.'); }
  answerPermission(): boolean { return false; }
  onTaskComplete(listener: (report: TaskCompleteArgs, refuted?: VerificationCheck) => void): void { this.completes.push(listener); }
  /** A subplanner asks by its own token, not its attempt's, and this is how that question reaches the attempt. */
  onToolCheckpoint(handler: (question: string, signal: AbortSignal) => Promise<CheckpointAnswer>): void { this.ask = handler; }
  onScriptExit(): void {}
}

/**
 * Starts delegated tasks' attempts (ADR-0055 D3), as a runner starts a coding
 * agent's and the script runner a body, so the claim, the log, the verdict and
 * the landing meet one the way they meet any task. A separate process later is
 * a second `IRunner`, not a redesign.
 */
export class ChildPlanRunner extends AbstractRunner<ChildPlanSession> {
  private spawned = 0;

  constructor(private readonly host: ChildHost) {
    super();
  }

  /** Every child's stop, for a node that waits on its subtree. */
  async stopEvery(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.stop()));
  }

  /** Where the tasks of the child `taskId` runs stand, or nothing with no child live. */
  progressOf(taskId: string): ChildTaskCounts | undefined {
    return [...this.sessions.values()].find((session) => session.taskId === taskId)?.progress();
  }

  async spawn(opts: RunnerSpawnOptions): Promise<IRunnerSession> {
    const task = opts.delegated;
    if (!task) throw new Error(`Task "${opts.title ?? opts.taskId}" has no goal: only a delegated task runs here.`);
    this.spawned += 1;
    const resume = opts.resumeSessionId ? { resume: { sessionId: opts.resumeSessionId, message: opts.prompt } } : {};
    const session = new ChildPlanSession(`child-${opts.taskId.slice(0, 8)}-${this.spawned}`, opts.taskId, { task, cwd: opts.cwd, host: this.host, ...resume });
    this.registerSession(session.id, session);
    session.begin();
    return session;
  }
}

/**
 * A child's own view of the runner its tree shares: a Stop of a child ends what
 * that child started, and a parent's `stopAll` would otherwise end every
 * session of the tree through this one.
 */
export function ownedRunner(runner: IRunner): IRunner {
  const owned = new Set<string>();
  return {
    spawn: async (opts) => {
      const session = await runner.spawn(opts);
      owned.add(session.id);
      session.onExit(() => owned.delete(session.id));
      return session;
    },
    stop: (sessionId) => runner.stop(sessionId),
    stopAll: () => { for (const id of owned) void runner.stop(id); },
    get activeCount() { return owned.size; },
  };
}
