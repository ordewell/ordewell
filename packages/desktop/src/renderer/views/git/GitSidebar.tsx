import { Fragment, useEffect, useId, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDownToLine, Check, ChevronDown, ChevronRight, GitBranch, GitBranchPlus, GitGraph, History, Lock, RefreshCw, Trash2 } from 'lucide-react';
import { Button, EmptyState, Icon, IconButton } from '@ordewell/ui/design';
import type { FrameApi, Unregister } from '../../frame/api';
import { useDisclosure } from '../../frame/store';
import { all } from '../Stub';
import { onCheckoutChange } from '../checkout/checkoutEvents';
import { LONG_LIST, MiddleText, Notice, SidebarGroup } from '../sidebarKit';
import {
  createBranch, deleteBranch, dropStash, fetchRepo, openRun, popStash, pullBranch, pushBranch, stashChanges, switchBranch, syncTarget,
  type GitContext,
} from './gitActions';
import type { BranchInfo, Owner, WorktreeInfo } from './gitData';
import { branchTree, commitsTabId, plural, repoDisplay, runMark, trackMark, type BranchNode } from './gitModel';
import { gitStoreFor, useGit, type RunInfo } from './gitStore';
import { HistoryList } from './HistoryList';
import { SyncBar, type SyncState } from './SyncBar';
import './git.css';

/*
 * The branches, stashes and worktrees of one repository, and the actions on
 * the person's own checkout (design W11, ADR-0062). Ordewell's branches are
 * listed to look at, never to switch to or delete: a run owns them. Branches
 * and History are two views of the same repository under the same branch and
 * sync controls; slash-delimited names fold into folders.
 */

/** A branch row only reveals its history: a preview tab, replaced by the next one, so looking never piles tabs up. */
function showGraph(api: FrameApi, repo: string, ref?: string, preview = true): void {
  api.openTab({ kind: 'commits', id: commitsTabId(repo, ref), title: ref ? `Commits: ${ref}` : 'Commits' }, { preview });
}

/** What a branch or worktree belongs to, as the sidebar words it: `run r7`, and the task when it is one's. */
function ownerLabel(runs: Readonly<Record<string, RunInfo>>, owner: Owner): string {
  const task = owner.taskId ? runs[owner.sessionId]?.tasks.find((t) => t.id === owner.taskId) : undefined;
  return task ? `run ${owner.runId} · task #${task.order}` : `run ${owner.runId}`;
}

function OwnerLink({ api, runs, owner }: { api: FrameApi; runs: Readonly<Record<string, RunInfo>>; owner: Owner }): JSX.Element {
  const task = owner.taskId ? runs[owner.sessionId]?.tasks.find((t) => t.id === owner.taskId) : undefined;
  const title = task ? `Open task #${task.order}: ${task.title}` : `Open run ${owner.runId}`;
  return (
    <button type="button" className="git-owner" title={title} onClick={() => void openRun(api, owner)}>
      <span className="git-owner-text">{ownerLabel(runs, owner)}</span>
    </button>
  );
}

/** How deep a row sits in its folders, for its indent. */
const indent = (depth: number): CSSProperties => ({ '--git-depth': depth } as CSSProperties);

function LocalRow({ ctx, branch, label = branch.name, depth = 0 }: { ctx: GitContext; branch: BranchInfo; label?: string; depth?: number }): JSX.Element {
  const mark = trackMark(branch);
  const held = runMark(branch);
  const hold = branch.landingFor && held ? `A live run lands on ${branch.name}` : undefined;
  return (
    <li className="srow git-branch" style={indent(depth)} aria-current={branch.current ? 'true' : undefined}>
      <button type="button" className="srow-main" aria-label={branch.name} title={branch.upstream ? `${branch.name} tracks ${branch.upstream}` : branch.name} onClick={() => showGraph(ctx.api, ctx.repo, branch.name)}>
        <span className="git-lead">{branch.current ? <Icon icon={Check} size={14} /> : <Icon icon={GitBranch} size={14} />}</span>
        <MiddleText className="srow-label" text={label} />
      </button>
      {mark && <span className="srow-note" aria-label={`${plural(branch.ahead, 'commit')} ahead, ${plural(branch.behind, 'commit')} behind`}>{mark}</span>}
      {hold && <span className="git-lock" title={hold}><Icon icon={Lock} size={12} /><span>{held}</span></span>}
      <span className="srow-actions">
        {!branch.current && <IconButton icon={ArrowDownToLine} label={`Switch to ${branch.name}`} onClick={() => void switchBranch(ctx, branch.name)} />}
        {!branch.current && <IconButton icon={Trash2} label={`Delete ${branch.name}`} onClick={() => void deleteBranch(ctx, branch.name)} />}
      </span>
    </li>
  );
}

