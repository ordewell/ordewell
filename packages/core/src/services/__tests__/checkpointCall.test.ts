import { describe, it, expect, afterEach, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { OrdewellMcpServer, type TaskToolHandler } from '../mcp';
import { serializeTaskStatus } from '../SessionMessage';
import { fakeConfig, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { AgentEvent, AgentStartOptions, TaskModeAgentAdapter } from '../harness/AgentAdapter';
import type { ApprovalDecision } from '../../interfaces/IApproval';

/**
 * A runner's open `checkpoint` call and the turn it was made in (ADR-0022, V5).
 * The call is only ever the runner's to cancel, and a runner that is
 * interrupted does not always say so; Ordewell withdraws the checkpoint itself
 * once the turn that asked it is over.
 */

class ScriptedAdapter implements TaskModeAgentAdapter {
  async mcpAttached(): Promise<boolean> { return true; }
  readonly agentId = 'claude-code';
  readonly prompts: string[] = [];
  private turn: { onEvent: (event: AgentEvent) => void; resolve: () => void } | null = null;
  private exit: Array<(code: number) => void> = [];

  async start(_opts: AgentStartOptions): Promise<void> {}
  send(message: string, onEvent: (event: AgentEvent) => void): Promise<void> {
    this.prompts.push(message);
    return new Promise<void>((resolve) => { this.turn = { onEvent, resolve }; });
  }
  /** Whether a mid-turn message is taken; a refused one waits in the queue, where it can be force sent. */
  takesSteers = true;
  steer(_id: string, _text: string): Promise<boolean> { return Promise.resolve(this.takesSteers); }
  deliver(id: string): void { this.turn?.onEvent({ type: 'message_delivered', id }); }
  /** The runner stops its turn when interrupted, leaving any tool call it had open dangling. */
  async interrupt(): Promise<boolean> {
    queueMicrotask(() => {
      const turn = this.turn;
      this.turn = null;
      turn?.onEvent({ type: 'turn_end', interrupted: true });
      turn?.resolve();
    });
    return true;
  }
  onProcessExit(listener: (code: number) => void): void { this.exit.push(listener); }
  answerPermission(_id: string, _decision: ApprovalDecision): boolean { return true; }
  nativeSessionId(): string | null { return 'native-1'; }
  dispose(): void {}
}

/** The task's tool handler as the MCP server would hold it, so a call can be made without a socket and cancelled on demand. */
function fakeServer() {
  const handlers: TaskToolHandler[] = [];
  const server = {
    issueTaskToken: async (_scope: unknown, handler: TaskToolHandler): Promise<{ url: string; token: string; headers: Record<string, string> }> => {
      handlers.push(handler);
      return { url: 'http://127.0.0.1:0/mcp', token: 't', headers: {} };
    },
    revoke: () => undefined,
  };
  return { server: server as unknown as OrdewellMcpServer, handlers };
}

const runners: StructuredRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.stopAll(); });

const task = (id: string, extra: Partial<Task> = {}) =>
  createTask({ id, order: 1, title: `Task ${id}`, prompt: `do ${id}`, autonomy: 'HITL', ...extra });

async function asking() {
  const { server, handlers } = fakeServer();
  const adapters: ScriptedAdapter[] = [];
  const runner = new StructuredRunner({
    createAdapter: () => {
      const adapter = new ScriptedAdapter();
      adapters.push(adapter);
      return adapter;
    },
    mcp: server,
    interruptGraceMs: 20,
  });
  runners.push(runner);
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(), notifications: fakeNotification(), runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(), workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  orchestrator.loadPlan([task('t1')]);
  await orchestrator.forceStartTask('t1');
  await vi.waitFor(() => expect(adapters[0].prompts).toHaveLength(1));
  const get = () => orchestrator.storeInstance.get('t1')!;
  const ask = (question: string, signal = new AbortController().signal): Promise<string> => {
    const checkpoint = handlers[0].checkpoint;
    if (!checkpoint) throw new Error('no checkpoint tool');
    return checkpoint({ question }, { signal }).then((reply) => reply.text);
  };
  return { orchestrator, adapter: adapters[0], get, ask };
}

const settledAs = async (call: Promise<string>): Promise<string | 'pending'> =>
  Promise.race([call, flushMicrotasks(20).then(() => 'pending' as const)]);

