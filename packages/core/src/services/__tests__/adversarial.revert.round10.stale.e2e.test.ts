import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { defaultExecFile, type GitExecFn } from '../gitExec';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function initRepo(root: string, files: Record<string, string> = {}): string {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}
const temps: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-r10-stale-')));
  temps.push(dir);
  return dir;
}
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

const task = (order: number, title: string): Task => ({ id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [], assignedRunner: 'claude-code' });
const nothingInTheWay = { refusal: () => null, persist: () => undefined, settled: () => undefined };
const integrationDir = (root: string, run: { id: string }, repo: string): string => join(root, '.ordewell', 'worktrees', run.id, 'integration', repo);

describe('a worktree left out of step by a rollback that cannot read the worktrees', () => {
  it('is put back with its branch, so a later landing still lands', async () => {
    const root = tempDir();
    initRepo(join(root, 'api'));
    const webRoot = join(root, 'web');
    initRepo(webRoot, { 'shared.txt': 'base\n' });
    let calls = 0;
    let failing = false;
    const exec: GitExecFn = async (file, args, opts) => {
      if (failing && file === 'git' && args[0] === 'worktree' && args[1] === 'list' && ++calls === 4) {
        const err = new Error('cannot list worktrees') as Error & { code: number; stdout: string; stderr: string };
        err.code = 128; err.stdout = ''; err.stderr = 'fatal: cannot list worktrees';
        throw err;
      }
      return defaultExecFile(file, args, opts);
    };
    const iso = createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec });
    const run = await iso.startRun(root);
    const [api] = run.repos;
    const a = task(1, 'A');
    const pa = await iso.prepare(a, run);
    writeFileSync(join(pa.cwd, 'api/a.txt'), 'a\n');
    writeFileSync(join(pa.cwd, 'web/shared.txt'), 'A\n');
    expect(await iso.integrate(a, run)).toBe('merged');
    const b = task(2, 'B');
    const pb = await iso.prepare(b, run);
    writeFileSync(join(pb.cwd, 'web/shared.txt'), 'B\n');
    expect(await iso.integrate(b, run)).toBe('merged');
    const apiTip = git(api.root, 'rev-parse', api.integrationBranch);
    const apiDir = integrationDir(root, run, 'api');
    failing = true;

    const result = await iso.revert(run, [a.id], nothingInTheWay);
    failing = false;

    // The api revert was rolled back with the branch, whatever git said about worktrees.
    expect(result).toMatchObject({ outcome: 'conflict', repo: 'web' });
    expect(git(api.root, 'rev-parse', api.integrationBranch)).toBe(apiTip);
    expect(git(apiDir, 'status', '--porcelain', '--untracked-files=no')).toBe('');

    // And what landed after still lands on the tip the branch names.
    const c = task(3, 'C');
    const pc = await iso.prepare(c, run);
    writeFileSync(join(pc.cwd, 'api/c.txt'), 'c\n');
    expect(await iso.integrate(c, run)).toBe('merged');
    expect(git(api.root, 'show', `${api.integrationBranch}:c.txt`)).toBe('c');
  });

  it('stays recorded when nothing but the list could say a checkout is not under the branch', async () => {
    const root = tempDir();
    initRepo(join(root, 'api'));
    const webRoot = join(root, 'web');
    initRepo(webRoot, { 'shared.txt': 'base\n' });
    let armed = false;
    let failing = false;
    const exec: GitExecFn = async (file, args, opts) => {
      if (armed && file === 'git' && args[0] === 'merge-tree' && opts.cwd === webRoot) {
        // Mid-revert, with api's branch moved: the user checks it out, and git then cannot list where it is.
        armed = false;
        failing = true;
        git(join(root, 'api'), 'switch', '-q', run.repos[0].integrationBranch);
      }
      if (failing && file === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        const err = new Error('cannot list worktrees') as Error & { code: number; stdout: string; stderr: string };
        err.code = 128; err.stdout = ''; err.stderr = 'fatal: cannot list worktrees';
        throw err;
      }
      return defaultExecFile(file, args, opts);
    };
    const iso = createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec });
    const run = await iso.startRun(root);
    const [api] = run.repos;
    const a = task(1, 'A');
    const pa = await iso.prepare(a, run);
    writeFileSync(join(pa.cwd, 'api/a.txt'), 'a\n');
    writeFileSync(join(pa.cwd, 'web/shared.txt'), 'A\n');
    expect(await iso.integrate(a, run)).toBe('merged');
    const b = task(2, 'B');
    const pb = await iso.prepare(b, run);
    writeFileSync(join(pb.cwd, 'web/shared.txt'), 'B\n');
    expect(await iso.integrate(b, run)).toBe('merged');
    await iso.handoff(run);
    const apiTip = git(api.root, 'rev-parse', api.integrationBranch);
    armed = true;

    const result = await iso.revert(run, [a.id], nothingInTheWay);

    // Git cannot say who holds the branch and the run has no worktree of its own to ask, so it does not move under the checkout.
    expect(result).toMatchObject({ outcome: 'failed', error: expect.stringContaining('could not be put back in api') });
    expect(git(api.root, 'rev-parse', api.integrationBranch)).not.toBe(apiTip);
    expect(git(api.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(run.landing?.tips.api).toBe(apiTip);
  });
});
