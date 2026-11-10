import { describe, expect, it } from 'vitest';
import type { Branches, BranchInfo } from '../gitData';
import {
  ago, branchTree, commitDiffTabId, commitWhen, commitsTabId, isOrdewellRef, landedTaskOf, landingSubject, parseCommitDiffTabId, parseCommitsTabId, plural, refChips, repoDisplay, summarizeRefs,
  runMark, splitUpstream, tipAge, tipSummary, trackMark,
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

  it('marks behind then ahead, as the sync bar does, and nothing when level', () => {
    expect(trackMark({ ahead: 1, behind: 2, upstream: 'origin/main' })).toBe('↓2 ↑1');
    expect(trackMark({ ahead: 0, behind: 3, upstream: 'origin/main' })).toBe('↓3');
    expect(trackMark({ ahead: 4, behind: 0, upstream: 'origin/main' })).toBe('↑4');
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

  it('ages a branch\'s tip, and says nothing when the daemon sent no date', () => {
    const now = Date.parse('2025-01-10T12:00:00Z');
    expect(tipAge({ date: '2025-01-07T12:00:00+00:00' }, now)).toBe('3d');
    expect(tipAge({}, now)).toBe('');
    expect(tipAge({ date: 'garbled' }, now)).toBe('');
  });

  it('sums up a tip as its subject and age for a tooltip', () => {
    const now = Date.parse('2025-01-10T12:00:00Z');
    expect(tipSummary({ subject: 'Fix the login redirect', date: '2025-01-07T12:00:00Z' }, now)).toBe('Fix the login redirect · 3d ago');
    expect(tipSummary({ subject: 'Fix', date: '2025-01-10T11:59:59Z' }, now)).toBe('Fix · just now');
    expect(tipSummary({ subject: 'Only a subject' }, now)).toBe('Only a subject');
    expect(tipSummary({ date: '2025-01-09T12:00:00Z' }, now)).toBe('1d ago');
    expect(tipSummary({}, now)).toBe('');
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

describe('summarizeRefs', () => {
  const sum = (refs: string[]) => summarizeRefs(refChips(refs, BRANCHES));

  it('leads with the checked-out branch, then counts the rest and names them all but HEAD', () => {
    const s = sum(['HEAD', 'feature', 'main', 'v1.0']);
    expect(s.lead?.text).toBe('main');
    expect(s.more).toBe(2);
    expect(s.names).toEqual(['feature', 'main', 'v1.0']);
  });

  it('folds a remote-tracking ref into the local branch of its name, and leaves another remote alone', () => {
    const folded = sum(['main', 'origin/main']);
    expect(folded.lead).toMatchObject({ text: 'main', tracked: 'origin/main' });
    expect(folded.more).toBe(0);
    expect(sum(['feature', 'origin/main']).more).toBe(1);
    expect(sum(['origin/main']).lead?.tracked).toBeUndefined();
  });

  it('leads with Ordewell’s branch before a remote or a tag, and with nothing when there is no ref', () => {
    expect(sum(['v1.0', 'origin/main', 'ordewell/r7/integration']).lead?.kind).toBe('ordewell');
    expect(sum([])).toEqual({ lead: undefined, more: 0, names: [] });
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

  it('groups slash-delimited names into folders, folders and branches in one alphabetical order, and keeps each branch’s full name', () => {
    expect(shape(branchTree(names('zeta', 'main', 'fix/typo', 'feature/sso', 'feature/login', 'develop')))).toEqual([
      'develop',
      { folder: 'feature', path: 'feature', count: 2, children: ['feature/login', 'feature/sso'] },
      { folder: 'fix', path: 'fix', count: 1, children: ['fix/typo'] },
      'main',
      'zeta',
    ]);
  });

  it('sorts as a person reads: case aside, and numbers by their value', () => {
    expect(shape(branchTree(names('release/1.10', 'Hotfix', 'release/1.9', 'alpha')))).toEqual([
      'alpha', 'Hotfix', { folder: 'release', path: 'release', count: 2, children: ['release/1.9', 'release/1.10'] },
    ]);
  });

  it('pins the checked-out branch first, under its full name and outside its folder', () => {
    const tree = branchTree([branch('feature/login'), branch('fix/typo'), branch('main', { current: true }), branch('release/2')]);
    expect(shape(tree)).toEqual([
      'main',
      { folder: 'feature', path: 'feature', count: 1, children: ['feature/login'] },
      { folder: 'fix', path: 'fix', count: 1, children: ['fix/typo'] },
      { folder: 'release', path: 'release', count: 1, children: ['release/2'] },
    ]);
    const nested = branchTree([branch('feature/a'), branch('feature/sso', { current: true }), branch('dev')]);
    expect(shape(nested)).toEqual(['feature/sso', 'dev', { folder: 'feature', path: 'feature', count: 1, children: ['feature/a'] }]);
    expect(nested[0]).toMatchObject({ kind: 'leaf', label: 'feature/sso', key: 'branch:feature/sso' });
  });

  it('nests deep, branching refs level by level, each level in the same order', () => {
    const tree = branchTree(names('team/web/feature/sso/b', 'team/web/feature/sso/a', 'team/web/fix/x', 'team/api/y', 'team/web/feature/login'));
    expect(shape(tree)).toEqual([
      { folder: 'team', path: 'team', count: 5, children: [
        { folder: 'api', path: 'team/api', count: 1, children: ['team/api/y'] },
        { folder: 'web', path: 'team/web', count: 4, children: [
          { folder: 'feature', path: 'team/web/feature', count: 3, children: [
            'team/web/feature/login',
            { folder: 'sso', path: 'team/web/feature/sso', count: 2, children: ['team/web/feature/sso/a', 'team/web/feature/sso/b'] },
          ] },
          { folder: 'fix', path: 'team/web/fix', count: 1, children: ['team/web/fix/x'] },
        ] },
      ] },
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
    const tree = branchTree(names('feature/login', 'feature'));
    expect(shape(tree)).toEqual(['feature', { folder: 'feature', path: 'feature', count: 1, children: ['feature/login'] }]);
    expect(new Set(tree.map((n) => n.key)).size).toBe(2);
  });

  it('leaves no folder holding the checked-out branch, since it leads the list', () => {
    const tree = branchTree([branch('a/b/c', { current: true }), branch('a/d'), branch('e/f')]);
    expect(shape(tree)).toEqual(['a/b/c', { folder: 'a', path: 'a', count: 1, children: ['a/d'] }, { folder: 'e', path: 'e', count: 1, children: ['e/f'] }]);
  });
});
