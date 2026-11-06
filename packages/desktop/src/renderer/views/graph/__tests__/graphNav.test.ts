import { describe, expect, it } from 'vitest';
import { buildGraph } from '../graphModel';
import { navigate, stageAt, stagesInView, stepStage } from '../graphNav';
import { stageLayout } from '../layout';
import { runTask } from './fixtures';

//   a ─┬─ b ─┐
//      └─ c ─┴─ d
//   e
const MODEL = buildGraph([
  runTask({ id: 'a', order: 1 }),
  runTask({ id: 'b', order: 2, dependencies: ['a'] }),
  runTask({ id: 'c', order: 3, dependencies: ['a'] }),
  runTask({ id: 'd', order: 4, dependencies: ['b', 'c'] }),
  runTask({ id: 'e', order: 5 }),
], { expanded: new Set(), executing: false, handoffPending: false });
if (!MODEL.ok) throw new Error('fixture');
const NODES = new Map(MODEL.nodes.map((n) => [n.id, n]));
const LAYOUT = stageLayout(MODEL.nodes);

describe('navigate', () => {
  it('goes to the one dependency or dependent there is', () => {
    expect(navigate('b', 'ArrowLeft', NODES, LAYOUT)).toEqual({ kind: 'go', id: 'a' });
    expect(navigate('b', 'ArrowRight', NODES, LAYOUT)).toEqual({ kind: 'go', id: 'd' });
  });

  it('offers a choice when there are several, in stage then plan order', () => {
    expect(navigate('a', 'ArrowRight', NODES, LAYOUT)).toEqual({ kind: 'choose', ids: ['b', 'c'] });
    expect(navigate('d', 'ArrowLeft', NODES, LAYOUT)).toEqual({ kind: 'choose', ids: ['b', 'c'] });
  });

  it('stays put with nowhere to go', () => {
    expect(navigate('a', 'ArrowLeft', NODES, LAYOUT)).toBeNull();
    expect(navigate('d', 'ArrowRight', NODES, LAYOUT)).toBeNull();
    expect(navigate('missing', 'ArrowRight', NODES, LAYOUT)).toBeNull();
  });

  it('moves up and down within a stage, stopping at its ends', () => {
    expect(navigate('a', 'ArrowDown', NODES, LAYOUT)).toEqual({ kind: 'go', id: 'e' });
    expect(navigate('e', 'ArrowUp', NODES, LAYOUT)).toEqual({ kind: 'go', id: 'a' });
    expect(navigate('a', 'ArrowUp', NODES, LAYOUT)).toBeNull();
    expect(navigate('c', 'ArrowDown', NODES, LAYOUT)).toBeNull();
  });

  it('goes to the first and last stage at the same row where it can', () => {
    expect(navigate('c', 'Home', NODES, LAYOUT)).toEqual({ kind: 'go', id: 'e' });
    expect(navigate('c', 'End', NODES, LAYOUT)).toEqual({ kind: 'go', id: 'd' });
    expect(navigate('e', 'End', NODES, LAYOUT)).toEqual({ kind: 'go', id: 'd' });
    expect(navigate('a', 'Home', NODES, LAYOUT)).toBeNull();
  });
});

describe('stepStage', () => {
  const STOPS = [0, 320, 640, 960];

  it('steps to the next stage edge', () => {
    expect(stepStage(0, STOPS, 1)).toBe(320);
    expect(stepStage(320, STOPS, 1)).toBe(640);
    expect(stepStage(100, STOPS, 1)).toBe(320);
  });

  it('steps back to the edge of the stage in view, then the one before', () => {
    expect(stepStage(400, STOPS, -1)).toBe(320);
    expect(stepStage(320, STOPS, -1)).toBe(0);
    expect(stepStage(0, STOPS, -1)).toBe(0);
  });

  it('treats a scroll a pixel off a stop as on it', () => {
    expect(stepStage(319.5, STOPS, 1)).toBe(640);
    expect(stepStage(321, STOPS, -1)).toBe(0);
  });

  it('steps to the furthest the scroller goes when the next edge is past it, and back from there to an edge', () => {
    expect(stepStage(320, STOPS, 1, 700)).toBe(640);
    expect(stepStage(640, STOPS, 1, 700)).toBe(700);
    expect(stepStage(700, STOPS, 1, 700)).toBe(700);
    expect(stepStage(699, STOPS, 1, 700)).toBe(700);
    expect(stepStage(700, STOPS, -1, 700)).toBe(640);
  });

  it('does nothing without stages', () => {
    expect(stepStage(42, [], 1)).toBe(42);
  });
});

describe('stageAt', () => {
  it('names the stage at the left edge, or the last one past it', () => {
    expect(stageAt(0, [0, 320, 640])).toBe(0);
    expect(stageAt(319, [0, 320, 640])).toBe(1);
    expect(stageAt(500, [0, 320, 640])).toBe(1);
    expect(stageAt(9999, [0, 320, 640])).toBe(2);
  });
});

describe('stagesInView', () => {
  const COLUMNS = [{ left: 0, right: 264 }, { left: 320, right: 584 }, { left: 640, right: 904 }];

  it('spans the stages at least half in view', () => {
    expect(stagesInView(COLUMNS, 0, 700)).toEqual({ first: 0, last: 1 });
    expect(stagesInView(COLUMNS, 0, 800)).toEqual({ first: 0, last: 2 });
    expect(stagesInView(COLUMNS, 320, 600)).toEqual({ first: 1, last: 2 });
  });

  it('names the stage shown most when none is half in view', () => {
    expect(stagesInView(COLUMNS, 200, 200)).toEqual({ first: 1, last: 1 });
  });

  it('is nothing without stages', () => {
    expect(stagesInView([], 0, 100)).toBeNull();
  });
});
