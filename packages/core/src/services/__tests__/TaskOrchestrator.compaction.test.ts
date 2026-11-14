import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';

function setup() {
  const sessions: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
      const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, `native-${o.taskId}`);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ worktreeIsolation: false }),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  return { orchestrator, sessions, task: (id: string) => orchestrator.storeInstance.get(id)! };
}

const plan = (overrides: Partial<Task> = {}): Task => ({
  ...createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'Parse objects and arrays.\nEvery test passes.' }),
  ...overrides,
});

const sentByOrdewell = (session: FakeRunnerSession) => session.queued().filter((m) => m.from === 'ordewell');

describe('a runner that compacts its own context is told to finish its brief', () => {
  it('queues one message with the task and its commit-and-complete line behind the running turn', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan()]);
    await h.orchestrator.forceStartTask('t1');

    h.sessions[0].emitEvent({ type: 'compaction', trigger: 'auto', preTokens: 180_000, postTokens: 9_000 });

    const sent = sentByOrdewell(h.sessions[0]);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Parse JSON');
    expect(sent[0].text).toContain('Parse objects and arrays.\nEvery test passes.');
    expect(sent[0].text).toMatch(/If what the brief asks is done, commit and call `task_complete` now/);
    expect(sent[0].text).toMatch(/Work beyond the brief belongs to other tasks/);
  });

  it('sends one per compaction: two compactions give two messages', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan()]);
    await h.orchestrator.forceStartTask('t1');

    h.sessions[0].emitEvent({ type: 'compaction', trigger: 'auto' });
    h.sessions[0].emitEvent({ type: 'compaction', trigger: 'auto' });

    expect(sentByOrdewell(h.sessions[0])).toHaveLength(2);
  });

  it('sends none for a compaction the user asked for', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan()]);
    await h.orchestrator.forceStartTask('t1');

    h.sessions[0].emitEvent({ type: 'compaction', trigger: 'manual' });

    expect(sentByOrdewell(h.sessions[0])).toEqual([]);
  });

  it('sends none to an attempt that has ended', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan()]);
    await h.orchestrator.forceStartTask('t1');
    h.sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(h.task('t1').status).toBe('completed'));

    h.sessions[0].emitEvent({ type: 'compaction', trigger: 'auto' });

    expect(sentByOrdewell(h.sessions[0])).toEqual([]);
    expect(h.sessions[0].delivered.filter((_, i) => h.sessions[0].fromOrdewell.includes(h.sessions[0].delivered[i]))).toEqual([]);
  });

  it('sends none to an attempt waiting for input, and its status stays', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan()]);
    await h.orchestrator.forceStartTask('t1');
    h.sessions[0].waitForInput();
    expect(h.task('t1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
    const before = h.sessions[0].fromOrdewell.length;

    h.sessions[0].emitEvent({ type: 'compaction', trigger: 'auto' });

    expect(sentByOrdewell(h.sessions[0])).toEqual([]);
    expect(h.sessions[0].fromOrdewell).toHaveLength(before);
    expect(h.task('t1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });
  });

  it('sends none to an attempt waiting at a checkpoint', async () => {
    const h = setup();
    h.orchestrator.loadPlan([plan()]);
    await h.orchestrator.forceStartTask('t1');
    void h.sessions[0].callCheckpoint('May I?');
    await vi.waitFor(() => expect(h.task('t1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint' }));

    h.sessions[0].emitEvent({ type: 'compaction', trigger: 'auto' });

    expect(sentByOrdewell(h.sessions[0])).toEqual([]);
    expect(h.task('t1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint' });
  });
});
