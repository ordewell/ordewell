import type { Admitted } from './Attempts';

/**
 * What one planner turn leaves for its end: whether the planner committed a
 * whole plan in it, which autorun starts once the turn lands (ADR-0030), and
 * what failed in it, which that start leaves failed. Made per turn, so nothing
 * of one turn carries into the next. A change a planner tool makes commits as
 * the call answers (ADR-0022 P2), so a start the turn asks for after it runs
 * on the plan as changed, and none waits for the turn.
 */
export class TurnEffects {
  private submitted: Admitted | null = null;
  private run: Admitted | null = null;
  private open = true;

  /** `failedBefore` is each task failed as the turn opened, with the attempt that failed. */
  constructor(private readonly failedBefore: ReadonlyMap<string, number> = new Map()) {}

  /** The turn's planner tasks were adopted: a task edit, or a whole plan committed, whose start a Stop from now on withdraws (ADR-0029). */
  landed(how: 'edit' | 'commit', admitted: Admitted): void {
    if (how === 'commit') this.submitted = admitted;
  }

  /** A run of the plan opened: past a Stop that came before it, the plan is running on someone's word. */
  ran(admitted: Admitted): void { this.run = admitted; }

  /** The turn is over, landed or not: nothing it submitted waits for its end any more. */
  closed(): void { this.open = false; }

  get planSubmitted(): boolean { return this.submitted !== null; }

  /** A plan was submitted and its start waits for the turn's end, with no Stop since. */
  get startWaits(): boolean { return this.open && this.planSubmitted && !this.submissionStopped; }

  /** A Stop came since the plan was submitted, so the start it stood for is withdrawn. */
  get submissionStopped(): boolean { return this.submitted !== null && !this.submitted.current(); }

  /** A run opened after that Stop and no Stop has ended it since: the plan has started all the same. */
  get ranSinceStop(): boolean { return this.run?.current() ?? false; }

  /** Of the tasks failed now, those whose failure is this turn's: not the attempt that had failed as it opened. */
  failedSince(failedNow: ReadonlyMap<string, number>): Set<string> {
    return new Set([...failedNow].filter(([id, attempt]) => this.failedBefore.get(id) !== attempt).map(([id]) => id));
  }
}