function NewBranch({ ctx, close }: { ctx: GitContext; close(): void }): JSX.Element {
  const [name, setName] = useState('');
  const [from, setFrom] = useState(ctx.branches.current ?? ctx.branches.local[0]?.name ?? 'HEAD');
  const [switchTo, setSwitchTo] = useState(true);
  const [busy, setBusy] = useState(false);
  const repo = repoDisplay(ctx.api.workspace, ctx.repo).name;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    void createBranch(ctx, name.trim(), from, switchTo).then((made) => { if (made) close(); else setBusy(false); });
  };
  return (
    <form className="sform" aria-label="New branch" onSubmit={submit} onKeyDown={(event) => {
      // The form is the topmost layer: its Esc must not also close the drawer it sits in.
      if (event.key === 'Escape') { event.preventDefault(); close(); }
    }}>
      <label>Name<input type="text" className="frame-input" autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>
        From
        <select className="ow-select frame-input" value={from} onChange={(event) => setFrom(event.target.value)}>
          {[...ctx.branches.local, ...ctx.branches.remote].map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
        </select>
      </label>
      <label className="sform-check"><input type="checkbox" checked={switchTo} onChange={(event) => setSwitchTo(event.target.checked)} /> Switch to it</label>
      <p className="git-hint">Creates {name.trim() || 'the branch'} from {from} in {repo}{switchTo ? ' and switches your checkout to it' : ''}.</p>
      <div className="sform-actions">
        <Button type="submit" size="sm" variant="primary" disabled={!name.trim() || busy}>Create branch</Button>
        <Button size="sm" onClick={close}>Cancel</Button>
      </div>
    </form>
  );
}

