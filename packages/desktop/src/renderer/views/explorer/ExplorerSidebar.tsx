import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject } from 'react';
import { ChevronDown, ChevronRight, File as FileIcon, FileSearch, Folder, FolderOpen, FolderGit2, FolderX, Link2, Lock, RefreshCw, Search, SquareArrowOutUpRight, TextSearch } from 'lucide-react';
import { Badge, Button, EmptyState, Icon, IconButton } from '@ordewell/ui/design';
import { describeError, filesApi, FilesError, type FindMatch, type ReadTarget, type TreeEntry } from '../../files/api';
import type { FrameApi, Unregister, ViewScope } from '../../frame/api';
import { all } from '../Stub';
import { openRun } from '../git/gitActions';
import { scopeName, type ScopeSession } from '../scope/scopeStore';
import { useScope } from '../scope/useScope';
import { openFile } from './fileTabs';
import { revealLabel } from './shellLabels';
import { flatten, isExpandable, windowOf, type Row } from './treeModel';
import { useTree } from './useTree';
import './explorer.css';

/** A list row is 28 (design.md, Design tokens); the tree's windowing and its CSS share it. */
const ROW_HEIGHT = 28;
/** Before the pane has a measured height (and in a test with no layout), draw this much. */
const FALLBACK_VIEWPORT = 480;

/** A request from quick open (Mod+P) to put the cursor in the search box, from outside the sidebar. */
let focusWanted = false;
const focusListeners = new Set<() => void>();
function requestSearchFocus(): void {
  focusWanted = true;
  for (const listener of focusListeners) listener();
}

/** The header's refresh button lives in the section header, outside the tree it reloads. */
const reloadListeners = new Set<() => void>();

const STATUS_WORDS: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', '?': 'Untracked', U: 'Conflicted' };

function taskLabel(session: ScopeSession | undefined, taskId: string): string {
  const task = session?.tasks.find((t) => t.id === taskId);
  return task ? `Task #${task.order}: ${task.title}` : `Task ${taskId}`;
}

function taskChip(session: ScopeSession | undefined, taskId: string): string {
  const task = session?.tasks.find((t) => t.id === taskId);
  return task ? `#${task.order}` : 'task';
}

function EntryIcon({ entry, expanded }: { entry: TreeEntry; expanded: boolean }): JSX.Element {
  if (entry.kind === 'directory') return <Icon icon={expanded ? FolderOpen : Folder} size={16} />;
  if (entry.kind === 'repository') return <Icon icon={FolderGit2} size={16} />;
  if (entry.kind === 'symlink') return <Icon icon={Link2} size={16} />;
  return <Icon icon={FileIcon} size={16} />;
}

interface TreeProps {
  api: FrameApi;
  target: ReadTarget;
  session: ScopeSession | undefined;
  onGone(message: string): void;
  /** Bumped by the header's refresh button. */
  reloadKey: number;
}

