import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator, type TaskOrchestratorOptions } from '../TaskOrchestrator';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { TaskControlError } from '../TaskControlError';
import { LeaseGuaranteeError, refuseUnproven, GUARANTEES, type ExecutionBackend, type GuaranteeReport, type LeaseRequest } from '../executionLease';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeExecutionBackend, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';

/** The lease seam (ADR-0059), driven through the scheduler with a backend that is only a count of slots. */

function setup(opts: { limit?: number; isolation?: FakeWorktreeIsolation } & Pick<TaskOrchestratorOptions, 'runSettings' | 'execution'> = {}) {
  const backend = new FakeExecutionBackend();
  backend.limit = opts.limit ?? Infinity;
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (o: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, `native-${o.taskId}`);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const notifications = fakeNotification();
  const isolation = opts.isolation ?? new FakeWorktreeIsolation();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ maxParallelSessions: 8 }),
    notifications,
    runner,
    output: new BufferedTaskOutputSource(),
    isolation,
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    execution: opts.execution ?? (() => backend),
    sessionId: () => 'session-1',
    ...(opts.runSettings ? { runSettings: opts.runSettings } : {}),
  });
  const notices: string[] = [];
  orchestrator.subscribe({ onIsolationNotice: ({ message }) => notices.push(message) });
  const store = orchestrator.storeInstance;
  return { backend, orchestrator, spawn, sessions, store, notifications, notices, isolation, started: () => spawn.mock.calls.map(([o]) => o.taskId), session: (id: string) => sessions.filter((s) => s.taskId === id).at(-1)! };
}

const task = (id: string, order = 1, over: Partial<Task> = {}) => createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i += 1) await flushMicrotasks();
  expect(condition()).toBe(true);
}

