import type { Escalation } from '@ordewell/core';
import type { HostState } from '@ordewell/ui';
import type { FrameApi, Unregister } from '../../frame/api';
import { PLANNER_TAB } from '../../frame/layout';
import type { DaemonHost } from '../../session/DaemonHost';
import { showEscalatedTask } from './escalationView';

/** What a task's run is doing, as the attention monitor reads it: work is at work or on its way. */
function isLive(state: HostState): boolean {
  const activity = state.run.activity;
  return state.isExecuting
    || state.plan?.status === 'running'
    || activity?.starting === true
    || activity?.running === true
    || activity?.scheduled === true;
}

function taskOf(escalation: Escalation): string | undefined {
  return escalation.task?.id;
}

function bodyOf(escalation: Escalation): string {
  return escalation.reason;
}

function titleOf(escalation: Escalation): string {
  if (!escalation.task) return 'Needs you';
  return `${escalation.task.ref} ${escalation.task.title} needs you`;
}

/**
 * Keeps the title bar's count, the OS badge and the desktop notifications in
 * step with core's one derived list (ADR-0053). It lives outside React because
 * a wait matters while every pane of the window is closed or on another
 * activity; the list itself is drawn by {@link NeedsYouList}.
 */
export function startAttention(api: FrameApi, host: DaemonHost): Unregister {
  const notify = (): Window['ordewell']['notify'] | undefined => window.ordewell.notify;
  let sessionId = host.sessionId;
  let seen = new Set<string>();
  let baseline = true;
  let live = false;
  let ended = 0;

  const update = (): void => {
    const snapshot = host.getSnapshot();
    const escalations = snapshot.state.run.escalations ?? [];
    api.setNeedsYouCount(escalations.length);
    void notify()?.setBadge(escalations.length);

    if (snapshot.sessionId !== sessionId) {
      sessionId = snapshot.sessionId;
      baseline = true;
      live = isLive(snapshot.state);
    }

    const ids = new Set(escalations.map((e) => e.id));
    if (baseline) {
      // What already waits when a session opens is on screen: no notification for it.
      seen = ids;
      baseline = false;
    } else {
      for (const escalation of escalations) {
        if (seen.has(escalation.id)) continue;
        void notify()?.show({
          id: escalation.id,
          title: titleOf(escalation),
          body: bodyOf(escalation),
          sessionId: snapshot.sessionId,
          ...(taskOf(escalation) !== undefined ? { taskId: taskOf(escalation) } : {}),
        });
      }
      seen = ids;
    }

    const nowLive = isLive(snapshot.state);
    if (live && !nowLive) {
      ended += 1;
      void notify()?.show({
        id: `run-ended:${snapshot.sessionId}:${ended}`,
        title: snapshot.state.plan?.status === 'completed' ? 'Run finished' : 'Run ended',
        body: snapshot.goal ? `${snapshot.goal} is no longer running.` : 'The run is no longer running.',
        sessionId: snapshot.sessionId,
      });
    }
    live = nowLive;
  };

  const offHost = host.subscribe(update);
  const offClick = notify()?.onClick((click) => {
    if (click.taskId) {
      const escalation = (host.getSnapshot().state.run.escalations ?? []).find((item) => item.task?.id === click.taskId);
      showEscalatedTask(host, click.taskId, escalation?.kind);
    } else {
      api.openTab(PLANNER_TAB);
    }
  });
  update();

  return () => {
    offHost();
    offClick?.();
    api.setNeedsYouCount(0);
    void notify()?.setBadge(0);
  };
}
