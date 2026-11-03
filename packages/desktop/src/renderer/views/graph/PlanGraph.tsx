import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Background, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type NodeTypes,
} from '@xyflow/react';
import { Map as MapIcon, Maximize, Route } from 'lucide-react';
import { titledTaskRefOf } from '@ordewell/core/plan-utils';
import { IconButton } from '@ordewell/ui/design';
import type { FrameApi } from '../../frame/api';
import type { DaemonHost } from '../../session/DaemonHost';
import { useTaskSelection } from '../../session/selection';
import { useSession } from '../../session/useSession';
import { requestTaskView } from '../task/taskView';
import { buildGraph, graphTasks, type GraphNode } from './graphModel';
import { neighbour, type Arrow } from './graphNav';
import { memoLayout, type Placed } from './layout';
import { NodeMenu, type MenuAnchor } from './NodeMenu';
import { nodeCommands, type NodeCommandId } from './nodeCommands';
import { peekOf } from './peek';
import { NodeActionsContext, TaskNode, type NodeActions, type TaskFlowNode } from './TaskNode';

const NODE_TYPES: NodeTypes = { task: TaskNode };
const FIT = { padding: 0.15, maxZoom: 1 } as const;
/**
 * Past this many nodes only those in view are mounted. Below it all are, so
 * every node is reachable by a screen reader's own navigation; the canvas
 * stays smooth well past a plan of sixty either way.
 */
const VIRTUALIZE_ABOVE = 120;
const PEEK_DELAY_MS = 350;
const SYSTEM_COMMANDS = { stop: 'cancel', retry: 'retry', skip: 'skip' } as const;

/** Design: reduced motion means no animated pan or fit. */
function motion(ms: number): number {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms;
}

export interface PlanGraphProps {
  host: DaemonHost;
  api: FrameApi;
  /** The plan has a dependency loop, so no layering exists: the tab falls back to the List and says why. */
  onCannotDraw(reason: string): void;
}

/**
 * The plan as a graph (design W5): React Flow draws what `buildGraph` decided
 * and dagre placed. The structure is not editable here, so every control is a
 * command on a task, run through the same host messages the List's buttons post.
 */
