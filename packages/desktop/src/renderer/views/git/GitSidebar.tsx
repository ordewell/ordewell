import { useState, type FormEvent } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, GitBranchPlus, GitGraph, Lock, RefreshCw, Trash2 } from 'lucide-react';
import { Icon } from '@ordewell/ui/design';
import type { FrameApi, Unregister } from '../../frame/api';
import { all } from '../Stub';
import '../explorer/explorer.css';
import {
  createBranch, deleteBranch, dropStash, fetchRepo, openRun, popStash, pullBranch, pushBranch, stashChanges, switchBranch, syncTarget,
  type GitContext,
} from './gitActions';
import type { BranchInfo, Owner, WorktreeInfo } from './gitData';
import { commitsTabId, plural, repoDisplay, runMark, trackMark } from './gitModel';
import { gitStoreFor, useGit, type RunInfo } from './gitStore';
import './git.css';

/*
 * The branches, stashes and worktrees of one repository, and the actions on
 * the person's own checkout (design W11, ADR-0062). Ordewell's branches are
 * listed to look at, never to switch to or delete: a run owns them.
 */

function showGraph(api: FrameApi, repo: string, ref?: string): void {
  api.openTab({ kind: 'commits', id: commitsTabId(repo, ref), title: ref ? `Commits: ${ref}` : 'Commits' });
}

/** What a branch or worktree belongs to, as the sidebar words it: `run r7`, and the task when it is one's. */
function ownerLabel(runs: Readonly<Record<string, RunInfo>>, owner: Owner): string {
  const task = owner.taskId ? runs[owner.sessionId]?.tasks.find((t) => t.id === owner.taskId) : undefined;
  return task ? `run ${owner.runId} · task #${task.order}` : `run ${owner.runId}`;
}

function OwnerLink({ api, runs, owner }: { api: FrameApi; runs: Readonly<Record<string, RunInfo>>; owner: Owner }): JSX.Element {
  const task = owner.taskId ? runs[owner.sessionId]?.tasks.find((t) => t.id === owner.taskId) : undefined;
  return (
    <button type="button" className="changes-link" title={task ? `Open task #${task.order}: ${task.title}` : `Open run ${owner.runId}`} onClick={() => void openRun(api, owner)}>
      {ownerLabel(runs, owner)}
    </button>
  );
}

