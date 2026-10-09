import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { serializeTaskStatus } from '../SessionMessage';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeStructuredSession, FakeTerminalSession, flushMicrotasks } from '../../testing';
import { fakeNotification, makeSession, saves, taskOf } from './sessionTestKit';
import type { ITerminalRunner, ITerminalSession, RunnerTransport } from '../../interfaces/ITerminalRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';

/**
 * The runner a {@link TransportRouter} would be: a structured session for a
 * structured request on Claude Code, a terminal one otherwise. Records what
 * each spawn asked for.
 */
function routingRunner() {
  const sessions: FakeTerminalSession[] = [];
  const requests: RunnerSpawnOptions[] = [];
  const runner = {
    spawn: vi.fn(async (opts: RunnerSpawnOptions): Promise<ITerminalSession> => {
      requests.push(opts);
      const id = `s${sessions.length + 1}`;
      const session = opts.transport === 'structured' && opts.runner === 'claude-code'
        ? new FakeStructuredSession(id, opts.taskId, `native-${opts.taskId}`)
        : new FakeTerminalSession(id, opts.taskId);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies ITerminalRunner;
  return { runner, sessions, requests };
}

function orchestratorWith(transport: RunnerTransport | undefined, runner: ITerminalRunner) {
  return TaskOrchestrator.compose({
    config: fakeConfig(),
    notifications: fakeNotification(),
    terminalRunner: runner,
    output: new BufferedTaskOutputSource({ transcripts: { finalAssistantText: async () => null } }),
    registry: new RunnerRegistry(),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    transport,
  });
}

const settle = () => flushMicrotasks(50);

describe('the structured transport, asked for by default', () => {
  it('is what every task of a run and every later run asks for', async () => {
    const { runner, sessions, requests } = routingRunner();
    const orchestrator = orchestratorWith(undefined, runner);
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'one', completionMarker: 'mk-1' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'two', completionMarker: 'mk-2', dependencies: ['t1'] }),
    ]);

    await orchestrator.approveReview();
    sessions[0].emitOutput('<<<ORDEWELL_DONE_mk-1>>>');
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    sessions[1].emitOutput('<<<ORDEWELL_DONE_mk-2>>>');
    await vi.waitFor(() => expect(orchestrator.status).toBe('completed'));
    await orchestrator.retryTask('t2');
    await orchestrator.runTask('t2');
    await settle();

    expect(requests.map((r) => r.transport)).toEqual(['structured', 'structured', 'structured']);
  });

  it('runs a saved plan that an older build pinned to the terminal structured, and stops saving the pin', async () => {
    const { runner, requests } = routingRunner();
    const session = makeSession({ runner });
    const plan = {
      tasks: [createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', completionMarker: 'mk-1' })],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
      runnerTransport: 'terminal',
    } as LegacyPlanState;
    session.loadPlan(plan, 'Goal', '/repo');
    expect(saves(session).mock.lastCall?.[0]).not.toHaveProperty('runnerTransport');

    await session.executePlan();

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].transport).toBe('structured');
    expect(taskOf(session, 't1')?.transport).toEqual({ kind: 'structured' });
  });
});

