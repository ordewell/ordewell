import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { createTask } from '../../models/Task';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import type { AgentEvent, AgentStartOptions, TaskModeAgentAdapter } from '../harness/AgentAdapter';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { IRunner, IRunnerSession, StructuredEvent, StructuredTurnEnd } from '../../interfaces/IRunner';

/**
 * Messages that reach a running structured task between tool calls
 * (ADR-0023): handed to an adapter that can take them mid-turn, in the order
 * they were sent, falling back to the turn's end — never lost — when the
 * runner refuses one, drops one, or goes away with one in flight.
 */

type Turn = { onEvent: (event: AgentEvent) => void; resolve: () => void };
type SteerAnswer = 'accept' | 'refuse' | 'throw' | 'hold';

/** A task adapter with no mid-turn delivery: each `send` stays open until the test ends it. */
class TurnEndAdapter implements TaskModeAgentAdapter {
  async mcpAttached(): Promise<boolean> { return true; }
  readonly agentId: string = 'claude-code';
  readonly exited = false;
  readonly sent: string[] = [];
  interruptAnswer: 'ack' | 'ignore' | 'hold' = 'ack';
  private releaseInterrupt: (() => void) | null = null;
  protected turn: Turn | null = null;
  private outOfTurn: ((event: AgentEvent) => void) | null = null;
  private readonly exitListeners: Array<(code: number) => void> = [];

  async start(_opts: AgentStartOptions): Promise<void> {}

  send(message: string, onEvent: (event: AgentEvent) => void): Promise<void> {
    this.sent.push(message);
    return new Promise<void>((resolve) => { this.turn = { onEvent, resolve }; });
  }

  /** A runner command opens a turn of its own, as a message does; `sent` shows it as typed. */
  invokeCommand(name: string, args: string, onEvent: (event: AgentEvent) => void): Promise<void> {
    return this.send(args ? `/${name} ${args}` : `/${name}`, onEvent);
  }

  emit(...events: AgentEvent[]): void {
    for (const event of events) this.turn?.onEvent(event);
  }

  /** What the runner says with no `send` in flight — a turn it opened itself. */
  emitOutOfTurn(...events: AgentEvent[]): void {
    for (const event of events) this.outOfTurn?.(event);
  }

  endTurn(interrupted = false): void {
    const turn = this.turn;
    this.turn = null;
    turn?.onEvent(interrupted ? { type: 'turn_end', interrupted: true } : { type: 'turn_end' });
    turn?.resolve();
  }

  /** The turn settles with no `turn_end` — how a turn that reported an `error` ends. */
  settle(): void {
    const turn = this.turn;
    this.turn = null;
    turn?.resolve();
  }

  async interrupt(): Promise<boolean> {
    if (this.interruptAnswer === 'ignore') return false;
    if (this.interruptAnswer === 'hold') await new Promise<void>((resolve) => { this.releaseInterrupt = resolve; });
    queueMicrotask(() => this.endTurn(true));
    return true;
  }

  finishInterrupt(): void { this.releaseInterrupt?.(); }

  onOutOfTurn(listener: (event: AgentEvent) => void): void { this.outOfTurn = listener; }
  onProcessExit(listener: (code: number) => void): void { this.exitListeners.push(listener); }
  exit(code: number): void { for (const listener of this.exitListeners.splice(0)) listener(code); }
  answerPermission(_id: string, _decision: ApprovalDecision): boolean { return false; }
  nativeSessionId(): string | null { return 'native-1'; }
  dispose(): void {}
}

/** The same, able to take a message into the running turn; each steer is answered as the test says. */
class SteeringAdapter extends TurnEndAdapter {
  override readonly agentId = 'codex';
  readonly steers: Array<{ id: string; text: string }> = [];
  /** How each next steer is answered, in turn; `accept` once these run out. */
  answers: SteerAnswer[] = [];
  private readonly held = new Map<string, (accepted: boolean) => void>();

  steer(id: string, text: string): Promise<boolean> {
    this.steers.push({ id, text });
    const answer = this.answers.shift() ?? 'accept';
    if (answer === 'throw') return Promise.reject(new Error('write EPIPE'));
    if (answer === 'hold') return new Promise<boolean>((resolve) => { this.held.set(id, resolve); });
    return Promise.resolve(answer === 'accept');
  }

  answer(id: string, accepted: boolean): void {
    this.held.get(id)?.(accepted);
    this.held.delete(id);
  }

  deliver(id: string): void { this.emit({ type: 'message_delivered', id }); }
  drop(id: string): void { this.emit({ type: 'message_dropped', id }); }
}

const registry = new RunnerRegistry();
const runners: StructuredRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.stopAll(); });

function options(overrides: Partial<RunnerSpawnOptions> = {}): RunnerSpawnOptions {
  return { taskId: 'task-0012-steer', runner: 'codex', prompt: 'Do the task', modelId: 'gpt-5.6-luna', mode: 'fullAccess', cwd: '/repo', registry, ...overrides };
}

function runnerOf<A extends TurnEndAdapter>(make: () => A) {
  const adapters: A[] = [];
  const runner = new StructuredRunner({
    createAdapter: () => {
      const adapter = make();
      adapters.push(adapter);
      return adapter;
    },
    interruptGraceMs: 20,
  });
  runners.push(runner);
  return { runner, adapters };
}

