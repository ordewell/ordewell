import { Fragment, useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, GitBranch, GitBranchPlus, History, Lock, Trash2, Undo2 } from 'lucide-react';
import { Archive, ArchiveRestore, RotateCcw } from 'lucide-react';
import { ArrowRightLeft } from 'lucide-react';
import { Cloud, RotateCw } from 'lucide-react';
import { Button, Icon, IconButton } from '@ordewell/ui/design';
import type { FrameApi, Unregister } from '../../frame/api';
import { useDisclosure } from '../../frame/store';
import { all } from '../Stub';
import { onCheckoutChange } from '../checkout/checkoutEvents';
import { scopeStoreFor } from '../scope/scopeStore';
import { LONG_LIST, MiddleText, Notice, SidebarGroup } from '../sidebarKit';
import {
  createBranch, deleteBranch, dropStash, fetchRepo, openRun, popStash, pullBranch, pushBranch, stashChanges, switchBranch, syncTarget,
  type GitContext,
} from './gitActions';
import type { BranchInfo, Branches, Owner, WorktreeInfo } from './gitData';
import { branchTree, plural, repoDisplay, runMark, tipAge, tipSummary, trackMark, type BranchNode } from './gitModel';
import { gitStoreFor, useGit, type GitStore, type RunInfo } from './gitStore';
import { HistoryList } from './HistoryList';
import { SyncBar, type SyncState } from './SyncBar';
import './git.css';

/*
 * The branches, stashes and worktrees of one repository, and the actions on
 * the person's own checkout (design W11, ADR-0062). Ordewell's branches are
 * listed to look at, never to switch to or delete: a run owns them. Branches
 * and History are two views of the same repository under the same branch and
 * sync controls; slash-delimited names fold into folders. Pressing a branch
 * browses its history here in the sidebar: it opens no tab and switches
 * nothing, so the main area keeps what the person had open.
 */

/** Which group a branch is listed in, and so what may be done to it here. */
type BranchKind = 'local' | 'ordewell' | 'remote';

function kindOf(branches: Branches, name: string): BranchKind | undefined {
  if (branches.local.some((b) => b.name === name)) return 'local';
  if (branches.ordewell.some((b) => b.name === name)) return 'ordewell';
  if (branches.remote.some((b) => b.name === name)) return 'remote';
  return undefined;
}

