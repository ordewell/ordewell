import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createIsolationPreview, createWorktreeIsolation, type GitExecFn } from '../GitWorktreeIsolation';
import { defaultExecFile, subcommandOf } from '../gitExec';
import { fakeConfig } from '../../testing';
import type { IConfig } from '../../interfaces/IConfig';

// A git hook that runs the suite exports GIT_DIR & co., which would point every
// fixture command at the outer repository instead of the temp one.
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(root: string, opts: { commit?: boolean } = {}): string {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  if (opts.commit === false) return root;
  writeFileSync(join(root, 'README.md'), 'hello\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

const temps: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-preview-')));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const preview = (workspace: string, config: Partial<IConfig> = {}, deps: { execFileImpl?: GitExecFn } = {}) =>
  createIsolationPreview({
    config: fakeConfig({ worktreeIsolation: true, ...config }),
    resolvePath: async () => process.env.PATH ?? '',
    ...deps,
  }).preview(workspace);

describe('IsolationPreview — a workspace that is one repository', () => {
  it('is ready on its branch, a group of one at `.`', async () => {
    const root = initRepo(tempDir());

    const result = await preview(root);

    expect(result).toEqual({
      status: 'ready',
      repos: [{ path: '.', head: { kind: 'branch', branch: 'main', commit: git(root, 'rev-parse', '--short', 'HEAD') }, dirty: false }],
      shared: [],
    });
  });
});

const head = (repo: string) => git(repo, 'rev-parse', '--short', 'HEAD');

describe('IsolationPreview — a workspace that holds repositories', () => {
  it('is the repositories directly inside it, each on its own branch, with the loose entries shared', async () => {
    const ws = tempDir();
    const api = initRepo(join(ws, 'api'));
    const web = initRepo(join(ws, 'web'));
    git(web, 'checkout', '-q', '-b', 'feature/ui');
    writeFileSync(join(ws, 'notes.txt'), 'shared\n');

    const result = await preview(ws);

    expect(result.status).toBe('ready');
    expect(result.repos).toEqual([
      { path: 'api', head: { kind: 'branch', branch: 'main', commit: head(api) }, dirty: false },
      { path: 'web', head: { kind: 'branch', branch: 'feature/ui', commit: head(web) }, dirty: false },
    ]);
    expect(result.shared).toEqual(['notes.txt']);
  });

  it('honors workspaceRepos: exactly the listed repositories, at any depth', async () => {
    const ws = tempDir();
    initRepo(join(ws, 'api'));
    const deep = initRepo(join(ws, 'services', 'billing'));
    initRepo(join(ws, 'left-out'));

    const result = await preview(ws, { workspaceRepos: ['api', 'services/billing', 'missing'] });

    expect(result.repos.map((r) => r.path)).toEqual(['api', 'services/billing']);
    expect(result.repos[1].head).toEqual({ kind: 'branch', branch: 'main', commit: head(deep) });
  });

  it('shows a repository with no commit yet, shared rather than isolated, beside one that has', async () => {
    const ws = tempDir();
    initRepo(join(ws, 'api'));
    initRepo(join(ws, 'fresh'), { commit: false });

    const result = await preview(ws);

    expect(result.status).toBe('ready');
    expect(result.repos.find((r) => r.path === 'fresh')).toEqual({ path: 'fresh', head: { kind: 'unborn', branch: 'main' } });
  });
});

describe('IsolationPreview — a workspace inside a repository', () => {
  it('is a group of one at `.` that names where the repository starts, with nested repositories shared live', async () => {
    const outer = initRepo(tempDir());
    const ws = join(outer, 'packages', 'app');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'index.ts'), 'x\n');
    git(outer, 'add', '-A');
    git(outer, 'commit', '-q', '-m', 'app');
    initRepo(join(ws, 'vendored'));
    // Repositories listed in workspaceRepos never split a lone repository's group.
    initRepo(join(ws, 'other'));

    const result = await preview(ws, { workspaceRepos: ['other'] });

    expect(result.status).toBe('ready');
    expect(result.repos).toEqual([{ path: '.', top: '../..', head: { kind: 'branch', branch: 'main', commit: head(outer) }, dirty: false }]);
    expect(result.shared).toEqual(['other', 'vendored']);
  });

  it('reads a workspace opened through a symlink as the repository it is, as macOS\'s /var and /tmp are', async () => {
    const outer = initRepo(tempDir());
    const link = join(tempDir(), 'link');
    symlinkSync(outer, link);
    const nested = join(outer, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'index.ts'), 'x\n');
    git(outer, 'add', '-A');
    git(outer, 'commit', '-q', '-m', 'app');

    const root = await preview(link);
    const inside = await preview(join(link, 'packages', 'app'));

    expect(root.repos).toEqual([{ path: '.', head: { kind: 'branch', branch: 'main', commit: head(outer) }, dirty: false }]);
    expect(inside.repos).toEqual([{ path: '.', top: '../..', head: { kind: 'branch', branch: 'main', commit: head(outer) }, dirty: false }]);
  });

  it('reads a linked worktree, whose .git is a file, on its own branch', async () => {
    const main = initRepo(tempDir());
    const linked = join(tempDir(), 'linked');
    git(main, 'worktree', 'add', '-q', '-b', 'topic', linked);

    const result = await preview(linked);

    expect(result.status).toBe('ready');
    expect(result.repos).toEqual([{ path: '.', head: { kind: 'branch', branch: 'topic', commit: head(linked) }, dirty: false }]);
  });
});

