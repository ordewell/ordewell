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

/**
 * t0 lands; t1, beside it, fails with commits in its worktree, which is kept,
 * and the run ends on that failure. Then the user merges what landed with
 * Merge all, which leaves the run for its failed task.
 */
async function failedBesideMerged() {
  const root = repo();
  const requests: RunnerSpawnOptions[] = [];
  const sessionsOf = new Map<string, FakeRunnerSession>();
  const runner: IRunner = {
    spawn: vi.fn(async (opts) => {
      requests.push(opts);
      const runnerSession = new FakeRunnerSession(`s${requests.length}`, opts.taskId, opts.resumeSessionId ?? `native-${requests.length}`);
      sessionsOf.set(opts.taskId, runnerSession);
      return runnerSession;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
  let ids = 0;
  const config = fakeConfig({ worktreeIsolation: true, autonomousMode: true });
  const session = makeSession({
    runner,
    config,
    isolation: createWorktreeIsolation({ config, resolvePath: async () => process.env.PATH ?? '', mintRunId: () => `run-${++ids}` }),
    workspaceRoot: () => root,
  });
  sessions.push(session);
  const now = new Date().toISOString();
  const plan: LegacyPlanState = {
    tasks: [
      createTask({ id: 't0', order: 1, title: 'Write the docs', prompt: 'Write the docs', assignedRunner: 'claude-code', taskMode: 'acceptEdits' }),
      createTask({ id: 't1', order: 2, title: 'Build the module', prompt: 'Build the module', assignedRunner: 'claude-code', taskMode: 'acceptEdits' }),
    ],
    generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now,
  };
  session.loadPlan(plan, 'goal', root, { persist: false });
  await session.execute({ command: 'run_plan' }, { kind: 'user' });
  await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 20_000 });
  const docs = requests.find((r) => r.taskId === 't0')!.cwd!;
  writeFileSync(join(docs, 'docs.txt'), 'docs\n');
  sessionsOf.get('t0')!.reportComplete({ status: 'done', summary: 'Wrote the docs.' });
  await vi.waitFor(() => expect(taskOf(session, 't0')!.status).toBe('completed'), { timeout: 20_000 });
  const first = requests.find((r) => r.taskId === 't1')!.cwd!;
  writeFileSync(join(first, 'module.txt'), 'module work\n');
  git(first, 'add', 'module.txt');
  git(first, 'commit', '-q', '-m', 'module work so far');
  sessionsOf.get('t1')!.emitExit(1);
  await vi.waitFor(() => expect(taskOf(session, 't1')!.status).toBe('failed'), { timeout: 20_000 });
  await vi.waitFor(() => expect(session.runSnapshot().activity?.running).toBe(false), { timeout: 20_000 });
  expect(await session.execute({ command: 'merge_all' }, { kind: 'user' })).toMatchObject({ ok: true });
  expect(readFileSync(join(root, 'docs.txt'), 'utf8')).toBe('docs\n');
  expect(session.planState?.isolation?.run.id).toBe('run-1');
  return { root, session, requests };
}

describe.skipIf(!hasGit)('a task failed beside landed work the user merged, retried from "fresh"', () => {
  it('by the user, starts in a new run from their branch, and names its integration branch and the preserved one', async () => {
    const { root, session, requests } = await failedBesideMerged();

    const outcome = await session.execute({ command: 'retry_task', task: 't1', from: 'fresh', message: 'Build on the module work' }, { kind: 'user' });

    await vi.waitFor(() => expect(requests).toHaveLength(3), { timeout: 20_000 });
    expect(session.planState?.isolation?.run.id).toBe('run-2');
    expect(session.planState?.isolation?.run.repos[0].baseRef).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(existsSync(join(requests[2].cwd!, 'docs.txt'))).toBe(true);
    expect(existsSync(join(requests[2].cwd!, 'module.txt'))).toBe(false);
    expect(outcome).toEqual({
      ok: true,
      message: 'Retrying task #2 "Build the module". It starts from the integration tip, branch `ordewell/run-2/integration`, not from the earlier attempt\'s worktree: '
        + 'the work that attempt had not landed is on branch `ordewell-preserved/run-1/2-build-the-module`, not in the new worktree. '
        + 'If it should build on that work, tell it with message_task to merge that branch.',
    });
    expect(git(root, 'rev-parse', '--verify', '--quiet', 'refs/heads/ordewell/run-2/integration')).not.toBe('');
    expect(git(root, 'show', 'ordewell-preserved/run-1/2-build-the-module:module.txt')).toBe('module work');
    expect(git(root, 'branch', '--list', 'ordewell/run-1/*')).toBe('');
  });

  it('by the supervisor, continues the run it failed in, which the user\'s own start alone replaces (ADR-0028)', async () => {
    const { root, session, requests } = await failedBesideMerged();

    const outcome = await session.execute({ command: 'retry_task', task: 't1', from: 'fresh', message: 'Build on the module work' }, SUPERVISOR);

    await vi.waitFor(() => expect(requests).toHaveLength(3), { timeout: 20_000 });
    expect(session.planState?.isolation?.run.id).toBe('run-1');
    expect(outcome.message).toContain('branch `ordewell/run-1/integration`');
    expect(git(root, 'rev-parse', '--verify', '--quiet', 'refs/heads/ordewell/run-1/integration')).not.toBe('');
    expect(git(root, 'show', 'ordewell-preserved/run-1/2-build-the-module:module.txt')).toBe('module work');
  });
});

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