function Tree({ api, target, session, onGone, reloadKey }: TreeProps): JSX.Element {
  const scopeId = `${target.repo}|${JSON.stringify(target.scope)}`;
  const tree = useTree(target, scopeId, onGone);
  const rows = useMemo(() => flatten(tree.dirs, tree.expanded), [tree.dirs, tree.expanded]);
  const { reload } = tree;
  useEffect(() => { if (reloadKey > 0) reload(); }, [reloadKey, reload]);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  const [focused, setFocused] = useState(0);
  const checkout = target.scope.kind === 'checkout';
  const hasTree = !(rows.length === 1 && rows[0]?.type === 'note' && rows[0].depth === 0);

  // Another scope starts at its top: the row focused in the last one may not exist in this one.
  useEffect(() => setFocused(0), [scopeId]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // A scroller drawn again after a loading state starts at the top; the window kept from the old one would draw no rows.
    setScrollTop(el.scrollTop);
    const measure = (): void => setViewport(el.clientHeight || FALLBACK_VIEWPORT);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // The scroller is not drawn while a root state stands in for it.
  }, [hasTree]);

  const { start, end } = windowOf(rows.length, scrollTop, viewport, ROW_HEIGHT);
  const rootNote = rows.length === 1 && rows[0]?.type === 'note' && rows[0].depth === 0 ? rows[0] : undefined;

  const reveal = (index: number): void => {
    const el = scroller.current;
    if (!el) return;
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + viewport) el.scrollTop = top + ROW_HEIGHT - viewport;
    setScrollTop(el.scrollTop);
  };
  const focusRow = (index: number): void => {
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setFocused(next);
    reveal(next);
    requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus());
  };

  const activate = (entry: TreeEntry, keep: boolean): void => {
    if (isExpandable(entry)) { tree.toggle(entry.path); return; }
    if (entry.kind === 'file') openFile(api, target.repo, entry.path, target.scope, { preview: !keep });
  };

  const onKey = (event: KeyboardEvent): void => {
    const row = rows[focused];
    const entry = row?.type === 'entry' ? row.entry : undefined;
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); focusRow(focused + 1); break;
      case 'ArrowUp': event.preventDefault(); focusRow(focused - 1); break;
      case 'Home': event.preventDefault(); focusRow(0); break;
      case 'End': event.preventDefault(); focusRow(rows.length - 1); break;
      case 'ArrowRight':
        if (entry && isExpandable(entry)) { event.preventDefault(); if (row?.type === 'entry' && row.expanded) focusRow(focused + 1); else tree.expand(entry.path); }
        break;
      case 'ArrowLeft':
        if (entry && row?.type === 'entry') {
          event.preventDefault();
          if (isExpandable(entry) && row.expanded) tree.collapse(entry.path);
          else {
            const parentDepth = row.depth - 1;
            for (let i = focused - 1; i >= 0 && parentDepth >= 0; i--) {
              const above = rows[i];
              if (above?.type === 'entry' && above.depth === parentDepth) { focusRow(i); break; }
            }
          }
        }
        break;
      case 'Enter': case ' ': if (entry) { event.preventDefault(); activate(entry, true); } break;
      default:
    }
  };

  // A scope's task shows on its card in the plan list, its session opened first when another is.
  const openTask = (taskId: string): void => {
    if (session) void openRun(api, { sessionId: session.sessionId, taskId });
  };

  if (rootNote?.tone === 'empty') return <EmptyState className="ex-state" icon={Folder} title="This folder is empty" />;
  if (rootNote?.tone === 'error') {
    return <EmptyState className="ex-state" icon={FolderX} title="The files could not be read" body={rootNote.text} action={<Button size="sm" icon={RefreshCw} onClick={reload}>Try again</Button>} />;
  }
  if (rootNote?.tone === 'loading') return <Skeleton />;

  return (
    <div
      ref={scroller}
      className="ex-tree"
      role="tree"
      aria-label={`Files in ${scopeName(target.scope, session)}`}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={onKey}
    >
      <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
        {rows.slice(start, end).map((row, offset) => {
          const index = start + offset;
          return (
            <TreeRow
              key={row.type === 'entry' ? row.entry.path : row.key}
              row={row}
              index={index}
              total={rows.length}
              focused={index === focused}
              checkout={checkout}
              platform={api.platform}
              session={session}
              onFocus={() => setFocused(index)}
              onActivate={activate}
              onTask={openTask}
              onReveal={(entry) => void shellAction(api, 'reveal', target.repo, entry.path)}
              onEditor={(entry) => void shellAction(api, 'openInEditor', target.repo, entry.path)}
            />
          );
        })}
      </div>
    </div>
  );
}

async function shellAction(api: FrameApi, action: 'reveal' | 'openInEditor', repo: string, path: string): Promise<void> {
  const result = await window.ordewell.shell[action]({ repo, path });
  if (!result.ok) api.announce(result.message ?? 'That did not work.');
}

interface RowProps {
  row: Row;
  index: number;
  total: number;
  focused: boolean;
  checkout: boolean;
  platform: string;
  session: ScopeSession | undefined;
  onFocus(): void;
  onActivate(entry: TreeEntry, keep: boolean): void;
  onTask(taskId: string): void;
  onReveal(entry: TreeEntry): void;
  onEditor(entry: TreeEntry): void;
}

/**
 * Every part but the name is a fixed box in a flex row, so the name is the one
 * thing that shrinks and nothing can be drawn under an icon (design.md, Layout
 * rules that prevent overlap).
 */
