import { useCallback, useEffect, useRef } from 'react';
import { Workflow } from 'lucide-react';
import { taskStatusKind, walkPlan } from '@ordewell/core/plan-utils';
import { statusOf, type StatusId } from '@ordewell/ui/design';
import type { FrameApi, PlanProgress, Unregister } from '../../frame/api';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { primaryAction, RUN_ACTION_LABEL, runActions, type RunAction } from '../../session/primaryAction';
import { PlanGraph } from '../graph/PlanGraph';
import { all } from '../Stub';
import { PlanList } from './PlanList';

/**
 * The plan graph, opened from the plan panel's header as a centre tab beside
 * the planner. Design slice 10 owns the graph itself.
 */
export function PlanGraphTab({ host, api }: { host: DaemonHost; api: FrameApi }): JSX.Element {
  const banner = useRef<Unregister | null>(null);
  useEffect(() => () => banner.current?.(), []);

  // A dependency loop has no layers to draw: say so; the plan panel's list still shows it (design W5).
  const cannotDraw = useCallback((reason: string) => {
    banner.current?.();
    banner.current = api.showBanner({ id: 'plan.graph.cycle', tone: 'warning', title: 'The graph cannot draw this plan', body: reason });
  }, [api]);

  return (
    <div className="session-plan">
      <PlanGraph host={host} api={api} onCannotDraw={cannotDraw} />
    </div>
  );
}

const DONE: ReadonlySet<StatusId> = new Set(['passed', 'skipped', 'waiting-for-merge']);

/** The plan panel's progress and its rail's counts, from the run's live status where a task has one. */
export function planProgress(host: DaemonHost): PlanProgress | undefined {
  const { plan, run } = host.getSnapshot().state;
  const tasks = plan?.tasks ?? [];
  if (tasks.length === 0) return undefined;
  const live = new Map([...walkPlan(run.tasks)].map((p) => [p.task.id, p.task]));
  const counts: Partial<Record<StatusId, number>> = {};
  let total = 0;
  let done = 0;
  for (const { task } of walkPlan(tasks)) {
    const status = statusOf(taskStatusKind(live.get(task.id) ?? task)).id;
    counts[status] = (counts[status] ?? 0) + 1;
    total += 1;
    if (DONE.has(status)) done += 1;
  }
  return { done, total, counts };
}

/** Keeps the plan panel's header and rail, and the Sessions item's live dot, on the session. */
function followProgress(api: FrameApi, host: DaemonHost): Unregister {
  let shown = '';
  let live = false;
  const sync = (): void => {
    const progress = planProgress(host);
    const key = JSON.stringify(progress ?? null);
    if (key !== shown) { shown = key; api.setPlanProgress(progress); }
    const executing = host.getSnapshot().state.isExecuting;
    if (executing !== live) {
      live = executing;
      api.setActivityBadge('sessions', executing ? { dot: true, label: 'a run is live' } : undefined);
    }
  };
  sync();
  return all(host.subscribe(sync), () => { api.setPlanProgress(undefined); api.setActivityBadge('sessions', undefined); });
}

/** Each run action as the plan dock's button posts it, so the host asks and answers exactly as it does for the dock. */
function perform(host: DaemonHost, action: RunAction): void {
  switch (action) {
    case 'approve':
    case 'run':
      void host.handle({ type: 'sendSystemCommand', command: 'executePlan' });
      return;
    case 'stop':
      void host.handle({ type: 'sendSystemCommand', command: 'stopExecution' });
      return;
    case 'merge':
      // Review & Merge all: the review step, where the Changes view is there to show it; it merges otherwise.
      void host.handle({ type: 'isolationAction', action: host.reviewing ? 'reviewDiff' : 'merge' });
      return;
  }
}

const COMMAND_IDS: Record<RunAction, string> = {
  approve: 'plan.approve',
  run: 'plan.run',
  stop: 'plan.stop',
  merge: 'plan.mergeAll',
};

/**
 * The title bar's one action follows the session (Approve plan, Run, Stop,
 * Merge all, first that applies), and each other run action the session
 * offers is in the ⋯ menu. Followed here rather than in the tab, so the
 * button is right whichever tab is in front.
 */
function followRunActions(api: FrameApi, host: DaemonHost): Unregister {
  let shown: RunAction | undefined;
  let shownDisabled = false;
  const sync = (): void => {
    const next = primaryAction(runActions(host.getSnapshot().state));
    const disabled = host.getSnapshot().readOnly;
    if (next === shown && disabled === shownDisabled) return;
    shown = next;
    shownDisabled = disabled;
    api.setPrimaryAction(next ? { label: RUN_ACTION_LABEL[next], disabled, run: () => perform(host, next) } : undefined);
  };
  sync();
  const offSession = host.subscribe(sync);
  const commands = (Object.keys(COMMAND_IDS) as RunAction[]).map((action) => api.registerCommand({
    id: COMMAND_IDS[action],
    title: action === 'run' ? 'Run plan' : action === 'stop' ? 'Stop run' : RUN_ACTION_LABEL[action],
    more: true,
    enabled: () => {
      if (api.readOnly || host.getSnapshot().readOnly) return false;
      const offered = runActions(host.getSnapshot().state);
      return offered.has(action) && primaryAction(offered) !== action;
    },
    run: () => perform(host, action),
  }));
  const discard = api.registerCommand({
    id: 'plan.discardRun',
    title: 'Discard run',
    more: true,
    enabled: () => {
      if (api.readOnly || host.getSnapshot().readOnly) return false;
      const { run, isExecuting } = host.getSnapshot().state;
      return run.handoff !== null && !isExecuting;
    },
    run: () => { void host.handle({ type: 'isolationAction', action: 'discard' }); },
  });
  return all(offSession, ...commands, discard, () => api.setPrimaryAction(undefined));
}

export function register(api: FrameApi): Unregister {
  const host = daemonHost(api.workspace);
  return all(
    api.registerTabKind({ kind: 'plan-graph', icon: Workflow, render: () => <PlanGraphTab host={host} api={api} /> }),
    api.registerPanel({ region: 'plan', id: 'plan', title: 'Plan', render: () => <PlanList host={host} /> }),
    followProgress(api, host),
    followRunActions(api, host),
  );
}
