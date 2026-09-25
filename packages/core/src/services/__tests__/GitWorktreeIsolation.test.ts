import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation, type GitExecFn, type WorktreeIsolationDeps } from '../GitWorktreeIsolation';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

// A git hook that runs the suite exports GIT_DIR & co., which would point every
// fixture command at the outer repository instead of the temp one.
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}

// Skips the login-shell PATH probe: the suite is hermetic and git is already on PATH.
const create = (deps: WorktreeIsolationDeps) =>
  createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', ...deps });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(root: string, files: Record<string, string> = { 'README.md': 'hello\n' }): string {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

function makeRepo(files?: Record<string, string>): string {
  return initRepo(realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-wt-'))), files);
}

function task(order: number, title: string): Task {
  return {
    id: `task-${order}`,
    order,
    title,
    description: '',
    type: 'ai',
    status: 'in_progress',
    dependencies: [],
    subtasks: [],
    assignedRunner: 'claude-code',
    completionMarker: 'DONE',
  };
}

function worktreePaths(root: string): string[] {
  return git(root, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => realpathSafe(l.slice('worktree '.length)));
}

function lexists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

function realpathSafe(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function branches(root: string, pattern = 'ordewell/*'): string[] {
  return git(root, 'branch', '--list', pattern, '--format=%(refname:short)').split('\n').filter(Boolean);
}

const execFileAsync = promisify(execFile);

/** Real git, except that `git worktree add` fails in the given repositories. */
function refuseWorktreesIn(...repoRoots: string[]): GitExecFn {
  return async (file, args, opts) => {
    if (args[0] === 'worktree' && args[1] === 'add' && opts.cwd && repoRoots.includes(opts.cwd)) {
      throw Object.assign(new Error('fatal: cannot add worktree'), { stderr: 'fatal: cannot add worktree', code: 128 });
    }
    const { stdout, stderr } = await execFileAsync(file, args, { cwd: opts.cwd, env: opts.env });
    return { stdout: String(stdout), stderr: String(stderr) };
  };
}

/**
 * Real git until the first call `at` matches, which never returns: the
 * process died there. Every later call hangs too, as it would in a dead process.
 */
function crashAt(at: (args: string[], cwd: string | undefined) => boolean): { exec: GitExecFn; crashed: () => boolean } {
  let crashed = false;
  const exec: GitExecFn = async (file, args, opts) => {
    if (crashed || at(args, opts.cwd)) {
      crashed = true;
      return new Promise(() => undefined);
    }
    const { stdout, stderr } = await execFileAsync(file, args, { cwd: opts.cwd, env: opts.env });
    return { stdout: String(stdout), stderr: String(stderr) };
  };
  return { exec, crashed: () => crashed };
}

const roots: string[] = [];
function repo(files?: Record<string, string>): string {
  const root = makeRepo(files);
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
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
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-plain-')));
      roots.push(dir);
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(dir)).toEqual({ active: false, reason: 'not-git' });
    });

    it('refuses a repository that contains a nested repository that is not a submodule, naming it', async () => {
      const root = repo();
      initRepo(join(root, 'services', 'billing'));
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(root)).toEqual({ active: false, reason: 'nested-repos', repos: ['services/billing'] });
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
      expect(await iso.isActive(root)).toEqual({ active: false, reason: 'nested-repos', repos: ['tools/linked'] });
    });

    it('resolves submodules against the repository top level when the workspace is a subdirectory', async () => {
      const root = repo({ 'app/README.md': 'hello\n' });
      const upstream = repo();
      git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'app/vendor/lib');
      git(root, 'commit', '-q', '-m', 'add submodule');
      initRepo(join(root, 'app', 'tools', 'extra'));
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(join(root, 'app'))).toEqual({ active: false, reason: 'nested-repos', repos: ['tools/extra'] });
    });

    it('skips a nested repository the outer repository ignores, at either depth', async () => {
      const root = repo({ 'README.md': 'hello\n', '.gitignore': 'scratch/\ncache/\n' });
      initRepo(join(root, 'scratch'));
      initRepo(join(root, 'cache', 'clone'));
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(root)).toEqual({ active: true });
    });

    it('does not look for nested repositories inside .ordewell or node_modules', async () => {
      const root = repo();
      initRepo(join(root, '.ordewell', 'worktrees', 'r1'));
      initRepo(join(root, 'node_modules', 'pkg'));
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(root)).toEqual({ active: true });
    });

    it('isolates a folder of repositories as a group of the ones directly inside it, not deeper ones', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-group-')));
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
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-empty-')));
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
    expect(run.tasks['task-1'].repos).toEqual({ '.': { worktree: a.cwd, linked: [] } });

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
    expect(merges).toEqual(['Merge task 1: One', 'Merge task 2: Two', 'Merge task 3: Three']);
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
    await expect(iso.release(run, 'nope', { keep: false })).resolves.toBeUndefined();
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

describe.skipIf(!hasGit)('WorktreeIsolation bootstrap', () => {
  function repoWithLocalState(): string {
    const root = repo({ '.gitignore': 'node_modules/\n.env\n.venv/\n', 'README.md': 'hi\n', '.env.example': 'KEY=\n' });
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

    for (const name of ['node_modules', '.venv', '.claude', '.env', '.envrc']) {
      expect(lstatSync(join(cwd, name)).isSymbolicLink(), name).toBe(true);
      expect(realpathSync(join(cwd, name))).toBe(realpathSync(join(root, name)));
    }
    expect(readFileSync(join(cwd, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(existsSync(join(cwd, '.ordewell'))).toBe(false);
    // A tracked file is checked out for real, not replaced by a link.
    expect(lstatSync(join(cwd, '.env.example')).isSymbolicLink()).toBe(false);
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
    expect(tree.some((f) => f.startsWith('node_modules') || f.startsWith('.venv') || f === '.envrc' || f === '.env')).toBe(false);
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

    expect(lstatSync(join(cwd, 'node_modules')).isSymbolicLink()).toBe(true);
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

  it('a failing setup command fails prepare and leaves nothing behind', async () => {
    const root = repoWithLocalState();
    const iso = create({ config: fakeConfig({ worktreeSetupCommand: 'exit 3' }) });
    const run = await iso.startRun(root);

    await expect(iso.prepare(task(1, 'Broken setup'), run)).rejects.toThrow(/setup command failed/i);
    expect(worktreePaths(root)).toEqual([root]);
    expect(branches(root)).toEqual([run.repos[0].integrationBranch]);
    expect(run.tasks['task-1']).toBeUndefined();
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

    await iso.pruneOrphans(run);

    const listed = worktreePaths(root);
    expect(listed).not.toContain(crashed.cwd);
    expect(listed).not.toContain(strayDir);
    expect(listed).toContain(kept.cwd);
    expect(listed).toContain(conflicted.cwd);
    expect(branches(root).sort()).toEqual([run.repos[0].integrationBranch, kept.branch, conflicted.branch].sort());
    expect(run.tasks['task-1']).toBeUndefined();
    expect(Object.keys(run.tasks).sort()).toEqual(['task-2', 'task-3']);
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
      repos: [{ path: '.', integrationBranch: `ordewell/${run.id}/integration`, baseRef: git(root, 'rev-parse', 'HEAD'), landed }],
      landed,
    });
  });

  it('frees the integration branch so the user can check it out', async () => {
    const { root, iso, run } = await finishedRun();
    await iso.handoff(run);
    expect(worktreePaths(root)).toEqual([root]);
    expect(branches(root)).toContain(run.repos[0].integrationBranch);
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

  it('discard removes worktrees and task branches but can keep the integration branch', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const [t1, t2] = [task(1, 'Landed'), task(2, 'Still running')];
    const a = await iso.prepare(t1, run);
    const b = await iso.prepare(t2, run);
    writeFileSync(join(a.cwd, 'landed.txt'), 'l\n');
    await iso.integrate(t1, run);

    await iso.discard(run, { keepIntegration: true });

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

    await iso.discard(run, { keepIntegration: false });

    expect(worktreePaths(root)).toEqual([root]);
    expect(branches(root)).toEqual([]);
    expect(existsSync(join(root, '.ordewell', 'worktrees', run.id))).toBe(false);
    expect(run.tasks).toEqual({});
  });
});

describe.skipIf(!hasGit)('WorktreeIsolation over a repo group', () => {
  // A folder that is not a repository: three repositories with commits, one
  // with none, a loose file, a loose directory, and a gitignored `.env`.
  function group(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-group-')));
    roots.push(dir);
    initRepo(join(dir, 'api'), { 'README.md': 'api\n', '.gitignore': '.env\n' });
    initRepo(join(dir, 'web'), { 'index.html': '<p>web</p>\n' });
    initRepo(join(dir, 'infra'), { 'main.tf': '# infra\n', '.gitignore': '*.tfstate\n' });
    mkdirSync(join(dir, 'scratch'));
    git(join(dir, 'scratch'), 'init', '-q');
    writeFileSync(join(dir, 'NOTES.md'), 'notes\n');
    mkdirSync(join(dir, 'design'));
    writeFileSync(join(dir, 'design', 'mock.txt'), 'mock\n');
    writeFileSync(join(dir, 'api', '.env'), 'API_KEY=1\n');
    return dir;
  }

  const GROUP = ['api', 'infra', 'web'];

  describe('detection', () => {
    it('isolates the repositories directly inside a folder, sharing the one with no commits and the loose paths', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(dir)).toEqual({ active: true, repos: GROUP, shared: ['NOTES.md', 'design', 'scratch'] });

      const run = await iso.startRun(dir);
      expect(run.repos.map((r) => r.path)).toEqual(GROUP);
      expect(run.sharedRepos).toEqual(['scratch']);
      expect(run.shared).toEqual(['NOTES.md', 'design', 'scratch']);
      for (const repo of run.repos) {
        expect(repo.root).toBe(join(dir, repo.path));
        expect(repo.baseRef).toBe(git(repo.root, 'rev-parse', 'HEAD'));
        expect(repo.baseBranch).toBe('main');
        expect(repo.integrationBranch).toBe(`ordewell/${run.id}/integration`);
        expect(branches(repo.root)).toEqual([repo.integrationBranch]);
      }
    });

    it('uses workspaceRepos instead when it is set, including a repository two levels down', async () => {
      const dir = group();
      initRepo(join(dir, 'libs', 'core'), { 'lib.ts': 'export {};\n' });
      writeFileSync(join(dir, 'libs', 'README.md'), 'libs\n');
      const iso = create({ config: fakeConfig({ worktreeIsolation: true, workspaceRepos: ['libs/core/', './api'] }) });
      expect(await iso.isActive(dir)).toEqual({ active: true, repos: ['api', 'libs/core'], shared: ['NOTES.md', 'design', 'infra', 'libs/README.md', 'scratch', 'web'] });

      const run = await iso.startRun(dir);
      expect(run.repos.map((r) => r.path)).toEqual(['api', 'libs/core']);
      expect(run.shared).toEqual(['NOTES.md', 'design', 'infra', 'libs/README.md', 'scratch', 'web']);

      const { cwd } = await iso.prepare(task(1, 'Deep'), run);
      expect(readFileSync(join(cwd, 'libs', 'core', 'lib.ts'), 'utf8')).toBe('export {};\n');
      expect(git(join(cwd, 'libs', 'core'), 'branch', '--show-current')).toBe(run.tasks['task-1'].branch);
      expect(lstatSync(join(cwd, 'libs')).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(cwd, 'libs', 'README.md')).isSymbolicLink()).toBe(true);
    });

    it('shares a repository git refuses a worktree for, and isolates the others', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl: refuseWorktreesIn(join(dir, 'web')) });
      const run = await iso.startRun(dir);

      expect(run.repos.map((r) => r.path)).toEqual(['api', 'infra']);
      expect(run.sharedRepos).toEqual(['scratch', 'web']);
      expect(run.shared).toContain('web');
      expect(branches(join(dir, 'web'))).toEqual([]);
      const { cwd } = await iso.prepare(task(1, 'Around web'), run);
      expect(lstatSync(join(cwd, 'web')).isSymbolicLink()).toBe(true);
    });

    it('refuses to start a run when git refuses a worktree for every repository', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl: refuseWorktreesIn(join(dir, 'api'), join(dir, 'infra'), join(dir, 'web')) });
      await expect(iso.startRun(dir)).rejects.toThrow(/No repository could be isolated: api, infra, scratch, web/);
      for (const repo of GROUP) expect(branches(join(dir, repo))).toEqual([]);
    });

    it('reports no-commits, naming them, when no repository in the folder has a commit', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-group-')));
      roots.push(dir);
      for (const name of ['one', 'two']) {
        mkdirSync(join(dir, name));
        git(join(dir, name), 'init', '-q');
      }
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(dir)).toEqual({ active: false, reason: 'no-commits', repos: ['one', 'two'] });
    });

    it('still reports not-git for a folder with no repositories in it', async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-group-')));
      roots.push(dir);
      mkdirSync(join(dir, 'docs'));
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(dir)).toEqual({ active: false, reason: 'not-git' });
    });
  });

  describe('dirty trees', () => {
    it('holds the run when any repository has tracked changes, naming only those', async () => {
      const dir = group();
      writeFileSync(join(dir, 'web', 'index.html'), '<p>edited</p>\n');
      writeFileSync(join(dir, 'api', 'README.md'), 'staged\n');
      git(join(dir, 'api'), 'add', 'README.md');
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(dir)).toEqual({ active: false, reason: 'dirty', repos: ['api', 'web'] });
    });

    it('stash cleans every dirty repository, and the group isolates', async () => {
      const dir = group();
      writeFileSync(join(dir, 'web', 'index.html'), '<p>edited</p>\n');
      writeFileSync(join(dir, 'infra', 'main.tf'), '# edited\n');
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });

      await iso.stash(dir);

      expect(await iso.isActive(dir)).toEqual({ active: true, repos: GROUP, shared: ['NOTES.md', 'design', 'scratch'] });
      expect(readFileSync(join(dir, 'web', 'index.html'), 'utf8')).toBe('<p>web</p>\n');
      expect(git(join(dir, 'web'), 'stash', 'list')).toContain('ordewell');
      expect(git(join(dir, 'infra'), 'stash', 'list')).toContain('ordewell');
      expect(git(join(dir, 'api'), 'stash', 'list')).toBe('');
    });
  });

  describe('task workspace', () => {
    it('lays the repositories out as in the real folder, each on the task branch, with the shared paths linked', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const { cwd, branch, copied } = await iso.prepare(task(1, 'Span repos'), run);

      expect(cwd).toBe(join(dir, '.ordewell', 'worktrees', run.id, '1-span-repos'));
      expect(branch).toBe(`ordewell/${run.id}/1-span-repos`);
      expect(copied).toEqual([]);
      expect(run.tasks['task-1'].workspace).toBe(cwd);
      for (const repo of GROUP) {
        expect(run.tasks['task-1'].repos[repo].worktree).toBe(join(cwd, repo));
        expect(git(join(cwd, repo), 'branch', '--show-current')).toBe(branch);
        expect(worktreePaths(join(dir, repo))).toContain(join(cwd, repo));
      }
      expect(readFileSync(join(cwd, 'web', 'index.html'), 'utf8')).toBe('<p>web</p>\n');
      for (const shared of ['NOTES.md', 'design', 'scratch']) {
        expect(lstatSync(join(cwd, shared)).isSymbolicLink(), shared).toBe(true);
        expect(realpathSync(join(cwd, shared))).toBe(join(dir, shared));
      }
      expect(existsSync(join(cwd, '.ordewell'))).toBe(false);
      expect(lstatSync(join(cwd, 'api', '.env')).isSymbolicLink()).toBe(true);
      expect(run.tasks['task-1'].repos.api.linked).toEqual(['.env']);
    });

    it('makes an edit to a shared path live in the real folder', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const { cwd } = await iso.prepare(task(1, 'Edit notes'), run);

      writeFileSync(join(cwd, 'NOTES.md'), 'edited by a task\n');
      writeFileSync(join(cwd, 'design', 'new.txt'), 'new\n');

      expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('edited by a task\n');
      expect(readFileSync(join(dir, 'design', 'new.txt'), 'utf8')).toBe('new\n');
    });

    it('prepares a task beside a loose link that leads nowhere, such as an editor lock file, without sharing it', async () => {
      const dir = group();
      symlinkSync('user@host.4242:1700000000', join(dir, '.#NOTES.md'));
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      expect(await iso.isActive(dir)).toEqual({ active: true, repos: GROUP, shared: ['NOTES.md', 'design', 'scratch'] });
      const run = await iso.startRun(dir);

      const { cwd } = await iso.prepare(task(1, 'Beside a lock file'), run);

      expect(run.shared).toEqual(['NOTES.md', 'design', 'scratch']);
      expect(lexists(join(cwd, '.#NOTES.md'))).toBe(false);
      expect(realpathSync(join(cwd, 'NOTES.md'))).toBe(join(dir, 'NOTES.md'));
    });

    it('lands each repository the task changed on that repository’s integration branch', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const t = task(1, 'Api and web');
      const { cwd } = await iso.prepare(t, run);
      writeFileSync(join(cwd, 'api', 'route.ts'), 'route\n');
      writeFileSync(join(cwd, 'web', 'page.html'), 'page\n');

      expect(await iso.integrate(t, run)).toBe('merged');
      const integration = `ordewell/${run.id}/integration`;
      expect(git(join(dir, 'api'), 'show', `${integration}:route.ts`)).toBe('route');
      expect(git(join(dir, 'web'), 'show', `${integration}:page.html`)).toBe('page');
      expect(git(join(dir, 'api'), 'ls-tree', '-r', '--name-only', integration).split('\n')).not.toContain('.env');
      expect(run.tasks['task-1'].repos.infra.changed).toBe(false);
      expect(existsSync(cwd)).toBe(false);
      expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('notes\n');
    });

    it('a retry recreates the whole task workspace from the integration tips', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const retried = task(2, 'Retried');
      const first = await iso.prepare(retried, run);
      writeFileSync(join(first.cwd, 'web', 'stale.txt'), 'old attempt\n');
      await iso.release(run, 'task-2', { keep: true });

      const pred = task(1, 'Predecessor');
      const p = await iso.prepare(pred, run);
      writeFileSync(join(p.cwd, 'infra', 'vpc.tf'), 'vpc\n');
      await iso.integrate(pred, run);

      const retry = await iso.prepare(retried, run);
      expect(retry.cwd).toBe(first.cwd);
      expect(existsSync(join(retry.cwd, 'web', 'stale.txt'))).toBe(false);
      expect(readFileSync(join(retry.cwd, 'infra', 'vpc.tf'), 'utf8')).toBe('vpc\n');
      expect(lstatSync(join(retry.cwd, 'NOTES.md')).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('notes\n');
    });
  });

  it('on Windows links shared directories as junctions and shared files as hard links', async () => {
    const dir = group();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }), platform: 'win32' });
    const run = await iso.startRun(dir);
    const { cwd, copied } = await iso.prepare(task(1, 'Windows'), run);

    expect(copied).toEqual([]);
    expect(lstatSync(join(cwd, 'design')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(cwd, 'NOTES.md')).isSymbolicLink()).toBe(false);
    writeFileSync(join(cwd, 'NOTES.md'), 'through a hard link\n');
    expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('through a hard link\n');
    await iso.release(run, 'task-1', { keep: false });
    expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('through a hard link\n');
    expect(readFileSync(join(dir, 'design', 'mock.txt'), 'utf8')).toBe('mock\n');
  });

  describe('bootstrap', () => {
    it('links worktreeLinks matches from the real repository and keeps them out of the commit', async () => {
      const dir = group();
      writeFileSync(join(dir, 'infra', 'terraform.tfstate'), '{"serial":7}\n');
      mkdirSync(join(dir, 'infra', '.terraform', 'providers'), { recursive: true });
      const iso = create({ config: fakeConfig({ worktreeIsolation: true, worktreeLinks: ['*.tfstate', '.terraform/', 'absent.lock'] }) });
      const run = await iso.startRun(dir);
      const t = task(1, 'Plan infra');
      const { cwd } = await iso.prepare(t, run);

      const state = join(cwd, 'infra', 'terraform.tfstate');
      expect(lstatSync(state).isSymbolicLink()).toBe(true);
      expect(realpathSync(state)).toBe(join(dir, 'infra', 'terraform.tfstate'));
      expect(lstatSync(join(cwd, 'infra', '.terraform')).isSymbolicLink()).toBe(true);
      expect(existsSync(join(cwd, 'infra', 'absent.lock'))).toBe(false);
      expect(existsSync(join(cwd, 'web', 'terraform.tfstate'))).toBe(false);

      writeFileSync(join(cwd, 'infra', 'vpc.tf'), 'vpc\n');
      expect(await iso.integrate(t, run)).toBe('merged');
      const tree = git(join(dir, 'infra'), 'ls-tree', '-r', '--name-only', `ordewell/${run.id}/integration`).split('\n');
      expect(tree).toContain('vpc.tf');
      expect(tree.some((f) => f === 'terraform.tfstate' || f.startsWith('.terraform'))).toBe(false);
      expect(readFileSync(join(dir, 'infra', 'terraform.tfstate'), 'utf8')).toBe('{"serial":7}\n');
    });

    it('links each repository’s default artifacts from that repository and keeps them out of its commit', async () => {
      const dir = group();
      mkdirSync(join(dir, 'web', 'node_modules', 'left-pad'), { recursive: true });
      writeFileSync(join(dir, 'infra', '.envrc'), 'export TF_VAR_x=1\n');
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const t = task(1, 'Use the defaults');
      const { cwd } = await iso.prepare(t, run);

      expect(realpathSync(join(cwd, 'web', 'node_modules'))).toBe(join(dir, 'web', 'node_modules'));
      expect(realpathSync(join(cwd, 'infra', '.envrc'))).toBe(join(dir, 'infra', '.envrc'));
      expect(existsSync(join(cwd, 'api', 'node_modules'))).toBe(false);
      expect(run.tasks['task-1'].repos.web.linked).toEqual(['node_modules']);
      expect(run.tasks['task-1'].repos.infra.linked).toEqual(['.envrc']);

      writeFileSync(join(cwd, 'web', 'page.html'), 'page\n');
      writeFileSync(join(cwd, 'infra', 'vpc.tf'), 'vpc\n');
      expect(await iso.integrate(t, run)).toBe('merged');
      const tree = (repo: string) => git(join(dir, repo), 'ls-tree', '-r', '--name-only', `ordewell/${run.id}/integration`).split('\n');
      expect(tree('web')).toContain('page.html');
      expect(tree('web').some((f) => f.startsWith('node_modules'))).toBe(false);
      expect(tree('infra')).toContain('vpc.tf');
      expect(tree('infra')).not.toContain('.envrc');
      expect(existsSync(join(dir, 'web', 'node_modules', 'left-pad'))).toBe(true);
    });

    it('runs the setup command once per isolated repository, in its worktree, naming the repository', async () => {
      const dir = group();
      const log = join(dir, 'setup.log');
      const iso = create({
        config: fakeConfig({ worktreeIsolation: true, worktreeSetupCommand: `echo "$ORDEWELL_REPO|$ORDEWELL_MAIN_REPO|$(pwd)" >> "${log}"` }),
      });
      const run = await iso.startRun(dir);
      const { cwd } = await iso.prepare(task(1, 'Setup'), run);

      const lines = readFileSync(log, 'utf8').trim().split('\n').sort();
      expect(lines).toEqual(GROUP.map((repo) => `${repo}|${join(dir, repo)}|${join(cwd, repo)}`));
      expect(existsSync(join(cwd, 'api', '.env'))).toBe(false);
    });
  });

  // Two repositories in a folder, each with a file two tasks can collide on.
  function pair(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-pair-')));
    roots.push(dir);
    initRepo(join(dir, 'api'), { 'api.txt': 'api\n' });
    initRepo(join(dir, 'web'), { 'web.txt': 'web\n' });
    return dir;
  }
  const integrationOf = (run: IsolationRun) => `ordewell/${run.id}/integration`;
  const tip = (dir: string, repo: string, run: IsolationRun) => git(join(dir, repo), 'rev-parse', integrationOf(run));

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
        const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-trio-')));
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

      it('rolls back the repositories merged before the crash', async () => {
        const dir = trio();
        const { persisted, tips, workspace } = await crashDuringLanding(dir, {
          conflict: false,
          at: (run) => (args, cwd) => args[0] === 'merge' && cwd === integrationDir(dir, run, 'web'),
        });
        expect(tip(dir, 'api', persisted)).not.toBe(tips.api);
        expect(persisted.landing).toEqual({ taskId: 'task-2', tips });

        await recover(dir, persisted);

        for (const repo of ['api', 'db', 'web']) {
          expect(tip(dir, repo, persisted)).toBe(tips[repo]);
          expect(worktreePaths(join(dir, repo))).toEqual([join(dir, repo)]);
          expect(branches(join(dir, repo))).toEqual([integrationOf(persisted)]);
        }
        expect(persisted.landing).toBeUndefined();
        expect(persisted.tasks['task-2']).toBeUndefined();
        expect(existsSync(workspace)).toBe(false);
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
          at: (run) => (args, cwd) => args[0] === 'merge' && cwd === integrationDir(dir, run, 'web'),
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

      await iso.discard(run, { keepIntegration: true });
      for (const repo of ['api', 'web']) {
        expect(worktreePaths(join(dir, repo))).toEqual([join(dir, repo)]);
        expect(branches(join(dir, repo))).toEqual([integrationOf(run)]);
      }
      expect(existsSync(b.cwd)).toBe(false);

      await iso.discard(run, { keepIntegration: false });
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

  describe('handoff', () => {
    /** A handed-off run whose one task changed api.txt and web.txt. */
    async function handedOff(deps: Partial<WorktreeIsolationDeps> = {}, opts: { idleRepo?: string } = {}) {
      const dir = pair();
      if (opts.idleRepo) initRepo(join(dir, opts.idleRepo), { 'idle.txt': 'idle\n' });
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }), ...deps });
      const run = await iso.startRun(dir);
      const t = task(1, 'Edit both');
      const { cwd } = await iso.prepare(t, run);
      writeFileSync(join(cwd, 'api', 'api.txt'), 'run api\n');
      writeFileSync(join(cwd, 'web', 'web.txt'), 'run web\n');
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
      writeFileSync(join(dir, 'web', '.git', 'hooks', 'pre-merge-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const webHead = git(join(dir, 'web'), 'rev-parse', 'HEAD');

      expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'failed', repo: 'web', landed: ['api'] });

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
        `# api — ${integrationOf(run)} against ${base('api')}`,
        `# web — ${integrationOf(run)} against ${base('web')}`,
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

  describe('pruneOrphans', () => {
    it('drops a crashed task workspace and its worktrees and branches in every repository', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const crashed = await iso.prepare(task(1, 'Was running'), run);
      const kept = await iso.prepare(task(2, 'Failed verdict'), run);
      await iso.release(run, 'task-2', { keep: true });
      const strayDir = join(dir, '.ordewell', 'worktrees', run.id, '9-stray');
      git(join(dir, 'web'), 'worktree', 'add', '-q', '-b', `ordewell/${run.id}/9-stray`, join(strayDir, 'web'), run.repos[2].integrationBranch);

      await iso.pruneOrphans(run);

      expect(existsSync(crashed.cwd)).toBe(false);
      expect(existsSync(strayDir)).toBe(false);
      for (const repo of GROUP) {
        expect(worktreePaths(join(dir, repo)).sort()).toEqual([join(dir, repo), join(kept.cwd, repo)].sort());
        expect(branches(join(dir, repo)).sort()).toEqual([`ordewell/${run.id}/integration`, kept.branch].sort());
      }
      expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('notes\n');
      expect(readFileSync(join(dir, 'design', 'mock.txt'), 'utf8')).toBe('mock\n');
      expect(Object.keys(run.tasks)).toEqual(['task-2']);
    });

    it('discard leaves no trace in any repository', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      await iso.prepare(task(1, 'Abandoned'), run);

      await iso.discard(run, { keepIntegration: false });

      for (const repo of GROUP) {
        expect(worktreePaths(join(dir, repo))).toEqual([join(dir, repo)]);
        expect(branches(join(dir, repo))).toEqual([]);
      }
      expect(existsSync(join(dir, '.ordewell', 'worktrees', run.id))).toBe(false);
      expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('notes\n');
    });
  });
});
