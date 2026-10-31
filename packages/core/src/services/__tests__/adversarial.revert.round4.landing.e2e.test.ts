import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import type { IsolationRun, IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';

/**
 * ADR-0054: "Each is `git revert -m 1` of a merge that landed the task." A
 * landing commits wherever the run's integration worktree has HEAD (it is
 * reused whenever `<dir>/.git` exists, GitWorktreeIsolation.ts:1660), and then
 * `land` records `rev-parse <integrationBranch>` as the task's landed tip
 * (:1311-1323) whether or not the branch moved. With the worktree on another
 * branch, the tip recorded for the landing is the *previous* task's landing,
 * and reverting this task reverts that one.
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
function tempDir(): string { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-r4l-'))); temps.push(dir); return dir; }
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });
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

describe('ADVERSARIAL: a landing made with the integration worktree off its branch', () => {
  it('records the previous task landing as this task\'s, so reverting this task takes that one out', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const first = task(1, 'Add greeting');
    await land(iso, run, first, { 'greeting.txt': 'hi\n' });
    const firstLanding = git(root, 'rev-parse', integration);
    const dir = join(root, '.ordewell', 'worktrees', run.id, 'integration');
    // A review checkout in the run's own worktree, as ADR-0054 names.
    git(dir, 'checkout', '-q', '-b', 'review');

    const second = task(2, 'Add farewell');
    await land(iso, run, second, { 'farewell.txt': 'bye\n' });
    // The second landing the code recorded is the first task's merge.
    expect(run.landings?.[second.id]?.['.']).toEqual([firstLanding]);
    // ... and its own work never reached the integration branch.
    expect(git(root, 'ls-tree', '--name-only', integration).split('\n')).not.toContain('farewell.txt');

    // Back on the branch, the revert the preview offers for `second` must not take `first`'s work.
    git(dir, 'checkout', '-q', integration);
    expect(await iso.revert(run, [second.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });
    expect(git(root, 'ls-tree', '--name-only', integration).split('\n')).toContain('greeting.txt');
  });
});
