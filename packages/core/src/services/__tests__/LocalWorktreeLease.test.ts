import { describe, it, expect, vi } from 'vitest';
import { LocalWorktreeLease } from '../LocalWorktreeLease';
import { SlotPool, type PoolNode } from '../SlotPool';
import { IsolationRunController } from '../IsolationRunController';
import { GUARANTEES, LeaseGuaranteeError, type LeaseRequest, type LeaseSpec, type OpenLease, type ReservedLease } from '../executionLease';
import { createTask } from '../../models/Task';
import { fakeConfig, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification } from './sessionTestKit';

/** L4: today's code behind the seam, against the controller and the fake git, with nothing but the seam between them. */

const noListener = { changed: vi.fn(), blocked: vi.fn(), handoff: vi.fn(), closed: vi.fn(), ended: vi.fn(), notice: vi.fn(), resolversEnded: vi.fn() };
const node: PoolNode = { tick: async () => undefined, openTurn: () => undefined, waitsOnPlanner: () => false, limitFound: () => undefined };
const t1 = createTask({ id: 't1', order: 1, title: 'One', prompt: 'do it' });
const attemptOf = (taskId = 't1'): LeaseRequest => ({ node: { sessionId: 's', taskId }, role: 'task' });

function setup(limit = 3, isolated = true) {
  const isolation = new FakeWorktreeIsolation();
  const runs = new IsolationRunController({
    isolation,
    config: fakeConfig({ worktreeIsolation: true }),
    notifications: fakeNotification(),
    workspaceRoot: () => '/repo',
    listener: noListener,
    liveTasks: () => new Set(),
    landedOn: () => [],
  });
  const pool = new SlotPool(() => limit);
  pool.join(node);
  const backend = new LocalWorktreeLease({ pool, node, runs, workspaceRoot: () => '/repo' });
  const open = async (spec: Omit<LeaseSpec, 'required'> & { required?: LeaseSpec['required'] }, signal = new AbortController().signal) => {
    if (isolated && !runs.decided) await runs.decide(async () => undefined);
    return reserved(backend.reserve(attemptOf())).open({ required: [], ...spec }, signal);
  };
  return { isolation, runs, pool, backend, open };
}

function reserved(result: ReturnType<LocalWorktreeLease['reserve']>): ReservedLease {
  if ('refused' in result) throw new Error(result.refused);
  return result.lease;
}

