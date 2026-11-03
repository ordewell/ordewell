import type { GitRepoInfo } from '@ordewell/core';
import type { HostState } from '@ordewell/ui';
import { changeLetter, type Hunk } from '../changes/changesModel';

/*
 * What the checkout group draws, as plain data: git's status per repository,
 * whether its last commit can be amended, and the note a live run puts above
 * the files it will land on. Pure, so the sidebar is tested without a daemon.
 */

/** A row's letter: git's own, with `?` for an untracked file and `U` for a conflicted one. */
export type CheckoutLetter = 'A' | 'M' | 'D' | '?' | 'U';

export interface CheckoutFile {
  path: string;
  status: CheckoutLetter;
  from?: string;
}

export interface CheckoutStatus {
  staged: CheckoutFile[];
  changes: CheckoutFile[];
  conflicted: CheckoutFile[];
}

export type CheckoutRepoInfo = GitRepoInfo;

export interface RepoCheckout {
  info: CheckoutRepoInfo;
  status: CheckoutStatus | null;
  /** Why this repository's status could not be read; the rest still draws. */
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function letter(status: string | undefined): CheckoutLetter {
  return changeLetter(status) ?? 'M';
}

/** `GET /api/git/repos`: the branch, upstream and commit each action reasons about. */
export function parseRepoInfo(data: unknown): CheckoutRepoInfo[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.repos)) return undefined;
  const repos: CheckoutRepoInfo[] = [];
  for (const raw of data.repos) {
    if (!isRecord(raw) || typeof raw.repo !== 'string') return undefined;
    repos.push({
      repo: raw.repo,
      branch: typeof raw.branch === 'string' ? raw.branch : null,
      detached: raw.detached === true,
      head: typeof raw.head === 'string' ? raw.head : null,
      upstream: typeof raw.upstream === 'string' ? raw.upstream : null,
      ahead: typeof raw.ahead === 'number' ? raw.ahead : 0,
      behind: typeof raw.behind === 'number' ? raw.behind : 0,
    });
  }
  return repos;
}

/** `GET /api/git/status`: staged and unstaged changes, untracked paths and conflicts, as its four lists. */
export function parseCheckoutStatus(data: unknown): CheckoutStatus | undefined {
  if (!isRecord(data) || !Array.isArray(data.staged) || !Array.isArray(data.unstaged) || !Array.isArray(data.untracked) || !Array.isArray(data.conflicted)) return undefined;
  const staged: CheckoutFile[] = [];
  for (const raw of data.staged) {
    if (!isRecord(raw) || typeof raw.path !== 'string') return undefined;
    staged.push({ path: raw.path, status: letter(typeof raw.status === 'string' ? raw.status : undefined), ...(typeof raw.from === 'string' ? { from: raw.from } : {}) });
  }
  const changes: CheckoutFile[] = [];
  for (const raw of data.unstaged) {
    if (!isRecord(raw) || typeof raw.path !== 'string') return undefined;
    changes.push({ path: raw.path, status: letter(typeof raw.status === 'string' ? raw.status : undefined) });
  }
  for (const raw of data.untracked) {
    if (typeof raw !== 'string') return undefined;
    changes.push({ path: raw, status: '?' });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const conflicted: CheckoutFile[] = [];
  for (const raw of data.conflicted) {
    if (typeof raw !== 'string') return undefined;
    conflicted.push({ path: raw, status: 'U' });
  }
  return { staged, changes, conflicted };
}

/** Every path with an uncommitted change, for Stage all and Discard all. */
export function changedPaths(status: CheckoutStatus): string[] {
  return [...new Set([...status.staged.map((file) => file.path), ...status.changes.map((file) => file.path), ...status.conflicted.map((file) => file.path)])].sort();
}

export function pathsToStage(status: CheckoutStatus): string[] {
  return [...new Set([...status.changes.map((file) => file.path), ...status.conflicted.map((file) => file.path)])].sort();
}

/**
 * Amend only while HEAD is on no remote-tracking branch (ADR-0062 G4). Ahead of
 * a known upstream is unpushed; a branch with no upstream has nowhere pushed.
 */
export function canAmend(info: CheckoutRepoInfo | undefined): boolean {
  if (!info || info.head === null) return false;
  return info.upstream === null || info.ahead > 0;
}

/** The branch a live run lands on in this repository, when it is the branch checked out now. */
export function liveLandingBranch(state: HostState, repo: string, branch: string | null): string | undefined {
  const live = state.isExecuting || state.activity.advancesOnItsOwn || state.run.activity?.advancesOnItsOwn === true;
  if (!live || branch === null) return undefined;
  const handoff = state.run.handoff ?? state.run.runMerge;
  const entry = handoff?.repos.find((candidate) => candidate.path === repo);
  if (!entry || entry.startedDetached || entry.baseBranch === undefined || entry.baseBranch !== branch) return undefined;
  return entry.baseBranch;
}

/**
 * One hunk of a file's patch, with the file header above it: what stage and
 * unstage take as `hunks`, cut from the diff the person was shown (ADR-0062).
 */
export function sliceHunk(patch: string, index: number): string | undefined {
  const header: string[] = [];
  const hunks: string[][] = [];
  let current: string[] | undefined;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ ')) {
      current = [line];
      hunks.push(current);
    } else if (current === undefined) {
      header.push(line);
    } else {
      current.push(line);
    }
  }
  const hunk = hunks[index];
  if (!hunk) return undefined;
  const lines = [...header, ...hunk];
  // A patch is text: one newline at its end, never a blank line git reads as context.
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

/** The drawn line of the after side a hunk's action sits under, so Monaco places its widget at the change. */
export function hunkAfterLine(sides: { lines: { modified: number[] } }, hunk: Hunk): number {
  const wanted = hunk.newLines > 0 ? hunk.newStart + hunk.newLines - 1 : Math.max(1, hunk.newStart - 1);
  const at = sides.lines.modified.indexOf(wanted);
  if (at >= 0) return at + 1;
  const firstAfter = sides.lines.modified.findIndex((line) => line > 0 && line >= hunk.newStart);
  return firstAfter >= 0 ? firstAfter + 1 : Math.max(1, sides.lines.modified.length);
}

/** `web`, or the workspace's own checkout. */
export function checkoutRepoLabel(repo: string): string {
  return repo === '.' ? 'Your checkout' : repo;
}