function observe(session: IRunnerSession) {
  const events: StructuredEvent[] = [];
  const turnEnds: StructuredTurnEnd[] = [];
  const statesAtTurnEnd: string[] = [];
  session.onEvent((event) => events.push(event));
  session.onTurnEnd((reason) => { turnEnds.push(reason); statesAtTurnEnd.push(session.turnState()); });
  return { session, events, turnEnds, statesAtTurnEnd };
}

/** A running task on a runner that can take messages mid-turn, its prompt already sent. */
async function steering(configure: (adapter: SteeringAdapter) => void = () => {}) {
  const { runner, adapters } = runnerOf(() => {
    const adapter = new SteeringAdapter();
    configure(adapter);
    return adapter;
  });
  const task = observe(await runner.spawn(options()));
  await vi.waitFor(() => expect(adapters[0].sent).toEqual(['Do the task']));
  return { ...task, adapter: adapters[0], adapters };
}

/** A running task on a runner that only takes messages at a turn's end, its prompt already sent. */
async function turnEnd() {
  const { runner, adapters } = runnerOf(() => new TurnEndAdapter());
  const task = observe(await runner.spawn(options({ runner: 'claude-code' })));
  await vi.waitFor(() => expect(adapters[0].sent).toEqual(['Do the task']));
  return { ...task, adapter: adapters[0], adapters };
}

const of = (events: StructuredEvent[], ...types: StructuredEvent['type'][]) => events.filter((e) => types.includes(e.type));

describe('a message sent to a working task, on a runner that takes one mid-turn', () => {
  it('is handed over at once, cannot be taken back, and is logged where the runner read it', async () => {
    const task = await steering();
    task.adapter.emit({ type: 'tool_call', id: 'c1', name: 'shell', args: { command: 'sleep 20' } });

    const id = task.session.sendMessage('use Postgres');
    expect(task.adapter.steers).toEqual([{ id, text: 'use Postgres' }]);
    await flushMicrotasks();
    expect(task.session.queued()).toEqual([{ id, text: 'use Postgres', handedOver: true }]);
    expect(task.session.removeQueued(id)).toBe(false);

    task.adapter.emit({ type: 'tool_result', id: 'c1', name: 'shell', output: '', success: true });
    task.adapter.deliver(id);
    task.adapter.emit({ type: 'assistant_text', runId: 'r1', text: 'Switching to Postgres.' });
    task.adapter.endTurn();
    await flushMicrotasks();

    expect(task.events.map((e) => e.type)).toEqual([
      'turn_start', 'tool_call', 'message_queued', 'message_handed_over', 'tool_result', 'message_delivered', 'assistant_text', 'turn_end',
    ]);
    expect(of(task.events, 'message_delivered')).toEqual([{ type: 'message_delivered', messageId: id, text: 'use Postgres' }]);
    expect(task.session.queued()).toEqual([]);
    expect(task.adapter.sent).toEqual(['Do the task']);
    expect(task.turnEnds).toEqual(['completed']);
    expect(task.session.turnState()).toBe('idle');
  });

  it('offers messages one at a time, so a later one never reaches the runner first', async () => {
    const task = await steering((adapter) => { adapter.answers = ['hold']; });

    const first = task.session.sendMessage('one');
    const second = task.session.sendMessage('two');
    expect(task.adapter.steers.map((s) => s.text)).toEqual(['one']);

    task.adapter.answer(first, true);
    await flushMicrotasks();
    expect(task.adapter.steers.map((s) => s.text)).toEqual(['one', 'two']);
    expect(task.session.queued()).toEqual([
      { id: first, text: 'one', handedOver: true },
      { id: second, text: 'two', handedOver: true },
    ]);
  });

  it('is offered to the first turn once it has gone out, when sent before', async () => {
    const { runner, adapters } = runnerOf(() => new SteeringAdapter());
    const task = observe(await runner.spawn(options()));
    task.session.sendMessage('and add tests');
    expect(adapters[0].steers).toEqual([]);

    await vi.waitFor(() => expect(adapters[0].steers.map((s) => s.text)).toEqual(['and add tests']));
    expect(adapters[0].sent).toEqual(['Do the task']);
  });

  it('waits for the turn to end when refused, and every later one waits behind it, to go with it in order', async () => {
    const task = await steering((adapter) => { adapter.answers = ['refuse']; });

    const first = task.session.sendMessage('one');
    await flushMicrotasks();
    const second = task.session.sendMessage('two');
    expect(task.adapter.steers.map((s) => s.text)).toEqual(['one']);
    expect(task.session.queued()).toEqual([{ id: first, text: 'one' }, { id: second, text: 'two' }]);

    task.adapter.endTurn();
    await flushMicrotasks();
    expect(task.adapter.sent).toEqual(['Do the task', 'one\ntwo']);
    expect(task.statesAtTurnEnd).toEqual(['working']);
    expect(task.adapter.steers.map((s) => s.text)).toEqual(['one']);
    expect(of(task.events, 'turn_start')).toEqual([
      { type: 'turn_start', text: 'Do the task' },
      { type: 'turn_start', text: 'one\ntwo', messageId: first },
    ]);
  });

  it('treats a steer that fails outright as a refusal', async () => {
    const task = await steering((adapter) => { adapter.answers = ['throw']; });
    const id = task.session.sendMessage('one');
    await flushMicrotasks();
    expect(task.session.queued()).toEqual([{ id, text: 'one' }]);
    expect(task.session.removeQueued(id)).toBe(true);
  });

  it('is sent as the next turn when the runner drops it unread, with no wait for input in between', async () => {
    const task = await steering();
    const id = task.session.sendMessage('use Postgres');
    await flushMicrotasks();

    task.adapter.drop(id);
    task.adapter.endTurn();
    await flushMicrotasks();

    expect(task.events.filter((e) => e.type.startsWith('message_'))).toEqual([
      { type: 'message_queued', messageId: id, text: 'use Postgres' },
      { type: 'message_handed_over', messageId: id },
      { type: 'message_queued', messageId: id, text: 'use Postgres' },
    ]);
    expect(task.adapter.sent).toEqual(['Do the task', 'use Postgres']);
    expect(task.statesAtTurnEnd).toEqual(['working']);
    expect(of(task.events, 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'use Postgres', messageId: id });
  });

  it('keeps the task working past a turn end while the runner owes a message, and gives the turn it opens for it that message', async () => {
    const task = await steering();
    const id = task.session.sendMessage('use Postgres');
    await flushMicrotasks();

    task.adapter.endTurn();
    await flushMicrotasks();
    expect(task.statesAtTurnEnd).toEqual(['working']);
    expect(task.adapter.sent).toEqual(['Do the task']);

    task.adapter.emitOutOfTurn({ type: 'message_delivered', id }, { type: 'assistant_text', runId: 'r1', text: 'On it.' }, { type: 'turn_end' });
    expect(of(task.events, 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'use Postgres', messageId: id });
    expect(of(task.events, 'message_delivered')).toEqual([]);
    expect(task.turnEnds).toEqual(['completed', 'completed']);
    expect(task.session.turnState()).toBe('idle');
    expect(task.session.queued()).toEqual([]);
  });

  it('ignores a delivery or a drop of a message it never had', async () => {
    const task = await steering();
    task.adapter.deliver('msg-404');
    task.adapter.drop('msg-404');
    task.adapter.endTurn();
    await flushMicrotasks();
    expect(task.events.filter((e) => e.type.startsWith('message_'))).toEqual([]);
    expect(task.adapter.sent).toEqual(['Do the task']);
  });
});

