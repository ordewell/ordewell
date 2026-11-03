import type { LandingBranchHeld } from '../daemonContract';
import type { IsolationRun } from '../interfaces/IWorktreeIsolation';
import type { LegacyPlanState } from '../models/Task';
import { listSessions, loadSession } from '../utils/sessionStore';

/**
 * What a live run holds of the user's checkout (ADR-0062 G7): its landing
 * branch, in each repository it lands in, and nothing else.
 */

/** An open isolation run's landing branch in one repository. */
export interface LandingRun {
  sessionId: string;
  runId: string;
  repo: string;
  branch: string;
  /** An attempt in progress, a start pending, or a landing or Merge all under way. */
  live: boolean;
  /** It landed work on its integration branch for this repository that Merge all has not taken yet. */
  unmerged: boolean;
}

/** A user's move of a repository's checkout: a switch (`to` null detaches), or a branch delete. */
export type LandingMove =
  | { kind: 'switch'; repo: string; from: string | null; to: string | null }
  | { kind: 'delete'; repo: string; branch: string };

export interface InterlockAnswer {
  /** The live run that refuses the move; null when the move is allowed. */
  held: LandingBranchHeld | null;
  /** Said with an allowed move that strands a settled run's work until the branch is back. */
  warnings: string[];
}

export function interlock(runs: readonly LandingRun[], move: LandingMove): InterlockAnswer {
  const branch = move.kind === 'delete' ? move.branch : move.from !== move.to ? move.from : null;
  const landing = branch === null ? [] : runs.filter((run) => run.repo === move.repo && run.branch === branch);
  const live = landing.find((run) => run.live);
  if (live) return { held: { sessionId: live.sessionId, runId: live.runId, repo: live.repo, branch: live.branch }, warnings: [] };
  return {
    held: null,
    warnings: landing.filter((run) => run.unmerged).map((run) =>
      `Run ${run.runId} of session ${run.sessionId} lands on ${run.branch} and has work not merged yet: Merge all refuses until ${run.branch} is checked out again.`),
  };
}

/**
 * Every open run's landing branches in a workspace, from each session's saved
 * record: a run that started detached names no branch and holds nothing.
 * `isLive` judges each, since only a host can say whether its run is at work.
 */
export function landingRuns(workspace: string, isLive: (sessionId: string, plan: LegacyPlanState) => boolean): LandingRun[] {
  const runs: LandingRun[] = [];
  for (const meta of listSessions(workspace)) {
    const plan = loadSession(meta.id, workspace)?.plan;
    const run = plan?.isolation?.run;
    if (!plan || !run) continue;
    const entries = run.repos.filter((entry) => entry.baseBranch && !entry.startedDetached);
    if (entries.length === 0) continue;
    const live = isLive(meta.id, plan);
    for (const entry of entries) {
      runs.push({ sessionId: meta.id, runId: run.id, repo: entry.path, branch: entry.baseBranch as string, live, unmerged: landedIn(run, entry.path) });
    }
  }
  return runs;
}

function landedIn(run: IsolationRun, repo: string): boolean {
  if (Object.values(run.landings ?? {}).some((byRepo) => (byRepo[repo]?.length ?? 0) > 0)) return true;
  return Object.values(run.tasks).some((record) => record.repos[repo]?.landedTip !== undefined);
}

/**
 * Whether a run another host holds is live, judged from its saved record: an
 * attempt in progress or a landing under way. What a host knows only in
 * memory (a start pending, a Merge all) it cannot see from here, so the
 * holder's own record is the best evidence a non-holder has.
 */
export function savedRunLooksLive(plan: LegacyPlanState): boolean {
  const run = plan.isolation?.run;
  if (!run) return false;
  if (run.landing) return true;
  return plan.tasks.some(function atWork(task): boolean {
    return task.status === 'in_progress' || (task.subtasks ?? []).some(atWork);
  });
}
