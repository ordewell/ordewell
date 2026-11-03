import type { ConfirmValue, LandingBranchHeld } from '@ordewell/core';
import type { FrameApi } from '../../frame/api';
import { daemonHost } from '../../session/DaemonHost';
import { confirmWith } from '../../session/ConfirmDialog';
import { DaemonError, messageOf } from '../../session/daemon';
import { readLog, runGitAction, type BranchInfo, type Branches, type GitAction, type StashInfo } from './gitData';
import { plural, repoDisplay, splitUpstream } from './gitModel';
import { gitStoreFor, runName } from './gitStore';
import './git.css';

/*
 * The Git view's actions on the user's checkout (ADR-0062 G1–G7). Each one
 * says which repository, branch and worktree it acts on before it runs, sends
 * what it said so the daemon can check it against the repository now, and
 * words a refusal as what happened: a run holds the branch, the repository
 * moved since it was shown, git said no.
 */

export interface GitContext {
  api: FrameApi;
  repo: string;
  branches: Branches;
}

/** The three things every confirm names. */
interface Target {
  branch: string;
  /** What is notable about the branch: commits not merged, the upstream a pull reads. */
  branchNote?: string;
  /** The worktree, as a sentence: the person's own checkout is the only one an action acts on. */
  worktree?: string;
}

function checkoutPath(ctx: GitContext): string {
  return ctx.branches.worktrees.find((tree) => tree.main)?.path ?? repoDisplay(ctx.api.workspace, ctx.repo).path;
}

function TargetRows({ ctx, target }: { ctx: GitContext; target: Target }): JSX.Element {
  const repo = repoDisplay(ctx.api.workspace, ctx.repo);
  return (
    <dl className="git-target">
      <dt>Repository</dt>
      <dd>{repo.name} <span className="muted">{repo.path}</span></dd>
      <dt>Branch</dt>
      <dd>{target.branch}{target.branchNote && <span className="muted"> — {target.branchNote}</span>}</dd>
      <dt>Worktree</dt>
      <dd>{target.worktree ?? 'your checkout'} <span className="muted">{checkoutPath(ctx)}</span></dd>
    </dl>
  );
}

/** Asks one yes/no question that names its target; Cancel and Esc are no. */
async function ask(ctx: GitContext, question: { message: string; detail?: string; yes: string; target: Target }): Promise<boolean> {
  const answer = await confirmWith(
    { kind: 'git_action', message: question.message, ...(question.detail ? { detail: question.detail } : {}), choices: [{ id: 'yes', label: question.yes }] },
    <TargetRows ctx={ctx} target={question.target} />,
  );
  return answer === 'yes';
}

const BANNER = 'git-action';

function say(ctx: GitContext, tone: 'warning' | 'error', title: string, body?: string): void {
  const off = ctx.api.showBanner({ id: BANNER, tone, title, ...(body ? { body } : {}), actions: [{ label: 'Dismiss', run: () => off() }] });
}

/** A live run holds this branch: said in words, with the way to the run (ADR-0062 G7). */
async function refuse(ctx: GitContext, verb: string, held: LandingBranchHeld): Promise<void> {
  const store = gitStoreFor(ctx.api);
  const runs = await store.runsFor([held]);
  const run = runName(runs, held);
  const answer = await confirmWith(
    {
      kind: 'git_landing_branch_held',
      message: `Can’t ${verb} ${held.branch}`,
      detail: `${run[0]!.toUpperCase()}${run.slice(1)} is live, and it lands on ${held.branch}. Switching or deleting it now would land the run’s work somewhere else. Wait for the run to finish, or stop it first.`,
      choices: [{ id: 'open', label: 'Open run' }],
    },
    <TargetRows ctx={ctx} target={{ branch: `${run} lands here`, worktree: 'your checkout' }} />,
  );
  if (answer !== 'open') return;
  await openRun(ctx.api, held);
}

/** Opens the run a branch belongs to, and its task when the branch is a task's, in the Plan view. */
export async function openRun(api: FrameApi, owner: { sessionId: string; taskId?: string }): Promise<void> {
  const host = daemonHost(api.workspace);
  if (host.sessionId !== owner.sessionId) await host.open(owner.sessionId);
  api.showActivity('plan');
  if (owner.taskId) host.openTask(owner.taskId, 'details');
}

type Outcome = { done: true } | { stale: { field: string; shown: ConfirmValue; now: ConfirmValue } } | { done: false };

function staleOf(body: unknown): { field: string; shown: ConfirmValue; now: ConfirmValue } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const stale: unknown = Reflect.get(body, 'confirmStale');
  if (typeof stale !== 'object' || stale === null || typeof Reflect.get(stale, 'field') !== 'string') return undefined;
  return { field: Reflect.get(stale, 'field') as string, shown: (Reflect.get(stale, 'shown') ?? null) as ConfirmValue, now: (Reflect.get(stale, 'now') ?? null) as ConfirmValue };
}

