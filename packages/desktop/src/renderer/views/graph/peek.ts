import type { GraphNode } from './graphModel';

export interface Peek {
  heading: string;
  lines: string[];
}

const PEEK_LINES = 6;

/**
 * What the hover/Space peek shows: the tail of a live runner's output when
 * there is one, since that is what "what is it doing now" means; otherwise the
 * words the node already carries, so the peek is never empty.
 */
export function peekOf(node: GraphNode, output: string | undefined): Peek {
  const tail = (output ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '').slice(-PEEK_LINES);
  if (tail.length > 0) return { heading: node.statusLine, lines: tail };
  const lines = [node.fold?.summary, node.description].filter((l): l is string => !!l);
  return { heading: node.statusLine, lines };
}
