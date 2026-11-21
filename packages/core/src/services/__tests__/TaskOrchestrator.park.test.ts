import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, migrateLoadedTasks, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification, makeSession, saves, taskOf } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/**
 * A change task that needs a sibling's unlanded work parks with `wait_for`
 * (ADR-0074): its attempt ends with no verdict, the plan gains the edge, its
 * slot goes to what is ready, and once the sibling lands it goes on in the
 * session it parked in.
 */

function setup(opts: { maxParallel?: number; sessionIds?: boolean; failSpawn?: (o: RunnerSpawnOptions, nth: number) => boolean } = {}) {
  const sessions: FakeRunnerSession[] = [];
  const requests: RunnerSpawnOptions[] = [];
  const runner = {
    spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
      requests.push(o);
      if (opts.failSpawn?.(o, requests.filter((r) => r.taskId === o.taskId).length)) throw new Error('spawn failed');
      const native = opts.sessionIds === false ? null : o.resumeSessionId ?? `native-${o.taskId}-${sessions.length + 1}`;
      const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, native);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(async () => undefined),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const notifications = fakeNotification();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ maxParallelSessions: opts.maxParallel ?? 2 }),
    notifications,
    runner,
    output: new BufferedTaskOutputSource(),
    isolation: new FakeWorktreeIsolation(),
    workspaceRoot: () => '/repo',
  });
  const stored = (id: string) => orchestrator.storeInstance.get(id)!;
  const spawnsOf = (id: string) => requests.filter((r) => r.taskId === id);
  const latest = (id: string) => sessions.filter((s) => s.taskId === id).at(-1)!;
  const pass = (id: string) => latest(id).reportComplete({ status: 'done', summary: `${id} done` });
  const waitFor = (id: string, tasks: string[], reason = 'its tests import that module') =>
    spawnsOf(id).at(-1)!.waitFor!({ tasks, reason });
  return { orchestrator, notifications, requests, sessions, stored, spawnsOf, latest, pass, waitFor };
}

const task = (id: string, order: number, over: Partial<Task> = {}) => createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

describe('a task that waits for a sibling parks, freeing its slot (ADR-0074)', () => {
  it('ends with no verdict, gains the edge, gives its slot to what is ready, and continues its session once the sibling lands', async () => {
    const h = setup({ maxParallel: 2 });
    h.orchestrator.loadPlan([task('a', 1), task('c', 2), task('d', 3)]);
    await h.orchestrator.approveReview();
    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(1));
    expect(h.spawnsOf('d')).toHaveLength(0);

    const reply = await h.waitFor('c', ['a']);
    expect(reply.isError).toBeUndefined();
    expect(reply.text).toContain('#1 "Task a"');
    h.latest('c').emitTurnEnd('completed');

    await vi.waitFor(() => expect(h.spawnsOf('d')).toHaveLength(1));
    const c = h.stored('c');
    expect(c.status).toBe('pending');
    expect(c.verdict).toBeUndefined();
    expect(c.dependencies).toEqual(['a']);
    expect(c.parked).toMatchObject({ attempt: 1, waitsOn: ['a'], added: ['a'], count: 1 });
    expect(h.notifications.error).not.toHaveBeenCalled();

    h.pass('a');
    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(2));
    const resumed = h.spawnsOf('c')[1];
    expect(resumed.resumeSessionId).toBe('native-c-2');
    expect(resumed.prompt).toMatch(/^\(Ordewell\) The work you waited for has landed: #1 "Task a"/);

    h.pass('c');
    await vi.waitFor(() => expect(h.stored('c').status).toBe('completed'));
  });
});

