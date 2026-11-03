import { describe, expect, it } from 'vitest';
import type { Branches, BranchInfo } from '../gitData';
import {
  ago, commitDiffTabId, commitsTabId, isOrdewellRef, landedTaskOf, landingSubject, parseCommitDiffTabId, parseCommitsTabId, plural, refChips, repoDisplay,
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
