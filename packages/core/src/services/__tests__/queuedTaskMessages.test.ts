import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { createTask } from '../../models/Task';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeStructuredSession, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { claudeTurnEndQueue, fakeSpawn, scriptedAdapter } from './harnessTestKit';
import { isStructuredSession, type ITerminalRunner, type StructuredEvent } from '../../interfaces/ITerminalRunner';

const runners: StructuredRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.stopAll(); });

function scheduled() {
  const session = new FakeStructuredSession();
  const runner = {
    spawn: async () => session,
    stop: () => session.kill(),
    stopAll: () => session.kill(),
    activeCount: 1,
  } satisfies ITerminalRunner;
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(), notifications: fakeNotification(), terminalRunner: runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(), workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Queued task', prompt: 'Do it' })]);
  return { orchestrator, session };
}

describe('queued task messages before settlement', () => {
  it('keeps the same attempt running after done until the queued message gets new evidence', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    orchestrator.sendTaskMessage('t1', 'Also add tests');
    session.reportComplete({ status: 'done', summary: 'Original work' });
    await flushMicrotasks(50);
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('in_progress');
    session.emitTurnEnd('completed');
    expect(session.delivered).toEqual(['Also add tests']);
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('in_progress');
    session.reportComplete({ status: 'done', summary: 'Work with tests' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')?.status).toBe('completed'));
    expect(orchestrator.storeInstance.get('t1')?.outputSummary?.logTail).toBe('Work with tests');
  });

  it('delivers several queued messages in order without a status flicker', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    for (const text of ['one', 'two', 'three']) orchestrator.sendTaskMessage('t1', text);
    for (let i = 0; i < 3; i++) {
      session.reportComplete({ status: 'done', summary: `Turn ${i}` });
      session.emitTurnEnd('completed');
      await flushMicrotasks(50);
      expect(orchestrator.storeInstance.get('t1')?.status).toBe('in_progress');
    }
    expect(session.delivered).toEqual(['one', 'two', 'three']);
    session.reportComplete({ status: 'failed', summary: 'Final failure', reason: 'Tests failed' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')?.status).toBe('failed'));
    expect(orchestrator.storeInstance.get('t1')?.verdict?.reason).toContain('Tests failed');
    expect(orchestrator.storeInstance.get('t1')?.outputSummary?.logTail).toBe('Final failure');
  });

  it.each(['blocked', 'failed'] as const)('supersedes a %s report after a queued message', async (status) => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    orchestrator.sendTaskMessage('t1', 'The missing file is here');
    session.reportComplete({ status, summary: 'Missing file', reason: 'No schema' });
    session.emitTurnEnd('completed');
    expect(session.delivered).toEqual(['The missing file is here']);
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('in_progress');
    session.reportComplete({ status: 'done', summary: 'Fixed' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')?.status).toBe('completed'));
    expect(orchestrator.storeInstance.get('t1')?.outputSummary?.logTail).toBe('Fixed');
  });

  it('requires fresh evidence when the follow-up turn ends without a report', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    orchestrator.sendTaskMessage('t1', 'Please check again');
    session.reportComplete({ status: 'done', summary: '' });
    session.emitTurnEnd('completed');
    session.emitOutput('I have a question');
    session.emitTurnEnd('completed');
    await flushMicrotasks(50);
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('awaiting_user');
    expect(orchestrator.storeInstance.get('t1')?.verdict).toBeUndefined();
    orchestrator.stop();
  });

  it('uses only the follow-up turn when a completion call supersedes the previous report', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    session.emitOutput('Original work\n');
    orchestrator.sendTaskMessage('t1', 'Also add tests');
    session.reportComplete({ status: 'done', summary: 'Original summary' });
    session.emitTurnEnd('completed');
    session.reportComplete({ status: 'done', summary: 'Work with tests' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')?.status).toBe('completed'));
    expect(orchestrator.storeInstance.get('t1')?.outputSummary?.logTail).toBe('Work with tests');
  });

  it('does not deliver a removed message, and settles the held evidence at turn end', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    const id = orchestrator.sendTaskMessage('t1', 'Never mind');
    session.reportComplete({ status: 'done', summary: 'Finished' });
    expect(orchestrator.removeQueuedTaskMessage('t1', id)).toBe(true);
    session.emitTurnEnd('completed');
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')?.status).toBe('completed'));
    expect(session.delivered).toEqual([]);
  });

  it('rejects reports from a previous attempt after retrying held evidence', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    orchestrator.sendTaskMessage('t1', 'Again');
    session.reportComplete({ status: 'done', summary: 'Old turn' });
    await orchestrator.retryTask('t1');
    session.reportComplete({ status: 'done', summary: 'Late old report' });
    session.reportComplete({ status: 'done', summary: '' });
    await flushMicrotasks(50);
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('pending');
    expect(orchestrator.storeInstance.get('t1')?.verdict).toBeUndefined();
  });

});

describe('messages that cannot be delivered', () => {
  it.each(['kill', 'exit'] as const)('logs every queued message on %s and empties the queue', async (ending) => {
    const spawned = fakeSpawn([() => {}]);
    const runner = new StructuredRunner({
      process: { spawn: spawned.spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
      createAdapter: claudeTurnEndQueue,
    });
    runners.push(runner);
    const session = await runner.spawn({ taskId: 't1', runner: 'claude-code', prompt: 'Do it', cwd: '/repo', registry: new RunnerRegistry() });
    if (!isStructuredSession(session)) throw new Error('expected structured');
    const events: StructuredEvent[] = [];
    session.onEvent((event) => events.push(event));
    await vi.waitFor(() => expect(spawned.processes[0].written).toHaveLength(2));
    const id = session.sendMessage('Please do not lose this');
    if (ending === 'kill') session.kill();
    else spawned.processes[0].exit(1);
    await flushMicrotasks(50);
    expect(events).toContainEqual({ type: 'message_undelivered', messageId: id, text: 'Please do not lose this' });
    expect(session.queued()).toEqual([]);
    expect(spawned.processes[0].written).toHaveLength(2);
  });
});


describe('a failed structured turn with queued messages', () => {
  it('logs undelivered messages when the adapter fails without exiting', async () => {
    let end = () => {};
    const factory = scriptedAdapter([[{ type: 'error', message: 'Transport failed' }]]);
    const runner = new StructuredRunner({ createAdapter: (id, deps) => {
      const scripted = factory(id, deps);
      if (!scripted) throw new Error('expected scripted adapter');
      return {
        ...scripted,
        send: async (text, onEvent, signal) => {
          await new Promise<void>((resolve) => { end = resolve; });
          await scripted.send(text, onEvent, signal);
        },
        mcpAttached: async () => true,
        interrupt: async () => false,
        onProcessExit: () => {},
        answerPermission: () => false,
      };
    } });
    runners.push(runner);
    const session = await runner.spawn({ taskId: 't1', runner: 'claude-code', prompt: 'Do it', cwd: '/repo', registry: new RunnerRegistry() });
    if (!isStructuredSession(session)) throw new Error('expected structured');
    const events: StructuredEvent[] = [];
    session.onEvent((event) => events.push(event));
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'turn_start', text: 'Do it' }));
    const id = session.sendMessage('Do not lose this');
    end();
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'message_undelivered', messageId: id, text: 'Do not lose this' }));
    expect(session.queued()).toEqual([]);
    expect(session.turnState()).toBe('idle');
  });
});
