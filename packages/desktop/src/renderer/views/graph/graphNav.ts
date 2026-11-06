import type { StageLayout } from './layout';

export type NavKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

export const NAV_KEYS: ReadonlySet<string> = new Set<NavKey>(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

/** Where a key leads: one card, a choice between several, or nowhere. */
export type Move = { kind: 'go'; id: string } | { kind: 'choose'; ids: string[] } | null;

/**
 * Where a key moves from a card (design W5, Keys): ← to a dependency and → to
 * a dependent, offering a choice when there are several, since which one the
 * user follows is theirs to say; ↑ ↓ within the stage; Home and End to the
 * first and last stage, at the same row where it has one.
 */
export function navigate(
  from: string,
  key: NavKey,
  edges: ReadonlyMap<string, { dependsOn: readonly string[]; dependents: readonly string[] }>,
  layout: StageLayout,
): Move {
  const at = layout.at.get(from);
  const node = edges.get(from);
  if (!at || !node) return null;
  const pick = (ids: readonly string[]): Move => {
    const placed = ids.filter((id) => layout.at.has(id)).sort((a, b) => {
      const p = layout.at.get(a)!;
      const q = layout.at.get(b)!;
      return p.column - q.column || p.row - q.row;
    });
    if (placed.length === 0) return null;
    return placed.length === 1 ? { kind: 'go', id: placed[0]! } : { kind: 'choose', ids: placed };
  };
  const cell = (column: number, row: number): Move => {
    const ids = layout.columns[column];
    if (!ids || ids.length === 0) return null;
    const id = ids[Math.min(Math.max(row, 0), ids.length - 1)]!;
    return id === from ? null : { kind: 'go', id };
  };
  switch (key) {
    case 'ArrowLeft': return pick(node.dependsOn);
    case 'ArrowRight': return pick(node.dependents);
    case 'ArrowUp': return at.row > 0 ? cell(at.column, at.row - 1) : null;
    case 'ArrowDown': return at.row < layout.columns[at.column]!.length - 1 ? cell(at.column, at.row + 1) : null;
    case 'Home': return cell(0, at.row);
    case 'End': return cell(layout.columns.length - 1, at.row);
  }
}

/** Below this a column's edge counts as at the scroller's edge: a snapped scroll can land a fraction of a pixel off. */
const SNAPPED = 2;

/**
 * Where ‹ or › scrolls to: the next stage's left edge, or back to the left
 * edge of the stage in view, then the one before it. `stops` are the scroll
 * positions that put each stage at the left edge, in order. A stage the
 * scroller cannot bring to its left edge is stepped to as far as it goes: the
 * last stages would otherwise stay out of reach.
 */
export function stepStage(scrollLeft: number, stops: readonly number[], direction: 1 | -1, max = Infinity): number {
  if (stops.length === 0) return scrollLeft;
  const clamp = (x: number): number => Math.max(0, Math.min(x, max));
  if (direction === 1) {
    const next = stops.find((s) => s > scrollLeft + SNAPPED);
    return clamp(next ?? scrollLeft);
  }
  const before = [...stops].reverse().find((s) => s < scrollLeft - SNAPPED);
  return clamp(before ?? 0);
}

/** The stage whose left edge is at the scroller's, or the last one past it: what the chips call the first in view. */
export function stageAt(scrollLeft: number, stops: readonly number[]): number {
  let at = 0;
  stops.forEach((s, i) => { if (s <= scrollLeft + SNAPPED) at = i; });
  return at;
}

/**
 * The stages the bracket under the chips spans: those at least half in view.
 * When the view is narrower than half a column, the one it shows most of.
 */
export function stagesInView(
  columns: readonly { left: number; right: number }[],
  scrollLeft: number,
  width: number,
): { first: number; last: number } | null {
  if (columns.length === 0) return null;
  const right = scrollLeft + width;
  const shown = columns.map((c) => Math.max(0, Math.min(c.right, right) - Math.max(c.left, scrollLeft)) / Math.max(1, c.right - c.left));
  const visible = shown.map((share, i) => (share >= 0.5 ? i : -1)).filter((i) => i >= 0);
  if (visible.length > 0) return { first: visible[0]!, last: visible[visible.length - 1]! };
  const most = shown.indexOf(Math.max(...shown));
  return { first: most, last: most };
}
