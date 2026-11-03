import type { Branches, BranchInfo, CommitSummary, Owner } from './gitData';

/*
 * What the Git view says about its data: pure, so the words a confirm shows
 * and the marks a commit carries are tested without a daemon.
 */

/** A run's own refs: `ordewell/<run>/…` and `ordewell-preserved/<run>/…`, never switched to or deleted from here. */
const RUN_REF = /^ordewell(?:-preserved)?\/([^/]+)\//;

export function isOrdewellRef(name: string): boolean {
  return RUN_REF.test(name);
}

/** A repository as a confirm names it: its name, and where it is on disk. */
export function repoDisplay(workspace: string, repo: string): { name: string; path: string } {
  const root = workspace.replace(/\/+$/, '');
  if (repo === '.' || repo === '') return { name: root.slice(root.lastIndexOf('/') + 1) || root, path: root };
  return { name: repo, path: repo.startsWith('/') ? repo : `${root}/${repo}` };
}

/** `origin/main` as the remote and branch a pull or push is confirmed with. */
export function splitUpstream(upstream: string): { remote: string; branch: string } {
  const slash = upstream.indexOf('/');
  return slash < 0 ? { remote: upstream, branch: '' } : { remote: upstream.slice(0, slash), branch: upstream.slice(slash + 1) };
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** How many commits a branch is ahead and behind its upstream, as the sidebar marks it; empty when level. */
export function trackMark(branch: Pick<BranchInfo, 'ahead' | 'behind' | 'upstream'>): string {
  return [branch.ahead > 0 ? `↑${branch.ahead}` : '', branch.behind > 0 ? `↓${branch.behind}` : ''].filter(Boolean).join(' ');
}

export type RefKind = 'head' | 'branch' | 'remote' | 'tag' | 'ordewell';

export interface RefChip {
  text: string;
  kind: RefKind;
  /** The branch HEAD is on. */
  current?: boolean;
  /** Why it is marked Ordewell's, when it is. */
  owner?: Owner;
}

/**
 * The names git decorates a commit with, told apart by what the branch list
 * knows: a name that is no branch and no remote branch is a tag. Ordewell's
 * integration and task branches carry their owner so the graph can mark whose
 * they are.
 */
export function refChips(refs: readonly string[], branches: Branches | undefined): RefChip[] {
  const local = new Set(branches?.local.map((b) => b.name));
  const remote = new Set(branches?.remote.map((b) => b.name));
  const owners = new Map(branches?.ordewell.map((b) => [b.name, b.owner] as const));
  const chips = refs.map((text): RefChip => {
    if (text === 'HEAD') return { text, kind: 'head' };
    if (isOrdewellRef(text)) {
      const owner = owners.get(text);
      return { text, kind: 'ordewell', ...(owner ? { owner } : {}) };
    }
    if (local.has(text)) return { text, kind: 'branch', ...(branches?.current === text ? { current: true } : {}) };
    if (remote.has(text)) return { text, kind: 'remote' };
    return { text, kind: 'tag' };
  });
  const order: Record<RefKind, number> = { head: 0, branch: 1, ordewell: 2, remote: 3, tag: 4 };
  return chips.sort((a, b) => order[a.kind] - order[b.kind]);
}

/** A task as the graph links a landed commit to it. */
export interface LandedTask {
  taskId: string;
  order: number;
  title: string;
}

/**
 * The subject a task's landing commit was written from: Ordewell's merge
 * wording around it comes off (landingMessage.ts), so what is left is the
 * title or the subject the task's handoff stated.
 */
export function landingSubject(subject: string): string {
  return subject
    .replace(/^(Merge|WIP|Revert): /, '')
    .replace(/ \((resume its kept work|resolve conflicts with integration)\)$/, '')
    .trim();
}

/**
 * The task a commit landed from, when the commit is on a run's integration
 * branch and its subject is a landed task's title. Nothing else says so: a
 * commit with no match is not linked rather than guessed at.
 */
export function landedTaskOf(commit: Pick<CommitSummary, 'sha' | 'subject'>, onIntegration: ReadonlySet<string>, landed: readonly LandedTask[]): LandedTask | undefined {
  if (!onIntegration.has(commit.sha)) return undefined;
  const subject = landingSubject(commit.subject);
  return landed.find((task) => task.title.trim() === subject);
}

/** `2025-01-05T12:00:00Z` as "2d", "1h", "now": the graph's date column. */
export function ago(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

/** The run a branch belongs to or lands for, named as the sidebar's lock does: `run r7`. */
export function runMark(branch: BranchInfo): string | undefined {
  const run = branch.landingFor?.[0] ?? branch.owner;
  return run ? `run ${run.runId}` : undefined;
}

/*
 * Tab ids. A git ref never holds `//` and neither does a path inside a
 * repository, so the pieces split on it the way a file tab's id does.
 */
const SEP = '//';

/** The graph of `repo`, from `ref` when it is not the checkout's own history. */
export function commitsTabId(repo: string, ref?: string): string {
  return ref ? `${repo}${SEP}${ref}` : repo;
}

export function parseCommitsTabId(id: string): { repo: string; ref?: string } {
  const at = id.indexOf(SEP);
  return at < 0 ? { repo: id } : { repo: id.slice(0, at), ref: id.slice(at + SEP.length) };
}

export function commitDiffTabId(repo: string, sha: string, path: string): string {
  return [repo, sha, path].join(SEP);
}

export function parseCommitDiffTabId(id: string): { repo: string; sha: string; path: string } {
  const [repo = '.', sha = '', ...path] = id.split(SEP);
  return { repo, sha, path: path.join(SEP) };
}
