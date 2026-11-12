/** The part of a run's handoff a Merge confirmation is worded from; structural, so each surface passes the handoff it holds. */
export interface MergeWordingHandoff {
  repos: readonly { path: string; baseBranch?: string; landed: readonly unknown[] }[];
}

/**
 * Whether the run spans more than a lone repo at the workspace root. A group of
 * one at `.` is worded and drawn exactly as it was before repo groups; anything
 * else names its repos.
 */
export function isRepoGroup(handoff: { repos: readonly { path: string }[] }): boolean {
  return handoff.repos.some((r) => r.path !== '.');
}

/** The repos Merge all will merge: those with work on their integration branch, else all of them. */
export function reposWithWork(handoff: MergeWordingHandoff): string[] {
  const withWork = handoff.repos.filter((r) => r.landed.length > 0);
  return (withWork.length > 0 ? withWork : handoff.repos).map((r) => r.path);
}

/**
 * What a Merge confirmation says the branch lands on: the branch the run
 * started on, which Merge all insists is checked out. A repo that started
 * detached has none, and keeps the old wording.
 */
export function mergeTarget(handoff: MergeWordingHandoff): string {
  if (!isRepoGroup(handoff)) return handoff.repos[0]?.baseBranch ?? 'the branch you have checked out';
  const targets = handoff.repos.filter((r) => reposWithWork(handoff).includes(r.path));
  const branches = new Set(targets.map((r) => r.baseBranch));
  const [only] = branches;
  if (branches.size === 1 && only) return `${only} in each of ${targets.map((r) => r.path).join(', ')}`;
  return `each of ${targets.map((r) => `${r.path} (${r.baseBranch ?? 'as checked out'})`).join(', ')}`;
}

/** The refusal Merge all makes when a repo is on another branch, for a confirmation to warn of; empty when no repo named a branch. */
export function checkoutRule(handoff: MergeWordingHandoff): string {
  const named = handoff.repos.filter((r) => r.baseBranch);
  if (named.length === 0) return '';
  if (!isRepoGroup(handoff)) return ` Nothing is merged unless ${named[0]!.baseBranch} is checked out.`;
  return ' Nothing is merged unless each repository is on the branch it started on.';
}

/**
 * The run's integration branch as one line names it. Every repo's has the same
 * name (ADR-0014), so the line collapses to that one; a record written when
 * they differed still names each.
 */
export function handoffBranchName(handoff: { repos: readonly { integrationBranch: string }[] }): string {
  return [...new Set(handoff.repos.map((r) => r.integrationBranch))].join(', ');
}

/** The facts a repo's fork line is written from. */
export interface HandoffForkRepo {
  path: string;
  baseRef: string;
  /** The branch the run started on; absent on a detached HEAD, and on a record saved before this was noted. */
  baseBranch?: string;
  /** Set when the run started on a detached HEAD, so that is told from a record that never noted its branch. */
  startedDetached?: true;
}

/**
 * Where one repo's run forked: the branch and the commit, or that it started
 * detached, or just the commit when the record never noted a branch.
 */
export function repoBaseLine(repo: HandoffForkRepo, length: number): string {
  const commit = repo.baseRef.slice(0, length);
  return repo.baseBranch ? `${repo.baseBranch} @ ${commit}` : `${repo.startedDetached ? 'detached at' : 'base'} ${commit}`;
}

/**
 * Where the run forked, as one line names it: each repo's line, headed by its
 * path when the run spans a group, so a surface drawing one base reads the
 * same wording a surface drawing all of them does.
 */
export function handoffBaseLine(handoff: { repos: readonly HandoffForkRepo[] }, length: number): string {
  const group = isRepoGroup(handoff);
  return handoff.repos.map((repo) => `${group ? `${repo.path}: ` : ''}${repoBaseLine(repo, length)}`).join(', ');
}

/** One line per repo: what landed on its integration branch, or that there is nothing to merge. */
export function repoResultLines(handoff: { repos: readonly { path: string; landed: readonly unknown[] }[] }): string[] {
  return handoff.repos.map(({ path, landed }) => `${path}: ${landed.length === 0 ? 'nothing to merge' : `${landed.length} task${landed.length === 1 ? '' : 's'} landed`}`);
}

/**
 * What a Merge all asks the user to confirm when a delegated task's check has
 * not passed (ADR-0055 D9), the checks named as the plan names them. Every
 * surface asks with these words, and the inbox's option carries them.
 */
export function mergePastChecksConfirmation(checks: readonly string[]): string {
  return `This merges work no check has passed: ${checks.join(', ')} ${checks.length === 1 ? 'has' : 'have'} not.`;
}

/**
 * What the user's Merge all asks to confirm while ops tasks run in their
 * checkout (ADR-0020), the tasks named as the plan names them: the merge
 * rewrites files those tasks may be reading or building from, which only a
 * person who knows where they work can rule out.
 */
export function mergeBesideOpsConfirmation(tasks: readonly string[]): string {
  const one = tasks.length === 1;
  return `Ops task${one ? '' : 's'} ${tasks.join(', ')} ${one ? 'is' : 'are'} running in your checkout. Merge all rewrites files there that ${one ? 'it' : 'they'} may be reading, building or committing: merge beside ${one ? 'it' : 'them'} only if ${one ? 'it works' : 'they work'} outside your checkout.`;
}
