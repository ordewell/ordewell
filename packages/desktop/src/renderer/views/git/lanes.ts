/**
 * Lane assignment for the commit graph: which column each commit sits in and
 * which lines cross each row. Pure, so a page loaded later re-lays the whole
 * history instead of patching the part already drawn.
 *
 * Each lane waits for one commit (the next ancestor on that line). A commit
 * takes the leftmost lane waiting for it, a first parent carries on in the same
 * lane, and every other parent joins a lane that already waits for it or opens
 * the leftmost free one. That keeps a long-lived branch in one column and an
 * octopus merge as one node with a line per parent.
 */

export interface GraphCommit {
  sha: string;
  parents: readonly string[];
}

/**
 * A line in one row, in lane columns.
 * - `pass`: runs top to bottom in `from`, behind the node.
 * - `in`: from the top of the row in lane `from`, into the node.
 * - `out`: from the node down to the bottom of the row in lane `to`.
 */
export interface GraphSegment {
  kind: 'pass' | 'in' | 'out';
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  sha: string;
  lane: number;
  color: number;
  segments: GraphSegment[];
  /** More than one parent: a merge, drawn as a ring. */
  merge: boolean;
  /** At least one parent is not among the commits given, so its line leaves the page unfinished. */
  continues: boolean;
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Columns the widest row needs. */
  width: number;
}

/** Colours cycle through this many, so the CSS carries a fixed palette. */
export const LANE_COLORS = 8;

interface Lane {
  waitingFor: string;
  color: number;
}

/**
 * `commits` run newest first, as a page of the log answers them. A parent that
 * shows up above its child (clock skew) is still drawn: its row opens a lane of
 * its own, and the child's line ends where the page does.
 */
export function assignLanes(commits: readonly GraphCommit[]): GraphLayout {
  const shas = new Set(commits.map((c) => c.sha));
  const lanes: Array<Lane | null> = [];
  let nextColor = 0;
  let width = 0;
  const rows: GraphRow[] = [];

  const colour = () => nextColor++ % LANE_COLORS;
  const freeLane = () => {
    const free = lanes.findIndex((l) => l === null);
    return free < 0 ? lanes.length : free;
  };

  for (const commit of commits) {
    const waiting = lanes.flatMap((l, i) => (l?.waitingFor === commit.sha ? [i] : []));
    const segments: GraphSegment[] = [];
    const lane = waiting.length > 0 ? waiting[0] : freeLane();
    const color = waiting.length > 0 ? lanes[lane]!.color : colour();
    let span = Math.max(lanes.length, lane + 1);

    lanes.forEach((l, i) => {
      if (l === null) return;
      if (l.waitingFor === commit.sha) segments.push({ kind: 'in', from: i, to: lane, color: l.color });
      else segments.push({ kind: 'pass', from: i, to: i, color: l.color });
    });
    for (const i of waiting) lanes[i] = null;

    let continues = false;
    commit.parents.forEach((parent, index) => {
      if (!shas.has(parent)) continues = true;
      const joined = lanes.findIndex((l) => l?.waitingFor === parent);
      if (joined >= 0) {
        segments.push({ kind: 'out', from: lane, to: joined, color: lanes[joined]!.color });
        return;
      }
      // The first parent carries the commit's own line on; the rest start theirs.
      const target = index === 0 && lanes[lane] == null ? lane : freeLane();
      const lineColor = index === 0 ? color : colour();
      lanes[target] = { waitingFor: parent, color: lineColor };
      segments.push({ kind: 'out', from: lane, to: target, color: lineColor });
      span = Math.max(span, target + 1);
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, span);
    rows.push({ sha: commit.sha, lane, color, segments, merge: commit.parents.length > 1, continues });
  }
  return { rows, width };
}
