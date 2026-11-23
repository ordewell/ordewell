import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import type { ExecutionActor } from '../../models/Execution';
import type { Session } from '../createSession';
import { fakeConfig, FakeRunnerSession, removeDir } from '../../testing';
import { makeSession, taskOf } from './sessionTestKit';

/**
 * A task stopped mid-attempt, seen from the caller that retries it: the
 * supervisor, which in a recorded run stopped a task after 81 minutes of
 * committed work, was refused its continue, and told the fresh retry's note
 * to build on commits the new worktree did not hold.
 */

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const roots: string[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.stopExecution();
  while (roots.length) await removeDir(roots.pop()!);
});

function repo(): string {
  // Native, as git names a path: on Windows the JS realpath keeps the 8.3 short name of the temp folder.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ordewell-stopped-retry-')));
  roots.push(root);
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

const SUPERVISOR: ExecutionActor = { kind: 'supervisor', level: 'act' };

async function stoppedWithCommits() {
  const root = repo();
  const requests: RunnerSpawnOptions[] = [];
  const runner: IRunner = {
    spawn: vi.fn(async (opts) => {
      requests.push(opts);
      return new FakeRunnerSession(`s${requests.length}`, opts.taskId, opts.resumeSessionId ?? `native-${requests.length}`);
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
  const config = fakeConfig({ worktreeIsolation: true, autonomousMode: true });
  const session = makeSession({
    runner,
    config,
    isolation: createWorktreeIsolation({ config, resolvePath: async () => process.env.PATH ?? '', mintRunId: () => 'stop-run' }),
    workspaceRoot: () => root,
  });
  sessions.push(session);
  const now = new Date().toISOString();
  const plan: LegacyPlanState = {
    tasks: [createTask({ id: 't1', order: 1, title: 'Build the module', prompt: 'Build the module', assignedRunner: 'claude-code', taskMode: 'acceptEdits' })],
    generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now,
  };
  session.loadPlan(plan, 'goal', root, { persist: false });
  await session.execute({ command: 'run_plan' }, { kind: 'user' });
  await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 20_000 });
  const first = requests[0].cwd!;
  writeFileSync(join(first, 'module.txt'), 'module work\n');
  git(first, 'add', 'module.txt');
  git(first, 'commit', '-q', '-m', 'module work so far');
  expect(await session.execute({ command: 'stop_task', task: 't1' }, SUPERVISOR)).toMatchObject({ ok: true });
  expect(taskOf(session, 't1')!.status).toBe('pending');
  return { root, session, requests, first };
}

describe.skipIf(!hasGit)('a task stopped mid-attempt, retried', () => {
  it('from "session" continues in a worktree that holds the stopped attempt\'s commits', async () => {
    const { session, requests, first } = await stoppedWithCommits();

    const outcome = await session.execute({ command: 'retry_task', task: 't1', from: 'session', message: 'Commit what works and finish the module' }, SUPERVISOR);

    expect(outcome).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 20_000 });
    expect(requests[1].resumeSessionId).toBe('native-1');
    expect(requests[1].cwd).toBe(first);
    expect(readFileSync(join(requests[1].cwd!, 'module.txt'), 'utf8')).toBe('module work\n');
  });

  it('from "fresh" answers what the new attempt starts from and which branch holds the stopped attempt\'s commits', async () => {
    const { root, session, requests } = await stoppedWithCommits();

    const outcome = await session.execute({ command: 'retry_task', task: 't1', from: 'fresh', message: 'Build on the module work already committed in your worktree' }, SUPERVISOR);

    await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 20_000 });
    expect(existsSync(join(requests[1].cwd!, 'module.txt'))).toBe(false);
    expect(git(root, 'show', 'ordewell-preserved/stop-run/1-build-the-module:module.txt')).toBe('module work');
    expect(outcome).toEqual({
      ok: true,
      message: 'Retrying task #1 "Build the module". It starts from the integration tip, branch `ordewell/stop-run/integration`, not from the earlier attempt\'s worktree: '
        + 'the work that attempt had not landed is on branch `ordewell-preserved/stop-run/1-build-the-module`, not in the new worktree. '
        + 'If it should build on that work, tell it with message_task to merge that branch.',
    });
  });
});
