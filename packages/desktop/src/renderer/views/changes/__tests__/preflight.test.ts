import { describe, expect, it } from 'vitest';
import type { MergePreflightResponse } from '@ordewell/core';
import { parsePreflight, preflightModel, repoName, stashPlan } from '../preflight';
import { HANDOFF } from './fixtures';

const CLEAN: MergePreflightResponse = { runId: 'r1', stashMessage: 'ordewell: before merging r1', repos: [{ repo: '.', branch: 'main', overlap: [], otherDirty: false }] };
const OVERLAP: MergePreflightResponse = {
  runId: 'r1',
  stashMessage: 'ordewell: before merging r1',
  repos: [
    { repo: '.', branch: 'main', overlap: ['src/a.ts', 'src/b.ts'], otherDirty: true },
    { repo: 'web', branch: null, overlap: [], otherDirty: true },
  ],
};

describe('Merge all\'s preflight', () => {
  it('reads only an answer it can check', () => {
    expect(parsePreflight(CLEAN)).toEqual(CLEAN);
    expect(parsePreflight({ runId: 'r1', stashMessage: 'm', repos: [{ repo: '.', overlap: [3] }] })).toBeUndefined();
    expect(parsePreflight({ runId: 'r1', repos: [] })).toBeUndefined();
    expect(parsePreflight(null)).toBeUndefined();
  });

  it('offers a plain merge when nothing of the user\'s is in the way, naming where it lands', () => {
    const model = preflightModel(CLEAN, HANDOFF, false);
    expect(model.overlapping).toBe(false);
    expect(model.request.choices).toEqual([{ id: 'merge', label: 'Merge' }]);
    expect(model.request.message).toMatch(/^Merge the isolated run into main\./);
    expect(model.request.detail).toMatch(/ordewell\/r1\/integration is merged, then the task worktrees are cleaned up/);
    expect(model.rows).toEqual([{ repo: '.', branch: 'main', overlap: [], otherDirty: false }]);
  });

  it('lists the overlapping files per repo and offers Stash or Commit, never a plain merge', () => {
    const model = preflightModel(OVERLAP, HANDOFF, false);
    expect(model.overlapping).toBe(true);
    expect(model.request.choices.map((c) => c.id)).toEqual(['stash', 'commit']);
    expect(model.request.detail).toMatch(/uncommitted changes to files the run also changed/);
    expect(model.rows.map((r) => [r.repo, r.branch, r.overlap])).toEqual([
      ['.', 'main', ['src/a.ts', 'src/b.ts']],
      ['web', 'the detached HEAD it started on', []],
    ]);
  });

  it('says other uncommitted changes stay put when they do not overlap', () => {
    const model = preflightModel({ ...CLEAN, repos: [{ ...CLEAN.repos[0]!, otherDirty: true }] }, HANDOFF, false);
    expect(model.request.detail).toMatch(/do not touch what the run changed, and stay as they are/);
  });

  it('words a merge mid-run as one the run goes on after', () => {
    expect(preflightModel(CLEAN, HANDOFF, true).request.message).toMatch(/^Merge what the run has landed so far/);
  });

  it('stashes only the overlapping files, in the repos that hold them', () => {
    expect(stashPlan(OVERLAP)).toEqual([{ repo: '.', paths: ['src/a.ts', 'src/b.ts'] }]);
    expect(stashPlan(CLEAN)).toEqual([]);
  });

  it('names the workspace root in words', () => {
    expect([repoName('.'), repoName('web')]).toEqual(['the workspace', 'web']);
  });
});
