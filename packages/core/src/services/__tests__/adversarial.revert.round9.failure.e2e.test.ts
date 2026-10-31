import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-round9-failure-')));
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

describe('a git failure while asking which branches hold the merge', () => {
  it('refuses the revert rather than reverting work the user\'s branch holds', async () => {
    const root = initRepo(tempDir());
    // for-each-ref --contains cannot answer: a lock, a corrupt ref, a filesystem error.
    const exec: GitExecFn = async (file, args, opts) => {
      if (file === 'git' && args[0] === 'for-each-ref' && args.includes('--contains')) {
        const err = new Error('for-each-ref failed') as Error & { code: number; stdout: string; stderr: string };
        err.code = 1;
        err.stdout = '';
        err.stderr = 'fatal: cannot read refs';
        throw err;
      }
      return defaultExecFile(file, args, opts);
    };
    const iso = createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec });
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    expect(await iso.mergeIntoCheckedOut(run)).toEqual({ outcome: 'merged' });
    expect(existsSync(join(root, 'greeting.txt'))).toBe(true);

    const result = await iso.revert(run, [landed.id], nothingInTheWay);
    const preview = await iso.readLanded(run, [landed.id]);
    const merged = await iso.mergeIntoCheckedOut(run);
    const greeting = (() => { try { return git(root, 'show', 'main:greeting.txt'); } catch { return null; } })();

    // Cannot be sure: refuse. The work is in main, so a revert followed by Merge all
    // removes it. Git named no branch, so the refusal names none and prints no command.
    expect({ result: result.outcome, merged: merged.outcome, greeting }).toEqual({ result: 'failed', merged: 'merged', greeting: 'hi' });
    expect(preview).toMatchObject({ ok: false, reason: 'git', error: expect.stringContaining('cannot be sure') });
  });
});

describe('a git failure while asking whether a tip of Ordewell\'s holds the merge on the checkout\'s line', () => {
  it('does not read a review of a preserved merge as merged', async () => {
    const root = initRepo(tempDir());
    const base = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', '--detach', base);
    const exec: GitExecFn = async (file, args, opts) => {
      // The own-branch query only; the branch list still answers.
      if (file === 'git' && args[0] === 'for-each-ref' && args.includes('--contains') && args.some((a) => a.includes('refs/heads/ordewell/'))) {
        const err = new Error('for-each-ref failed') as Error & { code: number; stdout: string; stderr: string };
        err.code = 1;
        err.stdout = '';
        err.stderr = 'fatal: cannot read refs';
        throw err;
      }
      return defaultExecFile(file, args, opts);
    };
    const iso = createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec });
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });
    const preview = task(2, 'Preview');
    const { cwd } = await iso.prepare(preview, run);
    git(cwd, 'reset', '-q', '--hard', base);
    git(cwd, 'merge', '-q', '--no-ff', '--no-edit', run.repos[0].integrationBranch);
    await iso.release(run, preview.id, { keep: false });
    const preserved = git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads/ordewell-preserved/').split(/\r?\n/).filter(Boolean);
    expect(preserved).toHaveLength(1);
    git(root, 'checkout', '-q', '--detach', preserved[0]);

    const changed = await iso.findInHead(run);
    const inHead = run.tasks[landed.id]?.inHead;
    expect({ changed, inHead }).toEqual({ changed: [], inHead: undefined });
  });
});
