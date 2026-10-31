import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';
import { handoffOf } from '../isolationRecord';
import { inBranchRefusal } from '../taskRevert';

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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-round9-')));
  temps.push(dir);
  return dir;
}
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

const task = (order: number, title: string): Task => ({ id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [], assignedRunner: 'claude-code' });
function isolation(): IWorktreeIsolation {
  return createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) });
}
async function land(iso: IWorktreeIsolation, run: Parameters<typeof iso.prepare>[1], t: Task, files: Record<string, string>): Promise<void> {
  const { cwd } = await iso.prepare(t, run);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  expect(await iso.integrate(t, run)).toBe('merged');
}

describe('a new branch takes the base name, at the integration tip, while the real base is elsewhere', () => {
  it('does not read the landing as merged, and still hands the work over', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    const integration = run.repos[0].integrationBranch;
    const landing = git(root, 'rev-parse', integration);

    // The user renames their branch away and starts a new main at the integration
    // tip, to read the work. Their own branch, trunk, does not hold it.
    git(root, 'branch', '-m', 'main', 'trunk');
    git(root, 'branch', 'main', integration);
    git(root, 'switch', '-q', 'trunk');
    expect(() => git(root, 'merge-base', '--is-ancestor', landing, 'trunk')).toThrow();

    const changed = await iso.findInHead(run);
    const inHead = run.tasks[landed.id]?.inHead;
    const handoff = handoffOf(run).landed.map((t) => t.taskId);
    const read = await iso.readLanded(run, [landed.id]);
    const commands = read.ok ? read.inBranch : [];
    const message = inBranchRefusal(commands).message;

    // ADR-0054: only the user's own branch, the one the run started on under any
    // name its reflog gives it, reads as merged. A new branch taking the old name
    // is a review, so the gate stays closed and the run hands the work over.
    expect({ changed, inHead, handoff }).toEqual({ changed: [], inHead: undefined, handoff: [landed.id] });
    // The review branch is only in the way: the user is told to clear it.
    expect(commands.map((c) => ({ heldBy: c.heldBy, merged: c.merged }))).toEqual([{ heldBy: ['main'], merged: false }]);
    expect(message).toContain('delete "main"');
  });

  it('reads as merged once the renamed branch holds it, whatever the new branch does', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    const integration = run.repos[0].integrationBranch;
    git(root, 'branch', '-m', 'main', 'trunk');
    git(root, 'branch', 'main', integration);
    git(root, 'merge', '-q', '--no-edit', integration);

    await iso.findInHead(run);

    expect(run.tasks[landed.id]?.inHead).toBe(true);
  });

  it('follows a branch renamed away and back', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    git(root, 'branch', '-m', 'main', 'trunk');
    git(root, 'branch', '-m', 'trunk', 'main');
    git(root, 'merge', '-q', '--no-edit', run.repos[0].integrationBranch);

    await iso.findInHead(run);

    expect(run.tasks[landed.id]?.inHead).toBe(true);
  });
});

describe('a branch renamed from the base name before the run started', () => {
  it('says nothing of the run, so the branch under that name is still the user\'s', async () => {
    const root = initRepo(tempDir());
    git(root, 'branch', '-m', 'main', 'legacy');
    git(root, 'switch', '-q', '-c', 'main');
    writeFileSync(join(root, 'since.txt'), 'since\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'since the rename');
    const iso = isolation();
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });

    await iso.findInHead(run);

    expect(run.tasks[landed.id]?.inHead).toBe(true);
  });
});
