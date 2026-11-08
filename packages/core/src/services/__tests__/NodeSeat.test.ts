import { describe, expect, it, vi } from 'vitest';
import { createTask, type LegacyPlanState, type PendingPlanTurn, type Task } from '../../models/Task';
import type { ExecutionActor, SupervisorLevel } from '../../models/Execution';
import { flushMicrotasks } from '../../testing';
import { CHILD_ENDED, type SeatedChild } from '../ChildDirectory';
import type { SubplannerLink } from '../ChildPlanRunner';
import type { CommandOutcome, ExecutionCommand } from '../ExecutionCommands';
import { rootMandate, type Mandate } from '../Mandate';
import { ChildSeat, PERSON_SPOKE, RootSeat, type ChildSeatHost } from '../NodeSeat';
import { PlannerTurnDiscardedError, PlannerTurnStoppedError } from '../PlannerConversation';
import type { PlanTurnInput } from '../PlanTurns';
import { EMPTY_RUN } from '../runView';

/**
 * A node's seat with its Session faked as the narrow host it reads: its plan,
 * its turns, the seam a person's control runs through, and the directory a
 * surface finds it in.
 */

const mandate: Mandate = rootMandate({ level: 'act', autorun: true, autonomous: true, delegationTokens: 0, runners: ['claude-code'], models: {} });
const task = (id: string, over: Partial<Task> = {}): Task => createTask({ id, order: 1, title: `Task ${id}`, prompt: `do ${id}`, ...over });
const delegated = task('d', { type: 'delegated', title: 'Delegated' });

function seated(over: Partial<ChildSeatHost> = {}) {
  const tasks: Task[] = [];
  const said: PlanTurnInput[] = [];
  const queued: PlanTurnInput[] = [];
  const notices: string[] = [];
  const held: PendingPlanTurn[] = [];
  const order: string[] = [];
  const executed: { command: ExecutionCommand; actor: ExecutionActor }[] = [];
  const turns = {
    turnRunning: false,
    enqueue: vi.fn((input: PlanTurnInput) => {
      queued.push(input);
      return Promise.resolve();
    }),
    heldWithoutCaller: () => held,
  };
  const state = {
    listening: true,
    refusal: null as string | null,
    turnRefusal: null as string | null,
    stoppedFor: null as string | null,
    plan: { tasks } as unknown as LegacyPlanState | null,
    level: 'act' as SupervisorLevel,
    checkpoint: undefined as string | undefined,
    outcome: { ok: true, message: 'Done.' } as CommandOutcome,
    follow: (input: PlanTurnInput): Promise<unknown> => {
      said.push(input);
      turns.turnRunning = true;
      return Promise.resolve();
    },
  };
  const spoken: Promise<unknown>[] = [];
  const link: SubplannerLink = {
    taskComplete: vi.fn(),
    checkpoint: vi.fn(),
    changed: vi.fn(),
    stopped: () => false,
    reported: () => false,
    usage: vi.fn(),
    listening: () => state.listening,
    spoken: vi.fn((turn: () => Promise<unknown>) => { spoken.push(turn()); }),
  };
  let seat: SeatedChild | undefined;
  const leave = vi.fn(() => { order.push('leave'); });
  const host: ChildSeatHost = {
    link,
    depth: 2,
    directory: { seat: (child) => { seat = child; return leave; } },
    pool: { heldSince: (since) => since + 1 },
    funds: {
      turnRefusal: () => state.turnRefusal,
      stoppedFor: () => state.stoppedFor,
      closeOwn: vi.fn(() => { order.push('closeOwn'); }),
    },
    sessionId: () => 'child-session',
    goal: () => 'the goal',
    plan: () => state.plan,
    tasks: () => tasks,
    snapshot: () => tasks.map((t) => ({ ...t })),
    run: () => EMPTY_RUN,
    plannerTurnId: () => 'turn-1',
    plannerCompaction: () => undefined,
    working: () => turns.turnRunning,
    opened: () => state.plan !== null,
    turns: () => turns,
    follow: (input) => state.follow(input),
    startPlanning: vi.fn(() => Promise.resolve('planned')),
    continueConversation: vi.fn(() => Promise.resolve('continued')),
    execute: vi.fn((command: ExecutionCommand, actor: ExecutionActor) => {
      executed.push({ command, actor });
      return Promise.resolve(state.outcome);
    }),
    actor: () => ({ kind: 'subplanner', depth: 2 }),
    awaitsCheckpoint: (taskId) => state.checkpoint !== undefined && taskId === 'a',
    checkpointQuestion: () => state.checkpoint,
    owesChildren: () => ['A child is owed this.'],
    nodeRefusal: () => state.refusal,
    withdrawn: () => null,
    refusedStart: () => null,
    runIsLive: () => false,
    unmerged: () => false,
    wakeOwed: () => false,
    supervisorLevel: () => state.level,
    takeReport: vi.fn(),
    notice: (_level, message) => { notices.push(message); },
    stopSubtree: vi.fn(() => Promise.resolve()),
    destroy: vi.fn(() => {
      order.push('destroy');
      return Promise.resolve();
    }),
    ...over,
  };
  const node = new ChildSeat(host).asNode(delegated, mandate, ['pinned line']);
  return { node, host, link, state, tasks, said, queued, notices, held, order, executed, turns, spoken, leave, seat: () => seat! };
}

