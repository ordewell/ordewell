// Part of GitWorktreeIsolation: split by describe so CI's shards (vitest splits by file) balance. Helpers: gitWorktreeIsolationKit.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { type GitExecFn, type WorktreeIsolationDeps } from '../GitWorktreeIsolation';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import { fakeConfig, flushMicrotasks, removeDir } from '../../testing';
import { realpath, hasGit, create, git, initRepo, task, worktreePaths, replaceGitFile, lexists, branches, execFileAsync, refuseWorktreesIn, roots, repo } from './gitWorktreeIsolationKit';

afterEach(async () => {
  while (roots.length) await removeDir(roots.pop()!);
});

describe('WorktreeIsolation.isActive', () => {
  it('reports disabled when the setting is off, even inside a clean repo', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: false }) });
    expect(await iso.isActive(root)).toEqual({ active: false, reason: 'disabled' });
  });

  it('reports git-missing when the git binary cannot be started', async () => {
    const iso = create({
      config: fakeConfig({ worktreeIsolation: true }),
      execFileImpl: async () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); },
      resolvePath: async () => '',
    });
    expect(await iso.isActive('/anywhere')).toEqual({ active: false, reason: 'git-missing' });
  });

  describe.skipIf(!hasGit)('with git installed', () => {
    it('reports not-git for a plain directory', async () => {
      const dir = realpath(mkdtempSync(join(tmpdir(), 'ordewell-plain-')));
      roots.push(dir);
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(dir)).toEqual({ active: false, reason: 'not-git' });
    });

    it('stays active for a repository that contains a nested repository that is not a submodule, and shares it live', async () => {
      const root = repo();
      initRepo(join(root, 'services', 'billing'));
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(root)).toEqual({ active: true, shared: ['services/billing'] });
    });

    it('does not treat a submodule as a nested repository', async () => {
      const root = repo();
      const upstream = repo();
      git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'vendor/lib');
      git(root, 'commit', '-q', '-m', 'add submodule');
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(root)).toEqual({ active: true });
    });

    it('does not treat a path its .gitmodules declares as a nested repository, even before the gitlink is staged', async () => {
      const root = repo({ 'README.md': 'hello\n', '.gitmodules': '[submodule "lib"]\n\tpath = vendor/lib\n\turl = ../lib\n' });
      initRepo(join(root, 'vendor', 'lib'));
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(root)).toEqual({ active: true });
    });

    it('counts a checkout with a .git file as a nested repository, and looks no deeper than two levels', async () => {
      const root = repo();
      const elsewhere = repo();
      mkdirSync(join(root, 'tools'));
      git(elsewhere, 'worktree', 'add', '-q', join(root, 'tools', 'linked'));
      initRepo(join(root, 'a', 'b', 'too-deep'));
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(root)).toEqual({ active: true, shared: ['tools/linked'] });
    });

    it('resolves submodules against the repository top level when the workspace is a subdirectory', async () => {
      const root = repo({ 'app/README.md': 'hello\n' });
      const upstream = repo();
      git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'app/vendor/lib');
      git(root, 'commit', '-q', '-m', 'add submodule');
      initRepo(join(root, 'app', 'tools', 'extra'));
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(join(root, 'app'))).toEqual({ active: true, shared: ['tools/extra'] });
    });

    it('shares a nested repository the outer repository ignores too, so it cannot vanish silently', async () => {
      const root = repo({ 'README.md': 'hello\n', '.gitignore': 'scratch/\ncache/\n' });
      initRepo(join(root, 'scratch'));
      initRepo(join(root, 'cache', 'clone'));
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(root)).toEqual({ active: true, shared: ['cache/clone', 'scratch'] });
    });

    it('does not look for nested repositories inside .ordewell or node_modules', async () => {
      const root = repo();
      initRepo(join(root, '.ordewell', 'worktrees', 'r1'));
      initRepo(join(root, 'node_modules', 'pkg'));
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(root)).toEqual({ active: true });
    });

    it('isolates a folder of repositories as a group of the ones directly inside it, not deeper ones', async () => {
      const dir = realpath(mkdtempSync(join(tmpdir(), 'ordewell-group-')));
      roots.push(dir);
      initRepo(join(dir, 'web'));
      initRepo(join(dir, 'api'));
      mkdirSync(join(dir, 'docs'));
      initRepo(join(dir, 'docs', 'deep'));
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(dir)).toEqual({ active: true, repos: ['api', 'web'], shared: ['docs'] });
      const run = await iso.startRun(dir);
      expect(run.repos.map((r) => r.path)).toEqual(['api', 'web']);
      expect(run.shared).toEqual(['docs']);
    });

    it('reports no-commits for a repository with nothing to branch from', async () => {
      const dir = realpath(mkdtempSync(join(tmpdir(), 'ordewell-empty-')));
      roots.push(dir);
      git(dir, 'init', '-q');
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(dir)).toEqual({ active: false, reason: 'no-commits' });
    });

    it('is active for a clean repository, and untracked files do not block it', async () => {
      const root = repo();
      writeFileSync(join(root, 'scratch.txt'), 'untracked');
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(root)).toEqual({ active: true });
    });

    it('reports dirty when a tracked file is modified', async () => {
      const root = repo();
      writeFileSync(join(root, 'README.md'), 'changed\n');
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(root)).toEqual({ active: false, reason: 'dirty' });
    });

    it('reports dirty for a staged change too', async () => {
      const root = repo();
      writeFileSync(join(root, 'README.md'), 'staged\n');
      git(root, 'add', 'README.md');
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(root)).toEqual({ active: false, reason: 'dirty' });
    });

    it('stashes tracked changes so the tree isolates, leaving untracked files where they are', async () => {
      const root = repo();
      writeFileSync(join(root, 'README.md'), 'work in progress\n');
      writeFileSync(join(root, 'notes.txt'), 'untracked\n');
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });

      await iso.stash(root);

      expect(await iso.isActive(root)).toEqual({ active: true });
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('hello\n');
      expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('untracked\n');
      git(root, 'stash', 'pop');
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('work in progress\n');
    });
  });
});
describe.skipIf(!hasGit)('WorktreeIsolation run lifecycle', () => {
  let root: string;
  beforeEach(() => { root = repo(); });

  it('runs a task in its own worktree and lands it on the integration branch with a merge commit', async () => {
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const headBefore = git(root, 'rev-parse', 'HEAD');

    // A workspace that is one repository is a group of one, at `.`.
    expect(run.repos).toEqual([
      { path: '.', root, baseRef: headBefore, baseBranch: 'main', integrationBranch: `ordewell/${run.id}/integration` },
    ]);
    expect(run.shared).toEqual([]);

    const { cwd, branch } = await iso.prepare(task(1, 'Add greeting'), run);
    expect(cwd).toBe(join(root, '.ordewell', 'worktrees', run.id, '1-add-greeting'));
    expect(branch).toBe(`ordewell/${run.id}/1-add-greeting`);
    expect(worktreePaths(root)).toContain(cwd);
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe('hello\n');

    writeFileSync(join(cwd, 'greeting.txt'), 'hi\n');
    expect(await iso.integrate(task(1, 'Add greeting'), run)).toBe('merged');

    expect(git(root, 'show', `${run.repos[0].integrationBranch}:greeting.txt`)).toBe('hi');
    // Two parents plus the commit id: --no-ff produced a real merge commit.
    expect(git(root, 'rev-list', '--parents', '-n', '1', run.repos[0].integrationBranch).split(' ')).toHaveLength(3);
    expect(git(root, 'log', '-1', '--format=%s', run.repos[0].integrationBranch)).toContain('Add greeting');

    expect(worktreePaths(root)).not.toContain(cwd);
    expect(existsSync(cwd)).toBe(false);
    expect(branches(root)).not.toContain(branch);
    expect(run.tasks['task-1'].status).toBe('merged');

    // The user's checkout is exactly as it was.
    expect(git(root, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(root, 'branch', '--show-current')).toBe('main');
    expect(existsSync(join(root, 'greeting.txt'))).toBe(false);
    expect(git(root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  it('records a task workspace holding the repo worktree, and which repos a landed task changed', async () => {
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const [changes, idle] = [task(1, 'Changes'), task(2, 'Idle')];
    const a = await iso.prepare(changes, run);
    const b = await iso.prepare(idle, run);
    expect(run.tasks['task-1'].workspace).toBe(a.cwd);
    expect(run.tasks['task-1'].repos).toEqual({ '.': { worktree: a.cwd, linked: [], baseRef: run.repos[0].baseRef } });

    writeFileSync(join(a.cwd, 'new.txt'), 'n\n');
    expect(await iso.integrate(changes, run)).toBe('merged');
    expect(await iso.integrate(idle, run)).toBe('merged');

    expect(run.tasks['task-1'].repos['.'].changed).toBe(true);
    expect(run.tasks['task-2'].repos['.'].changed).toBe(false);
    expect(existsSync(b.cwd)).toBe(false);
  });

  it('starts a later task from a tree that already contains integrated work', async () => {
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const first = await iso.prepare(task(1, 'First'), run);
    writeFileSync(join(first.cwd, 'one.txt'), '1\n');
    await iso.integrate(task(1, 'First'), run);

    const second = await iso.prepare(task(2, 'Second'), run);
    expect(readFileSync(join(second.cwd, 'one.txt'), 'utf8')).toBe('1\n');
  });

  it('mints a record that survives a JSON round trip', async () => {
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    await iso.prepare(task(1, 'Persist me'), run);
    const restored = JSON.parse(JSON.stringify(run)) as IsolationRun;
    expect(restored).toEqual(run);
    expect(restored.tasks['task-1'].branch).toBe(`ordewell/${run.id}/1-persist-me`);
  });

  it('gives two runs different ids and integration branches', async () => {
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const a = await iso.startRun(root);
    const b = await iso.startRun(root);
    expect(a.id).not.toBe(b.id);
    expect(a.repos[0].integrationBranch).not.toBe(b.repos[0].integrationBranch);
  });

  it('prepares several tasks concurrently', async () => {
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const prepared = await Promise.all([1, 2, 3].map((n) => iso.prepare(task(n, `Task ${n}`), run)));
    for (const { cwd } of prepared) expect(worktreePaths(root)).toContain(cwd);
  });
});
describe.skipIf(!hasGit)('WorktreeIsolation over a repository with nested repositories', () => {
  it('shares the nested repo live into every task and keeps it out of the task commit', async () => {
    const root = repo();
    const nested = initRepo(join(root, 'services', 'billing'), { 'billing.txt': 'v1\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    expect(run.repos.map((r) => r.path)).toEqual(['.']);
    expect(run.shared).toEqual(['services/billing']);

    const { cwd } = await iso.prepare(task(1, 'Touch both'), run);
    expect(lstatSync(join(cwd, 'services', 'billing')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(cwd, 'services', 'billing', 'billing.txt'), 'utf8')).toBe('v1\n');
    writeFileSync(join(cwd, 'services', 'billing', 'billing.txt'), 'v2\n');

    writeFileSync(join(cwd, 'app.txt'), 'a\n');
    expect(await iso.integrate(task(1, 'Touch both'), run)).toBe('merged');
    const branch = run.repos[0].integrationBranch;
    expect(git(root, 'show', `${branch}:app.txt`)).toBe('a');
    expect(() => git(root, 'cat-file', '-e', `${branch}:services/billing`)).toThrow();

    // The edit went through the live link to the real nested repo, which survives cleanup.
    expect(readFileSync(join(nested, 'billing.txt'), 'utf8')).toBe('v2\n');
    expect(existsSync(join(root, 'services', 'billing', '.git'))).toBe(true);
  });

  it('does not fail a later task when a nested repo disappears mid-run', async () => {
    const root = repo();
    const nested = initRepo(join(root, 'services', 'billing'));
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    await iso.prepare(task(1, 'First'), run);
    rmSync(nested, { recursive: true, force: true });
    const { cwd } = await iso.prepare(task(2, 'Second'), run);
    expect(lexists(join(cwd, 'services', 'billing'))).toBe(false);
  });

  it('does not link again a nested repo a linked artifact already covers', async () => {
    const root = repo();
    initRepo(join(root, 'vendor', 'lib'));
    writeFileSync(join(root, '.gitignore'), 'vendor/\n');
    git(root, 'add', '.gitignore');
    git(root, 'commit', '-q', '-m', 'ignore vendor');
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    expect(run.shared).toEqual(['vendor/lib']);
    const { cwd } = await iso.prepare(task(1, 'Vendored'), run);
    // `vendor` is a linked artifact: the whole thing is live, nested repo included.
    expect(lstatSync(join(cwd, 'vendor')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(cwd, 'vendor', 'lib', 'README.md'), 'utf8')).toBe('hello\n');
  });
});
describe.skipIf(!hasGit)('WorktreeIsolation integration queue', () => {
  it('merges in plan order when tasks finish out of order', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const [t1, t2, t3] = [task(1, 'One'), task(2, 'Two'), task(3, 'Three')];
    for (const t of [t1, t2, t3]) {
      const { cwd } = await iso.prepare(t, run);
      writeFileSync(join(cwd, `file-${t.order}.txt`), `${t.order}\n`);
    }

    const outcomes = await Promise.all([iso.integrate(t3, run), iso.integrate(t1, run), iso.integrate(t2, run)]);
    expect(outcomes).toEqual(['merged', 'merged', 'merged']);

    const merges = git(root, 'log', '--first-parent', '--reverse', '--merges', '--format=%s', run.repos[0].integrationBranch).split('\n');
    expect(merges).toEqual(['Merge: One', 'Merge: Two', 'Merge: Three']);
  });

  it('does not wait for a lower-order task that has not finished', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const [t1, t2] = [task(1, 'Slow'), task(2, 'Fast')];
    await iso.prepare(t1, run);
    const { cwd } = await iso.prepare(t2, run);
    writeFileSync(join(cwd, 'fast.txt'), 'x\n');

    expect(await iso.integrate(t2, run)).toBe('merged');
    expect(git(root, 'show', `${run.repos[0].integrationBranch}:fast.txt`)).toBe('x');
    expect(run.tasks['task-1'].status).toBe('active');
  });

  it('commits what the runner left uncommitted, and keeps commits the runner made itself', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Mixed');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'committed.txt'), 'a\n');
    git(cwd, 'add', 'committed.txt');
    git(cwd, 'commit', '-q', '-m', 'runner commit');
    writeFileSync(join(cwd, 'loose.txt'), 'b\n');

    expect(await iso.integrate(t, run)).toBe('merged');
    expect(git(root, 'show', `${run.repos[0].integrationBranch}:committed.txt`)).toBe('a');
    expect(git(root, 'show', `${run.repos[0].integrationBranch}:loose.txt`)).toBe('b');
    expect(git(root, 'log', '--format=%s', run.repos[0].integrationBranch)).toContain('runner commit');
  });

  it('writes the commit the task stated on its leftover work and its merge', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Add greeting');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'greeting.txt'), 'hi\n');

    const commit = { subject: 'Greet the user on start', body: 'The banner was empty.\nNow it says hi.' };
    expect(await iso.integrate(t, run, undefined, commit)).toBe('merged');

    const integration = run.repos[0].integrationBranch;
    expect(git(root, 'log', '-1', '--format=%B', integration)).toBe('Merge: Greet the user on start\n\nThe banner was empty.\nNow it says hi.');
    expect(git(root, 'log', '-1', '--format=%B', `${integration}^2`)).toBe('Greet the user on start\n\nThe banner was empty.\nNow it says hi.');
  });

  it.each([true, false])('writes the stated commit verbatim when the user\'s commit.cleanup strips # lines (trailer %s)', async (plannedWith) => {
    const root = repo();
    git(root, 'config', 'commit.cleanup', 'strip');
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }), plannedWith: () => plannedWith });
    const run = await iso.startRun(root);
    const t = task(1, 'Fix the parser');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'parser.txt'), 'fixed\n');

    expect(await iso.integrate(t, run, undefined, { subject: '#42 Fix the parser', body: '# Changes\n- one' })).toBe('merged');

    const integration = run.repos[0].integrationBranch;
    const trailer = plannedWith ? '\n\nPlanned-with: Ordewell' : '';
    expect(git(root, 'log', '-1', '--format=%B', `${integration}^2`)).toBe(`#42 Fix the parser\n\n# Changes\n- one${trailer}`);
    expect(git(root, 'log', '-1', '--format=%B', integration)).toBe(`Merge: #42 Fix the parser\n\n# Changes\n- one${trailer}`);
  });

  it('falls back to the task title when the task stated no commit', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Add greeting\nwith a second line');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'greeting.txt'), 'hi\n');

    expect(await iso.integrate(t, run)).toBe('merged');

    const integration = run.repos[0].integrationBranch;
    expect(git(root, 'log', '-1', '--format=%B', integration)).toBe('Merge: Add greeting');
    expect(git(root, 'log', '-1', '--format=%B', `${integration}^2`)).toBe('Add greeting');
  });

  it('never rewrites a commit the runner made, and gives only the leftover work the stated message', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Mixed');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'committed.txt'), 'a\n');
    git(cwd, 'add', 'committed.txt');
    git(cwd, 'commit', '-q', '-m', 'runner commit');
    writeFileSync(join(cwd, 'loose.txt'), 'b\n');

    expect(await iso.integrate(t, run, undefined, { subject: 'Stated subject' })).toBe('merged');

    const integration = run.repos[0].integrationBranch;
    expect(git(root, 'log', '--reverse', '--format=%s', `${integration}^1..${integration}^2`).split('\n')).toEqual(['runner commit', 'Stated subject']);
    expect(git(root, 'log', '-1', '--format=%B', integration)).toBe('Merge: Stated subject');
  });

  describe('the Planned-with trailer (ADR-0030)', () => {
    const trailers = (cwd: string, ref: string): string =>
      execFileSync('git', ['interpret-trailers', '--parse'], { input: git(cwd, 'log', '-1', '--format=%B', ref), encoding: 'utf8' });

    async function landOne(deps: Partial<WorktreeIsolationDeps>, title: string) {
      const root = repo();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }), ...deps });
      const run = await iso.startRun(root);
      const t = task(1, title);
      const { cwd } = await iso.prepare(t, run);
      writeFileSync(join(cwd, 'committed.txt'), 'a\n');
      git(cwd, 'add', 'committed.txt');
      git(cwd, 'commit', '-q', '-m', 'runner commit');
      writeFileSync(join(cwd, 'loose.txt'), 'b\n');
      expect(await iso.integrate(t, run, undefined, { subject: 'Stated subject', body: 'Stated body.' })).toBe('merged');
      return { root, integration: run.repos[0].integrationBranch };
    }

    it('is parsed by git on the landing merge and on the leftover work, and never on the runner\'s commit', async () => {
      const { root, integration } = await landOne({ plannedWith: () => true }, 'Mixed');

      expect(trailers(root, integration)).toBe('Planned-with: Ordewell\n');
      expect(trailers(root, `${integration}^2`)).toBe('Planned-with: Ordewell\n');
      expect(git(root, 'log', '-1', '--format=%B', integration)).toBe('Merge: Stated subject\n\nStated body.\n\nPlanned-with: Ordewell');
      expect(trailers(root, `${integration}^2^`)).toBe('');
      expect(git(root, 'log', '-1', '--format=%B', `${integration}^2^`)).toBe('runner commit');
    });

    it('is left off when the setting is off, or when nothing says', async () => {
      const off = await landOne({ plannedWith: () => false }, 'Off');
      expect(git(off.root, 'log', '--format=%B', `${off.integration}^1..${off.integration}`)).not.toContain('Planned-with');

      const unsaid = await landOne({}, 'Unsaid');
      expect(git(unsaid.root, 'log', '--format=%B', `${unsaid.integration}^1..${unsaid.integration}`)).not.toContain('Planned-with');
    });

    it('follows the setting as each landing is written, with no new isolation', async () => {
      const root = repo();
      let on = true;
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }), plannedWith: () => on });
      const run = await iso.startRun(root);
      const integration = run.repos[0].integrationBranch;
      for (const [order, setting] of [[1, true], [2, false], [3, true]] as const) {
        on = setting;
        const t = task(order, `Task ${order}`);
        const { cwd } = await iso.prepare(t, run);
        writeFileSync(join(cwd, `f${order}.txt`), 'x\n');
        expect(await iso.integrate(t, run)).toBe('merged');
      }

      const merges = git(root, 'log', '--merges', '--format=%H', integration).split('\n');
      expect(merges.map((sha) => trailers(root, sha))).toEqual(['Planned-with: Ordewell\n', '', 'Planned-with: Ordewell\n']);
    });

    it('closes Merge all\'s merge into a branch that moved, which names the tasks it brings and never the integration branch', async () => {
      const root = repo();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }), plannedWith: () => true });
      const run = await iso.startRun(root);
      for (const [order, title, commit] of [[1, 'Add alpha', { subject: 'Greet the user' }], [2, 'Add beta', undefined]] as const) {
        const t = task(order, title);
        const { cwd } = await iso.prepare(t, run);
        writeFileSync(join(cwd, `f${order}.txt`), 'x\n');
        expect(await iso.integrate(t, run, undefined, commit)).toBe('merged');
      }
      writeFileSync(join(root, 'mine.txt'), 'mine\n');
      git(root, 'add', 'mine.txt');
      git(root, 'commit', '-q', '-m', 'user work');

      expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });

      expect(git(root, 'log', '-1', '--format=%B')).toBe('Merge: Greet the user and 1 more\n\n- Greet the user\n- Add beta\n\nPlanned-with: Ordewell');
      expect(trailers(root, 'HEAD')).toBe('Planned-with: Ordewell\n');
      expect(git(root, 'log', '--format=%B')).not.toContain('ordewell/');
    });

    it('names Merge all\'s merge of one task for it alone, and leaves the trailer off when the setting is off', async () => {
      const root = repo();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }), plannedWith: () => false });
      const run = await iso.startRun(root);
      const t = task(1, 'Add alpha');
      const { cwd } = await iso.prepare(t, run);
      writeFileSync(join(cwd, 'alpha.txt'), 'alpha\n');
      expect(await iso.integrate(t, run)).toBe('merged');
      git(root, 'commit', '-q', '--allow-empty', '-m', 'user work');

      expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });

      expect(git(root, 'log', '-1', '--format=%B')).toBe('Merge: Add alpha');
    });

    it('closes the kept-work rescue and a continue\'s merge of it, both named for the task, as they land with it', async () => {
      const root = repo();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }), plannedWith: () => true });
      const run = await iso.startRun(root);
      const resumed = task(1, 'Resume me');
      const first = await iso.prepare(resumed, run);
      writeFileSync(join(first.cwd, 'half.txt'), 'half\n');
      await iso.release(run, resumed.id, { keep: true });
      const meanwhile = task(2, 'Land meanwhile');
      const other = await iso.prepare(meanwhile, run);
      writeFileSync(join(other.cwd, 'other.txt'), 'other\n');
      expect(await iso.integrate(meanwhile, run)).toBe('merged');

      const again = await iso.prepare(resumed, run, 'restore');
      expect(readFileSync(join(again.cwd, 'half.txt'), 'utf8')).toBe('half\n');
      expect(await iso.integrate(resumed, run, undefined, { subject: 'Finish it' })).toBe('merged');

      const integration = run.repos[0].integrationBranch;
      const subjects = git(root, 'log', '--format=%s', integration).split('\n');
      expect(subjects).toEqual(expect.arrayContaining(['Merge: Finish it', 'Merge: Resume me (resume its kept work)', 'WIP: Resume me']));
      expect(git(root, 'log', '--format=%B', integration)).not.toMatch(/ordewell\/|Merge commit/);
      const ours = git(root, 'rev-list', integration, '--not', 'main').split('\n');
      expect(ours.map((sha) => trailers(root, sha))).toEqual(ours.map(() => 'Planned-with: Ordewell\n'));
    });
  });

  it('treats a task that changed nothing as merged', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Noop');
    await iso.prepare(t, run);
    expect(await iso.integrate(t, run)).toBe('merged');
  });

  it('reports failed for a task that was never prepared', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    expect(await iso.integrate(task(1, 'Ghost'), run)).toBe('failed');
  });

  it('names a missing worktree when a task that did its work can no longer be integrated', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Vanished');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'work.txt'), 'the runner wrote this\n');
    rmSync(cwd, { recursive: true, force: true });

    expect(await iso.integrate(t, run)).toBe('failed');
    expect(run.tasks['task-1'].landingError).toMatch(/worktree/i);
    expect(run.tasks['task-1'].landingError).toContain(cwd);
  });

  it('names the checkout holding the integration branch when git will not add it a second time', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Held elsewhere');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'work.txt'), 'the runner wrote this\n');
    git(root, 'checkout', '-q', run.repos[0].integrationBranch);

    expect(await iso.integrate(t, run)).toBe('failed');
    expect(run.tasks['task-1'].landingError).toBe(`the integration branch is checked out in ${root}`);
  });
  it('names what a hook said when it refuses the merge commit of a landing', async () => {
    const root = repo();
    writeFileSync(join(root, '.git', 'hooks', 'pre-merge-commit'), '#!/bin/sh\necho "lint: subject is too long" >&2\nexit 1\n', { mode: 0o755 });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Hooked landing');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'work.txt'), 'the runner wrote this\n');

    expect(await iso.integrate(t, run)).toBe('failed');

    expect(run.tasks['task-1']).toMatchObject({ status: 'failed', landingError: expect.stringContaining('lint: subject is too long') });
  });
});
describe.skipIf(!hasGit)('WorktreeIsolation conflicts', () => {
  async function conflicted() {
    const root = repo({ 'shared.txt': 'base\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const [t1, t2] = [task(1, 'Left'), task(2, 'Right')];
    const a = await iso.prepare(t1, run);
    const b = await iso.prepare(t2, run);
    writeFileSync(join(a.cwd, 'shared.txt'), 'left\n');
    writeFileSync(join(b.cwd, 'shared.txt'), 'right\n');
    return { root, iso, run, t1, t2, a, b };
  }

  it('reports a conflict, keeps the worktree and both refs, and leaves the integration branch untouched', async () => {
    const { root, iso, run, t1, t2, b } = await conflicted();
    expect(await iso.integrate(t1, run)).toBe('merged');
    const tipBefore = git(root, 'rev-parse', run.repos[0].integrationBranch);

    expect(await iso.integrate(t2, run)).toBe('conflict');

    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tipBefore);
    expect(git(root, 'show', `${run.repos[0].integrationBranch}:shared.txt`)).toBe('left');
    expect(worktreePaths(root)).toContain(b.cwd);
    expect(branches(root)).toContain(b.branch);
    expect(branches(root)).toContain(run.repos[0].integrationBranch);
    expect(run.tasks['task-2'].status).toBe('conflict');
    expect(run.tasks['task-2'].conflictRepo).toBe('.');
    expect(run.tasks['task-2'].conflictFiles).toEqual(['shared.txt']);
    // The runner's work is committed on its branch, ready to resolve by hand.
    expect(git(root, 'show', `${b.branch}:shared.txt`)).toBe('right');
    // No half-finished merge is left in the integration worktree.
    const integrationDir = join(root, '.ordewell', 'worktrees', run.id, 'integration');
    expect(git(integrationDir, 'status', '--porcelain')).toBe('');
  });

  it('keeps integrating other tasks after a conflict', async () => {
    const { root, iso, run, t1, t2 } = await conflicted();
    const t3 = task(3, 'Unrelated');
    const c = await iso.prepare(t3, run);
    writeFileSync(join(c.cwd, 'other.txt'), 'o\n');

    await iso.integrate(t1, run);
    expect(await iso.integrate(t2, run)).toBe('conflict');
    expect(await iso.integrate(t3, run)).toBe('merged');
    expect(git(root, 'show', `${run.repos[0].integrationBranch}:other.txt`)).toBe('o');
  });

  it('respects a repo-level .gitattributes union merge, landing two tasks that each append to CHANGELOG.md without a conflict', async () => {
    const root = repo({
      'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n',
      '.gitattributes': 'CHANGELOG.md merge=union\n',
    });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const [t1, t2] = [task(1, 'Left entry'), task(2, 'Right entry')];
    const a = await iso.prepare(t1, run);
    const b = await iso.prepare(t2, run);
    writeFileSync(join(a.cwd, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n- Left change\n');
    writeFileSync(join(b.cwd, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n- Right change\n');

    expect(await iso.integrate(t1, run)).toBe('merged');
    expect(await iso.integrate(t2, run)).toBe('merged');

    const changelog = git(root, 'show', `${run.repos[0].integrationBranch}:CHANGELOG.md`);
    expect(changelog).toContain('- Left change');
    expect(changelog).toContain('- Right change');
  });

  it('clears the recorded conflict files once the task lands after being resolved by hand', async () => {
    const { iso, run, t1, t2, b } = await conflicted();
    await iso.integrate(t1, run);
    expect(await iso.integrate(t2, run)).toBe('conflict');

    expect(() => git(b.cwd, 'merge', '--no-edit', run.repos[0].integrationBranch)).toThrow();
    writeFileSync(join(b.cwd, 'shared.txt'), 'resolved\n');
    git(b.cwd, 'add', 'shared.txt');
    git(b.cwd, 'commit', '-q', '--no-edit');

    expect(await iso.integrate(t2, run)).toBe('merged');
    expect(run.tasks['task-2'].conflictRepo).toBeUndefined();
    expect(run.tasks['task-2'].conflictFiles).toBeUndefined();
  });
});
describe.skipIf(!hasGit)('WorktreeIsolation.release', () => {
  it('keep: true preserves the worktree and branch for inspection', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd, branch } = await iso.prepare(task(1, 'Failed verdict'), run);
    writeFileSync(join(cwd, 'evidence.txt'), 'what the runner did\n');

    await iso.release(run, 'task-1', { keep: true });

    expect(worktreePaths(root)).toContain(cwd);
    expect(branches(root)).toContain(branch);
    expect(readFileSync(join(cwd, 'evidence.txt'), 'utf8')).toBe('what the runner did\n');
    expect(run.tasks['task-1'].status).toBe('kept');
  });

  it('keep: false removes the worktree, the branch and the record', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd, branch } = await iso.prepare(task(1, 'Cancelled'), run);

    await iso.release(run, 'task-1', { keep: false });

    expect(worktreePaths(root)).not.toContain(cwd);
    expect(existsSync(cwd)).toBe(false);
    expect(branches(root)).not.toContain(branch);
    expect(run.tasks['task-1']).toBeUndefined();
    expect(branches(root)).toContain(run.repos[0].integrationBranch);
  });

  it('releasing an unknown task is a no-op', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    await expect(iso.release(run, 'nope', { keep: false })).resolves.toEqual({ preserved: [], refused: [] });
  });

  it('leaves the record a newer start made while a release decided for the earlier one waited its turn', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Cancelled, then started again');
    await iso.prepare(t, run);
    const ended = run.tasks['task-1'];
    const restarting = iso.prepare(t, run);
    // The newer prepare takes the admin lock once its turn comes, so the release queues behind it.
    await flushMicrotasks(5);
    const releasing = iso.release(run, 'task-1', { keep: false, record: ended });
    const { cwd, branch } = await restarting;

    await expect(releasing).resolves.toEqual({ preserved: [], refused: [] });
    expect(run.tasks['task-1']).not.toBe(ended);
    expect(run.tasks['task-1'].status).toBe('active');
    expect(worktreePaths(root)).toContain(cwd);
    expect(branches(root)).toContain(branch);
  });

  it('a retry starts fresh from the current integration tip', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const [t1, t2] = [task(1, 'Predecessor'), task(2, 'Retried')];
    const first = await iso.prepare(t2, run);
    writeFileSync(join(first.cwd, 'stale.txt'), 'old attempt\n');
    await iso.release(run, 'task-2', { keep: true });

    const pred = await iso.prepare(t1, run);
    writeFileSync(join(pred.cwd, 'pred.txt'), 'landed\n');
    await iso.integrate(t1, run);

    const retry = await iso.prepare(t2, run);
    expect(retry.cwd).toBe(first.cwd);
    expect(existsSync(join(retry.cwd, 'stale.txt'))).toBe(false);
    expect(readFileSync(join(retry.cwd, 'pred.txt'), 'utf8')).toBe('landed\n');
    expect(run.tasks['task-2'].status).toBe('active');
  });
});
describe.skipIf(!hasGit)("WorktreeIsolation for a read-only task (ADR-0046)", () => {
  /** Real git, recording the directory each command ran in. */
  function recording(): { exec: GitExecFn; cwds: string[] } {
    const cwds: string[] = [];
    const exec: GitExecFn = async (file, args, opts) => {
      cwds.push(opts.cwd ?? '');
      const { stdout, stderr } = await execFileAsync(file, args, { cwd: opts.cwd, env: opts.env });
      return { stdout: String(stdout), stderr: String(stderr) };
    };
    return { exec, cwds };
  }

  it.each([true, false])('removes its worktree whole when released (keep: %s), and keeps nothing of it on a branch', async (keep) => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);
    const { cwd, branch } = await iso.prepare(task(1, 'Review'), run, 'fresh', { readOnly: true });
    expect(run.tasks['task-1'].readOnly).toBe(true);
    writeFileSync(join(cwd, 'tried-fix.ts'), 'export const fixed = true;\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'a fix it tried');
    writeFileSync(join(cwd, 'README.md'), 'edited, never committed\n');

    expect(await iso.release(run, 'task-1', { keep })).toEqual({ preserved: [], refused: [] });

    expect(existsSync(cwd)).toBe(false);
    expect(worktreePaths(root)).not.toContain(cwd);
    expect(branches(root)).not.toContain(branch);
    expect(branches(root, 'ordewell-preserved/*')).toEqual([]);
    expect(run.tasks['task-1']).toBeUndefined();
    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tip);
  });

  it.skipIf(process.platform !== 'darwin')('clears an immutable flag before removing its worktree, so the throwaway tree is not left behind (ADR-0046)', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Review'), run, 'fresh', { readOnly: true });
    // What a sealed run can leave: a .git under a directory it made immutable.
    const locked = join(cwd, 'locked');
    mkdirSync(join(locked, '.git'), { recursive: true });
    writeFileSync(join(locked, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    execFileSync('chflags', ['uchg', join(locked, '.git')]);
    try {
      expect(await iso.release(run, 'task-1', { keep: false })).toEqual({ preserved: [], refused: [] });
      expect(existsSync(cwd)).toBe(false);
    } finally {
      if (existsSync(join(locked, '.git'))) execFileSync('chflags', ['-R', 'nouchg', join(locked, '.git')]);
    }
  });

  it('never integrates what it changed', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);
    const t = task(1, 'Review');
    const { cwd } = await iso.prepare(t, run, 'fresh', { readOnly: true });
    writeFileSync(join(cwd, 'tried-fix.ts'), 'export const fixed = true;\n');

    expect(await iso.integrate(t, run)).toBe('failed');

    expect(run.tasks['task-1'].landingError).toBe('a read-only task lands nothing');
    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tip);
  });

  it('runs no git inside its worktree to remove it, so a .git file it rewrote leads nowhere', async () => {
    const root = repo();
    const { exec, cwds } = recording();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Review'), run, 'fresh', { readOnly: true });
    // What a sealed command could leave: a gitdir of its own, whose config runs a program for git.
    mkdirSync(join(cwd, 'fake-git'));
    writeFileSync(join(cwd, 'fake-git', 'config'), `[core]\n\tfsmonitor = touch ${join(root, 'ran-outside')}\n`);
    replaceGitFile(cwd, 'gitdir: fake-git\n');
    cwds.length = 0;

    await iso.release(run, 'task-1', { keep: false });

    expect(cwds.filter((dir) => dir === cwd || dir.startsWith(`${cwd}${sep}`))).toEqual([]);
    expect(existsSync(join(root, 'ran-outside'))).toBe(false);
    expect(existsSync(cwd)).toBe(false);
  });

  it("is removed whole by a crash-recovery prune, without being taken for another host's work", async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Review'), run, 'fresh', { readOnly: true });
    writeFileSync(join(cwd, 'tried-fix.ts'), 'export const fixed = true;\n');

    const pruned = await iso.pruneOrphans(run);

    expect(pruned.kept).toEqual([]);
    expect(pruned.preserved).toEqual([]);
    expect(existsSync(cwd)).toBe(false);
    expect(run.tasks['task-1']).toBeUndefined();
  });

  it('does not follow a link put in place of a directory on the way to a mirrored install', async () => {
    const root = repo({
      '.gitignore': 'node_modules/\n',
      'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
      'packages/b/package.json': '{"name":"b"}\n',
    });
    mkdirSync(join(root, 'packages', 'b', 'node_modules', 'only-b'), { recursive: true });
    const outside = realpath(mkdtempSync(join(tmpdir(), 'ordewell-wt-outside-')));
    roots.push(outside);
    mkdirSync(join(outside, 'b', 'node_modules'), { recursive: true });
    symlinkSync(join(root, 'README.md'), join(outside, 'b', 'node_modules', 'theirs'));
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Review'), run, 'fresh', { readOnly: true });
    expect(run.tasks['task-1'].repos['.'].linked).toContain('packages/b/node_modules');
    rmSync(join(cwd, 'packages'), { recursive: true, force: true });
    symlinkSync(outside, join(cwd, 'packages'));

    await iso.release(run, 'task-1', { keep: false });

    expect(lexists(join(outside, 'b', 'node_modules', 'theirs'))).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  });
});
describe.skipIf(!hasGit)('WorktreeIsolation never deletes work that has not landed', () => {
  const preserved = (root: string) => branches(root, 'ordewell-preserved/*');

  /** Real git, except that a rescue commit fails, as it does for a repository with no identity set. */
  const rescueFails: GitExecFn = async (file, args, opts) => {
    if (args.includes('--no-verify')) throw Object.assign(new Error('fatal: unable to auto-detect email address'), { stderr: 'fatal: unable to auto-detect email address', code: 128 });
    const { stdout, stderr } = await execFileAsync(file, args, { cwd: opts.cwd, env: opts.env });
    return { stdout: String(stdout), stderr: String(stderr) };
  };

  it('keeps a kept task\'s uncommitted edits on a branch of their own when Merge all clears the run up', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const landed = await iso.prepare(task(1, 'Landed'), run);
    writeFileSync(join(landed.cwd, 'landed.txt'), 'landed\n');
    expect(await iso.integrate(task(1, 'Landed'), run)).toBe('merged');
    const stopped = await iso.prepare(task(2, 'Stopped mid-work'), run);
    writeFileSync(join(stopped.cwd, 'half-done.txt'), 'not committed yet\n');
    writeFileSync(join(stopped.cwd, 'README.md'), 'edited\n');
    await iso.release(run, 'task-2', { keep: true });
    await iso.handoff(run);
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });

    const removal = await iso.discard(run, { integration: 'delete-merged' });

    const branch = `ordewell-preserved/${run.id}/2-stopped-mid-work`;
    expect(removal).toEqual({
      preserved: [{ task: { taskId: 'task-2', order: 2, title: 'Stopped mid-work' }, repo: '.', branch, commit: git(root, 'rev-parse', branch) }],
      refused: [],
    });
    expect(existsSync(stopped.cwd)).toBe(false);
    expect(git(root, 'show', `${branch}:half-done.txt`)).toBe('not committed yet');
    expect(git(root, 'show', `${branch}:README.md`)).toBe('edited');
    expect(git(root, 'log', '-1', '--format=%s', branch)).toBe('WIP: Stopped mid-work');
    expect(branches(root)).toEqual([]);
    // The state dir's own ignore file is meant to be committed (it carves out .ordewell/skills); nothing else may show.
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('?? .ordewell/.gitignore');
  });

  it('keeps the commits only a task branch carries, even once its worktree is gone', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd, branch } = await iso.prepare(task(1, 'Committed its work'), run);
    writeFileSync(join(cwd, 'work.txt'), 'committed\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'the agent committed');
    const tip = git(root, 'rev-parse', branch);
    git(root, 'worktree', 'remove', '--force', cwd);

    const removal = await iso.discard(run, { integration: 'delete' });

    expect(removal.preserved).toEqual([expect.objectContaining({ branch: `ordewell-preserved/${run.id}/1-committed-its-work`, commit: tip })]);
    expect(branches(root)).toEqual([]);
  });

  it('a rescue commit gets past a hook that refuses commits', async () => {
    const root = repo();
    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Hooked'), run);
    writeFileSync(join(cwd, 'edit.txt'), 'edit\n');

    const removal = await iso.release(run, 'task-1', { keep: false });

    expect(removal.preserved).toHaveLength(1);
    expect(git(root, 'show', `${removal.preserved[0].branch}:edit.txt`)).toBe('edit');
    expect(existsSync(cwd)).toBe(false);
  });

  it('keeps nothing for a worktree with no work of its own, linked artifacts and all', async () => {
    const root = repo();
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude', 'settings.local.json'), '{}\n');
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Untouched'), run);
    expect(lexists(join(cwd, '.claude'))).toBe(true);

    expect(await iso.release(run, 'task-1', { keep: false })).toEqual({ preserved: [], refused: [] });
    expect(preserved(root)).toEqual([]);
    expect(existsSync(cwd)).toBe(false);
  });

  it('refuses to remove a worktree whose edits it cannot keep, and keeps its record', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl: rescueFails });
    const run = await iso.startRun(root);
    const { cwd, branch } = await iso.prepare(task(1, 'Unsaveable'), run);
    writeFileSync(join(cwd, 'precious.txt'), 'only copy\n');

    const removal = await iso.discard(run, { integration: 'delete' });

    expect(removal.preserved).toEqual([]);
    expect(removal.refused).toEqual([{ task: { taskId: 'task-1', order: 1, title: 'Unsaveable' }, worktree: cwd, reason: expect.stringContaining('auto-detect email') }]);
    expect(readFileSync(join(cwd, 'precious.txt'), 'utf8')).toBe('only copy\n');
    expect(worktreePaths(root)).toContain(cwd);
    expect(branches(root)).toContain(branch);
    expect(Object.keys(run.tasks)).toEqual(['task-1']);
  });

  it('a release that cannot keep the work leaves the attempt kept, not active', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl: rescueFails });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Unsaveable'), run);
    writeFileSync(join(cwd, 'precious.txt'), 'only copy\n');

    const removal = await iso.release(run, 'task-1', { keep: false });

    expect(removal.refused).toHaveLength(1);
    expect(existsSync(join(cwd, 'precious.txt'))).toBe(true);
    expect(run.tasks['task-1'].status).toBe('kept');
  });

  it('a retry keeps what the attempt before it left uncommitted, and starts clean', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const first = await iso.prepare(task(1, 'Retried'), run);
    writeFileSync(join(first.cwd, 'first-try.txt'), 'first try\n');
    await iso.release(run, 'task-1', { keep: true });

    const retry = await iso.prepare(task(1, 'Retried'), run);

    expect(retry.preserved).toEqual([expect.objectContaining({ branch: `ordewell-preserved/${run.id}/1-retried` })]);
    expect(existsSync(join(retry.cwd, 'first-try.txt'))).toBe(false);
    expect(git(root, 'show', `ordewell-preserved/${run.id}/1-retried:first-try.txt`)).toBe('first try');
  });

  describe('when the user\'s git hides untracked files from status', () => {
    // `status.showUntrackedFiles=no` is a common setting for huge trees; work made only of new files must still read as work.
    it('a retry keeps an attempt whose only work is new files', async () => {
      const root = repo();
      git(root, 'config', 'status.showUntrackedFiles', 'no');
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(root);
      const first = await iso.prepare(task(1, 'Retried'), run);
      writeFileSync(join(first.cwd, 'feature.ts'), 'export const feature = 1;\n');
      await iso.release(run, 'task-1', { keep: true });

      const retry = await iso.prepare(task(1, 'Retried'), run);

      expect(retry.preserved).toEqual([expect.objectContaining({ branch: `ordewell-preserved/${run.id}/1-retried` })]);
      expect(git(root, 'show', `ordewell-preserved/${run.id}/1-retried:feature.ts`)).toBe('export const feature = 1;');
    });

    it('crash recovery keeps an active attempt whose only work is new files', async () => {
      const root = repo();
      git(root, 'config', 'status.showUntrackedFiles', 'no');
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(root);
      const { cwd } = await iso.prepare(task(1, 'Crashed'), run);
      writeFileSync(join(cwd, 'new.ts'), 'export const x = 1;\n');

      const result = await iso.pruneOrphans(JSON.parse(JSON.stringify(run)) as IsolationRun);

      expect(result.kept).toEqual([{ taskId: 'task-1', order: 1, title: 'Crashed' }]);
      expect(readFileSync(join(cwd, 'new.ts'), 'utf8')).toBe('export const x = 1;\n');
    });
  });

  it('a retry that cannot start still says where the last attempt\'s work was kept', async () => {
    const root = repo();
    let refusing = false;
    const [real, refuse] = [refuseWorktreesIn(), refuseWorktreesIn(root)];
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl: (file, args, opts) => (refusing ? refuse : real)(file, args, opts) });
    const run = await iso.startRun(root);
    const first = await iso.prepare(task(1, 'Retried'), run);
    writeFileSync(join(first.cwd, 'kept-work.txt'), 'work\n');
    await iso.release(run, 'task-1', { keep: true });

    refusing = true;
    const failure = await iso.prepare(task(1, 'Retried'), run).then(() => null, (err: unknown) => err);

    const branch = `ordewell-preserved/${run.id}/1-retried`;
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ message: expect.stringContaining('git worktree failed'), preserved: [expect.objectContaining({ repo: '.', branch })] });
    expect(git(root, 'show', `${branch}:kept-work.txt`)).toBe('work');
    expect(run.tasks).toEqual({});
  });

  it('a retry whose last attempt it cannot keep does not start over it', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl: rescueFails });
    const run = await iso.startRun(root);
    const first = await iso.prepare(task(1, 'Retried'), run);
    writeFileSync(join(first.cwd, 'first-try.txt'), 'first try\n');

    await expect(iso.prepare(task(1, 'Retried'), run)).rejects.toThrow(/could not keep/);
    expect(readFileSync(join(first.cwd, 'first-try.txt'), 'utf8')).toBe('first try\n');
  });

  describe('a registration no record holds', () => {
    it('prepare succeeds after the directory of the last attempt was deleted and its registration left', async () => {
      const root = repo();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(root);
      const first = await iso.prepare(task(1, 'Retried'), run);
      rmSync(first.cwd, { recursive: true, force: true });
      run.tasks = {};

      const retry = await iso.prepare(task(1, 'Retried'), run);

      expect(retry.cwd).toBe(first.cwd);
      expect(git(retry.cwd, 'branch', '--show-current')).toBe(first.branch);
      expect(worktreePaths(root).sort()).toEqual([root, retry.cwd].sort());
    });

    it('prepare keeps the uncommitted work of a leftover at the task\'s own path, then starts over it', async () => {
      const root = repo();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(root);
      const first = await iso.prepare(task(1, 'Retried'), run);
      writeFileSync(join(first.cwd, 'half-done.txt'), 'half\n');
      run.tasks = {};

      const retry = await iso.prepare(task(1, 'Retried'), run);

      const kept = `ordewell-preserved/${run.id}/1-retried`;
      expect(retry.preserved).toEqual([expect.objectContaining({ repo: '.', branch: kept })]);
      expect(git(root, 'show', `${kept}:half-done.txt`)).toBe('half');
      expect(existsSync(join(retry.cwd, 'half-done.txt'))).toBe(false);
      expect(run.tasks['task-1'].workspace).toBe(retry.cwd);
    });

    it('prepare refuses, and removes nothing, when the leftover\'s work cannot be kept', async () => {
      const root = repo();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl: rescueFails });
      const run = await iso.startRun(root);
      const first = await iso.prepare(task(1, 'Retried'), run);
      writeFileSync(join(first.cwd, 'first-try.txt'), 'first try\n');
      run.tasks = {};

      await expect(iso.prepare(task(1, 'Retried'), run)).rejects.toThrow(/could not keep/);
      expect(readFileSync(join(first.cwd, 'first-try.txt'), 'utf8')).toBe('first try\n');
    });

    it('prepare never removes a worktree another live record of the run holds', async () => {
      const root = repo();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(root);
      const held = await iso.prepare(task(1, 'Held'), run);
      writeFileSync(join(held.cwd, 'in-flight.txt'), 'running\n');
      // A record that names the path a retry of task 1 would use, under another branch.
      run.tasks = { other: { ...run.tasks['task-1'], taskId: 'other', branch: `ordewell/${run.id}/elsewhere` } };

      await expect(iso.prepare(task(1, 'Held'), run)).rejects.toThrow();
      expect(readFileSync(join(held.cwd, 'in-flight.txt'), 'utf8')).toBe('running\n');
      expect(branches(root)).toContain(held.branch);
    });

    it('pruneOrphans drops a registration whose directory is gone, with its branch', async () => {
      const root = repo();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(root);
      const first = await iso.prepare(task(1, 'Crashed'), run);
      rmSync(first.cwd, { recursive: true, force: true });
      run.tasks = {};

      await iso.pruneOrphans(run);

      expect(worktreePaths(root)).toEqual([root]);
      expect(branches(root)).toEqual([`ordewell/${run.id}/integration`]);
    });
  });

  it('never overwrites a branch kept earlier: a second keep for the same task gets its own', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    for (const attempt of ['one', 'two']) {
      const { cwd } = await iso.prepare(task(1, 'Twice'), run);
      writeFileSync(join(cwd, 'attempt.txt'), `${attempt}\n`);
      await iso.release(run, 'task-1', { keep: false });
    }

    expect(preserved(root)).toEqual([`ordewell-preserved/${run.id}/1-twice`, `ordewell-preserved/${run.id}/1-twice-2`]);
    expect(git(root, 'show', `ordewell-preserved/${run.id}/1-twice:attempt.txt`)).toBe('one');
    expect(git(root, 'show', `ordewell-preserved/${run.id}/1-twice-2:attempt.txt`)).toBe('two');
  });

  it('crash recovery keeps the edits of a task workspace no record owns before sweeping it', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Record lost'), run);
    writeFileSync(join(cwd, 'unsaved.txt'), 'the runner wrote this\n');
    delete run.tasks['task-1'];

    const result = await iso.pruneOrphans(run);

    expect(result.preserved).toEqual([{ repo: '.', branch: `ordewell-preserved/${run.id}/1-record-lost`, commit: expect.any(String) }]);
    expect(existsSync(cwd)).toBe(false);
    expect(git(root, 'show', `ordewell-preserved/${run.id}/1-record-lost:unsaved.txt`)).toBe('the runner wrote this');
  });
});
