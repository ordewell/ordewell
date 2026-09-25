import type { IsolationMergeBlock, IsolationMergeResult } from '../interfaces/IWorktreeIsolation';
import { SELF_REPO } from './isolationRecord';

/** One repo that kept "Merge all" from touching anything, as part of one line. */
function blockNotice({ repo, reason, files }: IsolationMergeBlock): string {
  switch (reason) {
    case 'merge-in-progress': return `${repo} has a merge in progress`;
    case 'conflict': return `${repo} would conflict in ${files.join(', ')}`;
    case 'uncommitted-changes': return `${repo} has uncommitted changes to ${files.join(', ')}`;
    case 'partial-landing': return `${repo} holds part of a task whose landing could not be rolled back`;
    case 'git-error': return `git could not check ${repo}`;
  }
}

/** Which repos a "Merge all" that stopped part-way had merged already; merges into the user's branches are never undone. */
function landedNotice(landed: string[]): string {
  if (landed.length === 0) return 'Nothing was merged.';
  return landed.length === 1 ? `${landed[0]} was merged already and stays merged.` : `${landed.join(', ')} were merged already and stay merged.`;
}

/**
 * How "Merge all" went, in words every surface shares. `group` is whether the
 * run spans more than a lone repo at `.`; only a merge into every repository
 * has something to say about that.
 */
export function describeMergeResult(
  result: IsolationMergeResult,
  branch: string,
  group: boolean,
): { level: 'info' | 'warn' | 'error'; message: string } {
  switch (result.outcome) {
    case 'merged':
      return {
        level: 'info',
        message: group
          ? `Merged ${branch} into the checked-out branch of every repository.`
          : `Merged ${branch} into your checked-out branch.`,
      };
    case 'blocked':
      return { level: 'warn', message: `Merged nothing, so every tree is as it was: ${result.blocked.map(blockNotice).join('; ')}.` };
    case 'conflict':
      return {
        level: 'warn',
        message: result.repo === SELF_REPO
          ? `Merging ${branch} conflicted, so it was aborted — your tree is as it was.`
          : `Merging ${branch} conflicted in ${result.repo}${result.files?.length ? ` (${result.files.join(', ')})` : ''}, so it was aborted there. ${landedNotice(result.landed ?? [])}`,
      };
    case 'failed':
      return {
        level: 'error',
        message: result.repo === SELF_REPO
          ? `Could not merge ${branch} — finish or abort the merge already in progress, then try again.`
          : `Could not merge ${branch} in ${result.repo} — finish or abort any merge in progress there, then try again. ${landedNotice(result.landed ?? [])}`,
      };
  }
}