describe('reserve, then open (ADR-0059 L1)', () => {
  it('reserves in the claim and opens after it, on the workspace the attempt\'s kind asks for', async () => {
    const env = setup();
    env.orchestrator.loadPlan([task('a')]);
    await env.orchestrator.forceStartTask('a');

    expect(env.backend.requests).toContainEqual({ node: { sessionId: 'session-1', taskId: 'a' }, role: 'task', runner: 'claude-code' });
    expect(env.backend.opened).toHaveLength(1);
    expect(env.backend.opened[0].spec).toMatchObject({ workspace: { kind: 'worktree', intent: 'fresh' }, required: [] });
    expect(env.backend.opened[0].spec.task).toMatchObject({ id: 'a' });
  });

  it('runs the runner where the lease opened', async () => {
    const env = setup();
    env.orchestrator.loadPlan([task('a')]);
    await env.orchestrator.forceStartTask('a');
    expect(env.spawn.mock.calls[0][0].cwd).toBe('/fake-lease/a');
  });

  it('asks a script task\'s lease as a script', async () => {
    const env = setup();
    env.orchestrator.loadPlan([createTask({ id: 's', order: 1, title: 'S', type: 'script', commands: [['true']] })]);
    await env.orchestrator.forceStartTask('s');
    expect(env.backend.requests.at(-1)).toMatchObject({ role: 'script', node: { taskId: 's' } });
  });

  it('never gives one slot to two starts: reserve is in the claim\'s own step', async () => {
    const env = setup({ limit: 1 });
    env.orchestrator.loadPlan([task('a'), task('b', 2)]);
    const hold = env.backend.holdOpen();
    const results = await Promise.allSettled([env.orchestrator.forceStartTask('a'), env.orchestrator.forceStartTask('b').finally(hold)]);
    expect(env.backend.held).toBe(1);
    expect(env.orchestrator.activeTaskIds.concat(results.flatMap((r) => (r.status === 'rejected' ? [(r.reason as Error).message] : [])))).toEqual(['a', 'no slot for b']);
  });

  it('a claim with no free slot starts nothing, and says the backend\'s words', async () => {
    const env = setup({ limit: 1 });
    env.orchestrator.loadPlan([task('a'), task('b', 2)]);
    await env.orchestrator.forceStartTask('a');

    const refused = await env.orchestrator.forceStartTask('b').catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(TaskControlError);
    expect((refused as Error).message).toBe('no slot for b');
    expect(env.started()).toEqual(['a']);
  });

  it('a scheduled claim the backend refuses stays ready, and starts on the tick its release brings', async () => {
    const env = setup({ limit: 1 });
    const elsewhere = env.backend.reserve({ node: { sessionId: 'another' }, role: 'task' });
    if ('refused' in elsewhere) throw new Error(elsewhere.refused);
    env.backend.freed = () => { void env.orchestrator.tick(); };
    env.orchestrator.loadPlan([task('a')]);
    await env.orchestrator.approveReview();
    await flushMicrotasks();
    expect(env.started()).toEqual([]);
    expect(env.store.get('a')?.status).not.toBe('in_progress');
    expect(env.orchestrator.getReadyTasks().map((t) => t.id)).toEqual(['a']);

    elsewhere.lease.release('done');
    await until(() => env.started().includes('a'));
  });

  it('a Stop between reserve and open starts nothing, gives the slot back, and lets the workspace go', async () => {
    const env = setup();
    env.orchestrator.loadPlan([task('a')]);
    const open = env.backend.holdOpen();
    const starting = env.orchestrator.forceStartTask('a');
    await until(() => env.backend.opened.length === 1);

    env.orchestrator.stop('user');
    expect(env.backend.held).toBe(0);
    open();
    await starting.catch(() => undefined);
    await flushMicrotasks();

    expect(env.started()).toEqual([]);
    expect(env.backend.letGoCalls).toEqual([{ taskId: 'a', keep: false, reason: 'ended while opening' }]);
  });

  it('an open that fails leaves the task as a failed spawn does, and gives the slot back', async () => {
    const env = setup();
    env.orchestrator.loadPlan([task('a')]);
    env.backend.openError = new Error('no room on the host');
    await env.orchestrator.forceStartTask('a');
    await until(() => env.backend.held === 0);

    expect(env.started()).toEqual([]);
    expect(env.store.get('a')?.status).toBe('pending');
    expect(env.orchestrator.holdReason('a')).toContain('no room on the host');
    expect(env.backend.released).toHaveLength(1);
  });

  it('a release that runs twice gives one slot back', async () => {
    const env = setup({ limit: 1 });
    env.orchestrator.loadPlan([task('a')]);
    await env.orchestrator.forceStartTask('a');
    const stoppedOnce = env.orchestrator.cancelTask('a');
    await stoppedOnce;
    await env.orchestrator.cancelTask('a');
    expect(env.backend.released).toHaveLength(1);
    expect(env.backend.held).toBe(0);
  });

  it('frees the slot as the attempt ends', async () => {
    const env = setup({ limit: 1 });
    env.orchestrator.loadPlan([task('a')]);
    await env.orchestrator.forceStartTask('a');
    env.session('a').emitExit(1);
    await until(() => env.backend.held === 0);
    expect(env.backend.released).toEqual([{ id: 'lease-1', reason: 'verdict' }]);
  });
});

describe('a kept worktree outlives its lease (ADR-0059 L1)', () => {
  it('what becomes of it is asked of the backend, with no lease needed', async () => {
    const env = setup();
    env.orchestrator.loadPlan([task('a')]);
    await env.orchestrator.forceStartTask('a');
    await env.orchestrator.cancelTask('a');
    expect(env.backend.letGoCalls).toEqual([{ taskId: 'a', keep: true, reason: 'cancelled' }]);
  });
});

describe('results carry session state (ADR-0059 L2)', () => {
  it('saves the session the backend brought back, which is what a Continue resumes', async () => {
    const env = setup();
    env.backend.sessionState = { nativeSessionId: 'brought-back' };
    env.orchestrator.loadPlan([task('a')]);
    await env.orchestrator.forceStartTask('a');

    await env.orchestrator.cancelTask('a');

    expect(env.store.get('a')?.runnerSessionId).toBe('brought-back');
  });
});

