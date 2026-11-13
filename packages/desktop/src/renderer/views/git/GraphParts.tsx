import type { CSSProperties } from 'react';
import { Cloud } from 'lucide-react';
import type { RefChip } from './gitModel';
import { LANE_COLORS, type GraphRow } from './lanes';

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

/** The token a lane's colour index (GraphRow.color) is drawn in, for whatever else shows that commit. */
export function laneColor(color: number): string {
  return `var(--ow-lane-${((color % LANE_COLORS) + LANE_COLORS) % LANE_COLORS})`;
}

/** `lane` is the colour index of the commit the chip sits on, so the chip carries its line's hue. */
export function Chip({ chip, tracked, lane }: { chip: RefChip; tracked?: string; lane?: number }): JSX.Element {
  const classes = ['git-chip', `git-chip-${chip.kind}`, chip.current ? 'git-chip-current' : '', lane === undefined ? '' : 'git-chip-laned'].filter(Boolean).join(' ');
  const text = chip.kind === 'ordewell' ? `Ordewell · ${chip.text}` : chip.text;
  // --chars lets the sidebar's 64 px floor give way to a name shorter than it, so "main" is not padded out to a pill.
  const style = { '--chars': text.length + (tracked ? 2 : 0), ...(lane === undefined ? {} : { '--git-chip-lane': laneColor(lane) }) } as CSSProperties;
  return (
    <span className={classes} style={style} title={tracked ? `${chipTitle(chip)}\nAlso on ${tracked}` : chipTitle(chip)}>
      {text}
      {tracked && <Cloud className="git-chip-mark" size={10} strokeWidth={1.5} aria-hidden="true" />}
    </span>
  );
}
