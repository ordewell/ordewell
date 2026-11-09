import { describe, expect, it } from 'vitest';
import type { Branches, BranchInfo } from '../gitData';
import {
  ago, branchTree, commitDiffTabId, commitWhen, commitsTabId, isOrdewellRef, landedTaskOf, landingSubject, parseCommitDiffTabId, parseCommitsTabId, plural, refChips, repoDisplay,
  runMark, splitUpstream, trackMark,
} from '../gitModel';

const branch = (name: string, extra: Partial<BranchInfo> = {}): BranchInfo => ({ name, sha: 'a'.repeat(40), upstream: null, ahead: 0, behind: 0, current: false, ...extra });
const BRANCHES: Branches = {
  repo: '.', current: 'main', detached: false,
  local: [branch('main', { current: true }), branch('feature')],
  ordewell: [branch('ordewell/r7/integration', { owner: { sessionId: 's1', runId: 'r7' } })],
  remote: [branch('origin/main')],
  stashes: [], worktrees: [],
};

describe('naming', () => {
  it('names a repository and where it is', () => {
    expect(repoDisplay('/work/acme/', '.')).toEqual({ name: 'acme', path: '/work/acme' });
    expect(repoDisplay('/work/acme', 'web')).toEqual({ name: 'web', path: '/work/acme/web' });
    expect(repoDisplay('/work/acme', '/elsewhere/api')).toEqual({ name: '/elsewhere/api', path: '/elsewhere/api' });
  });

  it('splits an upstream at its first slash, so a branch with slashes keeps them', () => {
    expect(splitUpstream('origin/feature/login')).toEqual({ remote: 'origin', branch: 'feature/login' });
    expect(splitUpstream('origin')).toEqual({ remote: 'origin', branch: '' });
  });

  it('marks ahead and behind, and nothing when level', () => {
    expect(trackMark({ ahead: 1, behind: 2, upstream: 'origin/main' })).toBe('↑1 ↓2');
    expect(trackMark({ ahead: 0, behind: 3, upstream: 'origin/main' })).toBe('↓3');
    expect(trackMark({ ahead: 0, behind: 0, upstream: 'origin/main' })).toBe('');
  });

  it('counts', () => {
    expect(plural(1, 'commit')).toBe('1 commit');
    expect(plural(2, 'commit')).toBe('2 commits');
  });

  it('knows Ordewell’s refs from the person’s', () => {
    expect(isOrdewellRef('ordewell/r7/integration')).toBe(true);
    expect(isOrdewellRef('ordewell-preserved/r7/t3')).toBe(true);
    expect(isOrdewellRef('ordewell')).toBe(false);
    expect(isOrdewellRef('feature/ordewell/x')).toBe(false);
  });

  it('names the run a branch holds or lands for', () => {
    expect(runMark(branch('main', { landingFor: [{ sessionId: 's1', runId: 'r7' }] }))).toBe('run r7');
    expect(runMark(branch('x'))).toBeUndefined();
  });

  it('says how long ago', () => {
    const now = Date.parse('2025-01-10T12:00:00Z');
    expect(ago('2025-01-10T11:59:50Z', now)).toBe('now');
    expect(ago('2025-01-10T11:30:00Z', now)).toBe('30m');
    expect(ago('2025-01-10T09:00:00Z', now)).toBe('3h');
    expect(ago('2025-01-05T12:00:00Z', now)).toBe('5d');
    expect(ago('2024-09-10T12:00:00Z', now)).toBe('4mo');
    expect(ago('not a date', now)).toBe('');
  });

  it('dates a commit for its own tab, and leaves what is no date as it was', () => {
    expect(commitWhen('2025-01-05T12:00:00Z')).toMatch(/2025/);
    expect(commitWhen('not a date')).toBe('not a date');
  });
});

describe('refChips', () => {
  it('tells HEAD, branches, Ordewell’s, remotes and tags apart, in that order', () => {
    const chips = refChips(['v1.0', 'origin/main', 'ordewell/r7/integration', 'feature', 'main', 'HEAD'], BRANCHES);
    expect(chips.map((c) => [c.text, c.kind])).toEqual([
      ['HEAD', 'head'], ['feature', 'branch'], ['main', 'branch'], ['ordewell/r7/integration', 'ordewell'], ['origin/main', 'remote'], ['v1.0', 'tag'],
    ]);
  });

  it('marks the current branch and carries the owner of an Ordewell branch', () => {
    const chips = refChips(['main', 'ordewell/r7/integration'], BRANCHES);
    expect(chips.find((c) => c.text === 'main')?.current).toBe(true);
    expect(chips.find((c) => c.kind === 'ordewell')?.owner).toEqual({ sessionId: 's1', runId: 'r7' });
  });

  it('reads every name as a tag while the branch list is not known, but still marks Ordewell’s', () => {
    expect(refChips(['main', 'ordewell/r7/t3'], undefined).map((c) => c.kind)).toEqual(['ordewell', 'tag']);
  });
});

