import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
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
  writeFileSync(join(root, 'shared.txt'), 'base\n');
  writeFileSync(join(root, 'long.txt'), `${Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')}\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}
const temps: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-round9-rename-')));
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

describe('a change staged while a conflicting revert runs, on a file a later landing renamed', () => {
  it('stays, since the revert never wrote that path', async () => {
    const root = initRepo(tempDir());
    const iso = isolation();
    const run = await iso.startRun(root);
    const a = task(1, 'A');
    const pa = await iso.prepare(a, run);
    writeFileSync(join(pa.cwd, 'shared.txt'), 'base\nA\n');
    expect(await iso.integrate(a, run)).toBe('merged');
    // B renames an unrelated file and changes shared.txt, so reverting A conflicts.
    const b = task(2, 'B');
    const pb = await iso.prepare(b, run);
    git(pb.cwd, 'mv', 'long.txt', 'moved.txt');
    writeFileSync(join(pb.cwd, 'shared.txt'), 'base\nB\n');
    expect(await iso.integrate(b, run)).toBe('merged');
    const dir = integrationDir(root, run);

    const watch = stagingOnce(() => {
      writeFileSync(join(dir, 'moved.txt'), `${Array.from({ length: 40 }, (_, i) => (i === 0 ? 'mine' : `line ${i}`)).join('\n')}\n`);
      git(dir, 'add', 'moved.txt');
    });

    expect(await iso.revert(run, [a.id], watch)).toMatchObject({ outcome: 'conflict', files: ['shared.txt'] });

    // The user's change is on a path the revert never wrote. It must stay.
    expect(existsSync(join(dir, 'moved.txt')) ? readFileSync(join(dir, 'moved.txt'), 'utf8') : null)
      .toBe(`${Array.from({ length: 40 }, (_, i) => (i === 0 ? 'mine' : `line ${i}`)).join('\n')}\n`);
  });
});
