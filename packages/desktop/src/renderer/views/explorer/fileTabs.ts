import type { FrameApi, OpenTabOptions, ViewScope } from '../../frame/api';
import { tabKey } from '../../frame/layout';
import { hasDraft, withDirtyMark } from './drafts';
import { scopeStoreFor, type ScopeSession } from '../scope/scopeStore';

/**
 * How a file becomes a tab, shared by everything that opens one (the Explorer,
 * quick open, and the Changes and Git slices): the same file in two scopes is
 * two tabs (the frame keys a tab by kind, scope and id), and a file in a
 * second repository carries its repo in the id.
 */

const SEPARATOR = '//';

export function fileTabId(repo: string, path: string): string {
  return repo === '.' ? path : `${repo}${SEPARATOR}${path}`;
}

/** The inverse of {@link fileTabId}. A path never holds `//`, so the first one splits. */
export function parseFileTabId(id: string): { repo: string; path: string } {
  const at = id.indexOf(SEPARATOR);
  return at < 0 ? { repo: '.', path: id } : { repo: id.slice(0, at), path: id.slice(at + SEPARATOR.length) };
}

/** What a tab title adds after the file name to say where it is read from; empty for the checkout. */
export function scopeTag(scope: ViewScope, session: ScopeSession | undefined): string {
  switch (scope.kind) {
    case 'checkout': return '';
    case 'integration': return 'Integration';
    case 'task': {
      const task = session?.tasks.find((t) => t.id === scope.taskId);
      return task ? `Task #${task.order}` : 'Task';
    }
  }
}

export function fileTabTitle(path: string, scope: ViewScope, session: ScopeSession | undefined): string {
  const name = path.slice(path.lastIndexOf('/') + 1) || path;
  const tag = scopeTag(scope, session);
  return tag ? `${name} (${tag})` : name;
}

/** Lines to reveal in a file tab that is about to open or is open already. */
const pendingLines = new Map<string, number>();
const lineListeners = new Set<(key: string) => void>();

export function requestLine(tabKey: string, line: number): void {
  pendingLines.set(tabKey, line);
  for (const listener of lineListeners) listener(tabKey);
}

export function takeLine(tabKey: string): number | undefined {
  const line = pendingLines.get(tabKey);
  pendingLines.delete(tabKey);
  return line;
}

export function onLineRequest(listener: (key: string) => void): () => void {
  lineListeners.add(listener);
  return () => { lineListeners.delete(listener); };
}

export interface OpenFileOptions extends OpenTabOptions {
  line?: number;
}

/** Opens a file of `repo` in `scope`; a single click passes `preview`, a double click keeps it. */
export function openFile(api: FrameApi, repo: string, path: string, scope: ViewScope, options: OpenFileOptions = {}): void {
  const { line, ...tabOptions } = options;
  const session = scopeStoreFor(api).getSnapshot().session;
  const plain = { kind: 'file', id: fileTabId(repo, path), title: fileTabTitle(path, scope, session), scope };
  // A tab closed with unsaved edits reopens with them (drafts.ts), so it reopens marked.
  const ref = { ...plain, title: withDirtyMark(plain.title, hasDraft(tabKey(plain))) };
  if (line !== undefined) requestLine(tabKey(ref), line);
  api.openTab(ref, tabOptions);
}
