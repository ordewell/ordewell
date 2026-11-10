import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { GitCommitHorizontal, RefreshCw, X } from 'lucide-react';
import { Button, EmptyState, IconButton } from '@ordewell/ui/design';
import type { FrameApi, Tab, Unregister } from '../../frame/api';
import { messageOf } from '../../session/daemon';
import { all } from '../Stub';
import { MiddleText, Notice } from '../sidebarKit';
import { openRun } from './gitActions';
import { readBranches, readCommit, readLog, type Branches, type CommitDetail, type CommitSummary } from './gitData';
import { ago, commitDiffTabId, commitWhen, commitTabId, landedTaskOf, parseCommitTabId, parseCommitsTabId, refChips, shortSha, type LandedTask } from './gitModel';
import { gitStoreFor, ownersOf, type RunInfo } from './gitStore';
import { Chip, Lanes } from './GraphParts';
import { assignLanes } from './lanes';
import './git.css';

/*
 * The history of one repository as lanes (design W12, ADR-0062): paged from
 * the daemon, ref labels from the branch list, a commit's files opening in
 * diff tabs. A commit that landed from a task is linked to it only where the
 * run's own branch and its landed tasks say so.
 */

const PAGE = 100;
/** Integration branches whose log is read to link landed commits; a repository with more is linked for the newest runs only. */
const MAX_LINKED_BRANCHES = 5;

interface Linked {
  shas: ReadonlySet<string>;
  landed: LandedTask[];
  sessionId: string;
}

/** The tasks landed on each of the repository's runs' integration branches, with the commits those branches hold. */
async function readLinks(api: FrameApi, repo: string, branches: Branches): Promise<Linked[]> {
  const integration = branches.ordewell.filter((b) => b.owner && !b.owner.taskId).slice(0, MAX_LINKED_BRANCHES);
  const runs: Readonly<Record<string, RunInfo>> = await gitStoreFor(api).runsFor(ownersOf({ ...branches, local: [], worktrees: [], ordewell: integration }));
  return Promise.all(integration.map(async (branch): Promise<Linked> => {
    const sessionId = branch.owner!.sessionId;
    const page = await readLog(api.workspace, repo, { ref: branch.name, limit: PAGE }).catch(() => undefined);
    const landed = (runs[sessionId]?.tasks ?? []).filter((t) => t.state === 'landed').map(({ id, order, title }) => ({ taskId: id, order, title }));
    return { shas: new Set(page?.commits.map((c) => c.sha)), landed, sessionId };
  }));
}

function landedFor(commit: CommitSummary, links: readonly Linked[]): { task: LandedTask; sessionId: string } | undefined {
  for (const link of links) {
    const task = landedTaskOf(commit, link.shas, link.landed);
    if (task) return { task, sessionId: link.sessionId };
  }
  return undefined;
}

/**
 * A commit's message and files: beside the graph's rows, or as a tab of its own
 * when the sidebar's history opens it. Each file opens in a diff tab.
 */
