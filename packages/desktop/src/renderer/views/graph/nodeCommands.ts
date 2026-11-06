import type { GraphNode } from './graphModel';

export type NodeCommandId = 'login' | 'message' | 'stop' | 'retry' | 'skip' | 'diff' | 'fold';

export interface NodeCommand {
  id: NodeCommandId;
  label: string;
}

/**
 * What the context menu offers a node: only what applies to it now, decided
 * by the row view the List's card is drawn from, so a command is on a node
 * exactly when it is on that card. Structure (add, remove, rewire) is not
 * here: the canvas cannot edit it.
 */
export function nodeCommands(node: GraphNode, expanded: boolean): NodeCommand[] {
  const commands: NodeCommand[] = [];
  // A signed-out agent's own way in is the first fix a failed task has.
  if (node.signIn) commands.push({ id: 'login', label: node.signIn.action === 'key' ? 'Set API key…' : 'Log in' });
  if (node.row.chatAvailable) commands.push({ id: 'message', label: 'Message' });
  if (node.actions.includes('cancel')) commands.push({ id: 'stop', label: 'Stop' });
  // Core refuses Run on a failed task, so a fresh retry is its way back (as in the List card).
  if (node.task.status === 'failed' && node.task.type !== 'user') commands.push({ id: 'retry', label: 'Retry' });
  if (node.actions.includes('skip')) commands.push({ id: 'skip', label: 'Skip' });
  if (node.task.isolation && node.task.isolation.state !== 'none') commands.push({ id: 'diff', label: 'Open diff' });
  if (node.fold) commands.push({ id: 'fold', label: expanded ? 'Fold subtasks' : 'Expand subtasks' });
  return commands;
}
