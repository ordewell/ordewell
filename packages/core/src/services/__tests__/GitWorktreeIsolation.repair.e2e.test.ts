// Part of GitWorktreeIsolation: split by describe so CI's shards (vitest splits by file) balance. Helpers: gitWorktreeIsolationKit.ts

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { type GitExecFn } from '../GitWorktreeIsolation';
import { fakeConfig, removeDir } from '../../testing';
import { landingMessage, messageArgs } from '../landingMessage';
import { realpath, hasGit, create, git, initRepo, task, worktreePaths, replaceGitFile, linksTo, lexists, branches, execFileAsync, subcommand, roots, setupCommand, repo } from './gitWorktreeIsolationKit';

afterEach(async () => {
  while (roots.length) await removeDir(roots.pop()!);
});

describe.skipIf(!hasGit)('WorktreeIsolation conflict repair', () => {
  /** Task 1 landed `left`; task 2, cut beside it, wrote `right` and conflicted. */
  async function conflicted() {
    const root = repo({ 'shared.txt': 'base\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const [t1, t2] = [task(1, 'Left'), task(2, 'Right')];
    const a = await iso.prepare(t1, run);
    const b = await iso.prepare(t2, run);
    writeFileSync(join(a.cwd, 'shared.txt'), 'left\n');
    writeFileSync(join(b.cwd, 'shared.txt'), 'right\n');
    expect(await iso.integrate(t1, run)).toBe('merged');
    expect(await iso.integrate(t2, run)).toBe('conflict');
    const integration = run.repos[0].integrationBranch;
    return { root, iso, run, t2, b, integration, tip: git(root, 'rev-parse', integration) };
  }

  it('reopens the kept worktree at the same cwd, recording the tip it starts from and counting the repair', async () => {
    const { root, iso, run, t2, b, tip } = await conflicted();
    const committed = git(root, 'rev-parse', b.branch);

    const reopened = await iso.reopen(t2, run);

    expect(reopened).toEqual({ cwd: b.cwd, branch: b.branch, copied: [] });
    expect(worktreePaths(root)).toContain(b.cwd);
    expect(git(root, 'rev-parse', b.branch)).toBe(committed);
    expect(run.tasks['task-2']).toMatchObject({
      status: 'repairing', repairs: 1, repairBase: { '.': tip }, repairedFiles: ['shared.txt'], conflictFiles: ['shared.txt'],
    });
  });

  /** What a repair's agent does when it gets it right: merge the tip in and resolve so both sides survive. */
  function mergeAndResolve(cwd: string, integration: string, resolved = 'left and right\n'): void {
    expect(() => git(cwd, 'merge', '--no-edit', integration)).toThrow();
    writeFileSync(join(cwd, 'shared.txt'), resolved);
    git(cwd, 'add', 'shared.txt');
    git(cwd, 'commit', '-q', '--no-edit');
  }

  it('accepts a repair whose branch now contains the tip it started from', async () => {
    const { iso, run, t2, b, integration } = await conflicted();
    await iso.reopen(t2, run);

    mergeAndResolve(b.cwd, integration);

    expect(await iso.verifyRepair(t2, run)).toEqual({ ok: true });
  });

  it('refuses a repair that never merged the tip in, however its files read', async () => {
    const { iso, run, t2, b } = await conflicted();
    await iso.reopen(t2, run);

    writeFileSync(join(b.cwd, 'shared.txt'), 'left and right\n');

    expect(await iso.verifyRepair(t2, run)).toEqual({ ok: false, reason: 'not-merged', repo: '.' });
  });

  it('refuses a repair that merged the tip in but left the conflict markers, even uncommitted', async () => {
    const { iso, run, t2, b, integration } = await conflicted();
    await iso.reopen(t2, run);

    expect(() => git(b.cwd, 'merge', '--no-edit', integration)).toThrow();

    expect(await iso.verifyRepair(t2, run)).toEqual({ ok: false, reason: 'conflict-markers', repo: '.', files: ['shared.txt'] });
  });

  it('does not count whitespace warnings as leftover markers', async () => {
    const { iso, run, t2, b, integration } = await conflicted();
    await iso.reopen(t2, run);

    mergeAndResolve(b.cwd, integration, 'left and right   \n');

    expect(await iso.verifyRepair(t2, run)).toEqual({ ok: true });
  });

  it('lands a repair with the commit the conflicted landing stated, though the repair states none', async () => {
    const root = repo({ 'shared.txt': 'base\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const [t1, t2] = [task(1, 'Left'), task(2, 'Right')];
    const a = await iso.prepare(t1, run);
    const b = await iso.prepare(t2, run);
    writeFileSync(join(a.cwd, 'shared.txt'), 'left\n');
    writeFileSync(join(b.cwd, 'shared.txt'), 'right\n');
    expect(await iso.integrate(t1, run)).toBe('merged');
    expect(await iso.integrate(t2, run, undefined, { subject: 'Say right', body: 'Left was wrong.' })).toBe('conflict');
    const integration = run.repos[0].integrationBranch;

    await iso.reopen(t2, run);
    mergeAndResolve(b.cwd, integration);
    writeFileSync(join(b.cwd, 'note.txt'), 'left over\n');
    expect(await iso.verifyRepair(t2, run)).toEqual({ ok: true });
    expect(await iso.integrate(t2, run)).toBe('merged');

    expect(git(root, 'log', '-1', '--format=%B', integration)).toBe('Merge: Say right\n\nLeft was wrong.');
    expect(git(root, 'log', '-1', '--format=%B', `${integration}^2`)).toBe('Say right\n\nLeft was wrong.');
  });

  it('names the rescue and the restore of a conflicted task\'s kept work for the commit its landing stated, not its title', async () => {
    const root = repo({ 'shared.txt': 'base\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const [t1, t2] = [task(1, 'Left'), task(2, 'Right')];
    const a = await iso.prepare(t1, run);
    const b = await iso.prepare(t2, run);
    writeFileSync(join(a.cwd, 'shared.txt'), 'left\n');
    writeFileSync(join(b.cwd, 'shared.txt'), 'right\n');
    expect(await iso.integrate(t1, run)).toBe('merged');
    expect(await iso.integrate(t2, run, undefined, { subject: 'Say right', body: 'Left was wrong.' })).toBe('conflict');
    const integration = run.repos[0].integrationBranch;
    await iso.reopen(t2, run);
    mergeAndResolve(b.cwd, integration);
    writeFileSync(join(b.cwd, 'note.txt'), 'not committed yet\n');
    // Moves the tip, so the kept work comes back with a merge, not a fast-forward.
    const t3 = task(3, 'Elsewhere');
    const c = await iso.prepare(t3, run);
    writeFileSync(join(c.cwd, 'other.txt'), 'other\n');
    expect(await iso.integrate(t3, run)).toBe('merged');

    const again = await iso.prepare(t2, run, 'restore');

    expect(again.restoration).toBe('restored');
    expect(readFileSync(join(again.cwd, 'note.txt'), 'utf8')).toBe('not committed yet\n');
    expect(git(root, 'log', '-1', '--format=%s', again.preserved![0].commit)).toBe('WIP: Say right');
    expect(git(again.cwd, 'log', '-1', '--format=%s')).toBe('Merge: Say right (resume its kept work)');
    expect(await iso.integrate(t2, run)).toBe('merged');
    expect(git(root, 'log', '-1', '--format=%B', integration)).toBe('Merge: Say right\n\nLeft was wrong.');
  });

  it('leaves no internal branch name in history when the repair merges with the message its prompt gives', async () => {
    const { root, iso, run, t2, b, integration } = await conflicted();
    await iso.reopen(t2, run);

    const message = landingMessage('repair-merge', run.tasks['task-2']);
    expect(() => git(b.cwd, 'merge', '--no-edit', ...messageArgs(message), integration)).toThrow();
    writeFileSync(join(b.cwd, 'shared.txt'), 'left and right\n');
    git(b.cwd, 'add', 'shared.txt');
    git(b.cwd, 'commit', '-q', '--no-edit', '--cleanup=strip');
    expect(await iso.verifyRepair(t2, run)).toEqual({ ok: true });
    expect(await iso.integrate(t2, run)).toBe('merged');

    expect(git(root, 'log', '-1', '--format=%B', `${integration}^2`)).toBe('Merge: Right (resolve conflicts with integration)');
    const subjects = git(root, 'log', '--format=%s', integration).split('\n');
    expect(subjects).toContain('Merge: Right (resolve conflicts with integration)');
    expect(subjects.filter((s) => s.includes('ordewell/'))).toEqual([]);
  });

  it('lands a repaired branch cleanly, with one merge on the tip, keeping what the repair did on the record', async () => {
    const { root, iso, run, t2, b, integration, tip } = await conflicted();
    await iso.reopen(t2, run);
    mergeAndResolve(b.cwd, integration);
    expect(await iso.verifyRepair(t2, run)).toEqual({ ok: true });

    expect(await iso.integrate(t2, run)).toBe('merged');

    expect(git(root, 'show', `${integration}:shared.txt`)).toBe('left and right');
    expect(git(root, 'rev-parse', `${integration}^1`)).toBe(tip);
    expect(git(root, 'log', '-1', '--format=%s', integration)).toBe('Merge: Right');
    const record = run.tasks['task-2'];
    expect(record).toMatchObject({ status: 'merged', repairs: 1, repairedFiles: ['shared.txt'] });
    expect(record.repairBase).toBeUndefined();
    expect(record.conflictFiles).toBeUndefined();
  });

  it('is a fresh conflict, not a repair, when the tip moved again under the repaired branch', async () => {
    const { root, iso, run, t2, b, integration } = await conflicted();
    await iso.reopen(t2, run);
    mergeAndResolve(b.cwd, integration);
    expect(await iso.verifyRepair(t2, run)).toEqual({ ok: true });
    const t3 = task(3, 'Later');
    const c = await iso.prepare(t3, run);
    writeFileSync(join(c.cwd, 'shared.txt'), 'later\n');
    expect(await iso.integrate(t3, run)).toBe('merged');
    const tipBefore = git(root, 'rev-parse', integration);

    expect(await iso.integrate(t2, run)).toBe('conflict');

    expect(git(root, 'rev-parse', integration)).toBe(tipBefore);
    expect(run.tasks['task-2']).toMatchObject({ status: 'conflict', repairs: 1, conflictFiles: ['shared.txt'] });
    expect(run.tasks['task-2'].repairBase).toBeUndefined();
    expect((await iso.reopen(t2, run)).cwd).toBe(b.cwd);
    expect(run.tasks['task-2']).toMatchObject({ status: 'repairing', repairs: 2, repairBase: { '.': tipBefore } });
  });

  it('leaves the task conflicted as it was when a repair is released or a crash interrupted it', async () => {
    const { iso, run, t2, b } = await conflicted();
    await iso.reopen(t2, run);

    await iso.release(run, 'task-2', { keep: true });

    expect(run.tasks['task-2']).toMatchObject({ status: 'conflict', repairs: 1, conflictFiles: ['shared.txt'] });
    expect(run.tasks['task-2'].repairBase).toBeUndefined();

    await iso.reopen(t2, run);
    await iso.pruneOrphans(run);

    expect(run.tasks['task-2']).toMatchObject({ status: 'conflict', repairs: 2 });
    expect(run.tasks['task-2'].repairBase).toBeUndefined();
    expect(existsSync(b.cwd)).toBe(true);
  });

  it('refuses to reopen a task that has no conflict', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t1 = task(1, 'Running');
    await iso.prepare(t1, run);

    await expect(iso.reopen(t1, run)).rejects.toThrow(/no conflict/);
    expect(run.tasks['task-1'].status).toBe('active');
  });
});
describe.skipIf(!hasGit)('WorktreeIsolation bootstrap', () => {
  function repoWithLocalState(): string {
    const root = repo({ '.gitignore': 'node_modules/\n.env\n.venv/\n.claude/\n', 'README.md': 'hi\n', '.env.example': 'KEY=\n' });
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    mkdirSync(join(root, '.venv'));
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude', 'settings.local.json'), '{}\n');
    writeFileSync(join(root, '.env'), 'SECRET=1\n');
    writeFileSync(join(root, '.envrc'), 'use flake\n');
    mkdirSync(join(root, '.ordewell', 'sessions'), { recursive: true });
    writeFileSync(join(root, '.ordewell', 'sessions', 's.json'), '{}');
    return root;
  }

  it('links ignored artifacts from the main worktree and never links .ordewell', async () => {
    const root = repoWithLocalState();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Bootstrap'), run);

    for (const name of ['.venv', '.claude', '.env', '.envrc']) expect(linksTo(join(cwd, name), join(root, name)), name).toBe(true);
    // node_modules is a real directory whose entries are linked one by one.
    expect(lstatSync(join(cwd, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(realpath(join(cwd, 'node_modules', 'left-pad'))).toBe(join(root, 'node_modules', 'left-pad'));
    expect(readFileSync(join(cwd, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(existsSync(join(cwd, '.ordewell'))).toBe(false);
    // A tracked file is checked out for real, not replaced by a link.
    expect(lstatSync(join(cwd, '.env.example')).isSymbolicLink()).toBe(false);
  });

  it('leaves what a link leads to when it removes the worktree of a workspace below the repository top', async () => {
    const root = repo({ 'sub/file.txt': 'x\n', 'sub/.gitignore': '.claude/\n' });
    const workspace = join(root, 'sub');
    mkdirSync(join(workspace, '.claude'));
    writeFileSync(join(workspace, '.claude', 'settings.local.json'), '{}\n');
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(workspace);
    const { cwd } = await iso.prepare(task(1, 'Below the top'), run);
    expect(linksTo(join(cwd, '.claude'), join(workspace, '.claude'))).toBe(true);

    await iso.release(run, 'task-1', { keep: false });

    expect(existsSync(cwd)).toBe(false);
    expect(readFileSync(join(workspace, '.claude', 'settings.local.json'), 'utf8')).toBe('{}\n');
  });

  // A junction, which Windows makes with no privilege, is a directory to Git for
  // Windows: its removal walked into one, and a rescue commit staged what it held.
  it('neither empties nor keeps a folder of the user\'s a task left a link to', async () => {
    const root = repo();
    const theirs = realpath(mkdtempSync(join(tmpdir(), 'ordewell-wt-theirs-')));
    roots.push(theirs);
    writeFileSync(join(theirs, 'notes.md'), 'precious\n');
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Plants a link'), run);
    mkdirSync(join(cwd, 'refs'));
    symlinkSync(theirs, join(cwd, 'refs', 'notes'), 'junction');
    writeFileSync(join(cwd, 'work.txt'), 'never landed\n');

    const removal = await iso.release(run, 'task-1', { keep: false });

    expect(existsSync(cwd)).toBe(false);
    expect(readFileSync(join(theirs, 'notes.md'), 'utf8')).toBe('precious\n');
    const kept = git(root, 'ls-tree', '-r', '--name-only', removal.preserved[0].branch).split('\n');
    expect(kept).toContain('work.txt');
    expect(kept).not.toContain('refs/notes/notes.md');
  });

  it('keeps a symbolic link a task made in what it saves, as git stores a link', async (ctx) => {
    const root = repo({ 'docs/guide.md': 'guide\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Links a guide'), run);
    try {
      symlinkSync(join('docs', 'guide.md'), join(cwd, 'GUIDE.md'), 'file');
    } catch {
      // Windows makes a symbolic link only with Developer Mode or as an administrator.
      ctx.skip();
    }
    writeFileSync(join(cwd, 'work.txt'), 'never landed\n');

    const removal = await iso.release(run, 'task-1', { keep: false });

    const kept = git(root, 'ls-tree', '-r', '--name-only', removal.preserved[0].branch).split('\n');
    expect(kept).toEqual(expect.arrayContaining(['GUIDE.md', 'work.txt']));
  });

  it('skips artifacts that are not present in the main worktree', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Bare'), run);
    expect(existsSync(join(cwd, 'node_modules'))).toBe(false);
    expect(existsSync(join(cwd, '.claude'))).toBe(false);
  });

  it('does not commit the links, even where an ignore rule would not match a symlink', async () => {
    const root = repoWithLocalState();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Links stay out');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'feature.txt'), 'f\n');

    expect(await iso.integrate(t, run)).toBe('merged');
    const tree = git(root, 'ls-tree', '-r', '--name-only', run.repos[0].integrationBranch).split('\n');
    expect(tree).toContain('feature.txt');
    // `.claude/` is a directory-only rule, so it would not match the symlink
    // a task worktree gets: the landing commit must exclude it by name.
    expect(tree.some((f) => f.startsWith('node_modules') || f.startsWith('.venv') || f === '.envrc' || f === '.env' || f === '.claude')).toBe(false);
    expect(tree.some((f) => f.startsWith('.ordewell'))).toBe(false);
  });

  it('removing a worktree leaves the linked directories in the main tree intact', async () => {
    const root = repoWithLocalState();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    await iso.prepare(task(1, 'Cancel'), run);
    await iso.release(run, 'task-1', { keep: false });
    expect(readFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8')).toBe('{}\n');
  });

  it('on Windows uses junctions for directories and copies for files, needing no symlink privilege', async () => {
    const root = repoWithLocalState();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }), platform: 'win32' });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Windows'), run);

    expect(lstatSync(join(cwd, 'node_modules', 'left-pad')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(cwd, '.env')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(cwd, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(lstatSync(join(cwd, '.envrc')).isSymbolicLink()).toBe(false);
  });

  it('keeps copied files out of the commit on Windows', async () => {
    const root = repoWithLocalState();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }), platform: 'win32' });
    const run = await iso.startRun(root);
    const t = task(1, 'Copies stay out');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'feature.txt'), 'f\n');
    await iso.integrate(t, run);
    const tree = git(root, 'ls-tree', '-r', '--name-only', run.repos[0].integrationBranch).split('\n');
    expect(tree).not.toContain('.envrc');
  });

  it('runs the configured setup command instead of linking', async () => {
    const root = repoWithLocalState();
    const iso = create({ config: fakeConfig({ worktreeSetupCommand: 'echo ready > setup-ran.txt' }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Setup'), run);

    expect(readFileSync(join(cwd, 'setup-ran.txt'), 'utf8').trim()).toBe('ready');
    expect(existsSync(join(cwd, 'node_modules'))).toBe(false);
    expect(existsSync(join(cwd, '.env'))).toBe(false);
  });

  it('a failing setup command falls back to the default links, wiping what it left half-done', async () => {
    const root = repoWithLocalState();
    const iso = create({ config: fakeConfig({ worktreeSetupCommand: setupCommand("const fs = require('fs'); fs.mkdirSync('node_modules/half', { recursive: true }); fs.appendFileSync('README.md', 'x\\n'); process.exit(3);") }) });
    const run = await iso.startRun(root);
    const { cwd, setupFailed } = await iso.prepare(task(1, 'Broken setup'), run);

    expect(setupFailed).toEqual([{ repo: '.', detail: expect.stringContaining('Command failed') }]);
    expect(existsSync(join(cwd, 'node_modules', 'half'))).toBe(false);
    expect(existsSync(join(cwd, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    expect(existsSync(join(cwd, '.env'))).toBe(true);
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe('hi\n');
    expect(run.tasks['task-1'].status).toBe('active');
  });
});
describe.skipIf(!hasGit)('WorktreeIsolation bootstrap of a workspace install', () => {
  // An npm workspace installed in the main checkout: a real dependency, a
  // workspace link to packages/a, a bin link, and packages/b's own node_modules.
  function installedWorkspace(ignore: string): string {
    const root = repo({
      '.gitignore': ignore,
      'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
      'packages/a/package.json': '{"name":"@scope/a"}\n',
      'packages/a/index.js': "module.exports = 'a';\n",
      'packages/b/package.json': '{"name":"b"}\n',
    });
    mkdirSync(join(root, 'node_modules', 'left-pad', 'bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(root, 'node_modules', 'left-pad', 'bin', 'pad'), '#!/bin/sh\necho padded\n', { mode: 0o755 });
    mkdirSync(join(root, 'node_modules', '@scope'));
    symlinkSync('../../packages/a', join(root, 'node_modules', '@scope', 'a'));
    mkdirSync(join(root, 'node_modules', '.bin'));
    symlinkSync('../left-pad/bin/pad', join(root, 'node_modules', '.bin', 'pad'));
    mkdirSync(join(root, 'packages', 'b', 'node_modules', 'only-b'), { recursive: true });
    writeFileSync(join(root, 'packages', 'b', 'node_modules', 'only-b', 'index.js'), 'module.exports = 2;\n');
    return root;
  }

  it('resolves a workspace package to the worktree’s own code and dependencies to the main install', async () => {
    const root = installedWorkspace('node_modules/\n');
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Change a'), run);

    expect(realpath(join(cwd, 'node_modules', '@scope', 'a'))).toBe(join(cwd, 'packages', 'a'));
    expect(realpath(join(cwd, 'node_modules', 'left-pad'))).toBe(join(root, 'node_modules', 'left-pad'));
    // Windows starts no `#!` script by itself, so there the link is read for the main install's script.
    if (process.platform === 'win32') expect(readFileSync(join(cwd, 'node_modules', '.bin', 'pad'), 'utf8')).toBe('#!/bin/sh\necho padded\n');
    else expect(execFileSync(join(cwd, 'node_modules', '.bin', 'pad'), { encoding: 'utf8' })).toBe('padded\n');
    expect(realpath(join(cwd, 'packages', 'b', 'node_modules', 'only-b'))).toBe(join(root, 'packages', 'b', 'node_modules', 'only-b'));
    expect(existsSync(join(cwd, 'packages', 'a', 'node_modules'))).toBe(false);
    expect(git(cwd, 'status', '--porcelain')).toBe('');
  });

  it.each([
    ['ignored', 'node_modules/\n'],
    ['not ignored', 'dist/\n'],
  ])('keeps the mirrored install out of the task commit when node_modules is %s', async (_, ignore) => {
    const root = installedWorkspace(ignore);
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Edit a');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'packages', 'a', 'index.js'), "module.exports = 'a2';\n");

    expect(await iso.integrate(t, run)).toBe('merged');
    const tree = git(root, 'ls-tree', '-r', '--name-only', run.repos[0].integrationBranch).split('\n');
    expect(tree).toContain('packages/a/index.js');
    expect(tree.filter((f) => f.split('/').includes('node_modules'))).toEqual([]);
  });

  it('removing the worktree leaves the main install intact, links and all', async () => {
    const root = installedWorkspace('node_modules/\n');
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Cancel'), run);
    await iso.release(run, 'task-1', { keep: false });

    expect(existsSync(cwd)).toBe(false);
    expect(readFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(realpath(join(root, 'node_modules', '@scope', 'a'))).toBe(join(root, 'packages', 'a'));
    expect(readFileSync(join(root, 'node_modules', '.bin', 'pad'), 'utf8')).toBe('#!/bin/sh\necho padded\n');
    expect(readFileSync(join(root, 'packages', 'b', 'node_modules', 'only-b', 'index.js'), 'utf8')).toBe('module.exports = 2;\n');
    expect(readFileSync(join(root, 'packages', 'a', 'index.js'), 'utf8')).toBe("module.exports = 'a';\n");
  });

  it('crash recovery sweeps a worktree no record owns without touching the main install', async () => {
    const root = installedWorkspace('node_modules/\n');
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Crashed'), run);
    delete run.tasks['task-1'];
    await iso.pruneOrphans(run);

    expect(existsSync(cwd)).toBe(false);
    expect(realpath(join(root, 'node_modules', '@scope', 'a'))).toBe(join(root, 'packages', 'a'));
    expect(readFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(readFileSync(join(root, 'packages', 'b', 'node_modules', 'only-b', 'index.js'), 'utf8')).toBe('module.exports = 2;\n');
    expect(readFileSync(join(root, 'packages', 'a', 'index.js'), 'utf8')).toBe("module.exports = 'a';\n");
  });

  it('with a setup command links nothing by default', async () => {
    const root = installedWorkspace('node_modules/\n');
    const iso = create({ config: fakeConfig({ worktreeSetupCommand: 'exit 0' }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Setup'), run);
    expect(lexists(join(cwd, 'node_modules'))).toBe(false);
    expect(lexists(join(cwd, 'packages', 'b', 'node_modules'))).toBe(false);
  });
});
describe.skipIf(!hasGit)('WorktreeIsolation.pruneOrphans', () => {
  it('drops stale active worktrees and unowned leftovers, keeps what the user may want to inspect', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const crashed = await iso.prepare(task(1, 'Was running'), run);
    const kept = await iso.prepare(task(2, 'Failed verdict'), run);
    await iso.release(run, 'task-2', { keep: true });
    const conflicted = await iso.prepare(task(3, 'Conflicted'), run);
    run.tasks['task-3'].status = 'conflict';
    // A crash between `worktree add` and the record being persisted.
    const strayDir = join(root, '.ordewell', 'worktrees', run.id, '9-stray');
    git(root, 'worktree', 'add', '-q', '-b', `ordewell/${run.id}/9-stray`, strayDir, run.repos[0].integrationBranch);

    const result = await iso.pruneOrphans(run);

    const listed = worktreePaths(root);
    expect(listed).not.toContain(crashed.cwd);
    expect(listed).not.toContain(strayDir);
    expect(listed).toContain(kept.cwd);
    expect(listed).toContain(conflicted.cwd);
    expect(branches(root).sort()).toEqual([run.repos[0].integrationBranch, kept.branch, conflicted.branch].sort());
    expect(run.tasks['task-1']).toBeUndefined();
    expect(Object.keys(run.tasks).sort()).toEqual(['task-2', 'task-3']);
    expect(result.kept).toEqual([]);
  });

  // A second host may adopt the same plan while this one's runner is still
  // working. Pruning an `active` record as an orphan took the runner's commits
  // with it; an attempt that still holds unlanded work is kept instead.
  it('keeps an active worktree whose branch holds commits the integration branch does not', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd, branch } = await iso.prepare(task(1, 'Committed work'), run);
    writeFileSync(join(cwd, 'work.txt'), 'precious\n');
    git(cwd, 'add', 'work.txt');
    git(cwd, 'commit', '-q', '-m', 'the runner committed');
    const tip = git(root, 'rev-parse', branch);

    const result = await iso.pruneOrphans(run);

    expect(existsSync(join(cwd, 'work.txt'))).toBe(true);
    expect(branches(root)).toContain(branch);
    expect(git(root, 'rev-parse', branch)).toBe(tip);
    expect(run.tasks['task-1'].status).toBe('kept');
    expect(result.kept).toEqual([{ taskId: 'task-1', order: 1, title: 'Committed work' }]);
  });

  it('keeps an active worktree holding edits the runner had not committed yet', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd, branch } = await iso.prepare(task(1, 'Uncommitted work'), run);
    writeFileSync(join(cwd, 'loose.txt'), 'still here\n');

    const result = await iso.pruneOrphans(run);

    expect(readFileSync(join(cwd, 'loose.txt'), 'utf8')).toBe('still here\n');
    expect(branches(root)).toContain(branch);
    expect(run.tasks['task-1'].status).toBe('kept');
    expect(result.kept.map((k) => k.taskId)).toEqual(['task-1']);
  });

  it('does not mistake bootstrapped links for unlanded work', async () => {
    const root = repo({ '.gitignore': 'node_modules/\n' });
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(root, '.envrc'), 'use flake\n');
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Bootstrap only'), run);
    expect(linksTo(join(cwd, '.envrc'), join(root, '.envrc'))).toBe(true);

    const result = await iso.pruneOrphans(run);

    expect(existsSync(cwd)).toBe(false);
    expect(run.tasks['task-1']).toBeUndefined();
    expect(result.kept).toEqual([]);
  });

  it('forgets a worktree whose directory was deleted out from under git', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const { cwd } = await iso.prepare(task(1, 'Vanished'), run);
    await iso.release(run, 'task-1', { keep: true });
    rmSync(cwd, { recursive: true, force: true });

    await iso.pruneOrphans(run);
    expect(worktreePaths(root)).toEqual([root]);
  });

  it('only touches its own run', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const other = await iso.startRun(root);
    const mine = await iso.startRun(root);
    const theirs = await iso.prepare(task(1, 'Other run'), other);
    await iso.prepare(task(1, 'My run'), mine);

    await iso.pruneOrphans(mine);
    expect(worktreePaths(root)).toContain(theirs.cwd);
    expect(branches(root)).toContain(theirs.branch);
  });
});
describe.skipIf(!hasGit)('WorktreeIsolation for merge gates and ops tasks (ADR-0020)', () => {
  async function landedOne(root: string) {
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Add alpha');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'alpha.txt'), 'alpha\n');
    expect(await iso.integrate(t, run)).toBe('merged');
    return { iso, run };
  }

  it('records the integration tip each task landed at', async () => {
    const root = repo();
    const { run } = await landedOne(root);
    expect(run.tasks['task-1'].repos['.'].landedTip).toBe(git(root, 'rev-parse', run.repos[0].integrationBranch));
  });

  it('finds landed work in HEAD only once the user has merged it, mid-run included', async () => {
    const root = repo();
    const { iso, run } = await landedOne(root);
    expect(await iso.findInHead(run)).toEqual([]);

    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });

    expect(await iso.findInHead(run)).toEqual(['task-1']);
    expect(run.tasks['task-1'].inHead).toBe(true);
    expect(await iso.findInHead(run)).toEqual([]);
    // A later task still lands on the integration branch the merge left in place.
    const t2 = task(2, 'Add beta');
    const { cwd } = await iso.prepare(t2, run);
    writeFileSync(join(cwd, 'beta.txt'), 'beta\n');
    expect(await iso.integrate(t2, run)).toBe('merged');
    expect(await iso.findInHead(run)).toEqual([]);
  });

  it('counts a merge done by hand with git', async () => {
    const root = repo();
    const { iso, run } = await landedOne(root);
    git(root, 'merge', '-q', '--no-edit', run.repos[0].integrationBranch);
    expect(await iso.findInHead(run)).toEqual(['task-1']);
  });

  it('counts work whose integration branch is gone as nothing left to merge, but not in a repo git cannot read', async () => {
    const root = repo();
    const { iso, run } = await landedOne(root);
    // Deleted unmerged (a squash merge, a branch cleanup): Merge all merges by
    // the branch's name, so no merge could bring this in again.
    git(root, 'worktree', 'remove', '--force', join(root, '.ordewell', 'worktrees', run.id, 'integration'));
    git(root, 'branch', '-D', run.repos[0].integrationBranch);
    const untipped = structuredClone(run);
    delete untipped.tasks['task-1'].repos['.'].landedTip;
    const moved = structuredClone(run);
    moved.repos[0].root = join(root, 'moved-away');

    expect(await iso.findInHead(moved)).toEqual([]);
    expect(await iso.findInHead(untipped)).toEqual(['task-1']);
    expect(await iso.findInHead(run)).toEqual(['task-1']);
  });

  it('holds Merge all back until a landing in flight has finished', async () => {
    const root = repo();
    let reached!: () => void;
    const atMerge = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const execFileImpl: GitExecFn = async (file, args, opts) => {
      if (subcommand(args) === 'merge' && args.includes('--no-ff')) {
        reached();
        await held;
      }
      const { stdout, stderr } = await execFileAsync(file, args, { cwd: opts.cwd, env: opts.env });
      return { stdout: String(stdout), stderr: String(stderr) };
    };
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl });
    const run = await iso.startRun(root);
    const t = task(1, 'Add alpha');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'alpha.txt'), 'alpha\n');

    const landing = iso.integrate(t, run);
    await atMerge;
    const merge = iso.mergeIntoCheckedOut(run);
    release();

    expect(await landing).toBe('merged');
    expect(await merge).toEqual({ outcome: 'merged' });
    expect(readFileSync(join(root, 'alpha.txt'), 'utf8')).toBe('alpha\n');
  });

  it('snapshots tracked changes and names only those made since, never untracked files', async () => {
    const root = repo({ 'README.md': 'hello\n', 'notes.md': 'notes\n' });
    writeFileSync(join(root, 'notes.md'), 'the user was here\n');
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const snapshot = await iso.snapshotTree(root, []);
    expect(snapshot).toEqual({ '.': { 'notes.md': expect.any(String) } });
    expect(await iso.changedSince(root, snapshot!)).toEqual([]);

    writeFileSync(join(root, 'README.md'), 'changed\n');
    writeFileSync(join(root, 'notes.md'), 'changed again\n');
    writeFileSync(join(root, 'deploy.log'), 'untracked output\n');

    expect(await iso.changedSince(root, snapshot!)).toEqual(['README.md', 'notes.md']);
    // Neither the tree, the index nor the stash list is touched.
    expect(git(root, 'stash', 'list')).toBe('');
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('changed\n');
  });

  it('counts a deleted tracked file and a staged change as changes', async () => {
    const root = repo({ 'README.md': 'hello\n', 'notes.md': 'notes\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const snapshot = await iso.snapshotTree(root, []);

    rmSync(join(root, 'notes.md'));
    writeFileSync(join(root, 'README.md'), 'staged\n');
    git(root, 'add', 'README.md');

    expect(await iso.changedSince(root, snapshot!)).toEqual(['README.md', 'notes.md']);
  });

  it('does not count commits an ops task made to history, only uncommitted changes', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const snapshot = await iso.snapshotTree(root, []);
    git(root, 'commit', '-q', '--amend', '-m', 'reworded');
    expect(await iso.changedSince(root, snapshot!)).toEqual([]);
  });

  it('snapshots every repo of a group, leaving out those excluded', async () => {
    const dir = realpath(mkdtempSync(join(tmpdir(), 'ordewell-group-')));
    roots.push(dir);
    initRepo(join(dir, 'api'), { 'a.txt': 'a\n' });
    initRepo(join(dir, 'web'), { 'w.txt': 'w\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const snapshot = await iso.snapshotTree(dir, ['web']);
    expect(Object.keys(snapshot!)).toEqual(['api']);

    writeFileSync(join(dir, 'api', 'a.txt'), 'changed\n');
    writeFileSync(join(dir, 'web', 'w.txt'), 'changed\n');

    expect(await iso.changedSince(dir, snapshot!)).toEqual(['api/a.txt']);
  });
});
describe.skipIf(!hasGit)('task diff reads', () => {
  it('lists live tracked and untracked changes, reads a literal file patch, and keeps it after landing', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Change readme');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'README.md'), 'hello\nworld\n');
    writeFileSync(join(cwd, 'new file.txt'), 'new\n');
    expect(await iso.taskDiff!(run, t.id, {})).toEqual({ available: true, text: '[repo .] README.md: +1 -0\n[repo .] new file.txt: +1 -0\n' });
    expect(await iso.taskDiff!(run, t.id, { path: 'README.md' })).toMatchObject({ available: true, text: expect.stringContaining('+world') });
    expect(await iso.taskDiff!(run, t.id, { path: 'new file.txt' })).toMatchObject({ available: true, text: expect.stringContaining('+new') });
    expect(await iso.integrate(t, run)).toBe('merged');
    expect(existsSync(cwd)).toBe(false);
    expect(await iso.taskDiff!(run, t.id, { path: 'README.md' })).toMatchObject({ available: true, text: expect.stringContaining('+world') });
  });

  it('uses the starting integration tip so predecessor changes are excluded', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const first = task(1, 'First');
    const a = await iso.prepare(first, run);
    writeFileSync(join(a.cwd, 'first.txt'), 'first\n');
    expect(await iso.integrate(first, run)).toBe('merged');
    const second = task(2, 'Second');
    const b = await iso.prepare(second, run);
    writeFileSync(join(b.cwd, 'second.txt'), 'second\n');
    expect(await iso.taskDiff!(run, second.id, {})).toEqual({ available: true, text: '[repo .] second.txt: +1 -0\n' });
    expect(await iso.integrate(second, run)).toBe('merged');
    expect(await iso.taskDiff!(run, second.id, {})).toEqual({ available: true, text: '[repo .] second.txt: +1 -0\n' });
  });

  it('names every repository and selects the repository of a single file', async () => {
    const root = realpath(mkdtempSync(join(tmpdir(), 'ordewell-diff-group-')));
    roots.push(root);
    initRepo(join(root, 'alpha'));
    initRepo(join(root, 'beta'));
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Group');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, 'alpha', 'README.md'), 'alpha\n');
    writeFileSync(join(cwd, 'beta', 'README.md'), 'beta\n');
    expect(await iso.taskDiff!(run, t.id, {})).toEqual({ available: true, text: '[repo alpha] README.md: +1 -1\n[repo beta] README.md: +1 -1\n' });
    const patch = await iso.taskDiff!(run, t.id, { repo: 'beta', path: 'README.md' });
    expect(patch).toMatchObject({ available: true, text: expect.stringContaining('+beta') });
    if (patch.available) expect(patch.text).not.toContain('+alpha');
  });

  it('refuses traversal, state paths, unknown repos and missing files; reports missing historical evidence', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Read');
    await iso.prepare(t, run);
    for (const file of ['../secret', '/etc/passwd', '.ordewell/session', '.git/config', ':(glob)**']) {
      expect(await iso.taskDiff!(run, t.id, { path: file })).toMatchObject({ available: false });
    }
    expect(await iso.taskDiff!(run, t.id, { repo: 'outside' })).toMatchObject({ available: false, reason: expect.stringContaining('No repository') });
    expect(await iso.taskDiff!(run, t.id, { path: 'absent.txt' })).toMatchObject({ available: false, reason: expect.stringContaining('No changed file') });
    delete run.tasks[t.id].repos['.'].baseRef;
    expect(await iso.taskDiff!(run, t.id, {})).toMatchObject({ available: false, reason: expect.stringContaining('starting commit') });
    expect(await iso.taskDiff!(run, 'absent', {})).toMatchObject({ available: false, reason: expect.stringContaining('not available for this run') });
  });

  it('refuses a read-only task, running no git in a worktree whose .git a sealed run could have rewritten (ADR-0046)', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Review');
    const { cwd } = await iso.prepare(t, run, 'fresh', { readOnly: true });
    // A gitdir of the task's own, whose config would run a program the moment git reads it.
    const marker = join(root, 'ran-outside');
    mkdirSync(join(cwd, 'planted'));
    writeFileSync(join(cwd, 'planted', 'config'), `[core]\n\tfsmonitor = touch ${marker}\n\thooksPath = ${join(cwd, 'planted')}\n`);
    replaceGitFile(cwd, 'gitdir: planted\n');
    writeFileSync(join(cwd, 'tried-fix.ts'), 'export const fixed = true;\n');

    const diff = await iso.taskDiff!(run, t.id, {});

    expect(diff).toMatchObject({ available: false, reason: expect.stringContaining('read-only task') });
    expect(existsSync(marker)).toBe(false);
  });

  it('does not run clean filters, textconv, external diff drivers, or fsmonitor while reading', async () => {
    const root = repo({ 'README.md': 'hello\n', '.gitattributes': 'README.md filter=owned diff=owned\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Read safely');
    const { cwd } = await iso.prepare(t, run);
    const marker = join(root, 'executed');
    const command = `echo executed > '${marker}'`;
    git(root, 'config', 'filter.owned.clean', command);
    git(root, 'config', 'filter.owned.process', command);
    git(root, 'config', 'diff.owned.textconv', command);
    git(root, 'config', 'diff.external', command);
    git(root, 'config', 'core.fsmonitor', command);
    writeFileSync(join(cwd, 'README.md'), 'changed\n');
    expect(await iso.taskDiff!(run, t.id, { path: 'README.md' })).toMatchObject({ available: true, text: expect.stringContaining('+changed') });
    expect(existsSync(marker)).toBe(false);
  });
});
describe.skipIf(!hasGit)('task diff reads keep the workspace boundary', () => {
  it('excludes files outside a workspace that is a repository subdirectory', async () => {
    const root = repo({ 'outside.txt': 'outside\n', 'inside/file.txt': 'inside\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(join(root, 'inside'));
    const t = task(1, 'Inside');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, '..', 'outside.txt'), 'outside changed\n');
    writeFileSync(join(cwd, 'file.txt'), 'inside changed\n');
    writeFileSync(join(cwd, 'new.txt'), 'new\n');
    expect(await iso.taskDiff!(run, t.id, {})).toEqual({ available: true, text: '[repo .] file.txt: +1 -1\n[repo .] new.txt: +1 -0\n' });
    expect(await iso.taskDiff!(run, t.id, { path: 'file.txt' })).toMatchObject({ available: true, text: expect.stringContaining('+inside changed') });
    expect(await iso.taskDiff!(run, t.id, { path: 'outside.txt' })).toMatchObject({ available: false });
  });

  it('names for a verdict what a commit would take beside that subdirectory, as no diff a person reads does', async () => {
    const root = repo({ 'outside.txt': 'outside\n', 'inside/file.txt': 'inside\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(join(root, 'inside'));
    const t = task(1, 'Inside');
    const { cwd } = await iso.prepare(t, run);
    writeFileSync(join(cwd, '..', 'outside.txt'), 'outside changed\n');
    writeFileSync(join(cwd, 'file.txt'), 'inside changed\n');
    mkdirSync(join(cwd, '..', 'ci'));
    writeFileSync(join(cwd, '..', 'ci', 'new.yml'), 'new\n');
    const names = async (mode: true | 'both') => {
      const read = await iso.taskDiff!(run, t.id, { names: mode });
      return read.available ? read.text.split('\0').sort() : read.reason;
    };
    expect(await names(true)).toEqual(['ci/new.yml', 'file.txt', 'outside.txt']);
    expect(await names('both')).toEqual(['ci/new.yml', 'file.txt', 'inside/file.txt', 'outside.txt']);
  });

  it('lists what a repair brings beside that subdirectory, by each name a protected path may give it', async () => {
    const root = repo({ 'outside.txt': 'outside\n', 'inside/shared.txt': 'base\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(join(root, 'inside'));
    const [first, second] = [task(1, 'First'), task(2, 'Second')];
    const a = await iso.prepare(first, run);
    const b = await iso.prepare(second, run);
    writeFileSync(join(a.cwd, 'shared.txt'), 'first\n');
    writeFileSync(join(b.cwd, 'shared.txt'), 'second\n');
    expect(await iso.integrate(first, run)).toBe('merged');
    expect(await iso.integrate(second, run)).toBe('conflict');
    await iso.reopen(second, run);
    expect(() => git(b.cwd, 'merge', '--no-edit', `ordewell/${run.id}/integration`)).toThrow();
    writeFileSync(join(b.cwd, 'shared.txt'), 'first and second\n');
    writeFileSync(join(b.cwd, '..', 'outside.txt'), 'edited by the repair\n');
    git(b.cwd, 'add', '-A', '--', ':/');
    git(b.cwd, 'commit', '-q', '--no-edit');

    expect(await iso.verifyRepair(second, run)).toEqual({ ok: true });
    expect((await iso.repairPaths?.(second, run))?.sort()).toEqual(['inside/shared.txt', 'outside.txt', 'shared.txt']);
  });

  it('reads a symlink as a link without reading its outside target, and excludes linked artifacts', async () => {
    const root = repo();
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'secret.txt'), 'private artifact');
    const outside = repo({ 'secret.txt': 'outside secret\n' });
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const t = task(1, 'Link');
    const { cwd } = await iso.prepare(t, run);
    symlinkSync(join(outside, 'secret.txt'), join(cwd, 'link.txt'));
    const patch = await iso.taskDiff!(run, t.id, { path: 'link.txt' });
    expect(patch).toMatchObject({ available: true, text: expect.stringContaining('new file mode 120000') });
    if (patch.available) expect(patch.text).not.toContain('outside secret');
    const list = await iso.taskDiff!(run, t.id, {});
    if (list.available) expect(list.text).not.toContain('node_modules');
    expect(await iso.taskDiff!(run, t.id, { path: 'node_modules/secret.txt' })).toMatchObject({ available: false });
  });
});
