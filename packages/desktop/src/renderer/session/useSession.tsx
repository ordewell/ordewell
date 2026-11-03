import { useMemo, useSyncExternalStore } from 'react';
import { ChatApp, ChatBridgeContext, type ChatLayout } from '@ordewell/ui';
import type { DaemonHost, SessionSnapshotView } from './DaemonHost';

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
  return (
    <ChatBridgeContext.Provider value={bridge}>
      <ChatApp layout={layout} />
    </ChatBridgeContext.Provider>
  );
}
