import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { GitCommitHorizontal } from 'lucide-react';
import type { FrameApi, Tab, Unregister } from '../../frame/api';
import { messageOf } from '../../session/daemon';
import { all } from '../Stub';
import '../explorer/explorer.css';
import '../changes/changes.css';
import { openRun } from './gitActions';
import { readBranches, readCommit, readLog, type Branches, type CommitDetail, type CommitSummary } from './gitData';
import { ago, commitDiffTabId, landedTaskOf, parseCommitsTabId, refChips, shortSha, type LandedTask, type RefChip } from './gitModel';
import { gitStoreFor, ownersOf, type RunInfo } from './gitStore';
import { assignLanes, type GraphRow } from './lanes';
import './git.css';

/*
 * The history of one repository as lanes (design W12, ADR-0062): paged from
 * the daemon, ref labels from the branch list, a commit's files opening in
 * diff tabs. A commit that landed from a task is linked to it only where the
 * run's own branch and its landed tasks say so.
 */

const ROW = 28;
const LANE = 14;
const PAGE = 100;
/** Integration branches whose log is read to link landed commits; a repository with more is linked for the newest runs only. */
const MAX_LINKED_BRANCHES = 5;

const x = (lane: number): number => lane * LANE + LANE / 2;

function Lanes({ row, width }: { row: GraphRow; width: number }): JSX.Element {
  const mid = ROW / 2;
  return (
    <svg className="git-lanes" width={Math.max(width, 1) * LANE + 2} height={ROW} aria-hidden="true">
      {row.segments.map((s, i) => {
        const d = s.kind === 'pass' ? `M${x(s.from)},0 V${ROW}`
          : s.kind === 'in' ? `M${x(s.from)},0 L${x(s.to)},${mid}`
            : `M${x(s.from)},${mid} L${x(s.to)},${ROW}`;
        return <path key={i} d={d} className={`git-lane-${s.color}`} />;
      })}
      {row.continues && <path d={`M${x(row.lane)},${mid} V${ROW}`} className={`git-lane-${row.color}`} strokeDasharray="2 3" />}
      <circle cx={x(row.lane)} cy={mid} r={4} className={`git-lane-${row.color}${row.merge ? ' git-merge' : ''}`} />
    </svg>
  );
}

function Chip({ chip }: { chip: RefChip }): JSX.Element {
  const classes = ['git-chip', `git-chip-${chip.kind}`, chip.current ? 'git-chip-current' : ''].filter(Boolean).join(' ');
  const title = chip.kind === 'ordewell'
    ? `Ordewell’s ${chip.owner?.taskId ? 'task' : 'integration'} branch${chip.owner ? ` for run ${chip.owner.runId}` : ''}`
    : undefined;
  return <span className={classes} title={title}>{chip.kind === 'ordewell' ? `Ordewell · ${chip.text}` : chip.text}</span>;
}

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

function Detail({ api, repo, sha, summary, linked }: { api: FrameApi; repo: string; sha: string; summary: CommitSummary; linked: { task: LandedTask; sessionId: string } | undefined }): JSX.Element {
  const [detail, setDetail] = useState<CommitDetail>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setDetail(undefined);
    setError(undefined);
    readCommit(api.workspace, repo, sha).then((read) => { if (live) setDetail(read); }, (e: unknown) => { if (live) setError(messageOf(e)); });
    return () => { live = false; };
  }, [api, repo, sha]);

  const open = (path: string, preview: boolean): void => {
    api.openTab({ kind: 'commit-diff', id: commitDiffTabId(repo, sha, path), title: `${path.slice(path.lastIndexOf('/') + 1)} @ ${shortSha(sha)}` }, { preview });
  };

  return (
    <aside className="git-detail" aria-label="Commit">
      <h3>{summary.subject}</h3>
      <p className="git-detail-meta">{shortSha(sha)} · {summary.author} · {summary.date}</p>
      {linked && (
        <p className="git-detail-meta">
          Landed from{' '}
          <button type="button" className="changes-link" onClick={() => void openRun(api, { sessionId: linked.sessionId, taskId: linked.task.taskId })}>
            task #{linked.task.order}: {linked.task.title}
          </button>
        </p>
      )}
      {error && <p className="changes-note error" role="alert">{error}</p>}
      {!detail && !error && <p className="changes-note">Loading…</p>}
      {detail && (
        <>
          {detail.commit.body.trim() && <pre className="git-detail-body">{detail.commit.body.trim()}</pre>}
          {detail.files.length === 0 ? <p className="changes-note">This commit changes no files.</p> : (
            <ul className="changes-files">
              {detail.files.map((file) => (
                <li key={file.path} className="changes-file">
                  <button type="button" className="git-row-name" title={file.path} onClick={() => open(file.path, true)} onDoubleClick={() => open(file.path, false)}>
                    <span className={`ex-badge ex-badge-${file.status}`}>{file.status}</span> {file.path}
                  </button>
                  {file.added === null ? <span className="changes-counts muted">binary</span> : (
                    <span className="changes-counts"><span className="changes-added">+{file.added}</span> <span className="changes-removed">−{file.removed ?? 0}</span></span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
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
        <span className="git-row-name">{ref ?? 'History'}<span className="muted"> {repo === '.' ? '' : repo}</span></span>
        <button type="button" className="ft-button" onClick={() => setNonce((n) => n + 1)}>Refresh</button>
      </div>
      {error && <p className="changes-note error" role="alert">{error}</p>}
      {!loaded && <p className="frame-empty">Loading the history…</p>}
      {loaded && !error && commits.length === 0 && <p className="frame-empty">This repository has no commits yet.</p>}
      <div className="git-graph-body">
        <ul className="git-commits" aria-label="Commits">
          {commits.map((commit, i) => {
            const row = layout.rows[i]!;
            const linked = landedFor(commit, links);
            return (
              <li key={commit.sha}>
                <button type="button" className="git-commit" aria-pressed={commit.sha === selected} aria-label={`Commit ${shortSha(commit.sha)}: ${commit.subject}`} onClick={() => setSelected(commit.sha)}>
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
              <button type="button" className="ft-button" disabled={more} onClick={() => void loadMore()}>{more ? 'Loading…' : 'Load more'}</button>
            </li>
          )}
        </ul>
        {chosen && <Detail api={api} repo={repo} sha={chosen.sha} summary={chosen} linked={landedFor(chosen, links)} />}
      </div>
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  return all(api.registerTabKind({ kind: 'commits', icon: GitCommitHorizontal, render: (tab) => <Graph key={tab.key} api={api} tab={tab} /> }));
}
