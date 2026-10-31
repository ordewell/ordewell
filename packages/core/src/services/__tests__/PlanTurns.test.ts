import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LegacyPlanState } from '../../models/Task';
import { PlanTurns, turnPrompt, type PlanTurnsHost, type TurnPrompt } from '../PlanTurns';
import { ConversationBusyError, PlannerTurnDiscardedError, PlannerTurnStoppedError } from '../PlannerConversation';
import { flushMicrotasks } from '../../testing';

function plan(): LegacyPlanState {
  const now = '2026-10-11T00:00:00Z';
  return { tasks: [], generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

interface HeldTurn {
  prompt: TurnPrompt;
  signal?: AbortSignal;
  /** Land the turn: its commit runs `taken`, as the conversation's mutation does. */
  land(): void;
  fail(err: unknown): void;
}

/** A host whose turns the test ends by hand, recording the hold and every save. */
function fakeHost(current: { plan: LegacyPlanState | null } = { plan: plan() }) {
  const turns: HeldTurn[] = [];
  const saved: string[][] = [];
  let holds = 0;
  const host = {
    plan: () => current.plan,
    conversationBusy: vi.fn(() => false),
    mayWake: vi.fn(() => true),
    mayReport: vi.fn(() => true),
    persist: vi.fn(() => { saved.push((current.plan?.pendingTurns ?? []).map((t) => t.text)); }),
    announce: vi.fn(),
    interrupt: vi.fn(),
    holdStarts: vi.fn(() => {
      holds++;
      let held = true;
      return () => { if (held) { held = false; holds--; } };
    }),
    resumeStarts: vi.fn(async () => {}),
    run: vi.fn((prompt: TurnPrompt, { taken, signal }: { taken: () => void; signal?: AbortSignal }) => new Promise<LegacyPlanState>((resolve, reject) => {
      turns.push({
        prompt,
        signal,
        land: () => {
          taken();
          host.persist();
          resolve(current.plan!);
        },
        fail: reject,
      });
    })),
    notice: vi.fn(),
    plannerDetecting: vi.fn((): Promise<void> | null => null),
    assertPlannerReady: vi.fn(),
    plannerRunner: vi.fn((): string | null => 'claude-code'),
    stoppedByUser: vi.fn((_tasks: readonly string[] | undefined) => false),
  } satisfies PlanTurnsHost;
  return { host, turns, saved, current, held: () => holds };
}

afterEach(() => { vi.useRealTimers(); });

describe('PlanTurns', () => {
  it('starts a turn at once and holds new starts until it lands', async () => {
    const { host, turns, held } = fakeHost();
    const turnsRunner = new PlanTurns(host);

    const answered = turnsRunner.enqueue({ source: 'user', text: 'why did task 5 fail?' });

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt.text).toBe('why did task 5 fail?');
    expect(held()).toBe(1);
    turns[0].land();
    await answered;
    expect(held()).toBe(0);
    expect(host.resumeStarts).toHaveBeenCalledTimes(1);
  });

  it('releases the hold when the turn fails, and rejects its caller', async () => {
    const { host, turns, held } = fakeHost();
    const runner = new PlanTurns(host);

    const answered = runner.enqueue({ source: 'user', text: 'rename task 2' });
    turns[0].fail(new Error('planner down'));

    await expect(answered).rejects.toThrow('planner down');
    expect(held()).toBe(0);
    expect(host.resumeStarts).toHaveBeenCalled();
  });

  it('lets new starts go once the hold times out, while the turn itself goes on', async () => {
    vi.useFakeTimers();
    const { host, turns, held } = fakeHost();
    const runner = new PlanTurns(host, 1_000);

    const answered = runner.enqueue({ source: 'user', text: 'a long question' });
    expect(held()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(held()).toBe(0);
    expect(host.resumeStarts).toHaveBeenCalledTimes(1);
    expect(runner.busy).toBe(true);
    turns[0].land();
    await answered;
    expect(held()).toBe(0);
  });

  it('runs one turn at a time and takes what arrived meanwhile together, in order', async () => {
    const { host, turns } = fakeHost();
    const runner = new PlanTurns(host);

    const first = runner.enqueue({ source: 'user', text: 'one' });
    const second = runner.enqueue({ source: 'user', text: 'two' });
    const third = runner.enqueue({ source: 'supervisor', text: 'three' });
    expect(turns).toHaveLength(1);

    turns[0].land();
    await first;
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[1].prompt).toMatchObject({ source: 'user', text: 'two', wakeUps: ['three'] });
    turns[1].land();
    await expect(Promise.all([second, third])).resolves.toHaveLength(2);
  });

  it('saves an input as it arrives and drops it in the save that lands its turn', async () => {
    const { host, turns, saved } = fakeHost();
    const runner = new PlanTurns(host);

    const answered = runner.enqueue({ source: 'user', text: 'add a docs task' });
    expect(saved).toEqual([['add a docs task']]);
    turns[0].land();
    await answered;

    // One save after the arrival: the turn's own, without the input. Nothing
    // was saved between the change landing and the input leaving.
    expect(saved).toEqual([['add a docs task'], []]);
  });

  it('drops the inputs of a turn that ended without landing anything', async () => {
    const { host, turns, current } = fakeHost();
    const runner = new PlanTurns(host);

    const answered = runner.enqueue({ source: 'user', text: 'x' });
    turns[0].fail(new PlannerTurnStoppedError());
    await expect(answered).rejects.toBeInstanceOf(PlannerTurnStoppedError);

    expect(current.plan!.pendingTurns).toEqual([]);
    expect(host.persist).toHaveBeenCalledTimes(2);
  });

  it('replays what a saved plan still holds, once, and tells the user if it fails', async () => {
    const saved = plan();
    saved.pendingTurns = [{ id: 'turn-1', source: 'user', text: 'sent before the restart', timestamp: '2026-10-11T00:00:00Z' }];
    const { host, turns, current } = fakeHost({ plan: saved });
    const runner = new PlanTurns(host);

    runner.pump();
    runner.pump();

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt.text).toBe('sent before the restart');
    turns[0].fail(new Error('planner down'));
    await vi.waitFor(() => expect(host.notice).toHaveBeenCalledWith(expect.stringContaining('planner down')));
    expect(current.plan!.pendingTurns).toEqual([]);
    runner.pump();
    expect(turns).toHaveLength(1);
  });

  it('refuses an input while a turn of another kind holds the conversation', async () => {
    const { host, turns } = fakeHost();
    host.conversationBusy.mockReturnValue(true);
    const runner = new PlanTurns(host);

    await expect(runner.enqueue({ source: 'user', text: 'and CSV' })).rejects.toBeInstanceOf(ConversationBusyError);
    expect(turns).toHaveLength(0);
  });

  it('force sends past a turn of another kind: stops it, and answers the forced input first when it lets go', async () => {
    const { host, turns, saved } = fakeHost();
    host.conversationBusy.mockReturnValue(true);
    const runner = new PlanTurns(host);
    const wakeUp = runner.enqueue({ source: 'supervisor', text: 'task 1 failed' });

    const forced = runner.forceSend({ source: 'user', text: 'use Postgres' });

    expect(host.interrupt).toHaveBeenCalledTimes(1);
    expect(saved.at(-1)).toEqual(['use Postgres', 'task 1 failed']);
    host.conversationBusy.mockReturnValue(false);
    runner.pump();
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toMatchObject({ text: 'use Postgres', wakeUps: [], forced: true });
    turns[0].land();
    await forced;
    await flushMicrotasks();
    expect(turns[1].prompt).toMatchObject({ source: 'supervisor', wakeUps: ['task 1 failed'] });
    expect(turns[1].prompt.forced).toBeUndefined();
    turns[1].land();
    await wakeUp;
  });

  it('queues a second force send behind the first, both ahead of a plain input', async () => {
    const { host, turns, current } = fakeHost();
    const runner = new PlanTurns(host);
    const first = runner.enqueue({ source: 'user', text: 'one' });
    const plain = runner.enqueue({ source: 'user', text: 'two' });

    const forcedA = runner.forceSend({ source: 'user', text: 'now A' });
    const forcedB = runner.forceSend({ source: 'user', text: 'now B' });

    expect(host.interrupt).toHaveBeenCalledTimes(2);
    expect(current.plan!.pendingTurns!.map((t) => t.text)).toEqual(['one', 'now A', 'now B', 'two']);
    turns[0].fail(new PlannerTurnStoppedError());
    await expect(first).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    await flushMicrotasks();
    expect(turns.map((t) => t.prompt.text)).toEqual(['one', 'now A']);
    turns[1].land();
    await forcedA;
    await flushMicrotasks();
    turns[2].land();
    await forcedB;
    await flushMicrotasks();
    expect(turns.map((t) => t.prompt.text)).toEqual(['one', 'now A', 'now B', 'two']);
    turns[3].land();
    await plain;
  });

  it('is a plain send with no turn in flight', async () => {
    const { host, turns } = fakeHost();
    const runner = new PlanTurns(host);

    const sent = runner.forceSend({ source: 'user', text: 'and CSV' });

    expect(host.interrupt).not.toHaveBeenCalled();
    expect(turns[0].prompt.forced).toBeUndefined();
    turns[0].land();
    await sent;
  });

  it('waits for the conversation when another turn took it between two of its own', async () => {
    const { host, turns } = fakeHost();
    const runner = new PlanTurns(host);
    const first = runner.enqueue({ source: 'user', text: 'one' });
    const second = runner.enqueue({ source: 'user', text: 'two' });

    host.conversationBusy.mockReturnValue(true);
    turns[0].land();
    await first;
    await flushMicrotasks();
    expect(turns).toHaveLength(1);

    host.conversationBusy.mockReturnValue(false);
    runner.pump();
    expect(turns[1].prompt.text).toBe('two');
    turns[1].land();
    await second;
  });

  it('on a plan swap lets the hold go at once and discards every waiting caller', async () => {
    const { host, turns, held, current } = fakeHost();
    const runner = new PlanTurns(host);
    const inFlight = runner.enqueue({ source: 'user', text: 'one' });
    const waiting = runner.enqueue({ source: 'user', text: 'two' });
    const old = current.plan!;

    current.plan = plan();
    runner.abandon();

    expect(held()).toBe(0);
    await expect(inFlight).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    await expect(waiting).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    turns[0].fail(new PlannerTurnDiscardedError());
    await flushMicrotasks();
    expect(turns).toHaveLength(1);
    expect(current.plan.pendingTurns).toBeUndefined();
    expect(old.pendingTurns?.map((t) => t.text)).toEqual(['one', 'two']);
    expect(host.notice).not.toHaveBeenCalled();
  });

  it('relays a caller\'s stop into its turn, and drops an input stopped before its turn began', async () => {
    const { host, turns } = fakeHost();
    const runner = new PlanTurns(host);
    const first = new AbortController();
    const second = new AbortController();
    const one = runner.enqueue({ source: 'user', text: 'one', signal: first.signal });
    const two = runner.enqueue({ source: 'user', text: 'two', signal: second.signal });

    first.abort();
    expect(turns[0].signal?.aborted).toBe(true);
    second.abort();
    turns[0].fail(new PlannerTurnStoppedError());

    await expect(one).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    await expect(two).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    expect(turns).toHaveLength(1);
  });
});

