import { useEffect, useMemo, useSyncExternalStore, type KeyboardEvent } from 'react';
import { GitCommitHorizontal, RotateCcw } from 'lucide-react';
import { Button, EmptyState } from '@ordewell/ui/design';
import type { FrameApi } from '../../frame/api';
import { Notice } from '../sidebarKit';
import { openCommit } from './CommitGraphTab';
import type { Branches } from './gitData';
import { ago, refChips, shortSha } from './gitModel';
import { gitStoreFor } from './gitStore';
import { Chip, Lanes, type LaneGeometry } from './GraphParts';
import { assignLanes } from './lanes';

/*
 * The checkout's history down the sidebar: the full graph's lanes at a
 * narrower scale, a subject and its refs on one row. A commit opens in a tab
 * of its own, so its message and files get the main area's width and the
 * sidebar stays a list. The store keeps the commits and the pick, so a
 * switch of view or repository loses neither and reads nothing twice.
 */

/** One row is the sidebar's row height, so the lanes of rows above and below meet. */
const SIDE_LANES: LaneGeometry = { row: 28, lane: 10, dot: 3 };

/** Up and Down step through the commits, as a list of rows is read with the keyboard; Tab still leaves it. */
function step(event: KeyboardEvent<HTMLUListElement>): void {
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.git-hrow')];
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const to = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : -2;
  if (to === -2 || at < 0) return;
  event.preventDefault();
  rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
}

export function HistoryList({ api, repo, branches }: { api: FrameApi; repo: string; branches: Branches }): JSX.Element {
  const git = gitStoreFor(api);
  const history = useSyncExternalStore(git.subscribe, () => git.getSnapshot().history[repo]);
  const tips = useSyncExternalStore(git.subscribe, () => git.historyTips(repo));
  // Asked for on first showing and whenever a fetch, a switch or a commit moves a branch; the store sends nothing it already has.
  useEffect(() => { void git.loadHistory(repo); }, [git, repo, tips]);

  const commits = useMemo(() => history?.commits ?? [], [history?.commits]);
  const layout = useMemo(() => assignLanes(commits), [commits]);
  const retry = <Button size="sm" icon={RotateCcw} onClick={() => void git.loadHistory(repo)}>Try again</Button>;

  if (!history || (history.status !== 'ready' && commits.length === 0)) {
    return history?.status === 'error'
      ? <div className="git-history-state"><Notice tone="error">{history.error}</Notice>{retry}</div>
      : <EmptyState className="git-state" icon={GitCommitHorizontal} title="Loading the history…" />;
  }
  if (commits.length === 0) return <EmptyState className="git-state" icon={GitCommitHorizontal} title="No commits yet" body="Commit something and its history appears here." />;

  const open = (sha: string, preview: boolean): void => {
    git.selectCommit(repo, sha);
    openCommit(api, repo, sha, preview);
  };

  return (
    <div className="git-history">
      {history.status === 'error' && <div className="git-history-state"><Notice tone="error">{history.error}</Notice>{retry}</div>}
      <ul className="git-hlist" aria-label="History" onKeyDown={step}>
        {commits.map((commit, i) => {
          const short = shortSha(commit.sha);
          const chips = refChips(commit.refs, branches).filter((chip) => chip.kind !== 'head');
          return (
            <li key={commit.sha}>
              <button
                type="button"
                className="git-hrow"
                aria-current={commit.sha === history.selected ? 'true' : undefined}
                aria-label={`Commit ${short}: ${commit.subject}`}
                title={`${commit.subject}\n${short} · ${commit.author} · ${ago(commit.date)}`}
                onClick={() => open(commit.sha, true)}
                onDoubleClick={() => open(commit.sha, false)}
              >
                <Lanes row={layout.rows[i]!} width={layout.width} geometry={SIDE_LANES} />
                <span className="git-hrow-subject">{commit.subject}</span>
                {chips.length > 0 && <span className="git-hrow-refs">{chips.map((chip) => <Chip key={chip.text} chip={chip} />)}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {history.moreError && <Notice tone="error">{history.moreError}</Notice>}
      {history.cursor && (
        <div className="git-more">
          <Button size="sm" busy={history.more} onClick={() => void git.loadMoreHistory(repo)}>Load more</Button>
        </div>
      )}
    </div>
  );
}