function Stashes({ ctx }: { ctx: GitContext }): JSX.Element {
  const [message, setMessage] = useState('');
  const { stashes } = ctx.branches;
  return (
    <SidebarGroup title="Stashes" count={stashes.length} startOpen={stashes.length <= LONG_LIST}>
      <form className="sform" aria-label="Stash changes" onSubmit={(event) => { event.preventDefault(); void stashChanges(ctx, message).then(() => setMessage('')); }}>
        <input type="text" className="frame-input" aria-label="Stash message" placeholder="Message (optional)" value={message} onChange={(event) => setMessage(event.target.value)} />
        <div className="sform-actions"><Button type="submit" size="sm">Stash changes</Button></div>
      </form>
      {stashes.length === 0 ? <p className="git-hint">No stashes.</p> : (
        <ul className="git-list">
          {stashes.map((stash) => (
            <li key={stash.sha} className="srow">
              <span className="srow-main srow-plain" title={`${stash.ref}: ${stash.message}`}>
                <span className="srow-note git-stash-ref">{stash.ref}</span>
                <MiddleText className="srow-label" text={stash.message} />
              </span>
              <span className="srow-actions">
                <Button size="sm" aria-label={`Pop ${stash.ref}`} onClick={() => void popStash(ctx, stash)}>Pop</Button>
                <IconButton icon={Trash2} label={`Drop ${stash.ref}`} onClick={() => void dropStash(ctx, stash)} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </SidebarGroup>
  );
}

function WorktreeRow({ api, tree, runs }: { api: FrameApi; tree: WorktreeInfo; runs: Readonly<Record<string, RunInfo>> }): JSX.Element {
  return (
    <li className="srow git-worktree">
      <span className="srow-main srow-plain git-worktree-main" title={tree.path}>
        <span className="git-worktree-name">{tree.main ? 'Your checkout' : tree.branch ?? 'detached'}</span>
        <MiddleText className="git-worktree-path" text={tree.path} tail={20} />
      </span>
      {tree.owner && <OwnerLink api={api} runs={runs} owner={tree.owner} />}
    </li>
  );
}

/** A branch Ordewell owns: shown and diffed, with no switch or delete to press. */
function OrdewellRow({ api, repo, branch, runs, integration, label = branch.name, depth = 0 }: { api: FrameApi; repo: string; branch: BranchInfo; runs: Readonly<Record<string, RunInfo>>; integration?: boolean; label?: string; depth?: number }): JSX.Element {
  const note = integration ? 'integration' : 'read-only';
  return (
    <li className="srow" style={indent(depth)}>
      <button type="button" className="srow-main git-ordewell-main" aria-label={`${branch.name}, ${note}`} title={`${branch.name}: Ordewell’s, read-only here`} onClick={() => showGraph(api, repo, branch.name)}>
        <span className="git-lead"><Icon icon={Lock} size={14} /></span>
        <span className="git-ordewell-text">
          <MiddleText text={label} />
          <span className="git-ordewell-note">{note}</span>
        </span>
      </button>
      {branch.owner && <OwnerLink api={api} runs={runs} owner={branch.owner} />}
    </li>
  );
}

function RemoteRow({ api, repo, branch, label = branch.name, depth = 0 }: { api: FrameApi; repo: string; branch: BranchInfo; label?: string; depth?: number }): JSX.Element {
  return (
    <li className="srow" style={indent(depth)}>
      <button type="button" className="srow-main" aria-label={branch.name} title={branch.name} onClick={() => showGraph(api, repo, branch.name)}>
        <span className="git-lead"><Icon icon={GitBranch} size={14} /></span>
        <MiddleText className="srow-label" text={label} />
      </button>
    </li>
  );
}

type Leaf = (branch: BranchInfo, label: string, depth: number) => ReactNode;

/**
 * A folder of branches: the whole row turns it over, chevron and name alike,
 * and Right and Left open and close it as they do a folder elsewhere. It
 * keeps the person's choice; until there is one, it is open while it holds the
 * checked-out branch or its group is short enough to start open.
 */
function Folder({ node, depth, scope, short, leaf }: { node: Extract<BranchNode, { kind: 'folder' }>; depth: number; scope: string; short: boolean; leaf: Leaf }): JSX.Element {
  const [chosen, setOpen] = useDisclosure(`git:${scope}/${node.path}`);
  const open = chosen ?? (short || node.current);
  const body = useId();
  const keys = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== (open ? 'ArrowLeft' : 'ArrowRight')) return;
    event.preventDefault();
    setOpen(!open);
  };
  return (
    <li className="git-folder">
      <div className="srow" style={indent(depth)}>
        <button type="button" className="srow-main git-folder-main" aria-expanded={open} aria-controls={open ? body : undefined} title={`${node.path}/: ${plural(node.count, 'branch', 'branches')}`} onClick={() => setOpen(!open)} onKeyDown={keys}>
          <span className="git-lead"><Icon icon={open ? ChevronDown : ChevronRight} size={14} /></span>
          <MiddleText className="srow-label" text={node.label} />
          <span className="srow-note" aria-label={plural(node.count, 'branch', 'branches')}>{node.count}</span>
        </button>
      </div>
      {open && <ul id={body} className="git-list" aria-label={node.path}><Nodes nodes={node.children} depth={depth + 1} scope={scope} short={short} leaf={leaf} /></ul>}
    </li>
  );
}

function Nodes({ nodes, depth, scope, short, leaf }: { nodes: readonly BranchNode[]; depth: number; scope: string; short: boolean; leaf: Leaf }): JSX.Element {
  return (
    <>
      {nodes.map((node) => node.kind === 'folder'
        ? <Folder key={node.key} node={node} depth={depth} scope={scope} short={short} leaf={leaf} />
        : <Fragment key={node.key}>{leaf(node.branch, node.label, depth)}</Fragment>)}
    </>
  );
}

/** A group's branches in their folders; `scope` names the repository and the group, so a fold never lands on another's. */
function BranchFolders({ branches, scope, leaf }: { branches: readonly BranchInfo[]; scope: string; leaf: Leaf }): JSX.Element {
  return <ul className="git-list"><Nodes nodes={branchTree(branches)} depth={0} scope={scope} short={branches.length <= LONG_LIST} leaf={leaf} /></ul>;
}

/** Branches or History: two views of the one repository, the person's pick kept for the window like a sidebar's folds. */
function useHistoryView(): [boolean, (history: boolean) => void] {
  const [chosen, choose] = useDisclosure('git:history');
  return [chosen ?? false, choose];
}

function ViewSwitch({ history, choose }: { history: boolean; choose(history: boolean): void }): JSX.Element {
  return (
    <div className="git-mode" role="group" aria-label="Git sidebar view">
      <button type="button" aria-pressed={!history} onClick={() => choose(false)}><Icon icon={GitBranch} size={14} />Branches</button>
      <button type="button" aria-pressed={history} onClick={() => choose(true)}><Icon icon={History} size={14} />History</button>
    </div>
  );
}

function syncStateOf(ctx: GitContext): SyncState {
  const current = ctx.branches.local.find((b) => b.current);
  const target = syncTarget(ctx.branches);
  return {
    upstream: current?.upstream ?? null,
    ahead: current?.ahead ?? 0,
    behind: current?.behind ?? 0,
    hasRemote: ctx.branches.remote.length > 0 || target !== undefined,
    branchless: ctx.branches.detached || !current,
  };
}

function Sidebar({ api }: { api: FrameApi }): JSX.Element {
  const { git, state, repo, setRepo } = useGit(api);
  const [creating, setCreating] = useState(false);
  const [history, chooseView] = useHistoryView();
  const { branches } = state;
  const multi = state.repos.length > 1;
  const ctx: GitContext | undefined = branches && state.repo === repo ? { api, repo, branches } : undefined;

  // The checkout commits, stages and syncs too: its actions move the same branches, so this list reads again.
  useEffect(() => onCheckoutChange(() => { void git.refresh(repo); }), [git, repo]);

  const integration = branches?.ordewell.filter((b) => b.owner && !b.owner.taskId) ?? [];
  const others = branches?.ordewell.filter((b) => !(b.owner && !b.owner.taskId)) ?? [];
  const name = repoDisplay(api.workspace, repo).name;

  return (
    <div className="git-side">
      <div className="git-side-head">
        <span className="git-side-name"><MiddleText text={name} tail={8} /></span>
        <IconButton icon={RefreshCw} label="Refresh the branches" onClick={() => void git.refresh(repo)} />
      </div>
      {multi && (
        <select className="ow-select frame-input git-repo" aria-label="Repository" value={repo} onChange={(event) => setRepo(event.target.value)}>
          {state.repos.map((r) => <option key={r.repo} value={r.repo}>{r.repo === '.' ? 'Workspace' : r.repo}{r.branch ? ` (${r.branch})` : ''}</option>)}
        </select>
      )}
      {state.error && <Notice tone="error">{state.error}</Notice>}
      {!ctx && !state.error && <EmptyState className="git-state" icon={GitBranch} title="Loading the branches…" />}
      {ctx && (
        <>
          <div className="git-current">
            <div className="git-current-name">
              <Icon icon={GitBranch} size={14} />
              <MiddleText className="git-current-label" text={ctx.branches.detached ? 'Detached HEAD' : ctx.branches.current ?? 'No branch yet'} />
              <IconButton icon={GitGraph} label="Show the commit graph" onClick={() => showGraph(api, repo, undefined, false)} />
            </div>
            <SyncBar
              label={name}
              state={syncStateOf(ctx)}
              running={state.syncing[repo]}
              actions={{ fetch: () => fetchRepo(ctx), pull: () => pullBranch(ctx), push: () => pushBranch(ctx) }}
            />
          </div>
          <ViewSwitch history={history} choose={chooseView} />

          {history ? <HistoryList api={api} repo={repo} branches={ctx.branches} /> : (
            <>
              {/* Outside the group: a folded Local must still show the form its + opened. */}
              {creating && <NewBranch ctx={ctx} close={() => setCreating(false)} />}
              <SidebarGroup
                title="Local"
                count={ctx.branches.local.length}
                startOpen={ctx.branches.local.length <= LONG_LIST}
                actions={<IconButton icon={GitBranchPlus} label="New branch" onClick={() => setCreating(true)} />}
              >
                {ctx.branches.local.length === 0 ? <p className="git-hint">This repository has no branches yet.</p> : (
                  <BranchFolders branches={ctx.branches.local} scope={`${repo}:local`} leaf={(b, label, depth) => <LocalRow key={b.name} ctx={ctx} branch={b} label={label} depth={depth} />} />
                )}
              </SidebarGroup>

              {others.length > 0 && (
                <SidebarGroup title="Ordewell" count={others.length} startOpen={others.length <= LONG_LIST}>
                  <BranchFolders branches={others} scope={`${repo}:ordewell`} leaf={(b, label, depth) => <OrdewellRow key={b.name} api={api} repo={repo} branch={b} runs={state.runs} label={label} depth={depth} />} />
                </SidebarGroup>
              )}

              <SidebarGroup title="Worktrees" count={ctx.branches.worktrees.length + integration.length} startOpen={ctx.branches.worktrees.length + integration.length <= LONG_LIST}>
                <ul className="git-list">
                  {ctx.branches.worktrees.map((tree) => <WorktreeRow key={tree.path} api={api} tree={tree} runs={state.runs} />)}
                  {integration.map((b) => <OrdewellRow key={b.name} api={api} repo={repo} branch={b} runs={state.runs} integration />)}
                </ul>
              </SidebarGroup>

              {ctx.branches.remote.length > 0 && (
                <SidebarGroup title="Remote" count={ctx.branches.remote.length} startOpen={ctx.branches.remote.length <= LONG_LIST}>
                  <BranchFolders branches={ctx.branches.remote} scope={`${repo}:remote`} leaf={(b, label, depth) => <RemoteRow key={b.name} api={api} repo={repo} branch={b} label={label} depth={depth} />} />
                </SidebarGroup>
              )}

              <Stashes ctx={ctx} />
            </>
          )}
        </>
      )}
    </div>
  );
}

export function register(api: FrameApi): Unregister {
  const store = gitStoreFor(api);
  const context = (): GitContext | undefined => {
    const { branches, repo } = store.getSnapshot();
    return branches && repo !== undefined ? { api, repo, branches } : undefined;
  };
  const syncing = (): boolean => { const { repo, syncing: running } = store.getSnapshot(); return repo !== undefined && running[repo] !== undefined; };
  return all(
    api.registerSidebar({ activity: 'git', id: 'branches', title: 'Branches', render: () => <Sidebar api={api} /> }),
    api.registerCommand({ id: 'git.fetch', title: 'Git: Fetch', enabled: () => !api.readOnly && context() !== undefined && !syncing(), run: () => { const ctx = context(); if (ctx) void fetchRepo(ctx); } }),
    api.registerCommand({ id: 'git.refresh', title: 'Git: Refresh branches', enabled: () => !api.readOnly, run: () => { const { repo } = store.getSnapshot(); if (repo !== undefined) void store.refresh(repo); } }),
    api.registerCommand({ id: 'git.showGraph', title: 'Git: Show commit graph', enabled: () => store.getSnapshot().repo !== undefined, run: () => { const { repo } = store.getSnapshot(); if (repo !== undefined) showGraph(api, repo, undefined, false); } }),
  );
}
