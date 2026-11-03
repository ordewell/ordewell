import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  ConfirmDifference, ConfirmValue, FileSaveRequest, GitActionResponse, GitBranchCreateRequest, GitBranchDeleteRequest,
  GitChangesRequest, GitCommitRequest, GitDiscardRequest, GitRemoteRequest, GitRepoInfo, GitStashRefRequest, GitStashRequest,
  GitSwitchRequest, LandingBranchHeld,
} from '../daemonContract';
import { augmentedPath } from '../utils/shellPath';
import { defaultExecFile, isAncestor, tryGit, type GitExecFn, type GitInvoker, type GitResult } from './gitExec';
import { SELF_REPO } from './isolationRecord';
import { interlock, type LandingMove, type LandingRun } from './landingInterlock';
import { type CheckoutScope, type WorkspaceReader } from './workspaceReader';

/**
 * A person's own git actions on their checkout (ADR-0062). They run as the
 * person would run them: their git, config, hooks and credentials (G5), on
 * the checkout alone and never a run's worktree or branch (G1), and only
 * after the interlock (G7) and the person's confirmation (G3) both allow them.
 * Nothing here takes a session's lease: the interlock reads what runs hold.
 */

export type UserGitErrorCode = 'landing_branch_held' | 'confirm_stale' | 'stale' | 'not_checkout' | 'ordewell_branch' | 'pushed' | 'git_failed' | 'refused';

export class UserGitError extends Error {
  constructor(readonly code: UserGitErrorCode, message: string, readonly detail: { held?: LandingBranchHeld; difference?: ConfirmDifference } = {}) {
    super(message);
    this.name = 'UserGitError';
  }
}

export interface UserGitDeps {
  reader: WorkspaceReader;
  resolvePath?: () => Promise<string>;
  exec?: GitExecFn;
  /** Every open run's landing branches in a workspace, each judged live or settled by its host. */
  landingRuns: (workspace: string) => LandingRun[];
  /** One line in the session's timeline for an action on its live run's landing branch (G6). */
  record: (workspace: string, held: LandingBranchHeld, text: string) => void;
}

/** Which repository of which workspace an action is on. */
export interface UserGitScope {
  workspace: string;
  repo?: string;
}

const ORDEWELL_BRANCH = /^ordewell(-preserved)?\//;
const WORKTREES = `${path.sep}.ordewell${path.sep}worktrees${path.sep}`;

const literal = (file: string) => `:(literal)${file}`;
const sorted = (files: readonly string[]) => [...new Set(files)].sort();
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function stale(field: string, shown: ConfirmValue, now: ConfirmValue): never {
  throw new UserGitError('confirm_stale', `What you confirmed has changed: ${field} was ${JSON.stringify(shown)}, it is now ${JSON.stringify(now)}.`, { difference: { field, shown, now } });
}

function refused(message: string): never {
  throw new UserGitError('refused', message);
}

/** A ref a person names: never an option git would read. */
function refName(name: string, what: string): string {
  if (name === '' || name.startsWith('-') || /[\s\0]/.test(name)) refused(`Refused ${what} "${name}".`);
  return name;
}

function list(files: readonly string[]): string {
  return files.length <= 3 ? files.join(', ') : `${files.slice(0, 3).join(', ')} and ${files.length - 3} more`;
}

