import type { LegacyPlanState, PlannerResendState, RunnerId } from '../models/Task';
import { readUsageLimitReset, type TurnFailure } from './runnerExit';
import { RELAPSE_MS, RESUME_MARGIN_MS, ResetWaits } from './LimitPauses';
import { resumeTime } from '../taskRow/status';

export interface PlannerResendHost {
  plan(): LegacyPlanState | null;
  /** The runner the planner runs as now; null for a planner that is not a coding agent. */
  plannerRunner(): RunnerId | null;
  /** The wait ended at the reset: what waits may go now. */
  due(): void;
  /** The wait changed with no turn to say so: save and announce the plan. */
  changed(): void;
  notice(message: string): void;
}

/** What a usage limit that ended a planner turn led to. */
export interface PlannerLimit {
  /** The line the transcript keeps, drawn as a failure. */
  text: string;
  /** When what the turn took goes again on its own; null when it waits for the user's next message. */
  resendAt: Date | null;
  /** Why nothing goes again on its own, when nothing does: what the planner did, as in "the planner hit its usage limit and …". */
  held?: string;
  /** A planner tool's change in the turn took its inputs as answered (ADR-0022 P2): nothing of it waits to be sent again. */
  answered?: true;
}

const HELD = 'Send a message once it has reset: what waits goes with it.';

/** The planner has one wait, whatever runner it is on. */
const WAIT = 'planner';

/**
 * The planner's own usage limit (#84 for tasks, ADR-0029 for the
 * supervisor): a planner turn Ordewell started that ends on it leaves its
 * inputs waiting on the plan, and they are sent again as one turn — with
 * whatever arrives meanwhile — once the limit resets. The state is saved on
 * the plan (`plannerResend`), but loading a session holds its inputs for a new
 * message instead of rearming the wait (ADR-0044).
 *
 * Without a time — the reset could not be read, the resend hit the limit
 * again at once, the user cancelled it, or the planner moved to another
 * runner, whose account the limit is not — what waits is held for the next
 * input instead, the user's message or a wake-up: nothing is sent that no
 * one asked for since.
 */
export class PlannerResend {
  private readonly waits = new ResetWaits(() => this.due());
  /** When the last resend at a reset went out, until a turn lands: a limit in that window is a relapse. */
  private resentAt: number | null = null;

  constructor(private readonly host: PlannerResendHost) {}

  /** Whether turns wait on the limit: until the reset, or for the user's next message. */
  holds(): boolean {
    return this.host.plan()?.plannerResend !== undefined;
  }

  /** A planner turn Ordewell started ended on the planner's usage limit, which it reported as `said`. */
  limited(said: TurnFailure): PlannerLimit {
    const plan = this.host.plan();
    const runner = this.host.plannerRunner() ?? undefined;
    const now = new Date();
    const relapsed = this.resentAt !== null && now.getTime() - this.resentAt < RELAPSE_MS;
    this.resentAt = null;
    this.waits.clear();
    const name = runner ?? 'Planner';
    // An API planner has no runner and no words to read, but its client's
    // error states the reset as a field, which `said` carries.
    const reset = relapsed ? null : readUsageLimitReset(runner ?? '', said, now);
    if (!reset) {
      if (plan) plan.plannerResend = runner ? { runner } : {};
      const held = relapsed ? 'hit it again right after the resend' : 'did not say when it resets';
      const text = relapsed
        ? `${name} usage limit again right after the resend, so nothing is resent on its own. ${HELD}`
        : `${name} usage limit; it did not say when it resets. ${HELD}`;
      return { text, resendAt: null, held };
    }
    const at = new Date(reset.getTime() + RESUME_MARGIN_MS);
    if (plan) plan.plannerResend = { runner, at: at.toISOString() };
    this.waits.arm(WAIT, at);
    return { text: `${name} usage limit, resets ${resumeTime(reset, now)}. Resending at ${resumeTime(at, now)}; anything you send meanwhile goes with it.`, resendAt: at };
  }

  /**
   * A turn hit the planner's usage limit after a planner tool committed a
   * change in it (ADR-0022 P2), which took the turn's inputs as answered:
   * nothing waits to be sent again. With the reset known the wait is armed
   * all the same, so what arrives meanwhile — the user's message, the
   * supervisor's wake-ups — waits for it and goes then, rather than meeting
   * the limit again or leaving the run unsupervised (ADR-0029). Without one,
   * nothing waits and nothing is held.
   */
  limitedAfterChange(said: TurnFailure): PlannerLimit {
    const plan = this.host.plan();
    const runner = this.host.plannerRunner() ?? undefined;
    const now = new Date();
    this.resentAt = null;
    this.waits.clear();
    const reset = readUsageLimitReset(runner ?? '', said, now);
    const name = runner ?? 'Planner';
    if (!reset) return { text: `${name} usage limit. What the planner changed before it stays, and nothing waits to be sent again.`, resendAt: null, held: 'had already made its change', answered: true };
    const at = new Date(reset.getTime() + RESUME_MARGIN_MS);
    if (plan) plan.plannerResend = { runner, at: at.toISOString() };
    this.waits.arm(WAIT, at);
    return {
      text: `${name} usage limit, resets ${resumeTime(reset, now)}. What the planner changed before it stays, and nothing waits to be sent again; what arrives meanwhile goes at ${resumeTime(at, now)}.`,
      resendAt: at,
      answered: true,
    };
  }

  /**
   * A new input arrived — the user's message, or a wake-up the supervisor
   * asked for. What was held for one goes with it now; so does what waits on
   * a runner the planner has left, since nothing it waits for applies to the
   * planner that will answer. True when it lifted a wait.
   */
  arrived(): boolean {
    const saved = this.host.plan()?.plannerResend;
    if (!saved || (saved.at !== undefined && !this.switched(saved))) return false;
    this.lift();
    return true;
  }

  /** Keep what waits from going on its own; it goes with the user's next message. False when nothing waits on a reset. */
  cancel(): boolean {
    const plan = this.host.plan();
    const saved = plan?.plannerResend;
    if (!plan || saved?.at === undefined) return false;
    this.waits.clear();
    plan.plannerResend = held(saved);
    return true;
  }

  /** A turn landed: the resend before it got past the limit. */
  landed(): void {
    this.resentAt = null;
  }

  /** Loading a session preserves the inputs, without scheduling a model call. */
  restore(): void {
    this.reset();
    const saved = this.host.plan()?.plannerResend;
    if (saved) delete saved.at;
  }

  /** The plan is gone: nothing it waited on carries over. */
  reset(): void {
    this.waits.clear();
    this.resentAt = null;
  }

  private due(): void {
    const plan = this.host.plan();
    const saved = plan?.plannerResend;
    if (!plan || saved?.at === undefined) return;
    if (this.switched(saved)) {
      plan.plannerResend = held(saved);
      this.host.changed();
      this.host.notice(`The planner no longer runs on ${saved.runner}, whose usage limit it waited on, so nothing was resent. ${HELD}`);
      return;
    }
    delete plan.plannerResend;
    this.resentAt = Date.now();
    this.host.due();
  }

  private lift(): void {
    this.waits.clear();
    const plan = this.host.plan();
    if (plan) delete plan.plannerResend;
  }

  private switched(saved: PlannerResendState): boolean {
    return saved.runner !== undefined && saved.runner !== (this.host.plannerRunner() ?? undefined);
  }
}

function held({ runner }: PlannerResendState): PlannerResendState {
  return runner ? { runner } : {};
}