describe('PlanTurns: wake-ups (ADR-0029)', () => {
  const wakeUp = (text = 'Run update:\n- task #1 failed') => ({ source: 'supervisor' as const, text });

  it('opens a wake-up turn on wake-ups alone only while the supervisor may wake', async () => {
    const { host, turns } = fakeHost();
    host.mayWake.mockReturnValue(false);
    const runner = new PlanTurns(host);

    void runner.enqueue(wakeUp()).catch(() => {});
    expect(turns).toHaveLength(0);

    host.mayWake.mockReturnValue(true);
    runner.pump();
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toEqual({ source: 'supervisor', text: '', skills: [], wakeUps: ['Run update:\n- task #1 failed'], authority: 'supervisor' });
  });

  it('opens a turn on a report the planner asked for while the supervisor may not wake, acting for whose turn started it (ADR-0037)', () => {
    const { host, turns } = fakeHost();
    host.mayWake.mockReturnValue(false);
    const runner = new PlanTurns(host);

    void runner.enqueue({ ...wakeUp('Run update:\n- task #2 ended'), report: 'user' }).catch(() => {});

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toMatchObject({ source: 'supervisor', wakeUps: ['Run update:\n- task #2 ended'], authority: 'user' });
  });

  it('holds a report while one may not open a turn, until it may', () => {
    const { host, turns } = fakeHost();
    host.mayReport.mockReturnValue(false);
    const runner = new PlanTurns(host);

    void runner.enqueue({ ...wakeUp(), report: 'supervisor' }).catch(() => {});
    expect(turns).toHaveLength(0);

    host.mayReport.mockReturnValue(true);
    runner.pump();
    expect(turns[0].prompt).toMatchObject({ authority: 'supervisor' });
  });

  it('gives a report owed to the user\'s turn a turn of its own, past the supervisor\'s wake-ups that may not open one', async () => {
    const { host, turns } = fakeHost();
    host.mayWake.mockReturnValue(false);
    const runner = new PlanTurns(host);
    void runner.enqueue(wakeUp('Run update:\n- task #1 failed')).catch(() => {});

    void runner.enqueue({ ...wakeUp('Run update:\n- task #2 ended'), report: 'user' }).catch(() => {});

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt.wakeUps).toEqual(['Run update:\n- task #2 ended']);
  });

  it('delivers waiting wake-ups with the user\'s next message, whatever the supervisor may do', async () => {
    const { host, turns, current } = fakeHost();
    host.mayWake.mockReturnValue(false);
    const runner = new PlanTurns(host);
    void runner.enqueue(wakeUp()).catch(() => {});

    const answered = runner.enqueue({ source: 'user', text: 'what happened?' });

    expect(turns[0].prompt).toMatchObject({ source: 'user', text: 'what happened?', wakeUps: ['Run update:\n- task #1 failed'] });
    turns[0].land();
    await answered;
    expect(current.plan!.pendingTurns).toEqual([]);
  });

  it('keeps the wake-ups of a turn that failed, and drops the user\'s message', async () => {
    const { host, turns, current } = fakeHost();
    host.mayWake.mockReturnValue(false);
    const runner = new PlanTurns(host);
    const woke = runner.enqueue(wakeUp());
    const answered = runner.enqueue({ source: 'user', text: 'and now?' });

    turns[0].fail(new Error('planner down'));

    await expect(answered).rejects.toThrow('planner down');
    await expect(woke).rejects.toThrow('planner down');
    expect(current.plan!.pendingTurns!.map((t) => t.source)).toEqual(['supervisor']);
    expect(host.notice).not.toHaveBeenCalled();
  });

  it('drops the wake-ups of a turn the user stopped', async () => {
    const { host, turns, current } = fakeHost();
    const runner = new PlanTurns(host);
    const woke = runner.enqueue(wakeUp());

    turns[0].fail(new PlannerTurnStoppedError());

    await expect(woke).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    expect(current.plan!.pendingTurns).toEqual([]);
  });

  it('keeps the wake-ups of a turn a force send stopped, for the supervisor\'s next turn: the user did not answer them', async () => {
    const { host, turns, current } = fakeHost();
    const runner = new PlanTurns(host);
    let delivered = false;
    const woke = runner.enqueue(wakeUp()).then(() => { delivered = true; });

    const forced = runner.forceSend({ source: 'user', text: 'use Postgres' });
    turns[0].fail(new PlannerTurnStoppedError());
    await flushMicrotasks();

    expect(current.plan!.pendingTurns!.map((t) => t.text)).toEqual(['use Postgres', 'Run update:\n- task #1 failed']);
    expect(turns[1].prompt).toMatchObject({ text: 'use Postgres', wakeUps: [], forced: true });
    turns[1].land();
    await forced;
    await flushMicrotasks();
    expect(delivered).toBe(false);

    expect(turns[2].prompt).toMatchObject({ source: 'supervisor', wakeUps: ['Run update:\n- task #1 failed'] });
    turns[2].land();
    await woke;
    expect(current.plan!.pendingTurns).toEqual([]);
  });

  it('takes a wake-up while another kind of turn holds the conversation, and delivers it when that turn ends', async () => {
    const { host, turns, current } = fakeHost();
    host.conversationBusy.mockReturnValue(true);
    const runner = new PlanTurns(host);

    void runner.enqueue(wakeUp()).catch(() => {});
    expect(current.plan!.pendingTurns).toHaveLength(1);
    expect(turns).toHaveLength(0);

    host.conversationBusy.mockReturnValue(false);
    runner.pump();
    expect(turns).toHaveLength(1);
  });

  it('does not tell the user about a replayed wake-up that failed: the supervisor handles that', async () => {
    const saved = plan();
    saved.pendingTurns = [{ id: 'turn-1', source: 'supervisor', text: 'Run update:\n- task #1 failed', timestamp: '2026-10-11T00:00:00Z' }];
    const { host, turns, current } = fakeHost({ plan: saved });
    const runner = new PlanTurns(host);
    runner.pump();
    host.mayWake.mockReturnValue(false);

    turns[0].fail(new Error('planner down'));
    await flushMicrotasks();

    expect(host.notice).not.toHaveBeenCalled();
    expect(current.plan!.pendingTurns).toHaveLength(1);
  });
});

