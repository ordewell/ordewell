import { describe, expect, it } from 'vitest';
import { IDLE_RUN, heldFrom, nextRunState, type RunEvent, type RunState } from '../runState';

const idle: RunState = IDLE_RUN;
const scheduling: RunState = { kind: 'scheduling' };
const endedOnFailure: RunState = { kind: 'endedOnFailure' };
const finished: RunState = { kind: 'finished' };
const heldIdle: RunState = { kind: 'held', from: 'idle' };
const heldScheduling: RunState = { kind: 'held', from: 'scheduling' };
const heldEnded: RunState = { kind: 'held', from: 'endedOnFailure' };

const STATES: ReadonlyArray<[string, RunState]> = [
  ['idle', idle],
  ['scheduling', scheduling],
  ['endedOnFailure', endedOnFailure],
  ['finished', finished],
  ['held from idle', heldIdle],
  ['held from scheduling', heldScheduling],
  ['held from endedOnFailure', heldEnded],
];

/** Every event in every state, and what it leaves: the whole table, so a transition nobody meant shows up here. */
const TABLE: ReadonlyArray<[RunEvent, ReadonlyArray<RunState>]> = [
  // idle, scheduling, endedOnFailure, finished, held from idle, held from scheduling, held from endedOnFailure
  [{ type: 'schedule' }, [scheduling, scheduling, scheduling, scheduling, scheduling, scheduling, scheduling]],
  [{ type: 'stop' }, [idle, idle, idle, idle, idle, idle, idle]],
  [{ type: 'load' }, [idle, scheduling, idle, idle, idle, idle, idle]],
  [{ type: 'continue' }, [idle, scheduling, scheduling, finished, heldIdle, heldScheduling, heldScheduling]],
  [{ type: 'join' }, [idle, scheduling, endedOnFailure, finished, heldScheduling, heldScheduling, heldScheduling]],
  [{ type: 'hold' }, [heldIdle, heldScheduling, heldEnded, heldIdle, heldIdle, heldScheduling, heldEnded]],
  [{ type: 'release' }, [idle, scheduling, endedOnFailure, finished, idle, scheduling, endedOnFailure]],
  [{ type: 'end', outcome: 'finished' }, [finished, finished, finished, finished, heldIdle, heldScheduling, heldEnded]],
  [{ type: 'end', outcome: 'failed' }, [endedOnFailure, endedOnFailure, endedOnFailure, endedOnFailure, heldIdle, heldScheduling, heldEnded]],
  [{ type: 'reopen' }, [idle, scheduling, endedOnFailure, idle, heldIdle, heldScheduling, heldEnded]],
];

describe('nextRunState', () => {
  for (const [event, after] of TABLE) {
    const name = event.type === 'end' ? `end (${event.outcome})` : event.type;
    describe(name, () => {
      STATES.forEach(([label, state], i) => {
        it(`from ${label}`, () => {
          expect(nextRunState(state, event)).toEqual(after[i]);
        });
      });
    });
  }

  it('changes nothing it is given', () => {
    const state: RunState = { kind: 'held', from: 'scheduling' };
    nextRunState(state, { type: 'release' });
    expect(state).toEqual({ kind: 'held', from: 'scheduling' });
  });
});

describe('a usage-limit hold', () => {
  it('of a task started alone goes back to no run, never to a scheduled one (ADR-0018 U1)', () => {
    const held = nextRunState(idle, { type: 'hold' });
    expect(heldFrom(held)).toBe('idle');
    // A second pause while held keeps what the first held the run from.
    const again = nextRunState(held, { type: 'hold' });
    expect(nextRunState(again, { type: 'release' })).toEqual(idle);
  });

  it('of a whole-plan run stays held past a failure and an end, and goes back to scheduling once released', () => {
    let state = nextRunState(nextRunState(idle, { type: 'schedule' }), { type: 'hold' });
    state = nextRunState(state, { type: 'end', outcome: 'failed' });
    expect(state).toEqual(heldScheduling);
    expect(nextRunState(state, { type: 'release' })).toEqual(scheduling);
  });

  it('of a run that ended on a failure goes back to it, and once a retry continues the run, to scheduling', () => {
    const held = nextRunState(endedOnFailure, { type: 'hold' });
    expect(nextRunState(held, { type: 'release' })).toEqual(endedOnFailure);
    const continued = nextRunState(held, { type: 'continue' });
    expect(continued).toEqual(heldScheduling);
    expect(nextRunState(continued, { type: 'release' })).toEqual(scheduling);
  });

  it('is dropped by a Stop and by a plan load', () => {
    expect(nextRunState(heldScheduling, { type: 'stop' })).toEqual(idle);
    expect(nextRunState(heldScheduling, { type: 'load' })).toEqual(idle);
  });
});

describe('heldFrom', () => {
  it('names what a held run goes back to, and is null for every other state', () => {
    expect([heldIdle, heldScheduling, heldEnded].map(heldFrom)).toEqual(['idle', 'scheduling', 'endedOnFailure']);
    expect([idle, scheduling, endedOnFailure, finished].map(heldFrom)).toEqual([null, null, null, null]);
  });
});
