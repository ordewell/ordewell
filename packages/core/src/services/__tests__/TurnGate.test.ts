import { describe, expect, it, vi } from 'vitest';
import type { ReservedLease } from '../executionLease';
import { PlannerTurnDiscardedError, PlannerTurnStoppedError } from '../PlannerConversation';
import { TurnGate, type AdmissionKind, type TurnGateHost } from '../TurnGate';

/** A pool of `slots` planner leases, with the probe and the conversation as the test sets them. */
function harness({ slots = 1, placed = true, answered = true } = {}) {
  let free = slots;
  const released: string[] = [];
  let probeAnswer: () => void = () => undefined;
  const state = {
    answered,
    held: null as Error | null,
    ready: null as Error | null,
    queuedTurnRunning: false,
    conversationBusy: false,
  };
  const reserve = vi.fn((): { lease: ReservedLease } | { refused: string } => {
    if (free === 0) return { refused: 'the tree is full' };
    free--;
    let held = true;
    const lease: ReservedLease = {
      id: `lease-${released.length}`,
      holdsSlot: true,
      open: vi.fn().mockResolvedValue({}),
      release: (why) => {
        if (!held) return;
        held = false;
        free++;
        released.push(why);
      },
    };
    return { lease };
  });
  const host = {
    reserve,
    placed: () => placed,
    plannerAnswered: () => state.answered,
    plannerDetected: vi.fn(() => new Promise<void>((resolve) => {
      probeAnswer = () => {
        state.answered = true;
        resolve();
      };
    })),
    detecting: vi.fn(),
    refuseHeld: vi.fn(() => {
      if (state.held) throw state.held;
    }),
    assertReady: vi.fn(() => {
      if (state.ready) throw state.ready;
    }),
    queuedTurnRunning: () => state.queuedTurnRunning,
    conversationBusy: () => state.conversationBusy,
    parked: vi.fn(),
    pump: vi.fn(),
  } satisfies TurnGateHost;
  const gate = new TurnGate(host);
  /** Another Session gives its slot back, and the pool offers it here. */
  const freeOne = () => {
    free++;
    gate.freed();
  };
  return { gate, host, state, released, freeOne, answerProbe: () => probeAnswer(), takeSlot: () => { free--; } };
}

const outcome = (p: Promise<unknown>) => p.then(() => 'open' as const, (err: unknown) => err);

