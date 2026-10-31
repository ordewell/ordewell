import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { defaultExecFile, type GitExecFn } from '../gitExec';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { Task } from '../../models/Task';
import { fakeConfig } from '../../testing';

/**
 * ADR-0054: tracked changes in the integration worktree are refused, and a
 * change made there since the revert started stays as it was, staged or not.
 * A conflicting revert resets that worktree hard, so a user change staged
 * while `git revert` runs is lost; only a two-tree read keeps it.
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
  writeFileSync(join(root, 'shared.txt'), 'base\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}
const temps: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-round8-staged-')));
  temps.push(dir);
  return dir;
}
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

const task = (order: number, title: string): Task => ({ id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [], assignedRunner: 'claude-code' });
const nothingInTheWay = { refusal: () => null, persist: () => undefined, settled: () => undefined };
async function land(iso: IWorktreeIsolation, run: Parameters<typeof iso.prepare>[1], t: Task, append: string): Promise<void> {
  const { cwd } = await iso.prepare(t, run);
  writeFileSync(join(cwd, 'shared.txt'), `base\n${append}\n`);
  expect(await iso.integrate(t, run)).toBe('merged');
}

/** `stage` runs in the integration worktree just before the first `git revert`, past the check that comes before it. */
function isolationStaging(stage: (dir: string, opts: Parameters<GitExecFn>[2]) => Promise<void>): IWorktreeIsolation {
  let staged = false;
  const exec: GitExecFn = async (file, args, opts) => {
    if (file === 'git' && args.includes('revert') && args.includes('--no-commit') && opts.cwd && !staged) {
      staged = true;
      await stage(opts.cwd, opts);
    }
    return defaultExecFile(file, args, opts);
  };
  return createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec });
}
const integrationDir = (root: string, run: { id: string }): string => join(root, '.ordewell', 'worktrees', run.id, 'integration');

describe('a user change staged while a conflicting revert runs', () => {
  it('stays, as a change the rollback must not lose', async () => {
    const root = initRepo(tempDir());
    const iso = isolationStaging(async (dir, opts) => {
      writeFileSync(join(dir, 'user.txt'), 'mine\n');
      await defaultExecFile('git', ['add', 'user.txt'], opts);
    });
    const run = await iso.startRun(root);
    const a = task(1, 'A');
    const b = task(2, 'B');
    await land(iso, run, a, 'A');
    await land(iso, run, b, 'B');
    const dir = integrationDir(root, run);

    // Reverting A conflicts with B's change to the same file.
    expect(await iso.revert(run, [a.id], nothingInTheWay)).toMatchObject({ outcome: 'conflict' });
    expect({ exists: existsSync(join(dir, 'user.txt')), content: existsSync(join(dir, 'user.txt')) ? readFileSync(join(dir, 'user.txt'), 'utf8') : null })
      .toEqual({ exists: true, content: 'mine\n' });
    // Nothing of the revert stays, and no revert is left in progress.
    expect(git(dir, 'status', '--porcelain')).toBe('A  user.txt');
    expect(() => git(dir, 'rev-parse', '--verify', '-q', 'REVERT_HEAD')).toThrow();
  });

  it('takes off what the revert wrote cleanly as well as what it conflicted over', async () => {
    const root = initRepo(tempDir());
    const iso = isolationStaging(async (dir, opts) => {
      writeFileSync(join(dir, 'user.txt'), 'mine\n');
      await defaultExecFile('git', ['add', 'user.txt'], opts);
    });
    const run = await iso.startRun(root);
    const a = task(1, 'A');
    const { cwd } = await iso.prepare(a, run);
    writeFileSync(join(cwd, 'shared.txt'), 'base\nA\n');
    writeFileSync(join(cwd, 'added.txt'), 'added\n');
    expect(await iso.integrate(a, run)).toBe('merged');
    await land(iso, run, task(2, 'B'), 'B');
    const dir = integrationDir(root, run);

    expect(await iso.revert(run, [a.id], nothingInTheWay)).toMatchObject({ outcome: 'conflict', files: ['shared.txt'] });
    expect(readFileSync(join(dir, 'added.txt'), 'utf8')).toBe('added\n');
    expect(readFileSync(join(dir, 'shared.txt'), 'utf8')).toBe('base\nB\n');
    expect(git(dir, 'status', '--porcelain')).toBe('A  user.txt');
  });

  it('holds a change on a path the revert wrote, reporting it, rather than overwrite it', async () => {
    const root = initRepo(tempDir());
    const exec: GitExecFn = async (file, args, opts) => {
      const result = await defaultExecFile(file, args, opts).catch((err: unknown) => err);
      // Over the revert's own clean write of added.txt, before anything clears it.
      if (file === 'git' && args.includes('revert') && args.includes('--no-commit') && opts.cwd) writeFileSync(join(opts.cwd, 'added.txt'), 'edited since\n');
      if (result instanceof Error) throw result;
      return result as Awaited<ReturnType<GitExecFn>>;
    };
    const iso = createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec });
    const run = await iso.startRun(root);
    const a = task(1, 'A');
    const { cwd } = await iso.prepare(a, run);
    writeFileSync(join(cwd, 'shared.txt'), 'base\nA\n');
    writeFileSync(join(cwd, 'added.txt'), 'added\n');
    expect(await iso.integrate(a, run)).toBe('merged');
    const b = task(2, 'B');
    await land(iso, run, b, 'B');
    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);
    const dir = integrationDir(root, run);

    expect(await iso.revert(run, [a.id], nothingInTheWay)).toMatchObject({ outcome: 'failed', error: expect.stringContaining('could not be cleared') });
    expect(readFileSync(join(dir, 'added.txt'), 'utf8')).toBe('edited since\n');
    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tip);
  });
});