describe('RootSeat', () => {
  it('has no parent, so nothing drives it as a child', () => {
    expect(() => new RootSeat().asNode()).toThrow(/root has no parent/);
  });
});

describe('ChildSeat', () => {
  it('seats the child where a surface finds it, under its delegated task', () => {
    const { node, seat, tasks, state } = seated();
    tasks.push(task('a'));
    state.checkpoint = 'Proceed?';
    expect(node.sessionId).toBe('child-session');
    expect(node.heldSince(10)).toBe(11);
    expect(seat()).toMatchObject({ sessionId: 'child-session', taskId: 'd', title: 'Delegated' });
    expect(seat().checkpoints()).toEqual(['a']);
    expect(seat().view()).toMatchObject({ goal: 'the goal', plannerTurnId: 'turn-1', run: EMPTY_RUN, plan: { tasks: [{ id: 'a' }] } });
  });

  it('shows no plan before one is saved', () => {
    const { seat, state } = seated();
    state.plan = null;
    expect(seat().view().plan).toBeNull();
  });

  it('closes after its Session has gone: it leaves its seat, then gives back what it did not spend', async () => {
    const { node, order } = seated();
    await node.close();
    expect(order).toEqual(['destroy', 'leave', 'closeOwn']);
  });

  it('tells its subplanner what it starts with, the pins after it', async () => {
    const { node, host } = seated();
    await node.startPlanning('build it');
    expect(host.startPlanning).toHaveBeenCalledWith('build it\n\npinned line');
    await node.continueConversation('more');
    expect(host.continueConversation).toHaveBeenCalledWith('more');
  });

  it('adds a line to the next turn without opening one', () => {
    const { node, queued } = seated();
    node.hear('a landing');
    expect(queued).toEqual([{ source: 'supervisor', text: 'a landing', rides: true }]);
  });

  describe('a person\'s message', () => {
    it('is a turn of its subplanner, marked as a person\'s, that wakes it when nothing ran', async () => {
      const { seat, said, spoken } = seated();
      expect(seat().hear('hello')).toEqual({ ok: true, status: 'woken' });
      await Promise.all(spoken);
      expect(said).toEqual([{ source: 'user', text: 'hello', aside: PERSON_SPOKE }]);
    });

    it('queues behind a turn already running', () => {
      const { seat, turns } = seated();
      turns.turnRunning = true;
      expect(seat().hear('hello')).toEqual({ ok: true, status: 'queued' });
    });

    it('is refused while it is controlled from above: a Stop or a withdrawn grant lets nothing start', async () => {
      const { seat, state, link, executed, tasks } = seated();
      tasks.push(task('a'));
      state.refusal = 'A Stop stands at or above this node, so nothing starts here.';
      expect(seat().refusal()).toEqual({ ok: false, code: 'refused', message: state.refusal });
      expect(seat().hear('hello')).toEqual({ ok: false, code: 'refused', message: state.refusal });
      expect(await seat().control('a', { kind: 'message', text: 'hi' })).toEqual({ ok: false, code: 'refused', message: state.refusal });
      expect(link.spoken).not.toHaveBeenCalled();
      expect(executed).toEqual([]);
    });

    it('is view-only once its attempt is over', async () => {
      const { seat, state } = seated();
      state.listening = false;
      expect(seat().hear('hello')).toBe(CHILD_ENDED);
      expect(await seat().control('a', { kind: 'message', text: 'hi' })).toBe(CHILD_ENDED);
    });

    it('is refused before its conversation has started', () => {
      const { seat, state } = seated();
      state.plan = null;
      expect(seat().hear('hello')).toMatchObject({ ok: false, code: 'refused', message: 'This child plan has not started its conversation yet.' });
    });

    it('is refused when its budget lets no turn start, though an answer to a checkpoint opens none', async () => {
      const { seat, state, tasks, executed } = seated();
      tasks.push(task('a'));
      state.turnRefusal = 'Out of turns.';
      state.checkpoint = 'Proceed?';
      expect(seat().hear('hello')).toMatchObject({ ok: false, message: 'Out of turns.' });
      expect(await seat().control('a', { kind: 'checkpoint', answer: 'approve', question: 'Proceed?' })).toEqual({ ok: true, message: 'Done.' });
      expect(executed).toEqual([{ command: { command: 'answer_checkpoint', task: 'a', answer: 'approve' }, actor: { kind: 'subplanner', depth: 2, person: true } }]);
    });

    it('tells the person when the subplanner stopped before answering it', async () => {
      const { seat, state, notices, spoken } = seated();
      state.follow = () => Promise.reject(new PlannerTurnStoppedError());
      seat().hear('hello');
      await Promise.all(spoken);
      expect(notices).toEqual(['This child plan stopped before its subplanner answered your message.']);
    });

    it('says why a message failed, and says nothing when the turn that read it ended with the report', async () => {
      const { seat, state, notices, spoken } = seated();
      state.follow = () => Promise.reject(new Error('the runner is gone'));
      seat().hear('hello');
      state.follow = () => Promise.reject(new PlannerTurnDiscardedError());
      seat().hear('again');
      state.follow = () => Promise.reject(new PlannerTurnDiscardedError({ unread: true }));
      seat().hear('once more');
      await Promise.all(spoken);
      expect(notices).toEqual([
        'Your message to this child plan went unanswered: the runner is gone',
        'This child plan stopped before its subplanner answered your message.',
      ]);
    });
  });

  describe('a person\'s control', () => {
    it('runs as the subplanner\'s own command, and its subplanner hears of it on its next turn', async () => {
      const { seat, state, tasks, executed, queued } = seated();
      tasks.push(task('a'));
      state.outcome = { ok: true, message: 'Sent.', payload: { kind: 'message', id: 'm1' } } as CommandOutcome;
      expect(await seat().control('a', { kind: 'message', text: 'look here' })).toEqual({ ok: true, message: 'Sent.', id: 'm1' });
      expect(executed).toEqual([{ command: { command: 'message_task', task: 'a', text: 'look here' }, actor: { kind: 'subplanner', depth: 2, person: true } }]);
      expect(queued).toEqual([{ source: 'supervisor', text: 'A person acted on your plan: Sent. They said: look here', rides: true }]);
    });

    it('refuses a task this plan does not hold', async () => {
      const { seat } = seated();
      expect(await seat().control('elsewhere', { kind: 'message', text: 'hi' })).toMatchObject({ ok: false, code: 'no_task' });
    });

    it('refuses an answer to a question no longer asked', async () => {
      const { seat, state, tasks } = seated();
      tasks.push(task('a'));
      state.checkpoint = 'Another question?';
      expect(await seat().control('a', { kind: 'checkpoint', answer: 'reject', question: 'Proceed?' })).toMatchObject({ ok: false, code: 'not_waiting' });
    });

    it('passes on what the seam refused', async () => {
      const { seat, state, tasks, queued } = seated();
      tasks.push(task('a'));
      state.outcome = { ok: false, outcome: 'refused', message: 'Not now.' };
      expect(await seat().control('a', { kind: 'message', text: 'hi' })).toEqual({ ok: false, code: 'refused', message: 'Not now.' });
      expect(queued).toEqual([]);
    });
  });

  describe('a Continue', () => {
    it('plans its goal when its plan never reached the disk', async () => {
      const { node, host } = seated();
      expect(await node.goOn('go on', 'the goal')).toBe('planned');
      expect(host.startPlanning).toHaveBeenCalledWith('the goal\n\npinned line');
    });

    it('goes straight to its subplanner when nothing is left to run', async () => {
      const { node, host, tasks } = seated();
      tasks.push(task('a', { status: 'completed' }), task('u', { type: 'user' }));
      expect(await node.goOn('go on', 'the goal')).toBe('continued');
      expect(host.execute).not.toHaveBeenCalled();
      expect(host.continueConversation).toHaveBeenCalledWith('go on\n\npinned line');
    });

    it('runs what is left first, and tells its subplanner what its children are owed', async () => {
      const { node, host, tasks, executed } = seated();
      tasks.push(task('a', { status: 'failed' }));
      await node.goOn('go on', 'the goal');
      expect(executed).toEqual([{ command: { command: 'run_plan' }, actor: { kind: 'subplanner', depth: 2 } }]);
      expect(host.continueConversation).toHaveBeenCalledWith('go on\n\nA child is owed this.\n\npinned line');
    });

    it('throws what refused its run', async () => {
      const { node, state, tasks } = seated();
      tasks.push(task('a', { status: 'failed' }));
      state.outcome = { ok: false, outcome: 'refused', message: 'No run.' };
      await expect(node.goOn('go on', 'the goal')).rejects.toThrow('No run.');
    });
  });

  describe('its state', () => {
    it('names what is unfinished', () => {
      const { node, tasks } = seated({ runIsLive: () => true, unmerged: () => true, wakeOwed: () => true });
      tasks.push(task('a', { status: 'completed' }), task('b', { order: 2, status: 'in_progress' }));
      expect(node.state()).toEqual({
        unfinished: ['its run has not settled', '#2 "Task b" is in_progress', 'what landed is not merged into the delegated task\'s branch'],
        completed: 1,
        live: true,
        plannerBusy: false,
        wakeOwed: true,
        stoppedFor: null,
        withdrawn: null,
        startRefused: null,
        tasks: [{ label: '#1 "Task a"', status: 'completed' }, { label: '#2 "Task b"', status: 'in_progress' }],
      });
    });

    it('says an empty plan is unfinished', () => {
      expect(seated().node.state().unfinished).toEqual(['the child plan holds no tasks']);
    });

    it('stops blocked for its budget, failed for a restart that failed, and blocked for its loop guard', () => {
      const { node, state } = seated();
      state.stoppedFor = 'Out of budget.';
      expect(node.state().stoppedFor).toEqual({ why: 'Out of budget.', ends: 'blocked' });
      state.stoppedFor = null;
      state.plan = { tasks: [], runSettings: { unsupervised: 'no runner' } } as unknown as LegacyPlanState;
      expect(node.state().stoppedFor).toEqual({ why: 'its subplanner could not restart: no runner', ends: 'failed' });
      state.plan = { tasks: [], runSettings: {} } as unknown as LegacyPlanState;
      state.level = 'watch';
      expect(node.state().stoppedFor).toEqual({ why: 'its loop guard stopped its subplanner', ends: 'blocked' });
      state.level = 'act';
      expect(node.state().stoppedFor).toBeNull();
    });
  });

  describe('a halt', () => {
    it('tells the person once that their held message goes unanswered, then stops its subtree', async () => {
      const { node, host, held, notices } = seated();
      held.push({ id: 't', source: 'user', text: 'hello', timestamp: '', aside: PERSON_SPOKE } as PendingPlanTurn);
      await node.halt();
      await node.halt();
      await flushMicrotasks();
      expect(notices).toEqual(['This child plan stopped before its subplanner answered your message.']);
      expect(host.stopSubtree).toHaveBeenCalledTimes(2);
    });

    it('says nothing when no person\'s message was held', async () => {
      const { node, notices } = seated();
      await node.halt();
      expect(notices).toEqual([]);
    });
  });
});