describe('the races mid-turn delivery has to survive', () => {
  it('a turn ending while a steer is in flight: the message waits for the answer, then opens the next turn, and nothing overtakes it', async () => {
    const task = await steering((adapter) => { adapter.answers = ['hold']; });
    const first = task.session.sendMessage('one');
    task.session.sendMessage('two');

    task.adapter.endTurn();
    await flushMicrotasks();
    expect(task.statesAtTurnEnd).toEqual(['working']);
    expect(task.adapter.sent).toEqual(['Do the task']);

    task.adapter.answer(first, false);
    await flushMicrotasks();
    expect(task.adapter.sent).toEqual(['Do the task', 'one\ntwo']);
    expect(task.adapter.steers.map((s) => s.text)).toEqual(['one']);
  });

  it('a message delivered before its steer was answered is not offered or sent again', async () => {
    const task = await steering((adapter) => { adapter.answers = ['hold']; });
    const id = task.session.sendMessage('one');

    task.adapter.deliver(id);
    task.adapter.answer(id, true);
    await flushMicrotasks();
    task.adapter.endTurn();
    await flushMicrotasks();

    expect(of(task.events, 'message_delivered', 'message_handed_over')).toEqual([{ type: 'message_delivered', messageId: id, text: 'one' }]);
    expect(task.adapter.sent).toEqual(['Do the task']);
    expect(task.session.turnState()).toBe('idle');
  });

  it('a message dropped before its steer was answered goes back to the queue, not to the runner', async () => {
    const task = await steering((adapter) => { adapter.answers = ['hold']; });
    const id = task.session.sendMessage('one');

    task.adapter.drop(id);
    task.adapter.answer(id, true);
    task.adapter.endTurn();
    await flushMicrotasks();

    expect(of(task.events, 'message_handed_over')).toEqual([]);
    expect(task.adapter.sent).toEqual(['Do the task', 'one']);
  });

  it('nothing is offered while an interrupt is in flight; the queue follows the interrupted turn', async () => {
    const task = await steering((adapter) => { adapter.interruptAnswer = 'hold'; });
    const interrupted = task.session.interrupt();
    const first = task.session.sendMessage('one');
    task.session.sendMessage('two');
    expect(task.adapter.steers).toEqual([]);

    task.adapter.finishInterrupt();
    await interrupted;
    await flushMicrotasks();

    expect(task.turnEnds).toEqual(['interrupted']);
    expect(task.adapter.sent).toEqual(['Do the task', 'one\ntwo']);
    expect(of(task.events, 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'one\ntwo', messageId: first });
    expect(task.adapter.steers).toEqual([]);
  });

  it('a runner killed and resumed after an ignored interrupt is sent what the killed one was handed', async () => {
    const task = await steering((adapter) => { adapter.interruptAnswer = 'ignore'; });
    const id = task.session.sendMessage('use Postgres');
    await flushMicrotasks();
    expect(task.session.queued()).toEqual([{ id, text: 'use Postgres', handedOver: true }]);

    await task.session.interrupt();
    await flushMicrotasks();

    expect(task.adapters).toHaveLength(2);
    expect(task.adapters[1].sent).toEqual(['use Postgres']);
    expect(of(task.events, 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'use Postgres', messageId: id });
  });

  it.each(['on offer', 'handed over'] as const)('the process exiting with a message %s reports it undelivered, and a late answer changes nothing', async (stage) => {
    const task = await steering((adapter) => { adapter.answers = [stage === 'on offer' ? 'hold' : 'accept']; });
    const id = task.session.sendMessage('use Postgres');
    await flushMicrotasks();

    task.adapter.exit(1);
    task.adapter.answer(id, true);
    task.adapter.deliver(id);
    await flushMicrotasks();

    expect(task.events).toContainEqual({ type: 'message_undelivered', messageId: id, text: 'use Postgres' });
    expect(of(task.events, 'message_delivered')).toEqual([]);
    expect(of(task.events, 'message_handed_over')).toHaveLength(stage === 'on offer' ? 0 : 1);
    expect(task.session.queued()).toEqual([]);
  });

  it('a failed turn reports a message the runner was handed undelivered, as it does a queued one', async () => {
    const task = await steering();
    const id = task.session.sendMessage('use Postgres');
    await flushMicrotasks();

    task.adapter.emit({ type: 'error', message: 'API Error: 529 overloaded' });
    task.adapter.settle();
    await flushMicrotasks();

    expect(task.turnEnds).toEqual(['failed']);
    expect(task.events).toContainEqual({ type: 'message_undelivered', messageId: id, text: 'use Postgres' });
    expect(task.session.turnState()).toBe('idle');
  });
});

