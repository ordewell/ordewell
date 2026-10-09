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
    expect(git(root, 'log', '-1', '--format=%s', branch)).toBe('WIP: Stopped mid-work (kept by Ordewell before removing its worktree)');
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

  it('a retry whose last attempt it cannot keep does not start over it', async () => {
    const root = repo();
    const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl: rescueFails });
    const run = await iso.startRun(root);
    const first = await iso.prepare(task(1, 'Retried'), run);
    writeFileSync(join(first.cwd, 'first-try.txt'), 'first try\n');

    await expect(iso.prepare(task(1, 'Retried'), run)).rejects.toThrow(/could not keep/);
    expect(readFileSync(join(first.cwd, 'first-try.txt'), 'utf8')).toBe('first try\n');
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

    for (const name of ['.venv', '.claude', '.env', '.envrc']) {
      expect(lstatSync(join(cwd, name)).isSymbolicLink(), name).toBe(true);
      expect(realpathSync(join(cwd, name))).toBe(realpathSync(join(root, name)));
    }
    // node_modules is a real directory whose entries are linked one by one.
    expect(lstatSync(join(cwd, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(realpathSync(join(cwd, 'node_modules', 'left-pad'))).toBe(join(root, 'node_modules', 'left-pad'));
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

    expect(realpathSync(join(cwd, 'node_modules', '@scope', 'a'))).toBe(join(cwd, 'packages', 'a'));
    expect(realpathSync(join(cwd, 'node_modules', 'left-pad'))).toBe(join(root, 'node_modules', 'left-pad'));
    expect(execFileSync(join(cwd, 'node_modules', '.bin', 'pad'), { encoding: 'utf8' })).toBe('padded\n');
    expect(realpathSync(join(cwd, 'packages', 'b', 'node_modules', 'only-b'))).toBe(join(root, 'packages', 'b', 'node_modules', 'only-b'));
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
    expect(realpathSync(join(root, 'node_modules', '@scope', 'a'))).toBe(join(root, 'packages', 'a'));
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
    expect(realpathSync(join(root, 'node_modules', '@scope', 'a'))).toBe(join(root, 'packages', 'a'));
    expect(readFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(readFileSync(join(root, 'packages', 'b', 'node_modules', 'only-b', 'index.js'), 'utf8')).toBe('module.exports = 2;\n');
    expect(readFileSync(join(root, 'packages', 'a', 'index.js'), 'utf8')).toBe("module.exports = 'a';\n");
  });

  it('with a setup command links nothing by default', async () => {
    const root = installedWorkspace('node_modules/\n');
    const iso = create({ config: fakeConfig({ worktreeSetupCommand: 'true' }) });
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
    expect(lstatSync(join(cwd, '.envrc')).isSymbolicLink()).toBe(true);

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
      const isMerge = args[0] === 'merge' && args.includes('--no-ff');
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
      const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-user-wt-')));
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

  it('holds Merge all back until a landing in flight has finished', async () => {
    const root = repo();
    let reached!: () => void;
    const atMerge = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const execFileImpl: GitExecFn = async (file, args, opts) => {
      if (args[0] === 'merge' && args.includes('--no-ff')) {
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
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-group-')));
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

      expect(realpathSync(join(cwd, 'web', 'node_modules', 'left-pad'))).toBe(join(dir, 'web', 'node_modules', 'left-pad'));
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

      it('rolls back the repositories merged before the crash, keeping the task\'s own commit for a retry', async () => {
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

      const result = await iso.pruneOrphans(run);

      expect(existsSync(crashed.cwd)).toBe(false);
      expect(existsSync(strayDir)).toBe(false);
      for (const repo of GROUP) {
        expect(worktreePaths(join(dir, repo)).sort()).toEqual([join(dir, repo), join(kept.cwd, repo)].sort());
        expect(branches(join(dir, repo)).sort()).toEqual([`ordewell/${run.id}/integration`, kept.branch].sort());
      }
      expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('notes\n');
      expect(readFileSync(join(dir, 'design', 'mock.txt'), 'utf8')).toBe('mock\n');
      expect(Object.keys(run.tasks)).toEqual(['task-2']);
      expect(result.kept).toEqual([]);
    });

    it('keeps an active task workspace in every repository where it holds unlanded work', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const working = await iso.prepare(task(1, 'Still running'), run);
      writeFileSync(join(working.cwd, 'web', 'in-flight.txt'), 'not committed yet\n');

      const result = await iso.pruneOrphans(run);

      expect(existsSync(join(working.cwd, 'web', 'in-flight.txt'))).toBe(true);
      expect(branches(join(dir, 'web'))).toContain(working.branch);
      expect(run.tasks['task-1'].status).toBe('kept');
      expect(result.kept).toEqual([{ taskId: 'task-1', order: 1, title: 'Still running' }]);
    });

    it('discard leaves no trace in any repository', async () => {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      await iso.prepare(task(1, 'Abandoned'), run);

      await iso.discard(run, { integration: 'delete' });

      for (const repo of GROUP) {
        expect(worktreePaths(join(dir, repo))).toEqual([join(dir, repo)]);
        expect(branches(join(dir, repo))).toEqual([]);
      }
      expect(existsSync(join(dir, '.ordewell', 'worktrees', run.id))).toBe(false);
      expect(readFileSync(join(dir, 'NOTES.md'), 'utf8')).toBe('notes\n');
    });
  });

  describe('merged branches', () => {
    /** A handed-off run whose one task changed every repository of the group. */
    async function landedEverywhere() {
      const dir = group();
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }) });
      const run = await iso.startRun(dir);
      const t = task(1, 'Touch every repo');
      const { cwd } = await iso.prepare(t, run);
      for (const repo of GROUP) writeFileSync(join(cwd, repo, 'landed.txt'), `${repo}\n`);
      expect(await iso.integrate(t, run)).toBe('merged');
      await iso.handoff(run);
      return { dir, iso, run, integration: `ordewell/${run.id}/integration` };
    }

    it('decides per repository: only the one whose checked-out branch took the work loses its integration branch', async () => {
      const { dir, iso, run, integration } = await landedEverywhere();
      git(join(dir, 'api'), 'merge', '-q', '--no-edit', integration);

      await iso.discard(run, { integration: 'delete-merged' });

      expect(branches(join(dir, 'api'))).toEqual([]);
      expect(branches(join(dir, 'infra'))).toEqual([integration]);
      expect(branches(join(dir, 'web'))).toEqual([integration]);
      for (const repo of GROUP) expect(worktreePaths(join(dir, repo))).toEqual([join(dir, repo)]);
    });

    it('sweeps an earlier run out of only the repository that merged it by hand', async () => {
      const { dir, iso, integration } = await landedEverywhere();
      git(join(dir, 'web'), 'merge', '-q', '--no-edit', integration);
      const current = await iso.startRun(dir);

      await iso.sweep(current);

      expect(branches(join(dir, 'web'))).toEqual([current.repos[2].integrationBranch]);
      for (const repo of ['api', 'infra']) {
        expect(branches(join(dir, repo)).sort()).toEqual([integration, `ordewell/${current.id}/integration`].sort());
      }
    });

    it('sweeps every repository it can, then names the one where git failed', async () => {
      const dir = group();
      const failing = join(dir, 'api');
      const exec: GitExecFn = async (file, args, opts) => {
        if (args[0] === 'branch' && args[1] === '-d' && opts.cwd === failing) {
          throw Object.assign(new Error('fatal: cannot lock ref'), { stderr: 'fatal: cannot lock ref', code: 128 });
        }
        const { stdout, stderr } = await execFileAsync(file, args, { cwd: opts.cwd, env: opts.env });
        return { stdout: String(stdout), stderr: String(stderr) };
  };
      const iso = create({ config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec });
      const earlier = await iso.startRun(dir);
      await iso.discard(earlier, { integration: 'keep' });
      const current = await iso.startRun(dir);

      await expect(iso.sweep(current)).rejects.toThrow(/in api$/);

      expect(branches(failing)).toContain(`ordewell/${earlier.id}/integration`);
      for (const repo of ['infra', 'web']) expect(branches(join(dir, repo))).toEqual([`ordewell/${current.id}/integration`]);
    });
  });
});
