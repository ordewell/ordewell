import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, GitBranch, GitCommitHorizontal, Minus, Plus, RefreshCw, Undo2 } from 'lucide-react';
import { discardChangesConfirmation } from '@ordewell/ui/host';
import { Button, EmptyState, Icon, IconButton } from '@ordewell/ui/design';
import type { FrameApi, Unregister } from '../../frame/api';
import { Popover } from '../../frame/Popover';
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
import { fetchRepo, popStash, pullBranch, pushBranch, stashChanges, type GitContext } from '../git/gitActions';
import { useSyncing } from '../git/gitStore';
import { SyncBar } from '../git/SyncBar';
import { useRepoBranches } from '../git/useRepoBranches';
import { LONG_LIST, MiddleText, Notice, SidebarGroup } from '../sidebarKit';
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

/** A file's name first, its folder after it in muted type: the name is what tells two rows apart. */
function splitPath(path: string): { dir: string; base: string } {
  const at = path.lastIndexOf('/');
  return at < 0 ? { dir: '', base: path } : { dir: path.slice(0, at), base: path.slice(at + 1) };
}

function Row({ api, repo, file, staged, busy, actions }: {
  api: FrameApi;
  repo: string;
  file: CheckoutFile;
  staged: boolean;
  busy: string | undefined;
  actions: ReactNode;
}): JSX.Element {
  const name = pathName(repo, file.path);
  const { dir, base } = splitPath(file.path);
  return (
    <li className="srow checkout-row">
      <button
        type="button"
        className="srow-main checkout-file"
        title={file.from ? `${name}\nRenamed from ${file.from}` : name}
        onClick={() => openFile(api, repo, file, staged ? 'staged' : 'unstaged', true)}
        onDoubleClick={() => openFile(api, repo, file, staged ? 'staged' : 'unstaged', false)}
      >
        <span className={`sbadge sbadge-${file.status}`} aria-label={LETTER_WORD[file.status]}>{file.status}</span>
        <span className="checkout-name">{base}</span>
        {file.from ? <MiddleText className="checkout-dir" text={`from ${file.from}`} path /> : dir && <MiddleText className="checkout-dir" text={dir} path />}
      </button>
      <span className="srow-actions" aria-busy={busy !== undefined}>{actions}</span>
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const label = checkoutRepoLabel(repo.info.repo);
  const status = repo.status;
  // The route is the authority on whether the last commit is pushed (ADR-0062 G4): ahead of no upstream is a guess it can correct.
  const amendable = canAmend(repo.info) && repo.info.head !== pushedHead;
  const live = liveLandingBranch(state, repo.info.repo, repo.info.branch);
  const changeCount = repo.status ? repo.status.staged.length + repo.status.changes.length + repo.status.conflicted.length : 0;
  // What the sync line and the stash menu act on moves with the branch, its commit and the tree: read again when any does, and when the menu opens.
  const branches = useRepoBranches(api, repo.info.repo, `${repo.info.branch}|${repo.info.head}|${repo.info.ahead}|${repo.info.behind}|${changeCount}|${menuOpen}`);
  const git: GitContext | undefined = branches ? { api, repo: repo.info.repo, branches } : undefined;
  const syncing = useSyncing(api, repo.info.repo);

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
  const stash = branches?.stashes[0];
  const stashable = changeCount > 0;
  const closeMenu = (): void => setMenuOpen(false);
  const inMenu = (run: (ctx: GitContext) => Promise<void>) => (): void => {
    closeMenu();
    if (git) void run(git);
  };
  const branchName = repo.info.detached ? 'detached HEAD' : repo.info.branch ?? 'no branch yet';
  const files = (list: CheckoutFile[], staged: boolean, actions: (file: CheckoutFile) => ReactNode): JSX.Element => (
    <ul className="checkout-files">
      {list.map((file) => (
        <Row key={`${staged ? 'S' : 'W'}:${file.path}`} api={api} repo={repo.info.repo} file={file} staged={staged} busy={busy} actions={actions(file)} />
      ))}
    </ul>
  );
  const stageOne = (file: CheckoutFile): JSX.Element => (
    <IconButton
      icon={Plus}
      label={`Stage ${pathName(repo.info.repo, file.path)}`}
      disabled={busy !== undefined}
      onClick={() => { void act(`stage:${file.path}`, 'Staged.', () => stagePaths(api.workspace, repo.info.repo, [file.path])); }}
    />
  );

  return (
    <section className="checkout-repo" aria-label={label}>
      <div className="checkout-repo-head">
        <span className="checkout-repo-name" title={label}>{label}</span>
        <span className="checkout-branch">
          <Icon icon={GitBranch} size={14} />
          <MiddleText text={branchName} />
        </span>
        <IconButton icon={RefreshCw} label={`Refresh ${label}`} onClick={() => { void onRefresh(); }} />
      </div>

      {live && <Notice tone="info">{live} is a live run’s landing branch: actions here are noted in its timeline.</Notice>}
      {problem && <Notice tone="error">{problem}</Notice>}
      {repo.error && <Notice tone="error">{repo.error}</Notice>}

      <form className="checkout-commit" onSubmit={(event) => { event.preventDefault(); commit(); }}>
        <textarea
          ref={box}
          className="checkout-message"
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
          <div className="checkout-split">
            <Button type="submit" variant="primary" className="checkout-split-main" disabled={message.trim() === '' || busy !== undefined}>
              {busy === 'commit' ? (amend ? 'Amending…' : 'Committing…') : amend ? 'Amend' : 'Commit'}
            </Button>
            <button
              ref={menuAnchor}
              type="button"
              className="ow-button ow-button-primary checkout-split-more"
              aria-label="More commit actions"
              title="More commit actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={busy !== undefined}
              onClick={() => setMenuOpen((was) => !was)}
            >
              <Icon icon={ChevronDown} size={14} />
            </button>
            {menuOpen && (
              <Popover label="Commit actions" role="menu" anchor={menuAnchor} onClose={closeMenu} className="frame-menu checkout-menu">
                <ul>
                  <li>
                    <button type="button" role="menuitem" disabled={!git || !stashable} title={stashable ? undefined : 'There are no changes to stash.'} onClick={inMenu((ctx) => stashChanges(ctx, ''))}>
                      Stash changes…
                    </button>
                  </li>
                  <li>
                    <button type="button" role="menuitem" disabled={!git || !stash} title={stash ? undefined : 'There is no stash to pop.'} onClick={inMenu((ctx) => popStash(ctx, stash!))}>
                      {stash ? `Pop ${stash.ref}…` : 'Pop latest stash…'}
                    </button>
                  </li>
                </ul>
              </Popover>
            )}
          </div>
          {amendable ? (
            <label className="checkout-amend">
              <input type="checkbox" checked={amend} disabled={busy !== undefined} onChange={(event) => setAmend(event.target.checked)} />
              Amend the last commit
            </label>
          ) : (
            <span className="checkout-amend checkout-amend-off" title="Amend is offered only while the last commit is on no remote-tracking branch.">
              {repo.info.head === null ? 'No commit to amend yet' : 'Amend unavailable: the last commit is pushed'}
            </span>
          )}
        </div>
      </form>

      {status && (
        <>
          {status.conflicted.length > 0 && (
            <SidebarGroup title="Conflicts" label={`Conflicts in ${label}`} count={status.conflicted.length}>
              {files(status.conflicted, false, stageOne)}
            </SidebarGroup>
          )}

          {status.staged.length > 0 && (
            <SidebarGroup
              title="Staged"
              label={`Staged in ${label}`}
              count={status.staged.length}
              startOpen={status.staged.length <= LONG_LIST}
              actions={status.staged.length > 1 && (
                <IconButton
                  icon={Minus}
                  label="Unstage all"
                  disabled={busy !== undefined}
                  onClick={() => { void act('unstage-all', 'Unstaged all.', () => unstagePaths(api.workspace, repo.info.repo, status.staged.map((file) => file.path))); }}
                />
              )}
            >
              {files(status.staged, true, (file) => (
                <IconButton
                  icon={Minus}
                  label={`Unstage ${pathName(repo.info.repo, file.path)}`}
                  disabled={busy !== undefined}
                  onClick={() => { void act(`unstage:${file.path}`, 'Unstaged.', () => unstagePaths(api.workspace, repo.info.repo, [file.path])); }}
                />
              ))}
            </SidebarGroup>
          )}

          {status.changes.length > 0 && (
            <SidebarGroup
              title="Changes"
              label={`Changes in ${label}`}
              count={status.changes.length}
              startOpen={status.changes.length <= LONG_LIST}
              actions={(
                <>
                  <IconButton
                    icon={Plus}
                    label="Stage all"
                    disabled={busy !== undefined || stageAllPaths.length === 0}
                    onClick={() => { void act('stage-all', 'Staged all.', () => stagePaths(api.workspace, repo.info.repo, stageAllPaths)); }}
                  />
                  <IconButton icon={Undo2} label="Discard all…" disabled={busy !== undefined} onClick={() => discard(unstagedPaths)} />
                </>
              )}
            >
              {files(status.changes, false, (file) => (
                <>
                  {stageOne(file)}
                  <IconButton
                    icon={Undo2}
                    label={`Discard changes to ${pathName(repo.info.repo, file.path)}`}
                    disabled={busy !== undefined}
                    onClick={() => discard([file.path])}
                  />
                </>
              ))}
            </SidebarGroup>
          )}

          {changeCount === 0 && (
            <p className="checkout-empty">No changes in {repo.info.repo === '.' ? 'your checkout' : checkoutRepoLabel(repo.info.repo)}.</p>
          )}
        </>
      )}

      <SyncBar
        label={label}
        running={syncing}
        state={{
          upstream: repo.info.upstream,
          ahead: repo.info.ahead,
          behind: repo.info.behind,
          hasRemote: branches ? branches.remote.length > 0 || repo.info.upstream !== null : undefined,
          branchless: repo.info.detached || repo.info.branch === null,
        }}
        actions={{
          fetch: async () => { if (git) await fetchRepo(git); },
          pull: async () => { if (git) await pullBranch(git); },
          push: async () => { if (git) await pushBranch(git); },
        }}
      />
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

  if (!loaded) return <EmptyState className="checkout-state" icon={GitCommitHorizontal} title="Reading your checkout…" />;
  if (loaded.repos.length === 0) {
    return <EmptyState className="checkout-state" icon={GitBranch} title={loaded.error ?? 'No git repository in this workspace, so there is nothing to commit.'} />;
  }

  return (
    <div className="checkout">
      {loaded.error && <Notice tone="error">{loaded.error}</Notice>}
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