describe('IsolationPreview — HEAD states', () => {
  it('names a detached HEAD by its short commit, not by a branch', async () => {
    const root = initRepo(tempDir());
    git(root, 'checkout', '-q', '--detach');

    const result = await preview(root);

    expect(result.status).toBe('ready');
    expect(result.repos[0].head).toEqual({ kind: 'detached', commit: head(root) });
  });

  it('has no commits to isolate in a repository that has none, and says which branch it is on', async () => {
    const root = initRepo(tempDir(), { commit: false });

    const result = await preview(root);

    expect(result).toEqual({ status: 'no-commits', repos: [{ path: '.', head: { kind: 'unborn', branch: 'main' } }], shared: [] });
  });
});

describe('IsolationPreview — when isolation is not available', () => {
  it('finds no repository in a folder with none, and says so only then', async () => {
    const ws = tempDir();
    mkdirSync(join(ws, 'docs'));

    expect(await preview(ws)).toEqual({ status: 'no-repo', repos: [], shared: [] });
  });

  it('is disabled by the setting, still showing what is there, and leaves a dirty tree uninspected', async () => {
    const root = initRepo(tempDir());
    writeFileSync(join(root, 'README.md'), 'changed\n');

    const result = await preview(root, { worktreeIsolation: false });

    expect(result).toEqual({ status: 'disabled', repos: [{ path: '.', head: { kind: 'branch', branch: 'main', commit: head(root) } }], shared: [] });
  });

  it('is dirty for modified tracked files, in the repositories that have them, and not for untracked ones', async () => {
    const ws = tempDir();
    const api = initRepo(join(ws, 'api'));
    initRepo(join(ws, 'web'));
    writeFileSync(join(api, 'untracked.txt'), 'u\n');

    expect((await preview(ws)).status).toBe('ready');

    writeFileSync(join(api, 'README.md'), 'changed\n');
    const result = await preview(ws);

    expect(result.status).toBe('dirty');
    expect(result.repos.map((r) => [r.path, r.dirty])).toEqual([['api', true], ['web', false]]);
  });

  it('has no git to ask: the repositories come off the files, with nothing known about them', async () => {
    const ws = tempDir();
    initRepo(join(ws, 'api'));
    const noGit: GitExecFn = async () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); };

    const result = await preview(ws, {}, { execFileImpl: noGit });

    expect(result).toEqual({ status: 'git-missing', repos: [{ path: 'api', head: { kind: 'unknown' } }], shared: [] });
  });

  it('is failed, not "no repository", when git cannot read a repository it found', async () => {
    const root = initRepo(tempDir());
    const brokenStatus: GitExecFn = (file, args, opts) => {
      if (args.includes('status')) return Promise.reject(Object.assign(new Error('fatal: unsafe repository'), { stderr: 'fatal: unsafe repository' }));
      return defaultExecFile(file, args, opts);
    };

    const result = await preview(root, {}, { execFileImpl: brokenStatus });

    expect(result.status).toBe('failed');
    expect(result.repos.map((r) => r.path)).toEqual(['.']);
    expect(result.error).toContain('workspace');
  });

  it('is failed, never a rejection, when inspection throws', async () => {
    const root = initRepo(tempDir());
    const config = { ...fakeConfig(), get worktreeIsolation(): boolean { throw new Error('settings unreadable'); } };

    const result = await createIsolationPreview({ config, resolvePath: async () => process.env.PATH ?? '' }).preview(root);

    expect(result).toEqual({ status: 'failed', repos: [], shared: [], error: 'settings unreadable' });
  });
});

