// Part of GitWorktreeIsolation: split by describe so CI's shards (vitest splits by file) balance. Helpers: gitWorktreeIsolationKit.ts

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import { fakeConfig, removeDir } from '../../testing';
import { hasGit, create, git, task, roots, repo, pair, integrationOf } from './gitWorktreeIsolationKit';

afterEach(async () => {
  while (roots.length) await removeDir(roots.pop()!);
});

/**
 * Whether the user's branch holds everything a run landed, asked of git alone
 * (ADR-0013): the one answer that lets a person's start replace a run, so it
 * says no wherever it cannot be sure, in any one repository.
 */
describe.skipIf(!hasGit)('userBranchHolds', () => {
  /** A run over `dir` that landed one task, writing `file` in each of `repos` (the workspace itself when none). */
  async function landed(dir: string, repos: string[] = []) {
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(dir);
    const t = task(1, 'Land it');
    const { cwd } = await iso.prepare(t, run);
    for (const where of repos.length > 0 ? repos : ['.']) writeFileSync(join(cwd, where, 'landed.txt'), 'landed\n');
    expect(await iso.integrate(t, run)).toBe('merged');
    return { iso, run };
  }

  it('says yes once Merge all brought every repository\'s integration tip into the user\'s branch', async () => {
    const dir = pair();
    const { iso, run } = await landed(dir, ['api', 'web']);
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });

    expect(await iso.userBranchHolds(run)).toBe(true);
  });

  it('says yes once the user merged the integration branch by hand', async () => {
    const dir = repo();
    const { iso, run } = await landed(dir);
    git(dir, 'merge', '-q', '--no-ff', '-m', 'Take the run in', integrationOf(run));

    expect(await iso.userBranchHolds(run)).toBe(true);
  });

  it('says no while the integration branch holds a landing the user\'s branch lacks, whatever the records say', async () => {
    const dir = repo();
    const { iso, run } = await landed(dir);
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    // A later landing, then a retry that drops its record, as a held start's prepare does.
    const again = task(2, 'Land more');
    const { cwd } = await iso.prepare(again, run);
    writeFileSync(join(cwd, 'more.txt'), 'more\n');
    expect(await iso.integrate(again, run)).toBe('merged');
    delete run.tasks['task-2'];

    expect(await iso.userBranchHolds(run)).toBe(false);
  });

  it('says no for a group where one repository of two is merged', async () => {
    const dir = pair();
    const { iso, run } = await landed(dir, ['api', 'web']);
    git(join(dir, 'api'), 'merge', '-q', '--no-ff', '-m', 'Take api in', integrationOf(run));

    expect(await iso.userBranchHolds(run)).toBe(false);
    git(join(dir, 'web'), 'merge', '-q', '--no-ff', '-m', 'Take web in', integrationOf(run));
    expect(await iso.userBranchHolds(run)).toBe(true);
  });

  it('says no on a detached HEAD, even one that holds the tip', async () => {
    const dir = repo();
    const { iso, run } = await landed(dir);
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    git(dir, 'checkout', '-q', '--detach', 'HEAD');

    expect(await iso.userBranchHolds(run)).toBe(false);
  });

  it('says no once HEAD moved to another branch that lacks the tip, and to a review branch cut from it', async () => {
    const dir = repo();
    const { iso, run } = await landed(dir);
    git(dir, 'checkout', '-q', '-b', 'elsewhere', run.repos[0].baseRef);
    expect(await iso.userBranchHolds(run)).toBe(false);

    // A branch standing on the integration tip holds it, but is a review, not a merge into the user's branch.
    git(dir, 'checkout', '-q', '-b', 'review', integrationOf(run));
    expect(await iso.userBranchHolds(run)).toBe(false);
  });

  it('says no once the integration branch was deleted by hand, though HEAD holds what it had', async () => {
    const dir = repo();
    const { iso, run } = await landed(dir);
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    // As a clean-up by hand leaves it, whatever worktree still stood on it.
    git(dir, 'update-ref', '-d', `refs/heads/${integrationOf(run)}`);

    expect(await iso.userBranchHolds(run)).toBe(false);
  });

  it('says no after a squash merge, which leaves the tip out of HEAD', async () => {
    const dir = repo();
    const { iso, run } = await landed(dir);
    git(dir, 'merge', '-q', '--squash', integrationOf(run));
    git(dir, 'commit', '-q', '-m', 'Squash the run in');

    expect(await iso.userBranchHolds(run)).toBe(false);
  });

  it('says no where git cannot read a repository of the run', async () => {
    const dir = repo();
    const { iso, run } = await landed(dir);
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    const moved: IsolationRun = { ...run, repos: run.repos.map((r) => ({ ...r, root: join(dir, 'gone') })) };

    expect(await iso.userBranchHolds(moved)).toBe(false);
  });
});
