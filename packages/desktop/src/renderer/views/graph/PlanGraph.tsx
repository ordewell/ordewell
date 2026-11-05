import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { ChevronLeft, ChevronRight, Route } from 'lucide-react';
import type { TaskSummaryDensity } from '@ordewell/ui';
import { IconButton, STATUSES, StatusIndicator } from '@ordewell/ui/design';
import type { FrameApi } from '../../frame/api';
import type { DaemonHost } from '../../session/DaemonHost';
import { useTaskSelection } from '../../session/selection';
import { useSession } from '../../session/useSession';
import { routeEdges, type Box, type RouteColumn } from './edgeRoutes';
import { buildGraph, graphTasks, type GraphNode } from './graphModel';
import { navigate, stageAt, stagesInView, stepStage, type NavKey } from './graphNav';
import { memoStageLayout, stageSummary } from './layout';
import { NodeMenu, type MenuAnchor } from './NodeMenu';
import { nodeCommands, type NodeCommandId } from './nodeCommands';
import { peekOf } from './peek';
import { CardActionsContext, TaskCard, type CardActions } from './TaskCard';

const PEEK_DELAY_MS = 350;
/** One Shift+wheel gesture steps one stage: the events that follow it within this window are its own momentum. */
const WHEEL_STEP_MS = 250;
const SYSTEM_COMMANDS = { stop: 'cancel', retry: 'retry', skip: 'skip' } as const;

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface PlanGraphProps {
  host: DaemonHost;
  api: FrameApi;
  /** The plan has a dependency loop, so no stages exist: the tab falls back to the List and says why. */
  onCannotDraw(reason: string): void;
}

type MenuState =
  | { kind: 'commands'; id: string; at: MenuAnchor | 'node' }
  /** ← or → from a task with several dependencies or dependents: which one to follow is the user's to say. */
  | { kind: 'choose'; id: string; at: 'node'; ids: string[]; toward: 'dependencies' | 'dependents' };

/** Where the cards and columns landed, in the canvas's own coordinates, which scrolling does not change. */
interface Geometry {
  cards: Map<string, Box>;
  columns: RouteColumn[];
  key: string;
}

const NO_GEOMETRY: Geometry = { cards: new Map(), columns: [], key: '' };

/**
 * The plan as stage columns (design W5). Placement is `stageLayout`'s and the
 * edges are `routeEdges`', both pure; this component measures where the
 * browser put the cards and draws the edges between them. The structure is not
 * editable here, so every control is a command on a task, run through the same
 * host messages the List's buttons post.
 */
