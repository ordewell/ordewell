import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { createTask } from '../../models/Task';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeStructuredSession, FakeTerminalSession, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { RunnerSpawnOptions } from '../AbstractRunner';
import type { AgentEvent, AgentStartOptions, TaskModeAgentAdapter } from '../harness/AgentAdapter';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import { isStructuredSession, type ITerminalRunner, type ITerminalSession, type StructuredEvent, type StructuredTurnEnd } from '../../interfaces/ITerminalRunner';

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

function observe(session: ITerminalSession) {
  if (!isStructuredSession(session)) throw new Error('not a structured session');
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
    task.adapter.emit({ type: 'assistant_text', text: 'Switching to Postgres.' });
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

  it('waits for the turn to end when refused, and every later one waits behind it in order', async () => {
    const task = await steering((adapter) => { adapter.answers = ['refuse']; });

    const first = task.session.sendMessage('one');
    await flushMicrotasks();
    const second = task.session.sendMessage('two');
    expect(task.adapter.steers.map((s) => s.text)).toEqual(['one']);
    expect(task.session.queued()).toEqual([{ id: first, text: 'one' }, { id: second, text: 'two' }]);

    task.adapter.endTurn();
    await flushMicrotasks();
    expect(task.adapter.sent).toEqual(['Do the task', 'one']);
    expect(task.statesAtTurnEnd).toEqual(['working']);
    // The new turn takes the next one mid-turn again.
    expect(task.adapter.steers.map((s) => s.text)).toEqual(['one', 'two']);
    expect(of(task.events, 'turn_start')).toEqual([
      { type: 'turn_start', text: 'Do the task' },
      { type: 'turn_start', text: 'one', messageId: first },
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

    task.adapter.emitOutOfTurn({ type: 'message_delivered', id }, { type: 'assistant_text', text: 'On it.' }, { type: 'turn_end' });
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
    expect(task.adapter.sent).toEqual(['Do the task', 'one']);
    expect(task.adapter.steers.map((s) => s.text)).toEqual(['one', 'two']);
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
    expect(task.adapter.sent).toEqual(['Do the task', 'one']);
    expect(of(task.events, 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'one', messageId: first });
    // Once the interrupt has settled, the next message goes into the new turn.
    expect(task.adapter.steers.map((s) => s.text)).toEqual(['two']);
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
    expect(orchestrator.storeInstance.get('t1')?.outputSummary?.logTail).toBe('Work with tests');
    expect(session.delivered).toEqual([]);
  });

  it('asks for fresh evidence when the turn ends after the message with no new report', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    const id = orchestrator.sendTaskMessage('t1', 'Please check again');
    session.reportComplete({ status: 'done', summary: 'Finished' });
    session.deliverMidTurn(id);
    session.emitTurnEnd('completed');
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
    expect(orchestrator.storeInstance.get('t1')?.outputSummary?.logTail).toBe('Work with tests');
  });
});

/**
 * Force send (ADR-0023, F1–F3): the running turn is interrupted and the
 * forced message opens the one that replaces it, ahead of what is still
 * queued, with no stop at "waiting for input" in between.
 */