/** The marks a branch row carries while its history is the one the sidebar shows. */
function viewingProps(viewing: boolean): { 'aria-description'?: string } {
  return viewing ? { 'aria-description': 'Shown in History' } : {};
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

/**
 * The tip's age, or how far a branch is from its upstream, for the row's one
 * rest value. A diverged branch shows ↓↑ and any other its age, never both:
 * a slot that holds one short value keeps the same width whichever the row
 * shows, so the name does not reflow from row to row or under the pointer
 * (O4 and Layout rule 4), and at the sidebar's 240 px minimum two values side
 * by side would take the room the name needs. A diverged branch is the one
 * whose count is the news; the age is still in its tooltip.
 */
function RestNote({ branch }: { branch: BranchInfo }): JSX.Element | null {
  const mark = trackMark(branch);
  if (mark) return <span className="srow-note" aria-label={`${plural(branch.behind, 'commit')} behind, ${plural(branch.ahead, 'commit')} ahead`}>{mark}</span>;
  const age = tipAge(branch);
  return age ? <span className="srow-note" aria-hidden="true">{age}</span> : null;
}

/** The name, then the tip's subject and age: a row's tooltip and, through `aria-describedby`, its description. */
const branchTitle = (branch: BranchInfo, lead = branch.name): string => [lead, tipSummary(branch)].filter(Boolean).join('\n');

/*
 * A branch of the person's own. Past its name sits one trailing slot
 * (sidebarKit.css .srow-trail): at rest it shows RestNote, and under the
 * pointer or keyboard focus Switch and Delete take the same box, so the name
 * gives up only the wider of the two.
 */
function LocalRow({ ctx, branch, viewing, label = branch.name, depth = 0 }: { ctx: GitContext; branch: BranchInfo; viewing: boolean; label?: string; depth?: number }): JSX.Element {
  const held = runMark(branch);
  const hold = branch.landingFor && held ? `A live run lands on ${branch.name}` : undefined;
  const tip = tipSummary(branch);
  const tipId = useId();
  return (
    <li className={`srow git-branch${viewing ? ' git-viewing' : ''}`} style={indent(depth)} aria-current={branch.current ? 'true' : undefined}>
      <button type="button" className="srow-main" aria-label={branch.name} {...viewingProps(viewing)} aria-describedby={tip ? tipId : undefined} title={branchTitle(branch, branch.upstream ? `${branch.name} tracks ${branch.upstream}` : branch.name)} onClick={() => gitStoreFor(ctx.api).browse(ctx.repo, branch.name)}>
        <span className="git-lead">{branch.current ? <Icon icon={Check} size={14} /> : <Icon icon={GitBranch} size={14} />}</span>
        <MiddleText className="srow-label" text={label} />
      </button>
      {tip && <span id={tipId} hidden>{tip}</span>}
      {hold && <span className="git-lock" title={hold}><Icon icon={Lock} size={12} /><span>{held}</span></span>}
      <span className="srow-trail">
        <span className="srow-rest"><RestNote branch={branch} /></span>
        {!branch.current && (
          <span className="srow-actions">
            <IconButton icon={ArrowRightLeft} label={`Switch to ${branch.name}`} onClick={() => void switchBranch(ctx, branch.name)} />
            <IconButton icon={Trash2} label={`Delete ${branch.name}`} onClick={() => void deleteBranch(ctx, branch.name)} />
          </span>
        )}
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

/** The stash form, opened by the archive action in the Stashes header; Esc closes it and hands focus back to that action. */
function NewStash({ ctx, close }: { ctx: GitContext; close(): void }): JSX.Element {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    void stashChanges(ctx, message).then(close);
  };
  return (
    <form className="sform" aria-label="Stash changes" onSubmit={submit} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
    }}>
      <input type="text" className="frame-input" autoFocus aria-label="Stash message" placeholder="Message (optional)" value={message} onChange={(event) => setMessage(event.target.value)} />
      <div className="sform-actions">
        <Button type="submit" size="sm" variant="primary" disabled={busy}>Stash changes</Button>
        <Button size="sm" onClick={close}>Cancel</Button>
      </div>
    </form>
  );
}

