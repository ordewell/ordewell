import { StructuredRunner } from '../StructuredRunner';
import { fakeMcpServer } from './harnessTestKit';
import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { serializeTaskStatus, surfacePlan } from '../SessionMessage';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession, flushMicrotasks } from '../../testing';
import { fakeNotification, makeSession, saves, taskOf } from './sessionTestKit';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';

function routingRunner() {
  const sessions: FakeRunnerSession[] = [];
  const requests: RunnerSpawnOptions[] = [];
  const runner = {
    spawn: vi.fn(async (opts: RunnerSpawnOptions): Promise<IRunnerSession> => {
      requests.push(opts);
      const id = `s${sessions.length + 1}`;
      const session = new FakeRunnerSession(id, opts.taskId, `native-${opts.taskId}`);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  return { runner, sessions, requests };
}

function orchestratorWith(runner: IRunner, notifications = fakeNotification(), registry = new RunnerRegistry()) {
  return TaskOrchestrator.compose({
    config: fakeConfig(),
    notifications,
    runner,
    output: new BufferedTaskOutputSource(),
    registry,
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
}

const settle = () => flushMicrotasks(50);

describe('the structured transport, the only one', () => {
  it('runs every task and starts a fresh runner session on retry', async () => {
    const { runner, sessions, requests } = routingRunner();
    const orchestrator = orchestratorWith(runner);
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'one' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'two', dependencies: ['t1'] }),
    ]);

    await orchestrator.approveReview();
    sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    sessions[1].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(orchestrator.status).toBe('completed'));
    await orchestrator.retryTask('t2');
    await orchestrator.forceStartTask('t2');
    await settle();

    expect(requests).toHaveLength(3);
    expect(orchestrator.storeInstance.get('t1')!.runnerSessionId).toBe('native-t1');
    expect(orchestrator.storeInstance.get('t2')!.runnerSessionId).toBeUndefined();
  });

  it('runs a saved plan that an older build pinned to the terminal structured, and stops saving the pin', async () => {
    const { runner, requests } = routingRunner();
    const session = makeSession({ runner });
    const plan = {
      tasks: [createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
      runnerTransport: 'terminal',
    } as LegacyPlanState;
    session.loadPlan(plan, 'Goal', '/repo');
    expect(saves(session).mock.lastCall?.[0]).not.toHaveProperty('runnerTransport');

    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(taskOf(session, 't1')).not.toHaveProperty('transport');
  });
});

describe('recording the runner session on the task', () => {
  it('clears a saved runner session when a fresh attempt starts', async () => {
    const { runner } = routingRunner();
    const orchestrator = orchestratorWith(runner);
    orchestrator.loadPlan([{ ...createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' }), runnerSessionId: 'previous-session' }]);

    await orchestrator.forceStartTask('t1');

    const task = orchestrator.storeInstance.get('t1')!;
    expect(task.runnerSessionId).toBeUndefined();
    expect(serializeTaskStatus(task)).not.toHaveProperty('transport');
  });

  it('keeps the runner\'s own session id off a surface', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith(runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

    const task = orchestrator.storeInstance.get('t1')!;
    expect(task.runnerSessionId).toBe('native-t1');
    const plan = { tasks: [task], generatedAt: '', status: 'approved' as const, runners: ['claude-code'], lastUpdated: '' };
    expect(surfacePlan(plan).tasks[0]).not.toHaveProperty('runnerSessionId');
    expect(surfacePlan({ ...plan, plannerSession: { runner: 'claude-code', sessionId: 'native-planner', cwd: '/repo', heard: 2 } })).not.toHaveProperty('plannerSession');
  });
});

describe('a runner with no structured connector', () => {
  it('is refused at spawn, saying why, and never reaches the runner', async () => {
    const { runner } = routingRunner();
    const notifications = fakeNotification();
    const orchestrator = orchestratorWith(runner, notifications);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', assignedRunner: 'my-plugin' })], ['my-plugin']);

    await orchestrator.forceStartTask('t1');

    expect(runner.spawn).not.toHaveBeenCalled();
    const task = orchestrator.storeInstance.get('t1')!;
    expect(task.status).toBe('pending');
    expect(task.runnerSessionId).toBeUndefined();
    expect(notifications.error).toHaveBeenCalledWith(expect.stringContaining('my-plugin has no structured connector, so Ordewell cannot run its tasks'));
  });
});

describe('a task whose mode this host cannot run', () => {
  it('fails at spawn with the reason, before a worktree or the runner is touched', async () => {
    const { runner } = routingRunner();
    const notifications = fakeNotification();
    const registry = new RunnerRegistry();
    registry.setUnavailableModes('codex', { plan: 'Codex sandbox cannot start on this host.' });
    const orchestrator = orchestratorWith(runner, notifications, registry);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', assignedRunner: 'codex', taskMode: 'plan' })], ['codex']);

    await orchestrator.forceStartTask('t1');

    expect(runner.spawn).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalledWith(expect.stringContaining('Mode "plan" of Codex is unavailable on this host: Codex sandbox cannot start on this host.'));
  });
});

describe('ending a structured attempt', () => {
  it('stops the structured session once its task passes, instead of leaving it running', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith(runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput('Done.\n');
    sessions[0].reportComplete({ status: 'done', summary: '' });
    sessions[0].emitOutput('\n');
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

    expect(runner.stop).toHaveBeenCalledWith('s1');
    expect(orchestrator.storeInstance.get('t1')!.verdict?.outcome).toBe('pass');
  });

  it('saves the runner\'s own session id on the task for a later continue', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith(runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

    expect(orchestrator.storeInstance.get('t1')!.runnerSessionId).toBe('native-t1');
  });
});

describe('completing through task_complete (ADR-0022)', () => {
  it('leaves the completion contract to every runner\'s instructions, not its first message', async () => {
    const { runner, requests } = routingRunner();
    const orchestrator = orchestratorWith(runner);
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Claude', prompt: 'one' }),
      createTask({ id: 't2', order: 2, title: 'Codex', prompt: 'two', assignedRunner: 'codex' }),
      createTask({ id: 't3', order: 3, title: 'OpenCode', prompt: 'three', assignedRunner: 'opencode' }),
    ], ['claude-code', 'codex', 'opencode']);
    await orchestrator.forceStartTask('t1');
    await orchestrator.forceStartTask('t2');
    await orchestrator.forceStartTask('t3');

    expect(requests.map((r) => r.prompt.includes('task_complete'))).toEqual([false, false, false]);
  });

  it('numbers each attempt it spawns', async () => {
    const { runner, sessions, requests } = routingRunner();
    const orchestrator = orchestratorWith(runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');
    sessions[0].emitExit(1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));

    await orchestrator.retryTask('t1');
    await orchestrator.forceStartTask('t1');
    await settle();

    expect(requests.map((r) => r.attempt)).toEqual([1, 2]);
  });

  it('passes a task on a done call, and hands its summary to dependents', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith(runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');
    const session = sessions[0] as FakeRunnerSession;
    session.emitOutput('a screen of work\n');

    session.reportComplete({ status: 'done', summary: 'Added the parser and its tests.' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

    const task = orchestrator.storeInstance.get('t1')!;
    expect(task.verdict?.checks[0].name).toBe('task_complete');
    expect(task.handoff?.summary).toBe('Added the parser and its tests.');
    expect(runner.stop).toHaveBeenCalledWith('s1');
  });

  it('keeps the short summary in the digest and the long report outside the plan', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith(runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Review', prompt: 'review it' })]);
    await orchestrator.forceStartTask('t1');
    const findings = Array.from({ length: 40 }, (_, i) => `Finding ${i + 1}: services/Foo.ts:${i + 10} drops the error on retry.`).join('\n');

    (sessions[0] as FakeRunnerSession).reportComplete({ status: 'done', summary: 'Review complete', report: findings });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

    const summary = orchestrator.storeInstance.get('t1')!.outputSummary!;
    expect(summary.report).toBeUndefined();
    expect(orchestrator.storeInstance.get('t1')!.handoff?.summary).toBe('Review complete');
  });

  it('keeps the summary of a blocked call in its handoff', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith(runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');

    (sessions[0] as FakeRunnerSession).reportComplete({ status: 'blocked', summary: 'Tried the migration; the schema file is missing.', reason: 'no schema' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));

    expect(orchestrator.storeInstance.get('t1')!.handoff?.summary).toBe('Tried the migration; the schema file is missing.');
  });

  it('fails a task on a blocked call, saying why', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith(runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');

    (sessions[0] as FakeRunnerSession).reportComplete({ status: 'blocked', summary: 'Nothing changed.', reason: 'the schema file is missing' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));

    expect(orchestrator.storeInstance.get('t1')!.verdict?.reason).toContain('the schema file is missing');
  });
});

describe('checkpointing through the checkpoint tool (ADR-0022, V5)', () => {
  function hitlPlan() {
    return [createTask({ id: 't1', order: 1, title: 'Migrate', prompt: 'do it', autonomy: 'HITL' })];
  }

  async function asking() {
    const { runner, sessions, requests } = routingRunner();
    const orchestrator = orchestratorWith(runner);
    orchestrator.loadPlan(hitlPlan());
    const events: Array<{ taskId: string; taskTitle: string; summary: string }> = [];
    orchestrator.subscribe({ onCheckpoint: (data) => events.push(data) });
    await orchestrator.forceStartTask('t1');
    const session = sessions[0] as FakeRunnerSession;
    return { orchestrator, session, events, requests };
  }

  it('teaches the tool, and no text marker', async () => {
    const { requests } = await asking();

    expect(requests[0].prompt).toContain('Call the `checkpoint` tool');
    expect(requests[0].prompt).not.toContain('ORDEWELL');
  });
  it('waits on the user, then answers the call with continue', async () => {
    const { orchestrator, session, events } = await asking();

    const answer = session.callCheckpoint('Drop the table?');

    expect(events).toEqual([{ taskId: 't1', taskTitle: 'Migrate', summary: 'Drop the table?' }]);
    const waiting = orchestrator.storeInstance.get('t1')!;
    expect(waiting.status).toBe('awaiting_user');
    expect(waiting.awaitingReason).toBe('checkpoint');

    orchestrator.approveCheckpoint('t1');

    await expect(answer).resolves.toEqual({ kind: 'continue' });
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
    expect(session.written).toEqual([]);
  });

  it('answers the call with the user\'s reason on reject', async () => {
    const { orchestrator, session } = await asking();

    const answer = session.callCheckpoint('Drop the table?');
    orchestrator.rejectCheckpoint('t1', 'not on production');

    await expect(answer).resolves.toEqual({ kind: 'rejected', reason: 'not on production' });
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
    expect(session.written).toEqual([]);
  });

  it('withdraws a waiting call when the attempt is retried', async () => {
    const { orchestrator, session } = await asking();

    const answer = session.callCheckpoint('Drop the table?');
    await orchestrator.retryTask('t1');

    await expect(answer).resolves.toMatchObject({ kind: 'withdrawn' });
  });

  it('withdraws a waiting call when the run is stopped', async () => {
    const { orchestrator, session } = await asking();

    const answer = session.callCheckpoint('Drop the table?');
    orchestrator.stop();

    await expect(answer).resolves.toMatchObject({ kind: 'withdrawn' });
  });

  it('puts a task back in progress when its call went away with the attempt still running', async () => {
    const { orchestrator, session } = await asking();
    const gone = new AbortController();

    void session.callCheckpoint('Drop the table?', gone.signal);
    expect(orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user');
    gone.abort();

    expect(orchestrator.storeInstance.get('t1')!.status).toBe('in_progress');
  });

});

describe('a task whose MCP tools cannot attach', () => {
  function cannotAttach(report: 'pending' | 'failed') {
    const server = fakeMcpServer();
    const issue = server.issueTaskToken.bind(server);
    const scopes: Array<{ taskId: string; attempt: number }> = [];
    server.issueTaskToken = async (scope, handler) => {
      scopes.push(scope);
      return issue(scope, handler);
    };
    const send = vi.fn(async () => {});
    const disposed: string[] = [];
    let spawns = 0;
    const runner = new StructuredRunner({ mcp: server, createAdapter: () => {
      const id = String(++spawns);
      return {
        agentId: 'claude-code', exited: false, start: async () => {}, send,
        nativeSessionId: () => null, dispose: () => { disposed.push(id); },
        mcpAttached: async () => report, interrupt: async () => false,
        answerPermission: () => false, onProcessExit: () => {},
      };
    } });
    const orchestrator = orchestratorWith(runner);
    const notices: string[] = [];
    const settled: string[] = [];
    orchestrator.subscribe({
      onIsolationNotice: ({ message }) => notices.push(message),
      onTaskSettled: ({ taskId }) => settled.push(taskId),
    });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Only', prompt: 'Do it', taskMode: 'acceptEdits' }),
      createTask({ id: 't2', order: 2, title: 'After', prompt: 'Then it', taskMode: 'acceptEdits', dependencies: ['t1'] }),
    ]);
    return { orchestrator, runner, send, disposed, scopes, notices, settled, spawns: () => spawns };
  }

  it('holds the task with a reason when the respawn never connects, so its dependents are not blocked', async () => {
    const env = cannotAttach('pending');

    await env.orchestrator.forceStartTask('t1');

    expect(env.spawns()).toBe(2);
    expect(new Set(env.disposed)).toEqual(new Set(['1', '2']));
    expect(env.send).not.toHaveBeenCalled();
    expect(env.scopes.map(({ taskId, attempt }) => ({ taskId, attempt }))).toEqual([
      { taskId: 't1', attempt: 1 }, { taskId: 't1', attempt: 1 },
    ]);
    expect(env.orchestrator.storeInstance.get('t1')?.status).toBe('pending');
    expect(env.orchestrator.holdReason('t1')).toBe('could not connect to Ordewell\'s tools; start it again');
    expect(serializeTaskStatus(env.orchestrator.storeInstance.get('t1')!, null, null, [], 0, [], '', false, env.orchestrator.holdReason('t1')))
      .toMatchObject({ holdReason: 'could not connect to Ordewell\'s tools; start it again' });
    expect(env.orchestrator.startWaits(env.orchestrator.storeInstance.get('t1')!).find((wait) => wait.kind === 'on-hold'))
      .toEqual({ kind: 'on-hold', reason: 'could not connect to Ordewell\'s tools; start it again' });
    // A failure would block this one (ADR-0034); a hold leaves it waiting on
    // work that can still start rather than on one that never will.
    expect(env.orchestrator.storeInstance.get('t2')?.status).toBe('pending');
    expect(env.orchestrator.getBlockedBy('t2')).toEqual([]);
    expect(env.notices.filter((message) => message.includes('respawning once'))).toHaveLength(1);
    expect(env.settled).toEqual(['t1']);
    expect(env.runner.activeCount).toBe(0);
  });

  it('fails the task when the runner reports the server failed, a configuration problem', async () => {
    const env = cannotAttach('failed');

    await env.orchestrator.forceStartTask('t1');

    expect(env.spawns()).toBe(2);
    expect(env.send).not.toHaveBeenCalled();
    expect(env.orchestrator.storeInstance.get('t1')?.status).toBe('failed');
    expect(env.orchestrator.holdReason('t1')).toBeNull();
    expect(env.orchestrator.storeInstance.get('t1')?.outputSummary?.logTail).toContain('MCP server connected');
    expect(env.runner.activeCount).toBe(0);
  });
});
