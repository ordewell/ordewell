import { useSyncExternalStore } from 'react';

export type TaskView = 'details' | 'chat' | 'changes';

/** One ask to show a task's tab on a view; `seq` makes a repeat of the same ask land again on a tab already open. */
export interface TaskViewRequest {
  view: TaskView;
  seq: number;
}

const requests = new Map<string, TaskViewRequest>();
const listeners = new Set<() => void>();
let seq = 0;

/**
 * Ask the task's tab to show a view. The frame's openTab carries only the
 * tab's ref, and an open tab's "Open chat" must still switch it, so the ask
 * is kept here for the tab to read.
 */
export function requestTaskView(taskId: string, view: TaskView): void {
  seq += 1;
  requests.set(taskId, { view, seq });
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTaskViewRequest(taskId: string): TaskViewRequest | undefined {
  return useSyncExternalStore(subscribe, () => requests.get(taskId));
}

/** Tests start from no asks. */
export function resetTaskViews(): void {
  requests.clear();
}
