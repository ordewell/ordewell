import { filesApi } from '../../files/api';
import { callDaemon, DaemonError, messageOf } from '../../session/daemon';
import { diffSides, parsePatch, type DiffSides, type FilePatch } from '../changes/changesModel';
import { parseCheckoutStatus, parseRepoInfo, type CheckoutStatus, type RepoCheckout } from './checkoutModel';

/*
 * The checkout group's reads and actions through the daemon (ADR-0064,
 * ADR-0062). Every answer is checked here; a refusal keeps its code so the
 * view can word `confirm_stale` and `pushed` as the design says.
 */

export type CheckoutDiff =
  | { kind: 'text'; sides: DiffSides; patch: FilePatch; patchText: string; untracked: boolean }
  | { kind: 'binary' }
  | { kind: 'unchanged' }
  | { kind: 'error'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One read of every repository's checkout state; a repository whose status failed still names itself. */
export async function readCheckout(workspace: string): Promise<RepoCheckout[]> {
  const repos = parseRepoInfo(await callDaemon('git.repos', { workspace }));
  if (!repos) throw new Error('The daemon sent repositories this app cannot read.');
  return Promise.all(repos.map(async (info) => {
    try {
      return { info, status: await readStatus(workspace, info.repo) };
    } catch (error) {
      return { info, status: null, error: describeGitError(error) };
    }
  }));
}

export async function readStatus(workspace: string, repo: string): Promise<CheckoutStatus> {
  const status = parseCheckoutStatus(await callDaemon('git.status', { workspace, repo, scope: 'checkout' }));
  if (!status) throw new Error('The daemon sent a status this app cannot read.');
  return status;
}

function body(workspace: string, repo: string): Record<string, unknown> {
  return { workspace, repo };
}

export async function stagePaths(workspace: string, repo: string, paths: readonly string[]): Promise<void> {
  await callDaemon('git.stage', {}, { ...body(workspace, repo), paths });
}

export async function unstagePaths(workspace: string, repo: string, paths: readonly string[]): Promise<void> {
  await callDaemon('git.unstage', {}, { ...body(workspace, repo), paths });
}

export async function stageHunks(workspace: string, repo: string, hunks: string): Promise<void> {
  await callDaemon('git.stage', {}, { ...body(workspace, repo), hunks });
}

export async function unstageHunks(workspace: string, repo: string, hunks: string): Promise<void> {
  await callDaemon('git.unstage', {}, { ...body(workspace, repo), hunks });
}

/** Commit in the checkout, amending only the commit the person was shown (ADR-0062 G3, G4). */
export async function commitCheckout(workspace: string, repo: string, message: string, amend: boolean, head: string | null): Promise<void> {
  await callDaemon('git.commit', {}, {
    ...body(workspace, repo),
    message,
    ...(amend && head !== null ? { amend: true, confirm: { head } } : {}),
  });
}

/** Discard the named files; the route checks the echo against what is still changed (G3). */
export async function discardPaths(workspace: string, repo: string, paths: readonly string[]): Promise<void> {
  await callDaemon('git.discard', {}, { ...body(workspace, repo), paths, confirm: { files: [...paths] } });
}

function lineCount(text: string): number[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return Array.from({ length: lines.length }, (_, i) => i + 1);
}

async function workingContent(workspace: string, repo: string, path: string): Promise<{ text: string } | 'binary' | undefined> {
  try {
    const content = await filesApi.content({ workspace, repo, scope: { kind: 'checkout' } }, path);
    if (content.kind === 'text') return { text: content.text };
    if (content.kind === 'binary') return 'binary';
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * One checkout file's two sides. Unstaged is the index against the working
 * tree; staged is HEAD against the index (ADR-0064 R5). An untracked file has
 * no diff to ask for: the whole file is the change.
 */
export async function readCheckoutDiff(
  workspace: string,
  repo: string,
  path: string,
  kind: 'staged' | 'unstaged',
): Promise<CheckoutDiff> {
  try {
    const data = await callDaemon('git.diff', { workspace, repo, scope: 'checkout', kind, path });
    if (!isRecord(data) || typeof data.patch !== 'string') throw new Error('The daemon sent a diff this app cannot read.');
    const patchText = data.patch;
    const patch = parsePatch(patchText);
    if (patch.binary) return { kind: 'binary' };
    if (patch.hunks.length === 0) {
      if (kind !== 'unstaged') return { kind: 'unchanged' };
      // git does not diff an untracked file: the working tree's whole file is the change.
      const content = await workingContent(workspace, repo, path);
      if (content === 'binary') return { kind: 'binary' };
      if (!content) return { kind: 'unchanged' };
      const empty: FilePatch = { hunks: [], binary: false, added: true, deleted: false, noNewline: { old: false, new: false } };
      const sides: DiffSides = { original: '', modified: content.text, lines: { original: [], modified: lineCount(content.text) }, partial: false };
      return { kind: 'text', sides, patch: empty, patchText: '', untracked: true };
    }
    let after: string | undefined;
    if (patch.deleted) after = '';
    else {
      const content = await workingContent(workspace, repo, path);
      if (content === 'binary') return { kind: 'binary' };
      if (content) after = content.text;
    }
    return { kind: 'text', sides: diffSides(patch, after), patch, patchText, untracked: false };
  } catch (error) {
    return { kind: 'error', message: describeGitError(error) };
  }
}

/** Git's refusal in the person's words, with the one code that changes what the view offers named. */
export function describeGitError(error: unknown): string {
  if (error instanceof DaemonError) {
    switch (error.code) {
      case 'pushed': return 'The last commit is already pushed, so amending it would rewrite history. Amend is unavailable.';
      case 'confirm_stale': return `What you confirmed changed while it was open. ${error.message}`;
      case 'landing_branch_held': return error.message;
      case 'not_checkout': return 'That is not your checkout: only your own working tree can be changed here.';
      case 'ordewell_branch': return 'That branch belongs to a run, so it changes only through the run.';
      case 'stale': return `The file changed on disk since it was read. ${error.message}`;
      default: return error.message;
    }
  }
  return messageOf(error);
}
