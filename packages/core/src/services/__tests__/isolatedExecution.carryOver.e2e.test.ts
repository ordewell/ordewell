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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-carry-over-e2e-')));
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
  const notifications = fakeNotification();
  const orchestrator = TaskOrchestrator.compose({
    config,
    notifications,
    runner,
    output: new BufferedTaskOutputSource(),
    isolation: createWorktreeIsolation({ config, resolvePath: async () => process.env.PATH ?? '', mintRunId: () => 'carry-run' }),
    workspaceRoot: () => root,
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  orchestrators.push(orchestrator);
  orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Implement feature', prompt: 'Implement the feature' })]);
  const task = () => orchestrator.storeInstance.get('t1')!;
  return { orchestrator, sessions, requests, task, notifications };
}

// A reset hours ahead of the real clock: a fixed time of day is "just passed" for the hour after it, and the task would resume at once.
const LIMIT = (() => {
  const at = new Date(Date.now() + 3 * 60 * 60_000);
  const hour = at.getUTCHours() % 12 || 12;
  return `You've hit your session limit · resets ${hour}:${String(at.getUTCMinutes()).padStart(2, '0')}${at.getUTCHours() < 12 ? 'am' : 'pm'} (UTC)`;
})();

function hitLimit(session: FakeRunnerSession): void {
  session.emitEvent({ type: 'error', message: LIMIT });
  session.emitOutput(LIMIT);
  session.emitTurnEnd('failed');
}

/** What a runner change does to the task, as `PlanEditor.setTaskRunner` writes it. */
function moveTo(orchestrator: TaskOrchestrator, runner: string): void {
  orchestrator.storeInstance.update('t1', orchestrator.releaseMovedResume('t1', { assignedRunner: runner }));
  orchestrator.storeInstance.admitRunner(runner);
}

describe.skipIf(!hasGit)('a paused task moved to another runner keeps its uncommitted work', () => {
  it('starts a fresh session on the new runner from the files the paused attempt left', async () => {
    const root = repo();
    const h = setup(root);
    await h.orchestrator.approveReview();
    writeFileSync(join(h.requests[0].cwd, 'feature.txt'), 'half implemented\n');
    writeFileSync(join(h.requests[0].cwd, 'new.txt'), 'new implementation\n');
    hitLimit(h.sessions[0]);
    await vi.waitFor(() => expect(h.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' }), { timeout: 20_000 });

    moveTo(h.orchestrator, 'codex');
    await h.orchestrator.tick();

    await vi.waitFor(() => expect(h.requests).toHaveLength(2), { timeout: 20_000 });
    const moved = h.requests[1];
    expect(moved.runner).toBe('codex');
    expect(moved.resumeSessionId).toBeUndefined();
    expect(readFileSync(join(moved.cwd, 'feature.txt'), 'utf8')).toBe('half implemented\n');
    expect(readFileSync(join(moved.cwd, 'new.txt'), 'utf8')).toBe('new implementation\n');
    expect(moved.prompt).toContain('Implement the feature');
    expect(moved.prompt).toContain('## Work carried over');
    expect(moved.prompt).toContain('previous attempt on claude-code');
    expect(moved.prompt).toContain('may be unfinished');
    expect(readFileSync(join(root, 'feature.txt'), 'utf8')).toBe('initial implementation\n');

    h.sessions[1].reportComplete({ status: 'done', summary: 'Finished' });
    await vi.waitFor(() => expect(h.task().status).toBe('completed'), { timeout: 20_000 });
    expect(git(root, 'show', 'ordewell/carry-run/integration:new.txt')).toBe('new implementation');
    expect(h.task().carriedFrom).toBeUndefined();
  });

  it('starts fresh from the integration tip when the paused work conflicts with what landed, and says where that work is', async () => {
    const root = repo();
    const h = setup(root);
    h.orchestrator.storeInstance.add(createTask({ id: 't2', order: 2, title: 'Other change', prompt: 'Make another change' }));
    await h.orchestrator.forceStartTask('t1');
    await h.orchestrator.forceStartTask('t2');
    writeFileSync(join(h.requests[0].cwd, 'feature.txt'), 'half implemented\n');
    writeFileSync(join(h.requests[0].cwd, 'new.txt'), 'new implementation\n');
    hitLimit(h.sessions[0]);
    await vi.waitFor(() => expect(h.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' }), { timeout: 20_000 });
    writeFileSync(join(h.requests[1].cwd, 'feature.txt'), 'landed implementation\n');
    h.sessions[1].reportComplete({ status: 'done', summary: 'Other change' });
    await vi.waitFor(() => expect(h.orchestrator.storeInstance.get('t2')?.status).toBe('completed'), { timeout: 20_000 });

    moveTo(h.orchestrator, 'codex');
    await h.orchestrator.forceStartTask('t1');

    expect(h.requests).toHaveLength(3);
    const moved = h.requests[2];
    expect(moved.runner).toBe('codex');
    expect(moved.resumeSessionId).toBeUndefined();
    expect(readFileSync(join(moved.cwd, 'feature.txt'), 'utf8')).toBe('landed implementation\n');
    expect(existsSync(join(moved.cwd, 'new.txt'))).toBe(false);
    expect(git(moved.cwd, 'status', '--porcelain')).toBe('');
    const kept = 'ordewell-preserved/carry-run/1-implement-feature';
    expect(moved.prompt).toContain('Implement the feature');
    expect(moved.prompt).toContain('starts fresh at the integration tip');
    expect(moved.prompt).toContain(`git diff HEAD...${kept}`);
    expect(moved.prompt).not.toContain('The files in your working tree come from');
    expect(git(root, 'show', `${kept}:feature.txt`)).toBe('half implemented');
    expect(git(root, 'show', `${kept}:new.txt`)).toBe('new implementation');
    const warned = vi.mocked(h.notifications.warn).mock.calls.map(([message]) => message);
    expect(warned).toContainEqual(expect.stringMatching(new RegExp(`Task "Implement feature" starts fresh on codex.*not carried over.*${kept}`)));
  });

  it('still carries the work over when the plan is reloaded between the move and the start', async () => {
    const root = repo();
    const h = setup(root);
    await h.orchestrator.forceStartTask('t1');
    writeFileSync(join(h.requests[0].cwd, 'feature.txt'), 'half implemented\n');
    hitLimit(h.sessions[0]);
    await vi.waitFor(() => expect(h.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' }), { timeout: 20_000 });
    moveTo(h.orchestrator, 'codex');
    const savedTasks = h.orchestrator.storeInstance.snapshot();
    const savedIsolation = structuredClone(h.orchestrator.runs.planIsolation);
    h.orchestrator.stop();
    await h.orchestrator.runs.adopt(null);

    const reloaded = setup(root);
    await reloaded.orchestrator.runs.adopt(savedIsolation);
    reloaded.orchestrator.loadPlan(savedTasks, ['claude-code', 'codex']);
    await reloaded.orchestrator.forceStartTask('t1');

    const moved = reloaded.requests[0];
    expect(moved.runner).toBe('codex');
    expect(readFileSync(join(moved.cwd, 'feature.txt'), 'utf8')).toBe('half implemented\n');
    expect(moved.prompt).toContain('previous attempt on claude-code');
  });

  it('a shared run starts the new runner in the checkout, where the paused attempt left its edits', async () => {
    const root = repo();
    const h = setup(root, false);
    await h.orchestrator.forceStartTask('t1');
    writeFileSync(join(root, 'feature.txt'), 'half implemented\n');
    hitLimit(h.sessions[0]);
    await vi.waitFor(() => expect(h.task().awaitingReason).toBe('usage-limit'), { timeout: 20_000 });

    moveTo(h.orchestrator, 'codex');
    await h.orchestrator.forceStartTask('t1');

    const moved = h.requests[1];
    expect(moved.cwd).toBe(root);
    expect(moved.runner).toBe('codex');
    expect(readFileSync(join(root, 'feature.txt'), 'utf8')).toBe('half implemented\n');
    expect(moved.prompt).toContain('The files in your working tree come from a previous attempt on claude-code');
  });

  it('a fresh retry after the move starts clean, carrying nothing over', async () => {
    const root = repo();
    const h = setup(root);
    await h.orchestrator.forceStartTask('t1');
    writeFileSync(join(h.requests[0].cwd, 'feature.txt'), 'half implemented\n');
    hitLimit(h.sessions[0]);
    await vi.waitFor(() => expect(h.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' }), { timeout: 20_000 });
    moveTo(h.orchestrator, 'codex');
    await h.orchestrator.forceStartTask('t1');
    h.sessions[1].emitExit(1);
    await vi.waitFor(() => expect(h.task().status).toBe('failed'), { timeout: 20_000 });

    await h.orchestrator.retryTask('t1');
    await h.orchestrator.forceStartTask('t1');

    const retried = h.requests[2];
    expect(readFileSync(join(retried.cwd, 'feature.txt'), 'utf8')).toBe('initial implementation\n');
    expect(retried.prompt).not.toContain('## Work carried over');
  });
});

describe.skipIf(!hasGit)('a finished task moved to another runner', () => {
  it('refuses Continue, and a Retry starts a fresh session on the new runner from the files the earlier attempt left', async () => {
    const root = repo();
    const h = setup(root);
    await h.orchestrator.forceStartTask('t1');
    writeFileSync(join(h.requests[0].cwd, 'feature.txt'), 'half implemented\n');
    writeFileSync(join(h.requests[0].cwd, 'new.txt'), 'new implementation\n');
    h.sessions[0].emitExit(1);
    await vi.waitFor(() => expect(h.task().status).toBe('failed'), { timeout: 20_000 });
    await vi.waitFor(() => expect(h.orchestrator.runs.taskIsolation('t1')).toMatchObject({ state: 'kept' }), { timeout: 20_000 });
    expect(h.task()).toMatchObject({ runnerSessionId: 'native-t1', runnerSessionOwner: 'claude-code' });

    moveTo(h.orchestrator, 'codex');

    await expect(h.orchestrator.continueTask('t1', 'carry on')).rejects.toThrow(
      'its saved session belongs to claude-code; Retry starts fresh on codex and carries over its files.',
    );
    await h.orchestrator.retryTask('t1');
    await h.orchestrator.forceStartTask('t1');

    const moved = h.requests[1];
    expect(moved.runner).toBe('codex');
    expect(moved.resumeSessionId).toBeUndefined();
    expect(readFileSync(join(moved.cwd, 'feature.txt'), 'utf8')).toBe('half implemented\n');
    expect(readFileSync(join(moved.cwd, 'new.txt'), 'utf8')).toBe('new implementation\n');
    expect(moved.prompt).toContain('## Work carried over');
    expect(moved.prompt).toContain('previous attempt on claude-code');
    expect(h.task().carriedFrom).toBeUndefined();
    // The claude-code session is gone: what is saved is the new attempt's own, as soon as codex names it.
    expect(h.task().runnerSessionOwner).toBe('codex');
  });

  it('a completed task\'s Retry after the move carries the earlier files over too', async () => {
    const root = repo();
    const h = setup(root, false);
    await h.orchestrator.forceStartTask('t1');
    writeFileSync(join(root, 'feature.txt'), 'implemented\n');
    h.sessions[0].reportComplete({ status: 'done', summary: 'Done' });
    await vi.waitFor(() => expect(h.task().status).toBe('completed'), { timeout: 20_000 });

    moveTo(h.orchestrator, 'codex');
    await h.orchestrator.retryTask('t1');
    await h.orchestrator.forceStartTask('t1');

    const moved = h.requests[1];
    expect(moved.runner).toBe('codex');
    expect(moved.prompt).toContain('The files in your working tree come from a previous attempt on claude-code');
  });
});
