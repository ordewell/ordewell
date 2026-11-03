import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Minus, Plus, RefreshCw, Undo2 } from 'lucide-react';
import { discardChangesConfirmation } from '@ordewell/ui/host';
import { IconButton } from '@ordewell/ui/design';
import type { FrameApi, Unregister } from '../../frame/api';
import { all } from '../Stub';
import { FOCUS_COMMIT_COMMAND } from '../changes/mergeAll';
import { daemonHost, type DaemonHost } from '../../session/DaemonHost';
import { confirm as askInWindow } from '../../session/ConfirmDialog';
import { DaemonError } from '../../session/daemon';
import { useSession } from '../../session/useSession';
import {
  commitCheckout, describeGitError, discardPaths, readCheckout, readStatus, stagePaths, unstagePaths,
} from './checkoutData';
import { onCheckoutChange, notifyCheckoutChange } from './checkoutEvents';
import {
  canAmend, changedPaths, checkoutRepoLabel, liveLandingBranch, pathsToStage,
  type CheckoutFile, type RepoCheckout,
} from './checkoutModel';
import { checkoutDiffTabId, checkoutDiffTitle } from './checkoutTabs';
import './checkout.css';

/*
 * The user's own checkout in the Changes activity (design W10, ADR-0062): the
 * commit box, then staged and unstaged files per repository, with stage and
 * discard by file and a diff that stages hunks. Status is read again on focus,
 * on another view's action and on a gentle timer, since the daemon streams
 * session frames but not the working tree.
 */

const POLL_MS = 5000;

/** The commit box Merge all's "Commit first" puts the cursor in. */
let focusedCommit: HTMLTextAreaElement | null = null;

function focusCommitNow(attempt = 0): void {
  if (focusedCommit) { focusedCommit.focus(); focusedCommit.select(); return; }
  if (attempt < 10) setTimeout(() => focusCommitNow(attempt + 1), 50);
}

interface Loaded {
  repos: RepoCheckout[];
  error?: string;
}

function useCheckout(api: FrameApi): { loaded: Loaded | undefined; refresh(): Promise<void> } {
  const [loaded, setLoaded] = useState<Loaded>();
  const reading = useRef(false);
  const queued = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (reading.current) { queued.current = true; return; }
    reading.current = true;
    try {
      do {
        queued.current = false;
        const repos = await readCheckout(api.workspace);
        setLoaded(repos.length === 0
          ? { repos, error: 'No git repository in this workspace, so there is nothing to commit.' }
          : { repos });
      } while (queued.current);
    } catch (error) {
      setLoaded((was) => ({ repos: was?.repos ?? [], error: describeGitError(error) }));
    } finally {
      reading.current = false;
    }
  }, [api.workspace]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    const onFocus = (): void => { void refresh(); };
    window.addEventListener('focus', onFocus);
    const off = onCheckoutChange(() => { void refresh(); });
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      off();
    };
  }, [refresh]);

  return { loaded, refresh };
}

function openFile(api: FrameApi, repo: string, file: CheckoutFile, kind: 'staged' | 'unstaged', preview: boolean): void {
  api.openTab({
    kind: 'diff',
    id: checkoutDiffTabId(repo, file.path, kind),
    title: checkoutDiffTitle(file.path, kind),
    scope: { kind: 'checkout' },
  }, { preview });
}

function pathName(repo: string, path: string): string {
  return repo === '.' ? path : `${repo}/${path}`;
}

const LETTER_WORD: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', '?': 'Untracked', U: 'Conflicted' };

function Row({ api, repo, file, staged, busy, actions }: {
  api: FrameApi;
  repo: string;
  file: CheckoutFile;
  staged: boolean;
  busy: string | undefined;
  actions: ReactNode;
}): JSX.Element {
  const name = pathName(repo, file.path);
  return (
    <li className="checkout-row">
      <button
        type="button"
        className="checkout-file"
        title={name}
        onClick={() => openFile(api, repo, file, staged ? 'staged' : 'unstaged', true)}
        onDoubleClick={() => openFile(api, repo, file, staged ? 'staged' : 'unstaged', false)}
      >
        <span className={`ex-badge ex-badge-${file.status}`} aria-label={LETTER_WORD[file.status]}>{file.status}</span>
        <span className="checkout-path">{file.path}</span>
        {file.from && <span className="checkout-from muted">from {file.from}</span>}
      </button>
      <span className="checkout-row-actions" aria-busy={busy !== undefined}>{actions}</span>
    </li>
  );
}

