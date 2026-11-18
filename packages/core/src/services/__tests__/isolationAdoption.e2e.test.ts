import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { LeaseHost } from '../sessionLease';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { IRunner } from '../../interfaces/IRunner';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { Session } from '../createSession';
import { fakeConfig, FakeRunnerSession, removeDir } from '../../testing';
import { loadSession, saveSession } from '../../utils/sessionStore';
import { getSessionsDir } from '../../utils/sessionDir';
import { openTaskLog } from '../../utils/taskLogStore';
import { closeSessions, fakeNotification, makeSession } from './sessionTestKit';

/*
 * A run's worktrees belong to the session that made the run (ADR-0013,
 * ADR-0049). A copy of that session's plan opened under another id, a saved
 * file a script loads or a second checkout sharing the state root, must not
 * prune them while their owner may still be running in them.
 */

const env = () => {
  const e = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete e[k];
  return e;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const roots: string[] = [];
afterEach(async () => {
  await closeSessions();
  while (roots.length) await removeDir(roots.pop()!);
});

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-adopt-')));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'T');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), 'hello\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

/** The isolation, with every call it is asked counted, so a test can wait out whatever an adoption asked of git. */
function tracked(runId: string): { isolation: IWorktreeIsolation; settled: () => Promise<void> } {
  const real = createWorktreeIsolation({ config: fakeConfig({ worktreeIsolation: true }), resolvePath: async () => process.env.PATH ?? '', mintRunId: () => runId });
  const pending: Promise<unknown>[] = [];
  const isolation = new Proxy(real, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args);
        if (result instanceof Promise) pending.push(result.catch(() => undefined));
        return result;
      };
    },
  });
  return {
    isolation,
    settled: async () => {
      // An adoption's calls start a tick after the load, and each may queue another.
      for (let seen = -1; seen !== pending.length;) {
        seen = pending.length;
        await new Promise((r) => setTimeout(r, 50));
        await Promise.all(pending);
      }
    },
  };
}

