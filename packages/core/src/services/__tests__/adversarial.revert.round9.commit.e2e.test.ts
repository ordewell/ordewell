import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-round9-commit-')));
  temps.push(dir);
  return dir;
}
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

const task = (order: number, title: string): Task => ({ id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [], assignedRunner: 'claude-code' });
const nothingInTheWay = { refusal: () => null, persist: () => undefined, settled: () => undefined };
const integrationDir = (root: string, run: { id: string }): string => join(root, '.ordewell', 'worktrees', run.id, 'integration');

/** `stage` runs once, once the revert has judged everything and saved its tips. */
function stagingOnce(stage: () => void): typeof nothingInTheWay {
  let staged = false;
  return { ...nothingInTheWay, persist: () => { if (!staged) stage(); staged = true; } };
}
function isolation(): IWorktreeIsolation {
  return createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) });
}

describe('a change staged while a revert that goes cleanly runs', () => {
  it('is not committed as part of the revert', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const a = task(1, 'A');
    const pa = await iso.prepare(a, run);
    writeFileSync(join(pa.cwd, 'a.txt'), 'a\n');
    expect(await iso.integrate(a, run)).toBe('merged');
    const dir = integrationDir(root, run);
    const watch = stagingOnce(() => {
      writeFileSync(join(dir, 'user.txt'), 'mine\n');
      git(dir, 'add', 'user.txt');
    });

    expect(await iso.revert(run, [a.id], watch)).toMatchObject({ outcome: 'reverted' });

    const files = git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
    expect(files).not.toContain('user.txt');
    expect(git(dir, 'status', '--porcelain')).toBe('A  user.txt');
  });
});

describe('a change staged while a group revert commits the first repo then fails in the second', () => {
  it('is not committed and then lost by the rollback', async () => {
    const root = tempDir();
    initRepo(join(root, 'api'));
    initRepo(join(root, 'web'));
    writeFileSync(join(root, 'web', 'shared.txt'), 'base\n');
    git(join(root, 'web'), 'add', '-A');
    git(join(root, 'web'), 'commit', '-q', '-m', 'shared');
    const iso = isolation();
    const run = await iso.startRun(root);
    const api = run.repos.find((r) => r.path === 'api')!;
    const a = task(1, 'A');
    const pa = await iso.prepare(a, run);
    writeFileSync(join(pa.cwd, 'api', 'a.txt'), 'a\n');
    writeFileSync(join(pa.cwd, 'web', 'shared.txt'), 'A\n');
    expect(await iso.integrate(a, run)).toBe('merged');
    const b = task(2, 'B');
    const pb = await iso.prepare(b, run);
    writeFileSync(join(pb.cwd, 'web', 'shared.txt'), 'B\n');
    expect(await iso.integrate(b, run)).toBe('merged');
    const tip = git(api.root, 'rev-parse', api.integrationBranch);

    const apiDir = integrationDir(root, run) + '/api';
    const watch = stagingOnce(() => {
      writeFileSync(join(apiDir, 'user.txt'), 'mine\n');
      git(apiDir, 'add', 'user.txt');
    });

    expect(await iso.revert(run, [a.id], watch)).toMatchObject({ outcome: 'conflict', repo: 'web' });

    expect(git(api.root, 'rev-parse', api.integrationBranch)).toBe(tip);
    expect({ exists: existsSync(join(apiDir, 'user.txt')), files: git(apiDir, 'status', '--porcelain') })
      .toEqual({ exists: true, files: 'A  user.txt' });
  });
});