describe('a refused wait says why and what to do instead, and changes nothing (ADR-0074 P1)', () => {
  it('refuses a task that waits for the caller, one not in the plan, and work that has landed', async () => {
    const h = setup({ maxParallel: 3 });
    h.orchestrator.loadPlan([task('a', 1), task('c', 2), task('close', 3, { dependencies: ['a', 'c'] })]);
    await h.orchestrator.approveReview();
    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(1));

    const cycle = await h.waitFor('c', ['close']);
    expect(cycle).toMatchObject({ isError: true, text: expect.stringContaining('#3 "Task close" waits for this task') });
    expect(cycle.text).toContain('Finish your own part');
    expect(await h.waitFor('c', ['#9'])).toMatchObject({ isError: true, text: expect.stringContaining('"#9" names no task in the plan') });

    h.pass('a');
    await vi.waitFor(() => expect(h.stored('a').status).toBe('completed'));
    expect(await h.waitFor('c', ['a'])).toMatchObject({ isError: true, text: expect.stringContaining('has landed: take its work in now') });

    expect(h.stored('c')).toMatchObject({ status: 'in_progress', dependencies: [] });
    expect(h.stored('c').parked).toBeUndefined();
    h.pass('c');
    await vi.waitFor(() => expect(h.stored('c').status).toBe('completed'));
  });

  it('refuses the second of two tasks that wait for each other before either turn ends, so no cycle deadlocks the run', async () => {
    const h = setup({ maxParallel: 2 });
    h.orchestrator.loadPlan([task('a', 1), task('b', 2)]);
    await h.orchestrator.approveReview();
    await vi.waitFor(() => { expect(h.spawnsOf('a')).toHaveLength(1); expect(h.spawnsOf('b')).toHaveLength(1); });

    expect((await h.waitFor('a', ['b'])).isError).toBeUndefined();
    expect(await h.waitFor('b', ['a'])).toMatchObject({ isError: true, text: expect.stringContaining('#1 "Task a" waits for this task') });
    h.latest('a').emitTurnEnd('completed');
    await vi.waitFor(() => expect(h.stored('a')).toMatchObject({ status: 'pending', dependencies: ['b'] }));
    expect(h.stored('b')).toMatchObject({ status: 'in_progress', dependencies: [] });
  });

  it('drops an edge that would close a cycle the plan gained while the park was ending, and goes on told so', async () => {
    const h = setup({ maxParallel: 1 });
    h.orchestrator.loadPlan([task('a', 1), task('b', 2)]);
    await h.orchestrator.approveReview();
    await vi.waitFor(() => expect(h.spawnsOf('a')).toHaveLength(1));
    expect((await h.waitFor('a', ['b'])).isError).toBeUndefined();
    h.orchestrator.storeInstance.update('b', { dependencies: ['a'] });

    h.latest('a').emitTurnEnd('completed');
    await vi.waitFor(() => expect(h.spawnsOf('a')).toHaveLength(2));
    expect(h.stored('a').dependencies).toEqual([]);
    expect(h.spawnsOf('a')[1].prompt).toContain('#2 "Task b" is no longer among what this task waits for');
  });

  it('parks twice at most between fresh attempts', async () => {
    const h = setup({ maxParallel: 3 });
    h.orchestrator.loadPlan([task('a', 1), task('b', 2), task('c', 3), task('d', 4)]);
    await h.orchestrator.approveReview();
    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(1));

    await h.waitFor('c', ['a']);
    h.latest('c').emitTurnEnd('completed');
    await vi.waitFor(() => expect(h.stored('c').status).toBe('pending'));
    h.pass('a');
    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(2));

    expect((await h.waitFor('c', ['b'])).isError).toBeUndefined();
    h.latest('c').emitTurnEnd('completed');
    await vi.waitFor(() => expect(h.stored('c').parked?.count).toBe(2));
    expect(h.stored('c').dependencies).toEqual(['a', 'b']);
    h.pass('b');
    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(3));
    expect(h.spawnsOf('c')[2].resumeSessionId).toBe(h.spawnsOf('c')[1].resumeSessionId);

    expect(await h.waitFor('c', ['d'])).toMatchObject({ isError: true, text: expect.stringContaining('waited 2 times since it last started afresh') });
    expect(h.stored('c').status).toBe('in_progress');
  });
});

describe('a park whose awaited work will not land now goes on without it (ADR-0074 P7)', () => {
  async function parkedOnA(h: ReturnType<typeof setup>) {
    h.orchestrator.loadPlan([task('a', 1), task('c', 2)]);
    await h.orchestrator.approveReview();
    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(1));
    await h.waitFor('c', ['a']);
    h.latest('c').emitTurnEnd('completed');
    await vi.waitFor(() => expect(h.stored('c').status).toBe('pending'));
  }

  it('takes back the edge to a sibling that failed, and continues the session told so', async () => {
    const h = setup();
    await parkedOnA(h);

    h.latest('a').reportComplete({ status: 'failed', summary: 'could not build', reason: 'broken' });

    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(2));
    expect(h.stored('a').status).toBe('failed');
    expect(h.stored('c').dependencies).toEqual([]);
    expect(h.spawnsOf('c')[1].resumeSessionId).toBe('native-c-2');
    expect(h.spawnsOf('c')[1].prompt).toMatch(/^\(Ordewell\) The work you waited for will not land now: #1 "Task a" failed\. Finish your own part/);
    expect(h.notifications.info).toHaveBeenCalledWith(expect.stringContaining('Task "Task c" no longer waits for #1 "Task a"'));
    h.pass('c');
    await vi.waitFor(() => expect(h.stored('c').status).toBe('completed'));
  });

  it('goes on once a sibling it waits for is skipped', async () => {
    const h = setup();
    h.orchestrator.loadPlan([task('x', 1), task('a', 2, { dependencies: ['x'] }), task('c', 3)]);
    await h.orchestrator.approveReview();
    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(1));
    await h.waitFor('c', ['a']);
    h.latest('c').emitTurnEnd('completed');
    await vi.waitFor(() => expect(h.stored('c').status).toBe('pending'));

    await h.orchestrator.skipTask('a', 'not needed');

    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(2));
    expect(h.spawnsOf('c')[1].prompt).toMatch(/^\(Ordewell\) The work you waited for will not land now: #2 "Task a" was skipped\./);
    expect(h.stored('c').dependencies).toEqual([]);
  });
});

