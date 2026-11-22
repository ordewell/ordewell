import { flattenTasks, landsOnBranch, type Task } from '../models/Task';
import { planBlocks } from './blocking';
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
 * `blocker` whose evidence cites a landed task, by task reference pinned to the
 * attempt that landed or unpinned, landed when it was reported, or by a file
 * that landed work changed before the reporting attempt started and no other
 * task's landing changed since. The second is the one a recorded run needed: of
 * its 65 blockers, 61 cited only files and commits. A finding that also cites a
 * task yet to land is waiting on it, not blocked by what landed. Reports are
 * grouped by the task whose work they name, so 21 reports are one fact, and
 * counted from the plan, never stored, so a retry that lands again starts the
 * count over and a report a later landing overtook stops counting (ADR-0034's
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

/**
 * The landed task a finding names as blocked by its work, at the attempt that
 * landed: the first task it cites, else the owner of its files. One at most,
 * as the file signal is: a closing check's "the merged tree does not build"
 * citing every slice is one defect, not a fix owed by each.
 */
function ownerNamed(finding: HandoffFinding, reporter: Task, byId: ReadonlyMap<string, Task>, landedPaths?: LandedPaths): string | undefined {
  if (finding.severity !== 'blocker' || waitsOn(finding, reporter, byId)) return undefined;
  for (const ref of finding.evidence ?? []) {
    const owner = ref.kind === 'task' ? landedOwner(ref, reporter, byId) : undefined;
    if (owner) return owner;
  }
  return landedPaths ? fileOwner(finding, reporter, byId, landedPaths) : undefined;
}

/**
 * Whether a finding cites, by task reference, work of this plan still to come
 * when it was reported: a wait notice, never a blocker in landed work, whatever
 * files it cites: those may be the placeholders a landed task left for the
 * work it waits on. Only a task that can still land before the reporter's
 * work is wanted is work to come: one skipped or failed lands nothing, and one
 * that waits for the reporter, as the closing check the slice note names as
 * the one the work is for does, runs after it.
 */
function waitsOn(finding: HandoffFinding, reporter: Task, byId: ReadonlyMap<string, Task>): boolean {
  const reportedAt = settledAt(reporter) ?? Infinity;
  return (finding.evidence ?? []).some((ref) => {
    if (ref.kind !== 'task' || ref.finding !== undefined || (ref.node !== undefined && ref.node !== ROOT_NODE)) return false;
    const cited = byId.get(ref.task);
    if (!cited || cited.id === reporter.id || !landsOnBranch(cited) || waitsFor(cited, reporter.id, byId)) return false;
    if (cited.status === 'completed') return (settledAt(cited) ?? -Infinity) > reportedAt;
    return cited.status !== 'skipped' && cited.status !== 'failed';
  });
}

/** Whether `task` depends, directly or not, on the task `id`. */
function waitsFor(task: Task, id: string, byId: ReadonlyMap<string, Task>): boolean {
  const seen = new Set<string>();
  const queue = [...task.dependencies];
  for (let dep = queue.pop(); dep !== undefined; dep = queue.pop()) {
    if (dep === id) return true;
    if (seen.has(dep)) continue;
    seen.add(dep);
    queue.push(...(byId.get(dep)?.dependencies ?? []));
  }
  return false;
}

/** Whether `owner`'s work had landed by `at`: a retry that lands again starts the count over. */
function landedBy(owner: Task, reporter: Task, at: number): boolean {
  return owner.id !== reporter.id && owner.status === 'completed' && landsOnBranch(owner) && (settledAt(owner) ?? -Infinity) <= at;
}

/**
 * When the reporting attempt started, which is when its tree last held what
 * had landed by the records: a take-in later is the runner's own merge, with
 * no time on the plan (ADR-0013). Without the attempt's record, when it
 * reported.
 */
function heldFrom(reporter: Task): number {
  const attempt = reporter.handoff?.attempt;
  const usage = attempt === undefined ? undefined : reporter.attemptUsage?.find((u) => u.attempt === attempt);
  const started = Date.parse(usage?.startedAt ?? '');
  return Number.isNaN(started) ? settledAt(reporter) ?? Infinity : started;
}

/**
 * The landed task a finding's files name: the first file it cites that landed
 * work changed, where the defect is, not the callers it shows in after it. Of
 * several landings that changed that file, the last before the reporting
 * attempt started, which is the work its tree held: a file says nothing of a
 * take-in after, as a task reference does.
 *
 * None, once another task's landing after that start changed that file: what
 * the report complained of was still being written, as a placeholder the
 * opening task left for a slice is. Every report from a tree cut before that
 * landing is judged alike, whenever it was made, so the count does not fall
 * and climb back through 1 and 2 on the reports that came after it.
 */
function fileOwner(finding: HandoffFinding, reporter: Task, byId: ReadonlyMap<string, Task>, landedPaths: LandedPaths): string | undefined {
  const completed = [...byId.values()].filter((t) => t.id !== reporter.id && t.status === 'completed' && landsOnBranch(t));
  const held = heldFrom(reporter);
  const landed = completed.filter((t) => landedBy(t, reporter, held));
  for (const ref of finding.evidence ?? []) {
    if (ref.kind !== 'file') continue;
    const path = ref.path.replace(/\\/g, '/').replace(/^\.\//, '');
    const changed = (t: Task) => landedPaths(t.id)?.includes(path) === true;
    const owners = landed.filter(changed);
    if (owners.length === 0) continue;
    const owner = owners.reduce((last, t) => ((settledAt(t) ?? -Infinity) > (settledAt(last) ?? -Infinity) ? t : last));
    return completed.some((t) => t.id !== owner.id && (settledAt(t) ?? -Infinity) > held && changed(t)) ? undefined : owner.id;
  }
  return undefined;
}

/** When a task's verdict was decided: for a landed task, when its work landed; for a reporter, when it reported. */
function settledAt(task: Task): number | undefined {
  const at = Date.parse(task.verdict?.decidedAt ?? '');
  return Number.isNaN(at) ? undefined : at;
}

/**
 * The landed task a reference names: landed by the time of the report, not of
 * the attempt's start, since a reporter that names a task has its work, taken
 * in mid-attempt as the slice note asks once it lands.
 */
function landedOwner(ref: TaskEvidence, reporter: Task, byId: ReadonlyMap<string, Task>): string | undefined {
  // A plan below this one is its own supervisor's: its tasks are not this plan's to fix.
  if (ref.node !== undefined && ref.node !== ROOT_NODE) return undefined;
  // A finding named cites that report, which may be about anyone's work: a recorded run's slices cited one on unlanded code.
  if (ref.finding !== undefined) return undefined;
  const owner = byId.get(ref.task);
  if (!owner || !landedBy(owner, reporter, settledAt(reporter) ?? Infinity)) return undefined;
  // A report against an attempt that a later one replaced says nothing of the work that landed.
  const landedAttempt = owner.handoff?.attempt;
  if (ref.attempt !== undefined && landedAttempt !== undefined && ref.attempt !== landedAttempt) return undefined;
  return owner.id;
}

/**
 * The `landed_blocker` facts that `reporterId`'s handoff, as it settles,
 * raises: one per landed task its findings name whose count of reporters has just
 * reached a power of two. `plan` is the plan tree as it stands, with the
 * reporter's handoff on it.
 */
export function landedBlockers(plan: readonly Task[], reporterId: string, landedPaths?: LandedPaths): LandedBlockerFacts[] {
  const tasks = flattenTasks([...plan]);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const reporter = byId.get(reporterId);
  // A loop's check between rounds has its fix in hand: the loop's body is that fix, and runs again (ADR-0045 L3).
  const { repeating } = planBlocks([...plan]);
  if (!reporter || repeating.has(reporterId)) return [];
  const ownerOf = (f: HandoffFinding, by: Task) => ownerNamed(f, by, byId, landedPaths);
  const named = new Set((reporter.handoff?.findings ?? []).flatMap((f) => ownerOf(f, reporter) ?? []));
  if (named.size === 0) return [];
  const closer = fanOutShape(plan as Task[]).closers[0]?.id;
  const out: LandedBlockerFacts[] = [];
  for (const owner of named) {
    const reports: BlockerReport[] = [];
    let reporters = 0;
    for (const task of tasks) {
      if (repeating.has(task.id)) continue;
      const hits = (task.handoff?.findings ?? []).filter((f) => ownerOf(f, task) === owner);
      if (hits.length === 0) continue;
      reporters++;
      if (reports.length < LANDED_BLOCKER_NAMED) reports.push({ reporter: task.id, finding: hits[0].id, title: hits[0].title });
    }
    if (raisesAt(reporters)) out.push({ owner, reporters, reports, ...(closer && closer !== owner ? { closer } : {}) });
  }
  return out;
}
