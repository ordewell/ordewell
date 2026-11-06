import { useSyncExternalStore } from 'react';
import type { LineComment } from './changesModel';

/*
 * The line comments sent from a diff, kept for the window's life so a diff
 * tab closed and opened again still shows what was said on it. The daemon
 * keeps the message itself in the task's log; this only remembers where on
 * the diff it was written.
 */

export interface SentComment {
  id: number;
  comment: LineComment;
  /** Who it went to: the task, or the planner's composer when the task had finished. */
  to: 'task' | 'planner';
  /** "task #3", or "the planner". */
  recipient: string;
}

const EMPTY: readonly SentComment[] = [];
const byFile = new Map<string, readonly SentComment[]>();
const listeners = new Set<() => void>();
let nextId = 1;

/** One file in one scope: the same file seen in a task and in the run carries different comments. */
export function commentsKey(scopeKey: string, repo: string, path: string): string {
  return `${scopeKey}\0${repo}\0${path}`;
}

export function addComment(key: string, sent: Omit<SentComment, 'id'>): void {
  byFile.set(key, [...(byFile.get(key) ?? EMPTY), { ...sent, id: nextId++ }]);
  for (const listener of listeners) listener();
}

export function commentsOn(key: string): readonly SentComment[] {
  return byFile.get(key) ?? EMPTY;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useComments(key: string): readonly SentComment[] {
  return useSyncExternalStore(subscribe, () => commentsOn(key));
}

/** For a test: every comment forgotten. */
export function clearComments(): void {
  byFile.clear();
  for (const listener of listeners) listener();
}
