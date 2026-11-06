import { createContext, memo, useContext, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, Lock, MessageSquare, Telescope, UserCheck, Wrench } from 'lucide-react';
import { ElapsedTime, type TaskSummaryDensity } from '@ordewell/ui';
import { Badge, ChildPlanGlyph, IconButton, LoopGlyph, StatusIndicator, type BadgeTone, type IconComponent } from '@ordewell/ui/design';
import { CardAssignment } from './CardAssignment';
import type { BadgeKind, ElapsedView, FlagKind, GraphNode } from './graphModel';
import { NAV_KEYS, type NavKey } from './graphNav';
import type { Peek } from './peek';

/** What a card can ask of the graph; stable, so a memoized card never re-renders for it. */
export interface CardActions {
  select(id: string): void;
  open(id: string): void;
  openChat(id: string): void;
  toggleFold(id: string): void;
  togglePeek(id: string): void;
  hover(id: string | null): void;
  move(id: string, key: NavKey): void;
  menu(id: string, at: { x: number; y: number } | 'node'): void;
  closePeek(): void;
}

export const CardActionsContext = createContext<CardActions | null>(null);

export interface TaskCardProps {
  node: GraphNode;
  density: TaskSummaryDensity;
  selected: boolean;
  /** The one card in the tab order (roving tabindex): Tab enters the graph once. */
  tabbable: boolean;
  /** A selected card's edges are highlighted, so a card one of them reaches says so too. */
  related: boolean;
  peek: Peek | null;
}

const TRAIT_ICONS: Record<BadgeKind, IconComponent> = {
  'read-only': Lock,
  research: Telescope,
  ops: Wrench,
  hitl: UserCheck,
  delegated: ChildPlanGlyph,
};

/** A flag is about the task's state, so it takes that state's colour; a hold is Blocked's, which no badge tone has. */
const FLAG_TONES: Record<FlagKind, BadgeTone> = {
  approval: 'attention',
  'waits-for-approval': 'attention',
  checkpoint: 'attention',
  'usage-limit': 'attention',
  conflict: 'failed',
  repair: 'failed',
  'merge-gate': 'merge',
  hold: 'neutral',
};

function CardElapsed({ elapsed }: { elapsed: ElapsedView }): JSX.Element {
  return 'since' in elapsed
    ? <ElapsedTime since={elapsed.since} className="graph-card-elapsed" />
    : <span className="graph-card-elapsed" aria-hidden="true">{elapsed.took}</span>;
}

/**
 * Three rows in Comfortable: the status, order and title; who does it; then
 * what kind of task it is and where it stands. Compact keeps the first two,
 * and the face's accessible description carries what the third would say.
 */
function TaskCardView({ node, density, selected, tabbable, related, peek }: TaskCardProps): JSX.Element {
  const actions = useContext(CardActionsContext)!;
  const tab = tabbable ? 0 : -1;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (NAV_KEYS.has(event.key)) {
      event.preventDefault();
      actions.move(node.id, event.key as NavKey);
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
      className="graph-card"
      role="gridcell"
      data-id={node.id}
      data-density={density}
      data-selected={selected}
      data-related={related}
      data-critical={node.critical}
      data-status={node.status.id}
      data-chat={node.row.chatAvailable}
      onMouseEnter={() => actions.hover(node.id)}
      onMouseLeave={() => actions.hover(null)}
      onContextMenu={(event) => { event.preventDefault(); actions.menu(node.id, { x: event.clientX, y: event.clientY }); }}
    >
      <button
        type="button"
        className="graph-card-face"
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
        <span className="graph-card-head">
          <span className="graph-card-shape"><StatusIndicator status={node.status.id} size={14} label={node.statusLine} /></span>
          <span className="graph-card-heading" title={node.title}>
            <span className="graph-card-order">#{node.orderLabel}</span> {node.title}
          </span>
        </span>
        <CardAssignment lane={node.lane} density={density} />
        {density === 'comfortable' && (
          <span className="graph-card-foot">
            {node.badges.map((b) => <Badge key={b.kind} icon={TRAIT_ICONS[b.kind]} data-trait={b.kind} title={b.title}>{b.label}</Badge>)}
            {node.loop && <Badge icon={LoopGlyph} data-loop={node.loop.role} title={node.loop.title}>{node.loop.label}</Badge>}
            {node.flags.map((f) => <Badge key={f.kind} tone={FLAG_TONES[f.kind]} data-flag={f.kind} title={f.title}>{f.label}</Badge>)}
            <span className="graph-card-status-line" title={node.verdictReason ?? node.statusLine}>{node.statusLine}</span>
            {node.elapsed && <CardElapsed elapsed={node.elapsed} />}
          </span>
        )}
      </button>
      {node.row.chatAvailable && (
        <IconButton
          icon={MessageSquare}
          size={14}
          className="graph-card-chat"
          tabIndex={tab}
          label={`Open chat for #${node.orderLabel} ${node.title}`}
          onClick={() => actions.openChat(node.id)}
        />
      )}
      {node.fold && (
        <button
          type="button"
          className="graph-card-fold"
          tabIndex={tab}
          aria-expanded={node.expanded}
          onClick={() => actions.toggleFold(node.id)}
        >
          {node.expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          <span>{node.fold.summary}</span>
        </button>
      )}
      {node.fold && node.expanded && (
        <ul className="graph-card-subtasks" aria-label={`Inside #${node.orderLabel}`}>
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
 * tick elsewhere in a large plan re-renders only the cards it touched.
 */
export const TaskCard = memo(TaskCardView, (a, b) =>
  a.node.viewKey === b.node.viewKey && a.density === b.density && a.selected === b.selected && a.tabbable === b.tabbable
  && a.related === b.related && !!a.peek === !!b.peek && a.peek?.heading === b.peek?.heading
  && a.peek?.lines.join('\n') === b.peek?.lines.join('\n'));
