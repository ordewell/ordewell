import { useCallback, useSyncExternalStore } from 'react';
import type { SurfaceTask } from '@ordewell/core';
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
  /** The last reveal asked for; a new serial scrolls the list to its card even when the task was already selected. */
  reveal: Reveal | null;
  listeners: Set<() => void>;
}

export interface Reveal {
  taskId: string;
  serial: number;
}

const entries = new WeakMap<DaemonHost, Entry>();

function entryOf(host: DaemonHost): Entry {
  let entry = entries.get(host);
  if (!entry) {
    entry = { taskId: null, reveal: null, listeners: new Set() };
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

function contains(task: SurfaceTask, id: string): boolean {
  return task.id === id || task.subtasks.some((sub) => contains(sub, id));
}

/**
 * Select a task and ask the plan list to scroll its card into view. The list
 * opens top-level cards only, so a subtask reveals the task that holds it.
 */
export function revealTask(host: DaemonHost, taskId: string): string {
  const tasks = host.getSnapshot().state.plan?.tasks ?? [];
  const owner = tasks.find((task) => contains(task, taskId))?.id ?? taskId;
  const entry = entryOf(host);
  entry.taskId = owner;
  entry.reveal = { taskId: owner, serial: (entry.reveal?.serial ?? 0) + 1 };
  for (const listener of [...entry.listeners]) listener();
  return owner;
}

function useEntry<T>(host: DaemonHost, read: (entry: Entry) => T): T {
  const entry = entryOf(host);
  const subscribe = useCallback((listener: () => void) => {
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [entry]);
  return useSyncExternalStore(subscribe, () => read(entry));
}

/** The plan list has scrolled to this reveal, so a list that mounts later does not scroll to it again. */
export function settleReveal(host: DaemonHost, serial: number): void {
  const entry = entryOf(host);
  if (entry.reveal?.serial !== serial) return;
  entry.reveal = null;
  for (const listener of [...entry.listeners]) listener();
}

/** The reveal the plan list has yet to scroll to, if any. */
export function useRevealRequest(host: DaemonHost): Reveal | null {
  return useEntry(host, (entry) => entry.reveal);
}

/** The selection and its setter, in the shape ui's chat takes it. */
export function useTaskSelection(host: DaemonHost): TaskSelection {
  const taskId = useEntry(host, (entry) => entry.taskId);
  const onChange = useCallback((next: string | null) => selectTask(host, next), [host]);
  // Opening a task's chat selects it too, so the list and the graph show the tab's task (design W4).
  const onOpen = useCallback((id: string, view: 'chat', options?: { preview?: boolean }) => {
    selectTask(host, id);
    host.openTask(id, view, options);
  }, [host]);
  return { taskId, onChange, onOpen };
}