describe('LocalWorktreeLease (ADR-0059 L4)', () => {
  it('reserve is the Parallel limit', () => {
    const { backend } = setup(1);
    const lease = reserved(backend.reserve(attemptOf('a')));
    const words = '1 task is already running, the most this session runs at once. Wait for one to finish, or stop one first.';
    expect(backend.refusal(attemptOf('b'))).toBe(words);
    expect(backend.reserve(attemptOf('b'))).toEqual({ refused: words });
    lease.release('done');
    expect(backend.refusal(attemptOf('b'))).toBeNull();
  });

  it('a lease holds its slot until it is released, and a second release frees nothing more', () => {
    const { backend } = setup(2);
    const first = reserved(backend.reserve(attemptOf('a')));
    reserved(backend.reserve(attemptOf('b')));
    first.release('done');
    first.release('done');
    reserved(backend.reserve(attemptOf('c')));
    expect(backend.refusal(attemptOf('d'))).not.toBeNull();
  });

  it('open is attemptCwd: a fresh worktree', async () => {
    const { open } = setup();
    const { workspace } = await open({ task: t1, workspace: { kind: 'worktree', intent: 'fresh' } });
    expect(workspace).toEqual({
      cwd: '/fake-worktrees/run1/1-t1', writable: '/fake-worktrees/run1/1-t1', worktree: true,
      repos: [{ path: '.', root: '/repo', worktree: '/fake-worktrees/run1/1-t1', branch: 'ordewell/run1/1-t1', integrationBranch: 'ordewell/run1/integration', linked: [] }],
    });
  });

  it('open at the checkout is the workspace root, and lets go of a worktree an earlier attempt left', async () => {
    const { open, runs, isolation } = setup();
    await open({ task: t1, workspace: { kind: 'worktree', intent: 'fresh' } });
    const { workspace } = await open({ task: t1, workspace: { kind: 'checkout' } });
    expect(workspace).toEqual({ cwd: '/repo', worktree: false });
    expect(runs.current?.tasks.t1).toBeUndefined();
    expect(isolation.calls).toContainEqual({ op: 'release', taskId: 't1', keep: false });
  });

  it('a planner\'s open is the workspace root, and touches no record', async () => {
    const { backend } = setup();
    const opened = await reserved(backend.reserve({ node: { sessionId: 's' }, role: 'planner' })).open({ workspace: { kind: 'checkout' }, required: [] }, new AbortController().signal);
    expect(opened.workspace).toEqual({ cwd: '/repo', worktree: false });
  });

  it('makes nothing once aborted: a Stop between reserve and open', async () => {
    const { open, isolation } = setup();
    const stopped = new AbortController();
    stopped.abort();
    await expect(open({ task: t1, workspace: { kind: 'worktree', intent: 'fresh' } }, stopped.signal)).rejects.toThrow('given up');
    expect(isolation.taskIdsFor('prepare')).toEqual([]);
  });

  it('carries a failed open out as it failed', async () => {
    const { open, isolation } = setup();
    isolation.prepare = async () => { throw new Error('git worktree failed: x'); };
    await expect(open({ task: t1, workspace: { kind: 'worktree', intent: 'fresh' } })).rejects.toThrow('git worktree failed: x');
  });

  describe('its result carries session state (L2)', () => {
    const exported = async (spec: Parameters<ReturnType<typeof setup>['open']>[0]): Promise<OpenLease> => setup().open(spec);

    it('with the task\'s branch for each repo', async () => {
      const opened = await exported({ task: t1, workspace: { kind: 'worktree', intent: 'fresh' } });
      expect(opened.exportResult({ runner: 'claude-code', nativeSessionId: 'native-1' })).toEqual({
        refs: { '.': 'ordewell/run1/1-t1' },
        sessionState: { runner: 'claude-code', nativeSessionId: 'native-1' },
      });
    });

    it('with no refs for work in the checkout: the session is still the result a Continue needs', async () => {
      const opened = await exported({ task: t1, workspace: { kind: 'checkout' } });
      expect(opened.exportResult({ runner: 'codex', nativeSessionId: 'native-2' })).toEqual({ refs: {}, sessionState: { runner: 'codex', nativeSessionId: 'native-2' } });
    });
  });

  describe('what it can prove (L3)', () => {
    it('is nothing: its report is that a local runner reaches what the user reaches', async () => {
      const { backend } = setup();
      const report = await backend.probe();
      expect(Object.keys(report).sort()).toEqual([...GUARANTEES].sort());
      for (const proof of Object.values(report)) {
        expect(proof.proven).toBe(false);
        expect(proof.by).toContain('reaches what the user reaches');
        expect(Number.isNaN(Date.parse(proof.at))).toBe(false);
      }
    });

    it('reports that on every open', async () => {
      const { open } = setup();
      const { guarantees } = await open({ task: t1, workspace: { kind: 'worktree', intent: 'fresh' } });
      expect(guarantees['fs.hostHidden'].proven).toBe(false);
    });

    it('refuses an open that requires one, before it makes anything', async () => {
      const { open, isolation } = setup();
      const opening = open({ task: t1, workspace: { kind: 'worktree', intent: 'fresh' }, required: ['fs.hostHidden', 'limits.memory'] });
      await expect(opening).rejects.toBeInstanceOf(LeaseGuaranteeError);
      await expect(opening).rejects.toThrow('fs.hostHidden, limits.memory');
      expect(isolation.taskIdsFor('prepare')).toEqual([]);
    });
  });

  it('letGo is the run\'s release: a worktree can outlive the lease that opened it', async () => {
    const { open, backend, isolation } = setup();
    await open({ task: t1, workspace: { kind: 'worktree', intent: 'fresh' } });
    await backend.letGo('t1', { keep: true, reason: 'failed' });
    expect(isolation.calls).toContainEqual({ op: 'release', taskId: 't1', keep: true });
  });

  it('letGo waits for a landing still in flight', async () => {
    const { open, backend, isolation } = setup();
    await open({ task: t1, workspace: { kind: 'worktree', intent: 'fresh' } });
    let land!: () => void;
    const landing = new Promise<void>((resolve) => { land = resolve; });
    const letting = backend.letGo('t1', { keep: false, landing, reason: 'cancelled' });
    await Promise.resolve();
    expect(isolation.taskIdsFor('release')).toEqual([]);
    land();
    await letting;
    expect(isolation.taskIdsFor('release')).toEqual(['t1']);
  });

  it('list reads the session\'s records, and starts nothing', async () => {
    const { open, backend, isolation } = setup();
    expect(await backend.list()).toEqual([]);
    await open({ task: t1, workspace: { kind: 'worktree', intent: 'fresh' } });
    const prepared = isolation.taskIdsFor('prepare').length;
    expect(await backend.list()).toEqual([{ taskId: 't1', status: 'active', worktrees: ['/fake-worktrees/run1/1-t1'] }]);
    expect(isolation.taskIdsFor('prepare')).toHaveLength(prepared);
  });
});
