import { betweenRounds, loopRoundOf, outOfRounds, type LoopSubject } from '../models/Loop';
import { LOOP_OUT_OF_ROUNDS, stopsLoop } from '../models/SkipOrigin';
import type { Task } from '../models/Task';
import { quotedList } from '../utils/quotedList';
import { repeatingChecks } from './blocking';
import type { PlanStore } from './PlanStore';
import { waitOf, type StartWait } from './readiness';

/** What a round reads of a loop's check or its body task. */
export interface RoundSubject extends LoopSubject {
  title: string;
  /** Reverted by the user, so held until they start it again (ADR-0054). */
  reverted?: boolean;
}

/** The start wait of a check between rounds (ADR-0045 L3). */
export type RepeatingWait = Extract<StartWait, { kind: 'repeating' }>;

/** A body task a round runs again: not at work, and not waiting on the user. */
const REPEATABLE: ReadonlySet<string> = new Set(['pending', 'approved', 'completed', 'failed', 'skipped']);

/** A task left undone by what made it unneeded: it has not run, or it did not pass. A closed loop's body, or a resolver whose conflict is gone. */
export const LEFT_UNDONE: ReadonlySet<string> = new Set(['pending', 'approved', 'failed']);

/** What a loop's check failing does (ADR-0045 L2, L6, L7). */
export type AfterFailure =
  /** No loop, or no `failed` evidence: the failure is the task's own. */
  | { kind: 'failure' }
  /** It failed its last round: the loop closes, and the failure is the task's. */
  | { kind: 'out-of-rounds' }
  /** A body task a person or a supervisor skipped has stopped the loop (L7): the skip stands, and the failure is the task's. */
  | { kind: 'stopped' }
  /** A round starts: `reruns` run again, the reverted body keeps its hold, and `message` says so. */
  | { kind: 'round'; reruns: string[]; message: string };

/**
 * A loop's check failed (ADR-0045). With `failed` evidence and rounds left, a
 * round starts: its body runs again as new attempts, so the failure is the
 * round's, not the task's. Approval is not spent by a run, so the plan's
 * approval of the body covers every round. A body task they reverted keeps
 * its hold, which a round takes as any start does (L5, ADR-0054): the rest of
 * the body runs, and the loop waits for them to say. One already at work, or
 * waiting on the user, is left where it is.
 */
export function afterFailure(check: RoundSubject, body: readonly RoundSubject[], atWork: (taskId: string) => boolean): AfterFailure {
  if (!check.loop) return { kind: 'failure' };
  if (outOfRounds(check)) return { kind: 'out-of-rounds' };
  if (!betweenRounds(check)) return { kind: 'failure' };
  if (body.some(stopsLoop)) return { kind: 'stopped' };
  const taken = body.filter((t) => t.reverted);
  const runs = body.filter((t) => !t.reverted);
  const fixes = runs.length === 0 ? '' : ` ${quotedList(runs.map((t) => t.title))} ${runs.length === 1 ? 'runs' : 'run'} to fix what it found, then it checks again.`;
  const held = taken.length === 0 ? '' : ` ${quotedList(taken.map((t) => t.title))} ${taken.length === 1 ? 'was' : 'were'} reverted, so the loop waits for you to start ${taken.length === 1 ? 'it' : 'them'} again.`;
  return {
    kind: 'round',
    reruns: runs.filter((t) => !atWork(t.id) && REPEATABLE.has(t.status)).map((t) => t.id),
    message: `Task "${check.title}" failed round ${loopRoundOf(check)} of ${check.loop.maxRounds}:${fixes}${held}`,
  };
}

/**
 * The loop is over (ADR-0045 L6): what of its body has not run, or did not
 * pass, is not waited for and ends skipped. A body task at work is left to finish.
 */
export function closingSkips(body: readonly LoopSubject[], atWork: (taskId: string) => boolean): string[] {
  return body.filter((t) => !atWork(t.id) && LEFT_UNDONE.has(t.status)).map((t) => t.id);
}

/**
 * The checks an edit left out of rounds that were not before (ADR-0045 L6):
 * a lowered round limit, or a check it gave a loop it had already outrun.
 * Nothing else notices such an edit, since no round will run the check again.
 */
export function closedByEdit(before: readonly LoopSubject[], after: readonly LoopSubject[]): string[] {
  const was = new Map(before.map((task) => [task.id, task]));
  return after.filter((check) => {
    if (!outOfRounds(check)) return false;
    const prior = was.get(check.id);
    return !(prior && outOfRounds(prior));
  }).map((check) => check.id);
}