export function PlanGraph(props: PlanGraphProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

interface MenuState {
  id: string;
  at: MenuAnchor | 'node';
}

function Canvas({ host, api, onCannotDraw }: PlanGraphProps): JSX.Element {
  const { state } = useSession(host);
  const selection = useTaskSelection(host);
  const flow = useReactFlow();
  const canvas = useRef<HTMLDivElement>(null);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [showCritical, setShowCritical] = useState(true);
  const [minimap, setMinimap] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const executing = state.isExecuting || state.activity.advancesOnItsOwn;
  const handoffPending = !!state.run.handoff || (state.run.runMerge?.landed.length ?? 0) > 0;
  const drawCritical = executing && showCritical;
  const tasks = useMemo(() => graphTasks(state.plan, state.run), [state.plan, state.run]);
  const model = useMemo(() => buildGraph(tasks, {
    expanded, executing: drawCritical, handoffPending, modesByRunner: state.modesByRunner,
  }), [tasks, expanded, drawCritical, handoffPending, state.modesByRunner]);

  const layout = useMemo(memoLayout, []);
  const positions = useMemo(
    () => (model.ok ? layout(model.layoutKey, model.nodes, model.edges) : new Map<string, Placed>()),
    [model, layout],
  );
  const nodes = useMemo(() => new Map<string, GraphNode>(model.ok ? model.nodes.map((n) => [n.id, n]) : []), [model]);

  const reason = model.ok ? null : model.reason;
  useEffect(() => { if (reason) onCannotDraw(reason); }, [reason, onCannotDraw]);

  const selectedId = selection.taskId && nodes.has(selection.taskId) ? selection.taskId : null;
  const firstId = model.ok ? model.nodes[0]?.id ?? null : null;
  const tabbableId = (active && nodes.has(active) ? active : null) ?? selectedId ?? firstId;
  const peekId = pinned ?? hovered;
  const peekOutput = peekId ? state.taskOutput[peekId] : undefined;

  const flowNodes = useMemo<TaskFlowNode[]>(() => (model.ok ? model.nodes.map((node) => ({
    id: node.id,
    type: 'task',
    position: positions.get(node.id)!,
    width: node.width,
    height: node.height,
    // The peek overlaps its neighbours, so its node draws above them.
    zIndex: node.id === peekId ? 20 : node.id === selectedId ? 10 : 0,
    draggable: false,
    selectable: false,
    focusable: false,
    data: {
      node,
      selected: node.id === selectedId,
      tabbable: node.id === tabbableId,
      expanded: expanded.has(node.id) && node.fold !== null,
      peek: node.id === peekId ? peekOf(node, peekOutput) : null,
    },
  })) : []), [model, positions, selectedId, tabbableId, expanded, peekId, peekOutput]);

  const flowEdges = useMemo<Edge[]>(() => (model.ok ? model.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'smoothstep',
    className: `graph-edge graph-edge--${edge.state}${edge.critical && drawCritical ? ' graph-edge--critical' : ''}`,
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    selectable: false,
    focusable: false,
    // The edges are said in each node's description; drawn twice they would only be noise (design a11y).
    ariaRole: 'presentation',
    domAttributes: { 'aria-hidden': true },
  })) : []), [model, drawCritical]);

  const faceOf = (id: string): HTMLElement | null => canvas.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`) ?? null;
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const face = faceOf(id);
    if (face) { pendingFocus.current = null; face.focus(); }
  });

  const reveal = useCallback((id: string) => {
    const at = positions.get(id);
    const node = nodes.get(id);
    const bounds = canvas.current?.getBoundingClientRect();
    if (!at || !node || !bounds) return;
    const { x, y, zoom } = flow.getViewport();
    const left = at.x * zoom + x;
    const top = at.y * zoom + y;
    const inside = left >= 0 && top >= 0 && left + node.width * zoom <= bounds.width && top + node.height * zoom <= bounds.height;
    if (!inside) void flow.setCenter(at.x + node.width / 2, at.y + node.height / 2, { zoom, duration: motion(200) });
  }, [flow, positions, nodes]);

  const tabOf = useCallback((id: string) => ({
    kind: 'task',
    id,
    title: titledTaskRefOf(host.getSnapshot().state.plan?.tasks ?? [], id) ?? id,
    scope: { kind: 'task' as const, sessionId: host.sessionId, taskId: id },
  }), [host]);

  const impl = {
    select(id: string) {
      selection.onChange(id);
      setActive(id);
      // A single click looks at a task without keeping its tab; Enter or a double click keeps it.
      requestTaskView(id, 'details');
      api.openTab(tabOf(id), { preview: true });
    },
    open(id: string) {
      selection.onChange(id);
      setActive(id);
      host.openTask(id, 'details');
    },
    openChat(id: string) {
      selection.onChange(id);
      host.openTask(id, 'chat');
    },
    toggleFold(id: string) {
      const node = nodes.get(id);
      const opening = !expanded.has(id);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (opening) next.add(id); else next.delete(id);
        return next;
      });
      if (node?.fold) api.announce(`${opening ? 'Expanded' : 'Folded'} #${node.orderLabel}, ${node.fold.summary}`);
    },
    togglePeek(id: string) { setPinned((prev) => (prev === id ? null : id)); },
    hover: (() => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return (id: string | null) => {
        clearTimeout(timer);
        if (id === null) setHovered(null);
        else timer = setTimeout(() => setHovered(id), PEEK_DELAY_MS);
      };
    })(),
    move(id: string, key: Arrow) {
      const to = neighbour(id, key, nodes, positions);
      if (!to) return;
      setActive(to);
      reveal(to);
      pendingFocus.current = to;
      const face = faceOf(to);
      if (face) { pendingFocus.current = null; face.focus(); }
    },
    menu(id: string, at: MenuAnchor | 'node') { setMenu({ id, at }); },
    closePeek() { setPinned(null); setHovered(null); },
  };
  // Stable forwarders: the nodes are memoized, and a changing actions object would re-render all of them.
  const latest = useRef(impl);
  latest.current = impl;
  const actions = useMemo<NodeActions>(() => ({
    select: (id) => latest.current.select(id),
    open: (id) => latest.current.open(id),
    openChat: (id) => latest.current.openChat(id),
    toggleFold: (id) => latest.current.toggleFold(id),
    togglePeek: (id) => latest.current.togglePeek(id),
    hover: (id) => latest.current.hover(id),
    move: (id, key) => latest.current.move(id, key),
    menu: (id, at) => latest.current.menu(id, at),
    closePeek: () => latest.current.closePeek(),
  }), []);

  const menuNode = menu ? nodes.get(menu.id) : undefined;
  const menuCommands = useMemo(() => (menuNode ? nodeCommands(menuNode, expanded.has(menuNode.id)) : []), [menuNode, expanded]);
  const menuAt = useMemo<MenuAnchor | null>(() => {
    if (!menu) return null;
    if (menu.at !== 'node') return menu.at;
    const rect = faceOf(menu.id)?.getBoundingClientRect();
    return rect ? { x: rect.left + 24, y: rect.bottom - 8 } : { x: 0, y: 0 };
  }, [menu]);

  const closeMenu = (): void => {
    const id = menu?.id;
    setMenu(null);
    if (id) pendingFocus.current = id;
  };

  const pick = (command: NodeCommandId): void => {
    if (!menuNode) return;
    const ref = `#${menuNode.orderLabel}`;
    closeMenu();
    switch (command) {
      case 'message':
        impl.openChat(menuNode.id);
        return;
      case 'stop':
      case 'retry':
      case 'skip':
        void host.handle({ type: 'sendSystemCommand', command: SYSTEM_COMMANDS[command], taskId: menuNode.id });
        api.announce(`${command === 'stop' ? 'Stop' : command === 'retry' ? 'Retry' : 'Skip'} asked for ${ref}`);
        return;
      case 'diff':
        // The diff tab is the Changes slice's; it reads the task from the scope.
        api.openTab({ kind: 'diff', id: menuNode.id, title: `Diff ${ref}`, scope: { kind: 'task', sessionId: host.sessionId, taskId: menuNode.id } });
        return;
      case 'fold':
        impl.toggleFold(menuNode.id);
        return;
    }
  };

  const onFocus = (event: React.FocusEvent): void => {
    const id = (event.target as HTMLElement).closest('.graph-node')?.querySelector<HTMLElement>('[data-task-id]')?.dataset.taskId;
    if (id) setActive(id);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && (pinned || hovered)) { event.stopPropagation(); impl.closePeek(); }
  };

  if (!model.ok) {
    return <p className="plan-graph-note" role="alert">{model.reason}</p>;
  }

  return (
    <div className="plan-graph" onFocus={onFocus} onKeyDown={onKeyDown}>
      <div className="plan-graph-toolbar" role="toolbar" aria-label="Graph controls">
        <IconButton icon={Maximize} label="Fit to screen" onClick={() => void flow.fitView({ ...FIT, duration: motion(200) })} />
        <IconButton icon={Route} label="Critical path" active={showCritical} aria-pressed={showCritical} onClick={() => setShowCritical((v) => !v)} />
        <IconButton icon={MapIcon} label="Minimap" active={minimap} aria-pressed={minimap} onClick={() => setMinimap((v) => !v)} />
        <span className="plan-graph-note">The List is the full equivalent of this graph.</span>
      </div>
      <div className="plan-graph-canvas" ref={canvas}>
        <NodeActionsContext.Provider value={actions}>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={NODE_TYPES}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            disableKeyboardA11y
            deleteKeyCode={null}
            selectionKeyCode={null}
            zoomOnDoubleClick={false}
            minZoom={0.1}
            maxZoom={1.5}
            fitView
            fitViewOptions={FIT}
            onlyRenderVisibleElements={flowNodes.length > VIRTUALIZE_ABOVE}
            proOptions={{ hideAttribution: true }}
            aria-label="Plan graph"
            onPaneClick={() => { impl.closePeek(); setMenu(null); }}
          >
            <Background gap={24} />
            <Controls showInteractive={false} showFitView={false} />
            {minimap && <MiniMap pannable zoomable ariaLabel="Plan graph minimap" />}
          </ReactFlow>
        </NodeActionsContext.Provider>
        {menu && menuAt && menuCommands.length > 0 && menuNode && (
          <NodeMenu commands={menuCommands} at={menuAt} label={`Commands for #${menuNode.orderLabel} ${menuNode.title}`} onPick={pick} onClose={closeMenu} />
        )}
      </div>
      <div className="plan-graph-legend" aria-hidden="true">
        <span><svg viewBox="0 0 28 8"><line x1="0" y1="4" x2="28" y2="4" stroke="var(--ow-status-running)" strokeWidth="3.5" /></svg>Critical path</span>
        <span><svg viewBox="0 0 28 8"><line x1="0" y1="4" x2="28" y2="4" stroke="var(--ow-border-contrast, var(--ow-fg-secondary))" strokeWidth="1.5" /></svg>Dependency</span>
        <span>⟲ n/max Loop round</span>
      </div>
    </div>
  );
}
