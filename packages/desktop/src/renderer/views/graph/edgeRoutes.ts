/**
 * The graph's edge paths (design W5, checklist G3): every edge leaves the
 * right side of its dependency's card and enters the left side of its
 * dependent's, turning only in the gaps between columns, with rounded corners
 * and no diagonals. An edge that skips stages crosses the columns between at a
 * height no card in them covers. Pure: the card boxes come in, the paths go
 * out, so it is tested without a browser.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RouteColumn {
  left: number;
  right: number;
  ids: readonly string[];
}

export interface RouteEdge {
  id: string;
  source: string;
  target: string;
}

type Point = readonly [number, number];

/** Where an edge meets a card: its middle, but no lower than a collapsed Comfortable card's, so an opened fold does not drag it down. */
const PORT_DROP = 48;
/** How far a crossing keeps from a card above or below it. */
const CLEARANCE = 4;
/** Two vertical runs in a gap keep at least this far apart along it before they may share a lane. */
const LANE_SEPARATION = 6;
const CORNER = 6;

export function portY(box: Box): number {
  return box.y + Math.min(box.height / 2, PORT_DROP);
}

/** One vertical run in a gap: a source's fan-out, a target's fan-in, or one edge's own turn. */
interface Run {
  key: string;
  gap: number;
  low: number;
  high: number;
}

/**
 * The paths, by edge id. An edge whose card or column is missing (not measured
 * yet) is left out rather than drawn somewhere wrong.
 */
export function routeEdges(
  cards: ReadonlyMap<string, Box>,
  columns: readonly RouteColumn[],
  edges: readonly RouteEdge[],
): Map<string, string> {
  const columnOf = new Map<string, number>();
  columns.forEach((c, i) => c.ids.forEach((id) => columnOf.set(id, i)));
  const outs = new Map<string, number>();
  const ins = new Map<string, number>();
  for (const e of edges) {
    outs.set(e.source, (outs.get(e.source) ?? 0) + 1);
    ins.set(e.target, (ins.get(e.target) ?? 0) + 1);
  }

  interface Plan { edge: RouteEdge; from: Box; to: Box; s: number; t: number; sy: number; ty: number; cy: number; first: string; last: string }
  const plans: Plan[] = [];
  const runs = new Map<string, Run>();
  const extend = (key: string, gap: number, a: number, b: number): void => {
    const run = runs.get(key) ?? { key, gap, low: Infinity, high: -Infinity };
    run.low = Math.min(run.low, a, b);
    run.high = Math.max(run.high, a, b);
    runs.set(key, run);
  };
  const crossings: { y: number; from: number; to: number; source: string; target: string }[] = [];

  for (const edge of edges) {
    const from = cards.get(edge.source);
    const to = cards.get(edge.target);
    const s = columnOf.get(edge.source);
    const t = columnOf.get(edge.target);
    if (!from || !to || s === undefined || t === undefined || t <= s) continue;
    const sy = portY(from);
    const ty = portY(to);
    // A source with several dependents fans out from one trunk, and a target with several dependencies gathers into one.
    const fanOut = (outs.get(edge.source) ?? 0) > 1;
    const fanIn = (ins.get(edge.target) ?? 0) > 1;
    if (t === s + 1) {
      const key = fanOut ? `out:${edge.source}` : fanIn ? `in:${edge.target}` : `edge:${edge.id}`;
      extend(key, s, sy, ty);
      plans.push({ edge, from, to, s, t, sy, ty, cy: ty, first: key, last: key });
      continue;
    }
    const cy = channel(cards, columns, s, t, sy, ty, crossings, edge);
    crossings.push({ y: cy, from: columns[s + 1]!.left, to: columns[t - 1]!.right, source: edge.source, target: edge.target });
    const first = fanOut ? `out:${edge.source}` : `edge:${edge.id}:out`;
    const last = fanIn ? `in:${edge.target}` : `edge:${edge.id}:in`;
    extend(first, s, sy, cy);
    extend(last, t - 1, cy, ty);
    plans.push({ edge, from, to, s, t, sy, ty, cy, first, last });
  }

  const laneX = lanes([...runs.values()], columns);
  const paths = new Map<string, string>();
  for (const p of plans) {
    const sx = p.from.x + p.from.width;
    const tx = p.to.x;
    const x1 = laneX.get(p.first)!;
    const x2 = laneX.get(p.last)!;
    const points: Point[] = p.t === p.s + 1
      ? [[sx, p.sy], [x1, p.sy], [x1, p.ty], [tx, p.ty]]
      : [[sx, p.sy], [x1, p.sy], [x1, p.cy], [x2, p.cy], [x2, p.ty], [tx, p.ty]];
    paths.set(p.edge.id, roundedPath(points, CORNER));
  }
  return paths;
}

/**
 * The height an edge crosses the columns between its ends at: one no card in
 * them covers, as near its two ends as there is, and apart from the other
 * crossings unless it shares an end with them (then they are one line).
 */
