import { useCallback, useSyncExternalStore } from 'react';
import type { TaskSelection } from '@ordewell/ui';
import type { DaemonHost } from './DaemonHost';

/**
 * The task the Plan tab has selected, one per session. The List's open card
 * and the Graph's selected node are this one value, so a click in either shows
 * in the other and a view switch keeps it (design W5). Keyed by the host, so a
 * session's selection dies with it.
 */
interface Entry {
  taskId: string | null;
  listeners: Set<() => void>;
}

const entries = new WeakMap<DaemonHost, Entry>();

function entryOf(host: DaemonHost): Entry {
  let entry = entries.get(host);
  if (!entry) {
    entry = { taskId: null, listeners: new Set() };
    entries.set(host, entry);
  }
  return entry;
}

export function selectedTask(host: DaemonHost): string | null {
  return entryOf(host).taskId;
}

export function selectTask(host: DaemonHost, taskId: string | null): void {
  const entry = entryOf(host);
  if (entry.taskId === taskId) return;
  entry.taskId = taskId;
  for (const listener of [...entry.listeners]) listener();
}

/** The selection and its setter, in the shape ui's chat takes it. */
export function useTaskSelection(host: DaemonHost): TaskSelection {
  const entry = entryOf(host);
  const subscribe = useCallback((listener: () => void) => {
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [entry]);
  const taskId = useSyncExternalStore(subscribe, () => entry.taskId);
  const onChange = useCallback((next: string | null) => selectTask(host, next), [host]);
  return { taskId, onChange };
}
