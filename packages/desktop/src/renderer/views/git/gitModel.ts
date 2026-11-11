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

/**
 * A stash's row label: its message without the "On main: " or "WIP on main: " git puts first, which would take the row's
 * width from the words the person wrote. The row's tooltip keeps git's message whole.
 */
export function stashLabel(message: string): string {
  return message.replace(/^(?:WIP on|On) [^:]+: /, '') || message;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * How many commits a branch is behind and ahead of its upstream, as the
 * sidebar marks it; empty when level. Behind comes first, as the sync bar
 * puts it, so the two never read in opposite orders on one screen.
 */
export function trackMark(branch: Pick<BranchInfo, 'ahead' | 'behind' | 'upstream'>): string {
  return [branch.behind > 0 ? `↓${branch.behind}` : '', branch.ahead > 0 ? `↑${branch.ahead}` : ''].filter(Boolean).join(' ');
}

export type BranchNode =
  | { kind: 'folder'; key: string; /** The prefix it stands for, without a trailing slash. */ path: string; label: string; count: number; /** It holds the branch HEAD is on. */ current: boolean; children: BranchNode[] }
  | { kind: 'leaf'; key: string; label: string; branch: BranchInfo };

/** Names in the order a person reads a list of them: case aside, and `release/1.10` after `release/1.9`. */
const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Slash-delimited branch names as folders, the way the sidebar groups them.
 * The branch HEAD is on leads the list under its full name, outside any
 * folder, so the checkout is the first row and not the last. Every other row,
 * folder and branch alike, is in one alphabetical order at each level, the
 * same in every group. A chain of folders that each hold only one folder folds
 * into one row, so `ordewell/r7/…` costs a row and not two. A branch named
 * like a folder (`feature` beside `feature/login`) stays its own row, just
 * before it: keys tell the two apart, and every action takes the branch's full
 * name, never the label.
 */
export function branchTree(branches: readonly BranchInfo[]): BranchNode[] {
  interface Dir { folders: Map<string, Dir>; leaves: BranchInfo[] }
  const root: Dir = { folders: new Map(), leaves: [] };
  const pinned = branches.filter((b) => b.current);
  for (const branch of branches) {
    if (branch.current) continue;
    const segments = branch.name.split('/');
    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      let next = dir.folders.get(segment);
      if (!next) dir.folders.set(segment, (next = { folders: new Map(), leaves: [] }));
      dir = next;
    }
    dir.leaves.push(branch);
  }
  const nodes = (dir: Dir, prefix: string): BranchNode[] => [
    ...[...dir.folders].map(([segment, sub]): BranchNode => {
      let label = segment;
      let inner = sub;
      while (inner.leaves.length === 0 && inner.folders.size === 1) {
        const [[next, deeper]] = [...inner.folders];
        label = `${label}/${next}`;
        inner = deeper;
      }
      const path = prefix + label;
      const children = nodes(inner, `${path}/`);
      const count = children.reduce((n, c) => n + (c.kind === 'folder' ? c.count : 1), 0);
      const current = children.some((c) => (c.kind === 'folder' ? c.current : c.branch.current));
      return { kind: 'folder', key: `folder:${path}`, path, label, count, current, children };
    }),
    ...dir.leaves.map((branch): BranchNode => ({ kind: 'leaf', key: `branch:${branch.name}`, label: branch.name.slice(prefix.length), branch })),
    // Ties are a branch beside its namesake folder, branch first, or names apart only in case, by code point.
  ].sort((a, b) => byName.compare(a.label, b.label) || (a.kind !== b.kind ? (a.kind === 'leaf' ? -1 : 1) : a.label < b.label ? -1 : 1));
  return [
    ...pinned.map((branch): BranchNode => ({ kind: 'leaf', key: `branch:${branch.name}`, label: branch.name, branch })),
    ...nodes(root, ''),
  ];
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

/** What a narrow history row says of a commit's refs: one chip, a count of the rest, every name. */
export interface RefSummary {
  lead: (RefChip & { tracked?: string }) | undefined;
  /** The names beyond the lead chip; a remote-tracking ref folded into its branch is not one. */
  more: number;
  /** Every name, HEAD left out, for a tooltip or a screen reader. */
  names: string[];
}

/**
 * The refs of a commit as a row too narrow for several chips tells them: the
 * first of refChips' order, the checked-out branch before any other branch.
 * A local branch and the remote-tracking ref of the same name at this commit
 * are one chip, marked `tracked`, so `feature/sso` and `origin/feature/sso`
 * do not count as two.
 */
export function summarizeRefs(chips: readonly RefChip[]): RefSummary {
  const shown = chips.filter((chip) => chip.kind !== 'head');
  const locals = new Set(shown.filter((chip) => chip.kind === 'branch').map((chip) => chip.text));
  const trackedBy = new Map<string, string>();
  const folded = new Set<RefChip>();
  for (const chip of shown) {
    const name = chip.kind === 'remote' ? chip.text.slice(chip.text.indexOf('/') + 1) : undefined;
    if (name !== undefined && locals.has(name) && !trackedBy.has(name)) {
      trackedBy.set(name, chip.text);
      folded.add(chip);
    }
  }
  const rank = (chip: RefChip): number => (chip.current ? -1 : 0);
  const kept = shown.filter((chip) => !folded.has(chip)).sort((a, b) => rank(a) - rank(b));
  const first = kept[0];
  const tracked = first && first.kind === 'branch' ? trackedBy.get(first.text) : undefined;
  return {
    lead: first && (tracked ? { ...first, tracked } : first),
    more: Math.max(0, kept.length - 1),
    names: shown.map((chip) => chip.text),
  };
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

/** How long ago a branch's tip was committed: "2d", "now", or empty when the daemon sent no date. */
export function tipAge(branch: Pick<BranchInfo, 'date'>, now: number = Date.now()): string {
  return branch.date ? ago(branch.date, now) : '';
}

/**
 * What a branch row says beyond its name, for the tooltip and the accessible
 * description: the tip's subject and age ("Fix the login redirect · 2d ago").
 * Empty when the daemon sent neither.
 */
export function tipSummary(branch: Pick<BranchInfo, 'date' | 'subject'>, now: number = Date.now()): string {
  const age = tipAge(branch, now);
  return [branch.subject, age && (age === 'now' ? 'just now' : `${age} ago`)].filter(Boolean).join(' · ');
}

/** A commit's date for its own tab, where there is room for it: `Jan 5, 2025, 12:00 PM`, or the text as given when it is not a date. */
export function commitWhen(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
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

/** One commit's message and files, full width. */
export function commitTabId(repo: string, sha: string): string {
  return [repo, sha].join(SEP);
}

export function parseCommitTabId(id: string): { repo: string; sha: string } {
  const at = id.lastIndexOf(SEP);
  return { repo: id.slice(0, at), sha: id.slice(at + SEP.length) };
}

export function commitDiffTabId(repo: string, sha: string, path: string): string {
  return [repo, sha, path].join(SEP);
}

export function parseCommitDiffTabId(id: string): { repo: string; sha: string; path: string } {
  const [repo = '.', sha = '', ...path] = id.split(SEP);
  return { repo, sha, path: path.join(SEP) };
}
