// Fixtures and helpers shared by the GitWorktreeIsolation files (one file until it was split so CI's shards balance).

import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation, type GitExecFn, type WorktreeIsolationDeps } from '../GitWorktreeIsolation';
import type { IsolationRun } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';

// Native, as git names a path: on Windows the JS realpath keeps the 8.3 short
// name the temp folder has there, and a fixture would not match what git lists.
export const realpath = realpathSync.native;

export const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

// A git hook that runs the suite exports GIT_DIR & co., which would point every
// fixture command at the outer repository instead of the temp one.
export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}

// Skips the login-shell PATH probe: the suite is hermetic and git is already on PATH.
export const create = (deps: WorktreeIsolationDeps) =>
  createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', ...deps });

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function initRepo(root: string, files: Record<string, string> = { 'README.md': 'hello\n' }): string {
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

export function makeRepo(files?: Record<string, string>): string {
  return initRepo(realpath(mkdtempSync(join(tmpdir(), 'ordewell-wt-'))), files);
}

export function task(order: number, title: string): Task {
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

export function worktreePaths(root: string): string[] {
  return git(root, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => realpathSafe(l.slice('worktree '.length)));
}

/**
 * Rewrite a worktree's `.git` file as a task could. Replaced, not written over:
 * Git for Windows hides it, and Windows creates no file over a hidden one.
 */
export function replaceGitFile(worktree: string, content: string): void {
  rmSync(join(worktree, '.git'));
  writeFileSync(join(worktree, '.git'), content);
}

/**
 * Whether `p` leads live to `target` as the platform links without privilege
 * (ADR-0010): a symlink, or on Windows a hard link for a file, which is the
 * file itself rather than a link to it.
 */
export function linksTo(p: string, target: string): boolean {
  const here = lstatSync(p);
  if (here.isSymbolicLink()) return realpath(p) === realpath(target);
  const there = statSync(target);
  return process.platform === 'win32' && here.isFile() && here.dev === there.dev && here.ino === there.ino;
}

export function lexists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

export function realpathSafe(p: string): string {
  try { return realpath(p); } catch { return p; }
}

export function branches(root: string, pattern = 'ordewell/*'): string[] {
  return git(root, 'branch', '--list', pattern, '--format=%(refname:short)').split('\n').filter(Boolean);
}

export const execFileAsync = promisify(execFile);

/** The git subcommand an invocation runs, past any `-c key=value` it starts with. */
export function subcommand(args: string[]): string | undefined {
  let i = 0;
  while (args[i] === '-c') i += 2;
  return args[i];
}

/** Real git, except that `git worktree add` fails in the given repositories. */
export function refuseWorktreesIn(...repoRoots: string[]): GitExecFn {
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
export function crashAt(at: (args: string[], cwd: string | undefined) => boolean): { exec: GitExecFn; crashed: () => boolean } {
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

export const roots: string[] = [];

/** A setup command sh and cmd.exe run alike: node on a script of its own. */
export function setupCommand(script: string): string {
  const scripts = realpath(mkdtempSync(join(tmpdir(), 'ordewell-setup-')));
  roots.push(scripts);
  writeFileSync(join(scripts, 'setup.cjs'), script);
  return `"${process.execPath}" "${join(scripts, 'setup.cjs')}"`;
}
export function repo(files?: Record<string, string>): string {
  const root = makeRepo(files);
  roots.push(root);
  return root;
}
// A folder that is not a repository: three repositories with commits, one
// with none, a loose file, a loose directory, and a gitignored `.env`.
export function group(): string {
  const dir = realpath(mkdtempSync(join(tmpdir(), 'ordewell-group-')));
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

export const GROUP = ['api', 'infra', 'web'];

// Two repositories in a folder, each with a file two tasks can collide on.
export function pair(): string {
  const dir = realpath(mkdtempSync(join(tmpdir(), 'ordewell-pair-')));
  roots.push(dir);
  initRepo(join(dir, 'api'), { 'api.txt': 'api\n' });
  initRepo(join(dir, 'web'), { 'web.txt': 'web\n' });
  return dir;
}
export const integrationOf = (run: IsolationRun) => `ordewell/${run.id}/integration`;
export const tip = (dir: string, repo: string, run: IsolationRun) => git(join(dir, repo), 'rev-parse', integrationOf(run));
