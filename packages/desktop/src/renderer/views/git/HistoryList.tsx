import { useEffect, useLayoutEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react';
import { GitCommitHorizontal, RotateCcw } from 'lucide-react';
import { Button, EmptyState } from '@ordewell/ui/design';
import type { FrameApi } from '../../frame/api';
import { Notice } from '../sidebarKit';
import { openCommit } from './CommitGraphTab';
import type { Branches } from './gitData';
import { ago, refChips, shortSha, summarizeRefs } from './gitModel';
import { gitStoreFor, historyKey } from './gitStore';
import { Chip, Lanes, type LaneGeometry } from './GraphParts';
import { assignLanes } from './lanes';

/*
 * A history down the sidebar, the checkout's or a browsed branch's: the full
 * graph's lanes at a narrower scale beside two lines, the subject over its
 * refs, short sha, author and age. A commit opens in a tab of its own, so its
 * message and files get the main area's width and the sidebar stays a list.
 * The store keeps the commits and the pick per repository and ref, so a
 * switch of view, branch or repository loses neither and reads nothing twice.
 */

/**
 * One row is the sidebar's two-line row (--ow-row-double), so the lanes of rows
 * above and below meet. Past six lanes the step narrows, so more of a busy
 * history fits in the third of the row the lanes may take.
 */
function sideLanes(width: number): LaneGeometry {
  return { row: 44, lane: width > 6 ? 8 : 10, dot: 3 };
}

/**
 * Whether the lanes are drawn cut off by their third of the row. Measured, since
 * it depends on the sidebar's width; an unmeasured (zero-width) lane is no cut.
 */
function useLanesClipped(list: RefObject<HTMLUListElement>, key: unknown): boolean {
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return undefined;
    const measure = (): void => {
      const svg = el.querySelector<SVGSVGElement>('.git-lanes');
      const drawn = svg?.getBoundingClientRect().width ?? 0;
      setClipped(drawn > 0 && drawn < Number(svg?.getAttribute('width')) - 0.5);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [list, key]);
  return clipped;
}

/** Up and Down step through the commits, as a list of rows is read with the keyboard; Tab still leaves it. */
function step(event: KeyboardEvent<HTMLUListElement>): void {
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.git-hrow')];
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const to = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : -2;
  if (to === -2 || at < 0) return;
  event.preventDefault();
  rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
}

/** `at` is the branch browsed, or undefined for the checkout's own history. */
export function HistoryList({ api, repo, at: ref, branches }: { api: FrameApi; repo: string; at: string | undefined; branches: Branches }): JSX.Element {
  const git = gitStoreFor(api);
  const history = useSyncExternalStore(git.subscribe, () => git.getSnapshot().history[historyKey(repo, ref)]);
  const tips = useSyncExternalStore(git.subscribe, () => git.historyTips(repo));
  // Asked for on first showing and whenever a fetch, a switch or a commit moves a branch; the store sends nothing it already has.
  useEffect(() => { void git.loadHistory(repo, ref); }, [git, repo, ref, tips]);

  const commits = useMemo(() => history?.commits ?? [], [history?.commits]);
  const layout = useMemo(() => assignLanes(commits), [commits]);
  const list = useRef<HTMLUListElement>(null);
  const clippedId = useId();
  const geometry = sideLanes(layout.width);
  const clipped = useLanesClipped(list, layout);
  const retry = <Button size="sm" icon={RotateCcw} onClick={() => void git.loadHistory(repo, ref)}>Try again</Button>;

  if (!history || (history.status !== 'ready' && commits.length === 0)) {
    return history?.status === 'error'
      ? <div className="git-history-state"><Notice tone="error">{history.error}</Notice>{retry}</div>
      : <EmptyState className="git-state" icon={GitCommitHorizontal} title="Loading the history…" />;
  }
  if (commits.length === 0) return <EmptyState className="git-state" icon={GitCommitHorizontal} title="No commits yet" />;

  const open = (sha: string, preview: boolean): void => {
    git.selectCommit(repo, ref, sha);
    openCommit(api, repo, sha, preview);
  };

  return (
    <div className="git-history">
      {history.status === 'error' && <div className="git-history-state"><Notice tone="error">{history.error}</Notice>{retry}</div>}
      <ul
        ref={list}
        className={`git-hlist${clipped ? ' git-hlist-clipped' : ''}`}
        aria-label={ref ? `History of ${ref}` : 'History'}
        aria-describedby={clipped ? clippedId : undefined}
        onKeyDown={step}
      >
        {commits.map((commit, i) => {
          const short = shortSha(commit.sha);
          const { lead, more, names } = summarizeRefs(refChips(commit.refs, branches));
          const when = ago(commit.date);
          // Age first: the line ends in an ellipsis, so what it cuts is the sha, which the tooltip has whole.
          const meta = [when, commit.author, short].filter(Boolean).join(' · ');
          const spoken = [commit.author && `by ${commit.author}`, when && (when === 'now' ? 'just now' : `${when} ago`), names.length > 0 && `refs ${names.join(', ')}`].filter(Boolean).join(', ');
          return (
            <li key={commit.sha}>
              <button
                type="button"
                className="git-hrow"
                aria-current={commit.sha === history.selected ? 'true' : undefined}
                aria-label={`Commit ${short}: ${commit.subject}${spoken ? `, ${spoken}` : ''}`}
                title={`${commit.subject}\n${[commit.sha, commit.author, when].filter(Boolean).join(' · ')}${names.length > 0 ? `\n${names.join(', ')}` : ''}`}
                onClick={() => open(commit.sha, true)}
                onDoubleClick={() => open(commit.sha, false)}
              >
                <Lanes row={layout.rows[i]!} width={layout.width} geometry={geometry} />
                <span className="git-hrow-text">
                  <span className="git-hrow-subject">{commit.subject}</span>
                  <span className="git-hrow-meta">
                    {lead && (
                      <span className="git-hrow-refs">
                        <Chip chip={lead} tracked={lead.tracked} />
                        {more > 0 && <span className="git-chip git-chip-more">+{more}</span>}
                      </span>
                    )}
                    <span className="git-hrow-info">{meta}</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {clipped && <span id={clippedId} className="visually-hidden">The graph is wider than the sidebar shows: its further lanes are cut off.</span>}
      {history.moreError && <Notice tone="error">{history.moreError}</Notice>}
      {history.cursor && (
        <div className="git-more">
          {/* Its cursor is the last read's: while a read again replaces it, or after that read failed, a page from it could not be trusted. */}
          <Button size="sm" busy={history.more} disabled={history.rereading || history.status !== 'ready'} onClick={() => void git.loadMoreHistory(repo, ref)}>Load more</Button>
        </div>
      )}
    </div>
  );
}
