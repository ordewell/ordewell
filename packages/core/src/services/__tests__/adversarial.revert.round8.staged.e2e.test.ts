import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
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
function isolation(): IWorktreeIsolation {
  return createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) });
}
async function land(iso: IWorktreeIsolation, run: Parameters<typeof iso.prepare>[1], t: Task, append: string): Promise<void> {
  const { cwd } = await iso.prepare(t, run);
  writeFileSync(join(cwd, 'shared.txt'), `base\n${append}\n`);
  expect(await iso.integrate(t, run)).toBe('merged');
}

const integrationDir = (root: string, run: { id: string }): string => join(root, '.ordewell', 'worktrees', run.id, 'integration');

/** `stage` runs once, once the revert has judged everything and saved its tips. */
function stagingOnce(stage: () => void): typeof nothingInTheWay {
  let staged = false;
  return { ...nothingInTheWay, persist: () => { if (!staged) stage(); staged = true; } };
}

describe('a user change staged while a conflicting revert runs', () => {
  it('stays, and no revert is left in progress', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const a = task(1, 'A');
    await land(iso, run, a, 'A');
    await land(iso, run, task(2, 'B'), 'B');
    const dir = integrationDir(root, run);
    const watch = stagingOnce(() => {
      writeFileSync(join(dir, 'user.txt'), 'mine\n');
      git(dir, 'add', 'user.txt');
    });

    // Reverting A conflicts with B's change to the same file.
    expect(await iso.revert(run, [a.id], watch)).toMatchObject({ outcome: 'conflict' });
    expect(readFileSync(join(dir, 'user.txt'), 'utf8')).toBe('mine\n');
    expect(git(dir, 'status', '--porcelain')).toBe('A  user.txt');
    expect(() => git(dir, 'rev-parse', '--verify', '-q', 'REVERT_HEAD')).toThrow();
  });

  it('writes nothing of a revert that conflicted, on any path', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
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
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });
});

describe('a change on a path the revert touches', () => {
  it('stops it when it comes after the look, and stays as it was', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const a = task(1, 'A');
    await land(iso, run, a, 'A');
    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);
    const dir = integrationDir(root, run);
    const watch = stagingOnce(() => writeFileSync(join(dir, 'shared.txt'), 'base\nA\nmine\n'));

    expect(await iso.revert(run, [a.id], watch)).toMatchObject({ outcome: 'failed', error: expect.stringContaining('shared.txt') });
    expect(readFileSync(join(dir, 'shared.txt'), 'utf8')).toBe('base\nA\nmine\n');
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tip);
    expect(run.landing).toBeUndefined();
  });

  it('stays staged when the revert conflicts over that path', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const a = task(1, 'A');
    await land(iso, run, a, 'A');
    await land(iso, run, task(2, 'B'), 'B');
    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);
    const dir = integrationDir(root, run);
    const watch = stagingOnce(() => {
      writeFileSync(join(dir, 'shared.txt'), 'base\nB\nmine\n');
      git(dir, 'add', 'shared.txt');
    });

    expect(await iso.revert(run, [a.id], watch)).toMatchObject({ outcome: 'conflict', files: ['shared.txt'] });
    expect(git(dir, 'show', ':shared.txt')).toBe('base\nB\nmine');
    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tip);
  });
});

describe('a revert commit git would not make', () => {
  it('keeps what someone staged and leaves the branch', async () => {
    const root = initRepo(tempDir());
    const exec: GitExecFn = (file, args, opts) => (args[0] === 'commit-tree'
      ? Promise.reject(Object.assign(new Error('refused'), { stderr: 'refused', code: 1 }))
      : defaultExecFile(file, args, opts));
    const iso = createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }), execFileImpl: exec });
    const run = await iso.startRun(root);
    const a = task(1, 'A');
    await land(iso, run, a, 'A');
    const dir = integrationDir(root, run);
    const tip = git(root, 'rev-parse', run.repos[0].integrationBranch);
    const watch = stagingOnce(() => {
      writeFileSync(join(dir, 'user.txt'), 'mine\n');
      git(dir, 'add', 'user.txt');
    });

    expect(await iso.revert(run, [a.id], watch)).toMatchObject({ outcome: 'failed', task: { taskId: a.id } });

    expect(git(root, 'rev-parse', run.repos[0].integrationBranch)).toBe(tip);
    expect(git(dir, 'status', '--porcelain')).toBe('A  user.txt');
    expect(readFileSync(join(dir, 'shared.txt'), 'utf8')).toBe('base\nA\n');
  });
});

describe('a commit hook', () => {
  it('does not run for a revert commit, which `commit-tree` makes', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const a = task(1, 'A');
    await land(iso, run, a, 'A');
    const hooks = join(root, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    expect(await iso.revert(run, [a.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });
  });
});

describe('a repository that signs its commits', () => {
  it('signs the revert commit', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const a = task(1, 'A');
    await land(iso, run, a, 'A');
    const signer = join(root, '.git', 'fake-gpg');
    writeFileSync(signer, '#!/bin/sh\ncat >/dev/null\necho "[GNUPG:] SIG_CREATED D 1 8 00 0 0" >&2\necho "-----BEGIN PGP SIGNATURE-----"\necho "fake"\necho "-----END PGP SIGNATURE-----"\n', { mode: 0o755 });
    git(root, 'config', 'gpg.program', signer);
    git(root, 'config', 'user.signingkey', 'test');
    git(root, 'config', 'commit.gpgsign', 'true');

    expect(await iso.revert(run, [a.id], nothingInTheWay)).toMatchObject({ outcome: 'reverted' });

    expect(git(root, 'cat-file', 'commit', run.repos[0].integrationBranch)).toContain('gpgsig -----BEGIN PGP SIGNATURE-----');
  });
});

describe('a revert that follows a file a later landing renamed', () => {
  it('takes that file off under its new name too', async () => {
    const root = initRepo(tempDir());
    writeFileSync(join(root, 'long.txt'), `${Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')}\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'a long file');
    const iso = isolation();
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
