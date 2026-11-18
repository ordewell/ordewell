import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { LeaseHost } from '../sessionLease';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { IRunner } from '../../interfaces/IRunner';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { fakeConfig, FakeRunnerSession, removeDir } from '../../testing';
import { loadSession, saveSession } from '../../utils/sessionStore';
import { openTaskLog } from '../../utils/taskLogStore';
import { closeSessions, makeSession } from './sessionTestKit';

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
  const b = makeSession({
    runner: lingeringRunner().runner,
    isolation,
    registry: new RunnerRegistry(),
    workspaceRoot: () => root,
    saveSession,
    openTaskLog,
    leaseHost: new LeaseHost(),
    sessionId,
  });
  return { b, settled };
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