/** What the repeat rule reads of a check between rounds whose loop goes on. */
export interface RepeatFacts {
  /** A scheduler drives the plan, or the loop is carried on without one (L5). */
  driven: boolean;
  atWork: boolean;
  /** Each body task passed and landed. */
  bodyLanded: boolean;
}

/**
 * A check between rounds runs again, as the next round, once its whole body
 * has passed and landed and something drives it (ADR-0045 L5). Read off the
 * plan rather than at a body's verdict, so whatever finishes the body — a
 * verdict, a retry, a Mark complete, a reload in between — resumes the loop alike.
 */
export function repeatDue(check: LoopSubject, facts: RepeatFacts): boolean {
  return !!check.loop && facts.driven && !facts.atWork && facts.bodyLanded;
}

/** What starting a loop's check does now. */
export type CheckStart =
  /** It is not between rounds: a start is the check's own. */
  | { kind: 'own' }
  /** Something runs it on its own, as its next round: a start is not wanted (L5). */
  | { kind: 'loop-runs-it'; wait: RepeatingWait }
  /** Nothing runs it on its own, and its fix has yet to land: nothing can start it yet. */
  | { kind: 'fix-unlanded'; wait: RepeatingWait }
  /** Nothing runs it on its own, and its fix has landed: a start is its next round. */
  | { kind: 'next-round'; wait: RepeatingWait };

/**
 * The one answer to what a start of a loop's check does (ADR-0045 L5, L7),
 * which the seam, the supervisor's escalations and a force start all ask:
 * from its `repeating` wait, and whether something runs it on its own.
 */
export function checkStart(wait: RepeatingWait | undefined, runsOn: boolean): CheckStart {
  if (!wait) return { kind: 'own' };
  if (runsOn) return { kind: 'loop-runs-it', wait };
  return wait.waiting.length > 0 ? { kind: 'fix-unlanded', wait } : { kind: 'next-round', wait };
}

/** The orchestrator as a loop's rounds act on it. */
export interface LoopRoundsHost {
  readonly store: Pick<PlanStore, 'get' | 'allTasks' | 'planTasks' | 'retry' | 'repeat' | 'startRoundsOver' | 'isFailed'>;
  atWork(taskId: string): boolean;
  /** The scheduler drives the plan now. */
  scheduling(): boolean;
  /** The scheduler drives the plan, or would but for a usage limit holding it. */
  scheduledRun(): boolean;
  landed(taskId: string): boolean;
  startWaits(task: Readonly<Task>): StartWait[];
  /** A round started the task: what its start owed is spent. */
  roundStarted(taskId: string): void;
  /** A closed loop skipped this body task, with why; what else waited on it goes with it. */
  skip(taskId: string, reason: string): void;
  /** Said to the user, and in the run's notices. */
  tell(message: string): void;
  /** Said to the user. */
  info(message: string): void;
}

/**
 * A loop's rounds, end to end (ADR-0045 L5–L7): what a failed check starts,
 * the repeat once its body lands, the close, the loops carried on with no
 * scheduler, the report of the round before that the next one is handed, and
 * what a start of the check does. Decisions are the pure functions above;
 * this applies them to the plan, and keeps what lasts no longer than a run.
 *
 * The carried loops are held here, not on the plan, because a Stop ends them
 * and a reload does not bring them back; an edit does neither. One stays
 * carried while a body task the user stopped holds it, so a retry of that
 * task that passes resumes it (L7).
 */
export class LoopRounds {
  private readonly carriedLoops = new Set<string>();
  private readonly previousRounds = new Map<string, { round: number; report?: string }>();

  constructor(private readonly host: LoopRoundsHost) {}

  /**
   * The check failed, already stored as failed. True when a round starts, so
   * the failure is the round's; `carry` says a run with no scheduler started
   * it, which nothing else would go on with, so the loop is carried (L5).
   */
  checkFailed(checkId: string, carry: boolean): boolean {
    const check = this.host.store.get(checkId);
    if (!check) return false;
    const decision = afterFailure(check, this.bodyOf(check), (id) => this.host.atWork(id));
    if (decision.kind === 'out-of-rounds') this.close(check, LOOP_OUT_OF_ROUNDS);
    if (decision.kind !== 'round') return false;
    for (const id of decision.reruns) {
      this.host.store.retry(id);
      this.host.roundStarted(id);
    }
    this.host.tell(decision.message);
    if (carry) this.carriedLoops.add(checkId);
    return true;
  }

