import { EventEmitter } from 'events';
import type { IRunner, IRunnerSession, QueuedTaskMessage, StructuredEvent, StructuredTurnEnd } from '../interfaces/IRunner';
import type { RunnerCommand } from '../models/RunnerCommand';
import type { Task, VerificationCheck } from '../models/Task';
import { checkHandoff } from '../models/Handoff';
import { underProtectedPath } from '../models/Delegation';
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
  /** One line per task, as a derived report lists them. */
  tasks: readonly { label: string; status: Task['status'] }[];
}

/** The child, as its attempt drives it: nothing of the Session it is, or of a surface. */
export interface ChildNode {
  readonly sessionId: string;
  /** Its protected paths, its ancestors' with them (ADR-0056 M4). */
  readonly protectedPaths: readonly string[];
  /** The time it has to run in (ADR-0056 M3). */
  readonly wallClockMs: number | null;
  startPlanning(goal: string): Promise<unknown>;
  continueConversation(text: string): Promise<unknown>;
  /** Reopened (ADR-0055 D17): acts as Execute there, and its subplanner goes on with `text`; one that never wrote a plan plans `goal`. */
  goOn(text: string, goal: string): Promise<unknown>;
  state(): NodeState;
  /** End its subtree (D16). Resolves once nothing of it is left, however long that takes. */
  halt(): Promise<void>;
  /** Let its Session go, and what it did not spend return (ADR-0056 M5). */
  close(): Promise<void>;
}

/** What a subplanner's token calls and what its Session tells of itself, bound to one attempt (ADR-0055 D5). */
export interface SubplannerLink {
  taskComplete(report: TaskCompleteArgs): Promise<McpToolReply>;
  checkpoint(): Promise<McpToolReply>;
  /** Something changed that a verdict or the completion reminder may read. */
  changed(): void;
  /** A Stop stands over this node, its own or an ancestor's (ADR-0055 D16). */
  stopped(): boolean;
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
}

/** Once per attempt: a subplanner told this has no second turn to end without the call (ADR-0055 D6). */
const COMPLETION_REMINDER = 'Your turn ended with nothing running and no `task_complete` call. If your child plan reached the goal, call `task_complete` with status `done`; if it cannot, call it with status `blocked` or `failed` and the reason. If work is left, start it now. A second turn that ends like this fails the delegated task.';

