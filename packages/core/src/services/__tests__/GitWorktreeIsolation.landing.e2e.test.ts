// Part of GitWorktreeIsolation: split by describe so CI's shards (vitest splits by file) balance. Helpers: gitWorktreeIsolationKit.ts

import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { type GitExecFn } from '../GitWorktreeIsolation';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import { fakeConfig, removeDir } from '../../testing';
import { realpath, hasGit, create, git, initRepo, task, worktreePaths, branches, execFileAsync, subcommand, crashAt, roots, pair, integrationOf, tip } from './gitWorktreeIsolationKit';

afterEach(async () => {
  while (roots.length) await removeDir(roots.pop()!);
});

describe.skipIf(!hasGit)('WorktreeIsolation over a repo group', () => {
  describe('atomic landing', () => {
    it('lands two parallel tasks that each change a different repository', async () => {
      const dir = pair();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const [inApi, inWeb] = [task(1, 'Api only'), task(2, 'Web only')];
      const a = await iso.prepare(inApi, run);
      const w = await iso.prepare(inWeb, run);
      writeFileSync(join(a.cwd, 'api', 'route.ts'), 'route\n');
      writeFileSync(join(w.cwd, 'web', 'page.html'), 'page\n');

      expect(await Promise.all([iso.integrate(inWeb, run), iso.integrate(inApi, run)])).toEqual(['merged', 'merged']);

      expect(git(join(dir, 'api'), 'show', `${integrationOf(run)}:route.ts`)).toBe('route');
      expect(git(join(dir, 'web'), 'show', `${integrationOf(run)}:page.html`)).toBe('page');
      expect(run.tasks['task-1'].repos.web.changed).toBe(false);
      expect(run.tasks['task-2'].repos.api.changed).toBe(false);
      // A repository the task did not change gets no merge commit at all.
      expect(git(join(dir, 'api'), 'log', '--format=%s', integrationOf(run))).not.toContain('Web only');
    });

    it('writes the same stated commit for the merge in every repository the task changed', async () => {
      const dir = pair();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const t = task(1, 'Edit both');
      const { cwd } = await iso.prepare(t, run);
      writeFileSync(join(cwd, 'api', 'route.ts'), 'route\n');
      writeFileSync(join(cwd, 'web', 'page.html'), 'page\n');

      expect(await iso.integrate(t, run, undefined, { subject: 'Serve the page', body: 'Route and page together.' })).toBe('merged');

      for (const repoDir of [join(dir, 'api'), join(dir, 'web')]) {
        expect(git(repoDir, 'log', '-1', '--format=%B', integrationOf(run))).toBe('Merge: Serve the page\n\nRoute and page together.');
      }
    });

    /** Task 1 lands a change to web.txt; task 2, prepared beside it, changes both repositories and collides in web. */
    async function secondConflicts() {
      const dir = pair();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const [first, both] = [task(1, 'Edit web'), task(2, 'Edit both')];
      const f = await iso.prepare(first, run);
      const b = await iso.prepare(both, run);
      writeFileSync(join(f.cwd, 'web', 'web.txt'), 'first\n');
      writeFileSync(join(b.cwd, 'api', 'api.txt'), 'both\n');
      writeFileSync(join(b.cwd, 'web', 'web.txt'), 'both\n');
      expect(await iso.integrate(first, run)).toBe('merged');
      return { dir, iso, run, both, b };
    }

    it('rolls back what a task merged into one repository when another of its repositories conflicts', async () => {
      const { dir, iso, run, both, b } = await secondConflicts();
      const before = { api: tip(dir, 'api', run), web: tip(dir, 'web', run) };

      expect(await iso.integrate(both, run)).toBe('conflict');

      expect(tip(dir, 'api', run)).toBe(before.api);
      expect(tip(dir, 'web', run)).toBe(before.web);
      expect(git(join(dir, 'api'), 'show', `${integrationOf(run)}:api.txt`)).toBe('api');
      expect(run.tasks['task-2'].status).toBe('conflict');
      expect(run.tasks['task-2'].conflictRepo).toBe('web');
      expect(run.tasks['task-2'].conflictFiles).toEqual(['web.txt']);
      expect(run.tasks['task-2'].repos.api.changed).toBe(true);
      expect(run.tasks['task-2'].repos.web.changed).toBe(true);
      expect(run.landing).toBeUndefined();
      for (const repo of ['api', 'web']) {
        expect(worktreePaths(join(dir, repo))).toContain(join(b.cwd, repo));
        expect(branches(join(dir, repo))).toContain(b.branch);
        const integrationDir = join(dir, '.ordewell', 'worktrees', run.id, 'integration', repo);
        expect(git(integrationDir, 'status', '--porcelain')).toBe('');
        expect(git(integrationDir, 'rev-parse', 'HEAD')).toBe(before[repo as 'api' | 'web']);
      }
      expect(git(join(dir, 'api'), 'show', `${b.branch}:api.txt`)).toBe('both');
    });

    it('a task prepared while another is mid-landing starts from the group\'s tips before it, so a landing rolled back never lands through it', async () => {
      const dir = pair();
      let armed = false;
      const held = { release: () => undefined as void, reached: false };
      const gate = new Promise<void>((resolve) => { held.release = resolve; });
      let thirdBased!: () => void;
      const thirdBranched = new Promise<void>((resolve) => { thirdBased = resolve; });
      const exec: GitExecFn = async (file, args, opts) => {
        if (armed && subcommand(args) === 'merge' && args.includes('--no-ff') && opts.cwd?.endsWith(join('integration', 'web'))) {
          held.reached = true;
          await gate;
        }
        if (args.includes('worktree') && args.includes('add') && args.some((a) => a.endsWith('3-independent'))) thirdBased();
        const { stdout, stderr } = await execFileAsync(file, args, { cwd: opts.cwd, env: opts.env });
        return { stdout: String(stdout), stderr: String(stderr) };
      };
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec });
      const run = await iso.startRun(dir);
      const [first, both, independent] = [task(1, 'Edit web'), task(2, 'Edit both'), task(3, 'Independent')];
      const f = await iso.prepare(first, run);
      const b = await iso.prepare(both, run);
      writeFileSync(join(f.cwd, 'web', 'web.txt'), 'first\n');
      writeFileSync(join(b.cwd, 'api', 'api.txt'), 'both\n');
      writeFileSync(join(b.cwd, 'web', 'web.txt'), 'both\n');
      expect(await iso.integrate(first, run)).toBe('merged');

      armed = true;
      const landing = iso.integrate(both, run);
      await vi.waitFor(() => expect(held.reached).toBe(true));
      // api's integration branch already holds task 2's merge; web's does not yet.
      const prepared = iso.prepare(independent, run);
      // Once it has branched from a tip the damage is done; if it is waiting its turn instead, there is nothing to see.
      await Promise.race([thirdBranched, new Promise((resolve) => setTimeout(resolve, 1000))]);
      held.release();
      expect(await landing).toBe('conflict');

      const i = await prepared;
      writeFileSync(join(i.cwd, 'web', 'other.txt'), 'other\n');
      expect(await iso.integrate(independent, run)).toBe('merged');

      expect(run.tasks['task-2'].status).toBe('conflict');
      expect(git(join(dir, 'api'), 'show', `${integrationOf(run)}:api.txt`)).toBe('api');
    });

    it('lands the task in both repositories once a resolver has merged its branch by hand', async () => {
      const { dir, iso, run, both, b } = await secondConflicts();
      expect(await iso.integrate(both, run)).toBe('conflict');

      // What a resolver task's agent does: merge the conflicted branch in each
      // repository it changed, resolving the one that collides.
      const resolver = task(3, 'Resolve merge conflict: Edit both');
      const r = await iso.prepare(resolver, run);
      git(join(r.cwd, 'api'), 'merge', '--no-ff', '--no-edit', b.branch);
      expect(() => git(join(r.cwd, 'web'), 'merge', '--no-ff', '--no-edit', b.branch)).toThrow();
      writeFileSync(join(r.cwd, 'web', 'web.txt'), 'first and both\n');
      git(join(r.cwd, 'web'), 'add', 'web.txt');
      git(join(r.cwd, 'web'), 'commit', '-q', '--no-edit');
      expect(await iso.integrate(resolver, run)).toBe('merged');

      expect(await iso.integrate(both, run)).toBe('merged');
      expect(git(join(dir, 'api'), 'show', `${integrationOf(run)}:api.txt`)).toBe('both');
      expect(git(join(dir, 'web'), 'show', `${integrationOf(run)}:web.txt`)).toBe('first and both');
      expect(run.tasks['task-2']).toMatchObject({ status: 'merged', repos: { api: { changed: true }, web: { changed: true } } });
      expect(run.tasks['task-2'].conflictRepo).toBeUndefined();
      expect(run.tasks['task-2'].conflictFiles).toBeUndefined();
      for (const repo of ['api', 'web']) {
        expect(branches(join(dir, repo))).not.toContain(b.branch);
        expect(existsSync(join(b.cwd, repo))).toBe(false);
      }
      const { repos } = await iso.handoff(run);
      expect(repos.map((r) => [r.path, r.landed.map((l) => l.taskId)])).toEqual([
        ['api', ['task-2', 'task-3']],
        ['web', ['task-1', 'task-2', 'task-3']],
      ]);
    });

    it('lands the task in both repositories once it is resolved by hand in its own worktree', async () => {
      const { dir, iso, run, both, b } = await secondConflicts();
      expect(await iso.integrate(both, run)).toBe('conflict');

      expect(() => git(join(b.cwd, 'web'), 'merge', '--no-edit', integrationOf(run))).toThrow();
      writeFileSync(join(b.cwd, 'web', 'web.txt'), 'resolved\n');
      git(join(b.cwd, 'web'), 'add', 'web.txt');
      git(join(b.cwd, 'web'), 'commit', '-q', '--no-edit');

      expect(await iso.integrate(both, run)).toBe('merged');
      expect(git(join(dir, 'api'), 'show', `${integrationOf(run)}:api.txt`)).toBe('both');
      expect(git(join(dir, 'web'), 'show', `${integrationOf(run)}:web.txt`)).toBe('resolved');
    });

    it('repairs a two-repository conflict in the task\'s own workspace, then lands it in both', async () => {
      const { dir, iso, run, both, b } = await secondConflicts();
      expect(await iso.integrate(both, run)).toBe('conflict');
      const tips = { api: tip(dir, 'api', run), web: tip(dir, 'web', run) };

      expect(await iso.reopen(both, run)).toEqual({ cwd: b.cwd, branch: b.branch, copied: [] });
      expect(run.tasks['task-2']).toMatchObject({ status: 'repairing', repairBase: tips, repairedFiles: ['web/web.txt'] });

      // The repair's agent: bring the tip into every repository the task changed.
      git(join(b.cwd, 'api'), 'merge', '--no-edit', integrationOf(run));
      expect(await iso.verifyRepair(both, run)).toEqual({ ok: false, reason: 'not-merged', repo: 'web' });
      expect(() => git(join(b.cwd, 'web'), 'merge', '--no-edit', integrationOf(run))).toThrow();
      writeFileSync(join(b.cwd, 'web', 'web.txt'), 'first and both\n');
      expect(await iso.verifyRepair(both, run)).toEqual({ ok: true });

      expect(await iso.integrate(both, run)).toBe('merged');
      expect(git(join(dir, 'api'), 'show', `${integrationOf(run)}:api.txt`)).toBe('both');
      expect(git(join(dir, 'web'), 'show', `${integrationOf(run)}:web.txt`)).toBe('first and both');
      for (const repo of ['api', 'web'] as const) {
        expect(git(join(dir, repo), 'rev-parse', `${integrationOf(run)}^1`)).toBe(tips[repo]);
      }
    });

    describe('a repair in a repository its landing did not change (ADR-0055 D14)', () => {
      async function webOnlyConflict() {
        const dir = pair();
        const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
        const run = await iso.startRun(dir);
        const [first, second] = [task(1, 'First'), task(2, 'Second')];
        const a = await iso.prepare(first, run);
        const b = await iso.prepare(second, run);
        writeFileSync(join(a.cwd, 'web', 'web.txt'), 'first\n');
        writeFileSync(join(b.cwd, 'web', 'web.txt'), 'second\n');
        expect(await iso.integrate(first, run)).toBe('merged');
        expect(await iso.integrate(second, run)).toBe('conflict');
        await iso.reopen(second, run);
        expect(run.tasks['task-2'].repairBase).toEqual({ web: tip(dir, 'web', run) });
        expect(() => git(join(b.cwd, 'web'), 'merge', '--no-edit', integrationOf(run))).toThrow();
        writeFileSync(join(b.cwd, 'web', 'web.txt'), 'first and second\n');
        return { iso, run, second, b };
      }

      it('reads conflict markers there, though only a repo with a repair base is held to contain the tip', async () => {
        const { iso, run, second, b } = await webOnlyConflict();
        writeFileSync(join(b.cwd, 'api', 'api.txt'), '<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n');
        expect(await iso.verifyRepair(second, run)).toEqual({ ok: false, reason: 'conflict-markers', repo: 'api', files: ['api.txt'] });
      });

      it('lists what the repair brings there, for the protected paths to judge', async () => {
        const { iso, run, second, b } = await webOnlyConflict();
        writeFileSync(join(b.cwd, 'api', 'api.txt'), 'edited by the repair\n');
        expect(await iso.verifyRepair(second, run)).toEqual({ ok: true });
        expect(await iso.repairPaths?.(second, run)).toEqual(['api/api.txt', 'web/web.txt']);
      });
    });

    it('merges nothing for a task that changed nothing, and lands it', async () => {
      const dir = pair();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const idle = task(1, 'Idle');
      const { cwd } = await iso.prepare(idle, run);
      const before = { api: tip(dir, 'api', run), web: tip(dir, 'web', run) };
      const persisted: string[] = [];

      expect(await iso.integrate(idle, run, () => persisted.push('persist'))).toBe('merged');

      expect({ api: tip(dir, 'api', run), web: tip(dir, 'web', run) }).toEqual(before);
      expect(persisted).toEqual([]);
      expect(run.tasks['task-1']).toMatchObject({ status: 'merged', repos: { api: { changed: false }, web: { changed: false } } });
      expect(existsSync(cwd)).toBe(false);
    });

    it('records every changed repository\'s tip and has the run persisted before the first merge', async () => {
      const dir = pair();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const t = task(1, 'Both');
      const { cwd } = await iso.prepare(t, run);
      writeFileSync(join(cwd, 'api', 'a.txt'), 'a\n');
      writeFileSync(join(cwd, 'web', 'w.txt'), 'w\n');
      const before = { api: tip(dir, 'api', run), web: tip(dir, 'web', run) };
      const seen: unknown[] = [];

      await iso.integrate(t, run, () => seen.push({
        landing: JSON.parse(JSON.stringify(run.landing)),
        tips: { api: tip(dir, 'api', run), web: tip(dir, 'web', run) },
      }));

      expect(seen).toEqual([{ landing: { taskId: 'task-1', tips: before }, tips: before }]);
      expect(run.landing).toBeUndefined();
    });

    describe('after a crash mid-landing', () => {
      // Three repositories; task 1 has landed a change to web.txt, and task 2
      // changes all three, colliding in web — merged last, in path order.
      function trio(): string {
        const dir = realpath(mkdtempSync(join(tmpdir(), 'ordewell-trio-')));
        roots.push(dir);
        initRepo(join(dir, 'api'), { 'api.txt': 'api\n' });
        initRepo(join(dir, 'db'), { 'db.txt': 'db\n' });
        initRepo(join(dir, 'web'), { 'web.txt': 'web\n' });
        return dir;
      }
      const integrationDir = (dir: string, run: IsolationRun, repo: string) => join(dir, '.ordewell', 'worktrees', run.id, 'integration', repo);

      /** Run task 2's landing until `at` kills the process; return the run as it was last persisted. */
      async function crashDuringLanding(dir: string, opts: { conflict: boolean; at: (run: IsolationRun) => (args: string[], cwd: string | undefined) => boolean }) {
        let run: IsolationRun | null = null;
        const crash = crashAt((args, cwd) => run !== null && opts.at(run)(args, cwd));
        const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl: crash.exec });
        run = await iso.startRun(dir);
        const started = run;
        const [first, all] = [task(1, 'Edit web'), task(2, 'Edit all')];
        const f = await iso.prepare(first, started);
        const a = await iso.prepare(all, started);
        writeFileSync(join(f.cwd, 'web', 'web.txt'), 'first\n');
        for (const repo of ['api', 'db', 'web']) writeFileSync(join(a.cwd, repo, `${repo}.txt`), opts.conflict ? 'all\n' : `${repo}.txt`);
        if (opts.conflict) expect(await iso.integrate(first, started)).toBe('merged');
        const tips = Object.fromEntries(['api', 'db', 'web'].map((repo) => [repo, tip(dir, repo, started)]));
        let saved = '';
        void iso.integrate(all, started, () => { saved = JSON.stringify(started); });
        await vi.waitFor(() => expect(crash.crashed()).toBe(true));
        return { persisted: JSON.parse(saved) as IsolationRun, tips, workspace: a.cwd };
      }

      async function recover(dir: string, persisted: IsolationRun) {
        await create({ config: fakeConfig({ worktreeIsolation: true }) }).pruneOrphans(persisted);
      }

      it('rolls back the repositories merged before the crash, keeping the task\'s own commit for a retry', async () => {
        const dir = trio();
        const { persisted, tips, workspace } = await crashDuringLanding(dir, {
          conflict: false,
          at: (run) => (args, cwd) => subcommand(args) === 'merge' && cwd === integrationDir(dir, run, 'web'),
        });
        expect(tip(dir, 'api', persisted)).not.toBe(tips.api);
        expect(persisted.landing).toEqual({ taskId: 'task-2', tips });

        await recover(dir, persisted);

        for (const repo of ['api', 'db', 'web']) {
          expect(tip(dir, repo, persisted)).toBe(tips[repo]);
          expect(worktreePaths(join(dir, repo))).toContain(join(workspace, repo));
          expect(branches(join(dir, repo))).toContain(persisted.tasks['task-2'].branch);
        }
        expect(persisted.landing).toBeUndefined();
        // The rolled-back commits are still on the task's own branch. It is
        // kept rather than deleted: a retry can land them, a red X cannot.
        expect(persisted.tasks['task-2'].status).toBe('kept');
        expect(git(join(dir, 'api'), 'log', '--format=%s', persisted.tasks['task-2'].branch)).toContain('Edit all');
        expect(existsSync(workspace)).toBe(true);
      });

      it('finishes a rollback the crash cut short, leaving no repository half-rolled-back', async () => {
        const dir = trio();
        const { persisted, tips } = await crashDuringLanding(dir, {
          conflict: true,
          at: (run) => (args, cwd) => args[0] === 'reset' && cwd === integrationDir(dir, run, 'db'),
        });
        expect(tip(dir, 'api', persisted)).toBe(tips.api);
        expect(tip(dir, 'db', persisted)).not.toBe(tips.db);

        await recover(dir, persisted);

        for (const repo of ['api', 'db', 'web']) expect(tip(dir, repo, persisted)).toBe(tips[repo]);
        expect(persisted.landing).toBeUndefined();
      });

      it('rolls back a task that merged everywhere but was not yet saved as landed', async () => {
        const dir = trio();
        const { persisted, tips } = await crashDuringLanding(dir, {
          conflict: false,
          at: () => (args) => args[0] === 'worktree' && args[1] === 'remove',
        });
        for (const repo of ['api', 'db', 'web']) expect(tip(dir, repo, persisted)).not.toBe(tips[repo]);
        expect(persisted.tasks['task-2'].status).toBe('active');

        await recover(dir, persisted);

        for (const repo of ['api', 'db', 'web']) expect(tip(dir, repo, persisted)).toBe(tips[repo]);
        expect(persisted.landing).toBeUndefined();
      });

      it('leaves an integration branch alone that has moved past the landing, and keeps the landing recorded', async () => {
        const dir = trio();
        const { persisted, tips } = await crashDuringLanding(dir, {
          conflict: false,
          at: (run) => (args, cwd) => subcommand(args) === 'merge' && cwd === integrationDir(dir, run, 'web'),
        });
        // Something other than this landing committed on top of it.
        const api = join(dir, 'api');
        const moved = git(api, 'commit-tree', `${integrationOf(persisted)}^{tree}`, '-p', integrationOf(persisted), '-m', 'not ours');
        git(api, 'update-ref', `refs/heads/${integrationOf(persisted)}`, moved);

        await recover(dir, persisted);

        expect(tip(dir, 'api', persisted)).toBe(moved);
        expect(persisted.landing).toEqual({ taskId: 'task-2', tips });

        // Its integration branch holds part of a task, so none of it is merged for the user or built on.
        const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
        const heads = ['api', 'db', 'web'].map((repo) => git(join(dir, repo), 'rev-parse', 'HEAD'));
        expect(await iso.mergeIntoCheckedOut(persisted)).toEqual({
          outcome: 'blocked',
          blocked: [{ repo: 'api', reason: 'partial-landing', files: [] }],
        });
        expect(['api', 'db', 'web'].map((repo) => git(join(dir, repo), 'rev-parse', 'HEAD'))).toEqual(heads);
        const next = task(3, 'Next');
        const { cwd } = await iso.prepare(next, persisted);
        writeFileSync(join(cwd, 'db', 'next.txt'), 'n\n');
        expect(await iso.integrate(next, persisted)).toBe('failed');
        expect(tip(dir, 'db', persisted)).toBe(tips.db);
      });
    });

    it('cleanup and discard reach a conflicted task\'s worktrees and branches in every repository', async () => {
      const { dir, iso, run, b } = await secondConflicts();
      expect(await iso.integrate(task(2, 'Edit both'), run)).toBe('conflict');

      await iso.discard(run, { integration: 'keep' });
      for (const repo of ['api', 'web']) {
        expect(worktreePaths(join(dir, repo))).toEqual([join(dir, repo)]);
        expect(branches(join(dir, repo))).toEqual([integrationOf(run)]);
      }
      expect(existsSync(b.cwd)).toBe(false);

      await iso.discard(run, { integration: 'delete' });
      for (const repo of ['api', 'web']) expect(branches(join(dir, repo))).toEqual([]);
      expect(existsSync(join(dir, '.ordewell', 'worktrees', run.id))).toBe(false);
    });

    it('fails a task whose merge a hook refuses, naming the repository, and rolls the others back', async () => {
      const dir = pair();
      writeFileSync(join(dir, 'web', '.git', 'hooks', 'pre-merge-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const t = task(1, 'Both');
      const { cwd } = await iso.prepare(t, run);
      writeFileSync(join(cwd, 'api', 'a.txt'), 'a\n');
      writeFileSync(join(cwd, 'web', 'w.txt'), 'w\n');
      const before = tip(dir, 'api', run);

      expect(await iso.integrate(t, run)).toBe('failed');

      expect(tip(dir, 'api', run)).toBe(before);
      expect(run.tasks['task-1']).toMatchObject({ status: 'failed', conflictRepo: 'web' });
      const integrationDir = join(dir, '.ordewell', 'worktrees', run.id, 'integration', 'web');
      expect(git(integrationDir, 'status', '--porcelain')).toBe('');
      expect(existsSync(join(cwd, 'web'))).toBe(true);
    });
  });
});