function Detail({ api, repo, sha, summary, linked, close }: { api: FrameApi; repo: string; sha: string; summary?: CommitSummary; linked?: { task: LandedTask; sessionId: string }; close?(): void }): JSX.Element {
  const [detail, setDetail] = useState<CommitDetail>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setDetail(undefined);
    setError(undefined);
    readCommit(api.workspace, repo, sha).then((read) => { if (live) setDetail(read); }, (e: unknown) => { if (live) setError(messageOf(e)); });
    return () => { live = false; };
  }, [api, repo, sha]);
  const shown = summary ?? detail?.commit;

  const open = (path: string, preview: boolean): void => {
    // Its own tab is kept first: a preview diff would otherwise take the preview commit's place.
    if (!close) openCommit(api, repo, sha, false);
    api.openTab({ kind: 'commit-diff', id: commitDiffTabId(repo, sha, path), title: `${path.slice(path.lastIndexOf('/') + 1)} @ ${shortSha(sha)}` }, { preview });
  };

  return (
    <aside className={close ? 'git-detail' : 'git-detail git-detail-tab'} aria-label="Commit">
      <div className="git-detail-head">
        <h3>{shown?.subject ?? shortSha(sha)}</h3>
        {close && <IconButton icon={X} label="Close the commit" onClick={close} />}
      </div>
      <p className="git-detail-meta" title={shown ? `${sha}\n${shown.date}` : sha}>
        <span className="git-detail-sha">{shortSha(sha)}</span>
        {shown && <span>{shown.author}</span>}
        {shown && <span>{commitWhen(shown.date)}</span>}
      </p>
      {linked && (
        <p className="git-detail-landed">
          <span>Landed from</span>
          <button type="button" className="git-owner" title={`Open task #${linked.task.order}: ${linked.task.title}`} onClick={() => void openRun(api, { sessionId: linked.sessionId, taskId: linked.task.taskId })}>
            <span className="git-owner-text">task #{linked.task.order}: {linked.task.title}</span>
          </button>
        </p>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {!detail && !error && <p className="git-hint">Loading…</p>}
      {detail && (
        <>
          {detail.commit.body.trim() && <pre className="git-detail-body">{detail.commit.body.trim()}</pre>}
          {detail.files.length === 0 ? <p className="git-hint">This commit changes no files.</p> : (
            <ul className="git-list">
              {detail.files.map((file) => {
                const at = file.path.lastIndexOf('/');
                const base = file.path.slice(at + 1);
                const dir = at < 0 ? '' : file.path.slice(0, at);
                return (
                  <li key={file.path} className="srow git-file">
                    <button type="button" className="srow-main" title={file.path} aria-label={`${file.status} ${file.path}`} onClick={() => open(file.path, true)} onDoubleClick={() => open(file.path, false)}>
                      <span className={`sbadge sbadge-${file.status}`} aria-label={file.status}>{file.status}</span>
                      <span className="git-file-base">{base}</span>
                      {dir && <MiddleText className="git-file-dir" text={dir} path />}
                    </button>
                    {file.added === null ? <span className="git-file-counts">binary</span> : (
                      <span className="git-file-counts"><span className="git-file-added">+{file.added}</span><span className="git-file-removed">−{file.removed ?? 0}</span></span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}

/** A commit as a tab of its own, a preview unless kept, so stepping through the sidebar's history leaves one tab behind. */
export function openCommit(api: FrameApi, repo: string, sha: string, preview: boolean): void {
  api.openTab({ kind: 'commit', id: commitTabId(repo, sha), title: `Commit ${shortSha(sha)}` }, { preview });
}

function Graph({ api, tab }: { api: FrameApi; tab: Tab }): JSX.Element {
  const { repo, ref } = parseCommitsTabId(tab.id);
  const git = gitStoreFor(api);
  const { round } = useSyncExternalStore(git.subscribe, git.getSnapshot);
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [more, setMore] = useState(false);
  const [branches, setBranches] = useState<Branches>();
  const [links, setLinks] = useState<Linked[]>([]);
  const [selected, setSelected] = useState<string>();
  const [nonce, setNonce] = useState(0);

  // A fetch or a switch in the sidebar moves the labels and may add commits: both are read again.
  useEffect(() => {
    let live = true;
    setError(undefined);
    void (async () => {
      try {
        const [page, read] = await Promise.all([
          readLog(api.workspace, repo, { ...(ref ? { ref } : {}), limit: PAGE }),
          readBranches(api.workspace, repo).catch(() => undefined),
        ]);
        if (!live) return;
        setCommits(page.commits);
        setCursor(page.cursor);
        setBranches(read);
        setLoaded(true);
        if (read) {
          const found = await readLinks(api, repo, read).catch(() => []);
          if (live) setLinks(found);
        }
      } catch (e) {
        if (live) { setError(messageOf(e)); setLoaded(true); }
      }
    })();
    return () => { live = false; };
  }, [api, repo, ref, round, nonce]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const page = await readLog(api.workspace, repo, { ...(ref ? { ref } : {}), cursor, limit: PAGE });
      setCommits((have) => [...have, ...page.commits]);
      setCursor(page.cursor);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setMore(false);
    }
  }, [api, repo, ref, cursor]);

  const layout = useMemo(() => assignLanes(commits), [commits]);
  const chosen = commits.find((c) => c.sha === selected);

  return (
    <div className="git-graph">
      <div className="git-graph-bar">
        <span className="git-graph-title"><MiddleText text={ref ?? 'History'} tail={16} />{repo !== '.' && <span className="git-graph-repo">{repo}</span>}</span>
        <Button size="sm" icon={RefreshCw} onClick={() => setNonce((n) => n + 1)}>Refresh</Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!loaded && <EmptyState className="git-state-wide" icon={GitCommitHorizontal} title="Loading the history…" />}
      {loaded && !error && commits.length === 0 && <EmptyState className="git-state-wide" icon={GitCommitHorizontal} title="This repository has no commits yet." body="Commit something and its history appears here." />}
      <div className="git-graph-body">
        <ul className="git-commits" aria-label="Commits">
          {commits.map((commit, i) => {
            const row = layout.rows[i]!;
            const linked = landedFor(commit, links);
            return (
              <li key={commit.sha}>
                <button type="button" className="git-commit" aria-pressed={commit.sha === selected} aria-label={`Commit ${shortSha(commit.sha)}: ${commit.subject}`} onClick={() => setSelected((was) => (was === commit.sha ? undefined : commit.sha))}>
                  <Lanes row={row} width={layout.width} />
                  <span className="git-refs">{refChips(commit.refs, branches).map((chip) => <Chip key={chip.text} chip={chip} />)}</span>
                  <span className="git-commit-subject">{commit.subject}</span>
                  {linked && <span className="git-chip git-chip-ordewell" title={linked.task.title}>task #{linked.task.order}</span>}
                  <span className="git-commit-meta">{commit.author} · {ago(commit.date)}</span>
                </button>
              </li>
            );
          })}
          {cursor && (
            <li className="git-more">
              <Button size="sm" disabled={more} onClick={() => void loadMore()}>{more ? 'Loading…' : 'Load more'}</Button>
            </li>
          )}
        </ul>
        {chosen && <Detail api={api} repo={repo} sha={chosen.sha} summary={chosen} linked={landedFor(chosen, links)} close={() => setSelected(undefined)} />}
      </div>
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  return all(
    api.registerTabKind({ kind: 'commits', icon: GitCommitHorizontal, render: (tab) => <Graph key={tab.key} api={api} tab={tab} /> }),
    api.registerTabKind({ kind: 'commit', icon: GitCommitHorizontal, render: (tab) => { const { repo, sha } = parseCommitTabId(tab.id); return <Detail key={tab.key} api={api} repo={repo} sha={sha} />; } }),
  );
}