/** Admit a turn that opens nothing; `entered` says whether it got as far as opening. */
function admitting(gate: TurnGate, { kind = 'session', signal }: { kind?: AdmissionKind; signal?: AbortSignal } = {}) {
  const state = { entered: false };
  const admitted = outcome(gate.admit(kind, signal, () => { state.entered = true; }));
  return { admitted, get entered() { return state.entered; } };
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('TurnGate: admission', () => {
  it('lets a turn in at once when the probe has answered and a slot is free, holding the lease', () => {
    const { gate } = harness();
    expect(admitting(gate).entered).toBe(true);
    expect(gate.holding).toBe(true);
    expect(gate.waiting).toBe(false);
  });

  it('holds a lease for a turn of a Session outside a tree, which never waits for a slot', async () => {
    const { gate, host, takeSlot } = harness({ placed: false });
    expect(admitting(gate).entered).toBe(true);
    expect(host.reserve).toHaveBeenCalledTimes(1);
    expect(gate.holding).toBe(true);

    gate.settled();
    takeSlot();
    const refused = admitting(gate);
    expect(refused.entered).toBe(false);
    expect(await refused.admitted).toEqual(new Error('the tree is full'));
    expect(gate.waiting).toBe(false);
    expect(gate.holding).toBe(false);
  });

  it('refuses at once when the planner cannot plan', async () => {
    const { gate, state } = harness();
    state.ready = new Error('no planner');
    const turn = admitting(gate);
    expect(turn.entered).toBe(false);
    expect(await turn.admitted).toEqual(new Error('no planner'));
  });

  it('waits on the probe, telling the surfaces once however many wait, then judges the planner afresh', async () => {
    const { gate, host, state, answerProbe } = harness({ answered: false });
    const first = admitting(gate).admitted;
    const second = admitting(gate).admitted;
    expect(gate.detecting).toBe(true);
    expect(gate.waiting).toBe(true);
    expect(host.plannerDetected).toHaveBeenCalledTimes(1);
    expect(host.detecting).toHaveBeenCalledWith(true);

    state.ready = new Error('found no planner');
    answerProbe();
    expect(await first).toEqual(new Error('found no planner'));
    expect(await second).toEqual(new Error('found no planner'));
    expect(host.detecting).toHaveBeenLastCalledWith(false);
    expect(gate.detecting).toBe(false);
  });

  it('opens a turn the probe let through on a slot it then takes', async () => {
    const { gate, answerProbe } = harness({ answered: false });
    const admitted = admitting(gate).admitted;
    answerProbe();
    expect(await admitted).toBe('open');
    expect(gate.holding).toBe(true);
  });

  it('a wait ended before the probe answered is not opened by its answer', async () => {
    const { gate, answerProbe } = harness({ answered: false });
    const admitted = admitting(gate).admitted;
    expect(gate.endAll(() => new PlannerTurnDiscardedError())).toBe(true);
    answerProbe();
    expect(await admitted).toBeInstanceOf(PlannerTurnDiscardedError);
    await flush();
    expect(gate.holding).toBe(false);
  });

});

describe('TurnGate: tryAdmit, the queue\'s turn', () => {
  it('admits at once when the probe has answered and a slot is free, holding the lease', () => {
    const { gate } = harness();
    expect(gate.tryAdmit()).toEqual({ kind: 'admitted' });
    expect(gate.holding).toBe(true);
    expect(gate.waiting).toBe(false);
  });

  it('answers with the probe while it is unanswered, telling the surfaces once, and takes nothing', async () => {
    const { gate, host, answerProbe } = harness({ answered: false });
    const first = gate.tryAdmit();
    const second = gate.tryAdmit();
    expect(first).toMatchObject({ kind: 'probing' });
    expect(host.detecting).toHaveBeenCalledTimes(1);
    expect(host.detecting).toHaveBeenCalledWith(true);
    expect(host.assertReady).not.toHaveBeenCalled();
    expect(host.reserve).not.toHaveBeenCalled();
    expect(gate.waiting).toBe(false);
    expect(gate.detecting).toBe(true);

    answerProbe();
    if (first.kind !== 'probing' || second.kind !== 'probing') throw new Error('expected the probe');
    await Promise.all([first.answered, second.answered]);
    expect(gate.detecting).toBe(false);
    expect(gate.tryAdmit()).toEqual({ kind: 'admitted' });
  });

  it('throws what a session turn is refused for, a held session before the planner, taking no slot', () => {
    const { gate, host, state } = harness();
    state.held = new Error('held elsewhere');
    state.ready = new Error('no planner');
    expect(() => gate.tryAdmit()).toThrow('held elsewhere');
    state.held = null;
    expect(() => gate.tryAdmit()).toThrow('no planner');
    expect(host.reserve).not.toHaveBeenCalled();
    expect(gate.holding).toBe(false);
  });

  it('says why the tree is full, without waiting, and is offered the slot when one frees', () => {
    const { gate, host, takeSlot, freeOne } = harness();
    takeSlot();
    expect(gate.tryAdmit()).toEqual({ kind: 'full', why: 'the tree is full' });
    expect(gate.waiting).toBe(false);
    expect(gate.holding).toBe(false);
    // Nobody waits at the gate for it: the queue's next turn may take it.
    freeOne();
    expect(host.pump).toHaveBeenCalledTimes(1);
    expect(gate.tryAdmit()).toEqual({ kind: 'admitted' });
  });

  it('asks the pool once however many turns of the queue follow', () => {
    const { gate, host } = harness();
    gate.tryAdmit();
    gate.tryAdmit();
    expect(host.reserve).toHaveBeenCalledTimes(1);
  });

  it('a Session outside a tree takes a lease too, and its refusal is reported, not waited on', () => {
    const { gate, takeSlot } = harness({ placed: false });
    takeSlot();
    expect(gate.tryAdmit()).toEqual({ kind: 'full', why: 'the tree is full' });
  });
});

describe('TurnGate: one judgment (ADR-0049 L5)', () => {
  it('refuses a turn on a held session before the planner is judged or a slot taken', async () => {
    const { gate, host, state } = harness();
    state.held = new Error('held elsewhere');
    state.ready = new Error('no planner');
    const turn = admitting(gate);
    expect(await turn.admitted).toEqual(new Error('held elsewhere'));
    expect(turn.entered).toBe(false);
    expect(host.assertReady).not.toHaveBeenCalled();
    expect(host.reserve).not.toHaveBeenCalled();
  });

  it('leaves the hold out of a new goal\'s judgment: it is judged by the session it writes', async () => {
    const { gate, host, state } = harness();
    state.held = new Error('held elsewhere');
    const turn = admitting(gate, { kind: 'goal' });
    expect(turn.entered).toBe(true);
    expect(await turn.admitted).toBe('open');
    expect(host.refuseHeld).not.toHaveBeenCalled();
    expect(host.assertReady).toHaveBeenCalledTimes(1);
  });

  it('judges a turn the probe held up once it answers, the hold first', async () => {
    const { gate, host, state, answerProbe } = harness({ answered: false });
    const turn = admitting(gate);
    expect(host.refuseHeld).not.toHaveBeenCalled();
    state.held = new Error('taken over while it waited');
    answerProbe();
    expect(await turn.admitted).toEqual(new Error('taken over while it waited'));
    expect(turn.entered).toBe(false);
    expect(host.reserve).not.toHaveBeenCalled();
  });
});

describe('TurnGate: an admission gives its slot back on every failure', () => {
  it('when what it entered throws', async () => {
    const { gate, released } = harness();
    const failed = outcome(gate.admit('session', undefined, () => { throw new Error('too short to condense'); }));
    expect(await failed).toEqual(new Error('too short to condense'));
    expect(released).toEqual(['turn ended']);
    expect(gate.holding).toBe(false);
  });

  it('when what it entered rejects before taking the conversation', async () => {
    const { gate, released } = harness();
    expect(await outcome(gate.admit('session', undefined, () => Promise.reject(new Error('busy'))))).toEqual(new Error('busy'));
    expect(released).toEqual(['turn ended']);
  });

  it('but not while a turn holds the conversation, whose own end gives it back', async () => {
    const { gate, state, released } = harness();
    const failed = outcome(gate.admit('session', undefined, () => {
      state.conversationBusy = true;
      throw new Error('the turn failed');
    }));
    expect(await failed).toEqual(new Error('the turn failed'));
    expect(released).toEqual([]);
    expect(gate.holding).toBe(true);
  });

  it('when the session is found held once a slot it waited for frees', async () => {
    const { gate, state, released, freeOne, takeSlot } = harness();
    takeSlot();
    const turn = admitting(gate);
    state.held = new Error('taken over while it waited for a slot');
    freeOne();
    expect(await turn.admitted).toEqual(new Error('taken over while it waited for a slot'));
    expect(turn.entered).toBe(false);
    expect(released).toEqual(['turn ended']);
    expect(gate.holding).toBe(false);
  });

  it('when the planner can no longer plan once a slot it waited for frees', async () => {
    const { gate, state, released, freeOne, takeSlot } = harness();
    takeSlot();
    const turn = admitting(gate, { kind: 'goal' });
    state.ready = new Error('the budget ran out');
    freeOne();
    expect(await turn.admitted).toEqual(new Error('the budget ran out'));
    expect(released).toEqual(['turn ended']);
  });

  it('when it is stopped, or ended, while it waits for a slot: none was taken, and none is held', async () => {
    const { gate, released, takeSlot } = harness();
    takeSlot();
    const stop = new AbortController();
    const stopped = admitting(gate, { signal: stop.signal });
    const ended = admitting(gate);
    stop.abort();
    gate.endAll(() => new PlannerTurnDiscardedError());
    expect(await stopped.admitted).toBeInstanceOf(PlannerTurnStoppedError);
    expect(await ended.admitted).toBeInstanceOf(PlannerTurnDiscardedError);
    expect(released).toEqual([]);
    expect(gate.holding).toBe(false);
  });

  it('opens on the slot when nothing fails, keeping it for the turn', async () => {
    const { gate, released } = harness();
    expect(await gate.admit('session', undefined, () => 'opened')).toBe('opened');
    expect(released).toEqual([]);
    expect(gate.holding).toBe(true);
  });
});

describe('TurnGate: a wait for a slot of the tree (ADR-0055 D18)', () => {
  it('an abort while it waits rejects it as stopped, and the freed slot goes to the queue', async () => {
    const { gate, host, freeOne, takeSlot } = harness();
    takeSlot();
    const stop = new AbortController();
    const admitted = admitting(gate, { signal: stop.signal }).admitted;
    stop.abort();
    expect(await admitted).toBeInstanceOf(PlannerTurnStoppedError);
    expect(gate.waiting).toBe(false);

    freeOne();
    expect(host.pump).toHaveBeenCalledTimes(1);
    expect(gate.holding).toBe(false);
  });

  it('refuses at once a caller that had already aborted', async () => {
    const { gate, takeSlot } = harness();
    takeSlot();
    const stop = new AbortController();
    stop.abort();
    expect(await admitting(gate, { signal: stop.signal }).admitted).toBeInstanceOf(PlannerTurnStoppedError);
    expect(gate.waiting).toBe(false);
  });

  it('an end while it waits rejects it with why, and nothing is held when the slot frees', async () => {
    const { gate, host, freeOne, takeSlot } = harness();
    takeSlot();
    const stop = new AbortController();
    const admitted = admitting(gate, { signal: stop.signal }).admitted;
    expect(gate.endAll(() => new PlannerTurnStoppedError())).toBe(true);
    expect(await admitted).toBeInstanceOf(PlannerTurnStoppedError);
    expect(gate.endAll(() => new PlannerTurnStoppedError())).toBe(false);
    // Its abort listener went with it.
    stop.abort();

    freeOne();
    expect(gate.holding).toBe(false);
    expect(host.pump).toHaveBeenCalledTimes(1);
  });

  it('two turns waiting both pass when the one slot frees, on one lease: neither is lost', async () => {
    const { gate, host, freeOne, takeSlot } = harness();
    takeSlot();
    const first = admitting(gate).admitted;
    const second = admitting(gate).admitted;

    freeOne();
    expect(await first).toBe('open');
    expect(await second).toBe('open');
    expect(host.reserve).toHaveBeenCalledTimes(3);
    expect(gate.waiting).toBe(false);
    expect(host.pump).not.toHaveBeenCalled();
  });

  it('waits on when the pool refuses again what it offered', async () => {
    const { gate, host, takeSlot } = harness();
    takeSlot();
    const admitted = admitting(gate).admitted;
    gate.freed();
    expect(gate.waiting).toBe(true);
    expect(host.pump).not.toHaveBeenCalled();
    gate.endAll(() => new PlannerTurnDiscardedError());
    await admitted;
  });

  it('waits for the probe first, then for a slot', async () => {
    const { gate, answerProbe, freeOne, takeSlot } = harness({ answered: false });
    takeSlot();
    const admitted = admitting(gate).admitted;
    answerProbe();
    await flush();
    expect(gate.waiting).toBe(true);
    freeOne();
    expect(await admitted).toBe('open');
  });
});

describe('TurnGate: the lease (ADR-0059 L1)', () => {
  it('opens the planner process on the lease, and on nothing without one', async () => {
    const { gate } = harness();
    const signal = new AbortController().signal;
    expect(gate.open(signal)).toBeUndefined();
    gate.tryAdmit();
    await expect(gate.open(signal)).resolves.toEqual({});
  });

  it('a settled turn parks the Session and gives its slot back, once', () => {
    const { gate, host, released } = harness();
    gate.tryAdmit();
    gate.settled();
    gate.settled();
    expect(released).toEqual(['turn ended']);
    expect(host.parked).toHaveBeenCalledTimes(1);
    expect(gate.holding).toBe(false);
  });

  it('the conversation letting go keeps the lease of a queued turn still under way', () => {
    const { gate, state, released } = harness();
    gate.tryAdmit();
    state.queuedTurnRunning = true;
    gate.released();
    expect(released).toEqual([]);
    state.queuedTurnRunning = false;
    gate.released();
    expect(released).toEqual(['turn ended']);
  });

  it('a refusal after admission gives the slot back, unless a turn holds the conversation', () => {
    const { gate, state, released } = harness();
    gate.tryAdmit();
    state.conversationBusy = true;
    gate.dropped();
    expect(released).toEqual([]);
    state.conversationBusy = false;
    gate.dropped();
    expect(released).toEqual(['turn ended']);
  });

  it('a fresh plan keeps the lease its gate took through the old scope\'s end', () => {
    const { gate, host, released } = harness();
    expect(admitting(gate).entered).toBe(true);
    gate.carry(() => {
      gate.settled();
      gate.dropped();
      gate.carry(() => gate.settled());
      gate.settled();
    });
    expect(released).toEqual([]);
    expect(host.parked).not.toHaveBeenCalled();
    expect(gate.holding).toBe(true);
    // Outside the carry, the turn's own end gives it back.
    gate.settled();
    expect(released).toEqual(['turn ended']);
  });

  it('a lease is kept if the old scope\'s end throws, and a later end still frees it', () => {
    const { gate, released } = harness();
    gate.tryAdmit();
    expect(() => gate.carry(() => { throw new Error('boom'); })).toThrow('boom');
    expect(gate.holding).toBe(true);
    gate.settled();
    expect(released).toEqual(['turn ended']);
  });
});
