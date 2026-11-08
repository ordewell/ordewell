import { flattenTasks, type LegacyPlanState, type PendingPlanTurn, type Task } from '../models/Task';
import type { HandoffCheck } from '../models/Handoff';
import type { ExecutionActor, SupervisorLevel } from '../models/Execution';
import { CHILD_ENDED, type ChildDirectory } from './ChildDirectory';
import type { ChildNode, NodeEnd, NodeState, SubplannerLink, TakenReport } from './ChildPlanRunner';
import type { CommandOutcome, ExecutionCommand } from './ExecutionCommands';
import type { Mandate } from './Mandate';
import type { TaskCompleteArgs } from './mcp';
import type { NodeFunding } from './NodeFunding';
import { PlannerTurnDiscardedError, PlannerTurnStoppedError } from './PlannerConversation';
import type { PlanTurnInput } from './PlanTurns';
import { surfacePlan, type ChildControlOutcome, type ChildMessageOutcome, type ChildPlanView, type ChildTaskControl, type RunView, type SessionMessage, type SessionNotice } from './SessionMessage';
import type { SlotPool } from './SlotPool';
import { taskRefOf } from './TaskRefs';

/**
 * Where a node sits under its parent, as its Session asks for it: the node its
 * parent's attempt drives, the seat a surface reaches it through, and what a
 * person may say to it there (ADR-0055 D6, D20). One kind of node at every
 * depth (ADR-0055 D4), so a Session holds one of these and never asks which
 * depth it is at: a {@link RootSeat} has no parent, a {@link ChildSeat} sits
 * under its parent's delegated task.
 */
export interface NodeSeat {
  /** This node as its parent's attempt drives it, `pins` what it is told as it starts (ADR-0057 R10). */
  asNode(task: Task, mandate: Mandate, pins: readonly string[]): ChildNode;
}

/** Its planner's turns, as a seat reads them: the Session's `PlanTurns`, narrowed. */
export interface SeatTurns {
  readonly turnRunning: boolean;
  enqueue(input: PlanTurnInput): Promise<unknown>;
  heldWithoutCaller(): readonly PendingPlanTurn[];
}

/** What a seated node reads of its Session, afresh each time it asks. */
export interface ChildSeatHost {
  /** Its parent's attempt, which a person's message reaches through (ADR-0055 D5). */
  readonly link: SubplannerLink;
  /** Its level, the actor a person's control runs as. */
  readonly depth: number;
  /** The root's, which a surface finds this child through (D20). */
  readonly directory: Pick<ChildDirectory, 'seat'>;
  /** The root's, which knows how long the tree was held on a usage limit (ADR-0056 M3). */
  readonly pool: Pick<SlotPool, 'heldSince'>;
  readonly funds: Pick<NodeFunding, 'turnRefusal' | 'stoppedFor' | 'closeOwn'>;
  sessionId(): string;
  goal(): string;
  plan(): LegacyPlanState | null;
  /** The plan's tasks as they stand. */
  tasks(): readonly Task[];
  /** A copy of them, for a surface. */
  snapshot(): Task[];
  run(): RunView;
  plannerTurnId(): string | undefined;
  plannerCompaction(): Extract<SessionMessage, { type: 'planner_compaction' }> | undefined;
  /** Its planner is in a turn, waiting for one, or a queued one is running. */
  working(): boolean;
  /** Its conversation is under way, or opening. */
  opened(): boolean;
  turns(): SeatTurns;
  /** A turn behind what is in flight, the conversation's opening included. */
  follow(input: PlanTurnInput): Promise<unknown>;
  startPlanning(goal: string): Promise<unknown>;
  continueConversation(text: string): Promise<unknown>;
  execute(command: ExecutionCommand, actor: ExecutionActor): Promise<CommandOutcome>;
  /** Who its planner's turn acts as. */
  actor(): ExecutionActor;
  awaitsCheckpoint(taskId: string): boolean;
  checkpointQuestion(taskId: string): string | undefined;
  /** What its children are owed on a Continue, which its subplanner hears with `text` (ADR-0055 D17). */
  owesChildren(text: string): string[];
  /** Why no claim and no planner turn may start here (ADR-0055 D16). */
  nodeRefusal(): string | null;
  /** Why nothing may start here, what is in flight finishing first (ADR-0056 M10). */
  withdrawn(): string | null;
  refusedStart(): string | null;
  runIsLive(): boolean;
  /** What landed is not merged into the delegated task's branch yet. */
  unmerged(): boolean;
  wakeOwed(): boolean;
  supervisorLevel(): SupervisorLevel;
  takeReport(report: TaskCompleteArgs): HandoffCheck<TakenReport>;
  notice(level: SessionNotice['level'], message: string): void;
  stopSubtree(): Promise<void>;
  /** Destroy the Session; resolves once everything under it has gone. */
  destroy(): Promise<void>;
}

/** Who the message of a turn came from, since a subplanner otherwise reads every message as the plan above's. */
export const PERSON_SPOKE = 'A message in this turn comes from a person watching this child plan, not from the plan above. It stays here: nothing reaches the plan above unless you pass up what it needs in your own report or question.';

