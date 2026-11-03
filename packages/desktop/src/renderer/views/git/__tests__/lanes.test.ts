import { describe, expect, it } from 'vitest';
import { assignLanes, LANE_COLORS, type GraphCommit, type GraphRow } from '../lanes';

const c = (sha: string, ...parents: string[]): GraphCommit => ({ sha, parents });
const lanesOf = (commits: GraphCommit[]) => assignLanes(commits).rows.map((r) => r.lane);
const kinds = (row: GraphRow, kind: string) => row.segments.filter((s) => s.kind === kind).map((s) => [s.from, s.to]);

describe('assignLanes', () => {
  it('lays an empty history out as nothing', () => {
    expect(assignLanes([])).toEqual({ rows: [], width: 0 });
  });

  it('keeps a straight history in one lane', () => {
    const layout = assignLanes([c('c', 'b'), c('b', 'a'), c('a')]);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(layout.width).toBe(1);
    expect(kinds(layout.rows[1], 'in')).toEqual([[0, 0]]);
    expect(kinds(layout.rows[1], 'out')).toEqual([[0, 0]]);
    expect(kinds(layout.rows[2], 'out')).toEqual([]);
  });

  it('opens a second lane for a merge and closes it where the branch forks', () => {
    // m merges f (feature) into main; both descend from base.
    const layout = assignLanes([c('m', 'a', 'f'), c('f', 'base'), c('a', 'base'), c('base')]);
    const [m, f, a, base] = layout.rows;
    expect(m.merge).toBe(true);
    expect(kinds(m, 'out')).toEqual([[0, 0], [0, 1]]);
    // main's line hands over to the lane the feature already holds for base, rather than crossing it.
    expect([m.lane, f.lane, a.lane, base.lane]).toEqual([0, 1, 0, 1]);
    expect(layout.width).toBe(2);
    expect(kinds(a, 'out')).toEqual([[0, 1]]);
    expect(kinds(base, 'in')).toEqual([[1, 1]]);
    expect(f.color).not.toBe(m.color);
  });

  it('draws an octopus merge as one node with a line per parent', () => {
    const layout = assignLanes([c('o', 'p1', 'p2', 'p3', 'p4'), c('p1', 'r'), c('p2', 'r'), c('p3', 'r'), c('p4', 'r'), c('r')]);
    const [o, p1, p2, p3, p4, r] = layout.rows;
    expect(o.merge).toBe(true);
    expect(kinds(o, 'out')).toEqual([[0, 0], [0, 1], [0, 2], [0, 3]]);
    expect([p1.lane, p2.lane, p3.lane, p4.lane]).toEqual([0, 1, 2, 3]);
    expect(layout.width).toBe(4);
    // r is every parent's parent: p2..p4 each join the lane p1 already holds for it.
    expect([p2, p3, p4].map((row) => kinds(row, 'out')[0])).toEqual([[1, 0], [2, 0], [3, 0]]);
    expect(r.lane).toBe(0);
  });

  it('gives many branches in flight a lane each, then folds them into the trunk', () => {
    // Six tips, each with a commit of its own below it, all forked from the trunk.
    const n = [1, 2, 3, 4, 5, 6];
    const layout = assignLanes([
      ...n.map((i) => c(`t${i}`, `u${i}`)),
      ...n.map((i) => c(`u${i}`, 'trunk')),
      c('trunk', 'root'),
      c('root'),
    ]);
    expect(layout.rows.slice(0, 6).map((r) => r.lane)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(layout.width).toBe(6);
    expect(layout.rows.slice(6, 12).map((r) => r.lane)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(layout.rows[12].lane).toBe(0);
    expect(layout.rows[13].lane).toBe(0);
  });

  it('lets tips that join straight away share one lane', () => {
    const layout = assignLanes([c('t1', 'trunk'), c('t2', 'trunk'), c('t3', 'trunk'), c('trunk')]);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 1, 1, 0]);
    expect(layout.width).toBe(2);
  });

  it('reuses the leftmost free lane once a branch has ended', () => {
    // Lane 0 is free once a has joined base, so the tip z opens there rather than in a third column.
    const layout = assignLanes([c('m', 'a', 'x'), c('x', 'base'), c('a', 'base'), c('base', 'old'), c('z', 'old'), c('old')]);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 1, 0, 1, 0, 1]);
    expect(layout.width).toBe(2);
    expect(lanesOf([c('y', 'm2'), c('m2', 'm1'), c('m1', 'base')])).toEqual([0, 0, 0]);
  });

  it('cycles colours through the fixed palette instead of running past it', () => {
    const tips = Array.from({ length: LANE_COLORS + 3 }, (_, i) => c(`t${i}`, `u${i}`));
    const { rows } = assignLanes(tips);
    expect(rows.every((r) => r.color >= 0 && r.color < LANE_COLORS)).toBe(true);
    expect(rows[LANE_COLORS].color).toBe(rows[0].color);
    expect(rows[1].color).not.toBe(rows[0].color);
  });

  it('marks a commit whose parent is outside the page as continuing', () => {
    const { rows } = assignLanes([c('b', 'a'), c('a', 'older')]);
    expect(rows[0].continues).toBe(false);
    expect(rows[1].continues).toBe(true);
    expect(kinds(rows[1], 'out')).toEqual([[0, 0]]);
  });

  it('joins a parent that already has a lane, without opening another', () => {
    // Two commits share a parent: the second joins the first's waiting lane.
    const layout = assignLanes([c('b', 'a'), c('c', 'a'), c('a')]);
    expect(layout.rows.map((r) => r.lane)).toEqual([0, 1, 0]);
    expect(kinds(layout.rows[1], 'out')).toEqual([[1, 0]]);
    expect(layout.width).toBe(2);
  });

  it('survives a parent listed above its child', () => {
    const layout = assignLanes([c('a'), c('b', 'a')]);
    expect(layout.rows).toHaveLength(2);
    expect(layout.rows[1].continues).toBe(false);
  });

  it('is stable when a page is later extended', () => {
    const all = [c('m', 'a', 'f'), c('f', 'base'), c('a', 'base'), c('base', 'older'), c('older')];
    const first = assignLanes(all.slice(0, 3)).rows.map((r) => r.lane);
    expect(assignLanes(all).rows.slice(0, 3).map((r) => r.lane)).toEqual(first);
  });
});
