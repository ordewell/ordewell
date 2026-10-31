import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';
import { handoffOf, taskIsolationsOf } from '../isolationRecord';

/**
 * ADR-0054: "Ordewell's own branches are no one's." `preserve()` keeps unlanded
 * work on `ordewell-preserved/<run>/<task>`, deliberately outside `ordewell/`
 * so no clean-up deletes it. `inUserBranch` filters only `ordewell/`, so a
 * preserved branch that holds a landing off its first-parent line (a worktree
 * left on a line that merged the integration branch from an earlier base) is
 * read as the user's: the landing is marked inHead, dropped from the handoff,
 * and its revert refused with a command for a branch that never had it.
 */

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function initRepo(root: string, files: Record<string, string> = { 'README.md': 'hello\n' }): string {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}
const temps: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-preserved-')));
  temps.push(dir);
  return dir;
}
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

const task = (order: number, title: string): Task => ({ id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [], assignedRunner: 'claude-code' });
function isolation(): IWorktreeIsolation {
  return createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) });
}
const nothingInTheWay = { refusal: () => null, persist: () => undefined, settled: () => undefined };
async function land(iso: IWorktreeIsolation, run: Parameters<typeof iso.prepare>[1], t: Task, files: Record<string, string>): Promise<void> {
  const { cwd } = await iso.prepare(t, run);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  expect(await iso.integrate(t, run)).toBe('merged');
}

describe('a branch Ordewell preserved is no one\'s branch', () => {
  it('does not make a landing it holds off its first-parent line work in the user\'s branch', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const integration = run.repos[0].integrationBranch;
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    const merge = git(root, 'rev-parse', integration);

    // A task worktree left on the base plus a merge of the integration branch:
    // a runner recovering its branch (or checking out a line that merged it).
    const preview = task(2, 'Preview');
    const { cwd } = await iso.prepare(preview, run);
    git(cwd, 'reset', '-q', '--hard', 'main');
    git(cwd, 'merge', '-q', '--no-ff', '--no-edit', integration);
    // Removing the attempt keeps what it holds on Ordewell's own preserved branch.
    await iso.release(run, preview.id, { keep: false });
    const preserved = git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads/ordewell-preserved/').split(/\r?\n/).filter(Boolean);
    expect(preserved).toHaveLength(1);
    expect(preserved[0].startsWith('refs/heads/ordewell-preserved/')).toBe(true);
    // The landing is in it, off its first-parent line, and not in main.
    expect(git(root, 'rev-list', '--first-parent', preserved[0]).split('\n')).not.toContain(merge);
    expect(() => git(root, 'merge-base', '--is-ancestor', merge, preserved[0])).not.toThrow();
    expect(() => git(root, 'merge-base', '--is-ancestor', merge, 'main')).toThrow();

    const read = await iso.readLanded(run, [landed.id]);
    expect(read).toMatchObject({ ok: true, inBranch: [] });
    expect(await iso.findInHead(run)).toEqual([]);
    expect(handoffOf(run).landed.map((t) => t.taskId)).toEqual([landed.id]);
    expect(await iso.revert(run, [landed.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });
    expect(existsSync(join(root, 'greeting.txt'))).toBe(false);
  });
});

describe('the base branch under another name', () => {
  it('still holds a fast-forward Merge all, so the revert is refused with its command', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    const merge = git(root, 'rev-parse', run.repos[0].integrationBranch);
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    expect(await iso.findInHead(run)).toEqual([landed.id]);
    // The merge fast-forwarded, so the landing is on the renamed branch's first-parent line.
    expect(git(root, 'rev-list', '--first-parent', 'main').split('\n')).toContain(merge);

    git(root, 'branch', '-m', 'main', 'first');
    git(root, 'branch', '-m', 'first', 'trunk');

    expect(await iso.findInHead(run)).toEqual([]);
    expect(run.tasks[landed.id].inHead).toBe(true);
    expect(await iso.readLanded(run, [landed.id])).toMatchObject({ ok: true, inBranch: [{ commit: merge }] });
    expect(await iso.revert(run, [landed.id], nothingInTheWay)).toMatchObject({ outcome: 'in-branch' });
  });

  it('is not found in a branch merely cut from it', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    git(root, 'switch', '-q', '-c', 'cut', run.repos[0].integrationBranch);
    git(root, 'branch', '-D', 'main');

    expect(await iso.findInHead(run)).toEqual([]);
    expect(await iso.readLanded(run, [landed.id])).toMatchObject({ ok: true, inBranch: [{ heldBy: ['cut'], merged: false }] });
  });
});

describe('a merge read as merged and taken back out', () => {
  it('reads as not merged again, and comes back when it is merged again', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    const before = git(root, 'rev-parse', 'main');
    git(root, 'merge', '-q', '--no-edit', run.repos[0].integrationBranch);
    expect(await iso.findInHead(run)).toEqual([landed.id]);
    expect(handoffOf(run).landed).toEqual([]);

    git(root, 'reset', '-q', '--hard', before);

    expect(await iso.findInHead(run)).toEqual([landed.id]);
    expect(run.tasks[landed.id].inHead).toBeUndefined();
    expect(handoffOf(run).landed.map((t) => t.taskId)).toEqual([landed.id]);
    expect(taskIsolationsOf(run)[landed.id].revertible).toBe(true);

    git(root, 'merge', '-q', '--no-edit', run.repos[0].integrationBranch);
    expect(await iso.findInHead(run)).toEqual([landed.id]);
    expect(run.tasks[landed.id].inHead).toBe(true);
  });
});