describe('landed commits', () => {
  const landed = [{ taskId: 't1', order: 1, title: 'Add the login button' }, { taskId: 't3', order: 3, title: 'Wire SSO' }];

  it('takes Ordewell’s wording off a landing subject', () => {
    expect(landingSubject('Merge: Wire SSO')).toBe('Wire SSO');
    expect(landingSubject('WIP: Wire SSO (resume its kept work)')).toBe('Wire SSO');
    expect(landingSubject('Revert: Wire SSO')).toBe('Wire SSO');
    expect(landingSubject('Wire SSO')).toBe('Wire SSO');
  });

  it('links a commit on the integration branch whose subject is a landed task’s title', () => {
    expect(landedTaskOf({ sha: 'x', subject: 'Merge: Wire SSO' }, new Set(['x']), landed)?.taskId).toBe('t3');
  });

  it('does not link a commit that is not on the integration branch, or whose subject matches no task', () => {
    expect(landedTaskOf({ sha: 'x', subject: 'Wire SSO' }, new Set(['y']), landed)).toBeUndefined();
    expect(landedTaskOf({ sha: 'x', subject: 'Something else' }, new Set(['x']), landed)).toBeUndefined();
  });
});

describe('tab ids', () => {
  it('round-trips a graph id, with and without a ref', () => {
    expect(parseCommitsTabId(commitsTabId('.'))).toEqual({ repo: '.' });
    expect(parseCommitsTabId(commitsTabId('web', 'feature/login'))).toEqual({ repo: 'web', ref: 'feature/login' });
  });

  it('round-trips a commit file id', () => {
    expect(parseCommitDiffTabId(commitDiffTabId('web', 'abc123', 'src/a/b.ts'))).toEqual({ repo: 'web', sha: 'abc123', path: 'src/a/b.ts' });
  });
});

describe('branchTree', () => {
  const names = (...n: string[]) => n.map((name) => branch(name));
  const shape = (nodes: ReturnType<typeof branchTree>): unknown[] => nodes.map((n) => (n.kind === 'folder' ? { folder: n.label, path: n.path, count: n.count, children: shape(n.children) } : n.branch.name));

  it('groups slash-delimited names into folders, folders before branches, and keeps each branch’s full name', () => {
    expect(shape(branchTree(names('main', 'feature/login', 'feature/sso', 'fix/typo')))).toEqual([
      { folder: 'feature', path: 'feature', count: 2, children: ['feature/login', 'feature/sso'] },
      { folder: 'fix', path: 'fix', count: 1, children: ['fix/typo'] },
      'main',
    ]);
  });

  it('labels a branch by its last segment', () => {
    const [folder] = branchTree(names('feature/login'));
    expect(folder.kind === 'folder' && folder.children[0].label).toBe('login');
  });

  it('folds a chain of single folders into one, so a deep prefix costs one row', () => {
    expect(shape(branchTree(names('ordewell/r7/integration', 'ordewell/r7/t3')))).toEqual([
      { folder: 'ordewell/r7', path: 'ordewell/r7', count: 2, children: ['ordewell/r7/integration', 'ordewell/r7/t3'] },
    ]);
  });

  it('keeps a branch named like a folder beside that folder, with keys apart', () => {
    const tree = branchTree(names('feature', 'feature/login'));
    expect(shape(tree)).toEqual([{ folder: 'feature', path: 'feature', count: 1, children: ['feature/login'] }, 'feature']);
    expect(new Set(tree.map((n) => n.key)).size).toBe(2);
  });

  it('marks the folders that hold the current branch', () => {
    const tree = branchTree([branch('a/b/c', { current: true }), branch('a/d'), branch('e/f')]);
    expect(tree.map((n) => n.kind === 'folder' && n.current)).toEqual([true, false]);
    const [a] = tree;
    expect(a.kind === 'folder' && a.children.map((n) => n.kind === 'folder' && n.current)).toEqual([true, false]);
  });
});
