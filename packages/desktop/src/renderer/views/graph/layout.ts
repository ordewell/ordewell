import dagre from '@dagrejs/dagre';
import type { GraphEdge, GraphNode } from './graphModel';

export interface Placed {
  x: number;
  y: number;
}

const RANK_GAP = 72;
const NODE_GAP = 28;
const MARGIN = 24;

/**
 * Left-to-right layers from the dependencies (dagre's longest-path ranking
 * keeps a chain straight). Dagre places a node by its centre; the canvas wants
 * its corner.
 */
export function layoutGraph(nodes: readonly Pick<GraphNode, 'id' | 'width' | 'height'>[], edges: readonly Pick<GraphEdge, 'source' | 'target'>[]): Map<string, Placed> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'LR', ranksep: RANK_GAP, nodesep: NODE_GAP, marginx: MARGIN, marginy: MARGIN, ranker: 'longest-path' });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.id, { width: node.width, height: node.height });
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);
  const placed = new Map<string, Placed>();
  for (const node of nodes) {
    const at = graph.node(node.id);
    placed.set(node.id, { x: at.x - node.width / 2, y: at.y - node.height / 2 });
  }
  return placed;
}

/** The last layout per plan shape: a status change asks again with the same key and moves nothing. */
export function memoLayout(): (key: string, nodes: readonly GraphNode[], edges: readonly GraphEdge[]) => Map<string, Placed> {
  let lastKey: string | null = null;
  let last = new Map<string, Placed>();
  return (key, nodes, edges) => {
    if (key !== lastKey) {
      last = layoutGraph(nodes, edges);
      lastKey = key;
    }
    return last;
  };
}
