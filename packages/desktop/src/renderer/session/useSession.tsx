import { useMemo, useSyncExternalStore } from 'react';
import { ChatApp, ChatBridgeContext, type ChatLayout } from '@ordewell/ui';
import type { DaemonHost, SessionSnapshotView } from './DaemonHost';
import { useTaskSelection } from './selection';

export function useSession(host: DaemonHost): SessionSnapshotView {
  return useSyncExternalStore(host.subscribe, host.getSnapshot);
}

/**
 * One of ui's chat instances over the session's host: the planner's
 * conversation, or the plan's cards alone. Each is its own React tree with its
 * own bridge, as two webviews would be, and both fold the same messages.
 */
export function ChatSurface({ host, layout }: { host: DaemonHost; layout: Exclude<ChatLayout, 'chat'> }): JSX.Element {
  const bridge = useMemo(() => host.port(layout), [host, layout]);
  // Only the plan's list shares its open card; the planner's chat has none to share.
  const selection = useTaskSelection(host);
  const goal = useSyncExternalStore(host.subscribe, () => host.getSnapshot().goal);
  return (
    <ChatBridgeContext.Provider value={bridge}>
      <ChatApp layout={layout} selection={layout === 'plan' ? selection : undefined} goal={layout === 'plan' ? goal : undefined} />
    </ChatBridgeContext.Provider>
  );
}