describe('recording the transport on the task', () => {
  it('records a structured task, and says so on its status', async () => {
    const { runner } = routingRunner();
    const orchestrator = orchestratorWith('structured', runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);

    await orchestrator.forceStartTask('t1');

    const task = orchestrator.storeInstance.get('t1')!;
    expect(task.transport).toEqual({ kind: 'structured' });
    expect(serializeTaskStatus(task).transport).toEqual({ kind: 'structured' });
  });

  it('records the fallback and its reason for a runner with no connector', async () => {
    const { runner } = routingRunner();
    const orchestrator = orchestratorWith('structured', runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', assignedRunner: 'my-plugin' })], ['my-plugin']);

    await orchestrator.forceStartTask('t1');

    const status = serializeTaskStatus(orchestrator.storeInstance.get('t1')!);
    expect(status.transport).toEqual({ kind: 'terminal', fallback: 'no structured connector for my-plugin yet' });
  });

  it('names a host that cannot run structured tasks as the reason, never falling back silently', async () => {
    const runner = {
      spawn: vi.fn(async (opts: RunnerSpawnOptions) => new FakeTerminalSession('s1', opts.taskId)),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies ITerminalRunner;
    const orchestrator = orchestratorWith('structured', runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);

    await orchestrator.forceStartTask('t1');

    expect(orchestrator.storeInstance.get('t1')!.transport).toEqual({ kind: 'terminal', fallback: 'this surface cannot run structured tasks' });
  });

  it('records nothing on a terminal plan', async () => {
    const { runner } = routingRunner();
    const orchestrator = orchestratorWith('terminal', runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);

    await orchestrator.forceStartTask('t1');

    const task = orchestrator.storeInstance.get('t1')!;
    expect(task.transport).toBeUndefined();
    expect(serializeTaskStatus(task)).not.toHaveProperty('transport');
  });
});

describe('ending a structured attempt', () => {
  it('stops the structured session once its task passes, instead of leaving it running', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith('structured', runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', completionMarker: 'mk-1' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput('Done.\n<<<ORDEWELL_DONE_mk-1>>>\n');
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

    expect(runner.stop).toHaveBeenCalledWith('s1');
    expect(orchestrator.storeInstance.get('t1')!.verdict?.outcome).toBe('pass');
  });

  it('saves the runner\'s own session id on the task for a later continue', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith('structured', runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', completionMarker: 'mk-1' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput('<<<ORDEWELL_DONE_mk-1>>>');
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

    expect(orchestrator.storeInstance.get('t1')!.transport).toEqual({ kind: 'structured', nativeSessionId: 'native-t1' });
  });

  it('leaves a terminal task\'s runner up after its pass, as before', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith('terminal', runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', completionMarker: 'mk-1' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput('<<<ORDEWELL_DONE_mk-1>>>');
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

    expect(runner.stop).not.toHaveBeenCalled();
  });
});

describe('completing through task_complete (ADR-0022)', () => {
  it('teaches the tool only to a structured task whose runner is given it', async () => {
    const { runner, requests } = routingRunner();
    const orchestrator = orchestratorWith('structured', runner);
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Claude', prompt: 'one' }),
      createTask({ id: 't2', order: 2, title: 'Codex', prompt: 'two', assignedRunner: 'codex' }),
      createTask({ id: 't3', order: 3, title: 'OpenCode', prompt: 'three', assignedRunner: 'opencode' }),
      createTask({ id: 't4', order: 4, title: 'Other', prompt: 'four', assignedRunner: 'other-runner' }),
    ], ['claude-code', 'codex', 'opencode', 'other-runner']);
    await orchestrator.forceStartTask('t1');
    await orchestrator.forceStartTask('t2');
    await orchestrator.forceStartTask('t3');
    await orchestrator.forceStartTask('t4');

    expect(requests[0].prompt).toContain('`task_complete`');
    expect(requests[1].prompt).toContain('`task_complete`');
    expect(requests[2].prompt).toContain('`task_complete`');
    expect(requests[3].prompt).not.toContain('task_complete');

    const terminal = routingRunner();
    const onTerminal = orchestratorWith('terminal', terminal.runner);
    onTerminal.loadPlan([createTask({ id: 't1', order: 1, title: 'Claude', prompt: 'one' })]);
    await onTerminal.forceStartTask('t1');
    expect(terminal.requests[0].prompt).not.toContain('task_complete');
  });

  it('numbers each attempt it spawns', async () => {
    const { runner, sessions, requests } = routingRunner();
    const orchestrator = orchestratorWith('structured', runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');
    sessions[0].emitExit(1);
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));

    await orchestrator.retryTask('t1');
    await orchestrator.runTask('t1');
    await settle();

    expect(requests.map((r) => r.attempt)).toEqual([1, 2]);
  });

  it('passes a task on a done call, and hands its summary to dependents', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith('structured', runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', completionMarker: 'mk-1' })]);
    await orchestrator.forceStartTask('t1');
    const session = sessions[0] as FakeStructuredSession;
    session.emitOutput('a screen of work\n');

    session.reportComplete({ status: 'done', summary: 'Added the parser and its tests.' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('completed'));

    const task = orchestrator.storeInstance.get('t1')!;
    expect(task.verdict?.checks[0].name).toBe('task_complete');
    expect(task.outputSummary?.logTail).toBe('Added the parser and its tests.');
    expect(runner.stop).toHaveBeenCalledWith('s1');
  });

  it('fails a task on a blocked call, saying why', async () => {
    const { runner, sessions } = routingRunner();
    const orchestrator = orchestratorWith('structured', runner);
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it', completionMarker: 'mk-1' })]);
    await orchestrator.forceStartTask('t1');

    (sessions[0] as FakeStructuredSession).reportComplete({ status: 'blocked', summary: 'Nothing changed.', reason: 'the schema file is missing' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')!.status).toBe('failed'));

    expect(orchestrator.storeInstance.get('t1')!.verdict?.reason).toContain('the schema file is missing');
  });
});

describe('checkpointing through the checkpoint tool (ADR-0022, V5)', () => {
  function hitlPlan() {
    return [createTask({ id: 't1', order: 1, title: 'Migrate', prompt: 'do it', autonomy: 'HITL', completionMarker: 'mk-1' })];
  }

  async function asking() {
    const { runner, sessions, requests } = routingRunner();
    const orchestrator = orchestratorWith('structured', runner);
    orchestrator.loadPlan(hitlPlan());
    const events: Array<{ taskId: string; taskTitle: string; summary: string }> = [];
    orchestrator.subscribe({ onCheckpoint: (data) => events.push(data) });
    await orchestrator.forceStartTask('t1');
    const session = sessions[0] as FakeStructuredSession;
    return { orchestrator, session, events, requests };
  }

  it('teaches the tool, with the marker as its fallback', async () => {
    const { requests } = await asking();

    expect(requests[0].prompt).toContain('Call the `checkpoint` tool');
    expect(requests[0].prompt).toContain('`<<<ORDEWELL_` immediately followed by `CHECKPOINT:`');
  });

  it('waits on the user as a marker checkpoint does, then answers the call with continue', async () => {
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

  it('keeps the marker path writing its answer into the session', async () => {
    const { orchestrator, session } = await asking();

    session.emitOutput('<<<ORDEWELL_CHECKPOINT: need review>>>');
    orchestrator.approveCheckpoint('t1');

    expect(session.written.join('')).toContain('ORDEWELL_CONTINUE');
  });
});