/** A runner whose read-only attempt writes a marker into its worktree and then goes on running. */
function lingeringRunner(): { runner: IRunner; cwd: () => string } {
  let cwd = '';
  const runner: IRunner = {
    spawn: vi.fn(async (opts) => {
      cwd = opts.cwd;
      writeFileSync(join(opts.cwd, 'marker.txt'), 'still reading\n');
      return new FakeRunnerSession('s-r1', opts.taskId);
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
  return { runner, cwd: () => cwd };
}

const researchPlan = (): LegacyPlanState => ({
  tasks: [createTask({ id: 'r1', order: 1, title: 'Survey the code', prompt: 'read', taskMode: 'plan' })],
  runners: ['claude-code'],
  status: 'approved',
  generatedAt: '2026-11-18T10:00:00.000Z',
}) as unknown as LegacyPlanState;

/** The plan a session last saved, as a copy of its file would hold it. */
function savedPlanOf(root: string, sessionId: string): LegacyPlanState {
  const saved = loadSession(sessionId, root);
  if (!saved) throw new Error(`no saved file for ${sessionId}`);
  return saved.plan;
}

/** Session A, running a read-only task in a worktree of its run, its host alive. */
async function liveSessionA(root: string) {
  const { runner, cwd } = lingeringRunner();
  const a = makeSession({
    runner,
    isolation: tracked('runaaaa1').isolation,
    registry: new RunnerRegistry(),
    workspaceRoot: () => root,
    saveSession,
    openTaskLog,
    leaseHost: new LeaseHost(),
    sessionId: 'session-aaaa0001',
  });
  a.loadPlan(researchPlan(), 'The goal', root, { sessionId: 'session-aaaa0001' });
  await a.execute({ command: 'run_plan' }, { kind: 'user' });
  await vi.waitFor(() => expect(runner.spawn).toHaveBeenCalled());
  const marker = join(cwd(), 'marker.txt');
  await vi.waitFor(() => expect(savedPlanOf(root, 'session-aaaa0001').isolation?.run.tasks.r1?.readOnly).toBe(true));
  return { a, marker };
}

/** Session B: another host, under another id. */
function sessionB(root: string, sessionId = 'session-bbbb0002') {
  const { isolation, settled } = tracked('runbbbb2');
  const notifications = fakeNotification();
  const b = makeSession({
    notifications,
    runner: lingeringRunner().runner,
    isolation,
    registry: new RunnerRegistry(),
    workspaceRoot: () => root,
    saveSession,
    openTaskLog,
    leaseHost: new LeaseHost(),
    sessionId,
  });
  return { b, settled, notifications };
}

describe('adopting a run another session recorded', () => {
  it('leaves the live read-only worktree of a copied plan alone', async () => {
    const root = repo();
    const { marker } = await liveSessionA(root);
    expect(existsSync(marker)).toBe(true);

    const { b, settled } = sessionB(root);
    b.loadPlan(structuredClone(savedPlanOf(root, 'session-aaaa0001')), 'The goal', root, { sessionId: 'session-bbbb0002' });
    await settled();

    expect(existsSync(marker)).toBe(true);
    expect(git(root, 'worktree', 'list', '--porcelain')).toContain('1-survey-the-code');
  });

  it('starts clean, saves no record of the copied run, and runs its own beside it', async () => {
    const root = repo();
    const { marker } = await liveSessionA(root);

    const { b, settled } = sessionB(root);
    b.loadPlan(structuredClone(savedPlanOf(root, 'session-aaaa0001')), 'The goal', root, { sessionId: 'session-bbbb0002' });
    await settled();
    expect(b.isolationView()).toBeNull();
    await vi.waitFor(() => expect(savedPlanOf(root, 'session-bbbb0002').isolation).toBeUndefined());

    await b.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(git(root, 'worktree', 'list', '--porcelain')).toContain('runbbbb2'));
    await settled();
    expect(existsSync(marker)).toBe(true);
    expect(git(root, 'branch', '--list', 'ordewell/runaaaa1/*')).toContain('ordewell/runaaaa1/1-survey-the-code');
    expect(savedPlanOf(root, 'session-bbbb0002').isolation?.run).toMatchObject({ id: 'runbbbb2', session: 'session-bbbb0002' });
  });

  it('opens a fork of the live session with no run, leaving the original\'s worktree to it', async () => {
    const root = repo();
    const { a, marker } = await liveSessionA(root);
    const fork = a.forkConversation();
    const forked = savedPlanOf(root, fork.sessionId);
    expect(forked.isolation).toBeUndefined();

    const { b, settled } = sessionB(root, fork.sessionId);
    b.loadPlan(forked, fork.goal, fork.workspace, { sessionId: fork.sessionId });
    await settled();
    expect(b.isolationView()).toBeNull();
    expect(existsSync(marker)).toBe(true);
    expect(a.isolationView()?.tasks.r1).toMatchObject({ state: 'active' });
  });
});


/** A session's file as it is on disk, and where. */
function sessionFile(root: string, sessionId: string): { file: string; data: { meta: { id: string }; plan: LegacyPlanState } } {
  const dir = getSessionsDir(root);
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const data = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { meta: { id: string }; plan: LegacyPlanState };
    if (data.meta.id === sessionId) return { file: join(dir, name), data };
  }
  throw new Error(`no saved file for ${sessionId}`);
}

/** Rewrite a session's saved run as 0.14.1 wrote it: naming no session. */
function asSavedBy0141(root: string, sessionId: string): void {
  const { file, data } = sessionFile(root, sessionId);
  const run = data.plan.isolation?.run;
  if (!run) throw new Error(`${sessionId} saved no run`);
  delete run.session;
  writeFileSync(file, JSON.stringify(data));
}

describe('adopting a run saved before runs named their session', () => {
  it('leaves the live worktree of a copied pre-upgrade plan alone', async () => {
    const root = repo();
    const { marker } = await liveSessionA(root);
    asSavedBy0141(root, 'session-aaaa0001');

    const { b, settled } = sessionB(root);
    b.loadPlan(structuredClone(savedPlanOf(root, 'session-aaaa0001')), 'The goal', root, { sessionId: 'session-bbbb0002' });
    await settled();

    expect(existsSync(marker)).toBe(true);
    expect(b.isolationView()).toBeNull();
  });

  it('removes nothing for an unnamed record that came from no session\'s file, and says so', async () => {
    const root = repo();
    const { marker } = await liveSessionA(root);
    asSavedBy0141(root, 'session-aaaa0001');

    const { b, settled, notifications } = sessionB(root);
    // A script that reads the JSON itself: nothing in the plan says whose run it is.
    const raw = structuredClone(sessionFile(root, 'session-aaaa0001').data.plan);
    b.loadPlan(raw, 'The goal', root, { sessionId: 'session-bbbb0002' });
    await settled();

    expect(existsSync(marker)).toBe(true);
    expect(b.isolationView()).toBeNull();
    expect(notifications.info).toHaveBeenCalledWith(expect.stringContaining('could not tell which session'));
    await vi.waitFor(() => expect(savedPlanOf(root, 'session-bbbb0002').isolation).toBeUndefined());
  });
});

/** A runner that writes and finishes a build task at once, and leaves a read-only one running unless told to finish. */
function workingRunner(finishReading: boolean): { runner: IRunner; cwds: Map<string, string> } {
  const cwds = new Map<string, string>();
  const runner: IRunner = {
    spawn: vi.fn(async (opts) => {
      cwds.set(opts.taskId, opts.cwd);
      const session = new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
      if (opts.taskId === 't1') writeFileSync(join(opts.cwd, 'a.txt'), 'a\n');
      else writeFileSync(join(opts.cwd, 'marker.txt'), 'still reading\n');
      if (opts.taskId === 't1' || finishReading) setTimeout(() => session.reportComplete({ status: 'done', summary: 'Done.' }), 10);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  };
  return { runner, cwds };
}

const buildThenReadPlan = (): LegacyPlanState => ({
  tasks: [
    createTask({ id: 't1', order: 1, title: 'Write a', prompt: 'a' }),
    createTask({ id: 'r1', order: 2, title: 'Survey the code', prompt: 'read', taskMode: 'plan', dependencies: ['t1'] }),
  ],
  runners: ['claude-code'],
  status: 'approved',
  generatedAt: '2026-11-18T10:00:00.000Z',
}) as unknown as LegacyPlanState;

function hostOf(root: string, sessionId: string, runId: string, finishReading: boolean): { session: Session; cwds: Map<string, string> } {
  const { runner, cwds } = workingRunner(finishReading);
  const session = makeSession({
    runner,
    isolation: tracked(runId).isolation,
    registry: new RunnerRegistry(),
    workspaceRoot: () => root,
    saveSession,
    openTaskLog,
    leaseHost: new LeaseHost(),
    sessionId,
  });
  return { session, cwds };
}

/**
 * Session A as 0.14.1 left it when its host died: t1 landed, r1 still running
 * in its read-only worktree, and a saved record naming no session.
 */
async function crashedPreUpgradeA(root: string): Promise<string> {
  const { session: a, cwds } = hostOf(root, 'session-aaaa0001', 'runaaaa1', false);
  a.loadPlan(buildThenReadPlan(), 'The goal', root, { sessionId: 'session-aaaa0001' });
  await a.execute({ command: 'run_plan' }, { kind: 'user' });
  await vi.waitFor(() => expect(savedPlanOf(root, 'session-aaaa0001').isolation?.run.tasks.r1?.status).toBe('active'));
  const crashed = sessionFile(root, 'session-aaaa0001');
  const reading = cwds.get('r1')!;
  a.destroy();
  await a.gone;
  // A host killed outright leaves its file as it last saved it and the attempt's worktree in place.
  writeFileSync(crashed.file, JSON.stringify(crashed.data));
  if (!existsSync(reading)) git(root, 'worktree', 'add', '-q', '-B', crashed.data.plan.isolation!.run.tasks.r1.branch, reading);
  writeFileSync(join(reading, 'marker.txt'), 'left by the crash\n');
  asSavedBy0141(root, 'session-aaaa0001');
  return reading;
}

describe('the session that saved a run before runs named their session, upgraded', () => {
  it('takes its own run back on reopening, names itself on it, and prunes what its crash left', async () => {
    const root = repo();
    const reading = await crashedPreUpgradeA(root);

    const { session: a } = hostOf(root, 'session-aaaa0001', 'runaaaa9', true);
    a.loadPlan(loadSession('session-aaaa0001', root)!.plan, 'The goal', root, { sessionId: 'session-aaaa0001' });

    expect(sessionFile(root, 'session-aaaa0001').data.plan.isolation?.run).toMatchObject({ id: 'runaaaa1', session: 'session-aaaa0001' });
    expect(a.isolationView()?.tasks.t1).toMatchObject({ state: 'integrated' });
    await vi.waitFor(() => expect(existsSync(reading)).toBe(false));
  });

  it('resumes its run in the same worktrees and leaves none behind when it closes', async () => {
    const root = repo();
    await crashedPreUpgradeA(root);

    const { session: a, cwds } = hostOf(root, 'session-aaaa0001', 'runaaaa9', true);
    a.loadPlan(loadSession('session-aaaa0001', root)!.plan, 'The goal', root, { sessionId: 'session-aaaa0001' });
    await a.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(cwds.get('r1')).toBeDefined());
    expect(cwds.get('r1')).toContain(join('.ordewell', 'worktrees', 'runaaaa1'));
    await vi.waitFor(() => expect(a.isExecuting).toBe(false));

    await vi.waitFor(() => expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain('runaaaa1'));
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain('runaaaa9');
  });
});

describe('a stranger to a pre-upgrade session', () => {
  it('prunes nothing of a crashed pre-upgrade run when it opens a copy of the plan, and the owner still resumes it', async () => {
    const root = repo();
    const reading = await crashedPreUpgradeA(root);

    const { b, settled } = sessionB(root);
    b.loadPlan(loadSession('session-aaaa0001', root)!.plan, 'The goal', root, { sessionId: 'session-bbbb0002' });
    await settled();
    expect(existsSync(join(reading, 'marker.txt'))).toBe(true);
    expect(b.isolationView()).toBeNull();
    expect(sessionFile(root, 'session-aaaa0001').data.plan.isolation?.run.session).toBeUndefined();

    const { session: a } = hostOf(root, 'session-aaaa0001', 'runaaaa9', true);
    a.loadPlan(loadSession('session-aaaa0001', root)!.plan, 'The goal', root, { sessionId: 'session-aaaa0001' });
    expect(a.isolationView()?.tasks.t1).toMatchObject({ state: 'integrated' });
    await vi.waitFor(() => expect(existsSync(reading)).toBe(false));
  });

  for (const how of ['fork', 'rewind'] as const) {
    it(`opens a ${how} of the reopened pre-upgrade session with no run, leaving the original's worktree to it`, async () => {
      const root = repo();
      await crashedPreUpgradeA(root);
      const { session: a, cwds } = hostOf(root, 'session-aaaa0001', 'runaaaa9', false);
      const plan = loadSession('session-aaaa0001', root)!.plan;
      plan.conversationHistory = [{ role: 'user', content: 'The goal' }, { role: 'assistant', content: 'A plan.' }, { role: 'user', content: 'Survey it too.' }] as LegacyPlanState['conversationHistory'];
      a.loadPlan(plan, 'The goal', root, { sessionId: 'session-aaaa0001' });
      await a.execute({ command: 'run_plan' }, { kind: 'user' });
      await vi.waitFor(() => expect(cwds.get('r1')).toBeDefined());
      const marker = join(cwds.get('r1')!, 'marker.txt');
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));

      const fork = how === 'fork' ? a.forkConversation() : a.rewindConversation(a.rewindTargets().at(-1)!.index);
      const forked = savedPlanOf(root, fork.sessionId);
      expect(forked.isolation).toBeUndefined();
      const { b, settled } = sessionB(root, fork.sessionId);
      b.loadPlan(forked, fork.goal, fork.workspace, { sessionId: fork.sessionId });
      await settled();

      expect(b.isolationView()).toBeNull();
      expect(existsSync(marker)).toBe(true);
      expect(a.isolationView()?.tasks.r1).toMatchObject({ state: 'active' });
    });
  }
});
