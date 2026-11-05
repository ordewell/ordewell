import type { KeyboardEvent } from 'react';
import { PanelRightClose, PanelRightOpen, Workflow, X } from 'lucide-react';
import { EmptyState, IconButton, PlanGlyph, SectionHeader, StatusIndicator, STATUSES, type StatusId } from '@ordewell/ui/design';
import type { PlanProgress } from './api';
import { formatChord, isMac, parseChord } from './keys';
import { PLAN_GRAPH_TAB, paneSizes } from './layout';
import { useFrameState, useFrameStore } from './store';

/** The rail's counts, most urgent first, so the one that wants the user is nearest the top. */
const RAIL_ORDER: readonly StatusId[] = [
  'needs-you', 'failed', 'stalled', 'running', 'blocked', 'waiting-for-merge', 'not-started', 'passed', 'skipped',
];

function progressStatus(progress: PlanProgress): StatusId {
  if ((progress.counts.running ?? 0) > 0) return 'running';
  return progress.total > 0 && progress.done === progress.total ? 'passed' : 'not-started';
}

function typing(target: EventTarget): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/**
 * The plan beside the planner's conversation (design.md, Plan panel): its
 * header carries the progress, the way to the graph and the collapse, its body
 * the list a view module registers for the 'plan' region. Docked at the right,
 * or a drawer from the rail while the window is too narrow to dock it.
 */
export function PlanPanel({ drawer = false }: { drawer?: boolean }): JSX.Element {
  const store = useFrameStore();
  const { layout, panels, planProgress, commands } = useFrameState();
  const views = panels.filter((panel) => panel.region === 'plan');
  const keys = commands.find((command) => command.id === 'planGraph.open')?.keys;
  const graphHint = keys ? ` (${formatChord(parseChord(keys), isMac(store.platform))})` : '';
  const openGraph = (): void => store.api.openTab(PLAN_GRAPH_TAB);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key.toLowerCase() !== 'g' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || typing(event.target)) return;
    event.preventDefault();
    openGraph();
  };

  const progress = planProgress && planProgress.total > 0 && (
    <span className="frame-plan-progress" aria-label={`${planProgress.done} of ${planProgress.total} done`}>
      <StatusIndicator status={progressStatus(planProgress)} size={12} />
      <span aria-hidden="true">{planProgress.done}/{planProgress.total}</span>
    </span>
  );

  return (
    <aside
      className={['frame-plan', drawer ? 'frame-drawer frame-drawer-right' : ''].filter(Boolean).join(' ')}
      aria-label="Plan"
      data-region="plan"
      data-filter={drawer ? layout.planFilter : undefined}
      style={{ width: paneSizes(layout).plan }}
      onKeyDown={onKeyDown}
    >
      <SectionHeader
        className="frame-pane-head frame-plan-head"
        icon={PlanGlyph}
        title="Plan"
        level={2}
        actions={(
          <>
            {progress}
            <IconButton icon={Workflow} label="Open the plan graph" title={`Open the plan graph (G)${graphHint}`} onClick={openGraph} />
            {drawer
              ? <IconButton icon={X} label="Close the plan" onClick={() => store.dispatch({ type: 'closeDrawer' })} />
              : <IconButton icon={PanelRightClose} label="Collapse the plan panel" onClick={() => store.dispatch({ type: 'togglePlan', open: false })} />}
          </>
        )}
      />
      <div className="frame-plan-body">
        {views.length === 0
          ? <EmptyState icon={PlanGlyph} title="No plan yet." body="Describe a goal to the planner." />
          : views.map((view) => <div key={view.id} className="frame-plan-view">{view.render()}</div>)}
      </div>
    </aside>
  );
}

/**
 * The plan panel folded to 44 px: the way back, and a count per status that
 * opens the plan over the centre showing those tasks (Collapse order).
 */
export function PlanRail(): JSX.Element {
  const store = useFrameStore();
  const { layout, planProgress } = useFrameState();
  const counts = planProgress?.counts ?? {};
  const open = layout.drawer === 'plan';
  return (
    <aside className="frame-plan-rail" aria-label="Plan, collapsed" data-region="plan">
      <IconButton
        icon={PlanGlyph}
        label="Show the plan"
        active={open && !layout.planFilter}
        aria-expanded={open}
        onClick={() => store.dispatch(open && !layout.planFilter ? { type: 'closeDrawer' } : { type: 'drawer', drawer: 'plan' })}
      />
      {RAIL_ORDER.filter((status) => (counts[status] ?? 0) > 0).map((status) => {
        const label = `${counts[status]} ${STATUSES[status].label.toLowerCase()}`;
        const selected = open && layout.planFilter === status;
        return (
          <button
            key={status}
            type="button"
            className={['frame-rail-count', selected ? 'frame-rail-count-active' : ''].filter(Boolean).join(' ')}
            aria-label={label}
            aria-pressed={selected}
            title={label}
            data-status={status}
            onClick={() => store.dispatch(selected ? { type: 'closeDrawer' } : { type: 'drawer', drawer: 'plan', filter: status })}
          >
            <StatusIndicator status={status} size={12} />
            <span aria-hidden="true">{counts[status]}</span>
          </button>
        );
      })}
      <IconButton
        className="frame-rail-expand"
        icon={PanelRightOpen}
        label="Expand the plan panel"
        onClick={() => store.dispatch({ type: 'togglePlan', open: true })}
      />
    </aside>
  );
}