describe('guarantees are proven (ADR-0059 L3)', () => {
  const report = (proven: readonly string[]): GuaranteeReport => Object.fromEntries(GUARANTEES.map((g) => [g, { proven: proven.includes(g), by: 'canary', at: '2026-10-31T00:00:00.000Z' }])) as GuaranteeReport;

  it('an open that requires one its probe did not prove refuses, whatever the backend says of itself', async () => {
    const backend = new FakeExecutionBackend();
    backend.provenGuarantees = ['fs.writeScope'];
    const reserved = backend.reserve({ node: { sessionId: 's' }, role: 'task' });
    if ('refused' in reserved) throw new Error(reserved.refused);
    await expect(reserved.lease.open({ workspace: { kind: 'checkout' }, required: ['fs.writeScope', 'net.allowlist'] }, new AbortController().signal)).rejects.toBeInstanceOf(LeaseGuaranteeError);
  });

  it('names only what was not proven', () => {
    expect(() => refuseUnproven(['fs.writeScope', 'net.allowlist'], report(['fs.writeScope']))).toThrow('requires net.allowlist,');
  });

  it('lets an open through when everything it requires is proven', () => {
    expect(() => refuseUnproven(['fs.writeScope'], report(['fs.writeScope']))).not.toThrow();
  });
});

describe('a merge passes the seam (ADR-0059)', () => {
  /** The local backend, with what a merge is asked of it seen and, when `refused`, turned down. */
  const gated = (mergeAutomatically: boolean, refused?: string) => {
    const isolation = new FakeWorktreeIsolation();
    const merges: LeaseRequest[] = [];
    const released: string[] = [];
    const execution = (local: ExecutionBackend): ExecutionBackend => ({
      probe: () => local.probe(),
      refusal: (request) => local.refusal(request),
      reserve: (request) => {
        if (request.role !== 'merge') return local.reserve(request);
        merges.push(request);
        if (refused) return { refused };
        const reserved = local.reserve(request);
        if ('refused' in reserved) return reserved;
        return { lease: { ...reserved.lease, release: (reason) => { released.push(reason); reserved.lease.release(reason); } } };
      },
      letGo: (taskId, how) => local.letGo(taskId, how),
      list: () => local.list(),
    });
    const env = { ...setup({ isolation, execution, runSettings: () => ({ mergeAtGatesAutomatically: mergeAutomatically }) }), merges, released };
    env.orchestrator.loadPlan([task('a'), createTask({ id: 'ops', order: 2, title: 'Ops', prompt: 'deploy', ops: true, dependencies: ['a'] })]);
    return env;
  };
  const landed = async (env: ReturnType<typeof gated>) => {
    await env.orchestrator.approveReview();
    await until(() => env.started().includes('a'));
    env.session('a').reportComplete({ status: 'done', summary: '' });
    await until(() => env.store.get('a')?.status === 'completed');
    await flushMicrotasks();
  };

  it('an automatic merge at a gate asks a lease that holds no slot, and gives it back', async () => {
    const env = gated(true);
    await landed(env);
    await until(() => env.isolation.calls.some((c) => c.op === 'mergeIntoCheckedOut'));
    expect(env.merges).toEqual([{ node: { sessionId: 'session-1' }, role: 'merge' }]);
    await until(() => env.released.includes('merged'));
  });

  it('an automatic merge the backend refuses touches no checkout, and the gate waits for the user', async () => {
    const env = gated(true, 'this host holds no checkout');
    await landed(env);
    await until(() => env.notices.some((n) => n.includes('Automatic Merge all could not finish: this host holds no checkout')));
    expect(env.isolation.calls.some((c) => c.op === 'mergeIntoCheckedOut')).toBe(false);
  });

  it('a Merge all the user pressed answers them with the refusal', async () => {
    const env = gated(false, 'this host holds no checkout');
    await landed(env);
    await expect(env.orchestrator.mergeRun()).rejects.toThrow('this host holds no checkout');
    expect(env.orchestrator.isMerging).toBe(false);
  });
});
