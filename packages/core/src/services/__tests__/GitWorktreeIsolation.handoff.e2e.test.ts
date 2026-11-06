// Part of GitWorktreeIsolation: split by describe so CI's shards (vitest splits by file) balance. Helpers: gitWorktreeIsolationKit.ts

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { type GitExecFn, type WorktreeIsolationDeps } from '../GitWorktreeIsolation';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import { fakeConfig, removeDir } from '../../testing';
import { realpath, hasGit, create, git, initRepo, task, worktreePaths, realpathSafe, branches, execFileAsync, subcommand, roots, repo, pair, integrationOf } from './gitWorktreeIsolationKit';

afterEach(async () => {
  while (roots.length) await removeDir(roots.pop()!);
});

describe.skipIf(!hasGit)('WorktreeIsolation end-of-run handoff', () => {
  async function finishedRun() {
    const root = repo({ 'shared.txt': 'base\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const [t1, t2] = [task(1, 'Add alpha'), task(2, 'Add beta')];
    const a = await iso.prepare(t1, run);
    const b = await iso.prepare(t2, run);
    writeFileSync(join(a.cwd, 'alpha.txt'), 'alpha\n');
    writeFileSync(join(b.cwd, 'beta.txt'), 'beta\n');
    await Promise.all([iso.integrate(t2, run), iso.integrate(t1, run)]);
    return { root, iso, run };
  }

  it('reports the integration branch, the base ref and what landed in plan order', async () => {
    const { root, iso, run } = await finishedRun();
    const handoff = await iso.handoff(run);
    const landed = [
      { taskId: 'task-1', order: 1, title: 'Add alpha' },
      { taskId: 'task-2', order: 2, title: 'Add beta' },
    ];
    expect(handoff).toEqual({
      repos: [{ path: '.', integrationBranch: `ordewell/${run.id}/integration`, baseRef: git(root, 'rev-parse', 'HEAD'), baseBranch: 'main', landed }],
      landed,
    });
  });

  it('frees the integration branch so the user can check it out', async () => {
    const { root, iso, run } = await finishedRun();
    await iso.handoff(run);
    expect(worktreePaths(root)).toEqual([root]);
    expect(branches(root)).toContain(run.repos[0].integrationBranch);
  });

  it('waits for a landing in flight instead of rolling its merge back', async () => {
    const root = repo();
    let reachMerge = () => {};
    const mergeReached = new Promise<void>((resolve) => { reachMerge = resolve; });
    let releaseMerge = () => {};
    const mergeReleased = new Promise<void>((resolve) => { releaseMerge = resolve; });
    // While the landing's merge is held, any other git call can only be the handoff's.
    let holding = false;
    const intruders: Array<() => void> = [];
    let handing: Promise<unknown> = Promise.resolve();
    const exec: GitExecFn = async (file, args, opts) => {
      const isMerge = subcommand(args) === 'merge' && args.includes('--no-ff');
      if (isMerge) {
        reachMerge();
        await mergeReleased;
      } else if (holding) {
        await new Promise<void>((resolve) => intruders.push(resolve));
      }
      const { stdout, stderr } = await execFileAsync(file, args, { cwd: opts.cwd, env: opts.env });
      if (isMerge) {
        holding = false;
        // A handoff that slipped in runs to the end while the landing sits just past its merge.
        if (intruders.length > 0) {
          intruders.splice(0).forEach((go) => go());
          await handing.catch(() => undefined);
        }
      }
      return { stdout: String(stdout), stderr: String(stderr) };
    };
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec });
    const run = await iso.startRun(root);
    const t1 = task(1, 'Add alpha');
    const { cwd } = await iso.prepare(t1, run);
    writeFileSync(join(cwd, 'alpha.txt'), 'alpha\n');

    const landing = iso.integrate(t1, run);
    await mergeReached;
    holding = true;
    handing = iso.handoff(run);
    await new Promise((resolve) => setImmediate(resolve));
    releaseMerge();

    expect(await landing).toBe('merged');
    await handing;
    expect(git(root, 'show', `${run.repos[0].integrationBranch}:alpha.txt`)).toBe('alpha');
  });

  it('a task retried after handoff still integrates', async () => {
    const { root, iso, run } = await finishedRun();
    await iso.handoff(run);
    const t3 = task(3, 'Late');
    const { cwd } = await iso.prepare(t3, run);
    writeFileSync(join(cwd, 'late.txt'), 'late\n');
    expect(await iso.integrate(t3, run)).toBe('merged');
    expect(git(root, 'show', `${run.repos[0].integrationBranch}:late.txt`)).toBe('late');
  });

  it('reviewDiff shows the run against its base ref, not the current branch', async () => {
    const { root, iso, run } = await finishedRun();
    writeFileSync(join(root, 'later.txt'), 'the user moved on\n');
    git(root, 'add', 'later.txt');
    git(root, 'commit', '-q', '-m', 'user commit');

    const diff = await iso.reviewDiff(run);
    expect(diff).toContain('+++ b/alpha.txt');
    expect(diff).toContain('+++ b/beta.txt');
    expect(diff).not.toContain('later.txt');
  });

  it('reviewDiff needs no header for a repository that is the whole workspace', async () => {
    const { iso, run } = await finishedRun();
    expect(await iso.reviewDiff(run)).toMatch(/^diff --git a\/alpha\.txt b\/alpha\.txt\n/);
  });

  it('never merges into the checked-out branch until asked, and then does', async () => {
    const { root, iso, run } = await finishedRun();
    const before = git(root, 'rev-parse', 'HEAD');
    await iso.handoff(run);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before);
    expect(existsSync(join(root, 'alpha.txt'))).toBe(false);

    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    expect(readFileSync(join(root, 'alpha.txt'), 'utf8')).toBe('alpha\n');
    expect(readFileSync(join(root, 'beta.txt'), 'utf8')).toBe('beta\n');
    expect(git(root, 'branch', '--show-current')).toBe('main');
  });

  it('refuses Merge all when another branch is checked out than the run started on, landing nothing', async () => {
    const { root, iso, run } = await finishedRun();
    await iso.handoff(run);
    git(root, 'checkout', '-q', '-b', 'feature-x');
    const head = git(root, 'rev-parse', 'HEAD');

    expect(await iso.mergeIntoCheckedOut(run)).toEqual({
      outcome: 'blocked',
      blocked: [{ repo: '.', reason: 'wrong-branch', files: [], expected: 'main', actual: 'feature-x' }],
    });

    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(join(root, 'alpha.txt'))).toBe(false);

    git(root, 'checkout', '-q', 'main');
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
  });

  it('refuses Merge all on a detached HEAD when the run started on a branch', async () => {
    const { root, iso, run } = await finishedRun();
    await iso.handoff(run);
    git(root, 'checkout', '-q', '--detach');

    expect(await iso.mergeIntoCheckedOut(run)).toEqual({
      outcome: 'blocked',
      blocked: [{ repo: '.', reason: 'wrong-branch', files: [], expected: 'main' }],
    });
    expect(existsSync(join(root, 'alpha.txt'))).toBe(false);
  });

  it('says a repository mid-rebase is that, not just on a detached HEAD', async () => {
    const { root, iso, run } = await finishedRun();
    await iso.handoff(run);
    git(root, 'checkout', '-q', '--detach');
    mkdirSync(join(root, '.git', 'rebase-merge'));

    expect(await iso.mergeIntoCheckedOut(run)).toEqual({
      outcome: 'blocked',
      blocked: [{ repo: '.', reason: 'wrong-branch', files: [], expected: 'main', rebasing: true }],
    });
  });

  it('merges as before into a detached HEAD when the run started on one', async () => {
    const root = repo();
    git(root, 'checkout', '-q', '--detach');
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Add alpha');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'alpha.txt'), 'alpha\n');
    await iso.integrate(t, run);
    await iso.handoff(run);
    expect(run.repos[0]?.baseBranch).toBeUndefined();
    expect(run.repos[0]?.startedDetached).toBe(true);

    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    expect(readFileSync(join(root, 'alpha.txt'), 'utf8')).toBe('alpha\n');
  });

  it('aborts a conflicting merge and leaves the checked-out tree as it was', async () => {
    const root = repo({ 'shared.txt': 'base\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Edit shared');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'shared.txt'), 'run version\n');
    await iso.integrate(t, run);
    await iso.handoff(run);
    writeFileSync(join(root, 'shared.txt'), 'user version\n');
    git(root, 'commit', '-q', '-am', 'user edit');
    const head = git(root, 'rev-parse', 'HEAD');

    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'conflict', repo: '.', files: ['shared.txt'] });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe('user version\n');
  });

  // The run only needed a clean tree to start; the user keeps working in it,
  // and a merge of their own may be half-resolved when they ask for this one.
  it("leaves the user's own unfinished merge alone instead of aborting it", async () => {
    const root = repo({ 'shared.txt': 'base\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Add alpha');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'alpha.txt'), 'alpha\n');
    await iso.integrate(t, run);
    await iso.handoff(run);
    git(root, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(root, 'shared.txt'), 'feature\n');
    git(root, 'commit', '-q', '-am', 'feature edit');
    git(root, 'checkout', '-q', 'main');
    writeFileSync(join(root, 'shared.txt'), 'main\n');
    git(root, 'commit', '-q', '-am', 'main edit');
    expect(() => git(root, 'merge', 'feature')).toThrow();
    writeFileSync(join(root, 'shared.txt'), 'resolved by hand\n');

    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'failed', repo: '.' });
    expect(git(root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toBe(git(root, 'rev-parse', 'feature'));
    expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe('resolved by hand\n');
    expect(existsSync(join(root, 'alpha.txt'))).toBe(false);
  });

  it('names what git objected to when a lone repository cannot take its merge, and leaves the user\'s edit alone', async () => {
    const root = repo({ 'shared.txt': 'base\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Edit shared');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'shared.txt'), 'run\n');
    await iso.integrate(t, run);
    await iso.handoff(run);
    writeFileSync(join(root, 'shared.txt'), 'uncommitted\n');

    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'failed', repo: '.', error: expect.stringContaining('would be overwritten by merge') });

    expect(readFileSync(join(root, 'shared.txt'), 'utf8')).toBe('uncommitted\n');
  });

  it('after Merge all, discarding what is merged leaves no branch, worktree or directory of the run, and the work on the user\'s branch', async () => {
    const { root, iso, run } = await finishedRun();
    await iso.handoff(run);
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });

    await iso.discard(run, { integration: 'delete-merged' });

    expect(branches(root)).toEqual([]);
    expect(worktreePaths(root)).toEqual([root]);
    expect(existsSync(join(root, '.ordewell', 'worktrees', run.id))).toBe(false);
    expect(run.tasks).toEqual({});
    expect(git(root, 'branch', '--show-current')).toBe('main');
    expect(git(root, 'show', 'HEAD:alpha.txt')).toBe('alpha');
    expect(git(root, 'show', 'HEAD:beta.txt')).toBe('beta');
  });

  it('discarding what is merged keeps an integration branch the user has not merged, and its work', async () => {
    const { root, iso, run } = await finishedRun();
    await iso.handoff(run);
    const integration = run.repos[0].integrationBranch;
    const tip = git(root, 'rev-parse', integration);

    await iso.discard(run, { integration: 'delete-merged' });

    expect(branches(root)).toEqual([integration]);
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(worktreePaths(root)).toEqual([root]);
  });

  describe('sweep', () => {
    /** A handed-off run that landed one task writing `file`. */
    async function landedRun(iso: ReturnType<typeof create>, root: string, file: string): Promise<IsolationRun> {
      const run = await iso.startRun(root);
      const t = task(1, `Write ${file}`);
      const { cwd } = await iso.prepare(t, run);
      writeFileSync(join(cwd, file), `${file}\n`);
      expect(await iso.integrate(t, run)).toBe('merged');
      await iso.handoff(run);
      return run;
    }

    it('deletes the integration branches of other runs the checked-out branch holds, and nothing else', async () => {
      const root = repo();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const merged = await landedRun(iso, root, 'merged.txt');
      const unmerged = await landedRun(iso, root, 'unmerged.txt');
      git(root, 'merge', '-q', '--no-edit', merged.repos[0].integrationBranch);
      git(root, 'branch', 'ordewell-notes');
      const elsewhere = realpath(mkdtempSync(join(tmpdir(), 'ordewell-user-wt-')));
      roots.push(elsewhere);
      git(root, 'worktree', 'add', '-q', '-b', 'ordewell/cafe0000/integration', join(elsewhere, 'wt'), 'HEAD');
      const current = await iso.startRun(root);

      await iso.sweep(current);

      expect(branches(root).sort()).toEqual([
        'ordewell/cafe0000/integration',
        current.repos[0].integrationBranch,
        unmerged.repos[0].integrationBranch,
      ].sort());
      expect(branches(root, 'ordewell-*')).toEqual(['ordewell-notes']);
      expect(git(root, 'show', `${unmerged.repos[0].integrationBranch}:unmerged.txt`)).toBe('unmerged.txt');
      expect(worktreePaths(root)).toContain(realpathSafe(join(elsewhere, 'wt')));
    });

    it('takes an idle run\'s merged task branches with it, keeps its unmerged ones, and leaves a run with a worktree alone', async () => {
      const root = repo();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const idle = await landedRun(iso, root, 'idle.txt');
      git(root, 'merge', '-q', '--no-edit', idle.repos[0].integrationBranch);
      git(root, 'branch', `ordewell/${idle.id}/7-leftover`, idle.repos[0].integrationBranch);
      git(root, 'checkout', '-q', '-b', 'side');
      writeFileSync(join(root, 'side.txt'), 'side\n');
      git(root, 'add', 'side.txt');
      git(root, 'commit', '-q', '-m', 'side work');
      git(root, 'checkout', '-q', 'main');
      git(root, 'branch', '-m', 'side', `ordewell/${idle.id}/8-unmerged`);
      // Another plan's run, mid-task: its branch still sits at HEAD, so only its worktree says it is live.
      const live = await iso.startRun(root);
      const running = await iso.prepare(task(1, 'Still running'), live);
      const current = await iso.startRun(root);

      await iso.sweep(current);

      expect(branches(root).sort()).toEqual([
        `ordewell/${idle.id}/8-unmerged`,
        running.branch,
        live.repos[0].integrationBranch,
        current.repos[0].integrationBranch,
      ].sort());
      expect(worktreePaths(root)).toContain(running.cwd);
    });
  });

  it('discard removes worktrees and task branches but can keep the integration branch', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const [t1, t2] = [task(1, 'Landed'), task(2, 'Still running')];
    const a = await iso.prepare(t1, run);
    const b = await iso.prepare(t2, run);
    writeFileSync(join(a.cwd, 'landed.txt'), 'l\n');
    await iso.integrate(t1, run);

    await iso.discard(run, { integration: 'keep' });

    expect(worktreePaths(root)).toEqual([root]);
    expect(existsSync(b.cwd)).toBe(false);
    expect(branches(root)).toEqual([run.repos[0].integrationBranch]);
    expect(git(root, 'show', `${run.repos[0].integrationBranch}:landed.txt`)).toBe('l');
  });

  it('discard can give up the integration branch too, leaving no trace', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    await iso.prepare(task(1, 'Abandoned'), run);

    await iso.discard(run, { integration: 'delete' });

    expect(worktreePaths(root)).toEqual([root]);
    expect(branches(root)).toEqual([]);
    expect(existsSync(join(root, '.ordewell', 'worktrees', run.id))).toBe(false);
    expect(run.tasks).toEqual({});
  });
});
describe.skipIf(!hasGit)('WorktreeIsolation over a repo group', () => {
  describe('handoff', () => {
    /** A handed-off run whose one task changed api.txt and web.txt. */
    async function handedOff(deps: Partial<WorktreeIsolationDeps> = {}, opts: { idleRepo?: string; addsToWeb?: string } = {}) {
      const dir = pair();
      if (opts.idleRepo) initRepo(join(dir, opts.idleRepo), { 'idle.txt': 'idle\n' });
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }), ...deps });
      const run = await iso.startRun(dir);
      const t = task(1, 'Edit both');
      const { cwd } = await iso.prepare(t, run);
      writeFileSync(join(cwd, 'api', 'api.txt'), 'run api\n');
      writeFileSync(join(cwd, 'web', 'web.txt'), 'run web\n');
      if (opts.addsToWeb) writeFileSync(join(cwd, 'web', opts.addsToWeb), 'run adds\n');
      expect(await iso.integrate(t, run)).toBe('merged');
      await iso.handoff(run);
      const heads = () => ({ api: git(join(dir, 'api'), 'rev-parse', 'HEAD'), web: git(join(dir, 'web'), 'rev-parse', 'HEAD') });
      return { dir, iso, run, heads };
    }

    function commitIn(root: string, file: string, content: string): void {
      writeFileSync(join(root, file), content);
      git(root, 'add', file);
      git(root, 'commit', '-q', '-m', `user edit of ${file}`);
    }

    it('merges every repository when each of them can take its merge', async () => {
      const { dir, iso, run } = await handedOff();

      expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });

      expect(readFileSync(join(dir, 'api', 'api.txt'), 'utf8')).toBe('run api\n');
      expect(readFileSync(join(dir, 'web', 'web.txt'), 'utf8')).toBe('run web\n');
      for (const repo of ['api', 'web']) expect(git(join(dir, repo), 'branch', '--show-current')).toBe('main');
    });

    it('merges nothing anywhere when one repository is on another branch than the run started on, naming each that is', async () => {
      const { dir, iso, run, heads } = await handedOff();
      git(join(dir, 'web'), 'checkout', '-q', '-b', 'feature-x');
      const before = heads();

      expect(await iso.mergeIntoCheckedOut(run)).toEqual({
        outcome: 'blocked',
        blocked: [{ repo: 'web', reason: 'wrong-branch', files: [], expected: 'main', actual: 'feature-x' }],
      });

      expect(heads()).toEqual(before);
      expect(readFileSync(join(dir, 'api', 'api.txt'), 'utf8')).toBe('api\n');
    });

    it('refuses when a repository with nothing to merge is on another branch than the run started on', async () => {
      const { dir, iso, run, heads } = await handedOff({}, { idleRepo: 'docs' });
      git(join(dir, 'docs'), 'checkout', '-q', '-b', 'feature-x');
      const before = heads();

      expect(await iso.mergeIntoCheckedOut(run)).toEqual({
        outcome: 'blocked',
        blocked: [{ repo: 'docs', reason: 'wrong-branch', files: [], expected: 'main', actual: 'feature-x' }],
      });

      expect(heads()).toEqual(before);
    });

    it('merges nothing anywhere when a commit of the user\'s would conflict in one repository', async () => {
      const { dir, iso, run, heads } = await handedOff();
      commitIn(join(dir, 'web'), 'web.txt', 'user web\n');
      const before = heads();

      expect(await iso.mergeIntoCheckedOut(run)).toEqual({
        outcome: 'blocked',
        blocked: [{ repo: 'web', reason: 'conflict', files: ['web.txt'] }],
      });

      expect(heads()).toEqual(before);
      expect(readFileSync(join(dir, 'api', 'api.txt'), 'utf8')).toBe('api\n');
      for (const repo of ['api', 'web']) {
        expect(git(join(dir, repo), 'status', '--porcelain', '--untracked-files=no')).toBe('');
        expect(() => git(join(dir, repo), 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
      }
    });

    it('merges nothing anywhere when the user has uncommitted edits to a file the merge changes', async () => {
      const { dir, iso, run, heads } = await handedOff();
      writeFileSync(join(dir, 'api', 'api.txt'), 'uncommitted\n');
      // An uncommitted edit the merge does not touch is no obstacle.
      commitIn(join(dir, 'web'), 'notes.txt', 'n\n');
      writeFileSync(join(dir, 'web', 'notes.txt'), 'uncommitted notes\n');
      const before = heads();

      expect(await iso.mergeIntoCheckedOut(run)).toEqual({
        outcome: 'blocked',
        blocked: [{ repo: 'api', reason: 'uncommitted-changes', files: ['api.txt'] }],
      });

      expect(heads()).toEqual(before);
      expect(readFileSync(join(dir, 'api', 'api.txt'), 'utf8')).toBe('uncommitted\n');
      expect(readFileSync(join(dir, 'web', 'web.txt'), 'utf8')).toBe('web\n');
      expect(readFileSync(join(dir, 'web', 'notes.txt'), 'utf8')).toBe('uncommitted notes\n');
    });

    it('merges nothing anywhere when an untracked file of the user\'s is where the merge would add one', async () => {
      const { dir, iso, run, heads } = await handedOff({}, { addsToWeb: 'new.txt' });
      writeFileSync(join(dir, 'web', 'new.txt'), 'mine\n');
      const before = heads();

      expect(await iso.mergeIntoCheckedOut(run)).toEqual({
        outcome: 'blocked',
        blocked: [{ repo: 'web', reason: 'uncommitted-changes', files: ['new.txt'] }],
      });

      expect(heads()).toEqual(before);
      expect(readFileSync(join(dir, 'web', 'new.txt'), 'utf8')).toBe('mine\n');
      expect(readFileSync(join(dir, 'api', 'api.txt'), 'utf8')).toBe('api\n');
    });

    it('merges nothing anywhere when the user has staged a change and the merge needs a merge commit', async () => {
      const { dir, iso, run, heads } = await handedOff();
      commitIn(join(dir, 'web'), 'other.txt', 'o\n');
      writeFileSync(join(dir, 'web', 'staged.txt'), 'staged\n');
      git(join(dir, 'web'), 'add', 'staged.txt');
      const before = heads();

      expect(await iso.mergeIntoCheckedOut(run)).toEqual({
        outcome: 'blocked',
        blocked: [{ repo: 'web', reason: 'uncommitted-changes', files: ['staged.txt'] }],
      });

      expect(heads()).toEqual(before);
      expect(readFileSync(join(dir, 'api', 'api.txt'), 'utf8')).toBe('api\n');
      expect(git(join(dir, 'web'), 'diff', '--cached', '--name-only')).toBe('staged.txt');
    });

    it('lets a staged change that nothing overlaps wait while the merge fast-forwards', async () => {
      const { dir, iso, run } = await handedOff();
      writeFileSync(join(dir, 'web', 'staged.txt'), 'staged\n');
      git(join(dir, 'web'), 'add', 'staged.txt');

      expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });

      expect(git(join(dir, 'web'), 'diff', '--cached', '--name-only')).toBe('staged.txt');
      expect(readFileSync(join(dir, 'web', 'web.txt'), 'utf8')).toBe('run web\n');
    });

    it('merges nothing anywhere while a merge of the user\'s own is in progress in one repository, and leaves it alone', async () => {
      const { dir, iso, run, heads } = await handedOff();
      const web = join(dir, 'web');
      git(web, 'checkout', '-q', '-b', 'feature');
      commitIn(web, 'web.txt', 'feature\n');
      git(web, 'checkout', '-q', 'main');
      commitIn(web, 'web.txt', 'main\n');
      expect(() => git(web, 'merge', 'feature')).toThrow();
      const before = heads();

      const result = await iso.mergeIntoCheckedOut(run);

      expect(result).toEqual({ outcome: 'blocked', blocked: [{ repo: 'web', reason: 'merge-in-progress', files: [] }] });
      expect(heads()).toEqual(before);
      expect(git(web, 'rev-parse', 'MERGE_HEAD')).toBe(git(web, 'rev-parse', 'feature'));
      expect(readFileSync(join(dir, 'api', 'api.txt'), 'utf8')).toBe('api\n');
    });

    it('reports every repository that blocks, and only repositories with work to merge', async () => {
      const { dir, iso, run } = await handedOff({}, { idleRepo: 'docs' });
      // docs landed nothing, so nothing of the user's there is in the way.
      writeFileSync(join(dir, 'docs', 'idle.txt'), 'uncommitted\n');
      commitIn(join(dir, 'web'), 'web.txt', 'user web\n');
      writeFileSync(join(dir, 'api', 'api.txt'), 'uncommitted\n');

      expect(await iso.mergeIntoCheckedOut(run)).toEqual({
        outcome: 'blocked',
        blocked: [
          { repo: 'api', reason: 'uncommitted-changes', files: ['api.txt'] },
          { repo: 'web', reason: 'conflict', files: ['web.txt'] },
        ],
      });
    });

    it('says which repositories landed when a merge fails after the preflight passed', async () => {
      const { dir, iso, run } = await handedOff();
      // A diverged branch makes a real merge commit, which the hook then refuses.
      commitIn(join(dir, 'web'), 'other.txt', 'o\n');
      writeFileSync(join(dir, 'web', '.git', 'hooks', 'pre-merge-commit'), '#!/bin/sh\necho "lint: subject is too long" >&2\nexit 1\n', { mode: 0o755 });
      const webHead = git(join(dir, 'web'), 'rev-parse', 'HEAD');

      expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'failed', repo: 'web', error: expect.stringContaining('lint: subject is too long'), landed: ['api'] });

      expect(readFileSync(join(dir, 'api', 'api.txt'), 'utf8')).toBe('run api\n');
      expect(git(join(dir, 'web'), 'rev-parse', 'HEAD')).toBe(webHead);
      expect(() => git(join(dir, 'web'), 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
      expect(git(join(dir, 'web'), 'status', '--porcelain', '--untracked-files=no')).toBe('');
    });

    it('reviews one section per repository with changes, each headed by its path and rooted at the workspace', async () => {
      const { run, iso } = await handedOff({}, { idleRepo: 'docs' });
      const base = (repo: string) => run.repos.find((r) => r.path === repo)!.baseRef.slice(0, 12);

      const diff = await iso.reviewDiff(run);

      const sections = diff.split(/^(?=# )/m);
      expect(sections.map((section) => section.split('\n', 1)[0])).toEqual([
        `# api: ${integrationOf(run)} against ${base('api')}`,
        `# web: ${integrationOf(run)} against ${base('web')}`,
      ]);
      expect(sections[0]).toContain('diff --git a/api/api.txt b/api/api.txt');
      expect(sections[0]).toContain('+run api');
      expect(sections[0]).not.toContain('web.txt');
      expect(sections[1]).toContain('+++ b/web/web.txt');
      expect(diff).not.toContain('docs');
    });

    describe('on git older than 2.38', () => {
      /** Real git that says it is 2.37 and records every command it runs. */
      function oldGit(): { exec: GitExecFn; ran: string[][] } {
        const ran: string[][] = [];
        const exec: GitExecFn = async (file, args, opts) => {
          ran.push(args);
          if (args[0] === '--version') return { stdout: 'git version 2.37.1\n', stderr: '' };
          const { stdout, stderr } = await execFileAsync(file, args, { cwd: opts.cwd, env: opts.env });
          return { stdout: String(stdout), stderr: String(stderr) };
        };
        return { exec, ran };
      }

      it('merges repository by repository without a preflight, stops at the first failure and says what landed', async () => {
        const git237 = oldGit();
        const { dir, iso, run } = await handedOff({ execFileImpl: git237.exec });
        commitIn(join(dir, 'web'), 'web.txt', 'user web\n');
        const webHead = git(join(dir, 'web'), 'rev-parse', 'HEAD');

        expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'conflict', repo: 'web', files: ['web.txt'], landed: ['api'] });

        expect(readFileSync(join(dir, 'api', 'api.txt'), 'utf8')).toBe('run api\n');
        expect(git(join(dir, 'web'), 'rev-parse', 'HEAD')).toBe(webHead);
        expect(readFileSync(join(dir, 'web', 'web.txt'), 'utf8')).toBe('user web\n');
        expect(() => git(join(dir, 'web'), 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
        expect(git237.ran.some((args) => args[0] === 'merge-tree')).toBe(false);
      });

      it('merges every repository when none fails', async () => {
        const { dir, iso, run } = await handedOff({ execFileImpl: oldGit().exec });

        expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
        expect(readFileSync(join(dir, 'web', 'web.txt'), 'utf8')).toBe('run web\n');
      });
    });
  });
});