export function createUserGit(deps: UserGitDeps) {
  // The person's own git: their hooks run and their credentials answer (G5). `cleanEnv` keeps GIT_TERMINAL_PROMPT=0, so nothing waits on a prompt nobody sees.
  const invoker: GitInvoker = { exec: deps.exec ?? defaultExecFile, resolvePath: deps.resolvePath ?? (() => augmentedPath()) };
  const { reader } = deps;

  async function run(cwd: string, args: string[], input?: string): Promise<GitResult> {
    const result = await tryGit(invoker, cwd, args, input);
    if (!result.ok) throw new UserGitError('git_failed', (result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`));
    return result;
  }

  async function maybe(cwd: string, args: string[]): Promise<string | null> {
    const result = await tryGit(invoker, cwd, args);
    return result.ok ? result.stdout.trim() : null;
  }

  /** The person's checkout of the repository, and never a run's worktree in it (G1). */
  async function open(scope: UserGitScope): Promise<CheckoutScope> {
    const checkout = await reader.checkout(scope);
    if (`${checkout.root}${path.sep}`.includes(WORKTREES)) {
      throw new UserGitError('not_checkout', 'This is a task worktree Ordewell made: act on your own checkout, and leave a run\'s worktrees to the run.');
    }
    return checkout;
  }

  function ownBranch(branch: string | null, doing: string): void {
    if (branch !== null && ORDEWELL_BRANCH.test(branch)) {
      throw new UserGitError('ordewell_branch', `${branch} is a run's own branch: Ordewell ${doing === 'name' ? 'keeps the ordewell/ names for its runs' : `will not ${doing} it for you`}.`);
    }
  }

  async function answer(scope: CheckoutScope, workspace: string, extra: Omit<GitActionResponse, 'repo'> = {}): Promise<GitActionResponse> {
    const { repos } = await reader.repos(workspace);
    const repo = repos.find((r) => r.repo === scope.repo) as GitRepoInfo;
    return { repo, ...extra };
  }

  /** Git's view of which files a patch touches, each one a path a person may name. */
  async function patchFiles(checkout: CheckoutScope, patch: string): Promise<string[]> {
    const fields = (await run(checkout.root, ['apply', '--numstat', '-z'], patch)).stdout.split('\0');
    const files: string[] = [];
    for (const field of fields) {
      const name = field.includes('\t') ? field.split('\t')[2] : field;
      if (name) files.push(name);
    }
    if (files.length === 0) refused('The hunks name no file.');
    for (const file of files) reader.writable(checkout.root, file);
    return sorted(files);
  }

  /**
   * `git apply` reads a git diff's paths from the top of the repository,
   * while the reader's diffs name them from the checkout's root.
   */
  async function apply(checkout: CheckoutScope, patch: string, flags: string[]): Promise<GitResult> {
    const top = checkout.prefix === '' ? checkout.root : (await run(checkout.root, ['rev-parse', '--show-toplevel'])).stdout.trim();
    const directory = checkout.prefix === '' ? [] : [`--directory=${checkout.prefix.replace(/\/$/, '')}`];
    return tryGit(invoker, top, ['apply', ...directory, ...flags], patch);
  }

  async function paths(checkout: CheckoutScope, files: readonly string[] | undefined): Promise<string[]> {
    if (!files || files.length === 0) refused('Name the files.');
    for (const file of files) reader.writable(checkout.root, file);
    return sorted(files);
  }

  /** Every file with a change in the checkout now, as the reader shows them. */
  async function changed(scope: UserGitScope, checkout: CheckoutScope): Promise<{ all: Set<string>; added: Set<string>; untracked: Set<string> }> {
    const status = await reader.status({ workspace: scope.workspace, repo: checkout.repo });
    const all = new Set<string>([...status.untracked, ...status.conflicted]);
    for (const change of [...status.staged, ...status.unstaged]) {
      all.add(change.path);
      if (change.from) all.add(change.from);
    }
    return { all, added: new Set(status.staged.filter((c) => c.status === 'A').map((c) => c.path)), untracked: new Set(status.untracked) };
  }

  /** A timeline line in each live run whose landing branch the action was on (G6). */
  function record(scope: UserGitScope, checkout: CheckoutScope, did: string): void {
    const branch = checkout.at.branch;
    if (branch === null) return;
    const where = checkout.repo === SELF_REPO ? '' : ` in ${checkout.repo}`;
    for (const landing of deps.landingRuns(scope.workspace)) {
      if (!landing.live || landing.repo !== checkout.repo || landing.branch !== branch) continue;
      deps.record(scope.workspace, { sessionId: landing.sessionId, runId: landing.runId, repo: landing.repo, branch }, `You ${did} on ${branch}${where}.`);
    }
  }

  /** The interlock's word on a move: refused while a live run lands there, warned while a settled one does (G7). */
  function interlocked(scope: UserGitScope, move: LandingMove): string | undefined {
    const { held, warnings } = interlock(deps.landingRuns(scope.workspace), move);
    if (held) {
      throw new UserGitError('landing_branch_held', `Session ${held.sessionId} is running ${held.runId}, which lands on ${held.branch}: ${move.kind === 'delete' ? 'deleting' : 'switching away from'} it waits until the run settles.`, { held });
    }
    return warnings.length > 0 ? warnings.join(' ') : undefined;
  }

  async function upstreamOf(checkout: CheckoutScope): Promise<{ branch: string; remote: string; merge: string }> {
    const branch = checkout.at.branch;
    if (branch === null) refused('HEAD is detached: switch to a branch that tracks a remote.');
    const remote = await maybe(checkout.root, ['config', '--get', `branch.${branch}.remote`]);
    const merge = await maybe(checkout.root, ['config', '--get', `branch.${branch}.merge`]);
    if (!remote || !merge) refused(`${branch} tracks no remote branch.`);
    if (remote.startsWith('-') || merge.startsWith('-')) refused(`${branch} tracks "${remote}" "${merge}", which git would read as an option.`);
    return { branch, remote, merge };
  }

  async function confirmedRemote(checkout: CheckoutScope, confirm: GitRemoteRequest['confirm'] | undefined) {
    const upstream = await upstreamOf(checkout);
    const now = upstream.merge.replace(/^refs\/heads\//, '');
    if (confirm?.remote !== upstream.remote) stale('remote', confirm?.remote ?? null, upstream.remote);
    if (confirm.branch !== now) stale('branch', confirm.branch, now);
    return { ...upstream, name: `${upstream.remote}/${now}` };
  }

  async function stashIndex(checkout: CheckoutScope, sha: string): Promise<string> {
    const shas = (await maybe(checkout.root, ['stash', 'list', '--format=%H']))?.split('\n') ?? [];
    const index = shas.indexOf(sha);
    if (index < 0) throw new UserGitError('stale', `No stash ${sha.slice(0, 12)} any more: it was popped or dropped.`);
    return `stash@{${index}}`;
  }

  return {
    /** G10: a write of a file read at `baseHash`, or of one that must not exist yet. */
    async save(scope: UserGitScope, request: FileSaveRequest): Promise<GitActionResponse> {
      const checkout = await open(scope);
      const file = reader.writable(checkout.root, request.path);
      let now: string | null = null;
      if (fs.existsSync(file)) {
        if (!fs.statSync(file).isFile()) refused(`"${request.path}" is not a file.`);
        now = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      }
      if (now !== request.baseHash) throw new UserGitError('stale', `"${request.path}" ${now === null ? 'is gone' : request.baseHash === null ? 'exists now' : 'changed'} since you opened it: reopen it before saving.`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, request.text);
      record(scope, checkout, `saved ${request.path}`);
      return answer(checkout, scope.workspace);
    },

    async stage(scope: UserGitScope, request: GitChangesRequest): Promise<GitActionResponse> {
      const checkout = await open(scope);
      if (request.hunks !== undefined) {
        await patchFiles(checkout, request.hunks);
        const applied = await apply(checkout, request.hunks, ['--cached']);
        if (!applied.ok) throw new UserGitError('stale', `The hunks no longer match the file: ${applied.stderr.trim()}`);
      } else {
        await run(checkout.root, ['add', '--', ...(await paths(checkout, request.paths)).map(literal)]);
      }
      return answer(checkout, scope.workspace);
    },

    async unstage(scope: UserGitScope, request: GitChangesRequest): Promise<GitActionResponse> {
      const checkout = await open(scope);
      if (request.hunks !== undefined) {
        await patchFiles(checkout, request.hunks);
        const applied = await apply(checkout, request.hunks, ['--cached', '-R']);
        if (!applied.ok) throw new UserGitError('stale', `The hunks are no longer staged as shown: ${applied.stderr.trim()}`);
      } else {
        const files = await paths(checkout, request.paths);
        // On an unborn branch there is no HEAD to restore the index from.
        const args = checkout.at.commit === null ? ['rm', '--cached', '-q', '--'] : ['restore', '--staged', '--'];
        await run(checkout.root, [...args, ...files.map(literal)]);
      }
      return answer(checkout, scope.workspace);
    },

    /** G4: an amend only of the commit the person saw, and only while no remote has it. */
    async commit(scope: UserGitScope, request: GitCommitRequest): Promise<GitActionResponse> {
      const checkout = await open(scope);
      ownBranch(checkout.at.branch, 'commit on');
      if (request.message.trim() === '') refused('Write a commit message.');
      if (request.amend) {
        if (request.confirm?.head !== checkout.at.commit) stale('head', request.confirm?.head ?? null, checkout.at.commit);
        const remotes = await run(checkout.root, ['for-each-ref', '--count=1', '--format=%(refname:short)', '--contains', 'HEAD', 'refs/remotes']);
        if (remotes.stdout.trim() !== '') throw new UserGitError('pushed', `The last commit is on ${remotes.stdout.trim()} already: amending it would rewrite pushed history.`);
      }
      await run(checkout.root, ['commit', ...(request.amend ? ['--amend'] : []), '-m', request.message]);
      record(scope, checkout, request.amend ? 'amended the last commit' : `committed "${request.message.split('\n')[0].trim()}"`);
      return answer(checkout, scope.workspace);
    },

    /** G3: only the files the person was shown, each with a change to discard still. */
    async discard(scope: UserGitScope, request: GitDiscardRequest): Promise<GitActionResponse> {
      const checkout = await open(scope);
      const shown = sorted(request.confirm?.files ?? []);
      const { all, added, untracked } = await changed(scope, checkout);
      if (request.hunks !== undefined) {
        const files = await patchFiles(checkout, request.hunks);
        const now = files.filter((f) => all.has(f));
        if (!same(shown, now)) stale('files', shown, now);
        const check = await apply(checkout, request.hunks, ['-R', '--check']);
        if (!check.ok) throw new UserGitError('stale', `The hunks no longer match the file: ${check.stderr.trim()}`);
        const applied = await apply(checkout, request.hunks, ['-R']);
        if (!applied.ok) throw new UserGitError('git_failed', applied.stderr.trim());
        record(scope, checkout, `discarded changes to ${list(files)}`);
        return answer(checkout, scope.workspace);
      }
      const requested = await paths(checkout, request.paths);
      const now = requested.filter((f) => all.has(f));
      if (!same(shown, now)) stale('files', shown, now);
      const tracked = now.filter((f) => !untracked.has(f) && !added.has(f));
      const fresh = now.filter((f) => added.has(f));
      if (fresh.length > 0) await run(checkout.root, ['rm', '-f', '-q', '--', ...fresh.map(literal)]);
      if (tracked.length > 0) await run(checkout.root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked.map(literal)]);
      for (const file of now.filter((f) => untracked.has(f))) fs.rmSync(reader.writable(checkout.root, file), { force: true });
      record(scope, checkout, `discarded changes to ${list(now)}`);
      return answer(checkout, scope.workspace);
    },

    async createBranch(scope: UserGitScope, request: GitBranchCreateRequest): Promise<GitActionResponse> {
      const checkout = await open(scope);
      const name = refName(request.name, 'branch name');
      ownBranch(name, 'name');
      await run(checkout.root, ['check-ref-format', '--branch', name]);
      const from = request.from === undefined ? [] : [refName(request.from, 'start point')];
      let warning: string | undefined;
      if (request.switch) {
        warning = interlocked(scope, { kind: 'switch', repo: checkout.repo, from: checkout.at.branch, to: name });
        await run(checkout.root, ['switch', '-c', name, ...from]);
      } else {
        await run(checkout.root, ['branch', name, ...from]);
      }
      return answer(checkout, scope.workspace, warning ? { warning } : {});
    },

    async switchBranch(scope: UserGitScope, request: GitSwitchRequest): Promise<GitActionResponse> {
      const checkout = await open(scope);
      const branch = refName(request.branch, 'branch');
      ownBranch(branch, 'switch to');
      const warning = interlocked(scope, { kind: 'switch', repo: checkout.repo, from: checkout.at.branch, to: branch });
      await run(checkout.root, ['switch', branch]);
      return answer(checkout, scope.workspace, warning ? { warning } : {});
    },

    /** G3: a delete of the branch confirmed, said to be merged or not as it is now. */
    async deleteBranch(scope: UserGitScope, request: GitBranchDeleteRequest): Promise<GitActionResponse> {
      const checkout = await open(scope);
      const branch = refName(request.branch, 'branch');
      ownBranch(branch, 'delete');
      if (request.confirm?.branch !== branch) stale('branch', request.confirm?.branch ?? null, branch);
      const tip = await maybe(checkout.root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]);
      if (tip === null) throw new UserGitError('stale', `No branch ${branch} any more.`);
      // Git's own test for `branch -d`: merged into its upstream, or into HEAD when it has none.
      const upstream = await maybe(checkout.root, ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`]);
      const unmerged = (await isAncestor(invoker, checkout.root, tip, upstream || 'HEAD')) !== 'yes';
      if (request.confirm.unmerged !== unmerged) stale('unmerged', request.confirm.unmerged, unmerged);
      const warning = interlocked(scope, { kind: 'delete', repo: checkout.repo, branch });
      await run(checkout.root, ['branch', unmerged ? '-D' : '-d', '--', branch]);
      return answer(checkout, scope.workspace, warning ? { warning } : {});
    },

    /** A stash of the paths named, or of every change the person can see; answered by its commit, which outlives its stash@{n}. */
    async stash(scope: UserGitScope, request: GitStashRequest): Promise<GitActionResponse> {
      const checkout = await open(scope);
      const files = request.paths && request.paths.length > 0 ? await paths(checkout, request.paths) : sorted([...(await changed(scope, checkout)).all]);
      if (files.length === 0) refused('Nothing to stash: the checkout has no changes.');
      const before = await maybe(checkout.root, ['rev-parse', '--verify', '-q', 'refs/stash']);
      const message = request.message?.trim() ? ['-m', request.message.trim()] : [];
      await run(checkout.root, ['stash', 'push', '--include-untracked', ...message, '--', ...files.map(literal)]);
      const after = await maybe(checkout.root, ['rev-parse', '--verify', '-q', 'refs/stash']);
      if (after === null || after === before) refused('Nothing to stash: those files have no changes.');
      const subject = (await run(checkout.root, ['stash', 'list', '-n', '1', '--format=%gs'])).stdout.trim();
      record(scope, checkout, 'stashed changes');
      return answer(checkout, scope.workspace, { stash: { sha: after, message: subject } });
    },

    async stashPop(scope: UserGitScope, request: GitStashRefRequest): Promise<GitActionResponse> {
      const checkout = await open(scope);
      await run(checkout.root, ['stash', 'pop', await stashIndex(checkout, request.stash)]);
      return answer(checkout, scope.workspace);
    },

    async stashDrop(scope: UserGitScope, request: GitStashRefRequest): Promise<GitActionResponse> {
      const checkout = await open(scope);
      await run(checkout.root, ['stash', 'drop', await stashIndex(checkout, request.stash)]);
      return answer(checkout, scope.workspace);
    },

    async fetch(scope: UserGitScope): Promise<GitActionResponse> {
      const checkout = await open(scope);
      await run(checkout.root, ['fetch']);
      return answer(checkout, scope.workspace);
    },

    /** G3: from the remote branch the person was shown, which is the one the branch tracks. */
    async pull(scope: UserGitScope, request: GitRemoteRequest): Promise<GitActionResponse> {
      const checkout = await open(scope);
      ownBranch(checkout.at.branch, 'pull into');
      const upstream = await confirmedRemote(checkout, request.confirm);
      await run(checkout.root, ['pull', upstream.remote, upstream.merge]);
      record(scope, checkout, `pulled from ${upstream.name}`);
      return answer(checkout, scope.workspace);
    },

    /** G3: to the remote branch the person was shown, never forced. */
    async push(scope: UserGitScope, request: GitRemoteRequest): Promise<GitActionResponse> {
      const checkout = await open(scope);
      ownBranch(checkout.at.branch, 'push');
      const upstream = await confirmedRemote(checkout, request.confirm);
      await run(checkout.root, ['push', upstream.remote, `refs/heads/${upstream.branch}:${upstream.merge}`]);
      return answer(checkout, scope.workspace);
    },
  };
}

export type UserGit = ReturnType<typeof createUserGit>;