describe('turnPrompt', () => {
  it('joins a batch in order and keeps every skill it loaded', () => {
    const skill = { name: 'tdd', source: 'global' as const, path: '/s/tdd/SKILL.md', content: 'body', invokedBy: 'user' as const };
    const prompt = turnPrompt([
      { id: '1', source: 'user', text: '/tdd one', timestamp: 't', skills: [skill] },
      { id: '2', source: 'user', text: 'two', timestamp: 't' },
    ]);
    expect(prompt).toEqual({ source: 'user', text: '/tdd one\n\ntwo', skills: [skill], wakeUps: [] });
  });
});

describe('the planner gate', () => {
  const wakeUp = { source: 'supervisor' as const, text: 'Run update:\n- task #1 failed' };

  it('holds a wake-up turn until the planner is found, then opens it', async () => {
    const { host, turns } = fakeHost();
    let found!: () => void;
    const detecting = new Promise<void>((resolve) => { found = resolve; });
    host.plannerDetecting.mockReturnValue(detecting);
    const runner = new PlanTurns(host);

    void runner.enqueue(wakeUp);
    await flushMicrotasks();
    expect(turns).toHaveLength(0);

    host.plannerDetecting.mockReturnValue(null);
    found();
    await flushMicrotasks();
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toMatchObject({ source: 'supervisor', wakeUps: [wakeUp.text] });
  });

  it('opens no turn on a planner that cannot plan, and keeps the wake-ups for one that can', async () => {
    const { host, turns, current } = fakeHost();
    const refusal = new Error('No planner is ready. Pick one with /planner');
    host.assertPlannerReady.mockImplementation(() => { throw refusal; });
    const runner = new PlanTurns(host);

    await expect(runner.enqueue(wakeUp)).rejects.toBe(refusal);
    expect(turns).toHaveLength(0);
    expect(current.plan!.pendingTurns!.map((t) => t.text)).toEqual([wakeUp.text]);

    host.assertPlannerReady.mockImplementation(() => {});
    void runner.enqueue({ source: 'user', text: 'and go on' });
    await flushMicrotasks();
    expect(turns[0].prompt).toMatchObject({ source: 'user', text: 'and go on', wakeUps: [wakeUp.text] });
  });

  it('tells every caller waiting behind a refused force send, not only the forced one', async () => {
    const { host, turns } = fakeHost();
    const runner = new PlanTurns(host);
    void runner.enqueue({ source: 'user', text: 'one' }).catch(() => {});
    await flushMicrotasks();
    const second = runner.enqueue({ source: 'user', text: 'two' });
    const refusal = new Error('No planner is ready. Pick one with /planner');
    host.assertPlannerReady.mockImplementation(() => { throw refusal; });

    const forced = runner.forceSend({ source: 'user', text: 'now' });
    turns[0].fail(new PlannerTurnStoppedError());

    await expect(forced).rejects.toBe(refusal);
    await expect(second).rejects.toBe(refusal);
  });

  it('a Stop while a wake-up waits for the planner ends it as a stopped turn\'s: dropped, its caller told, and never opened', async () => {
    const { host, turns, current } = fakeHost();
    let found!: () => void;
    host.plannerDetecting.mockReturnValue(new Promise<void>((resolve) => { found = resolve; }));
    const runner = new PlanTurns(host);

    const delivered = runner.enqueue(wakeUp);
    await flushMicrotasks();
    expect(runner.stopQueued()).toBe(true);
    await expect(delivered).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    expect(current.plan!.pendingTurns).toEqual([]);

    host.plannerDetecting.mockReturnValue(null);
    found();
    await flushMicrotasks();
    expect(turns).toHaveLength(0);
    expect(runner.stopQueued()).toBe(false);
  });

  it('a Stop of a live turn cancels the user\'s inputs waiting behind it, and its release opens nothing', async () => {
    const { host, turns, current } = fakeHost();
    const runner = new PlanTurns(host);

    const live = runner.enqueue({ source: 'user', text: 'one' });
    const behind = runner.enqueue({ source: 'user', text: 'two' });
    expect(turns).toHaveLength(1);

    expect(runner.stopQueued()).toBe(true);
    await expect(behind).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    expect(current.plan!.pendingTurns!.map((t) => t.text)).toEqual(['one']);
    turns[0].fail(new PlannerTurnStoppedError());
    await expect(live).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    await flushMicrotasks();

    expect(turns).toHaveLength(1);
    expect(current.plan!.pendingTurns).toEqual([]);
  });

  it('a Stop of a live turn keeps the wake-ups behind it for the next input, not for its release', async () => {
    const { host, turns, current } = fakeHost();
    const runner = new PlanTurns(host);

    void runner.enqueue({ source: 'user', text: 'one' }).catch(() => {});
    const kept = runner.enqueue(wakeUp);
    expect(runner.stopQueued()).toBe(false);
    turns[0].fail(new PlannerTurnStoppedError());
    await flushMicrotasks();
    expect(turns).toHaveLength(1);
    expect(current.plan!.pendingTurns!.map((t) => t.text)).toEqual([wakeUp.text]);

    // Nor does a later pump, from a turn of another kind letting the conversation go.
    runner.pump();
    expect(turns).toHaveLength(1);

    const next = runner.enqueue({ source: 'user', text: 'go on' });
    await flushMicrotasks();
    expect(turns[1].prompt).toMatchObject({ source: 'user', text: 'go on', wakeUps: [wakeUp.text] });
    turns[1].land();
    await expect(Promise.all([next, kept])).resolves.toHaveLength(2);
  });

  it('a Stop with no turn live or waiting leaves a message kept from a reload alone', () => {
    const { host, current } = fakeHost();
    current.plan!.pendingTurns = [{ id: 'kept', source: 'user', text: 'Postgres', timestamp: '2026-10-11T00:00:00Z' }];
    const runner = new PlanTurns(host);

    expect(runner.stopQueued()).toBe(false);
    expect(current.plan!.pendingTurns.map((t) => t.text)).toEqual(['Postgres']);
  });
});

describe('an input about tasks the user stopped (ADR-0029)', () => {
  it('opens no turn, and rides with the next one', async () => {
    const { host, turns, current } = fakeHost();
    const runner = new PlanTurns(host);
    host.stoppedByUser.mockImplementation((tasks) => tasks?.[0] === 't1');

    void runner.enqueue({ source: 'supervisor', text: 'about t1', tasks: ['t1'] }).catch(() => {});
    await flushMicrotasks();
    expect(turns).toHaveLength(0);
    expect(current.plan!.pendingTurns!.map((t) => t.text)).toEqual(['about t1']);

    void runner.enqueue({ source: 'supervisor', text: 'about t2', tasks: ['t2'] }).catch(() => {});
    await flushMicrotasks();
    expect(turns.map((t) => t.prompt.wakeUps)).toEqual([['about t1', 'about t2']]);
  });

  it('holds a report about one too, whatever the level', async () => {
    const { host, turns } = fakeHost();
    const runner = new PlanTurns(host);
    host.stoppedByUser.mockReturnValue(true);

    void runner.enqueue({ source: 'supervisor', text: 'a report', report: 'supervisor', tasks: ['t1'] }).catch(() => {});
    await flushMicrotasks();

    expect(turns).toHaveLength(0);
  });
});