  /** The loop is over (L6): its check passed, or will run no more, so it is carried no more and what of its body is undone ends skipped. */
  close(check: Readonly<Task>, reason: string): void {
    this.carriedLoops.delete(check.id);
    for (const id of closingSkips(this.bodyOf(check), (taskId) => this.host.atWork(taskId))) this.host.skip(id, reason);
  }

  /** The loops an edit left out of rounds, closed; their checks, which settle once more while a run is under way. */
  planEdited(before: readonly Task[]): string[] {
    const closed = closedByEdit(before, this.host.store.allTasks);
    for (const id of closed) {
      const check = this.host.store.get(id);
      if (check) this.close(check, LOOP_OUT_OF_ROUNDS);
    }
    return closed;
  }

  /** Each check whose round's body has landed runs again; true when one did. */
  repeatDue(): boolean {
    let repeated = false;
    for (const id of repeatingChecks(this.host.store.planTasks)) {
      const check = this.host.store.get(id);
      if (!check || !repeatDue(check, {
        driven: this.host.scheduling() || this.carriedLoops.has(id),
        atWork: this.host.atWork(id),
        bodyLanded: (check.loop?.body ?? []).every((b) => this.host.landed(b)),
      })) continue;
      this.repeat(check);
      repeated = true;
    }
    return repeated;
  }

  /**
   * A force start of the check: its next round when nothing else would run it
   * and its fix has landed; forced after any other failure, its rounds start
   * over, as a retry's do (L5, L7).
   */
  forced(taskId: string): void {
    const task = this.host.store.get(taskId);
    if (task && this.startOf(task).kind === 'next-round') this.repeat(task);
    else if (this.host.store.isFailed(taskId)) this.host.store.startRoundsOver(taskId);
  }

  /** What a start of the task does now; see {@link checkStart}. */
  startOf(task: Readonly<Task>): CheckStart {
    if (!task.loop) return { kind: 'own' };
    return checkStart(waitOf(this.host.startWaits(task), 'repeating'), this.runsOn(task.id));
  }

  /** Something will run this check between rounds without being asked: a scheduler, the one a reset gives back, or its loop carried on (L5). */
  runsOn(checkId: string): boolean {
    return this.host.scheduledRun() || this.carriedLoops.has(checkId);
  }

  /** A check between rounds that nothing will run: it waits on a person, its failure no longer one its loop answers (L5, ADR-0053). */
  stranded(taskId: string): boolean {
    const task = this.host.store.get(taskId);
    const start = task ? this.startOf(task).kind : 'own';
    return start === 'fix-unlanded' || start === 'next-round';
  }

  /**
   * The carried loops owed now: a check between rounds whose loop goes on, or
   * a round waiting to start. One a body task stopped is not here until that
   * task passes (L7), though it stays carried.
   */
  carriedOwed(): string[] {
    let repeating: ReadonlySet<string> | undefined;
    return [...this.carriedLoops].filter((id) => {
      const check = this.host.store.get(id);
      if (!check?.loop) return false;
      repeating ??= repeatingChecks(this.host.store.planTasks);
      return repeating.has(id) || check.status === 'pending' || check.status === 'approved';
    });
  }

  /** A loop is carried on, one a body task stopped included: a retry that passes would resume it. */
  get anyCarried(): boolean {
    return [...this.carriedLoops].some((id) => !!this.host.store.get(id)?.loop);
  }

  /** The check's last round, and its report, for the body task a round runs again. */
  previousRound(taskId: string): { round: number; report?: string } | undefined {
    return this.previousRounds.get(taskId);
  }

  /** The run that carried them is over, by a Stop or what gives the run up or clears it up. */
  runEnded(): void {
    this.carriedLoops.clear();
  }

  /** A plan was loaded: an edit keeps the loops carried whose check is still a loop's; another plan keeps none. */
  planLoaded(edited: boolean): void {
    this.previousRounds.clear();
    for (const id of [...this.carriedLoops]) if (!edited || !this.host.store.get(id)?.loop) this.carriedLoops.delete(id);
  }

  private repeat(check: Readonly<Task>): void {
    this.previousRounds.set(check.id, { round: loopRoundOf(check), report: check.outputSummary?.report });
    // The same task the store counts on, so the round read after is the new one.
    this.host.store.repeat(check.id);
    this.host.roundStarted(check.id);
    this.host.info(`The fix for task "${check.title}" has landed: it checks again, round ${loopRoundOf(check)} of ${check.loop?.maxRounds}.`);
  }

  private bodyOf(check: Readonly<Task>): Readonly<Task>[] {
    return (check.loop?.body ?? []).flatMap((id) => this.host.store.get(id) ?? []);
  }
}