export function PlanGraph({ host, api, onCannotDraw }: PlanGraphProps): JSX.Element {
  const { state } = useSession(host);
  const selection = useTaskSelection(host);
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [showCritical, setShowCritical] = useState(true);
  const [density, setDensity] = useState<TaskSummaryDensity>('comfortable');
  const [active, setActive] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [geometry, setGeometry] = useState<Geometry>(NO_GEOMETRY);
  const [view, setView] = useState({ left: 0, width: 0, max: 0 });

  const executing = state.isExecuting || state.activity.advancesOnItsOwn;
  const handoffPending = !!state.run.handoff || (state.run.runMerge?.landed.length ?? 0) > 0;
  const drawCritical = executing && showCritical;
  const tasks = useMemo(() => graphTasks(state.plan, state.run), [state.plan, state.run]);
  const model = useMemo(() => buildGraph(tasks, {
    expanded, executing: drawCritical, handoffPending, modesByRunner: state.modesByRunner,
  }), [tasks, expanded, drawCritical, handoffPending, state.modesByRunner]);

  const placeStages = useMemo(memoStageLayout, []);
  const layout = useMemo(() => placeStages(model.ok ? model.layoutKey : '', model.ok ? model.nodes : []), [model, placeStages]);
  const nodes = useMemo(() => new Map<string, GraphNode>(model.ok ? model.nodes.map((n) => [n.id, n]) : []), [model]);
  const edges = model.ok ? model.edges : [];

  const reason = model.ok ? null : model.reason;
  useEffect(() => { if (reason) onCannotDraw(reason); }, [reason, onCannotDraw]);

  const selectedId = selection.taskId && nodes.has(selection.taskId) ? selection.taskId : null;
  const firstId = model.ok ? model.nodes[0]?.id ?? null : null;
  const tabbableId = (active && nodes.has(active) ? active : null) ?? selectedId ?? firstId;
  const peekId = pinned ?? hovered;
  const peekOutput = peekId ? state.taskOutput[peekId] : undefined;
  const related = useMemo(() => {
    const node = selectedId ? nodes.get(selectedId) : undefined;
    return new Set(node ? [...node.dependsOn, ...node.dependents] : []);
  }, [selectedId, nodes]);

  // --- Geometry: measured, never assumed, so a card's real height (a long title, an open fold) routes its edges.
  const measure = useCallback(() => {
    const root = canvas.current;
    if (!root) return;
    const origin = root.getBoundingClientRect();
    const boxOf = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height };
    };
    const cards = new Map<string, Box>();
    root.querySelectorAll<HTMLElement>('.graph-card[data-id]').forEach((el) => cards.set(el.dataset.id!, boxOf(el)));
    const columns: RouteColumn[] = [];
    root.querySelectorAll<HTMLElement>('.graph-column').forEach((el, i) => {
      const box = boxOf(el);
      columns.push({ left: box.x, right: box.x + box.width, ids: layout.columns[i] ?? [] });
    });
    const round = (n: number): number => Math.round(n * 2) / 2;
    const key = JSON.stringify([
      [...cards].map(([id, b]) => [id, round(b.x), round(b.y), round(b.width), round(b.height)]),
      columns.map((c) => [round(c.left), round(c.right), c.ids.length]),
    ]);
    setGeometry((prev) => (prev.key === key ? prev : { cards, columns, key }));
  }, [layout]);

  const readView = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const next = { left: el.scrollLeft, width: el.clientWidth, max: Math.max(0, el.scrollWidth - el.clientWidth) };
    setView((prev) => (prev.left === next.left && prev.width === next.width && prev.max === next.max ? prev : next));
  }, []);

  useLayoutEffect(() => {
    measure();
    readView();
    if (typeof ResizeObserver !== 'function') return undefined;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { measure(); readView(); });
    });
    if (scroller.current) observer.observe(scroller.current);
    canvas.current?.querySelectorAll('.graph-card').forEach((el) => observer.observe(el));
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [measure, readView, density, model]);

  const stops = useMemo(() => {
    const first = geometry.columns[0]?.left ?? 0;
    return geometry.columns.map((c) => c.left - first);
  }, [geometry]);

  const scrollToLeft = (left: number): void => {
    scroller.current?.scrollTo({ left: Math.max(0, Math.min(left, view.max)), behavior: reducedMotion() ? 'auto' : 'smooth' });
  };
  const step = (direction: 1 | -1): void => {
    const el = scroller.current;
    if (el) scrollToLeft(stepStage(el.scrollLeft, stops, direction, Math.max(0, el.scrollWidth - el.clientWidth)));
  };
  const stepRef = useRef(step);
  stepRef.current = step;

  // A mouse wheel's notch is not a stage wide, so Shift+wheel steps whole stages itself; a trackpad's sideways swipe is left to the snap.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    let last = 0;
    const onWheel = (event: WheelEvent): void => {
      if (!event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      const now = event.timeStamp;
      if (now - last < WHEEL_STEP_MS) { last = now; return; }
      last = now;
      stepRef.current(event.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [model.ok]);

  const onScroll = (): void => { readView(); };

  // --- Focus and reveal.
  const faceOf = (id: string): HTMLElement | null => canvas.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`) ?? null;
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const face = faceOf(id);
    if (face) { pendingFocus.current = null; face.focus({ preventScroll: true }); }
  });

  /** Brings a card into view on a stage edge: the browser's own scrolling would leave it between stops. */
  const reveal = (id: string): void => {
    const el = scroller.current;
    const box = geometry.cards.get(id);
    const at = layout.at.get(id);
    const column = at ? geometry.columns[at.column] : undefined;
    if (!el || !box || !at || !column) return;
    const origin = geometry.columns[0]?.left ?? 0;
    let left = el.scrollLeft;
    if (column.left - origin < el.scrollLeft) left = stops[at.column] ?? left;
    else if (column.right > el.scrollLeft + el.clientWidth) left = stops.find((s) => column.right <= s + el.clientWidth) ?? stops[at.column] ?? left;
    const header = canvas.current?.querySelector<HTMLElement>('.graph-column-head')?.offsetHeight ?? 0;
    let top = el.scrollTop;
    if (box.y - header < el.scrollTop) top = Math.max(0, box.y - header - 8);
    else if (box.y + box.height > el.scrollTop + el.clientHeight) top = box.y + box.height - el.clientHeight + 8;
    if (left !== el.scrollLeft || top !== el.scrollTop) el.scrollTo({ left, top, behavior: reducedMotion() ? 'auto' : 'smooth' });
  };

  const focusCard = (to: string): void => {
    setActive(to);
    reveal(to);
    pendingFocus.current = to;
    const face = faceOf(to);
    if (face) { pendingFocus.current = null; face.focus({ preventScroll: true }); }
  };

  // One hover peek's timer, kept across renders: one closed over a render's own actions was never the one a leave cleared.
  const peekTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(peekTimer.current), []);

  const impl = {
    // A click, a double click or Enter shows the task in the plan list; only Open chat opens a tab.
    select(id: string) {
      setActive(id);
      host.revealTask(id);
    },
    open(id: string) {
      setActive(id);
      host.revealTask(id);
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
    hover(id: string | null) {
      clearTimeout(peekTimer.current);
      if (id === null) setHovered(null);
      else peekTimer.current = setTimeout(() => setHovered(id), PEEK_DELAY_MS);
    },
    move(id: string, key: NavKey) {
      const node = nodes.get(id);
      const to = navigate(id, key, nodes, layout);
      if (!to || !node) return;
      if (to.kind === 'go') focusCard(to.id);
      else setMenu({ kind: 'choose', id, at: 'node', ids: to.ids, toward: key === 'ArrowLeft' ? 'dependencies' : 'dependents' });
    },
    menu(id: string, at: MenuAnchor | 'node') { setMenu({ kind: 'commands', id, at }); },
    closePeek() { setPinned(null); setHovered(null); },
  };
  // Stable forwarders: the cards are memoized, and a changing actions object would re-render all of them.
  const latest = useRef(impl);
  latest.current = impl;
  const actions = useMemo<CardActions>(() => ({
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

  // --- Menus: a task's commands, or the choice of which dependency or dependent to move to.
  const menuNode = menu ? nodes.get(menu.id) : undefined;
  const menuCommands = useMemo<readonly { id: string; label: string }[]>(() => {
    if (!menu || !menuNode) return [];
    if (menu.kind === 'commands') return nodeCommands(menuNode, expanded.has(menuNode.id));
    return menu.ids.map((id) => {
      const n = nodes.get(id);
      return { id, label: n ? `#${n.orderLabel} ${n.title}` : id };
    });
  }, [menu, menuNode, expanded, nodes]);
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

  const pick = (command: string): void => {
    if (!menu || !menuNode) return;
    if (menu.kind === 'choose') {
      setMenu(null);
      focusCard(command);
      return;
    }
    const ref = `#${menuNode.orderLabel}`;
    closeMenu();
    switch (command as NodeCommandId) {
      case 'message':
        impl.openChat(menuNode.id);
        return;
      case 'stop':
      case 'retry':
      case 'skip': {
        const id = command as 'stop' | 'retry' | 'skip';
        void host.handle({ type: 'sendSystemCommand', command: SYSTEM_COMMANDS[id], taskId: menuNode.id });
        api.announce(`${id === 'stop' ? 'Stop' : id === 'retry' ? 'Retry' : 'Skip'} asked for ${ref}`);
        return;
      }
      case 'diff':
        // A diff tab is one file's: the task's whole change is its tab's Changes view.
        selection.onChange(menuNode.id);
        host.openTask(menuNode.id, 'changes');
        return;
      case 'fold':
        impl.toggleFold(menuNode.id);
        return;
    }
  };

  const onFocus = (event: React.FocusEvent): void => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('.graph-card')?.dataset.id;
    if (id) setActive(id);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && (pinned || hovered)) { event.stopPropagation(); impl.closePeek(); }
  };
  const onBackgroundClick = (event: MouseEvent): void => {
    if ((event.target as HTMLElement).closest('.graph-card')) return;
    impl.closePeek();
    setMenu(null);
  };

  // --- What is drawn. Memoized apart from the scroll position, so scrolling redraws only the strip.
  const columnsView = useMemo(() => layout.columns.map((ids, i) => (
    <div key={i} className="graph-column" role="row" aria-label={`Stage ${i + 1}`} data-density={density}>
      <div className="graph-column-head" aria-hidden="true">Stage {i + 1}</div>
      {ids.map((id) => {
        const node = nodes.get(id)!;
        return (
          <TaskCard
            key={id}
            node={node}
            density={density}
            selected={id === selectedId}
            tabbable={id === tabbableId}
            related={related.has(id)}
            peek={id === peekId ? peekOf(node, peekOutput) : null}
          />
        );
      })}
    </div>
  )), [layout, nodes, density, selectedId, tabbableId, related, peekId, peekOutput]);

  const edgesView = useMemo(() => {
    const paths = routeEdges(geometry.cards, geometry.columns, edges);
    const tone = (source: string, target: string): 'related' | 'faint' | undefined => {
      if (!selectedId) return undefined;
      return source === selectedId || target === selectedId ? 'related' : 'faint';
    };
    const drawn = edges.flatMap((edge) => {
      const d = paths.get(edge.id);
      if (!d) return [];
      const t = tone(edge.source, edge.target);
      const critical = edge.critical && drawCritical;
      const marker = t === 'related' ? 'related' : critical ? 'critical' : 'base';
      // Highlighted edges draw last, so a faint one never crosses over them.
      return [{ edge, d, t, critical, marker, rank: t === 'related' ? 2 : critical ? 1 : 0 }];
    }).sort((a, b) => a.rank - b.rank);
    return (
      <svg className="graph-edges" aria-hidden="true">
        <defs>
          {(['base', 'critical', 'related'] as const).map((m) => (
            <marker key={m} id={`graph-arrow-${m}`} className={`graph-arrow graph-arrow--${m}`} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" />
            </marker>
          ))}
        </defs>
        {drawn.map(({ edge, d, t, critical, marker }) => (
          <path
            key={edge.id}
            className="graph-edge"
            d={d}
            data-state={edge.state}
            data-tone={t}
            data-critical={critical || undefined}
            markerEnd={`url(#graph-arrow-${marker})`}
          />
        ))}
      </svg>
    );
  }, [geometry, edges, selectedId, drawCritical]);

  if (!model.ok) {
    return <p className="plan-graph-note" role="alert">{model.reason}</p>;
  }

  const inView = stagesInView(
    geometry.columns.map((c) => ({ left: c.left - (geometry.columns[0]?.left ?? 0), right: c.right - (geometry.columns[0]?.left ?? 0) })),
    view.left,
    view.width,
  );
  const current = stageAt(view.left, stops);
  const canBack = view.left > 2;
  const canForward = stepStage(view.left, stops, 1, view.max) > view.left + 2;

  return (
    <div className="plan-graph" onFocus={onFocus} onKeyDown={onKeyDown}>
      <div className="plan-graph-strip" role="toolbar" aria-label="Graph controls">
        <IconButton icon={ChevronLeft} label="Previous stage" disabled={!canBack} onClick={() => step(-1)} />
        <div className="graph-stage-chips">
          {layout.columns.map((ids, i) => {
            const summary = stageSummary(ids.map((id) => nodes.get(id)!.status.id));
            const shown = !!inView && i >= inView.first && i <= inView.last;
            return (
              <button
                key={i}
                type="button"
                className="graph-stage-chip"
                data-in-view={shown || undefined}
                data-view-start={(shown && i === inView.first) || undefined}
                data-view-end={(shown && i === inView.last) || undefined}
                aria-current={i === current ? 'location' : undefined}
                aria-label={`Stage ${i + 1}, ${STATUSES[summary.status].label.toLowerCase()}, ${summary.done} of ${summary.total} done`}
                onClick={() => scrollToLeft(stops[i] ?? 0)}
              >
                <span>Stage {i + 1}</span>
                <StatusIndicator status={summary.status} size={12} />
                <span className="graph-stage-count">{summary.done}/{summary.total}</span>
              </button>
            );
          })}
        </div>
        <IconButton icon={ChevronRight} label="Next stage" disabled={!canForward} onClick={() => step(1)} />
        <span className="graph-strip-spacer" />
        <IconButton icon={Route} label="Critical path" active={showCritical} aria-pressed={showCritical} onClick={() => setShowCritical((v) => !v)} />
        <div className="graph-density" role="group" aria-label="Density">
          {(['comfortable', 'compact'] as const).map((d) => (
            <button key={d} type="button" aria-pressed={density === d} onClick={() => setDensity(d)}>
              {d === 'comfortable' ? 'Comfortable' : 'Compact'}
            </button>
          ))}
        </div>
      </div>
      <div className="plan-graph-scroller" ref={scroller} role="grid" aria-label="Plan graph" onScroll={onScroll} onClick={onBackgroundClick}>
        <div className="plan-graph-canvas" ref={canvas} data-density={density}>
          {edgesView}
          <CardActionsContext.Provider value={actions}>
            {columnsView}
          </CardActionsContext.Provider>
        </div>
      </div>
      {menu && menuAt && menuCommands.length > 0 && menuNode && (
        <NodeMenu
          commands={menuCommands}
          at={menuAt}
          label={menu.kind === 'commands'
            ? `Commands for #${menuNode.orderLabel} ${menuNode.title}`
            : `${menu.toward === 'dependencies' ? 'Dependencies' : 'Dependents'} of #${menuNode.orderLabel}`}
          onPick={pick}
          onClose={closeMenu}
        />
      )}
      <div className="plan-graph-legend">
        <span aria-hidden="true"><svg viewBox="0 0 28 8"><line x1="0" y1="4" x2="28" y2="4" className="graph-legend-related" /></svg>Edges of the selected task</span>
        <span aria-hidden="true"><svg viewBox="0 0 28 8"><line x1="0" y1="4" x2="28" y2="4" className="graph-legend-critical" /></svg>Critical path</span>
        <span aria-hidden="true">⟲ n/max Loop rounds on the check</span>
        <span className="plan-graph-note">The List is the full equivalent of this graph.</span>
      </div>
    </div>
  );
}
