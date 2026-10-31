import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';
import { revertStopped } from '../taskRevert';

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-round8-')));
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

describe('the base branch renamed away, then a new branch takes its old name', () => {
  it('still refuses a revert of work the renamed branch holds', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    const before = git(root, 'rev-parse', 'main');
    const landing = git(root, 'rev-parse', run.repos[0].integrationBranch);
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    expect(await iso.findInHead(run)).toEqual([landed.id]);

    // The user renames their branch away and starts a fresh main at the old tip.
    git(root, 'branch', '-m', 'main', 'trunk');
    git(root, 'branch', 'main', before);
    git(root, 'switch', '-q', 'trunk');
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trunk');
    expect(() => git(root, 'merge-base', '--is-ancestor', landing, 'main')).toThrow();

    // The work is in the user's branch trunk, just as it was before the rename.
    const changed = await iso.findInHead(run);
    const inHead = run.tasks[landed.id]?.inHead;
    const read = await iso.readLanded(run, [landed.id]);
    const revert = await iso.revert(run, [landed.id], nothingInTheWay);
    expect({
      changed,
      inHead,
      inBranch: read.ok ? read.inBranch.map((c) => c.commit) : read.reason,
      revert: revert.outcome,
    }).toEqual({
      changed: [],
      inHead: true,
      inBranch: [expect.any(String)],
      revert: 'in-branch',
    });
  });
});

describe('what stops a revert', () => {
  async function oneLanding() {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    return { root, iso, run, landed, integration: run.repos[0].integrationBranch };
  }
  const refusal = async (iso: IWorktreeIsolation, run: Parameters<typeof iso.prepare>[1], id: string): Promise<string> => {
    const result = await iso.revert(run, [id], nothingInTheWay);
    if (result.outcome === 'reverted') throw new Error('it reverted');
    return revertStopped(result);
  };

  it('never tells the user to delete their own branch', async () => {
    const { iso, run, landed } = await oneLanding();
    await iso.mergeIntoCheckedOut(run);

    const message = await refusal(iso, run, landed.id);

    expect(message).toContain('already in "main"');
    expect(message).not.toContain('delete');
  });

  it('says to delete a branch that may only be a review, and goes through once it has gone', async () => {
    const { root, iso, run, landed, integration } = await oneLanding();
    git(root, 'branch', 'review', integration);

    const message = await refusal(iso, run, landed.id);

    expect(message).toContain('already in "review"');
    expect(message).toContain('If that is only a review, delete "review" first, then revert again.');
    git(root, 'branch', '-D', 'review');
    expect(await iso.revert(run, [landed.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });
  });

  it('names a detached HEAD past any tip of Ordewell\'s, and lets it go once it stands on one', async () => {
    const { root, iso, run, landed, integration } = await oneLanding();
    git(root, 'checkout', '-q', '--detach', integration);
    expect(await iso.readLanded(run, [landed.id])).toMatchObject({ ok: true, inBranch: [] });

    git(root, 'commit', '-q', '--allow-empty', '-m', 'A note of the reviewer');

    expect(await refusal(iso, run, landed.id)).toContain('If that is only a review, check out something else first, then revert again.');
    git(root, 'checkout', '-q', 'main');
    expect(await iso.revert(run, [landed.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });
  });

  it('takes a base branch of Ordewell\'s own name for the user\'s, as a run nested in another\'s worktree has', async () => {
    const root = initRepo(tempDir());
    git(root, 'checkout', '-q', '-b', 'ordewell/outer/task');
    const iso = isolation();
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    await iso.mergeIntoCheckedOut(run);

    expect(await iso.findInHead(run)).toEqual([landed.id]);
    expect(await iso.readLanded(run, [landed.id])).toMatchObject({ ok: true, inBranch: [{ heldBy: ['ordewell/outer/task'], merged: true }] });
  });
});

describe('the loss it allows', () => {
  it('lets a later Merge all remove the work the user had merged', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    const before = git(root, 'rev-parse', 'main');
    await iso.mergeIntoCheckedOut(run);

    // The user renames trunk away and starts main again at the old tip.
    git(root, 'branch', '-m', 'main', 'trunk');
    git(root, 'branch', 'main', before);
    git(root, 'switch', '-q', 'trunk');

    // Ordewell offers and makes the revert, though the work is in trunk.
    const revert = await iso.revert(run, [landed.id], nothingInTheWay);

    // The user puts the run's base name back where their branch is, and Merge all.
    git(root, 'branch', '-D', 'main');
    git(root, 'branch', '-m', 'trunk', 'main');
    const merge = await iso.mergeIntoCheckedOut(run);
    const greeting = (() => { try { return git(root, 'show', 'main:greeting.txt'); } catch { return null; } })();

    expect({ revert: revert.outcome, merge: merge.outcome, greeting }).toEqual({
      revert: 'in-branch',
      merge: 'merged',
      greeting: 'hi',
    });
  });
});