describe('IsolationPreview — agrees with isActive and changes nothing', () => {
  it.each([
    ['one repository', (ws: string) => { initRepo(ws); }],
    ['a dirty repository', (ws: string) => { initRepo(ws); writeFileSync(join(ws, 'README.md'), 'x\n'); }],
    ['a repository with no commit', (ws: string) => { initRepo(ws, { commit: false }); }],
    ['no repository', (ws: string) => { mkdirSync(join(ws, 'docs')); }],
    ['a group', (ws: string) => { initRepo(join(ws, 'a')); initRepo(join(ws, 'b')); }],
  ])('for %s', async (_name, build) => {
    const ws = tempDir();
    build(ws);
    const config = fakeConfig({ worktreeIsolation: true });
    const deps = { config, resolvePath: async () => process.env.PATH ?? '' };

    const availability = await createWorktreeIsolation(deps).isActive(ws);
    const result = await createIsolationPreview(deps).preview(ws);

    const expected = availability.active ? 'ready' : availability.reason === 'not-git' ? 'no-repo' : availability.reason;
    expect(result.status).toBe(expected);
    if (availability.active) expect(result.shared).toEqual(availability.shared ?? []);
  });

  it('starts no run: it lists no new ref or worktree, creates no .ordewell, runs no hook, and asks git only to read', async () => {
    const root = initRepo(tempDir());
    git(root, 'branch', 'side');
    const marker = join(tempDir(), 'fsmonitor-ran');
    const hook = join(tempDir(), 'fsmonitor.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nprintf '\\0'\n`);
    chmodSync(hook, 0o755);
    git(root, 'config', 'core.fsmonitor', hook);
    const refs = () => git(root, 'for-each-ref');
    const before = { refs: refs(), worktrees: git(root, 'worktree', 'list'), stash: git(root, 'stash', 'list') };
    const subcommands: string[] = [];
    const recording: GitExecFn = (file, args, opts) => {
      subcommands.push(subcommandOf(args));
      return defaultExecFile(file, args, opts);
    };

    await preview(root, {}, { execFileImpl: recording });

    expect(refs()).toBe(before.refs);
    expect(git(root, 'worktree', 'list')).toBe(before.worktrees);
    expect(git(root, 'stash', 'list')).toBe(before.stash);
    expect(existsSync(join(root, '.ordewell'))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(subcommands.length).toBeGreaterThan(0);
    expect(subcommands.filter((c) => !['--version', 'rev-parse', 'symbolic-ref', 'status', 'ls-files', 'config'].includes(c))).toEqual([]);
  });
});