describe('force send', () => {
  async function turnEnd() {
    const { runner, adapters } = runnerOf(() => new TurnEndAdapter());
    const task = observe(await runner.spawn(options({ runner: 'claude-code' })));
    await vi.waitFor(() => expect(adapters[0].sent).toEqual(['Do the task']));
    return { ...task, adapter: adapters[0], adapters };
  }

  it('interrupts the turn and opens the next one with the forced message, ahead of the queue, never idle in between', async () => {
    const task = await turnEnd();
    const one = task.session.sendMessage('one');
    const two = task.session.sendMessage('two');
    task.adapter.emit({ type: 'tool_call', id: 'c1', name: 'Bash', args: { command: 'sleep 60' } });

    const now = task.session.forceSend('stop, use Postgres');
    expect(task.session.queued()).toEqual([
      { id: now, text: 'stop, use Postgres', forced: true }, { id: one, text: 'one' }, { id: two, text: 'two' },
    ]);
    await flushMicrotasks();

    expect(task.turnEnds).toEqual(['interrupted']);
    expect(task.statesAtTurnEnd).toEqual(['working']);
    expect(task.adapter.sent).toEqual(['Do the task', 'stop, use Postgres']);
    expect(of(task.events, 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'stop, use Postgres', messageId: now, forced: true });
    expect(of(task.events, 'message_queued').at(-1)).toEqual({ type: 'message_queued', messageId: now, text: 'stop, use Postgres', forced: true });
    expect(task.session.queued()).toEqual([{ id: one, text: 'one' }, { id: two, text: 'two' }]);

    task.adapter.endTurn();
    await flushMicrotasks();
    expect(task.adapter.sent).toEqual(['Do the task', 'stop, use Postgres', 'one']);
  });

  it('promotes a queued message by id; one the runner already has, or one gone, is refused', async () => {
    const task = await turnEnd();
    const one = task.session.sendMessage('one');
    const two = task.session.sendMessage('two');
    expect(task.session.forceSendQueued('msg-404')).toBe(false);

    expect(task.session.forceSendQueued(two)).toBe(true);
    await flushMicrotasks();

    expect(task.adapter.sent).toEqual(['Do the task', 'two']);
    expect(of(task.events, 'turn_start').at(-1)).toEqual({ type: 'turn_start', text: 'two', messageId: two, forced: true });
    expect(task.session.queued()).toEqual([{ id: one, text: 'one' }]);
    expect(task.statesAtTurnEnd).toEqual(['working']);

    const steered = await steering();
    const handed = steered.session.sendMessage('handed');
    await flushMicrotasks();
    expect(steered.session.forceSendQueued(handed)).toBe(false);
    expect(steered.turnEnds).toEqual([]);
  });

  it('leaves what the runner was handed to the runner, and re-sends one it drops after the forced message', async () => {
    const task = await steering((adapter) => { adapter.interruptAnswer = 'hold'; });
    const kept = task.session.sendMessage('kept');
    const dropped = task.session.sendMessage('dropped');
    await flushMicrotasks();
    expect(task.session.queued().every((m) => m.handedOver)).toBe(true);

    const now = task.session.forceSend('now');
    task.adapter.drop(dropped);
    task.adapter.finishInterrupt();
    await flushMicrotasks();

    expect(task.adapter.sent).toEqual(['Do the task', 'now']);
    expect(of(task.events, 'turn_start').at(-1)).toMatchObject({ messageId: now, forced: true });
    // Codex discards what it had not consumed; the rest the runner still owes.
    expect(task.adapter.steers.map((s) => s.text)).toEqual(['kept', 'dropped', 'dropped']);
    expect(task.session.queued().map((m) => m.id)).toEqual([kept, dropped]);
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
    expect(task.adapters[1].sent).toEqual(['now']);
    expect(of(task.events, 'turn_start').at(-1)).toMatchObject({ messageId: now, forced: true });
    expect(task.session.queued()).toEqual([{ id: queued, text: 'queued' }]);
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

describe('force send through the orchestrator', () => {
  function orchestratorFor(session: ITerminalSession) {
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
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Forced task', prompt: 'Do it' })]);
    return orchestrator;
  }

  function scheduled() {
    const session = new FakeStructuredSession();
    return { orchestrator: orchestratorFor(session), session };
  }

  it('keeps the task in progress through the interrupt, and delivers the forced message first', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    const statuses: string[] = [];
    orchestrator.subscribe({ onTaskChanged: () => { statuses.push(orchestrator.storeInstance.get('t1')?.status ?? ''); } });
    orchestrator.sendTaskMessage('t1', 'later');

    orchestrator.forceSendTaskMessage('t1', 'now');
    await flushMicrotasks(50);

    expect(session.interrupts).toBe(1);
    expect(session.delivered).toEqual(['now']);
    expect(statuses.every((s) => s === 'in_progress')).toBe(true);
    expect(orchestrator.getQueuedTaskMessages('t1').map((m) => m.text)).toEqual(['later']);
  });

  it('promotes a queued message, and refuses one it does not hold', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    orchestrator.sendTaskMessage('t1', 'first');
    const second = orchestrator.sendTaskMessage('t1', 'second');

    expect(orchestrator.forceSendQueuedTaskMessage('t1', 'msg-404')).toBe(false);
    expect(orchestrator.forceSendQueuedTaskMessage('t1', second)).toBe(true);
    await flushMicrotasks(50);
    expect(session.delivered).toEqual(['second']);
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('in_progress');
  });

  it('just delivers to a task waiting for input, which is back in progress', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    session.emitTurnEnd('completed');
    await flushMicrotasks(50);
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('awaiting_user');

    orchestrator.forceSendTaskMessage('t1', 'carry on');
    expect(session.interrupts).toBe(0);
    expect(session.delivered).toEqual(['carry on']);
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('in_progress');
    orchestrator.stop();
  });

  it('refuses a session that is not structured, saying there is no turn', async () => {
    const orchestrator = orchestratorFor(new FakeTerminalSession());
    await orchestrator.forceStartTask('t1');
    expect(() => orchestrator.forceSendTaskMessage('t1', 'now')).toThrow(/is not running, so there is no turn to send a message to/);
    expect(() => orchestrator.forceSendQueuedTaskMessage('t1', 'msg-1')).toThrow(/is not running/);
  });
});
