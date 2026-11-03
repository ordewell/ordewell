import { describe, expect, it } from 'vitest';
import { buildGraph } from '../graphModel';
import { neighbour } from '../graphNav';
import { layoutGraph, memoLayout } from '../layout';
import { runTask } from './fixtures';

//   a ─┬─ b ─┐
//      └─ c ─┴─ d
const MODEL = buildGraph([
  runTask({ id: 'a', order: 1 }),
  runTask({ id: 'b', order: 2, dependencies: ['a'] }),
  runTask({ id: 'c', order: 3, dependencies: ['a'] }),
  runTask({ id: 'd', order: 4, dependencies: ['b', 'c'] }),
], { expanded: new Set(), executing: false, handoffPending: false });
if (!MODEL.ok) throw new Error('fixture');
const NODES = new Map(MODEL.nodes.map((n) => [n.id, n]));
const POSITIONS = layoutGraph(MODEL.nodes, MODEL.edges);

describe('layoutGraph', () => {
  it('layers left to right by dependency', () => {
    const x = (id: string) => POSITIONS.get(id)!.x;
    expect(x('a')).toBeLessThan(x('b'));
    expect(x('b')).toBe(x('c'));
    expect(x('b')).toBeLessThan(x('d'));
  });

  it('keeps nodes in a layer from overlapping', () => {
    const b = POSITIONS.get('b')!;
    const c = POSITIONS.get('c')!;
    expect(Math.abs(b.y - c.y)).toBeGreaterThanOrEqual(NODES.get('b')!.height);
  });

  it('is computed once per shape: the same key answers with the same positions', () => {
    const layout = memoLayout();
    const first = layout(MODEL.layoutKey, MODEL.nodes, MODEL.edges);
    expect(layout(MODEL.layoutKey, MODEL.nodes, MODEL.edges)).toBe(first);
    expect(layout('another shape', MODEL.nodes, MODEL.edges)).not.toBe(first);
  });
});

describe('neighbour: the arrow keys', () => {
  it('goes left to a dependency and right to a dependent', () => {
    expect(neighbour('b', 'ArrowLeft', NODES, POSITIONS)).toBe('a');
    expect(neighbour('a', 'ArrowRight', NODES, POSITIONS) === 'b' || neighbour('a', 'ArrowRight', NODES, POSITIONS) === 'c').toBe(true);
    expect(neighbour('c', 'ArrowRight', NODES, POSITIONS)).toBe('d');
  });

  it('goes up and down between the nodes of a layer, top to bottom', () => {
    const top = POSITIONS.get('b')!.y < POSITIONS.get('c')!.y ? 'b' : 'c';
    const bottom = top === 'b' ? 'c' : 'b';
    expect(neighbour(top, 'ArrowDown', NODES, POSITIONS)).toBe(bottom);
    expect(neighbour(bottom, 'ArrowUp', NODES, POSITIONS)).toBe(top);
  });

  it('stays where it is when there is nowhere to go', () => {
    expect(neighbour('a', 'ArrowLeft', NODES, POSITIONS)).toBeNull();
    expect(neighbour('d', 'ArrowRight', NODES, POSITIONS)).toBeNull();
    expect(neighbour('a', 'ArrowUp', NODES, POSITIONS)).toBeNull();
    expect(neighbour('a', 'ArrowDown', NODES, POSITIONS)).toBeNull();
    expect(neighbour('missing', 'ArrowLeft', NODES, POSITIONS)).toBeNull();
  });
});