const STOPPED_UNANSWERED = 'This child plan stopped before its subplanner answered your message.';

/** What a person hears of a message nothing answered, nobody else holding the call. The child's report ending the turn that read it is no news. */
function personUnanswered(err: unknown): string | null {
  if (err instanceof PlannerTurnDiscardedError && !err.unread) return null;
  if (err instanceof PlannerTurnDiscardedError || err instanceof PlannerTurnStoppedError) return STOPPED_UNANSWERED;
  return `Your message to this child plan went unanswered: ${err instanceof Error ? err.message : String(err)}`;
}

/** The root's seat: it has no parent, so no attempt drives it and a person speaks to it as the user. */
export class RootSeat implements NodeSeat {
  asNode(): ChildNode {
    throw new Error('The root has no parent, so no attempt drives it as a child.');
  }
}

/** A child's seat, under its parent's delegated task: its attempt drives it, and a person watching may speak to it (ADR-0055 D20). */
export class ChildSeat implements NodeSeat {
  constructor(private readonly host: ChildSeatHost) {}

  asNode(task: Task, mandate: Mandate, pins: readonly string[]): ChildNode {
    const { host } = this;
    const told = (goal: string) => (pins.length > 0 ? `${goal}\n\n${pins.join('\n')}` : goal);
    let toldOfHeld = false;
    const leave = host.directory.seat({
      sessionId: host.sessionId(),
      taskId: task.id,
      title: task.title,
      working: () => host.working(),
      refusal: () => this.personRefused(),
      view: () => this.seenFromAbove(),
      hear: (text) => this.hearPerson(text),
      checkpoints: () => flattenTasks(host.tasks()).filter((held) => host.awaitsCheckpoint(held.id)).map((held) => held.id),
      control: (taskId, control) => this.controlledByPerson(taskId, control),
    });
    return {
      sessionId: host.sessionId(),
      protectedPaths: mandate.exclusions.protectedPaths,
      wallClockMs: mandate.limits.wallClockMs,
      heldSince: (since) => host.pool.heldSince(since),
      startPlanning: (goal) => host.startPlanning(told(goal)),
      continueConversation: (text) => host.continueConversation(text),
      goOn: (text, goal) => this.goOn(text, goal, told),
      hear: (line) => { void host.turns().enqueue({ source: 'supervisor', text: line, rides: true }).catch(() => undefined); },
      state: () => this.nodeState(),
      takeReport: (report) => host.takeReport(report),
      // Before the stop, which drops what a context pause held; halting closes the
      // seat first, so no message comes in behind this and one notice covers them all.
      halt: () => {
        if (!toldOfHeld && host.turns().heldWithoutCaller().some((t) => t.aside === PERSON_SPOKE)) {
          toldOfHeld = true;
          host.notice('warn', STOPPED_UNANSWERED);
        }
        return host.stopSubtree();
      },
      close: async () => {
        await host.destroy();
        leave();
        host.funds.closeOwn();
      },
    };
  }

  /** This child as a surface that selected it opens it, the same shape a joining client reads of any session. */
  private seenFromAbove(): Omit<ChildPlanView, 'child'> {
    const { host } = this;
    const plan = host.plan();
    const plannerTurnId = host.plannerTurnId();
    const plannerCompaction = host.plannerCompaction();
    return {
      goal: host.goal(),
      plan: plan ? surfacePlan({ ...plan, tasks: host.snapshot() }) : null,
      run: host.run(),
      ...(plannerTurnId ? { plannerTurnId } : {}),
      ...(plannerCompaction ? { plannerCompaction } : {}),
    };
  }

  /** `opensTurn`: an answer does not, and a runner must not stay parked at its question for want of a turn nobody takes. */
  private personRefused({ opensTurn = true }: { opensTurn?: boolean } = {}): Extract<ChildMessageOutcome, { ok: false }> | null {
    const { host } = this;
    if (!host.link.listening()) return CHILD_ENDED;
    const refused = host.nodeRefusal() ?? (opensTurn ? host.funds.turnRefusal() : null) ?? (host.opened() ? null : 'This child plan has not started its conversation yet.');
    return refused ? { ok: false, code: 'refused', message: refused } : null;
  }

  /**
   * A person's message to this child (ADR-0055 D20): a turn of its subplanner
   * as any other, its actor and mandate unchanged, so no budget, grant or
   * effect moves here. Skills are not resolved, which would be a person
   * loading them past the allowlist. It goes no higher: what the plan above
   * hears of it is what the subplanner chooses to pass up.
   */
  private hearPerson(text: string): ChildMessageOutcome {
    const refused = this.personRefused();
    if (refused) return refused;
    const { host } = this;
    // Beside the message, not in it: their words stay as they wrote them in the transcript.
    const input: PlanTurnInput = { source: 'user', text, aside: PERSON_SPOKE };
    const taken = host.turns().turnRunning;
    host.link.spoken(async () => {
      try {
        await host.follow(input);
      } catch (err) {
        const told = personUnanswered(err);
        if (told) host.notice('warn', told);
      }
    });
    return { ok: true, status: !taken && host.turns().turnRunning ? 'woken' : 'queued' };
  }