describe('a runner with no mid-turn delivery', () => {
  it('keeps the turn-end queue: removable until the turn ends, then the next turn', async () => {
    const { runner, adapters } = runnerOf(() => new TurnEndAdapter());
    const task = observe(await runner.spawn(options({ runner: 'claude-code' })));
    await vi.waitFor(() => expect(adapters[0].sent).toEqual(['Do the task']));

    const kept = task.session.sendMessage('one');
    const taken = task.session.sendMessage('two');
    expect(task.session.queued()).toEqual([{ id: kept, text: 'one' }, { id: taken, text: 'two' }]);
    expect(task.session.removeQueued(taken)).toBe(true);

    adapters[0].endTurn();
    await flushMicrotasks();
    expect(adapters[0].sent).toEqual(['Do the task', 'one']);
    expect(of(task.events, 'message_handed_over', 'message_delivered')).toEqual([]);
  });
});

describe('a turn\'s end sends what the person queued as one turn (ADR-0023, F1)', () => {
  it('glues every queued message, in order, into the next turn, under the oldest one\'s id', async () => {
    const task = await turnEnd();
    const a = task.session.sendMessage('a');
    const b = task.session.sendMessage('b');
    const c = task.session.sendMessage('c');

    task.adapter.endTurn();
    await flushMicrotasks();

    expect(task.adapter.sent).toEqual(['Do the task', 'a\nb\nc']);
    expect(of(task.events, 'message_removed')).toEqual([{ type: 'message_removed', messageId: b }, { type: 'message_removed', messageId: c }]);
    expect(of(task.events, 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'a\nb\nc', messageId: a });
    expect(task.session.queued()).toEqual([]);
    expect(task.statesAtTurnEnd).toEqual(['working']);
  });

  it('sends a command and Ordewell\'s own message each as a turn of its own, gluing only the runs between them', async () => {
    const task = await turnEnd();
    const a = task.session.sendMessage('a');
    const b = task.session.sendMessage('b');
    const supervisor = task.session.sendMessage('from the supervisor', 'ordewell');
    const c = task.session.sendMessage('c');
    const command = task.session.invokeCommand('compact');
    const d = task.session.sendMessage('d');
    const e = task.session.sendMessage('e');

    for (let turn = 0; turn < 5; turn += 1) {
      task.adapter.endTurn();
      await flushMicrotasks();
    }

    expect(task.adapter.sent).toEqual(['Do the task', 'a\nb', 'from the supervisor', 'c', '/compact', 'd\ne']);
    expect(of(task.events, 'turn_start').slice(1).map((event) => event.type === 'turn_start' && event.messageId)).toEqual([a, supervisor, c, command, d]);
    expect(of(task.events, 'message_removed')).toEqual([{ type: 'message_removed', messageId: b }, { type: 'message_removed', messageId: e }]);
  });
});

describe('a checkpoint answer typed at the task (ADR-0023)', () => {
  it('reaches the running turn mid-turn, and opens a turn of its own between turns', async () => {
    const task = await steering();

    task.session.write('ORDEWELL_CONTINUE');
    expect(task.adapter.steers.map((s) => s.text)).toEqual(['ORDEWELL_CONTINUE']);
    expect(task.adapter.sent).toEqual(['Do the task']);
    await flushMicrotasks();
    task.adapter.deliver(task.adapter.steers[0].id);
    task.adapter.endTurn();
    await flushMicrotasks();
    expect(task.session.turnState()).toBe('idle');

    task.session.write('ORDEWELL_REJECT: keep the table');
    expect(task.adapter.sent).toEqual(['Do the task', 'ORDEWELL_REJECT: keep the table']);
    expect(task.adapter.steers).toHaveLength(1);
  });
});