describe('a revert git refused before it wrote anything', () => {
  it('leaves the change that stopped it where it is', async () => {
    const root = initRepo(tempDir());
    const iso = isolationStaging(async (dir) => writeFileSync(join(dir, 'shared.txt'), 'base\nA\nmine\n'));
    const run = await iso.startRun(root);
    const a = task(1, 'A');
    await land(iso, run, a, 'A');
    const dir = integrationDir(root, run);

    expect(await iso.revert(run, [a.id], nothingInTheWay)).toMatchObject({ outcome: 'failed' });
    expect(readFileSync(join(dir, 'shared.txt'), 'utf8')).toBe('base\nA\nmine\n');
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
  });
});

describe('a change staged on the path a revert then conflicted over', () => {
  it('stays in the conflict, reported, since restoring that path would lose it', async () => {
    const root = initRepo(tempDir());
    const iso = isolationStaging(async (dir, opts) => {
      writeFileSync(join(dir, 'shared.txt'), 'base\nB\nmine\n');
      await defaultExecFile('git', ['add', 'shared.txt'], opts);
    });
    const run = await iso.startRun(root);
    const a = task(1, 'A');
    await land(iso, run, a, 'A');
    await land(iso, run, task(2, 'B'), 'B');
    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);
    const dir = integrationDir(root, run);

    expect(await iso.revert(run, [a.id], nothingInTheWay)).toMatchObject({ outcome: 'failed', error: expect.stringContaining('could not be cleared') });
    expect(git(dir, 'show', ':2:shared.txt')).toBe('base\nB\nmine');
    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tip);
  });
});

describe('a revert whose commit a hook refused', () => {
  it('takes off what it staged, keeps what someone else staged, and ends the revert', async () => {
    const root = initRepo(tempDir());
    const iso = isolationStaging(async (dir, opts) => {
      writeFileSync(join(dir, 'user.txt'), 'mine\n');
      await defaultExecFile('git', ['add', 'user.txt'], opts);
    });
    const run = await iso.startRun(root);
    const a = task(1, 'A');
    await land(iso, run, a, 'A');
    const dir = integrationDir(root, run);
    const hooks = join(root, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);

    expect(await iso.revert(run, [a.id], nothingInTheWay)).toMatchObject({ outcome: 'failed', task: { taskId: a.id } });

    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tip);
    expect(git(dir, 'status', '--porcelain')).toBe('A  user.txt');
    expect(readFileSync(join(dir, 'shared.txt'), 'utf8')).toBe('base\nA\n');
    expect(() => git(dir, 'rev-parse', '--verify', '-q', 'REVERT_HEAD')).toThrow();
  });
});

describe('a revert that follows a file a later landing renamed', () => {
  it('takes that file off under its new name too', async () => {
    const root = initRepo(tempDir());
    writeFileSync(join(root, 'long.txt'), `${Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')}\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'a long file');
    const iso = isolationStaging(async () => undefined);
    const run = await iso.startRun(root);
    const a = task(1, 'A');
    const prepared = await iso.prepare(a, run);
    writeFileSync(join(prepared.cwd, 'shared.txt'), 'base\nA\n');
    writeFileSync(join(prepared.cwd, 'long.txt'), `${Array.from({ length: 40 }, (_, i) => (i === 0 ? 'changed' : `line ${i}`)).join('\n')}\n`);
    expect(await iso.integrate(a, run)).toBe('merged');
    const b = task(2, 'B');
    const moved = await iso.prepare(b, run);
    git(moved.cwd, 'mv', 'long.txt', 'moved.txt');
    writeFileSync(join(moved.cwd, 'shared.txt'), 'base\nB\n');
    expect(await iso.integrate(b, run)).toBe('merged');
    const dir = integrationDir(root, run);

    expect(await iso.revert(run, [a.id], nothingInTheWay)).toMatchObject({ outcome: 'conflict', files: ['shared.txt'] });
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });
});