  /**
   * A person's control on this plan's own task (ADR-0055 D20): the command its
   * subplanner could call, as its subplanner, so its held mandate decides and
   * no budget, grant or effect moves here. An id this plan does not hold is
   * refused rather than resolved, and the question is compared in the same
   * tick the seam checks and answers it, so no answer lands on a later one.
   * The subplanner hears of it on its next turn, and none is opened to tell it.
   */
  private async controlledByPerson(taskId: string, control: ChildTaskControl): Promise<ChildControlOutcome> {
    const refused = this.personRefused({ opensTurn: control.kind !== 'checkpoint' });
    if (refused) return refused;
    const { host } = this;
    if (!flattenTasks(host.tasks()).some((task) => task.id === taskId)) {
      return { ok: false, code: 'no_task', message: `This child plan has no task "${taskId}".` };
    }
    if (control.kind === 'checkpoint' && !(host.awaitsCheckpoint(taskId) && host.checkpointQuestion(taskId) === control.question)) {
      return { ok: false, code: 'not_waiting', message: 'That checkpoint is not waiting any more: it was answered, withdrawn or replaced by another question.' };
    }
    const outcome = await host.execute(
      control.kind === 'message'
        ? { command: 'message_task', task: taskId, text: control.text }
        : { command: 'answer_checkpoint', task: taskId, answer: control.answer, ...(control.reason ? { reason: control.reason } : {}) },
      { kind: 'subplanner', depth: host.depth, person: true },
    );
    if (!outcome.ok) return { ok: false, code: 'refused', message: outcome.message };
    const said = control.kind === 'message' ? control.text : control.reason;
    void host.turns().enqueue({ source: 'supervisor', text: `A person acted on your plan: ${outcome.message}${said ? ` They said: ${said}` : ''}`, rides: true }).catch(() => undefined);
    return { ok: true, message: outcome.message, ...(outcome.payload?.kind === 'message' ? { id: outcome.payload.id } : {}) };
  }

  /**
   * Reopened (ADR-0055 D17): as Execute, so what failed is retried, but for its
   * own children, which go on under this same Continue, and then its subplanner
   * goes on. One whose plan never reached the disk plans its goal, and one with
   * nothing left to run goes straight to its turn: it may owe only its report.
   * `told` adds the pins of now, posted since it opened or not (ADR-0057 R10);
   * its children hear the message without them, and add their own.
   */
  private async goOn(text: string, goal: string, told: (said: string) => string): Promise<unknown> {
    const { host } = this;
    if (host.tasks().length === 0) return host.startPlanning(told(goal));
    const left = flattenTasks(host.tasks()).some((task) => task.type !== 'user' && task.status !== 'completed' && task.status !== 'skipped');
    if (!left) return host.continueConversation(told(text));
    const held = host.owesChildren(text);
    const run = await host.execute({ command: 'run_plan' }, host.actor());
    if (!run.ok) throw new Error(run.message);
    return host.continueConversation(told([text, ...held].join('\n\n')));
  }

  /** What its parent reads of it, afresh (ADR-0055 D6). */
  private nodeState(): NodeState {
    const { host } = this;
    const planTasks = host.tasks();
    const tasks = flattenTasks(planTasks);
    const label = (task: Task) => `${taskRefOf(planTasks, task.id) ?? `#${task.order}`} "${task.title}"`;
    const live = host.runIsLive();
    const open = tasks.filter((task) => task.status !== 'completed' && task.status !== 'skipped');
    return {
      unfinished: [
        ...(tasks.length === 0 ? ['the child plan holds no tasks'] : []),
        ...(live ? ['its run has not settled'] : []),
        ...open.map((task) => `${label(task)} is ${task.status}`),
        ...(host.unmerged() ? ['what landed is not merged into the delegated task\'s branch'] : []),
      ],
      completed: tasks.filter((task) => task.status === 'completed').length,
      live,
      plannerBusy: host.working(),
      wakeOwed: host.wakeOwed(),
      stoppedFor: this.stoppedFor(),
      withdrawn: host.withdrawn(),
      startRefused: host.refusedStart(),
      tasks: tasks.map((task) => ({ label: label(task), status: task.status })),
    };
  }

  /** Why this node stops now: a child has nobody else to wait for (ADR-0056 M5, M8). */
  private stoppedFor(): NodeEnd | null {
    const { host } = this;
    const outOfBudget = host.funds.stoppedFor();
    if (outOfBudget) return { why: outOfBudget, ends: 'blocked' };
    const settings = host.plan()?.runSettings;
    if (settings?.unsupervised !== undefined) return { why: `its subplanner could not restart: ${settings.unsupervised}`, ends: 'failed' };
    if (settings && host.supervisorLevel() !== 'act') return { why: 'its loop guard stopped its subplanner', ends: 'blocked' };
    return null;
  }
}