function heldOf(body: unknown): LandingBranchHeld | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const held: unknown = Reflect.get(body, 'landingBranchHeld');
  if (typeof held !== 'object' || held === null) return undefined;
  const { sessionId, runId, repo, branch } = held as Record<string, unknown>;
  return typeof sessionId === 'string' && typeof runId === 'string' && typeof repo === 'string' && typeof branch === 'string' ? { sessionId, runId, repo, branch } : undefined;
}

/**
 * Sends one action. `verb` completes "Can’t …" and "Could not …"; `done` is
 * what is announced. A refusal is shown here and answered as `done: false`,
 * except a stale confirm, which the caller draws again with what is there now.
 */
async function perform(ctx: GitContext, action: GitAction, verb: string, done: string): Promise<Outcome> {
  const store = gitStoreFor(ctx.api);
  try {
    const result = await runGitAction(ctx.api.workspace, ctx.repo, action);
    await store.refresh(ctx.repo);
    ctx.api.announce(done);
    if (result.warning) say(ctx, 'warning', done, result.warning);
    return { done: true };
  } catch (error) {
    if (error instanceof DaemonError) {
      const held = error.code === 'landing_branch_held' ? heldOf(error.body) : undefined;
      if (held) { await refuse(ctx, verb, held); return { done: false }; }
      const stale = error.code === 'confirm_stale' ? staleOf(error.body) : undefined;
      if (stale) return { stale };
      // A stash that is gone, a branch Ordewell made, git's own refusal: the lists may have moved, so they are read again.
      void store.refresh(ctx.repo);
      say(ctx, 'error', error.code === 'git_failed' ? `Git could not ${verb}` : `Could not ${verb}`, error.message);
      return { done: false };
    }
    say(ctx, 'error', `Could not ${verb}`, messageOf(error));
    return { done: false };
  }
}

const MAX_REDRAWS = 3;

export async function switchBranch(ctx: GitContext, branch: string): Promise<void> {
  const from = ctx.branches.current ?? 'a detached HEAD';
  const ok = await ask(ctx, {
    message: `Switch ${from} to ${branch}?`,
    detail: 'Your uncommitted changes come with you when they fit the other branch; git refuses the switch when they do not.',
    yes: `Switch to ${branch}`,
    target: { branch: `${from} → ${branch}` },
  });
  if (!ok) return;
  await perform(ctx, { route: 'git.switch', branch }, `switch away from ${from}`, `Switched ${repoDisplay(ctx.api.workspace, ctx.repo).name} to ${branch}.`);
}

/** Whether deleting `branch` would drop commits no other branch holds: a guess the daemon checks, and corrects when it is wrong. */
async function guessUnmerged(ctx: GitContext, branch: BranchInfo): Promise<boolean> {
  if (branch.upstream) return branch.ahead > 0;
  try {
    const page = await readLog(ctx.api.workspace, ctx.repo, { limit: 200 });
    return !page.commits.some((commit) => commit.sha === branch.sha);
  } catch {
    return true;
  }
}

export async function deleteBranch(ctx: GitContext, name: string, redraw?: { unmerged: boolean; note: string; times: number }): Promise<void> {
  const branch = ctx.branches.local.find((b) => b.name === name);
  if (!branch) return;
  const unmerged = redraw?.unmerged ?? await guessUnmerged(ctx, branch);
  const into = ctx.branches.current ?? 'HEAD';
  const ok = await ask(ctx, {
    message: `Delete branch ${name}?`,
    detail: [
      redraw?.note,
      unmerged
        ? 'Its commits are not all merged elsewhere. Deleting it leaves them reachable only through the reflog.'
        : 'Everything on it is merged, so deleting it loses no commits.',
    ].filter(Boolean).join(' '),
    yes: `Delete ${name}`,
    target: { branch: name, branchNote: unmerged ? `commits not merged into ${into}` : `merged into ${into}`, worktree: 'your checkout (not checked out here)' },
  });
  if (!ok) return;
  const outcome = await perform(ctx, { route: 'git.branchDelete', branch: name, unmerged }, `delete ${name}`, `Deleted ${name}.`);
  if ('stale' in outcome && (redraw?.times ?? 0) < MAX_REDRAWS) {
    const now = typeof outcome.stale.now === 'boolean' ? outcome.stale.now : unmerged;
    await gitStoreFor(ctx.api).refresh(ctx.repo);
    await deleteBranch(ctx, name, { unmerged: now, note: 'It changed since you looked: the repository holds something different now.', times: (redraw?.times ?? 0) + 1 });
  } else if ('stale' in outcome) {
    say(ctx, 'error', `Could not delete ${name}`, 'The repository keeps changing under it. Try again once it settles.');
  }
}

export async function createBranch(ctx: GitContext, name: string, from: string, switchTo: boolean): Promise<boolean> {
  const outcome = await perform(
    ctx,
    { route: 'git.branch', name, from, switch: switchTo },
    `create ${name}`,
    switchTo ? `Created ${name} from ${from} and switched to it.` : `Created ${name} from ${from}.`,
  );
  return 'done' in outcome && outcome.done;
}