describe('an interrupt while a checkpoint call waits', () => {
  it('withdraws the checkpoint, so the next call is taken and the task waits for input, not at a checkpoint', async () => {
    const { orchestrator, get, ask } = await asking();
    const first = ask('Drop the table?');
    await vi.waitFor(() => expect(get()).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint' }));

    await orchestrator.interruptTask('t1');

    expect(await first).toContain('withdrawn');
    expect(get()).toMatchObject({ status: 'awaiting_user', awaitingReason: 'input' });

    const next = ask('Drop the index?');
    await vi.waitFor(() => expect(get().awaitingReason).toBe('checkpoint'));
    expect(await settledAs(next)).toBe('pending');
    orchestrator.approveCheckpoint('t1');
    expect(await next).toBe('continue');
  });

  it('withdraws it for a force send of a message queued earlier, which interrupts too', async () => {
    const { orchestrator, adapter, get, ask } = await asking();
    adapter.takesSteers = false;
    const queued = orchestrator.sendTaskMessage('t1', 'also run the tests');
    await flushMicrotasks();
    const first = ask('Drop the table?');
    await vi.waitFor(() => expect(get().awaitingReason).toBe('checkpoint'));

    expect(orchestrator.forceSendQueuedTaskMessage('t1', queued)).toBe(true);

    expect(await first).toContain('withdrawn');
    await vi.waitFor(() => expect(adapter.prompts.slice(1)).toEqual(['also run the tests']));
    expect(get()).toMatchObject({ status: 'in_progress' });
    const next = ask('Drop the index?');
    await vi.waitFor(() => expect(get().awaitingReason).toBe('checkpoint'));
    expect(await settledAs(next)).toBe('pending');
  });

  it('leaves a call that went away on its own to the runner: the abort withdraws it as before', async () => {
    const { get, ask } = await asking();
    const controller = new AbortController();
    const first = ask('Drop the table?', controller.signal);
    await vi.waitFor(() => expect(get().awaitingReason).toBe('checkpoint'));

    controller.abort();

    expect(await first).toContain('cancelled');
    expect(get().status).toBe('in_progress');
    const next = ask('Again?');
    await vi.waitFor(() => expect(get().awaitingReason).toBe('checkpoint'));
    expect(await settledAs(next)).toBe('pending');
  });
});

describe('a message read mid-turn while a checkpoint call waits', () => {
  it('leaves the call open and answerable', async () => {
    const { orchestrator, adapter, get, ask } = await asking();
    const queued = orchestrator.sendTaskMessage('t1', 'use Postgres');
    await flushMicrotasks();
    const first = ask('Which database?');
    await vi.waitFor(() => expect(get().awaitingReason).toBe('checkpoint'));

    adapter.deliver(queued);
    await flushMicrotasks();

    expect(await settledAs(first)).toBe('pending');
    expect(get()).toMatchObject({ status: 'awaiting_user', awaitingReason: 'checkpoint' });
    orchestrator.rejectCheckpoint('t1', 'Postgres');
    expect(await first).toBe('rejected: Postgres');
    expect(get().status).toBe('in_progress');
  });
});

describe('the question a checkpoint asks', () => {
  const question = 'Drop the users table?\nIt holds 40k rows, and no backup exists.';

  it('is kept whole for as long as the checkpoint waits, and gone once it settles or is withdrawn', async () => {
    const { orchestrator, get, ask } = await asking();
    expect(orchestrator.getCheckpointQuestion('t1')).toBeUndefined();

    const first = ask(question);
    await vi.waitFor(() => expect(get().awaitingReason).toBe('checkpoint'));
    expect(orchestrator.getCheckpointQuestion('t1')).toBe(question);
    expect(orchestrator.awaitsCheckpoint('t1')).toBe(true);
    orchestrator.approveCheckpoint('t1');
    await first;
    expect(orchestrator.getCheckpointQuestion('t1')).toBeUndefined();

    const second = ask(question);
    await vi.waitFor(() => expect(get().awaitingReason).toBe('checkpoint'));
    await orchestrator.interruptTask('t1');
    await second;
    expect(orchestrator.getCheckpointQuestion('t1')).toBeUndefined();
  });

  it('rides the task status, only while the task waits at the checkpoint', async () => {
    const { orchestrator, get, ask } = await asking();
    const call = ask(question);
    await vi.waitFor(() => expect(get().awaitingReason).toBe('checkpoint'));

    expect(serializeTaskStatus(get(), null, null, [], 0, [], orchestrator.getCheckpointQuestion('t1')).checkpoint).toBe(question);
    orchestrator.rejectCheckpoint('t1', 'no');
    await call;
    expect(serializeTaskStatus(get(), null, null, [], 0, [], question)).not.toHaveProperty('checkpoint');
  });

  it('is refused cleanly when the task is not at a checkpoint', async () => {
    const { orchestrator, get } = await asking();
    expect(orchestrator.awaitsCheckpoint('t1')).toBe(false);
    orchestrator.approveCheckpoint('t1');
    orchestrator.rejectCheckpoint('t1', 'no');
    expect(get()).toMatchObject({ status: 'in_progress' });
  });
});

describe('an answer sent from outside the task view settles the open call', () => {
  it.each<[string, (o: Awaited<ReturnType<typeof asking>>['orchestrator']) => void, string]>([
    ['approve', (o) => o.approveCheckpoint('t1'), 'continue'],
    ['reject with a reason', (o) => o.rejectCheckpoint('t1', 'not on production'), 'rejected: not on production'],
    ['reject with no reason', (o) => o.rejectCheckpoint('t1'), 'rejected: Checkpoint rejected by user'],
  ])('%s', async (_name, answer, text) => {
    const { orchestrator, get, ask } = await asking();
    const call = ask('Drop the table?');
    await vi.waitFor(() => expect(get().awaitingReason).toBe('checkpoint'));

    answer(orchestrator);

    expect(await call).toBe(text);
    expect(get().status).toBe('in_progress');
  });
});
