import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { createTask } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { fakeNotification } from './sessionTestKit';

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const roots: string[] = [];
const orchestrators: TaskOrchestrator[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const orchestrator of orchestrators.splice(0)) {
    orchestrator.stop();
    if (orchestrator.runs.planIsolation) await orchestrator.runs.discard();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-continue-e2e-')));
  roots.push(root);
  return root;
}

function repo(root = tempDir()): string {
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'feature.txt'), 'initial implementation\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

function setup(root: string, isolated = true, workspaceRepos: string[] = []) {
  const sessions: FakeRunnerSession[] = [];
  const requests: RunnerSpawnOptions[] = [];
  const runner: IRunner = {
    spawn: vi.fn(async (opts) => {
      requests.push(opts);
      const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId, opts.resumeSessionId ?? `native-${opts.taskId}`);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
  const config = fakeConfig({ worktreeIsolation: isolated, workspaceRepos });
  const orchestrator = TaskOrchestrator.compose({
    config,
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    isolation: createWorktreeIsolation({ config, resolvePath: async () => process.env.PATH ?? '', mintRunId: () => 'continue-run' }),
    workspaceRoot: () => root,
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  orchestrators.push(orchestrator);
  orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Implement feature', prompt: 'Implement the feature' })]);
  const task = () => orchestrator.storeInstance.get('t1')!;
  return { orchestrator, sessions, requests, task };
}

describe.skipIf(!hasGit)('continued attempts keep their previous work', () => {
  it('an automatic usage-limit resume sees the tracked and untracked edits left uncommitted', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-11T17:00:00Z') });
    const root = repo();
    const h = setup(root);
    await h.orchestrator.forceStartTask('t1');
    writeFileSync(join(h.requests[0].cwd, 'feature.txt'), 'half implemented\n');
    writeFileSync(join(h.requests[0].cwd, 'new.txt'), 'new implementation\n');
    const limit = "You've hit your session limit · resets 8:10pm (UTC)";
    h.sessions[0].emitEvent({ type: 'error', message: limit });
    h.sessions[0].emitOutput(limit);
    h.sessions[0].emitTurnEnd('failed');
    await vi.waitFor(() => expect(h.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' }), { timeout: 20_000 });
    expect(h.task().resumeAt).toBe('2026-10-11T20:11:00.000Z');

    await vi.advanceTimersByTimeAsync(Date.parse('2026-10-11T20:11:00Z') - Date.now());
    await vi.waitFor(() => expect(h.requests).toHaveLength(2), { timeout: 20_000 });

    const resumed = h.requests[1];
    expect(readFileSync(join(resumed.cwd, 'feature.txt'), 'utf8')).toBe('half implemented\n');
    expect(readFileSync(join(resumed.cwd, 'new.txt'), 'utf8')).toBe('new implementation\n');
    expect(resumed.resumeSessionId).toBe('native-t1');
    expect(resumed.prompt).toContain('Your previous changes are in the working tree');
    expect(resumed.prompt).not.toContain('may not be in it');
    expect(readFileSync(join(root, 'feature.txt'), 'utf8')).toBe('initial implementation\n');
  });

  it('a conflicting integration change falls back to the integration tip and names the branch holding the previous work', async () => {
    const root = repo();
    const h = setup(root);
    h.orchestrator.storeInstance.add(createTask({ id: 't2', order: 2, title: 'Other change', prompt: 'Make another change' }));
    await h.orchestrator.forceStartTask('t1');
    await h.orchestrator.forceStartTask('t2');
    writeFileSync(join(h.requests[0].cwd, 'feature.txt'), 'half implemented\n');
    h.sessions[0].emitExit(1);
    await vi.waitFor(() => expect(h.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' }), { timeout: 20_000 });
    writeFileSync(join(h.requests[1].cwd, 'feature.txt'), 'landed implementation\n');
    h.sessions[1].reportComplete({ status: 'done', summary: 'Other change' });
    await vi.waitFor(() => expect(h.orchestrator.storeInstance.get('t2')?.status).toBe('completed'), { timeout: 20_000 });

    await h.orchestrator.continueTask('t1', 'Finish the implementation');

    expect(h.requests).toHaveLength(3);
    const resumed = h.requests[2];
    expect(readFileSync(join(resumed.cwd, 'feature.txt'), 'utf8')).toBe('landed implementation\n');
    expect(git(resumed.cwd, 'status', '--porcelain')).toBe('');
    const kept = 'ordewell-preserved/continue-run/1-implement-feature';
    expect(resumed.prompt).toContain('conflicted');
    expect(resumed.prompt).toContain('integration tip');
    expect(resumed.prompt).toContain(`git log ${kept}`);
    expect(resumed.prompt).toContain(`git diff HEAD...${kept}`);
    expect(resumed.prompt).not.toContain('Your previous changes are in the working tree');
    expect(git(root, 'show', `${kept}:feature.txt`)).toBe('half implemented');
  });

  it('a shared run continues in the checkout with its uncommitted work already in place', async () => {
    const root = repo();
    const h = setup(root, false);
    await h.orchestrator.forceStartTask('t1');
    writeFileSync(join(root, 'feature.txt'), 'half implemented\n');
    writeFileSync(join(root, 'new.txt'), 'new implementation\n');
    h.sessions[0].emitExit(1);
    await vi.waitFor(() => expect(h.task().status).toBe('failed'), { timeout: 20_000 });

    await h.orchestrator.continueTask('t1', 'Finish the implementation');

    const resumed = h.requests[1];
    expect(resumed.cwd).toBe(root);
    expect(readFileSync(join(resumed.cwd, 'feature.txt'), 'utf8')).toBe('half implemented\n');
    expect(readFileSync(join(resumed.cwd, 'new.txt'), 'utf8')).toBe('new implementation\n');
    expect(git(root, 'diff', '--name-only')).toBe('feature.txt');
    expect(resumed.prompt).toContain('Your previous changes are in the working tree');
    expect(resumed.prompt).toContain('shared workspace');
    expect(resumed.resumeSessionId).toBe('native-t1');
  });

  it('a manual continue keeps commits, staged edits and deletions while including work landed meanwhile', async () => {
    const root = repo();
    writeFileSync(join(root, 'removed.txt'), 'remove this\n');
    git(root, 'add', 'removed.txt');
    git(root, 'commit', '-q', '-m', 'add removable file');
    const h = setup(root);
    h.orchestrator.storeInstance.add(createTask({ id: 't2', order: 2, title: 'Other change', prompt: 'Make another change' }));
    await h.orchestrator.forceStartTask('t1');
    await h.orchestrator.forceStartTask('t2');
    const firstCwd = h.requests[0].cwd;
    writeFileSync(join(firstCwd, 'committed.txt'), 'committed implementation\n');
    git(firstCwd, 'add', 'committed.txt');
    git(firstCwd, 'commit', '-q', '-m', 'implementation so far');
    writeFileSync(join(firstCwd, 'feature.txt'), 'staged implementation\n');
    git(firstCwd, 'add', 'feature.txt');
    writeFileSync(join(firstCwd, 'feature.txt'), 'latest implementation\n');
    rmSync(join(firstCwd, 'removed.txt'));
    h.sessions[0].emitExit(1);
    await vi.waitFor(() => expect(h.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' }), { timeout: 20_000 });
    writeFileSync(join(h.requests[1].cwd, 'landed.txt'), 'other task implementation\n');
    h.sessions[1].reportComplete({ status: 'done', summary: 'Other change' });
    await vi.waitFor(() => expect(h.orchestrator.storeInstance.get('t2')?.status).toBe('completed'), { timeout: 20_000 });

    await h.orchestrator.continueTask('t1', 'Finish the implementation');

    const resumed = h.requests[2];
    expect(resumed.cwd).toBe(firstCwd);
    expect(resumed.resumeSessionId).toBe('native-t1');
    expect(readFileSync(join(resumed.cwd, 'feature.txt'), 'utf8')).toBe('latest implementation\n');
    expect(readFileSync(join(resumed.cwd, 'committed.txt'), 'utf8')).toBe('committed implementation\n');
    expect(readFileSync(join(resumed.cwd, 'landed.txt'), 'utf8')).toBe('other task implementation\n');
    expect(existsSync(join(resumed.cwd, 'removed.txt'))).toBe(false);
    expect(resumed.prompt).toContain('Your previous changes are in the working tree');
    expect(resumed.prompt).not.toContain('there only if it landed');
    h.sessions[2].reportComplete({ status: 'done', summary: 'Finished' });
    await vi.waitFor(() => expect(h.task().status).toBe('completed'), { timeout: 20_000 });
    expect(git(root, 'show', 'ordewell/continue-run/integration:feature.txt')).toBe('latest implementation');
    expect(git(root, 'show', 'ordewell/continue-run/integration:landed.txt')).toBe('other task implementation');
  });

  it('a fresh retry starts clean from the integration tip without resuming the saved session', async () => {
    const root = repo();
    const h = setup(root);
    await h.orchestrator.approveReview();
    writeFileSync(join(h.requests[0].cwd, 'feature.txt'), 'half implemented\n');
    writeFileSync(join(h.requests[0].cwd, 'new.txt'), 'new implementation\n');
    h.sessions[0].emitExit(1);
    await vi.waitFor(() => expect(h.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' }), { timeout: 20_000 });

    await h.orchestrator.retryTask('t1');

    const retried = h.requests[1];
    expect(readFileSync(join(retried.cwd, 'feature.txt'), 'utf8')).toBe('initial implementation\n');
    expect(existsSync(join(retried.cwd, 'new.txt'))).toBe(false);
    expect(retried.resumeSessionId).toBeUndefined();
    expect(retried.prompt).toContain('Implement the feature');
    expect(retried.prompt).not.toContain('Your previous changes are in the working tree');
    expect(git(root, 'show', 'ordewell-preserved/continue-run/1-implement-feature:feature.txt')).toBe('half implemented');
  });

  it('a continue restores uncommitted work in every repository of a workspace group', async () => {
    const root = tempDir();
    const firstRepo = repo(join(root, 'first'));
    const secondRepo = repo(join(root, 'nested', 'second'));
    const h = setup(root, true, ['first', 'nested/second']);
    await h.orchestrator.forceStartTask('t1');
    writeFileSync(join(h.requests[0].cwd, 'first', 'feature.txt'), 'first half implemented\n');
    writeFileSync(join(h.requests[0].cwd, 'nested', 'second', 'feature.txt'), 'second half implemented\n');
    h.sessions[0].emitExit(1);
    await vi.waitFor(() => expect(h.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' }), { timeout: 20_000 });

    await h.orchestrator.continueTask('t1', 'Finish both repositories');

    const resumed = h.requests[1];
    expect(readFileSync(join(resumed.cwd, 'first', 'feature.txt'), 'utf8')).toBe('first half implemented\n');
    expect(readFileSync(join(resumed.cwd, 'nested', 'second', 'feature.txt'), 'utf8')).toBe('second half implemented\n');
    expect(readFileSync(join(firstRepo, 'feature.txt'), 'utf8')).toBe('initial implementation\n');
    expect(readFileSync(join(secondRepo, 'feature.txt'), 'utf8')).toBe('initial implementation\n');
    expect(resumed.prompt).toContain('Your previous changes are in the working tree');
  });

  it('a conflict in one repository restores none of the previous work and names its branches in every changed repository', async () => {
    const root = tempDir();
    const firstRepo = repo(join(root, 'first'));
    const secondRepo = repo(join(root, 'second'));
    const h = setup(root);
    h.orchestrator.storeInstance.add(createTask({ id: 't2', order: 2, title: 'Other change', prompt: 'Make another change' }));
    await h.orchestrator.forceStartTask('t1');
    await h.orchestrator.forceStartTask('t2');
    writeFileSync(join(h.requests[0].cwd, 'first', 'feature.txt'), 'first half implemented\n');
    writeFileSync(join(h.requests[0].cwd, 'first', 'new.txt'), 'new implementation\n');
    writeFileSync(join(h.requests[0].cwd, 'second', 'feature.txt'), 'second half implemented\n');
    h.sessions[0].emitExit(1);
    await vi.waitFor(() => expect(h.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' }), { timeout: 20_000 });
    writeFileSync(join(h.requests[1].cwd, 'first', 'landed.txt'), 'other task implementation\n');
    writeFileSync(join(h.requests[1].cwd, 'second', 'feature.txt'), 'landed implementation\n');
    h.sessions[1].reportComplete({ status: 'done', summary: 'Other change' });
    await vi.waitFor(() => expect(h.orchestrator.storeInstance.get('t2')?.status).toBe('completed'), { timeout: 20_000 });

    await h.orchestrator.continueTask('t1', 'Finish both repositories');

    const resumed = h.requests[2];
    expect(readFileSync(join(resumed.cwd, 'first', 'feature.txt'), 'utf8')).toBe('initial implementation\n');
    expect(readFileSync(join(resumed.cwd, 'second', 'feature.txt'), 'utf8')).toBe('landed implementation\n');
    expect(readFileSync(join(resumed.cwd, 'first', 'landed.txt'), 'utf8')).toBe('other task implementation\n');
    expect(existsSync(join(resumed.cwd, 'first', 'new.txt'))).toBe(false);
    for (const name of ['first', 'second']) {
      expect(git(join(resumed.cwd, name), 'status', '--porcelain')).toBe('');
      expect(resumed.prompt).toContain(`In repository \`${name}\``);
    }
    const kept = 'ordewell-preserved/continue-run/1-implement-feature';
    expect(resumed.prompt).toContain(`git diff HEAD...${kept}`);
    expect(resumed.prompt).not.toContain('Your previous changes are in the working tree');
    expect(git(firstRepo, 'show', `${kept}:feature.txt`)).toBe('first half implemented');
    expect(git(firstRepo, 'show', `${kept}:new.txt`)).toBe('new implementation');
    expect(git(secondRepo, 'show', `${kept}:feature.txt`)).toBe('second half implemented');
  });

  it('another continue after reloading a conflict fallback still identifies the unrecovered previous work', async () => {
    const root = repo();
    const h = setup(root);
    h.orchestrator.storeInstance.add(createTask({ id: 't2', order: 2, title: 'Other change', prompt: 'Make another change' }));
    await h.orchestrator.forceStartTask('t1');
    await h.orchestrator.forceStartTask('t2');
    writeFileSync(join(h.requests[0].cwd, 'feature.txt'), 'half implemented\n');
    h.sessions[0].emitExit(1);
    await vi.waitFor(() => expect(h.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' }), { timeout: 20_000 });
    writeFileSync(join(h.requests[1].cwd, 'feature.txt'), 'landed implementation\n');
    h.sessions[1].reportComplete({ status: 'done', summary: 'Other change' });
    await vi.waitFor(() => expect(h.orchestrator.storeInstance.get('t2')?.status).toBe('completed'), { timeout: 20_000 });
    await h.orchestrator.continueTask('t1', 'Finish the implementation');
    h.sessions[2].emitExit(1);
    await vi.waitFor(() => expect(h.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' }), { timeout: 20_000 });
    const savedIsolation = structuredClone(h.orchestrator.runs.planIsolation);
    await h.orchestrator.runs.adopt(savedIsolation);

    await h.orchestrator.continueTask('t1', 'Recover the previous implementation');

    const resumed = h.requests[3];
    expect(readFileSync(join(resumed.cwd, 'feature.txt'), 'utf8')).toBe('landed implementation\n');
    expect(resumed.prompt).toContain('ordewell-preserved/continue-run/1-implement-feature');
    expect(resumed.prompt).not.toContain('Your previous changes are in the working tree');
  });

  it('an overdue usage-limit resume after a reload recovers the kept worktree in the saved session', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-11T17:00:00Z') });
    const root = repo();
    const h = setup(root);
    await h.orchestrator.forceStartTask('t1');
    writeFileSync(join(h.requests[0].cwd, 'feature.txt'), 'half implemented\n');
    const limit = "You've hit your session limit · resets 8:10pm (UTC)";
    h.sessions[0].emitOutput(limit);
    h.sessions[0].emitExit(1);
    await vi.waitFor(() => expect(h.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' }), { timeout: 20_000 });
    const savedTasks = h.orchestrator.storeInstance.snapshot();
    const savedIsolation = structuredClone(h.orchestrator.runs.planIsolation);
    h.orchestrator.stop();
    await h.orchestrator.runs.adopt(null);
    vi.setSystemTime(new Date('2026-10-11T21:00:00Z'));

    const reloaded = setup(root);
    await reloaded.orchestrator.runs.adopt(savedIsolation);
    reloaded.orchestrator.loadPlan(savedTasks);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(reloaded.requests).toHaveLength(1), { timeout: 20_000 });

    const resumed = reloaded.requests[0];
    expect(resumed.resumeSessionId).toBe('native-t1');
    expect(readFileSync(join(resumed.cwd, 'feature.txt'), 'utf8')).toBe('half implemented\n');
    expect(resumed.prompt).toContain('Your previous changes are in the working tree');
    expect(resumed.prompt).toContain('Your usage limit has reset');
  });

  it('a continue restores kept commits even if the user merged them into their own branch before continuing', async () => {
    const root = repo();
    const h = setup(root);
    await h.orchestrator.forceStartTask('t1');
    const cwd = h.requests[0].cwd;
    writeFileSync(join(cwd, 'feature.txt'), 'half implemented\n');
    git(cwd, 'add', 'feature.txt');
    git(cwd, 'commit', '-q', '-m', 'implementation so far');
    h.sessions[0].emitExit(1);
    await vi.waitFor(() => expect(h.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' }), { timeout: 20_000 });
    git(root, 'merge', '-q', '--no-edit', 'ordewell/continue-run/1-implement-feature');

    await h.orchestrator.continueTask('t1', 'Finish the implementation');

    expect(readFileSync(join(h.requests[1].cwd, 'feature.txt'), 'utf8')).toBe('half implemented\n');
    expect(h.requests[1].prompt).toContain('Your previous changes are in the working tree');
  });

  it('a continue of completed replacement work does not restore branches from an earlier conflict fallback', async () => {
    const root = repo();
    const h = setup(root);
    h.orchestrator.storeInstance.add(createTask({ id: 't2', order: 2, title: 'Other change', prompt: 'Make another change' }));
    await h.orchestrator.forceStartTask('t1');
    await h.orchestrator.forceStartTask('t2');
    writeFileSync(join(h.requests[0].cwd, 'feature.txt'), 'half implemented\n');
    h.sessions[0].emitExit(1);
    await vi.waitFor(() => expect(h.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' }), { timeout: 20_000 });
    writeFileSync(join(h.requests[1].cwd, 'feature.txt'), 'landed implementation\n');
    h.sessions[1].reportComplete({ status: 'done', summary: 'Other change' });
    await vi.waitFor(() => expect(h.orchestrator.storeInstance.get('t2')?.status).toBe('completed'), { timeout: 20_000 });
    await h.orchestrator.continueTask('t1', 'Finish the implementation');
    writeFileSync(join(h.requests[2].cwd, 'feature.txt'), 'finished replacement implementation\n');
    h.sessions[2].reportComplete({ status: 'done', summary: 'Finished the replacement' });
    await vi.waitFor(() => expect(h.task().status).toBe('completed'), { timeout: 20_000 });

    await h.orchestrator.continueTask('t1', 'Extend the finished implementation');

    const resumed = h.requests[3];
    expect(readFileSync(join(resumed.cwd, 'feature.txt'), 'utf8')).toBe('finished replacement implementation\n');
    expect(resumed.prompt).toContain('Your previous changes are in the working tree');
    expect(resumed.prompt).not.toContain('ordewell-preserved/continue-run/1-implement-feature');
    expect(git(root, 'show', 'ordewell-preserved/continue-run/1-implement-feature:feature.txt')).toBe('half implemented');
  });
});