function RepoSection({ api, host, repo, first, onRefresh }: {
  api: FrameApi;
  host: DaemonHost;
  repo: RepoCheckout;
  first: boolean;
  onRefresh(): Promise<void>;
}): JSX.Element {
  const { state } = useSession(host);
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [pushedHead, setPushedHead] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const box = useRef<HTMLTextAreaElement>(null);
  const label = checkoutRepoLabel(repo.info.repo);
  const status = repo.status;
  // The route is the authority on whether the last commit is pushed (ADR-0062 G4): ahead of no upstream is a guess it can correct.
  const amendable = canAmend(repo.info) && repo.info.head !== pushedHead;
  const live = liveLandingBranch(state, repo.info.repo, repo.info.branch);

  useEffect(() => {
    if (!first) return;
    focusedCommit = box.current;
    return () => { if (focusedCommit === box.current) focusedCommit = null; };
  }, [first]);

  useEffect(() => { setPushedHead(null); }, [repo.info.head]);
  useEffect(() => { if (!amendable) setAmend(false); }, [amendable]);

  const act = async (key: string, said: string, action: () => Promise<void>): Promise<boolean> => {
    setBusy(key);
    setProblem(undefined);
    try {
      await action();
      api.announce(said);
      notifyCheckoutChange();
      return true;
    } catch (error) {
      setProblem(describeGitError(error));
      if (error instanceof DaemonError) {
        if (error.code === 'pushed') {
          setPushedHead(repo.info.head);
          setAmend(false);
        }
        // The state moved under the action: the next attempt should be against what is there now.
        if (error.code === 'confirm_stale' || error.code === 'stale') void onRefresh();
      }
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const commit = (): void => {
    const text = message.trim();
    if (text === '') return;
    void (async () => {
      const done = await act('commit', amend ? 'Amended the last commit.' : 'Committed.', () => commitCheckout(api.workspace, repo.info.repo, text, amend && amendable, repo.info.head));
      if (done) setMessage('');
    })();
  };

  const discard = (paths: string[]): void => {
    void (async () => {
      let shown = paths;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const answer = await askInWindow(discardChangesConfirmation(shown));
        if (answer !== 'discard') return;
        setBusy('discard');
        setProblem(undefined);
        try {
          await discardPaths(api.workspace, repo.info.repo, shown);
          api.announce('Discarded.');
          notifyCheckoutChange();
          return;
        } catch (error) {
          if (error instanceof DaemonError && error.code === 'confirm_stale' && attempt === 0) {
            await onRefresh();
            const fresh = await readStatus(api.workspace, repo.info.repo).catch(() => undefined);
            const still = fresh ? changedPaths(fresh).filter((path) => paths.includes(path)) : [];
            if (still.length === 0) { api.announce('Nothing is left to discard.'); return; }
            shown = still;
            continue;
          }
          setProblem(describeGitError(error));
          return;
        } finally {
          setBusy(undefined);
        }
      }
    })();
  };

  const stageAllPaths = status ? pathsToStage(status) : [];
  const unstagedPaths = status ? [...status.changes, ...status.conflicted].map((file) => file.path) : [];
  const mod = api.platform === 'darwin' ? '⌘⏎' : 'Ctrl+Enter';

  return (
    <section className="checkout-repo" aria-label={label}>
      <div className="checkout-repo-head">
        <span className="checkout-repo-name">{label}</span>
        <span className="checkout-branch">{repo.info.detached ? 'detached HEAD' : repo.info.branch ?? 'no branch yet'}</span>
        {repo.info.upstream && (
          <span className="checkout-remote" title={`${repo.info.ahead} ahead, ${repo.info.behind} behind ${repo.info.upstream}`}>
            ↓ {repo.info.behind} ↑ {repo.info.ahead}
          </span>
        )}
        <span className="ft-spacer" />
        <IconButton icon={RefreshCw} size={12} label={`Refresh ${label}`} onClick={() => { void onRefresh(); }} />
      </div>

      {live && (
        <p className="checkout-live" role="note">
          {live} is a live run’s landing branch: actions here are noted in its timeline.
        </p>
      )}
      {problem && <p className="checkout-error" role="alert">{problem}</p>}
      {repo.error && <p className="checkout-error" role="alert">{repo.error}</p>}

      <form className="checkout-commit" onSubmit={(event) => { event.preventDefault(); commit(); }}>
        <textarea
          ref={box}
          className="frame-input checkout-message"
          aria-label={`Commit message for ${label}`}
          placeholder={`Message (${mod} to commit)`}
          rows={3}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(); }
          }}
        />
        <div className="checkout-commit-actions">
          <button type="submit" className="ft-button ft-primary" disabled={message.trim() === '' || busy !== undefined}>
            {busy === 'commit' ? (amend ? 'Amending…' : 'Committing…') : amend ? 'Amend' : 'Commit'}
          </button>
          {amendable ? (
            <label className="checkout-amend">
              <input type="checkbox" checked={amend} disabled={busy !== undefined} onChange={(event) => setAmend(event.target.checked)} />
              Amend the last commit
            </label>
          ) : (
            <span className="checkout-amend muted" title="Amend is offered only while the last commit is on no remote-tracking branch.">
              {repo.info.head === null ? 'No commit to amend yet' : 'Amend unavailable: the last commit is pushed'}
            </span>
          )}
        </div>
      </form>

      {status && (
        <>
          {status.conflicted.length > 0 && (
            <section className="checkout-group" aria-label={`Conflicts in ${label}`}>
              <h3 className="checkout-heading">CONFLICTS ({status.conflicted.length})</h3>
              <ul className="checkout-files">
                {status.conflicted.map((file) => (
                  <Row
                    key={`U:${file.path}`}
                    api={api}
                    repo={repo.info.repo}
                    file={file}
                    staged={false}
                    busy={busy}
                    actions={(
                      <IconButton
                        icon={Plus}
                        size={12}
                        label={`Stage ${pathName(repo.info.repo, file.path)}`}
                        disabled={busy !== undefined}
                        onClick={() => { void act(`stage:${file.path}`, 'Staged.', () => stagePaths(api.workspace, repo.info.repo, [file.path])); }}
                      />
                    )}
                  />
                ))}
              </ul>
            </section>
          )}

          {status.staged.length > 0 && (
            <section className="checkout-group" aria-label={`Staged in ${label}`}>
              <h3 className="checkout-heading">
                STAGED ({status.staged.length})
                {status.staged.length > 1 && (
                  <button
                    type="button"
                    className="checkout-text"
                    disabled={busy !== undefined}
                    onClick={() => { void act('unstage-all', 'Unstaged all.', () => unstagePaths(api.workspace, repo.info.repo, status.staged.map((file) => file.path))); }}
                  >
                    Unstage all
                  </button>
                )}
              </h3>
              <ul className="checkout-files">
                {status.staged.map((file) => (
                  <Row
                    key={`S:${file.path}`}
                    api={api}
                    repo={repo.info.repo}
                    file={file}
                    staged
                    busy={busy}
                    actions={(
                      <IconButton
                        icon={Minus}
                        size={12}
                        label={`Unstage ${pathName(repo.info.repo, file.path)}`}
                        disabled={busy !== undefined}
                        onClick={() => { void act(`unstage:${file.path}`, 'Unstaged.', () => unstagePaths(api.workspace, repo.info.repo, [file.path])); }}
                      />
                    )}
                  />
                ))}
              </ul>
            </section>
          )}

          {status.changes.length > 0 && (
            <section className="checkout-group" aria-label={`Changes in ${label}`}>
              <h3 className="checkout-heading">
                CHANGES ({status.changes.length})
                <button
                  type="button"
                  className="checkout-text"
                  disabled={busy !== undefined || stageAllPaths.length === 0}
                  onClick={() => { void act('stage-all', 'Staged all.', () => stagePaths(api.workspace, repo.info.repo, stageAllPaths)); }}
                >
                  Stage all
                </button>
                <button
                  type="button"
                  className="checkout-text"
                  disabled={busy !== undefined}
                  onClick={() => discard(unstagedPaths)}
                >
                  Discard all…
                </button>
              </h3>
              <ul className="checkout-files">
                {status.changes.map((file) => (
                  <Row
                    key={`W:${file.path}`}
                    api={api}
                    repo={repo.info.repo}
                    file={file}
                    staged={false}
                    busy={busy}
                    actions={(
                      <>
                        <IconButton
                          icon={Plus}
                          size={12}
                          label={`Stage ${pathName(repo.info.repo, file.path)}`}
                          disabled={busy !== undefined}
                          onClick={() => { void act(`stage:${file.path}`, 'Staged.', () => stagePaths(api.workspace, repo.info.repo, [file.path])); }}
                        />
                        <IconButton
                          icon={Undo2}
                          size={12}
                          label={`Discard changes to ${pathName(repo.info.repo, file.path)}`}
                          disabled={busy !== undefined}
                          onClick={() => discard([file.path])}
                        />
                      </>
                    )}
                  />
                ))}
              </ul>
            </section>
          )}

          {status.staged.length === 0 && status.changes.length === 0 && status.conflicted.length === 0 && (
            <p className="checkout-empty">No changes in {repo.info.repo === '.' ? 'your checkout' : checkoutRepoLabel(repo.info.repo)}.</p>
          )}
        </>
      )}
    </section>
  );
}