function LocalRow({ ctx, branch }: { ctx: GitContext; branch: BranchInfo }): JSX.Element {
  const mark = trackMark(branch);
  const held = runMark(branch);
  return (
    <li className="git-row" aria-current={branch.current ? 'true' : undefined}>
      <button type="button" className="git-row-name" title={branch.upstream ? `${branch.name} tracks ${branch.upstream}` : branch.name} onClick={() => showGraph(ctx.api, ctx.repo, branch.name)}>
        {branch.current ? '● ' : ''}{branch.name}
      </button>
      {mark && <span className="git-row-note" aria-label={`${plural(branch.ahead, 'commit')} ahead, ${plural(branch.behind, 'commit')} behind`}>{mark}</span>}
      {branch.landingFor && held && <span className="git-lock" title={`A live run lands on ${branch.name}`}><Icon icon={Lock} size={12} /> {held}</span>}
      <span className="git-row-actions">
        {!branch.current && <button type="button" aria-label={`Switch to ${branch.name}`} title={`Switch to ${branch.name}`} onClick={() => void switchBranch(ctx, branch.name)}>Switch</button>}
        {!branch.current && (
          <button type="button" aria-label={`Delete ${branch.name}`} title={`Delete ${branch.name}`} onClick={() => void deleteBranch(ctx, branch.name)}>
            <Icon icon={Trash2} size={12} />
          </button>
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
    <form className="git-form" aria-label="New branch" onSubmit={submit}>
      <label>Name<input className="frame-input" autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>
        From
        <select className="frame-input" value={from} onChange={(event) => setFrom(event.target.value)}>
          {[...ctx.branches.local, ...ctx.branches.remote].map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
        </select>
      </label>
      <label className="git-check"><input type="checkbox" checked={switchTo} onChange={(event) => setSwitchTo(event.target.checked)} /> Switch to it</label>
      <p className="muted">Creates {name.trim() || 'the branch'} from {from} in {repo}{switchTo ? ' and switches your checkout to it' : ''}.</p>
      <div className="git-form-actions">
        <button type="submit" className="ft-button ft-primary" disabled={!name.trim() || busy}>Create branch</button>
        <button type="button" className="ft-button" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}

function Stashes({ ctx }: { ctx: GitContext }): JSX.Element {
  const [message, setMessage] = useState('');
  return (
    <>
      <h3 className="git-heading">Stashes</h3>
      <form className="git-stash-new" aria-label="Stash changes" onSubmit={(event) => { event.preventDefault(); void stashChanges(ctx, message).then(() => setMessage('')); }}>
        <input className="frame-input" aria-label="Stash message" placeholder="Message (optional)" value={message} onChange={(event) => setMessage(event.target.value)} />
        <button type="submit" className="ft-button">Stash changes</button>
      </form>
      {ctx.branches.stashes.length === 0 ? <p className="changes-note">No stashes.</p> : (
        <ul className="git-list">
          {ctx.branches.stashes.map((stash) => (
            <li key={stash.sha} className="git-row">
              <span className="git-row-name" title={stash.message}>{stash.ref}: {stash.message}</span>
              <span className="git-row-actions">
                <button type="button" aria-label={`Pop ${stash.ref}`} onClick={() => void popStash(ctx, stash)}>Pop</button>
                <button type="button" aria-label={`Drop ${stash.ref}`} onClick={() => void dropStash(ctx, stash)}>Drop</button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function WorktreeRow({ api, tree, runs }: { api: FrameApi; tree: WorktreeInfo; runs: Readonly<Record<string, RunInfo>> }): JSX.Element {
  return (
    <li className="git-row">
      <span className="git-row-name" title={tree.path}>
        {tree.main ? 'Your checkout' : tree.branch ?? 'detached'}
        <span className="muted"> {tree.path}</span>
      </span>
      {tree.owner && <OwnerLink api={api} runs={runs} owner={tree.owner} />}
    </li>
  );
}

function Sidebar({ api }: { api: FrameApi }): JSX.Element {
  const { git, state, repo, setRepo } = useGit(api);
  const [creating, setCreating] = useState(false);
  const { branches } = state;
  const multi = state.repos.length > 1;
  const ctx: GitContext | undefined = branches && state.repo === repo ? { api, repo, branches } : undefined;
  const current = branches?.local.find((b) => b.current);
  const target = branches ? syncTarget(branches) : undefined;
  const integration = branches?.ordewell.filter((b) => b.owner && !b.owner.taskId) ?? [];
  const others = branches?.ordewell.filter((b) => !(b.owner && !b.owner.taskId)) ?? [];

  return (
    <div className="git-side">
      <div className="ex-head">
        <span>{repoDisplay(api.workspace, repo).name}</span>
        <button type="button" className="ex-icon" title="Refresh" aria-label="Refresh the branches" onClick={() => void git.refresh(repo)}>
          <Icon icon={RefreshCw} size={12} />
        </button>
      </div>
      {multi && (
        <select className="ex-repo frame-input" aria-label="Repository" value={repo} onChange={(event) => setRepo(event.target.value)}>
          {state.repos.map((r) => <option key={r.repo} value={r.repo}>{r.repo === '.' ? 'Workspace' : r.repo}{r.branch ? ` (${r.branch})` : ''}</option>)}
        </select>
      )}
      {state.error && <p className="changes-note error" role="alert">{state.error}</p>}
      {!ctx && !state.error && <p className="changes-note">Loading…</p>}
      {ctx && (
        <>
          <div className="git-current">
            <div className="git-current-name">
              <span>{ctx.branches.detached ? 'Detached HEAD' : ctx.branches.current ?? 'No branch yet'}</span>
              {current && trackMark(current) && <span className="git-track">{trackMark(current)}{current.upstream ? ` ${current.upstream}` : ''}</span>}
            </div>
            <div className="git-sync">
              <button type="button" className="ft-button" onClick={() => void fetchRepo(ctx)}>Fetch</button>
              <button type="button" className="ft-button" disabled={!target} title={target ? `Pull ${target.remote}/${target.branch}` : 'No remote to pull from'} onClick={() => void pullBranch(ctx)}>
                <Icon icon={ArrowDownToLine} size={12} /> Pull
              </button>
              <button type="button" className="ft-button" disabled={!target} title={target ? `Push to ${target.remote}/${target.branch}` : 'No remote to push to'} onClick={() => void pushBranch(ctx)}>
                <Icon icon={ArrowUpFromLine} size={12} /> Push
              </button>
              <button type="button" className="ft-button" onClick={() => showGraph(api, repo)}><Icon icon={GitGraph} size={12} /> Commits</button>
            </div>
          </div>

          <h3 className="git-heading">
            Local
            <button type="button" className="ex-icon" aria-label="New branch" title="New branch" onClick={() => setCreating(true)}><Icon icon={GitBranchPlus} size={12} /></button>
          </h3>
          {creating && <NewBranch ctx={ctx} close={() => setCreating(false)} />}
          <ul className="git-list">{ctx.branches.local.map((b) => <LocalRow key={b.name} ctx={ctx} branch={b} />)}</ul>

          {others.length > 0 && (
            <>
              <h3 className="git-heading">Ordewell</h3>
              <ul className="git-list">
                {others.map((b) => <OrdewellRow key={b.name} api={api} repo={repo} branch={b} runs={state.runs} />)}
              </ul>
            </>
          )}

          <h3 className="git-heading">Worktrees</h3>
          <ul className="git-list">
            {ctx.branches.worktrees.map((tree) => <WorktreeRow key={tree.path} api={api} tree={tree} runs={state.runs} />)}
            {integration.map((b) => <OrdewellRow key={b.name} api={api} repo={repo} branch={b} runs={state.runs} integration />)}
          </ul>

          {ctx.branches.remote.length > 0 && (
            <>
              <h3 className="git-heading">Remote</h3>
              <ul className="git-list">
                {ctx.branches.remote.map((b) => (
                  <li key={b.name} className="git-row">
                    <button type="button" className="git-row-name" onClick={() => showGraph(api, repo, b.name)}>{b.name}</button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <Stashes ctx={ctx} />
        </>
      )}
    </div>
  );
}

/** A branch Ordewell owns: shown and diffed, with no switch or delete to press. */
function OrdewellRow({ api, repo, branch, runs, integration }: { api: FrameApi; repo: string; branch: BranchInfo; runs: Readonly<Record<string, RunInfo>>; integration?: boolean }): JSX.Element {
  return (
    <li className="git-row">
      <button type="button" className="git-row-name" title={`${branch.name}: Ordewell’s, read-only here`} onClick={() => showGraph(api, repo, branch.name)}>
        {branch.name}
      </button>
      <span className="git-row-note">{integration ? 'integration' : 'read-only'}</span>
      {branch.owner && <OwnerLink api={api} runs={runs} owner={branch.owner} />}
    </li>
  );
}

export function register(api: FrameApi): Unregister {
  const store = gitStoreFor(api);
  const context = (): GitContext | undefined => {
    const { branches, repo } = store.getSnapshot();
    return branches && repo !== undefined ? { api, repo, branches } : undefined;
  };
  return all(
    api.registerSidebar({ activity: 'git', id: 'branches', title: 'Branches', render: () => <Sidebar api={api} /> }),
    api.registerCommand({ id: 'git.fetch', title: 'Git: Fetch', enabled: () => context() !== undefined, run: () => { const ctx = context(); if (ctx) void fetchRepo(ctx); } }),
    api.registerCommand({ id: 'git.refresh', title: 'Git: Refresh branches', run: () => { const { repo } = store.getSnapshot(); if (repo !== undefined) void store.refresh(repo); } }),
    api.registerCommand({ id: 'git.showGraph', title: 'Git: Show commit graph', enabled: () => store.getSnapshot().repo !== undefined, run: () => { const { repo } = store.getSnapshot(); if (repo !== undefined) showGraph(api, repo); } }),
  );
}