function channel(
  cards: ReadonlyMap<string, Box>,
  columns: readonly RouteColumn[],
  s: number,
  t: number,
  sy: number,
  ty: number,
  taken: readonly { y: number; from: number; to: number; source: string; target: string }[],
  edge: RouteEdge,
): number {
  const between = columns.slice(s + 1, t);
  const boxes = between.flatMap((c) => c.ids.map((id) => cards.get(id)).filter((b): b is Box => !!b));
  const free = (y: number): boolean => boxes.every((b) => y < b.y - CLEARANCE || y > b.y + b.height + CLEARANCE);
  const left = columns[s + 1]!.left;
  const right = columns[t - 1]!.right;
  const clash = (y: number): boolean => taken.some((c) =>
    Math.abs(c.y - y) < LANE_SEPARATION && c.from < right && left < c.to && c.source !== edge.source && c.target !== edge.target);

  const candidates = [ty, sy];
  for (const column of between) {
    const inColumn = column.ids.map((id) => cards.get(id)).filter((b): b is Box => !!b).sort((a, b) => a.y - b.y);
    for (let i = 1; i < inColumn.length; i += 1) {
      const above = inColumn[i - 1]!;
      candidates.push((above.y + above.height + inColumn[i]!.y) / 2);
    }
  }
  const bottom = boxes.reduce((most, b) => Math.max(most, b.y + b.height), -Infinity);
  const below = (Number.isFinite(bottom) ? bottom : Math.max(sy, ty)) + CLEARANCE * 3;
  candidates.push(below);

  const cost = (y: number): number => Math.abs(y - sy) + Math.abs(y - ty);
  const ranked = candidates.filter(free).sort((a, b) => cost(a) - cost(b));
  for (const y of ranked) {
    for (const nudge of [0, LANE_SEPARATION / 2, -LANE_SEPARATION / 2]) {
      if (free(y + nudge) && !clash(y + nudge)) return y + nudge;
    }
  }
  // Below everything is always free of cards; past the other crossings there it is free of them too.
  let y = below;
  while (clash(y)) y += LANE_SEPARATION;
  return y;
}

/**
 * Each run's x in its gap. Runs that overlap along the gap get lanes of their
 * own (interval colouring, first fit), and a gap's lanes are spread evenly
 * across it, so however many there are none touches a card.
 */
function lanes(runs: readonly Run[], columns: readonly RouteColumn[]): Map<string, number> {
  const byGap = new Map<number, Run[]>();
  for (const run of runs) byGap.set(run.gap, [...(byGap.get(run.gap) ?? []), run]);
  const x = new Map<string, number>();
  for (const [gap, inGap] of byGap) {
    const left = columns[gap]!.right;
    const right = columns[gap + 1]!.left;
    const sorted = [...inGap].sort((a, b) => a.low - b.low || a.high - b.high || a.key.localeCompare(b.key));
    const ends: number[] = [];
    const laneOf = new Map<string, number>();
    for (const run of sorted) {
      let lane = ends.findIndex((end) => end + LANE_SEPARATION <= run.low);
      if (lane === -1) { lane = ends.length; ends.push(run.high); } else ends[lane] = run.high;
      laneOf.set(run.key, lane);
    }
    const count = ends.length;
    for (const [key, lane] of laneOf) x.set(key, left + ((right - left) * (lane + 1)) / (count + 1));
  }
  return x;
}

/** A polyline as a path with its corners rounded; points on a straight line and repeats are dropped first. */
export function roundedPath(input: readonly Point[], radius: number): string {
  const points: Point[] = [];
  for (const p of input) {
    const last = points[points.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01) continue;
    const before = points[points.length - 2];
    if (before && last && collinear(before, last, p)) points.pop();
    points.push(p);
  }
  const round = (n: number): string => String(Math.round(n * 10) / 10);
  const at = (p: Point): string => `${round(p[0])} ${round(p[1])}`;
  if (points.length === 0) return '';
  let d = `M ${at(points[0]!)}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1]!;
    const p = points[i]!;
    const next = points[i + 1]!;
    const r = Math.min(radius, distance(prev, p) / 2, distance(p, next) / 2);
    const a: Point = [p[0] - unit(prev[0], p[0]) * r, p[1] - unit(prev[1], p[1]) * r];
    const b: Point = [p[0] + unit(p[0], next[0]) * r, p[1] + unit(p[1], next[1]) * r];
    d += ` L ${at(a)} Q ${at(p)} ${at(b)}`;
  }
  return `${d} L ${at(points[points.length - 1]!)}`;
}

function collinear(a: Point, b: Point, c: Point): boolean {
  return (Math.abs(a[0] - b[0]) < 0.01 && Math.abs(b[0] - c[0]) < 0.01) || (Math.abs(a[1] - b[1]) < 0.01 && Math.abs(b[1] - c[1]) < 0.01);
}

function distance(a: Point, b: Point): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function unit(from: number, to: number): number {
  return Math.sign(to - from);
}
