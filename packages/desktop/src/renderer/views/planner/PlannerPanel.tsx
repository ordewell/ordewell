import type { FocusEvent } from 'react';
import type { FrameApi, Unregister } from '../../frame/api';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { ChatSurface } from '../../session/useSession';

/**
 * Mod+L focuses a region's first focusable element in document order, and the
 * chat's composer sits below its conversation: this stand-in is first, and
 * hands the focus on to the composer.
 */
function toComposer(event: FocusEvent<HTMLDivElement>): void {
  if (event.target !== event.currentTarget) return;
  event.currentTarget.querySelector<HTMLTextAreaElement>('textarea')?.focus();
}

/** The planner conversation on the right (W2): ui's chat, without the plan, over the session's host. */
function PlannerPanel({ host }: { host: DaemonHost }): JSX.Element {
  return (
    <div className="session-planner" data-autofocus tabIndex={-1} onFocus={toComposer}>
      <ChatSurface host={host} layout="conversation" />
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  const host = daemonHost(api.workspace);
  return api.registerPanel({ region: 'right', id: 'planner', title: 'Planner', render: () => <PlannerPanel host={host} /> });
}