export async function stashChanges(ctx: GitContext, message: string): Promise<void> {
  const branch = ctx.branches.current ?? 'a detached HEAD';
  const text = message.trim();
  const ok = await ask(ctx, {
    message: `Stash your changes on ${branch}?`,
    detail: text ? `Saved as “${text}”. Your checkout goes back to the last commit.` : 'Your checkout goes back to the last commit; the stash keeps what you had.',
    yes: 'Stash changes',
    target: { branch },
  });
  if (!ok) return;
  await perform(ctx, { route: 'git.stash', ...(text ? { message: text } : {}) }, 'stash your changes', 'Stashed your changes.');
}

export async function popStash(ctx: GitContext, stash: StashInfo): Promise<void> {
  const branch = ctx.branches.current ?? 'a detached HEAD';
  const ok = await ask(ctx, {
    message: `Pop ${stash.ref}?`,
    detail: `“${stash.message}” is applied to your checkout and leaves the list once it applies cleanly.`,
    yes: `Pop ${stash.ref}`,
    target: { branch, branchNote: `applied on top of ${branch}` },
  });
  if (!ok) return;
  await perform(ctx, { route: 'git.stashPop', stash: stash.ref }, `pop ${stash.ref}`, `Popped ${stash.ref}.`);
}

export async function dropStash(ctx: GitContext, stash: StashInfo): Promise<void> {
  const branch = ctx.branches.current ?? 'a detached HEAD';
  const ok = await ask(ctx, {
    message: `Drop ${stash.ref}?`,
    detail: `“${stash.message}” is deleted from the stash list, and its changes with it.`,
    yes: `Drop ${stash.ref}`,
    target: { branch, branchNote: 'not changed' },
  });
  if (!ok) return;
  await perform(ctx, { route: 'git.stashDrop', stash: stash.ref }, `drop ${stash.ref}`, `Dropped ${stash.ref}.`);
}

/** The remote and branch a pull or push of the current branch means: its upstream's, else the first remote's under the branch's own name. */
export function syncTarget(branches: Branches): { remote: string; branch: string; tracked: boolean } | undefined {
  const current = branches.local.find((b) => b.current);
  if (!current) return undefined;
  if (current.upstream) return { ...splitUpstream(current.upstream), tracked: true };
  const remote = branches.remote[0]?.name.split('/')[0];
  return remote ? { remote, branch: current.name, tracked: false } : undefined;
}

export async function fetchRepo(ctx: GitContext): Promise<void> {
  const repo = repoDisplay(ctx.api.workspace, ctx.repo).name;
  await perform(ctx, { route: 'git.fetch' }, `fetch ${repo}`, `Fetched ${repo}.`);
}

async function sync(ctx: GitContext, which: 'pull' | 'push', redraw = 0): Promise<void> {
  const current = ctx.branches.local.find((b) => b.current);
  const target = syncTarget(ctx.branches);
  if (!current || !target) return;
  const upstream = `${target.remote}/${target.branch}`;
  const pull = which === 'pull';
  const count = pull ? current.behind : current.ahead;
  const ok = await ask(ctx, {
    message: pull ? `Pull ${upstream} into ${current.name}?` : `Push ${current.name} to ${upstream}?`,
    detail: pull
      ? 'Pulling changes the files in your checkout. Git refuses it when your uncommitted changes are in the way.'
      : target.tracked ? undefined : `${current.name} has no upstream yet, so this publishes it to ${target.remote}.`,
    yes: pull ? `Pull from ${target.remote}` : `Push to ${target.remote}`,
    target: {
      branch: current.name,
      branchNote: target.tracked
        ? `${plural(count, 'commit')} ${pull ? 'behind' : 'ahead of'} ${upstream}`
        : `${pull ? 'reads' : 'writes'} ${upstream}`,
    },
  });
  if (!ok) return;
  const action = { remote: target.remote, branch: target.branch };
  const outcome = await perform(
    ctx,
    pull ? { route: 'git.pull', ...action } : { route: 'git.push', ...action },
    `${which} ${upstream}`,
    pull ? `Pulled ${upstream} into ${current.name}.` : `Pushed ${current.name} to ${upstream}.`,
  );
  if ('stale' in outcome) {
    // The branch or its upstream moved while the question was open: ask again about what is true now.
    await gitStoreFor(ctx.api).refresh(ctx.repo);
    if (redraw < MAX_REDRAWS) await sync({ ...ctx, branches: gitStoreFor(ctx.api).getSnapshot().branches ?? ctx.branches }, which, redraw + 1);
    else say(ctx, 'error', `Could not ${which} ${upstream}`, 'The repository keeps changing under it. Try again once it settles.');
  }
}

export const pullBranch = (ctx: GitContext): Promise<void> => sync(ctx, 'pull');
export const pushBranch = (ctx: GitContext): Promise<void> => sync(ctx, 'push');
