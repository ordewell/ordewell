import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { List, Network } from 'lucide-react';
import { IconButton, PlanGlyph } from '@ordewell/ui/design';
import type { FrameApi, Unregister } from '../../frame/api';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { primaryAction, RUN_ACTION_LABEL, runActions, type RunAction } from '../../session/primaryAction';
import { PlanGraph } from '../graph/PlanGraph';
import { all } from '../Stub';
import { PlanList } from './PlanList';

/**
 * The pinned Plan tab, with its List and Graph views. Design slice 8 owns this
 * file and the list; slice 10 owns the graph it switches to.
 */
export function PlanTab({ host, api }: { host: DaemonHost; api: FrameApi }): JSX.Element {
  const [view, setView] = useState<'list' | 'graph'>('list');
  const banner = useRef<Unregister | null>(null);
  useEffect(() => () => banner.current?.(), []);

  // A dependency loop has no layers to draw: say so and show the List, which can still show it (design W5).
  const cannotDraw = useCallback((reason: string) => {
    setView('list');
    banner.current?.();
    banner.current = api.showBanner({ id: 'plan.graph.cycle', tone: 'warning', title: 'The graph cannot draw this plan', body: reason });
  }, [api]);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key.toLowerCase() !== 'v' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    setView((v) => (v === 'list' ? 'graph' : 'list'));
  };

  return (
    <div className="session-plan" onKeyDown={onKeyDown}>
      <div className="frame-toolbar" role="group" aria-label="Plan view">
        <IconButton icon={List} label="List" active={view === 'list'} aria-pressed={view === 'list'} onClick={() => setView('list')} />
        <IconButton icon={Network} label="Graph" active={view === 'graph'} aria-pressed={view === 'graph'} onClick={() => setView('graph')} />
      </div>
      {view === 'list' ? <PlanList host={host} /> : <PlanGraph host={host} api={api} onCannotDraw={cannotDraw} />}
    </div>
  );
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
 * button is right with the Plan tab closed or behind another.
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
      if (host.getSnapshot().readOnly) return false;
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
      if (host.getSnapshot().readOnly) return false;
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
    api.registerTabKind({ kind: 'plan', icon: PlanGlyph, render: () => <PlanTab host={host} api={api} /> }),
    followRunActions(api, host),
  );
}