export function CheckoutChanges({ api }: { api: FrameApi }): JSX.Element {
  const host = daemonHost(api.workspace);
  const { state } = useSession(host);
  const { loaded, refresh } = useCheckout(api);
  // A landing frame means the run wrote into the checkout's branch: read the tree again, as the design says.
  const landed = `${state.run.handoff?.landed.length ?? 0}/${state.run.runMerge?.landed.length ?? 0}`;
  const seenLanded = useRef(landed);
  useEffect(() => {
    if (seenLanded.current === landed) return;
    seenLanded.current = landed;
    void refresh();
  }, [landed, refresh]);

  if (!loaded) return <p className="changes-note">Reading your checkout…</p>;
  if (loaded.repos.length === 0) return <p className="frame-empty">{loaded.error ?? 'No git repository in this workspace, so there is nothing to commit.'}</p>;

  return (
    <div className="checkout">
      {loaded.error && <p className="checkout-error" role="alert">{loaded.error}</p>}
      {loaded.repos.map((repo, index) => (
        <RepoSection key={repo.info.repo} api={api} host={host} repo={repo} first={index === 0} onRefresh={refresh} />
      ))}
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  return all(
    api.registerSidebar({ activity: 'changes', id: 'checkout', title: 'Checkout', order: 0, render: () => <CheckoutChanges api={api} /> }),
    api.registerCommand({ id: FOCUS_COMMIT_COMMAND, title: 'Focus the commit message', run: () => focusCommitNow() }),
  );
}