function Stashes({ ctx }: { ctx: GitContext }): JSX.Element {
  const [creating, setCreating] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { stashes } = ctx.branches;
  const close = (): void => { setCreating(false); trigger.current?.focus(); };
  return (
    <>
      {/* Outside the group, as New branch is: a folded Stashes must still show the form its action opened. */}
      {creating && <NewStash ctx={ctx} close={close} />}
      <SidebarGroup
        title="Stashes"
        count={stashes.length}
        startOpen={stashes.length <= LONG_LIST}
        actions={<IconButton ref={trigger} icon={Archive} label="New stash" onClick={() => setCreating(true)} />}
      >
        {stashes.length === 0 ? <p className="git-hint">No stashes.</p> : (
          <ul className="git-list">
            {stashes.map((stash) => (
              <li key={stash.sha} className="srow git-stash">
                <span className="srow-main srow-plain git-stash-main" title={`${stash.ref}: ${stash.message}`}>
                  <MiddleText className="git-stash-message" text={stash.message} />
                  <span className="git-stash-ref">{stash.ref}</span>
                </span>
                {/* Always shown, not on hover: a hidden control cannot be reached by Tab. */}
                <span className="srow-actions">
                  <IconButton icon={ArchiveRestore} label={`Pop ${stash.ref}`} onClick={() => void popStash(ctx, stash)} />
                  <IconButton icon={Trash2} label={`Drop ${stash.ref}`} onClick={() => void dropStash(ctx, stash)} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </SidebarGroup>
    </>
  );
}

/**
 * Where a worktree sits, from the repository's own folder: inside it as `.ordewell/worktrees/…`, beside it as `../name`.
 * The renderer knows no home directory, so one far from the repository is shown whole.
 */
function relativeTo(root: string, path: string): string {
  const slashed = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = slashed(root).split('/');
  const target = slashed(path).split('/');
  let shared = 0;
  while (shared < base.length && shared < target.length && base[shared] === target[shared]) shared += 1;
  const up = base.length - shared;
  // Nothing in common beyond the root of the disk, or too many levels up to read at a glance.
  if (shared < 2 || up > 2) return slashed(path);
  const rest = target.slice(shared);
  return [...Array<string>(up).fill('..'), ...rest].join('/') || '.';
}

/** An Ordewell worktree; the person's own checkout is the group at the top, so it is left out of this list. */
function WorktreeRow({ api, repo, tree, runs }: { api: FrameApi; repo: string; tree: WorktreeInfo; runs: Readonly<Record<string, RunInfo>> }): JSX.Element {
  const where = relativeTo(repoDisplay(api.workspace, repo).path, tree.path);
  return (
    <li className="srow git-worktree">
      <span className="srow-main srow-plain git-worktree-main" title={tree.path}>
        {tree.branch ? <MiddleText className="git-worktree-name" text={tree.branch} /> : <span className="git-worktree-name">detached</span>}
        <MiddleText className="git-worktree-path" text={where} path />
      </span>
      {tree.owner && <OwnerLink api={api} runs={runs} owner={tree.owner} />}
    </li>
  );
}

/** A branch Ordewell owns: shown and diffed, with no switch or delete to press. */
function OrdewellRow({ api, repo, branch, runs, viewing, integration, label = branch.name, depth = 0 }: { api: FrameApi; repo: string; branch: BranchInfo; runs: Readonly<Record<string, RunInfo>>; viewing: boolean; integration?: boolean; label?: string; depth?: number }): JSX.Element {
  const note = integration ? 'integration' : 'read-only';
  return (
    <li className={`srow${viewing ? ' git-viewing' : ''}`} style={indent(depth)}>
      <button type="button" className="srow-main git-ordewell-main" aria-label={`${branch.name}, ${note}`} {...viewingProps(viewing)} title={`${branch.name}: Ordewell’s, read-only here`} onClick={() => gitStoreFor(api).browse(repo, branch.name)}>
        <span className="git-lead"><Icon icon={Lock} size={16} /></span>
        <span className="git-ordewell-text">
          <MiddleText text={label} />
          <span className="git-ordewell-note">{note}</span>
        </span>
      </button>
      {branch.owner && <OwnerLink api={api} runs={runs} owner={branch.owner} />}
    </li>
  );
}

function RemoteRow({ api, repo, branch, viewing, label = branch.name, depth = 0 }: { api: FrameApi; repo: string; branch: BranchInfo; viewing: boolean; label?: string; depth?: number }): JSX.Element {
  const tip = tipSummary(branch);
  const tipId = useId();
  return (
    <li className={`srow${viewing ? ' git-viewing' : ''}`} style={indent(depth)}>
      <button type="button" className="srow-main" aria-label={branch.name} {...viewingProps(viewing)} aria-describedby={tip ? tipId : undefined} title={branchTitle(branch)} onClick={() => gitStoreFor(api).browse(repo, branch.name)}>
        <span className="git-lead"><Icon icon={Cloud} size={16} /></span>
        <MiddleText className="srow-label" text={label} />
      </button>
      {tip && <span id={tipId} hidden>{tip}</span>}
      <span className="srow-trail"><span className="srow-rest"><RestNote branch={branch} /></span></span>
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
          <span className="git-lead"><Icon icon={open ? ChevronDown : ChevronRight} size={16} /></span>
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

/** Branches or History: two views of the one repository, the person's pick kept by the store for the window. */
function ViewSwitch({ git, history }: { git: GitStore; history: boolean }): JSX.Element {
  return (
    <div className="git-mode" role="group" aria-label="Git sidebar view">
      <button type="button" aria-pressed={!history} onClick={() => git.setView('branches')}><Icon icon={GitBranch} size={16} />Branches</button>
      <button type="button" aria-pressed={history} onClick={() => git.setView('history')}><Icon icon={History} size={16} />History</button>
    </div>
  );
}

/**
 * Whose history the History view shows: the checkout's, or a branch browsed
 * from the list. It names the checkout apart from the branch looked at, since
 * Fetch, Pull and Push act on the checkout whatever is browsed.
 */
function HistoryScope({ git, ctx, viewed }: { git: GitStore; ctx: GitContext; viewed: string | undefined }): JSX.Element {
  const { branches, repo } = ctx;
  const checkout = branches.detached ? 'detached HEAD' : branches.current ?? 'no branch yet';
  const kind = viewed === undefined ? undefined : kindOf(branches, viewed);
  const hint = kind === 'ordewell' ? 'Ordewell’s branch, read-only here.'
    : kind === 'remote' ? 'A remote branch, read-only here.'
    : kind === 'local' ? `Browsing only: your checkout stays on ${checkout}.`
    : undefined;
  const group = (label: string, list: readonly BranchInfo[]): ReactNode => list.length > 0 && (
    <optgroup label={label}>{list.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}</optgroup>
  );
  return (
    <div className="git-scope">
      <div className="git-scope-row">
        <select
          className="ow-select frame-input git-scope-select"
          aria-label="History of"
          title={viewed ?? `Your checkout (${checkout})`}
          value={viewed ?? ''}
          onChange={(event) => git.browse(repo, event.target.value || undefined)}
        >
          <option value="">Your checkout ({checkout})</option>
          {group('Local', branches.local.filter((b) => !b.current))}
          {group('Ordewell', branches.ordewell)}
          {group('Remote', branches.remote)}
        </select>
        {viewed !== undefined && <IconButton icon={Undo2} label="Show your checkout’s history" onClick={() => git.browse(repo, undefined)} />}
      </div>
      {hint && <p className="git-hint git-scope-hint">{hint}</p>}
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

/** The groups' rows in their final height, so the list moves nothing when it arrives (checklist S1); still, with no spinner. */
function BranchesSkeleton(): JSX.Element {
  return (
    <div className="git-skeleton" role="status" aria-label="Loading branches…" aria-busy="true">
      {[[34, 62, 48], [40, 56]].map((widths, group) => (
        <Fragment key={group}>
          <div className="git-skeleton-row git-skeleton-head"><span className="git-skeleton-bar" style={{ width: '24%' }} /></div>
          {widths.map((width, row) => <div key={row} className="git-skeleton-row"><span className="git-skeleton-bar" style={{ width: `${width}%` }} /></div>)}
        </Fragment>
      ))}
    </div>
  );
}

function Sidebar({ api }: { api: FrameApi }): JSX.Element {
  const { git, state, repo, setRepo } = useGit(api);
  const [creating, setCreating] = useState(false);
  const newBranch = useRef<HTMLButtonElement>(null);
  const { branches } = state;
  const history = state.view === 'history';
  const multi = state.repos.length > 1;
  const ctx: GitContext | undefined = branches && state.repo === repo ? { api, repo, branches } : undefined;
  // A browsed branch the last read no longer lists is gone: the checkout's history stands in for it.
  const browsed = state.browsing[repo];
  const viewed = ctx && browsed !== undefined && kindOf(ctx.branches, browsed) ? browsed : undefined;
  // On Branches, the row History would show stands out, apart from the checked-out one.
  const isViewed = (name: string): boolean => name === viewed;

  // The checkout commits, stages and syncs too: its actions move the same branches, so this list reads again.
  useEffect(() => onCheckoutChange(() => { void git.refresh(repo); }), [git, repo]);

  const integration = branches?.ordewell.filter((b) => b.owner && !b.owner.taskId) ?? [];
  const others = branches?.ordewell.filter((b) => !(b.owner && !b.owner.taskId)) ?? [];
  const name = repoDisplay(api.workspace, repo).name;
  // The checkout is the group at the top, so the list holds only the worktrees Ordewell made.
  const trees = branches?.worktrees.filter((tree) => !tree.main) ?? [];
  const treeCount = trees.length + integration.length;

  return (
    <div className="git-side">
      <div className="git-side-head">
        <span className="git-side-name"><MiddleText text={name} tail={8} /></span>
        <IconButton icon={RotateCw} label={history ? 'Reload branches and history' : 'Reload branches'} title="Re-read the branches and history from disk" onClick={() => void git.refresh(repo, { history: true })} />
      </div>
      {multi && (
        <select className="ow-select frame-input git-repo" aria-label="Repository" value={repo} onChange={(event) => setRepo(event.target.value)}>
          {state.repos.map((r) => <option key={r.repo} value={r.repo}>{r.repo === '.' ? 'Workspace' : r.repo}{r.branch ? ` (${r.branch})` : ''}</option>)}
        </select>
      )}
      {state.error && (
        <div className="git-side-error">
          <Notice tone="error">{state.error}</Notice>
          <Button size="sm" icon={RotateCcw} disabled={state.loading} onClick={() => void git.refresh(repo)}>Try again</Button>
        </div>
      )}
      {!ctx && !state.error && <BranchesSkeleton />}
      {ctx && (
        <>
          <div className="git-current" role="group" aria-label="Your checkout">
            <SyncBar
              label={name}
              branch={ctx.branches.detached ? 'Detached HEAD' : ctx.branches.current ?? 'No branch yet'}
              state={syncStateOf(ctx)}
              running={state.syncing[repo]}
              actions={{ fetch: () => fetchRepo(ctx), pull: () => pullBranch(ctx), push: () => pushBranch(ctx) }}
            />
          </div>
          <ViewSwitch git={git} history={history} />

          {history ? (
            <>
              <HistoryScope git={git} ctx={ctx} viewed={viewed} />
              <HistoryList key={viewed ?? ''} api={api} repo={repo} at={viewed} branches={ctx.branches} />
            </>
          ) : (
            <>
              {/* Outside the group: a folded Local must still show the form its + opened. */}
              {creating && <NewBranch ctx={ctx} close={() => { setCreating(false); newBranch.current?.focus(); }} />}
              <SidebarGroup
                title="Local"
                count={ctx.branches.local.length}
                startOpen={ctx.branches.local.length <= LONG_LIST}
                actions={<IconButton ref={newBranch} icon={GitBranchPlus} label="New branch" onClick={() => setCreating(true)} />}
              >
                {ctx.branches.local.length === 0 ? <p className="git-hint">This repository has no branches yet.</p> : (
                  <BranchFolders branches={ctx.branches.local} scope={`${repo}:local`} leaf={(b, label, depth) => <LocalRow key={b.name} ctx={ctx} branch={b} viewing={isViewed(b.name)} label={label} depth={depth} />} />
                )}
              </SidebarGroup>

              {others.length > 0 && (
                <SidebarGroup title="Ordewell" count={others.length} startOpen={others.length <= LONG_LIST}>
                  <BranchFolders branches={others} scope={`${repo}:ordewell`} leaf={(b, label, depth) => <OrdewellRow key={b.name} api={api} repo={repo} branch={b} runs={state.runs} viewing={isViewed(b.name)} label={label} depth={depth} />} />
                </SidebarGroup>
              )}

              {treeCount > 0 && (
                <SidebarGroup title="Worktrees" count={treeCount} startOpen={treeCount <= LONG_LIST}>
                  <ul className="git-list">
                    {trees.map((tree) => <WorktreeRow key={tree.path} api={api} repo={repo} tree={tree} runs={state.runs} />)}
                    {integration.map((b) => <OrdewellRow key={b.name} api={api} repo={repo} branch={b} runs={state.runs} viewing={isViewed(b.name)} integration />)}
                  </ul>
                </SidebarGroup>
              )}

              {ctx.branches.remote.length > 0 && (
                <SidebarGroup title="Remote" count={ctx.branches.remote.length} startOpen={ctx.branches.remote.length <= LONG_LIST}>
                  <BranchFolders branches={ctx.branches.remote} scope={`${repo}:remote`} leaf={(b, label, depth) => <RemoteRow key={b.name} api={api} repo={repo} branch={b} viewing={isViewed(b.name)} label={label} depth={depth} />} />
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
    api.registerSidebar({ activity: 'git', id: 'branches', title: 'Git', ownsHeading: true, render: () => <Sidebar api={api} /> }),
    api.registerCommand({ id: 'git.fetch', title: 'Git: Fetch', enabled: () => !api.readOnly && context() !== undefined && !syncing(), run: () => { const ctx = context(); if (ctx) void fetchRepo(ctx); } }),
    api.registerCommand({ id: 'git.refresh', title: 'Git: Refresh branches', enabled: () => !api.readOnly, run: () => { const { repo } = store.getSnapshot(); if (repo !== undefined) void store.refresh(repo, { history: true }); } }),
    // Kept under its old id so a binding to it still works: the history it shows is the checkout's, in the sidebar, whatever was open there.
    api.registerCommand({ id: 'git.showGraph', title: 'Git: Show history', run: () => {
      store.browse(store.getSnapshot().repo ?? scopeStoreFor(api).getSnapshot().repo, undefined);
      api.showActivity('git');
    } }),
  );
}
