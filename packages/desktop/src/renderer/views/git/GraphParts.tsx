import type { RefChip } from './gitModel';
import type { GraphRow } from './lanes';

/*
 * What the full-width graph and the sidebar's history both draw a commit
 * with: its lanes and its ref labels. Only the geometry differs, so the
 * sidebar's narrower lanes are the same paths at another scale.
 */

export interface LaneGeometry {
  row: number;
  lane: number;
  dot: number;
}

const WIDE_LANES: LaneGeometry = { row: 28, lane: 14, dot: 4 };

export function Lanes({ row, width, geometry = WIDE_LANES }: { row: GraphRow; width: number; geometry?: LaneGeometry }): JSX.Element {
  const { row: height, lane, dot } = geometry;
  const x = (at: number): number => at * lane + lane / 2;
  const mid = height / 2;
  return (
    <svg className="git-lanes" width={Math.max(width, 1) * lane + 2} height={height} aria-hidden="true">
      {row.segments.map((s, i) => {
        const d = s.kind === 'pass' ? `M${x(s.from)},0 V${height}`
          : s.kind === 'in' ? `M${x(s.from)},0 L${x(s.to)},${mid}`
            : `M${x(s.from)},${mid} L${x(s.to)},${height}`;
        return <path key={i} d={d} className={`git-lane-${s.color}`} />;
      })}
      {row.continues && <path d={`M${x(row.lane)},${mid} V${height}`} className={`git-lane-${row.color}`} strokeDasharray="2 3" />}
      <circle cx={x(row.lane)} cy={mid} r={dot} className={`git-lane-${row.color}${row.merge ? ' git-merge' : ''}`} />
    </svg>
  );
}

/** Where a ref chip's full name and kind are told, for a chip the sidebar cuts short. */
export function chipTitle(chip: RefChip): string {
  if (chip.kind === 'ordewell') return `${chip.text}: Ordewell’s ${chip.owner?.taskId ? 'task' : 'integration'} branch${chip.owner ? ` for run ${chip.owner.runId}` : ''}`;
  if (chip.current) return `${chip.text}: your checkout’s branch`;
  return chip.kind === 'head' ? 'HEAD: your checkout' : `${chip.text}: ${chip.kind === 'remote' ? 'remote branch' : chip.kind}`;
}

export function Chip({ chip }: { chip: RefChip }): JSX.Element {
  const classes = ['git-chip', `git-chip-${chip.kind}`, chip.current ? 'git-chip-current' : ''].filter(Boolean).join(' ');
  return <span className={classes} title={chipTitle(chip)}>{chip.kind === 'ordewell' ? `Ordewell · ${chip.text}` : chip.text}</span>;
}
