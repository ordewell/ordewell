import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { createTask } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { INotification } from '../../interfaces/INotification';
import { fakeConfig, FakeRunnerSession, homeEnv, removeDir, setEnv } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { cleanEnv, hasGit } from './gitWorktreeIsolationKit';

const roots: string[] = [];
let restoreEnv: () => void = () => undefined;
afterEach(async () => {
  restoreEnv();
  while (roots.length) await removeDir(roots.pop()!);
});

function tempDir(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ordewell-ident-')));
  roots.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * A host where git knows nobody: a home of its own and a global config with
 * nothing in it but `useConfigOnly`, which stops git guessing a name from the
 * account and host as it can on some machines, so every host refuses alike.
 */
let globalConfig = '';
beforeEach(() => {
  const home = tempDir();
  globalConfig = join(home, 'gitconfig');
  writeFileSync(globalConfig, '[user]\n\tuseConfigOnly = true\n');
  restoreEnv = setEnv({
    ...homeEnv(home),
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: undefined,
    GIT_AUTHOR_EMAIL: undefined,
    GIT_COMMITTER_NAME: undefined,
    GIT_COMMITTER_EMAIL: undefined,
    EMAIL: undefined,
  });
});

/** A repository whose one commit names its author on the command line, so none is left configured. */
function repo(): string {
  const root = tempDir();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-q', '-m', 'initial');
  return root;
}

function setIdentity(root: string): void {
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
}

function unsetIdentity(root: string): void {
  git(root, 'config', '--unset', 'user.name');
  git(root, 'config', '--unset', 'user.email');
}

/** A runner that writes one file per attempt in the directory it was handed, then passes. */
function writingRunner(onSpawn: () => void = () => undefined) {
  const runner: IRunner = {
    spawn: vi.fn(async (opts) => {
      const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
      onSpawn();
      setTimeout(() => {
        writeFileSync(join(opts.cwd!, `${opts.taskId}.txt`), `written by ${opts.taskId}\n`);
        session.reportComplete({ status: 'done', summary: 'Done.' });
      }, 5);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
  return runner;
}

function said(notifications: INotification): string {
  return [notifications.info, notifications.warn, notifications.error]
    .flatMap((fn) => vi.mocked(fn).mock.calls.map((call) => String(call[0])))
    .join('\n');
}

function compose(root: string, onSpawn?: () => void) {
  const runner = writingRunner(onSpawn);
  const notifications = fakeNotification();
  const isolation = createWorktreeIsolation({ config: fakeConfig({ worktreeIsolation: true }), resolvePath: async () => process.env.PATH ?? '' });
  const orchestrator = TaskOrchestrator.compose({ config: fakeConfig(), notifications, runner, output: new BufferedTaskOutputSource(), isolation, workspaceRoot: () => root });
  return { orchestrator, runner, notifications };
}

describe.skipIf(!hasGit)('a landing git cannot commit for want of an identity', () => {
  it('waits on the user as a landing failure, naming git\'s refusal and the fix, never a conflict', async () => {
    const root = repo();
    setIdentity(root);
    // Lost while the task runs, past the start's own check: what is left is the landing's commit.
    const { orchestrator, notifications } = compose(root, () => unsetIdentity(root));
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Write a file', prompt: 'write' })]);
    await orchestrator.approveReview();

    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')?.status).toBe('awaiting_user'));
    expect(orchestrator.storeInstance.get('t1')?.awaitingReason).toBe('landing-failed');
    const text = said(notifications);
    expect(text).toContain('Author identity unknown');
    expect(text).toMatch(/user\.name/);
    expect(text).toMatch(/user\.email/);
    expect(text).not.toMatch(/conflict/i);
  });

  it('lands the kept work once git can commit, without running the task again', async () => {
    const root = repo();
    setIdentity(root);
    const { orchestrator, runner } = compose(root, () => unsetIdentity(root));
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Write a file', prompt: 'write' })]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')?.awaitingReason).toBe('landing-failed'));

    setIdentity(root);
    await orchestrator.landKeptWork('t1');

    expect(orchestrator.storeInstance.get('t1')?.status).toBe('completed');
    expect(runner.spawn).toHaveBeenCalledTimes(1);
    const integration = git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/ordewell/*/integration');
    expect(git(root, 'show', `${integration}:t1.txt`)).toBe('written by t1');
    expect(git(root, 'log', '-1', '--format=%an', `${integration}^2`)).toBe('Test');
  });
});

describe.skipIf(!hasGit)('a worktree whose work git could not commit for want of an identity', () => {
  it('names the fix rather than a save by hand, and keeps the work on the next start once git can commit', async () => {
    const root = repo();
    setIdentity(root);
    let spawns = 0;
    const { orchestrator, runner, notifications } = compose(root, () => { if (++spawns === 1) unsetIdentity(root); });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Write a file', prompt: 'write' })]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')?.awaitingReason).toBe('landing-failed'));

    // A fresh attempt keeps the last one's work first, which is a commit too.
    const refused = await orchestrator.retryTask('t1').then(() => said(notifications), (err: unknown) => String(err));
    expect(refused).toMatch(/user\.name[\s\S]*user\.email/);
    expect(refused).not.toMatch(/by hand/);
    expect(runner.spawn).toHaveBeenCalledTimes(1);

    setIdentity(root);
    await orchestrator.retryTask('t1');
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')?.status).toBe('completed'));
    expect(runner.spawn).toHaveBeenCalledTimes(2);
    // The first attempt's work, kept on a branch of its own rather than lost to the fresh one.
    const kept = git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/ordewell-preserved/');
    expect(kept).not.toBe('');
    expect(git(root, 'show', `${kept.split('\n')[0]}:t1.txt`)).toBe('written by t1');
  });
});

describe.skipIf(!hasGit)('an isolated run git could not commit for', () => {
  it('is refused before its first task runs, naming the fix, and starts once git can commit', async () => {
    const root = repo();
    const { orchestrator, runner, notifications } = compose(root);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Write a file', prompt: 'write' })]);
    await orchestrator.approveReview();

    expect(runner.spawn).not.toHaveBeenCalled();
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('pending');
    expect(orchestrator.isRunning).toBe(false);
    const text = said(notifications);
    expect(text).toMatch(/user\.name/);
    expect(text).toMatch(/user\.email/);
    expect(text).not.toMatch(/conflict/i);
    // No identity made up for the user: their config is as it was.
    expect(() => git(root, 'config', 'user.name')).toThrow();

    setIdentity(root);
    await orchestrator.start();
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')?.status).toBe('completed'));
    expect(runner.spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses an explicit start with the fix, and runs nothing', async () => {
    const root = repo();
    const { orchestrator, runner } = compose(root);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Write a file', prompt: 'write' })]);

    await expect(orchestrator.forceStartTask('t1')).rejects.toThrow(/user\.name[\s\S]*user\.email/);
    expect(runner.spawn).not.toHaveBeenCalled();
  });
});