describe('a parked task whose runner left no session to resume (ADR-0074 P4)', () => {
  it('starts afresh from the parked attempt\'s files, told what it waited for and what landed', async () => {
    const h = setup({ sessionIds: false });
    h.orchestrator.loadPlan([task('a', 1), task('c', 2)]);
    await h.orchestrator.approveReview();
    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(1));
    await h.waitFor('c', ['a']);
    h.latest('c').emitTurnEnd('completed');
    await vi.waitFor(() => expect(h.stored('c').status).toBe('pending'));

    h.pass('a');

    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(2));
    const fresh = h.spawnsOf('c')[1];
    expect(fresh.resumeSessionId).toBeUndefined();
    expect(fresh.prompt).toContain('## Work carried over');
    expect(fresh.prompt).toContain('An earlier attempt of this task on claude-code stopped to wait for other tasks\' work, and its session cannot be continued, so this is a fresh one. (Ordewell) The work you waited for has landed: #1 "Task a".');
    expect(fresh.prompt).toContain('do c');
  });
});

describe('the user\'s controls on a parked task', () => {
  async function parkedOnA(h: ReturnType<typeof setup>) {
    h.orchestrator.loadPlan([task('a', 1), task('c', 2)]);
    await h.orchestrator.approveReview();
    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(1));
    await h.waitFor('c', ['a']);
    h.latest('c').emitTurnEnd('completed');
    await vi.waitFor(() => expect(h.stored('c').status).toBe('pending'));
  }

  it('a Stop keeps it from going on once the work lands, and a force start then continues its session', async () => {
    const h = setup();
    await parkedOnA(h);

    await h.orchestrator.cancelTask('c');
    h.pass('a');
    await vi.waitFor(() => expect(h.stored('a').status).toBe('completed'));
    await h.orchestrator.tick();
    expect(h.spawnsOf('c')).toHaveLength(1);
    expect(h.orchestrator.holdReason('c')).toContain('cancelled');

    await h.orchestrator.forceStartTask('c');
    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(2));
    expect(h.spawnsOf('c')[1].resumeSessionId).toBe('native-c-2');
  });

  it('a continuation whose spawn failed leaves the park owed, so the next start still continues its session', async () => {
    const h = setup({ failSpawn: (o, nth) => o.taskId === 'c' && nth === 2 });
    await parkedOnA(h);
    h.pass('a');
    await vi.waitFor(() => expect(h.stored('c').status).toBe('failed'));
    expect(h.spawnsOf('c')).toHaveLength(2);

    await h.orchestrator.forceStartTask('c');
    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(3));
    expect(h.spawnsOf('c')[2].resumeSessionId).toBe('native-c-2');
    expect(h.spawnsOf('c')[2].prompt).toContain('The work you waited for has landed');
  });

  it('a Retry starts afresh, the park and its session let go, the edge kept as the plan has it', async () => {
    const h = setup();
    await parkedOnA(h);

    await h.orchestrator.retryTask('c');
    expect(h.stored('c').parked).toBeUndefined();
    expect(h.stored('c').dependencies).toEqual(['a']);
    h.pass('a');

    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(2));
    expect(h.spawnsOf('c')[1].resumeSessionId).toBeUndefined();
    expect(h.spawnsOf('c')[1].prompt).not.toContain('waited');
  });
});

