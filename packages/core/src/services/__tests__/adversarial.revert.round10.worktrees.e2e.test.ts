import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { defaultExecFile, type GitExecFn } from '../gitExec';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
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
function initRepo(root: string): string {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}
const temps: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-round10-wt-')));
  temps.push(dir);
  return dir;
}
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

const task = (order: number, title: string): Task => ({ id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [], assignedRunner: 'claude-code' });
const nothingInTheWay = { refusal: () => null, persist: () => undefined, settled: () => undefined };
async function land(iso: IWorktreeIsolation, run: Parameters<typeof iso.prepare>[1], t: Task, files: Record<string, string>): Promise<void> {
  const { cwd } = await iso.prepare(t, run);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  expect(await iso.integrate(t, run)).toBe('merged');
}

describe('a git failure while asking which worktree holds the integration branch', () => {
  it('does not move the branch under a checkout', async () => {
    const root = initRepo(tempDir());
    let fail = false;
    const exec: GitExecFn = async (file, args, opts) => {
      if (fail && args[0] === 'worktree' && args[1] === 'list') {
        const err = new Error('cannot list worktrees') as Error & { code: number; stdout: string; stderr: string };
        err.code = 128; err.stdout = ''; err.stderr = 'fatal: cannot list worktrees';
        throw err;
      }
      return defaultExecFile(file, args, opts);
    };
    const iso = createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec });
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const a = task(1, 'A');
    await land(iso, run, a, { 'a.txt': 'a\n' });
    await iso.handoff(run);
    // The user checks the integration branch out themselves to read it.
    git(root, 'switch', '-q', integration);
    const tip = git(root, 'rev-parse', integration);
    fail = true;

    const preview = await iso.readLanded(run, [a.id]);
    const result = await iso.revert(run, [a.id], nothingInTheWay);

    // Cannot tell which worktree holds the branch: refuse, in the preview too,
    // and leave it where the user has it rather than moving it under them.
    expect(preview).toMatchObject({ ok: false, reason: 'git' });
    expect(result.outcome).toBe('failed');
    expect(git(root, 'rev-parse', integration)).toBe(tip);
  });

  it('does not move the branch when only the last look before the move fails', async () => {
    const root = initRepo(tempDir());
    let lists = 0;
    let armed = false;
    const exec: GitExecFn = async (file, args, opts) => {
      // The first list is the check every revert starts with; the second is the look just before the branch moves.
      if (armed && args[0] === 'worktree' && args[1] === 'list' && ++lists === 2) {
        const err = new Error('cannot list worktrees') as Error & { code: number; stdout: string; stderr: string };
        err.code = 128; err.stdout = ''; err.stderr = 'fatal: cannot list worktrees';
        throw err;
      }
      return defaultExecFile(file, args, opts);
    };
    const iso = createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec });
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const a = task(1, 'A');
    await land(iso, run, a, { 'a.txt': 'a\n' });
    const tip = git(root, 'rev-parse', integration);
    armed = true;

    const result = await iso.revert(run, [a.id], nothingInTheWay);

    expect(result).toMatchObject({ outcome: 'failed', error: expect.stringContaining('could not say where the integration branch is checked out') });
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(run.landing).toBeUndefined();
    expect(run.tasks[a.id]?.status).toBe('merged');
  });

  it('refuses when git cannot say whether a detached HEAD holds the merge', async () => {
    const root = initRepo(tempDir());
    let fail = false;
    const exec: GitExecFn = async (file, args, opts) => {
      if (fail && args[0] === 'merge-base' && args[1] === '--is-ancestor' && args[3] === 'HEAD') {
        const err = new Error('cannot read objects') as Error & { code: number; stdout: string; stderr: string };
        err.code = 128; err.stdout = ''; err.stderr = 'fatal: cannot read objects';
        throw err;
      }
      return defaultExecFile(file, args, opts);
    };
    const iso = createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec });
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const a = task(1, 'A');
    await land(iso, run, a, { 'a.txt': 'a\n' });
    await iso.handoff(run);
    // The user merged it on a detached HEAD: no branch but Ordewell's holds it, only that HEAD does.
    git(root, 'switch', '-q', '--detach');
    git(root, 'merge', '-q', '--no-ff', '--no-edit', integration);
    const tip = git(root, 'rev-parse', integration);
    expect(await iso.readLanded(run, [a.id])).toMatchObject({ ok: true, inBranch: [expect.objectContaining({ heldBy: ['HEAD'] })] });
    fail = true;

    const preview = await iso.readLanded(run, [a.id]);
    const result = await iso.revert(run, [a.id], nothingInTheWay);

    expect(preview).toMatchObject({ ok: false, reason: 'git' });
    expect(result.outcome).toBe('failed');
    expect(git(root, 'rev-parse', integration)).toBe(tip);
    expect(run.tasks[a.id]?.status).toBe('merged');
  });
});