describe('the attempt\'s verdict when a message is read mid-turn', () => {
  function scheduled() {
    const session = new FakeRunnerSession();
    const runner = {
      spawn: async () => session,
      stop: async () => session.kill(),
      stopAll: () => session.kill(),
      activeCount: 1,
    } satisfies IRunner;
    const orchestrator = TaskOrchestrator.compose({
      config: fakeConfig(), notifications: fakeNotification(), runner,
      output: new BufferedTaskOutputSource(),
      registry: new RunnerRegistry(), workspaceRoot: () => '/repo',
      workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Steered task', prompt: 'Do it' })]);
    return { orchestrator, session };
  }

  it('holds a report made before the runner read the message, and settles on the one after', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    const id = orchestrator.sendTaskMessage('t1', 'Also add tests');
    session.reportComplete({ status: 'done', summary: 'Original work' });
    await flushMicrotasks(50);
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('in_progress');

    session.deliverMidTurn(id);
    session.reportComplete({ status: 'done', summary: 'Work with tests' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')?.status).toBe('completed'));
    expect(orchestrator.storeInstance.get('t1')?.handoff?.summary).toBe('Work with tests');
    expect(session.delivered).toEqual([]);
  });

  it('asks for fresh evidence when the turn ends after the message with no new report', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    const id = orchestrator.sendTaskMessage('t1', 'Please check again');
    session.reportComplete({ status: 'done', summary: 'Finished' });
    session.deliverMidTurn(id);
    session.waitForInput();
    await flushMicrotasks(50);
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('awaiting_user');
    expect(orchestrator.storeInstance.get('t1')?.verdict).toBeUndefined();
    orchestrator.stop();
  });

  it('counts only the completion call after the message is delivered', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    const id = orchestrator.sendTaskMessage('t1', 'Also add tests');
    session.reportComplete({ status: 'done', summary: 'Original work' });
    await flushMicrotasks(50);
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('in_progress');

    session.deliverMidTurn(id);
    session.reportComplete({ status: 'done', summary: 'Work with tests' });
    await vi.waitFor(() => expect(orchestrator.storeInstance.get('t1')?.status).toBe('completed'));
    expect(orchestrator.storeInstance.get('t1')?.handoff?.summary).toBe('Work with tests');
  });
});

/**
 * Force send (ADR-0023, F1–F3): the running turn is interrupted and the
 * forced message opens the one that replaces it, ahead of what is still
 * queued, with no stop at "waiting for input" in between.
 */
describe('force send', () => {
  it('logs late subagent activity without opening a turn that traps the next message', async () => {
    const task = await steering();
    task.adapter.endTurn(true);
    await flushMicrotasks();
    task.adapter.emitOutOfTurn(
      { type: 'thinking', text: 'Still working', subagentId: 'child' },
      { type: 'tool_call', id: 'child-call', name: 'Read', args: {}, subagentId: 'child' },
    );
    expect(task.session.turnState()).toBe('idle');
    expect(of(task.events, 'turn_start')).toHaveLength(1);
    expect(of(task.events, 'thinking', 'tool_call')).toHaveLength(2);
    task.session.sendMessage('Next');
    expect(task.adapter.sent).toEqual(['Do the task', 'Next']);
  });

  it('waits for a message Claude Code still holds before sending a different forced message', async () => {
    const task = await steering();
    const first = task.session.sendMessage('A');
    await flushMicrotasks();
    const forced = task.session.forceSend('B');
    await flushMicrotasks();

    expect(task.adapter.sent).toEqual(['Do the task']);
    expect(task.session.turnState()).toBe('working');
    task.adapter.emitOutOfTurn({ type: 'message_delivered', id: first });
    task.adapter.emitOutOfTurn({ type: 'assistant_text', runId: 'a', text: 'Reply to A' }, { type: 'turn_end' });
    await flushMicrotasks();
    task.adapter.emitOutOfTurn({ type: 'message_delivered', id: forced });
    await flushMicrotasks();
    expect(of(task.events, 'turn_start')).toEqual([
      { type: 'turn_start', text: 'Do the task' },
      { type: 'turn_start', text: 'A', messageId: first },
      { type: 'turn_start', text: 'B', messageId: forced, forced: true },
    ]);
  });

  it('interrupts the turn and opens the next one with the forced message, ahead of the queue, never idle in between', async () => {
    const task = await turnEnd();
    const supervisor = task.session.sendMessage('from the supervisor', 'ordewell');
    task.adapter.emit({ type: 'tool_call', id: 'c1', name: 'Bash', args: { command: 'sleep 60' } });

    const now = task.session.forceSend('stop, use Postgres');
    expect(task.session.queued()).toEqual([
      { id: now, text: 'stop, use Postgres', forced: true },
      { id: supervisor, text: 'from the supervisor', from: 'ordewell' },
    ]);
    await flushMicrotasks();

    expect(task.turnEnds).toEqual(['interrupted']);
    expect(task.statesAtTurnEnd).toEqual(['working']);
    expect(task.adapter.sent).toEqual(['Do the task', 'stop, use Postgres']);
    expect(of(task.events, 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'stop, use Postgres', messageId: now, forced: true });
    expect(of(task.events, 'message_queued').at(-1)).toEqual({ type: 'message_queued', messageId: now, text: 'stop, use Postgres', forced: true });
    expect(of(task.events, 'message_removed')).toEqual([]);
    expect(task.session.queued()).toEqual([{ id: supervisor, text: 'from the supervisor', from: 'ordewell' }]);

    task.adapter.endTurn();
    await flushMicrotasks();
    expect(task.adapter.sent).toEqual(['Do the task', 'stop, use Postgres', 'from the supervisor']);
  });

  it('promotes a queued message by id, the ones queued before it glued in ahead; one gone is refused', async () => {
    const task = await turnEnd();
    const one = task.session.sendMessage('one');
    const two = task.session.sendMessage('two');
    expect(task.session.forceSendQueued('msg-404')).toBe(false);

    expect(task.session.forceSendQueued(two)).toBe(true);
    await flushMicrotasks();

    expect(task.adapter.sent).toEqual(['Do the task', 'one\ntwo']);
    expect(of(task.events, 'message_removed')).toEqual([{ type: 'message_removed', messageId: one }]);
    expect(of(task.events, 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'one\ntwo', messageId: two, forced: true });
    expect(task.session.queued()).toEqual([]);
    expect(task.statesAtTurnEnd).toEqual(['working']);
  });

  it('leaves what the runner was handed to the runner, and re-sends one it drops after the forced message', async () => {
    const task = await steering((adapter) => { adapter.interruptAnswer = 'hold'; });
    const kept = task.session.sendMessage('kept');
    const dropped = task.session.sendMessage('dropped');
    await flushMicrotasks();
    expect(task.session.queued().every((m) => m.handedOver)).toBe(true);

    const now = task.session.forceSend('now');
    task.adapter.deliver(kept);
    task.adapter.drop(dropped);
    task.adapter.finishInterrupt();
    await flushMicrotasks();

    expect(task.adapter.sent).toEqual(['Do the task', 'now']);
    expect(of(task.events, 'turn_start').at(-1)).toMatchObject({ messageId: now, forced: true });
    // Codex re-sends only the unread message after the forced one.
    expect(task.adapter.steers.map((s) => s.text)).toEqual(['kept', 'dropped', 'dropped']);
    expect(task.session.queued().map((m) => m.id)).toEqual([dropped]);
  });

  it('is never steered into the turn it interrupts', async () => {
    const task = await steering((adapter) => { adapter.interruptAnswer = 'hold'; });
    task.session.forceSend('now');
    await flushMicrotasks();
    expect(task.adapter.steers).toEqual([]);
    task.adapter.finishInterrupt();
    await flushMicrotasks();
    expect(task.adapter.sent).toEqual(['Do the task', 'now']);
    expect(task.adapter.steers).toEqual([]);
  });

  it('kills and resumes the runner when the soft interrupt is ignored, and the resumed one gets the forced message first', async () => {
    const task = await turnEnd();
    task.adapter.interruptAnswer = 'ignore';
    const queued = task.session.sendMessage('queued');
    const now = task.session.forceSend('now');
    await vi.waitFor(() => expect(task.adapters).toHaveLength(2));
    await flushMicrotasks();

    expect(task.turnEnds).toEqual(['interrupted']);
    expect(task.statesAtTurnEnd).toEqual(['working']);
    expect(task.adapters[1].sent).toEqual(['queued\nnow']);
    expect(of(task.events, 'turn_start').at(-1)).toMatchObject({ messageId: now, forced: true });
    expect(of(task.events, 'message_removed')).toEqual([{ type: 'message_removed', messageId: queued }]);
    expect(task.session.queued()).toEqual([]);
  });

  it('is a plain send when no turn runs', async () => {
    const task = await turnEnd();
    task.adapter.endTurn();
    await flushMicrotasks();
    expect(task.session.turnState()).toBe('idle');

    task.session.forceSend('next');
    await flushMicrotasks();
    expect(task.adapter.sent).toEqual(['Do the task', 'next']);
    expect(task.turnEnds).toEqual(['completed']);
    expect(of(task.events, 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'next' });
  });

  it('reports a forced message undelivered when the runner is gone', async () => {
    const task = await turnEnd();
    task.adapter.interruptAnswer = 'hold';
    const now = task.session.forceSend('now');
    task.adapter.exit(1);
    await flushMicrotasks();
    expect(task.events).toContainEqual({ type: 'message_undelivered', messageId: now, text: 'now' });
  });
});

describe('force send glues what the person queued into one message (ADR-0023, F1)', () => {
  it('sends every queued message, in order, ahead of the forced text as one forced message, and takes each off the queue', async () => {
    const task = await turnEnd();
    const a = task.session.sendMessage('a');
    const b = task.session.sendMessage('b');
    const c = task.session.sendMessage('c');

    const now = task.session.forceSend('x');
    expect(task.session.queued()).toEqual([{ id: now, text: 'a\nb\nc\nx', forced: true }]);
    expect(of(task.events, 'message_removed', 'message_queued').slice(3)).toEqual([
      { type: 'message_removed', messageId: a },
      { type: 'message_removed', messageId: b },
      { type: 'message_removed', messageId: c },
      { type: 'message_queued', messageId: now, text: 'a\nb\nc\nx', forced: true },
    ]);
    await flushMicrotasks();

    expect(task.adapter.sent).toEqual(['Do the task', 'a\nb\nc\nx']);
    expect(of(task.events, 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'a\nb\nc\nx', messageId: now, forced: true });
    expect(task.session.queued()).toEqual([]);
  });

  it('sends every queued message, in order, as the one forced message when one of them is force sent', async () => {
    const task = await turnEnd();
    const a = task.session.sendMessage('a');
    const b = task.session.sendMessage('b');
    const c = task.session.sendMessage('c');

    expect(task.session.forceSendQueued(a)).toBe(true);
    expect(task.session.queued()).toEqual([{ id: a, text: 'a\nb\nc', forced: true }]);
    expect(of(task.events, 'message_removed', 'message_queued').slice(3)).toEqual([
      { type: 'message_removed', messageId: b },
      { type: 'message_removed', messageId: c },
      { type: 'message_queued', messageId: a, text: 'a\nb\nc', forced: true },
    ]);
    await flushMicrotasks();

    expect(task.turnEnds).toEqual(['interrupted']);
    expect(task.statesAtTurnEnd).toEqual(['working']);
    expect(task.adapter.sent).toEqual(['Do the task', 'a\nb\nc']);
    expect(of(task.events, 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'a\nb\nc', messageId: a, forced: true });
  });

  it('never takes in what the runner has, a forced message, a command, or Ordewell\'s own', async () => {
    const task = await steering((adapter) => { adapter.interruptAnswer = 'hold'; adapter.answers = ['accept', 'hold']; });
    const handed = task.session.sendMessage('handed');
    const offered = task.session.sendMessage('offered');
    await flushMicrotasks();
    const supervisor = task.session.sendMessage('from the supervisor', 'ordewell');
    const command = task.session.invokeCommand('compact');
    const first = task.session.forceSend('first');
    const mine = task.session.sendMessage('mine');

    const now = task.session.forceSend('now');
    expect(of(task.events, 'message_removed')).toEqual([{ type: 'message_removed', messageId: mine }]);
    expect(task.session.queued()).toEqual([
      { id: first, text: 'first', forced: true },
      { id: now, text: 'mine\nnow', forced: true },
      { id: handed, text: 'handed', handedOver: true },
      { id: offered, text: 'offered', handedOver: true },
      { id: supervisor, text: 'from the supervisor', from: 'ordewell' },
      { id: command, text: '/compact' },
    ]);
  });
});

describe('force send of a message the runner already has (ADR-0023, F1)', () => {
  it('on a runner that keeps it across the interrupt (Claude Code): interrupts, sends nothing twice, and the turn the runner opens for it is the forced one', async () => {
    const task = await steering((adapter) => { adapter.answers = ['accept', 'refuse']; });
    const handed = task.session.sendMessage('use Postgres');
    const waiting = task.session.sendMessage('then add tests');
    await flushMicrotasks();
    expect(task.session.queued()).toEqual([{ id: handed, text: 'use Postgres', handedOver: true }, { id: waiting, text: 'then add tests' }]);

    expect(task.session.forceSendQueued(handed)).toBe(true);
    expect(task.session.queued()).toEqual([{ id: handed, text: 'use Postgres', handedOver: true, forced: true }, { id: waiting, text: 'then add tests' }]);
    expect(of(task.events, 'message_removed')).toEqual([]);
    await flushMicrotasks();

    expect(task.turnEnds).toEqual(['interrupted']);
    expect(task.statesAtTurnEnd).toEqual(['working']);
    // The runner still has it: neither it nor the one queued behind it overtakes that.
    expect(task.adapter.sent).toEqual(['Do the task']);
    expect(task.adapter.steers.map((s) => s.text)).toEqual(['use Postgres', 'then add tests']);

    task.adapter.emitOutOfTurn({ type: 'message_delivered', id: handed });
    await flushMicrotasks();
    expect(of(task.events, 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'use Postgres', messageId: handed, forced: true });
    expect(task.adapter.steers.map((s) => s.text)).toEqual(['use Postgres', 'then add tests', 'then add tests']);
  });

  it('on a runner that lets go of it at the interrupt (Codex, OpenCode 1.x): sends it once more, as the next turn', async () => {
    const task = await steering((adapter) => { adapter.interruptAnswer = 'hold'; });
    const handed = task.session.sendMessage('use Postgres');
    await flushMicrotasks();

    expect(task.session.forceSendQueued(handed)).toBe(true);
    task.adapter.drop(handed);
    task.adapter.finishInterrupt();
    await flushMicrotasks();

    expect(task.turnEnds).toEqual(['interrupted']);
    expect(task.statesAtTurnEnd).toEqual(['working']);
    expect(task.adapter.sent).toEqual(['Do the task', 'use Postgres']);
    expect(of(task.events, 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'use Postgres', messageId: handed, forced: true });
    expect(task.session.queued()).toEqual([]);
  });

  it('goes first, and every other message keeps the order it was sent in, handed over or queued', async () => {
    const task = await steering((adapter) => { adapter.interruptAnswer = 'hold'; adapter.answers = ['accept', 'accept', 'refuse']; });
    const one = task.session.sendMessage('one');
    const two = task.session.sendMessage('two');
    const three = task.session.sendMessage('three');
    const four = task.session.sendMessage('four');
    await flushMicrotasks();
    expect(task.session.queued().map((m) => [m.id, Boolean(m.handedOver)])).toEqual([[one, true], [two, true], [three, false], [four, false]]);

    expect(task.session.forceSendQueued(two)).toBe(true);
    expect(task.session.queued().map((m) => m.id)).toEqual([two, one, three, four]);
    task.adapter.drop(one);
    task.adapter.drop(two);
    task.adapter.finishInterrupt();
    await flushMicrotasks();

    expect(task.adapter.sent).toEqual(['Do the task', 'two']);
    expect(task.adapter.steers.slice(3).map((s) => s.text)).toEqual(['one', 'three', 'four']);
    expect(task.session.queued().map((m) => m.id)).toEqual([one, three, four]);
  });

  it('changes nothing when force sent again: one interrupt, one event, and its place kept', async () => {
    const task = await steering((adapter) => { adapter.interruptAnswer = 'hold'; });
    const handed = task.session.sendMessage('handed');
    await flushMicrotasks();
    const interrupt = vi.spyOn(task.adapter, 'interrupt');

    expect(task.session.forceSendQueued(handed)).toBe(true);
    const now = task.session.forceSend('now');
    expect(task.session.forceSendQueued(handed)).toBe(true);
    expect(task.session.forceSendQueued(now)).toBe(true);

    expect(task.session.queued().map((m) => m.id)).toEqual([handed, now]);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(task.events.filter((e) => e.type === 'message_queued' && e.forced).map((e) => e.type === 'message_queued' && e.messageId)).toEqual([handed, now]);
  });

  it('has nothing left to send once the runner reports it delivered, even with the interrupt on its way', async () => {
    const task = await steering((adapter) => { adapter.interruptAnswer = 'hold'; });
    const handed = task.session.sendMessage('use Postgres');
    await flushMicrotasks();

    expect(task.session.forceSendQueued(handed)).toBe(true);
    task.adapter.deliver(handed);
    expect(task.session.forceSendQueued(handed)).toBe(false);
    task.adapter.finishInterrupt();
    await flushMicrotasks();

    expect(of(task.events, 'message_delivered')).toEqual([{ type: 'message_delivered', messageId: handed, text: 'use Postgres' }]);
    expect(of(task.events, 'message_undelivered')).toEqual([]);
    expect(task.adapter.sent).toEqual(['Do the task']);
    // The model has it, and nothing is owed: the interrupt ends the turn as a plain one does.
    expect(task.turnEnds).toEqual(['interrupted']);
    expect(task.statesAtTurnEnd).toEqual(['idle']);
  });

  it('opens the next turn with one still being offered that the runner then refuses', async () => {
    const task = await steering((adapter) => { adapter.interruptAnswer = 'hold'; adapter.answers = ['hold']; });
    const offered = task.session.sendMessage('use Postgres');
    await flushMicrotasks();
    expect(task.session.queued()).toEqual([{ id: offered, text: 'use Postgres', handedOver: true }]);

    expect(task.session.forceSendQueued(offered)).toBe(true);
    task.adapter.finishInterrupt();
    await flushMicrotasks();
    expect(task.adapter.sent).toEqual(['Do the task']);

    task.adapter.answer(offered, false);
    await flushMicrotasks();
    expect(task.adapter.sent).toEqual(['Do the task', 'use Postgres']);
    expect(of(task.events, 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'use Postgres', messageId: offered, forced: true });
  });
});

describe('force send through the orchestrator', () => {
  function orchestratorFor(session: IRunnerSession) {
    const runner = {
      spawn: async () => session,
      stop: async () => session.kill(),
      stopAll: () => session.kill(),
      activeCount: 1,
    } satisfies IRunner;
    const orchestrator = TaskOrchestrator.compose({
      config: fakeConfig(), notifications: fakeNotification(), runner,
      output: new BufferedTaskOutputSource(),
      registry: new RunnerRegistry(), workspaceRoot: () => '/repo',
      workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Forced task', prompt: 'Do it' })]);
    return orchestrator;
  }

  function scheduled() {
    const session = new FakeRunnerSession();
    return { orchestrator: orchestratorFor(session), session };
  }

  it('keeps the task in progress through the interrupt, and delivers the forced message first, what was queued glued ahead of it', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    const statuses: string[] = [];
    orchestrator.subscribe({ onTaskChanged: () => { statuses.push(orchestrator.storeInstance.get('t1')?.status ?? ''); } });
    orchestrator.sendTaskMessage('t1', 'later');

    orchestrator.forceSendTaskMessage('t1', 'now');
    await flushMicrotasks(50);

    expect(session.interrupts).toBe(1);
    expect(session.delivered).toEqual(['later\nnow']);
    expect(statuses.every((s) => s === 'in_progress')).toBe(true);
    expect(orchestrator.getQueuedTaskMessages('t1')).toEqual([]);
  });

  it('promotes a queued message with the ones queued before it, and refuses one it does not hold', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    orchestrator.sendTaskMessage('t1', 'first');
    const second = orchestrator.sendTaskMessage('t1', 'second');

    expect(orchestrator.forceSendQueuedTaskMessage('t1', 'msg-404')).toBe(false);
    expect(orchestrator.forceSendQueuedTaskMessage('t1', second)).toBe(true);
    await flushMicrotasks(50);
    expect(session.delivered).toEqual(['first\nsecond']);
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('in_progress');
  });

  it('just delivers to a task waiting for input, which is back in progress', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    session.waitForInput();
    await flushMicrotasks(50);
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('awaiting_user');

    orchestrator.forceSendTaskMessage('t1', 'carry on');
    expect(session.interrupts).toBe(0);
    expect(session.delivered.at(-1)).toBe('carry on');
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('in_progress');
    orchestrator.stop();
  });

  it('refuses a task that is not running, saying there is no turn', async () => {
    const orchestrator = orchestratorFor(new FakeRunnerSession());
    expect(() => orchestrator.forceSendTaskMessage('t1', 'now')).toThrow(/is not running, so there is no turn to send a message to/);
    expect(() => orchestrator.forceSendQueuedTaskMessage('t1', 'msg-1')).toThrow(/is not running/);
  });
});
