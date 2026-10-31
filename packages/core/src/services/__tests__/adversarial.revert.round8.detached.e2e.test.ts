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

/**
 * ADR-0054: Ordewell's own branches, `ordewell-preserved/` included, are no
 * one's. A run started detached has no base branch, so `inUserBranch` reads a
 * detached HEAD's own line; a detached HEAD standing on a preserved branch's
 * tip (a merge of the integration branch off its first parent) is therefore
 * read as the user's, even though the preserved branch is Ordewell's.
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-round8-detached-')));
  temps.push(dir);
  return dir;
}
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

const task = (order: number, title: string): Task => ({ id: `task-${order}`, order, title, description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [], assignedRunner: 'claude-code' });
async function land(iso: IWorktreeIsolation, run: Parameters<typeof iso.prepare>[1], t: Task, files: Record<string, string>): Promise<void> {
  const { cwd } = await iso.prepare(t, run);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  expect(await iso.integrate(t, run)).toBe('merged');
}

describe('a detached HEAD standing on a preserved branch tip, with no base branch', () => {
  /** A run started detached, so a detached HEAD speaks for it, with a landing Ordewell preserved a merge of. */
  async function preservedMerge() {
    const root = initRepo(tempDir());
    const base = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', '--detach', base);
    const iso = createWorktreeIsolation({ resolvePath: async () => process.env.PATH ?? '', config: fakeConfig({ worktreeIsolation: true }) });
    const run = await iso.startRun(root);
    const landed = task(1, 'Add greeting');
    await land(iso, run, landed, { 'greeting.txt': 'hi\n' });

    // A worktree left on the base plus a merge of the integration branch, then
    // released: Ordewell keeps it on refs/heads/ordewell-preserved/.
    const preview = task(2, 'Preview');
    const { cwd } = await iso.prepare(preview, run);
    git(cwd, 'reset', '-q', '--hard', base);
    git(cwd, 'merge', '-q', '--no-ff', '--no-edit', run.repos[0].integrationBranch);
    await iso.release(run, preview.id, { keep: false });
    const preserved = git(root, 'for-each-ref', '--format=%(refname)', 'refs/heads/ordewell-preserved/').split(/\r?\n/).filter(Boolean);
    expect(preserved).toHaveLength(1);
    return { root, iso, run, landed, tip: preserved[0] };
  }

  it('does not make the preserved merge the user branch', async () => {
    const { root, iso, run, landed, tip } = await preservedMerge();
    // The user checks the preserved work out to inspect it; HEAD is detached.
    git(root, 'checkout', '-q', '--detach', tip);

    const changed = await iso.findInHead(run);
    const inHead = run.tasks[landed.id]?.inHead;
    const read = await iso.readLanded(run, [landed.id]);
    const inBranch = read.ok ? read.inBranch.map((c) => c.commit) : read.reason;
    expect({ changed, inHead, inBranch, handoff: handoffOf(run).landed.map((t) => t.taskId) }).toEqual({
      changed: [],
      inHead: undefined,
      inBranch: [],
      handoff: [landed.id],
    });
  });

  it.each([
    ['detached, with a commit of its own', (root: string, tip: string) => git(root, 'checkout', '-q', '--detach', tip), 'HEAD'],
    ['on a branch cut from it, with a commit of its own', (root: string, tip: string) => git(root, 'checkout', '-q', '-b', 'review', tip), 'review'],
  ])('is no merge %s either, and stops a revert until it goes', async (_name, checkOut, holder) => {
    const { root, iso, run, landed, tip } = await preservedMerge();
    checkOut(root, tip);
    git(root, 'commit', '-q', '--allow-empty', '-m', 'A note of the reviewer');

    expect(await iso.findInHead(run)).toEqual([]);
    expect(handoffOf(run).landed.map((t) => t.taskId)).toEqual([landed.id]);
    expect(await iso.readLanded(run, [landed.id])).toMatchObject({ ok: true, inBranch: [{ heldBy: [holder], merged: false }] });
  });
});
