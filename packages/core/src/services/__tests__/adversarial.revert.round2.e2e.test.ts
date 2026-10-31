import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import type { IsolationRun, IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';

/**
 * Audit of ADR-0054's promise that the revert "adds commits and rewrites
 * nothing" and "Each is `git revert -m 1` of a merge that landed the task" on
 * the integration branch. The commits are made in the run's own integration
 * worktree (`ensureIntegrationWorktree`), which the code reuses whenever its
 * directory exists, without checking that its HEAD is the integration branch.
 */

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-revert-adv2-')));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});
function task(order: number, title: string): Task {
  return { id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [], assignedRunner: 'claude-code' };
}
function isolation(): IWorktreeIsolation {
  return createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) });
}
async function land(iso: IWorktreeIsolation, run: IsolationRun, t: Task, files: Record<string, string>): Promise<void> {
  const { cwd } = await iso.prepare(t, run);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  expect(await iso.integrate(t, run)).toBe('merged');
}
const nothingInTheWay = { refusal: () => null, persist: () => undefined, settled: () => undefined };
const treeOf = (root: string, branch: string) => git(root, 'ls-tree', '--name-only', branch).split('\n').filter(Boolean).sort();

describe('ADVERSARIAL revert: the integration worktree is not on the integration branch', () => {
  /** The preview says nothing of it, and `ensureIntegrationWorktree` (GitWorktreeIsolation.ts:1660) reuses the directory. */
  async function revertedWithWorktreeOn(head: (dir: string) => void) {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    const dir = join(root, '.ordewell', 'worktrees', run.id, 'integration');
    head(dir);
    const preview = await iso.readLanded(run, [t.id]);
    const result = await iso.revert(run, [t.id], nothingInTheWay);
    return { root, iso, run, integration, t, preview, result };
  }

  it('commits nothing to the integration branch when the worktree was switched to a review branch, but reports reverted', async () => {
    const { root, integration, result } = await revertedWithWorktreeOn((dir) => git(dir, 'checkout', '-q', '-b', 'review'));

    // What the surface was told: the preview offered it, and the revert says it went.
    expect(result).toMatchObject({ outcome: 'reverted' });
    // What ADR-0054 promises: if it reverted, the integration branch no longer holds the work.
    expect(treeOf(root, integration)).toEqual(['README.md']);
  });

  it('commits nothing to the integration branch when the worktree HEAD was detached, but reports reverted', async () => {
    const { root, integration, result } = await revertedWithWorktreeOn((dir) => git(dir, 'checkout', '-q', '--detach'));

    expect(result).toMatchObject({ outcome: 'reverted' });
    expect(treeOf(root, integration)).toEqual(['README.md']);
  });

});

describe('ADVERSARIAL revert: the work comes back with Merge all', () => {
  it('does not leave the reverted work for Merge all to bring into the user branch', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const t = task(1, 'Add greeting');
    await land(iso, run, t, { 'greeting.txt': 'hi\n' });
    const dir = join(root, '.ordewell', 'worktrees', run.id, 'integration');
    git(dir, 'checkout', '-q', '-b', 'review');

    const result = await iso.revert(run, [t.id], nothingInTheWay);
    expect(result).toMatchObject({ outcome: 'reverted' });
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    expect(existsSync(join(root, 'greeting.txt'))).toBe(false);
  });
});
