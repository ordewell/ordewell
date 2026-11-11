import { describe, expect, it } from 'vitest';
import { parseBranches, parseCommitDetail, parseLog, parseRepos } from '../gitData';

const SHA = 'a'.repeat(40);

describe('parseRepos', () => {
  it('reads the repository list', () => {
    expect(parseRepos({ repos: [{ repo: '.', branch: 'main', detached: false, head: SHA, upstream: 'origin/main', ahead: 1, behind: 0 }] })).toEqual([
      { repo: '.', branch: 'main', detached: false, head: SHA, upstream: 'origin/main', ahead: 1, behind: 0 },
    ]);
  });

  it('refuses a list with an entry it cannot read, rather than drawing part of it', () => {
    expect(parseRepos({ repos: [{ repo: '.' }, { nope: 1 }] })).toBeUndefined();
    expect(parseRepos({})).toBeUndefined();
  });
});

describe('parseBranches', () => {
  const base = { repo: '.', current: 'main', detached: false, local: [], ordewell: [], remote: [], stashes: [], worktrees: [] };

  it('reads a tip\'s date and subject, and leaves them out when the daemon sent none', () => {
    const read = parseBranches({
      ...base,
      local: [
        { name: 'main', sha: SHA, date: '2025-01-05T12:00:00+01:00', subject: 'Fix: "the" login' },
        { name: 'old', sha: SHA, date: '', subject: 5 },
        { name: 'older', sha: SHA },
      ],
    });
    expect(read?.local[0]).toMatchObject({ date: '2025-01-05T12:00:00+01:00', subject: 'Fix: "the" login' });
    expect(read?.local[1]).not.toHaveProperty('date');
    expect(read?.local[1]).not.toHaveProperty('subject');
    expect(read?.local[2]).not.toHaveProperty('subject');
  });

  it('reads owners and the live runs a branch is landed on', () => {
    const read = parseBranches({
      ...base,
      local: [{ name: 'main', sha: SHA, upstream: null, ahead: 0, behind: 0, current: true, landingFor: [{ sessionId: 's1', runId: 'r7', extra: 1 }] }],
      ordewell: [{ name: 'ordewell/r7/t3', sha: SHA, owner: { sessionId: 's1', runId: 'r7', taskId: 't3' } }],
      worktrees: [{ path: '/w', branch: null, head: SHA, main: true }],
      stashes: [{ ref: 'stash@{0}', sha: SHA, message: 'wip' }],
    });
    expect(read?.local[0]?.landingFor).toEqual([{ sessionId: 's1', runId: 'r7' }]);
    expect(read?.ordewell[0]?.owner).toEqual({ sessionId: 's1', runId: 'r7', taskId: 't3' });
    expect(read?.worktrees[0]).toMatchObject({ branch: null, main: true });
    expect(read?.stashes[0]?.message).toBe('wip');
  });

  it('is undefined when a list is missing or a branch has no sha', () => {
    expect(parseBranches({ repo: '.' })).toBeUndefined();
    expect(parseBranches({ ...base, local: [{ name: 'main' }] })).toBeUndefined();
  });
});

describe('parseLog and parseCommitDetail', () => {
  const commit = { sha: SHA, parents: ['b'.repeat(40)], refs: ['HEAD', 'main'], subject: 'Fix it', author: 'Ada', email: 'a@x', date: '2025-01-01T00:00:00Z' };

  it('reads a page and its cursor', () => {
    expect(parseLog({ repo: '.', ref: 'HEAD', commits: [commit], cursor: 'next' })).toEqual({ repo: '.', ref: 'HEAD', commits: [commit], cursor: 'next' });
    expect(parseLog({ repo: '.', commits: [], cursor: null })?.cursor).toBeNull();
  });

  it('refuses a commit with no parents list', () => {
    expect(parseLog({ repo: '.', commits: [{ sha: SHA }] })).toBeUndefined();
  });

  it('reads a commit with its files and an optional patch', () => {
    const detail = parseCommitDetail({ commit: { ...commit, body: 'Why.' }, files: [{ path: 'a.ts', status: 'M', added: 1, removed: 0 }, { path: 'i.png', status: 'A', added: null, removed: null }], patch: '@@' });
    expect(detail?.commit.body).toBe('Why.');
    expect(detail?.files.map((f) => f.added)).toEqual([1, null]);
    expect(detail?.patch).toBe('@@');
    expect(parseCommitDetail({ commit })?.files).toBeUndefined();
  });
});
