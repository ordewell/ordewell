import { describe, expect, it } from 'vitest';
import { StreamOrder, stampOf } from '../streamOrder';

const at = (seq: number, stream = 'a') => ({ stream, seq });

describe('stampOf', () => {
  it.each([
    [{ stream: 'a', seq: 3 }, { stream: 'a', seq: 3 }],
    [{ stream: 'a' }, null],
    [{ seq: 3 }, null],
    [{}, null],
  ])('%j is %j', (frame, stamp) => {
    expect(stampOf(frame)).toEqual(stamp);
  });
});

type Step =
  | ['first', number, string?, string?]
  | ['adopt', number, string?]
  | ['cover', number];

const KEEP = { keep: true, jump: false };
const JUMP = { keep: true, jump: true };
const DROP = { keep: false };

describe('StreamOrder', () => {
  // Each row is one client's life; `want` answers the steps that judge a frame, in order.
  it.each<[string, Step[], unknown[]]>([
    ['numbers in a row', [['first', 1], ['first', 2], ['first', 3]], [KEEP, KEEP, KEEP]],
    ['a first frame, whatever its number', [['first', 40]], [KEEP]],
    ['a number skipped', [['first', 1], ['first', 4]], [KEEP, JUMP]],
    ['a copy on a second socket', [['first', 1], ['first', 2], ['first', 2]], [KEEP, KEEP, DROP]],
    ['a late frame below the highest that was not yet seen', [['first', 1], ['first', 3], ['first', 2]], [KEEP, JUMP, KEEP]],
    ['a frame older than the window', [['first', 300], ['first', 40]], [KEEP, DROP]],
    ['a restarted daemon', [['first', 5], ['first', 1, 'b']], [KEEP, JUMP]],
    ['a restarted daemon, then its next frame', [['first', 5], ['first', 1, 'b'], ['first', 2, 'b']], [KEEP, JUMP, KEEP]],
    ['a snapshot with nothing delivered', [['adopt', 7]], [KEEP]],
    ['a snapshot as new as everything delivered', [['first', 1], ['first', 2], ['adopt', 2]], [KEEP, KEEP, KEEP]],
    ['a snapshot past what was delivered', [['first', 1], ['adopt', 5]], [KEEP, JUMP]],
    ['a snapshot older than a broadcast shown', [['first', 4], ['adopt', 2]], [KEEP, DROP]],
    ['a snapshot of a restarted daemon', [['first', 4], ['adopt', 1, 'b']], [KEEP, JUMP]],
    ['a run frame the snapshot accounts for', [['adopt', 5], ['first', 3, 'a', 'status_update']], [KEEP, DROP]],
    ['a run frame after the snapshot', [['adopt', 5], ['first', 6, 'a', 'status_update']], [KEEP, KEEP]],
    ['a conversation frame below the snapshot, which it does not account for', [['first', 1], ['adopt', 4], ['first', 3, 'a', 'planner_message']], [KEEP, JUMP, KEEP]],
    ['a frame a load covered', [['cover', 5], ['first', 5], ['first', 6]], [DROP, KEEP]],
    ['a snapshot below what a load covered', [['cover', 5], ['adopt', 4]], [DROP]],
    ['a frame after a load, though it jumped over nothing', [['first', 1], ['cover', 9], ['first', 10]], [KEEP, KEEP]],
  ])('%s', (_what, steps, want) => {
    const order = new StreamOrder(256);
    const got: unknown[] = [];
    for (const step of steps) {
      if (step[0] === 'cover') order.cover(at(step[1]));
      else if (step[0] === 'adopt') got.push(order.adopt(at(step[1], step[2])));
      else got.push(order.first(at(step[1], step[2]), step[3] ?? 'planner_turn_started'));
    }
    expect(got).toEqual(want);
  });

  it('forgets a number the window has moved past, and keeps the window it was given', () => {
    const order = new StreamOrder(4);
    for (const seq of [1, 2, 3, 4, 5]) order.first(at(seq), 'x');
    expect(order.first(at(1), 'x')).toEqual(DROP);
    expect(order.first(at(2), 'x')).toEqual(DROP);
  });
});