function TreeRow({ row, index, total, focused, checkout, platform, session, onFocus, onActivate, onTask, onReveal, onEditor }: RowProps): JSX.Element {
  const top = index * ROW_HEIGHT;
  const guides = Array.from({ length: row.depth }, (_, level) => <span key={level} className="ex-guide" aria-hidden="true" />);
  if (row.type === 'note') {
    return (
      <div className={`ex-note ex-note-${row.tone}`} role="none" style={{ top, height: ROW_HEIGHT }}>
        {guides}
        <span className="ex-chevron" aria-hidden="true" />
        <span className="ex-note-text" title={row.text}>{row.text}</span>
      </div>
    );
  }
  const { entry } = row;
  const expandable = isExpandable(entry);
  const status = entry.status === '?' ? 'untracked' : entry.status;
  return (
    <div
      role="treeitem"
      data-index={index}
      aria-level={row.depth + 1}
      aria-posinset={index + 1}
      aria-setsize={total}
      aria-expanded={expandable ? row.expanded : undefined}
      aria-label={entry.name}
      tabIndex={focused ? 0 : -1}
      className={`ex-row${entry.ignored ? ' ex-ignored' : ''}${entry.kind === 'repository' || entry.kind === 'symlink' ? ' ex-inert' : ''}`}
      style={{ top, height: ROW_HEIGHT }}
      title={entry.ignored ? `${entry.path} (ignored by git)` : entry.path}
      onFocus={onFocus}
      onClick={() => onActivate(entry, false)}
      onDoubleClick={() => { if (!expandable) onActivate(entry, true); }}
    >
      {guides}
      <span className="ex-chevron" aria-hidden="true">{expandable && <Icon icon={row.expanded ? ChevronDown : ChevronRight} size={12} />}</span>
      <EntryIcon entry={entry} expanded={row.expanded} />
      <span className="ex-name">{entry.name}</span>
      {/* One cell, two occupants: the task and status letter at rest, the actions on hover or focus.
          Sharing the cell keeps the name's room the same either way, so nothing shifts or overlaps. */}
      <span className="ex-trail">
        <span className="ex-marks">
          {entry.taskId && (
            <button
              type="button"
              className="ex-task"
              tabIndex={-1}
              title={`Changed by ${taskLabel(session, entry.taskId)}`}
              aria-label={`Changed by ${taskLabel(session, entry.taskId)}. Open the task`}
              onClick={(event) => { event.stopPropagation(); onTask(entry.taskId as string); }}
            >
              {taskChip(session, entry.taskId)}
            </button>
          )}
          {entry.status && (
            <span className={`ex-badge ex-badge-${status}`} title={STATUS_WORDS[entry.status]} aria-label={STATUS_WORDS[entry.status]}>
              {entry.status === '?' ? 'U' : entry.status}
            </span>
          )}
        </span>
        {checkout && entry.kind !== 'symlink' && (
          <span className="ex-actions">
            <button type="button" tabIndex={-1} title={revealLabel(platform)} aria-label={`${revealLabel(platform)}: ${entry.name}`} onClick={(event) => { event.stopPropagation(); onReveal(entry); }}>
              <Icon icon={FolderOpen} size={14} />
            </button>
            {entry.kind === 'file' && (
              <button type="button" tabIndex={-1} title="Open in editor" aria-label={`Open in editor: ${entry.name}`} onClick={(event) => { event.stopPropagation(); onEditor(entry); }}>
                <Icon icon={SquareArrowOutUpRight} size={14} />
              </button>
            )}
          </span>
        )}
      </span>
    </div>
  );
}

/** Rows with their final height, so the tree that replaces them moves nothing (checklist S1). */
function Skeleton(): JSX.Element {
  return (
    <div className="ex-skeleton" role="status" aria-label="Loading files" aria-busy="true">
      {[62, 44, 70, 38, 54, 48].map((width, index) => (
        <div key={index} className="ex-skeleton-row" style={{ height: ROW_HEIGHT }}>
          <span className="ex-skeleton-icon" />
          <span className="ex-skeleton-bar" style={{ width: `${width}%` }} />
        </div>
      ))}
    </div>
  );
}

type SearchMode = 'name' | 'text';

interface ResultsProps {
  api: FrameApi;
  target: ReadTarget;
  query: string;
  mode: SearchMode;
  onError(error: unknown): void;
  /** The search box's keys, handled here because the list knows which result is chosen. */
  keys: MutableRefObject<((event: KeyboardEvent) => void) | undefined>;
}

