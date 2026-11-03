import type { GraphNode } from './graphModel';
import type { Placed } from './layout';

export type Arrow = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

/**
 * Where an arrow key moves from a node (design keyboard table): ← to a
 * dependency, → to a dependent, ↑↓ between the nodes in the same layer. With
 * several dependencies or dependents the nearest by height wins, so the key
 * stays on the line the eye is following. Null when there is nowhere to go.
 */
export function neighbour(
  from: string,
  key: Arrow,
  nodes: ReadonlyMap<string, GraphNode>,
  positions: ReadonlyMap<string, Placed>,
): string | null {
  const node = nodes.get(from);
  const at = positions.get(from);
  if (!node || !at) return null;
  const nearest = (ids: readonly string[]): string | null => {
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const id of ids) {
      const p = positions.get(id);
      if (!p) continue;
      const distance = Math.abs(p.y - at.y);
      if (distance < bestDistance) { best = id; bestDistance = distance; }
    }
    return best;
  };
  if (key === 'ArrowLeft') return nearest(node.dependsOn);
  if (key === 'ArrowRight') return nearest(node.dependents);
  const layer = [...positions].filter(([, p]) => p.x === at.x).sort((a, b) => a[1].y - b[1].y).map(([id]) => id);
  const index = layer.indexOf(from);
  return layer[key === 'ArrowUp' ? index - 1 : index + 1] ?? null;
}
