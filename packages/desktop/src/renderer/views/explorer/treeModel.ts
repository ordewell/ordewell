import type { TreeEntry } from '../../files/api';

/** One directory as the tree holds it: its entries once read, and whether a read is out or failed. */
export interface DirState {
  entries?: TreeEntry[];
  loading: boolean;
  error?: string;
}

export type Row =
  | { type: 'entry'; entry: TreeEntry; depth: number; expanded: boolean }
  | { type: 'note'; key: string; depth: number; text: string; tone: 'loading' | 'error' | 'empty' };

export function isExpandable(entry: TreeEntry): boolean {
  return entry.kind === 'directory';
}

/** A repository is a folder to the eye, as the workspace folder's view lists it beside the plain ones. */
function isFolder(entry: TreeEntry): boolean {
  return entry.kind === 'directory' || entry.kind === 'repository';
}

/** Folders first, then names, so a tree reads the same whatever order the daemon listed. */
export function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  return entries.slice().sort((a, b) => {
    const folders = Number(isFolder(b)) - Number(isFolder(a));
    return folders || a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

/**
 * The tree as the flat list it is drawn from. Flat because a long tree is
 * windowed (only the rows in view are drawn), and a window needs rows
 * addressed by position, not nested.
 */
export function flatten(dirs: ReadonlyMap<string, DirState>, expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (dir: string, depth: number): void => {
    const state = dirs.get(dir);
    if (!state || (state.loading && !state.entries)) {
      rows.push({ type: 'note', key: `${dir}\0loading`, depth, text: 'Loading…', tone: 'loading' });
      return;
    }
    if (state.error && !state.entries) {
      rows.push({ type: 'note', key: `${dir}\0error`, depth, text: state.error, tone: 'error' });
      return;
    }
    const entries = state.entries ?? [];
    if (entries.length === 0) {
      rows.push({ type: 'note', key: `${dir}\0empty`, depth, text: 'Empty', tone: 'empty' });
      return;
    }
    for (const entry of entries) {
      const open = isExpandable(entry) && expanded.has(entry.path);
      rows.push({ type: 'entry', entry, depth, expanded: open });
      if (open) walk(entry.path, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}

/** The slice of rows to draw for a scroll position, with the space above and below that stands in for the rest. */
export function windowOf(total: number, scrollTop: number, viewport: number, rowHeight: number, overscan = 8): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return { start, end };
}

export function parentOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}