/** Questions going up a level are ADR-0056 M8's, and not built yet: a blocking call would hold a slot, so this refuses and says how to go on. */
const NO_QUESTIONS_YET = 'A question cannot reach the plan above yet. Decide it yourself if your goal lets you; otherwise call task_complete with status "blocked" and say exactly what you need.';

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
  private reminded = false;
  /** The accepted call, until it is published. */
  private accepted: { report: TaskCompleteArgs; refuted?: VerificationCheck } | null = null;
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
        checkpoint: () => Promise.resolve({ text: NO_QUESTIONS_YET, isError: true }),
        changed: () => this.queueCheck(),
        stopped: () => this.tombstone || this.halting !== null || host.stopped(),
      }, resume?.sessionId);
    } catch (err) {
      // Refused, not failed: nothing ran, and what can be changed is the plan above (ADR-0056 M4).
      if (!this.tombstone) this.end('blocked', err instanceof Error ? err.message : String(err));
      return;
    }
    if (this.tombstone) return;
    if (this.node.wallClockMs !== null) {
      this.wallClock = setTimeout(() => this.haltFor(`its time of ${this.node?.wallClockMs} ms ran out`), this.node.wallClockMs);
      this.wallClock.unref?.();
    }
    this.opened(resume ? this.node.goOn(resume.message, task.goal ?? '') : this.node.startPlanning(task.goal ?? ''));
  }

  /** A turn this opened: its end is one a check reads, and a failure in it ends the attempt, since no person reads it (ADR-0056 M8). */
  private opened(turn: Promise<unknown>): void {
    this.opening += 1;
    turn.then(
      () => this.turnSettled(),
      (err: unknown) => {
        this.turnSettled();
        // A turn this ended itself is no failure of its planner, and nor is one refused at the gate: the check owes that end.
        if (this.tombstone || this.halting) return;
        const state = this.node?.state();
        if (state?.stoppedFor || state?.withdrawn) return;
        this.end('failed', `Its planner could not go on: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
  }

  private turnSettled(): void {
    this.opening -= 1;
    this.queueCheck();
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
    const stopped = this.halting ?? state.stoppedFor;
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
    if (state.live || state.plannerBusy || state.wakeOwed || this.opening > 0) return;
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
    return `The child plan ended without a report: ${why}.${tasks ? ` Its tasks: ${tasks}.` : ' It holds no tasks.'}`;
  }

  /** The child's activity, as this attempt's log shows it (ADR-0055 D20): what a task became, not what its runner said. */
  private say({ tasks }: NodeState): void {
    for (const { label, status } of tasks) {
      if (this.printed.get(label) === status) continue;
      this.printed.set(label, status);
      this.print(`${label}: ${status}\n`);
    }
  }

  private print(text: string): void {
    this.output += text;
    this.outputEmitter.emit('output', text);
  }

  /**
   * The subplanner's `task_complete`, on the token bound to this attempt. D6's
   * first two tests refuse at the call and leave the attempt open; a protected
   * path fails the verdict instead, since that work cannot be taken back here.
   * `blocked` and `failed` are taken at any time: that is how a subtree gives up.
   */
  private async taskComplete(report: TaskCompleteArgs): Promise<McpToolReply> {
    if (this.ended || this.accepted || this.tombstone) return { text: 'This attempt has ended: nothing was recorded.', isError: true };
    // Its references resolve in its own plan (ADR-0057 R1), which comes with reports by reference: until then it may cite none.
    const checked = checkHandoff(report, this.taskId, []);
    if (!checked.ok) return { text: checked.refusal, isError: true };
    let refuted: VerificationCheck | undefined;
    if (checked.handoff.status === 'done') {
      const refusal = await this.doneRefusal();
      if (refusal) return { text: refusal, isError: true };
      refuted = await this.protectedPathsTouched();
    }
    if (this.ended || this.accepted || this.tombstone) return { text: 'This attempt has ended: nothing was recorded.', isError: true };
    this.accepted = { report: checked.handoff, ...(refuted ? { refuted } : {}) };
    this.emitEvent({ type: 'completion_received', status: checked.handoff.status });
    // The runner ends its turn on this reply; one that keeps it open is published at this grace.
    this.graceTimer = setTimeout(() => this.publish(), COMPLETION_GRACE_MS);
    this.graceTimer.unref?.();
    return { text: 'Recorded. End your turn now.' };
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
    return { name: 'protected_paths', passed: false, skipped: false, detail: `The child plan changed protected paths, so its work does not land: ${touched.join(', ')}.` };
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
    this.accepted = { report: { status, summary: why.slice(0, 1500), reason: why } };
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

  getOutput(): string { return this.output; }
  /** Nothing reads a child's input but a message. */
  write(): void {}
  /** One turn from its start to its verdict (D3). */
  turnState(): 'working' | 'idle' { return this.ended ? 'idle' : 'working'; }
  onTurnEnd(listener: (reason: StructuredTurnEnd) => void): void { this.turnEnds.push(listener); }
  onEvent(listener: (event: StructuredEvent) => void): void { this.events.on('event', listener); }

  /** A parent's message goes to the subplanner's next turn (D3). */
  sendMessage(text: string): string {
    if (this.node && !this.ended) this.opened(this.node.continueConversation(text));
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
  /** A subplanner's question goes by its own token, not its attempt's: see {@link NO_QUESTIONS_YET}. */
  onToolCheckpoint(_handler: (question: string, signal: AbortSignal) => Promise<CheckpointAnswer>): void {}
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