describe('a park survives a save and a reload, as after a daemon restart (ADR-0074)', () => {
  it('is saved with the plan, and the reloaded run continues the session once the work it waits for lands', async () => {
    const first = setupRunner();
    const before = makeSession({ runner: first.runner });
    before.loadPlan(planState([task('a', 1), task('c', 2)]), 'Goal', '/repo');
    await before.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(first.spawnsOf('c')).toHaveLength(1));
    await first.spawnsOf('c')[0].waitFor!({ tasks: ['#1'], reason: 'needs its parser' });
    first.latest('c').emitTurnEnd('completed');
    await vi.waitFor(() => expect(saves(before).mock.lastCall?.[0].tasks[1]).toMatchObject({ status: 'pending', dependencies: ['a'], parked: { attempt: 1, waitsOn: ['a'], added: ['a'], count: 1 } }));
    const saved = structuredClone(saves(before).mock.lastCall![0]);
    before.destroy();

    const second = setupRunner();
    const after = makeSession({ runner: second.runner });
    after.loadPlan(saved, 'Goal', '/repo');
    expect(taskOf(after, 'c')).toMatchObject({ dependencies: ['a'], parked: { attempt: 1 } });
    await after.execute({ command: 'run_plan' }, { kind: 'user' });
    // The sibling the restart cut short runs again; the parked task waits for it, not a fresh start.
    await vi.waitFor(() => expect(second.spawnsOf('a')).toHaveLength(1));
    expect(second.spawnsOf('c')).toHaveLength(0);
    second.latest('a').reportComplete({ status: 'done', summary: '' });

    await vi.waitFor(() => expect(second.spawnsOf('c')).toHaveLength(1));
    expect(second.spawnsOf('c')[0].resumeSessionId).toBe('native-c-2');
    expect(second.spawnsOf('c')[0].prompt).toMatch(/^\(Ordewell\) The work you waited for has landed: #1 "Task a"/);
  });

  it('drops a saved park it cannot read, and the task starts afresh', () => {
    const tasks = [{ ...task('c', 1), parked: { attempt: 'one', waitsOn: ['a'] } }] as unknown as Task[];
    migrateLoadedTasks(tasks);
    expect(tasks[0].parked).toBeUndefined();
  });
});

function setupRunner() {
  const sessions: FakeRunnerSession[] = [];
  const requests: RunnerSpawnOptions[] = [];
  const runner = {
    spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
      requests.push(o);
      const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, o.resumeSessionId ?? `native-${o.taskId}-${sessions.length + 1}`);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(async () => undefined),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  return {
    runner,
    spawnsOf: (id: string) => requests.filter((r) => r.taskId === id),
    latest: (id: string) => sessions.filter((s) => s.taskId === id).at(-1)!,
  };
}

function planState(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

describe('stop_task on a parked task, through the command seam', () => {
  it('stops it going on, where a task with no attempt is otherwise refused', async () => {
    const h = setupRunner();
    const session = makeSession({ runner: h.runner });
    session.loadPlan(planState([task('a', 1), task('c', 2), task('d', 3, { dependencies: ['a'] })]), 'Goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(1));
    await h.spawnsOf('c')[0].waitFor!({ tasks: ['#1'], reason: 'needs its parser' });
    h.latest('c').emitTurnEnd('completed');
    await vi.waitFor(() => expect(taskOf(session, 'c')?.status).toBe('pending'));

    await expect(session.execute({ command: 'stop_task', task: '#3' }, { kind: 'user' })).resolves.toMatchObject({ ok: false, outcome: 'refused', message: expect.stringContaining('is not running') });
    await expect(session.execute({ command: 'stop_task', task: '#2' }, { kind: 'user' })).resolves.toMatchObject({ ok: true, message: expect.stringContaining('no longer goes on once that lands') });

    h.latest('a').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(h.spawnsOf('d')).toHaveLength(1));
    expect(h.spawnsOf('c')).toHaveLength(1);
  });
});

describe('a granted park stands however the attempt then ends', () => {
  it('parks, with no failure, when the runner exits instead of ending its turn', async () => {
    const h = setup();
    h.orchestrator.loadPlan([task('a', 1), task('c', 2)]);
    await h.orchestrator.approveReview();
    await vi.waitFor(() => expect(h.spawnsOf('c')).toHaveLength(1));
    await h.waitFor('c', ['a']);

    h.latest('c').emitExit(1);

    await vi.waitFor(() => expect(h.stored('c').status).toBe('pending'));
    expect(h.stored('c')).toMatchObject({ dependencies: ['a'], parked: { count: 1 } });
    expect(h.stored('c').verdict).toBeUndefined();
    expect(h.notifications.error).not.toHaveBeenCalled();
  });

  it('refuses a second wait in the same attempt', async () => {
    const h = setup();
    h.orchestrator.loadPlan([task('a', 1), task('b', 2), task('c', 3)]);
    await h.orchestrator.approveReview();
    await vi.waitFor(() => expect(h.spawnsOf('b')).toHaveLength(1));
    await h.waitFor('b', ['a']);
    expect(await h.waitFor('b', ['a'])).toEqual({ isError: true, text: 'This attempt already waits for that work: end your turn now.' });
  });
});

describe('only a change task parks', () => {
  it('refuses an ops task, whose work lands nothing on the run\'s branch', async () => {
    const h = setup();
    h.orchestrator.loadPlan([task('a', 1), task('o', 2, { ops: true })]);
    await h.orchestrator.approveReview();
    await vi.waitFor(() => expect(h.spawnsOf('o')).toHaveLength(1));
    expect(await h.waitFor('o', ['a'])).toMatchObject({ isError: true, text: expect.stringContaining('wait_for is for a change task') });
    expect(h.stored('o').dependencies).toEqual([]);
  });
});
