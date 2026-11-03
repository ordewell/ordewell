import { checkoutRule, handoffBranchName, mergeTarget } from '@ordewell/core/plan-utils';
import type { IsolationHandoff, MergePreflightResponse } from '@ordewell/core';
import { mergeAllConfirmation, type ConfirmationRequest } from '@ordewell/ui/host';

/*
 * Merge all's preflight (ADR-0062 G8), as the dialog asks it: where the run
 * lands, what merging costs, and the user's own uncommitted files the merge
 * would collide with, per repository. Pure: the flow that calls the daemon is
 * mergeAll.ts.
 */

export type PreflightChoice = 'merge' | 'stash' | 'commit';

export interface PreflightRow {
  repo: string;
  /** The branch it lands on, worded for a run that started detached too. */
  branch: string;
  overlap: string[];
  otherDirty: boolean;
}

export interface PreflightModel {
  rows: PreflightRow[];
  /** Some repository holds an uncommitted file the merge also changes: merging now is not offered. */
  overlapping: boolean;
  request: ConfirmationRequest<PreflightChoice>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The daemon's answer, checked: a page trusts nothing it did not parse. */
export function parsePreflight(data: unknown): MergePreflightResponse | undefined {
  if (!isRecord(data) || typeof data.runId !== 'string' || typeof data.stashMessage !== 'string' || !Array.isArray(data.repos)) return undefined;
  const repos: MergePreflightResponse['repos'] = [];
  for (const raw of data.repos) {
    if (!isRecord(raw) || typeof raw.repo !== 'string' || !Array.isArray(raw.overlap)) return undefined;
    if (!raw.overlap.every((p): p is string => typeof p === 'string')) return undefined;
    repos.push({ repo: raw.repo, branch: typeof raw.branch === 'string' ? raw.branch : null, overlap: raw.overlap, otherDirty: raw.otherDirty === true });
  }
  return { runId: data.runId, repos, stashMessage: data.stashMessage };
}

export function repoName(repo: string): string {
  return repo === '.' ? 'the workspace' : repo;
}

type Handoff = Pick<IsolationHandoff, 'repos' | 'landed'>;

/**
 * The dialog for a preflight's answer. The merge's own words are ui's
 * (`mergeAllConfirmation`), so every host says the same thing; what this adds
 * is the integration branch by name and the files in the way.
 */
export function preflightModel(response: MergePreflightResponse, handoff: Handoff | null, midRun: boolean): PreflightModel {
  const rows = response.repos.map((r) => ({
    repo: r.repo,
    branch: r.branch ?? 'the detached HEAD it started on',
    overlap: r.overlap,
    otherDirty: r.otherDirty,
  }));
  const overlapping = rows.some((r) => r.overlap.length > 0);
  const target = handoff ? mergeTarget(handoff) : 'the branch you have checked out';
  const merge = mergeAllConfirmation(target, handoff ? checkoutRule(handoff) : '', midRun);
  const detail: string[] = [];
  if (handoff && handoff.repos.length > 0) detail.push(`The integration branch ${handoffBranchName(handoff)} is merged, then the task worktrees are cleaned up.`);
  if (overlapping) {
    detail.push('You have uncommitted changes to files the run also changed. Commit them, or stash them to merge now and restore them after.');
  } else if (rows.some((r) => r.otherDirty)) {
    detail.push('Your other uncommitted changes do not touch what the run changed, and stay as they are.');
  }
  const choices = overlapping
    ? [{ id: 'stash' as const, label: 'Stash and merge' }, { id: 'commit' as const, label: 'Commit first' }]
    : [{ id: 'merge' as const, label: 'Merge' }];
  return {
    rows,
    overlapping,
    request: { kind: 'merge_all', message: merge.message, ...(detail.length ? { detail: detail.join('\n\n') } : {}), choices },
  };
}

/** The repositories a Stash choice sets files aside in, each with the files it sets aside. */
export function stashPlan(response: MergePreflightResponse): Array<{ repo: string; paths: string[] }> {
  return response.repos.filter((r) => r.overlap.length > 0).map((r) => ({ repo: r.repo, paths: r.overlap }));
}
