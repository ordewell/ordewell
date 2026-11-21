import { flattenTasks, type Task } from '../models/Task';
import { ROOT_NODE, type HandoffFinding, type TaskEvidence } from '../models/Handoff';
import { fanOutShape } from './PlanFanOut';

/**
 * A blocker one task finds in work another has already landed reaches the
 * supervisor while the run can still use a fix, not at the closing check. In a
 * recorded run 21 slices named one defect in the opening task's landed code,
 * the first 25 minutes in; nothing routed it, and the closing check fixed it
 * in a dozen calls 147 minutes in, too late to land.
 *
 * What counts is mechanical, and reads no words: a finding of severity
 * `blocker` whose evidence cites a task that had landed when it was reported,
 * by task reference pinned to the attempt that landed or unpinned, or by a file
 * that landed work changed. The second is the one a recorded run needed: of its
 * 65 blockers, 61 cited only files and commits. Reports are grouped by the task
 * whose work they name, so 21 reports are one fact, and counted from the plan,
 * never stored, so a retry that lands again starts the count over (ADR-0034's
 * derived rule).
 * Ordewell writes no brief from a report: a runner's words are data, never
 * another task's brief (ADR-0057 R3), so the fix is the supervisor's to write
 * (ADR-0073).
 */

/** A report named in the update: the reporter, its finding, and that finding's title. */
export interface BlockerReport {
  reporter: string;
  finding: string;
  title: string;
}

/** What a `landed_blocker` event says: whose landed work, how many tasks report a blocker in it, and the first few reports. */
export interface LandedBlockerFacts {
  /** The completed task whose work the reports name. */
  owner: string;
  /** Distinct tasks whose handoff reports a blocker in it. */
  reporters: number;
  /** The first {@link LANDED_BLOCKER_NAMED} reports, in plan order. */
  reports: BlockerReport[];
  /** The plan's closing check, when it fans out with one: what the fix must land before. */
  closer?: string;
}

/** How many reports an update names; the rest are counted (ADR-0057 R5). */
export const LANDED_BLOCKER_NAMED = 3;

/**
 * Raised when the count of distinct reporters reaches 1, 2, 4, 8…: the first
 * report, its corroboration, then each doubling. 21 reports raise five events
 * over a run, not 21, and a supervisor that judged two reports noise hears
 * again only once there are four.
 */
export function raisesAt(count: number): boolean {
  return count > 0 && (count & (count - 1)) === 0;
}

/** The files a completed task's landing changed, workspace-relative; undefined where nothing says. */
export type LandedPaths = (taskId: string) => readonly string[] | undefined;

/** The completed tasks a finding names as blocked by their work, at the attempt that landed. */
function ownersNamed(finding: HandoffFinding, reporter: Task, byId: ReadonlyMap<string, Task>, landedPaths?: LandedPaths): string[] {
  if (finding.severity !== 'blocker') return [];
  const cited = (finding.evidence ?? []).flatMap((ref) => {
    if (ref.kind !== 'task') return [];
    const owner = landedOwner(ref, reporter, byId);
    return owner ? [owner] : [];
  });
  const changed = landedPaths ? fileOwner(finding, reporter, byId, landedPaths) : undefined;
  return [...new Set([...cited, ...(changed ? [changed] : [])])];
}

/**
 * Whether `owner`'s work had landed when `reporter` reported on it. A report
 * made before is about work that was not there, so the count never jumps past
 * its first raise when the work it named lands later; and a retry that lands
 * again starts the count over.
 */
function landedBefore(owner: Task, reporter: Task): boolean {
  return owner.id !== reporter.id && owner.status === 'completed' && (settledAt(owner) ?? -Infinity) <= (settledAt(reporter) ?? Infinity);
}

/**
 * The landed task a finding's files name: the first file it cites that landed
 * work changed, where the defect is, not the callers it shows in after it. Of
 * several landings that changed that file, the last before the report, which is
 * the work the reporter's tree held.
 */
function fileOwner(finding: HandoffFinding, reporter: Task, byId: ReadonlyMap<string, Task>, landedPaths: LandedPaths): string | undefined {
  const landed = [...byId.values()].filter((t) => landedBefore(t, reporter));
  for (const ref of finding.evidence ?? []) {
    if (ref.kind !== 'file') continue;
    const path = ref.path.replace(/\\/g, '/').replace(/^\.\//, '');
    const owners = landed.filter((t) => landedPaths(t.id)?.includes(path));
    if (owners.length > 0) return owners.reduce((last, t) => ((settledAt(t) ?? -Infinity) > (settledAt(last) ?? -Infinity) ? t : last)).id;
  }
  return undefined;
}

/** When a task's verdict was decided: for a landed task, when its work landed; for a reporter, when it reported. */
function settledAt(task: Task): number | undefined {
  const at = Date.parse(task.verdict?.decidedAt ?? '');
  return Number.isNaN(at) ? undefined : at;
}

function landedOwner(ref: TaskEvidence, reporter: Task, byId: ReadonlyMap<string, Task>): string | undefined {
  // A plan below this one is its own supervisor's: its tasks are not this plan's to fix.
  if (ref.node !== undefined && ref.node !== ROOT_NODE) return undefined;
  // A finding named cites that report, which may be about anyone's work: a recorded run's slices cited one on unlanded code.
  if (ref.finding !== undefined) return undefined;
  const owner = byId.get(ref.task);
  if (!owner || !landedBefore(owner, reporter)) return undefined;
  // A report against an attempt that a later one replaced says nothing of the work that landed.
  const landedAttempt = owner.handoff?.attempt;
  if (ref.attempt !== undefined && landedAttempt !== undefined && ref.attempt !== landedAttempt) return undefined;
  return owner.id;
}

/**
 * The `landed_blocker` facts that `reporterId`'s handoff, as it settles,
 * raises: one per landed task it names whose count of reporters has just
 * reached a power of two. `plan` is the plan tree as it stands, with the
 * reporter's handoff on it.
 */
export function landedBlockers(plan: readonly Task[], reporterId: string, landedPaths?: LandedPaths): LandedBlockerFacts[] {
  const tasks = flattenTasks([...plan]);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const reporter = byId.get(reporterId);
  if (!reporter) return [];
  const named = new Set((reporter.handoff?.findings ?? []).flatMap((f) => ownersNamed(f, reporter, byId, landedPaths)));
  if (named.size === 0) return [];
  const closer = fanOutShape(plan as Task[]).closers[0]?.id;
  const out: LandedBlockerFacts[] = [];
  for (const owner of named) {
    const reports: BlockerReport[] = [];
    let reporters = 0;
    for (const task of tasks) {
      const hits = (task.handoff?.findings ?? []).filter((f) => ownersNamed(f, task, byId, landedPaths).includes(owner));
      if (hits.length === 0) continue;
      reporters++;
      if (reports.length < LANDED_BLOCKER_NAMED) reports.push({ reporter: task.id, finding: hits[0].id, title: hits[0].title });
    }
    if (raisesAt(reporters)) out.push({ owner, reporters, reports, ...(closer && closer !== owner ? { closer } : {}) });
  }
  return out;
}
