import { createContext, memo, useContext, type KeyboardEvent } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { StatusIndicator } from '@ordewell/ui/design';
import type { GraphNode } from './graphModel';
import type { Arrow } from './graphNav';
import type { Peek } from './peek';

/** What a node can ask of the canvas; stable, so a memoized node never re-renders for it. */
export interface NodeActions {
  select(id: string): void;
  open(id: string): void;
  openChat(id: string): void;
  toggleFold(id: string): void;
  togglePeek(id: string): void;
  hover(id: string | null): void;
  move(id: string, key: Arrow): void;
  menu(id: string, at: { x: number; y: number } | 'node'): void;
  closePeek(): void;
}

export const NodeActionsContext = createContext<NodeActions | null>(null);

export interface TaskNodeData extends Record<string, unknown> {
  node: GraphNode;
  selected: boolean;
  /** The one node in the tab order (roving tabindex): Tab enters the canvas once. */
  tabbable: boolean;
  expanded: boolean;
  peek: Peek | null;
}

export type TaskFlowNode = Node<TaskNodeData, 'task'>;

const ARROWS: ReadonlySet<string> = new Set<Arrow>(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

function TaskNodeView({ data }: NodeProps<TaskFlowNode>): JSX.Element {
  const actions = useContext(NodeActionsContext)!;
  const { node, selected, tabbable, expanded, peek } = data;
  const tab = tabbable ? 0 : -1;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (ARROWS.has(event.key)) {
      event.preventDefault();
      actions.move(node.id, event.key as Arrow);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      actions.open(node.id);
    } else if (event.key === ' ') {
      event.preventDefault();
      actions.togglePeek(node.id);
    } else if (event.key === 'Escape') {
      actions.closePeek();
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      actions.menu(node.id, 'node');
    }
  };

  return (
    <div
      className="graph-node"
      data-selected={selected}
      data-critical={node.critical}
      data-status={node.status.id}
      onMouseEnter={() => actions.hover(node.id)}
      onMouseLeave={() => actions.hover(null)}
      onContextMenu={(event) => { event.preventDefault(); actions.menu(node.id, { x: event.clientX, y: event.clientY }); }}
    >
      <Handle type="target" position={Position.Left} className="graph-handle" isConnectable={false} />
      <button
        type="button"
        className="graph-node-face nodrag nopan"
        data-task-id={node.id}
        tabIndex={tab}
        aria-label={node.label}
        aria-description={node.description}
        aria-current={selected ? 'true' : undefined}
        aria-haspopup="menu"
        onClick={() => actions.select(node.id)}
        onDoubleClick={() => actions.open(node.id)}
        onKeyDown={onKeyDown}
      >
        <span className="graph-node-head">
          <StatusIndicator status={node.status.id} size={16} />
          <span className="graph-node-order">#{node.orderLabel}</span>
          <span className="graph-node-title">{node.title}</span>
        </span>
        <span className="graph-node-meta">
          {node.assignment && <span>{node.assignment}</span>}
          {node.badges.map((b) => <span key={b.kind} className="graph-badge" title={b.title}>{b.label}</span>)}
          {node.loop && <span className="graph-badge" data-loop={node.loop.role} title={node.loop.title}>{node.loop.label}</span>}
        </span>
        <span className="graph-node-meta">
          <span className="graph-node-status">{node.statusLine}</span>
          {node.flags.map((f) => <span key={f.kind} className="graph-badge" data-flag={f.kind} title={f.title}>{f.label}</span>)}
        </span>
      </button>
      {node.row.chatAvailable && (
        <button
          type="button"
          className="graph-node-chat nodrag nopan"
          tabIndex={tab}
          aria-label={`Open chat for #${node.orderLabel} ${node.title}`}
          onClick={() => actions.openChat(node.id)}
        >
          Open chat
        </button>
      )}
      {node.fold && (
        <>
          <button
            type="button"
            className="graph-node-fold nodrag nopan"
            tabIndex={tab}
            aria-expanded={expanded}
            onClick={() => actions.toggleFold(node.id)}
          >
            {expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            {node.fold.summary}
          </button>
          {expanded && (
            <ul className="graph-node-subtasks" aria-label={`Inside #${node.orderLabel}`}>
              {node.fold.childPlan?.goal && <li><span>Goal</span><span>{node.fold.childPlan.goal}</span></li>}
              {node.fold.subtasks.map((s) => (
                <li key={s.id}>
                  <StatusIndicator status={s.status.id} size={12} />
                  <span>#{s.orderLabel}</span>
                  <span>{s.title}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <Handle type="source" position={Position.Right} className="graph-handle" isConnectable={false} />
      {peek && (
        <div className="graph-peek" role="status">
          <strong>{peek.heading}</strong>
          {peek.lines.length > 0 && <pre>{peek.lines.join('\n')}</pre>}
        </div>
      )}
    </div>
  );
}

/**
 * `viewKey` is the node's own word for "what I draw changed", so a status
 * tick elsewhere in a 60-task plan re-renders only the nodes it touched.
 */
export const TaskNode = memo(TaskNodeView, (a, b) => {
  const x = a.data;
  const y = b.data;
  return x.node.viewKey === y.node.viewKey && x.selected === y.selected && x.tabbable === y.tabbable
    && x.expanded === y.expanded && x.peek?.lines.join('\n') === y.peek?.lines.join('\n') && !!x.peek === !!y.peek;
});
