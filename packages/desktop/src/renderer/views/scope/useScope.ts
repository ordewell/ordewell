import { useEffect, useSyncExternalStore } from 'react';
import type { FrameApi } from '../../frame/api';
import { useDaemonStatus } from '../../useDaemonStatus';
import { scopeStoreFor, type ScopeState, type ScopeStore } from './scopeStore';

/** The window's scope state, re-read once the daemon is connected. */
export function useScope(api: FrameApi): { store: ScopeStore; state: ScopeState } {
  const store = scopeStoreFor(api);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const connected = useDaemonStatus()?.state === 'connected';
  useEffect(() => { if (connected) void store.refresh(); }, [store, connected]);
  return { store, state };
}
