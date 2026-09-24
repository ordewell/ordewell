import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation, type WorktreeIsolationDeps } from '../GitWorktreeIsolation';
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

function makeRepo(files: Record<string, string> = { 'README.md': 'hello\n' }): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-wt-')));
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

function realpathSafe(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function branches(root: string, pattern = 'ordewell/*'): string[] {
  return git(root, 'branch', '--list', pattern, '--format=%(refname:short)').split('\n').filter(Boolean);
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

    expect(run.baseRef).toBe(headBefore);
    expect(run.baseBranch).toBe('main');
    expect(run.integrationBranch).toBe(`ordewell/${run.id}/integration`);

    const { cwd, branch } = await iso.prepare(task(1, 'Add greeting'), run);
    expect(cwd).toBe(join(root, '.ordewell', 'worktrees', run.id, '1-add-greeting'));
    expect(branch).toBe(`ordewell/${run.id}/1-add-greeting`);
    expect(worktreePaths(root)).toContain(cwd);
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toBe('hello\n');

    writeFileSync(join(cwd, 'greeting.txt'), 'hi\n');
    expect(await iso.integrate(task(1, 'Add greeting'), run)).toBe('merged');

    expect(git(root, 'show', `${run.integrationBranch}:greeting.txt`)).toBe('hi');
    // Two parents plus the commit id: --no-ff produced a real merge commit.
    expect(git(root, 'rev-list', '--parents', '-n', '1', run.integrationBranch).split(' ')).toHaveLength(3);
    expect(git(root, 'log', '-1', '--format=%s', run.integrationBranch)).toContain('Add greeting');

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
    expect(a.integrationBranch).not.toBe(b.integrationBranch);
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

    const merges = git(root, 'log', '--first-parent', '--reverse', '--merges', '--format=%s', run.integrationBranch).split('\n');
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
    expect(git(root, 'show', `${run.integrationBranch}:fast.txt`)).toBe('x');
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
    expect(git(root, 'show', `${run.integrationBranch}:committed.txt`)).toBe('a');
    expect(git(root, 'show', `${run.integrationBranch}:loose.txt`)).toBe('b');
    expect(git(root, 'log', '--format=%s', run.integrationBranch)).toContain('runner commit');
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
    const tipBefore = git(root, 'rev-parse', run.integrationBranch);

    expect(await iso.integrate(t2, run)).toBe('conflict');

    expect(git(root, 'rev-parse', run.integrationBranch)).toBe(tipBefore);
    expect(git(root, 'show', `${run.integrationBranch}:shared.txt`)).toBe('left');
    expect(worktreePaths(root)).toContain(b.cwd);
    expect(branches(root)).toContain(b.branch);
    expect(branches(root)).toContain(run.integrationBranch);
    expect(run.tasks['task-2'].status).toBe('conflict');
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
    expect(git(root, 'show', `${run.integrationBranch}:other.txt`)).toBe('o');
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
    expect(branches(root)).toContain(run.integrationBranch);
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
    const tree = git(root, 'ls-tree', '-r', '--name-only', run.integrationBranch).split('\n');
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
    const tree = git(root, 'ls-tree', '-r', '--name-only', run.integrationBranch).split('\n');
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
    expect(branches(root)).toEqual([run.integrationBranch]);
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
    git(root, 'worktree', 'add', '-q', '-b', `ordewell/${run.id}/9-stray`, strayDir, run.integrationBranch);

    await iso.pruneOrphans(run);

    const listed = worktreePaths(root);
    expect(listed).not.toContain(crashed.cwd);
    expect(listed).not.toContain(strayDir);
    expect(listed).toContain(kept.cwd);
    expect(listed).toContain(conflicted.cwd);
    expect(branches(root).sort()).toEqual([run.integrationBranch, kept.branch, conflicted.branch].sort());
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
    expect(handoff).toEqual({
      branch: run.integrationBranch,
      baseRef: git(root, 'rev-parse', 'HEAD'),
      landed: [
        { taskId: 'task-1', order: 1, title: 'Add alpha' },
        { taskId: 'task-2', order: 2, title: 'Add beta' },
      ],
    });
  });

  it('frees the integration branch so the user can check it out', async () => {
    const { root, iso, run } = await finishedRun();
    await iso.handoff(run);
    expect(worktreePaths(root)).toEqual([root]);
    expect(branches(root)).toContain(run.integrationBranch);
  });

  it('a task retried after handoff still integrates', async () => {
    const { root, iso, run } = await finishedRun();
    await iso.handoff(run);
    const t3 = task(3, 'Late');
    const { cwd } = await iso.prepare(t3, run);
    writeFileSync(join(cwd, 'late.txt'), 'late\n');
    expect(await iso.integrate(t3, run)).toBe('merged');
    expect(git(root, 'show', `${run.integrationBranch}:late.txt`)).toBe('late');
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

  it('never merges into the checked-out branch until asked, and then does', async () => {
    const { root, iso, run } = await finishedRun();
    const before = git(root, 'rev-parse', 'HEAD');
    await iso.handoff(run);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before);
    expect(existsSync(join(root, 'alpha.txt'))).toBe(false);

    expect(await iso.mergeIntoCheckedOut(run)).toBe('merged');
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

    expect(await iso.mergeIntoCheckedOut(run)).toBe('conflict');
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

    expect(await iso.mergeIntoCheckedOut(run)).toBe('failed');
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
    expect(branches(root)).toEqual([run.integrationBranch]);
    expect(git(root, 'show', `${run.integrationBranch}:landed.txt`)).toBe('l');
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