function Results({ api, target, query, mode, onError, keys }: ResultsProps): JSX.Element {
  const [matches, setMatches] = useState<FindMatch[]>();
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [chosen, setChosen] = useState(0);
  const scopeId = JSON.stringify([target.repo, target.scope]);

  useEffect(() => {
    let live = true;
    setFailed(undefined);
    // Typing is debounced: each keystroke would otherwise walk the tree.
    const timer = setTimeout(() => {
      filesApi.find(target, query, { text: mode === 'text', limit: 100 }).then(
        (found) => { if (live) { setMatches(found.matches); setTruncated(found.truncated); setChosen(0); } },
        (error: unknown) => { if (live) { setFailed(describeError(error)); setMatches([]); onError(error); } },
      );
    }, 200);
    return () => { live = false; clearTimeout(timer); };
    // `target` is rebuilt every render; its identity is the repo and scope.
  }, [scopeId, query, mode]);

  const open = (match: FindMatch, keep: boolean): void => openFile(api, target.repo, match.path, target.scope, { preview: !keep, ...(match.line !== undefined ? { line: match.line } : {}) });

  keys.current = (event) => {
    const count = matches?.length ?? 0;
    if (!count) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setChosen((n) => Math.min(count - 1, n + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setChosen((n) => Math.max(0, n - 1)); }
    else if (event.key === 'Enter' && matches?.[chosen]) { event.preventDefault(); open(matches[chosen] as FindMatch, true); }
  };
  useEffect(() => () => { keys.current = undefined; }, [keys]);

  if (failed) return <EmptyState className="ex-state" icon={FileSearch} title="The search could not run" body={failed} />;
  if (!matches) return <Skeleton />;
  if (matches.length === 0) return <EmptyState className="ex-state" icon={FileSearch} title={mode === 'text' ? 'No line matches' : 'No file matches'} />;
  return (
    <ul className="ex-results" aria-label="Search results">
      {matches.map((match, index) => (
        <li key={`${match.path}:${match.line ?? ''}`}>
          <button
            type="button"
            className={index === chosen ? 'ex-result ex-result-chosen' : 'ex-result'}
            onClick={() => open(match, false)}
            onDoubleClick={() => open(match, true)}
          >
            <span className="ex-result-path" title={match.path}>
              <span className="ex-result-name">{match.path}</span>
              {match.line !== undefined && <span className="ex-result-line">:{match.line}</span>}
            </span>
            {match.preview && <span className="ex-result-preview">{match.preview}</span>}
          </button>
        </li>
      ))}
      {truncated && <li className="ex-more">Showing the first {matches.length}. Narrow the search.</li>}
    </ul>
  );
}

function ExplorerTree({ api }: { api: FrameApi }): JSX.Element {
  const { store, state } = useScope(api);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('name');
  const [reloadKey, setReloadKey] = useState(0);
  const resultKeys = useRef<((event: KeyboardEvent) => void) | undefined>();
  const scope: ViewScope = store.scopeOf();
  const target: ReadTarget = { workspace: api.workspace, repo: state.repo, scope };
  const readOnly = scope.kind !== 'checkout';
  const multi = state.repos.length > 1;

  useEffect(() => {
    const reload = (): void => { void store.refresh(); setReloadKey((n) => n + 1); };
    reloadListeners.add(reload);
    return () => { reloadListeners.delete(reload); };
  }, [store]);

  useEffect(() => {
    const focus = (): void => {
      if (!focusWanted) return;
      focusWanted = false;
      input.current?.focus();
      input.current?.select();
    };
    focusListeners.add(focus);
    focus();
    return () => { focusListeners.delete(focus); };
  }, []);

  const onSearchError = (error: unknown): void => {
    if (error instanceof FilesError && error.code === 'gone') store.fallBack(state.repo, describeError(error));
  };

  return (
    <div className="ex">
      <div className="ex-scope" title={readOnly ? `${scopeName(scope, state.session)} is read-only` : 'Your checkout'}>
        <span className="ex-scope-name">{scopeName(scope, state.session)}</span>
        {readOnly && <Badge icon={Lock}>Read-only</Badge>}
      </div>
      {multi && (
        <select className="ow-select ex-repo frame-input" aria-label="Repository" value={state.repo} onChange={(event) => store.setRepo(event.target.value)}>
          {state.repos.map((r) => <option key={r.repo} value={r.repo}>{r.repo === '.' ? 'Workspace' : r.repo}{r.branch ? ` (${r.branch})` : ''}</option>)}
        </select>
      )}
      {state.notice && (
        <div className="ex-notice" role="status">
          <span className="ex-notice-text">{state.notice}</span>
          <Button size="sm" variant="ghost" onClick={() => store.dismissNotice()}>Dismiss</Button>
        </div>
      )}
      <div className="ex-search">
        <Icon icon={Search} size={16} />
        <input
          ref={input}
          type="search"
          className="frame-input"
          placeholder={mode === 'text' ? 'Search in files' : 'Go to file'}
          aria-label={mode === 'text' ? 'Search text in files' : 'Search file names'}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); else resultKeys.current?.(event); }}
        />
        <IconButton
          icon={TextSearch}
          label="Search the text of files"
          active={mode === 'text'}
          aria-pressed={mode === 'text'}
          onClick={() => setMode(mode === 'text' ? 'name' : 'text')}
        />
      </div>
      {query.trim()
        ? <Results api={api} target={target} query={query.trim()} mode={mode} onError={onSearchError} keys={resultKeys} />
        : <Tree api={api} target={target} session={state.session} onGone={(message) => store.fallBack(state.repo, message)} reloadKey={reloadKey} />}
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  return all(
    api.registerSidebar({
      activity: 'explorer',
      id: 'files',
      title: 'Files',
      actions: () => <IconButton icon={RefreshCw} label="Refresh the tree" onClick={() => { for (const reload of reloadListeners) reload(); }} />,
      render: () => <ExplorerTree api={api} />,
    }),
    api.registerCommand({
      id: 'explorer.quickOpen',
      title: 'Go to file',
      keys: 'Mod+P',
      run: () => { api.showActivity('explorer'); requestSearchFocus(); },
    }),
  );
}
