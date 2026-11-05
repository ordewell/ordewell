import { describe, expect, it } from 'vitest';
import { portY, roundedPath, routeEdges, type Box, type RouteColumn, type RouteEdge } from '../edgeRoutes';

type Point = [number, number];

// Comfortable cards: 264 wide, 96 high, 12 apart, columns 56 apart.
const WIDTH = 264;
const HEIGHT = 96;
const box = (column: number, row: number): Box => ({ x: column * (WIDTH + 56), y: row * (HEIGHT + 12), width: WIDTH, height: HEIGHT });

//   a ─┬─ b ─┐
//   e  ├─ c ─┼─ d
//      │  f  │
//      └─────┘        a → d and e → d cross the middle column
const PLACES: Record<string, [number, number]> = { a: [0, 0], e: [0, 1], b: [1, 0], c: [1, 1], f: [1, 2], d: [2, 0] };
const CARDS = new Map(Object.entries(PLACES).map(([id, [c, r]]) => [id, box(c, r)]));
const COLUMNS: RouteColumn[] = [0, 1, 2].map((c) => ({
  left: c * (WIDTH + 56),
  right: c * (WIDTH + 56) + WIDTH,
  ids: Object.keys(PLACES).filter((id) => PLACES[id]![0] === c),
}));
const EDGES: RouteEdge[] = [
  ['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['a', 'd'], ['e', 'd'],
].map(([source, target]) => ({ id: `${source}->${target}`, source: source!, target: target! }));

/** Every point the path names, corners' control points included: a rounded corner's control point is where its two straight runs meet. */
function points(d: string): Point[] {
  const out: Point[] = [];
  for (const [, , args] of d.matchAll(/([MLQ])\s*([^MLQ]+)/g)) {
    const n = args!.trim().split(/\s+/).map(Number);
    for (let i = 0; i < n.length; i += 2) out.push([n[i]!, n[i + 1]!]);
  }
  return out;
}

function crosses(a: Point, b: Point, card: Box): boolean {
  const inset = 0.5;
  const [x1, x2] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [y1, y2] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  return x1 < card.x + card.width - inset && x2 > card.x + inset && y1 < card.y + card.height - inset && y2 > card.y + inset;
}

describe('routeEdges', () => {
  const paths = routeEdges(CARDS, COLUMNS, EDGES);

  it('draws every edge from the right of its dependency to the left of its dependent', () => {
    expect([...paths.keys()].sort()).toEqual(EDGES.map((e) => e.id).sort());
    for (const edge of EDGES) {
      const route = points(paths.get(edge.id)!);
      const from = CARDS.get(edge.source)!;
      const to = CARDS.get(edge.target)!;
      expect(route[0]).toEqual([from.x + from.width, portY(from)]);
      expect(route[route.length - 1]).toEqual([to.x, portY(to)]);
    }
  });

  it('runs only straight across or straight down, never through a card', () => {
    for (const [id, d] of paths) {
      const route = points(d);
      for (let i = 1; i < route.length; i += 1) {
        const [a, b] = [route[i - 1]!, route[i]!];
        expect(a[0] === b[0] || a[1] === b[1], `${id} has a diagonal at ${a} → ${b}`).toBe(true);
        for (const [card, place] of CARDS) expect(crosses(a, b, place), `${id} crosses ${card}`).toBe(false);
      }
    }
  });

  it('turns only in the gaps between columns', () => {
    for (const [id, d] of paths) {
      const route = points(d);
      for (let i = 1; i < route.length; i += 1) {
        const [a, b] = [route[i - 1]!, route[i]!];
        if (a[0] !== b[0]) continue;
        const inGap = COLUMNS.slice(0, -1).some((c, g) => a[0] > c.right && a[0] < COLUMNS[g + 1]!.left);
        expect(inGap, `${id} turns at x ${a[0]}`).toBe(true);
      }
    }
  });

  it('fans a dependency out from one trunk', () => {
    // a → b runs straight across; a → c and a → d turn at their first corner, the trunk.
    const trunk = (id: string): number => points(paths.get(id)!)[2]![0];
    expect(trunk('a->c')).toBe(trunk('a->d'));
  });

  it('leaves out an edge whose card is not measured yet', () => {
    const partial = new Map(CARDS);
    partial.delete('d');
    expect(routeEdges(partial, COLUMNS, EDGES).has('b->d')).toBe(false);
  });
});

describe('portY', () => {
  it('meets a card at its middle, but no lower than a collapsed card does', () => {
    expect(portY({ x: 0, y: 10, width: 10, height: 60 })).toBe(40);
    expect(portY({ x: 0, y: 10, width: 10, height: 400 })).toBe(58);
  });
});

describe('roundedPath', () => {
  it('rounds each corner with a curve whose control point is the corner', () => {
    expect(roundedPath([[0, 0], [20, 0], [20, 20]], 6)).toBe('M 0 0 L 14 0 Q 20 0 20 6 L 20 20');
  });

  it('keeps a corner no rounder than half its shorter run', () => {
    expect(roundedPath([[0, 0], [4, 0], [4, 20]], 6)).toBe('M 0 0 L 2 0 Q 4 0 4 2 L 4 20');
  });

  it('drops repeated points and points in a straight line', () => {
    expect(roundedPath([[0, 0], [10, 0], [10, 0], [20, 0]], 6)).toBe('M 0 0 L 20 0');
  });
});
