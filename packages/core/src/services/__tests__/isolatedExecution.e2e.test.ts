import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { createTask, type Task } from '../../models/Task';
import type { ITerminalRunner } from '../../interfaces/ITerminalRunner';
import type { IsolationHandoff } from '../../interfaces/IWorktreeIsolation';
import { fakeConfig, FakeTerminalSession } from '../../testing';
import { fakeNotification } from './sessionTestKit';

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-e2e-')));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

/**
 * A runner that does what a coding agent does, minus the model: writes the
 * task's file in whatever directory it was handed, then prints the marker.
 * It records whether each file its task depends on was already there.
 */
function writingRunner(files: Record<string, { name: string; needs?: string }>, tasks: Task[]) {
  const sawPredecessor: Record<string, boolean> = {};
  const runner: ITerminalRunner = {
    spawn: vi.fn(async (opts) => {
      const session = new FakeTerminalSession(`s-${opts.taskId}`, opts.taskId);
      const job = files[opts.taskId];
      const marker = tasks.find((t) => t.id === opts.taskId)!.completionMarker;
      setTimeout(() => {
        if (job.needs) sawPredecessor[opts.taskId] = existsSync(join(opts.cwd!, job.needs));
        writeFileSync(join(opts.cwd!, job.name), `written by ${opts.taskId}\n`);
        session.emitOutput(`done\n<<<ORDEWELL_DONE_${marker}>>>`);
      }, 5);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
  return { runner, sawPredecessor };
}

describe.skipIf(!hasGit)('isolated execution against a real repository', () => {
  it('lands every task on the integration branch and leaves the user\'s branch and tree untouched', async () => {
    const root = repo();
    const base = git(root, 'rev-parse', 'HEAD');
    const tasks = [
      createTask({ id: 't1', order: 1, title: 'Add a', prompt: 'write a.txt' }),
      createTask({ id: 't2', order: 2, title: 'Add b on top of a', prompt: 'write b.txt', dependencies: ['t1'] }),
    ];
    const { runner, sawPredecessor } = writingRunner({ t1: { name: 'a.txt' }, t2: { name: 'b.txt', needs: 'a.txt' } }, tasks);
    const isolation = createWorktreeIsolation({
      config: fakeConfig({ worktreeIsolation: true }),
      resolvePath: async () => process.env.PATH ?? '',
    });
    const output = new BufferedTaskOutputSource({ transcripts: { finalAssistantText: async () => null } });
    const orchestrator = new TaskOrchestrator(fakeConfig(), fakeNotification(), runner, undefined, output, isolation);
    orchestrator.setWorkspaceRoot(() => root);
    let handoff: IsolationHandoff | undefined;
    orchestrator.subscribe({ onIsolationHandoff: (h) => { handoff = h; } });
    orchestrator.loadPlan(tasks);

    await orchestrator.approveReview();
    await vi.waitFor(() => expect(handoff).toBeDefined(), { timeout: 20_000 });

    expect(orchestrator.storeInstance.allTasks.map((t) => t.status)).toEqual(['completed', 'completed']);
    expect(handoff!.landed.map((l) => l.taskId)).toEqual(['t1', 't2']);
    expect(handoff!.baseRef).toBe(base);
    expect(git(root, 'show', `${handoff!.branch}:a.txt`)).toBe('written by t1');
    expect(git(root, 'show', `${handoff!.branch}:b.txt`)).toBe('written by t2');
    expect(sawPredecessor.t2).toBe(true);

    expect(git(root, 'rev-parse', 'main')).toBe(base);
    expect(git(root, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(existsSync(join(root, 'a.txt'))).toBe(false);
    expect(existsSync(join(root, 'b.txt'))).toBe(false);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(git(root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
  }, 30_000);
});
