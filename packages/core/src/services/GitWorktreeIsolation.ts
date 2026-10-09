import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { IConfig } from '../interfaces/IConfig';
import type {
  IsolationAvailability,
  IsolationHandoff,
  IsolationInactiveReason,
  IsolationMergeBlock,
  IsolationMergeBlockReason,
  IsolationMergeResult,
  IsolationOutcome,
  IsolationPruneResult,
  IsolationRemoval,
  IsolationRepo,
  IsolationRun,
  IsolationTaskRecord,
  IsolationTaskRepo,
  IntegrationDisposal,
  IWorktreeIsolation,
  PreparedTask,
  PreservedWork,
  RepairEvidence,
  TreeSnapshot,
} from '../interfaces/IWorktreeIsolation';
import type { Task } from '../models/Task';
import { augmentedPath } from '../utils/shellPath';
import { ensureStateDirIgnored, STATE_DIR } from '../utils/fsHelpers';
import { sanitizeSlug } from '../utils/prdStore';
import { absorbRemoval, handoffOf, integrationBranchFor, noRemoval, repoRootOf, SELF_REPO } from './isolationRecord';
import { defaultExecFile, git, tryGit, type GitExecFn, type GitInvoker, type GitResult } from './gitExec';
import { IsolationLocks } from './isolationLocks';
import { bootstrap, installDirs, isEnvFile, lexists, LINKED_ARTIFACTS, listDir } from './worktreeBootstrap';
import { linkPath } from './worktreeLink';
import { childDirs, groupPaths, hasGitEntry } from './repoGroup';

export type { GitExecFn } from './gitExec';

export interface WorktreeIsolationDeps {
  config: Pick<IConfig, 'worktreeIsolation' | 'worktreeSetupCommand' | 'workspaceRepos' | 'worktreeLinks'>;
  /** Test seam: every git invocation goes through this. */
  execFileImpl?: GitExecFn;
  resolvePath?: () => Promise<string>;
  platform?: NodeJS.Platform;
  mintRunId?: () => string;
}

const INTEGRATION_DIR = 'integration';

// The names Ordewell gives its own branches and task workspaces; the run id is
// the one segment it owns. Greedy, so a workspace that itself sits in a task
// workspace resolves to the innermost run.
const RUN_BRANCH = /^ordewell\/([^/]+)\/[^/]+$/;
const RUN_WORKTREE = /.*[\\/]\.ordewell[\\/]worktrees[\\/]([^\\/]+)[\\/]/;

// Where work a removal would otherwise delete is kept. Deliberately outside
// `ordewell/`, every branch of which some clean-up or sweep may delete.
const PRESERVED_BRANCHES = 'ordewell-preserved';

// How far below the workspace root a repository is looked for. Deeper ones are
// not scanned for: a walk of the whole tree would visit every dependency folder.
const NESTED_REPO_DEPTH = 2;
const GITLINK_MODE = '160000';

/** One repo's share of a worktree about to be removed, as {@link GitWorktreeIsolation.preserve} reads it. */
interface RemovalTarget {
  /** Absent once the worktree is gone, or for a branch no worktree has. */
  worktree?: string;
  /** Artifacts linked in from the real workspace, which are never the task's work. */
  linked: string[];
  /** The task branch whose tip is kept when no worktree is left; null when there is none. */
  branch: string | null;
  /** The last segment of the branch it is kept on. */
  name: string;
  title: string;
}

/**
 * The repo group a workspace forms, or the reason it forms none. `nested` is
 * the repositories found inside a lone repository, which cannot be isolated
 * with it and are shared live instead; empty for a folder group.
 */
type GroupScan = { paths: string[]; nested: string[] } | { refused: IsolationAvailability };

interface QueuedMerge {
  task: Task;
  run: IsolationRun;
  persist: () => void;
  settle: (outcome: IsolationOutcome) => void;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0].trim();
}

/** The paths of `git status --porcelain -z`; a rename or copy names both of its paths. */
function statusPaths(porcelain: string): string[] {
  const fields = porcelain.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && fields[i + 1]) paths.push(fields[++i]);
  }
  return paths;
}

/** The files `git diff --check` reports leftover conflict markers in; its whitespace warnings are not asked about. */
function leftoverMarkerFiles(check: string): string[] {
  const files = check.split(/\r?\n/).flatMap((line) => /^(.+):\d+: leftover conflict marker$/.exec(line)?.[1] ?? []);
  return [...new Set(files)];
}

/**
 * Tracked file → its state, from `git diff --raw -z --no-abbrev`: the mode and
 * blob on the right-hand side, all zeros for a deleted file.
 */
function rawDiffStates(raw: string): Record<string, string> {
  const parts = raw.split('\0');
  const states: Record<string, string> = {};
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].trim();
    const file = parts[i + 1];
    if (!meta.startsWith(':') || !file) continue;
    const [, mode, , blob] = meta.slice(1).split(' ');
    states[file] = `${mode}:${blob}`;
  }
  return states;
}

/** Where a landing or a release leaves a task; a repair in flight ends there too, whatever the outcome. */
function settleStatus(record: IsolationTaskRecord, status: IsolationTaskRecord['status']): void {
  record.status = status;
  delete record.repairBase;
}

function sameDir(a: string, b: string): boolean {
  const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
}

function resolves(target: string): boolean {
  try { fs.statSync(target); return true; } catch { return false; }
}

/** An inactive availability naming `repos`; `.` is not a name, so a group of one names none. */
function inactive(reason: IsolationInactiveReason, repos: string[]): IsolationAvailability {
  const named = repos.filter((r) => r !== SELF_REPO);
  return named.length > 0 ? { active: false, reason, repos: named } : { active: false, reason };
}

/**
 * What a task workspace has linked in, read off the directory when no record
 * says: its links, the artifacts linked into every workspace, and the install
 * directories mirrored there.
 */
function leftoverLinks(dir: string): string[] {
  const named = listDir(dir).filter((name) => LINKED_ARTIFACTS.has(name) || isEnvFile(name) || isLink(path.join(dir, name)));
  return [...new Set([...named, ...installDirs(dir)])];
}

function isLink(target: string): boolean {
  try { return fs.lstatSync(target).isSymbolicLink(); } catch { return false; }
}

class GitWorktreeIsolation implements IWorktreeIsolation {
  private readonly resolvePath: () => Promise<string>;
  private readonly platform: NodeJS.Platform;
  private readonly mintRunId: () => string;

  private readonly gitInvoker: GitInvoker;
  private readonly locks = new IsolationLocks();
  private waiting: QueuedMerge[] = [];
  private draining = false;

  constructor(private readonly deps: WorktreeIsolationDeps) {
    this.resolvePath = deps.resolvePath ?? (() => augmentedPath());
    this.gitInvoker = { exec: deps.execFileImpl ?? defaultExecFile, resolvePath: this.resolvePath };
    this.platform = deps.platform ?? process.platform;
    this.mintRunId = deps.mintRunId ?? (() => randomBytes(4).toString('hex'));
  }

  async isActive(workspaceRoot: string): Promise<IsolationAvailability> {
    if (!this.deps.config.worktreeIsolation) return { active: false, reason: 'disabled' };

    const version = await this.tryGit(undefined, ['--version']);
    if (!version.ok) return { active: false, reason: 'git-missing' };

    const scan = await this.scanGroup(workspaceRoot);
    if ('refused' in scan) return scan.refused;
    // A commitless repo is shared rather than isolated; only a group of nothing but those is refused.
    const committed = await this.committedRepos(workspaceRoot, scan.paths);
    if (committed.length === 0) return inactive('no-commits', scan.paths);

    const dirty: string[] = [];
    for (const repoPath of committed) {
      const tracked = await this.trackedChanges(repoRootOf(workspaceRoot, repoPath));
      if (tracked === null) return { active: false, reason: 'not-git' };
      if (tracked) dirty.push(repoPath);
    }
    if (dirty.length > 0) return inactive('dirty', dirty);
    if (committed.includes(SELF_REPO)) return scan.nested.length > 0 ? { active: true, shared: scan.nested } : { active: true };
    return { active: true, repos: committed, shared: this.sharedPaths(workspaceRoot, committed) };
  }

  /**
   * A workspace inside a repository is a group of one at `.`, and any
   * repositories nested in it are shared live. A folder that is not forms a
   * group from `workspaceRepos` when set, otherwise from the repositories
   * directly inside it.
   */
  private async scanGroup(workspaceRoot: string): Promise<GroupScan> {
    // cwd may not exist; any failure here is "not a repository" as far as the caller can act on it.
    const toplevel = await this.tryGit(workspaceRoot, ['rev-parse', '--show-toplevel']);
    if (toplevel.ok) return { paths: [SELF_REPO], nested: await this.nestedRepos(workspaceRoot, toplevel.stdout.trim()) };
    const paths = groupPaths(workspaceRoot, this.deps.config.workspaceRepos);
    return paths.length > 0 ? { paths, nested: [] } : { refused: { active: false, reason: 'not-git' } };
  }

  private async committedRepos(workspaceRoot: string, paths: string[]): Promise<string[]> {
    const committed: string[] = [];
    for (const repoPath of paths) {
      if ((await this.tryGit(repoRootOf(workspaceRoot, repoPath), ['rev-parse', '--verify', '-q', 'HEAD'])).ok) committed.push(repoPath);
    }
    return committed;
  }

  /** Whether tracked files differ from HEAD; null when git cannot tell. Untracked and ignored files never count: the bootstrap step accounts for them. */
  private async trackedChanges(root: string): Promise<boolean | null> {
    const status = await this.tryGit(root, ['status', '--porcelain', '--untracked-files=no']);
    return status.ok ? status.stdout.trim() !== '' : null;
  }

  /**
   * Repositories below the workspace that the outer repository does not own as
   * submodules. Isolating the outer one would leave them out of every task
   * worktree, so they are linked live into each task instead. A nested repo the
   * outer repo ignores is shared too: no linked artifact stands in for it, and
   * leaving it out would make it vanish with no word.
   */
  private async nestedRepos(workspaceRoot: string, toplevel: string): Promise<string[]> {
    const found: string[] = [];
    const walk = (rel: string, depth: number): void => {
      for (const name of childDirs(path.join(workspaceRoot, rel))) {
        const child = rel ? `${rel}/${name}` : name;
        if (hasGitEntry(path.join(workspaceRoot, child))) found.push(child);
        else if (depth < NESTED_REPO_DEPTH) walk(child, depth + 1);
      }
    };
    walk('', 1);
    if (found.length === 0) return [];

    const owned = await this.submodulePaths(workspaceRoot, toplevel);
    const prefix = (await this.tryGit(workspaceRoot, ['rev-parse', '--show-prefix'])).stdout.trim();
    return found.filter((rel) => !owned.has(`${prefix}${rel}`));
  }

  /** Paths, relative to the repository's top level, that are submodules: staged gitlinks and `.gitmodules` entries. */
  private async submodulePaths(workspaceRoot: string, toplevel: string): Promise<Set<string>> {
    const paths = new Set<string>();
    const staged = await this.tryGit(workspaceRoot, ['ls-files', '-s', '-z']);
    for (const entry of staged.stdout.split('\0')) {
      const [meta, file] = entry.split('\t');
      if (file !== undefined && meta.startsWith(`${GITLINK_MODE} `)) paths.add(file);
    }
    const declared = await this.tryGit(workspaceRoot, ['config', '-z', '-f', path.join(toplevel, '.gitmodules'), '--get-regexp', '^submodule\\..*\\.path$']);
    for (const entry of declared.stdout.split('\0')) {
      const value = entry.split('\n')[1];
      if (value) paths.add(value.replace(/\/+$/, ''));
    }
    return paths;
  }

  async stash(workspaceRoot: string): Promise<void> {
    const scan = await this.scanGroup(workspaceRoot);
    for (const repoPath of await this.committedRepos(workspaceRoot, 'paths' in scan ? scan.paths : [SELF_REPO])) {
      const root = repoRootOf(workspaceRoot, repoPath);
      if (await this.trackedChanges(root)) await this.git(root, ['stash', 'push', '-m', 'ordewell: stashed before an isolated run']);
    }
  }

  startRun(workspaceRoot: string): Promise<IsolationRun> {
    return this.admin(workspaceRoot, async () => {
      const scan = await this.scanGroup(workspaceRoot);
      const paths = 'paths' in scan ? scan.paths : [SELF_REPO];
      const nested = 'paths' in scan ? scan.nested : [];
      const run: IsolationRun = { id: this.mintRunId(), workspaceRoot, repos: [], shared: [], sharedRepos: [], tasks: {} };
      for (const repoPath of paths) {
        const repo = await this.startRepo(run, repoPath);
        if (repo) run.repos.push(repo);
        else run.sharedRepos.push(repoPath);
      }
      if (run.repos.length === 0) throw new Error(`No repository could be isolated: ${run.sharedRepos.join(', ')}`);
      // A lone repository shares the repositories nested in it; a folder shares its loose entries.
      run.shared = paths.includes(SELF_REPO)
        ? nested
        : this.sharedPaths(workspaceRoot, run.repos.map((r) => r.path));
      return run;
    });
  }

  /** The repo's share of a new run, or null when it cannot be isolated and is to be shared instead. */
  private async startRepo(run: IsolationRun, repoPath: string): Promise<IsolationRepo | null> {
    const root = repoRootOf(run.workspaceRoot, repoPath);
    const head = await this.tryGit(root, ['rev-parse', '--verify', '-q', 'HEAD']);
    if (!head.ok) return null;
    const baseRef = head.stdout.trim();
    const branch = (await this.tryGit(root, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
    const repo: IsolationRepo = {
      path: repoPath,
      root,
      baseRef,
      ...(branch ? { baseBranch: branch } : {}),
      integrationBranch: integrationBranchFor(run.id),
    };
    if (!(await this.tryGit(root, ['branch', repo.integrationBranch, baseRef])).ok) return null;
    if (await this.acceptsWorktree(run, repo)) return repo;
    await this.tryGit(root, ['branch', '-D', repo.integrationBranch]);
    return null;
  }

  /**
   * Whether git will add a worktree for this repo. Only trying tells — a
   * repository format it cannot extend, an admin directory it cannot write —
   * and a refusal found here shares the repo for the whole run instead of
   * failing its first task. `--no-checkout` keeps the try cheap.
   */
  private async acceptsWorktree(run: IsolationRun, repo: IsolationRepo): Promise<boolean> {
    const dir = this.integrationDir(run, repo);
    ensureStateDirIgnored(run.workspaceRoot);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const added = await this.tryGit(repo.root, ['worktree', 'add', '-q', '--no-checkout', dir, repo.integrationBranch]);
    await this.removeWorktreeDir(run, repo, dir, []);
    return added.ok;
  }

  /**
   * What each task workspace links live from the real workspace: everything
   * outside the isolated repos except `.ordewell` and `.git`. A directory that
   * holds a deeper repo is recreated rather than linked, so the repo's worktree
   * can sit at its real path inside it.
   */
  private sharedPaths(workspaceRoot: string, isolated: string[]): string[] {
    if (isolated.includes(SELF_REPO)) return [];
    const shared: string[] = [];
    const walk = (rel: string): void => {
      for (const name of listDir(path.join(workspaceRoot, rel))) {
        if (!rel && (name === STATE_DIR || name === '.git')) continue;
        const child = rel ? `${rel}/${name}` : name;
        if (isolated.includes(child)) continue;
        if (isolated.some((p) => p.startsWith(`${child}/`))) walk(child);
        // A link that leads nowhere, such as an editor's lock file, has nothing to share, and linking it would fail every task.
        else if (resolves(path.join(workspaceRoot, child))) shared.push(child);
      }
    };
    walk('');
    return shared;
  }

  prepare(task: Task, run: IsolationRun): Promise<PreparedTask> {
    return this.admin(run.workspaceRoot, async () => {
      const previous = run.tasks[task.id];
      const replaced = previous ? await this.removeTask(run, previous, { dropRecord: true }) : noRemoval();
      const [refused] = replaced.refused;
      if (refused) {
        throw new Error(`The worktree of its last attempt (${refused.worktree}) holds work Ordewell could not keep (${refused.reason}). Save or remove it by hand, then start the task again`);
      }

      const { branch, dir } = this.namesFor(run, task);
      ensureStateDirIgnored(run.workspaceRoot);
      const record: IsolationTaskRecord = { taskId: task.id, order: task.order, title: task.title, branch, workspace: dir, status: 'active', repos: {} };
      let cwd = dir;
      const copied: string[] = [];
      try {
        for (const repo of run.repos) {
          const worktree = path.join(dir, repo.path);
          const tip = (await this.git(repo.root, ['rev-parse', repo.integrationBranch])).trim();
          fs.mkdirSync(path.dirname(worktree), { recursive: true });
          // -B: the name is inside this run's namespace, so a leftover from a crashed attempt is ours to reset.
          await this.git(repo.root, ['worktree', 'add', '-q', '-B', branch, worktree, tip]);
          record.repos[repo.path] = { worktree, linked: [] };
        }

        // A group re-takes its loose paths for every task, so a file the user
        // adds mid-run is shared from the next task on; a lone repository's
        // shared paths are the repositories nested in it, fixed for the run.
        const self = run.repos.find((r) => r.path === SELF_REPO);
        if (!self) run.shared = this.sharedPaths(run.workspaceRoot, run.repos.map((r) => r.path));

        for (const repo of run.repos) {
          const entry = record.repos[repo.path];
          const inRepo = await this.inWorkspacePlace(repo, entry.worktree);
          if (repo.path === SELF_REPO) cwd = inRepo;
          const boot = await bootstrap(repo, inRepo, {
            setupCommand: this.deps.config.worktreeSetupCommand,
            links: this.deps.config.worktreeLinks,
            platform: this.platform,
            resolvePath: this.resolvePath,
          });
          entry.linked = boot.linked;
          copied.push(...boot.copied.map((name) => path.posix.join(repo.path, name)));
        }

        // After the bootstrap: a nested repo already live through a linked
        // artifact (`vendor/`, `.venv/`) is left as it is, so the whole artifact
        // stays linked. A lone repository's shared paths sit inside its worktree,
        // so they are recorded like its bootstrapped artifacts and kept out of
        // its commit.
        for (const rel of run.shared) {
          const source = path.join(run.workspaceRoot, rel);
          const target = path.join(cwd, rel);
          // A shared path that vanished mid-run is left out rather than failing
          // the task: a group re-scans for every task, a lone repository's
          // nested repositories are fixed for the run.
          if (!resolves(source) || lexists(target)) continue;
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (linkPath(source, target, this.platform) === 'copy') copied.push(rel);
          const entry = self ? record.repos[SELF_REPO] : undefined;
          if (entry) entry.linked.push(rel);
        }
      } catch (err) {
        record.status = 'failed';
        await this.removeTask(run, record, { dropRecord: false, preserve: false });
        throw err;
      }
      run.tasks[task.id] = record;
      return { cwd, branch, copied, ...(replaced.preserved.length > 0 ? { preserved: replaced.preserved } : {}) };
    });
  }

  reopen(task: Task, run: IsolationRun): Promise<PreparedTask> {
    return this.admin(run.workspaceRoot, async () => {
      const record = run.tasks[task.id];
      if (record?.status !== 'conflict') throw new Error(`Task ${task.order} has no conflict to repair`);
      let cwd = record.workspace;
      const repairBase: Record<string, string> = {};
      for (const repo of run.repos) {
        const entry = record.repos[repo.path];
        if (!entry) continue;
        if (!fs.existsSync(entry.worktree)) throw new Error(`The worktree of task ${task.order} is gone: ${entry.worktree}`);
        if (repo.path === SELF_REPO) cwd = await this.inWorkspacePlace(repo, entry.worktree);
        // A record from before `changed` was kept names only the repo that stopped it.
        if (entry.changed || repo.path === record.conflictRepo) {
          repairBase[repo.path] = (await this.git(repo.root, ['rev-parse', '--verify', repo.integrationBranch])).trim();
        }
      }
      const files = (record.conflictFiles ?? []).map((file) => (record.conflictRepo && record.conflictRepo !== SELF_REPO ? `${record.conflictRepo}/${file}` : file));
      record.repairs = (record.repairs ?? 0) + 1;
      record.repairBase = repairBase;
      record.repairedFiles = [...new Set([...(record.repairedFiles ?? []), ...files])];
      record.status = 'repairing';
      return { cwd, branch: record.branch, copied: [] };
    });
  }

  async verifyRepair(task: Task, run: IsolationRun): Promise<RepairEvidence> {
    const record = run.tasks[task.id];
    if (!record?.repairBase) return { ok: false, reason: 'failed', repo: record?.conflictRepo ?? SELF_REPO };
    for (const repo of run.repos) {
      const entry = record.repos[repo.path];
      if (!entry) continue;
      try {
        await this.commitWorktree(repo, entry, firstLine(record.title));
      } catch {
        return { ok: false, reason: 'failed', repo: repo.path };
      }
    }
    for (const repo of run.repos) {
      const base = record.repairBase[repo.path];
      if (base === undefined) continue;
      const contains = await this.tryGit(repo.root, ['merge-base', '--is-ancestor', base, record.branch]);
      if (!contains.ok) return { ok: false, reason: contains.code === 1 ? 'not-merged' : 'failed', repo: repo.path };
      const check = await this.tryGit(repo.root, ['-c', 'core.quotePath=false', 'diff', '--check', base, record.branch]);
      // Exit 2 is "found something", which is whitespace just as often; anything else is git failing.
      if (!check.ok && check.code !== 2) return { ok: false, reason: 'failed', repo: repo.path };
      const files = leftoverMarkerFiles(check.stdout);
      if (files.length > 0) return { ok: false, reason: 'conflict-markers', repo: repo.path, files };
    }
    return { ok: true };
  }

  /**
   * The place in a repo's worktree that matches where the workspace sits in
   * the real repo: the worktree itself, or a subdirectory of it when the
   * workspace root is a subdirectory of the repository.
   */
  private async inWorkspacePlace(repo: IsolationRepo, worktree: string): Promise<string> {
    const prefix = await this.prefixOf(repo);
    return prefix ? path.join(worktree, prefix) : worktree;
  }

  private async prefixOf(repo: IsolationRepo): Promise<string> {
    return (await this.git(repo.root, ['rev-parse', '--show-prefix'])).trim();
  }

  integrate(task: Task, run: IsolationRun, persist: () => void = () => undefined): Promise<IsolationOutcome> {
    return new Promise((settle) => {
      this.waiting.push({ task, run, persist, settle });
      // Deferred a microtask so verdicts landing in the same tick queue up
      // together and plan order, not arrival order, decides who merges first.
      if (!this.draining) {
        this.draining = true;
        queueMicrotask(() => void this.drain());
      }
    });
  }

  release(run: IsolationRun, taskId: string, opts: { keep: boolean }): Promise<IsolationRemoval> {
    return this.admin(run.workspaceRoot, async () => {
      const record = run.tasks[taskId];
      if (!record) return noRemoval();
      const removal = opts.keep ? noRemoval() : await this.removeTask(run, record, { dropRecord: true });
      if (opts.keep || removal.refused.length > 0) {
        // Off `active` so a crash-recovery prune does not mistake a kept attempt for an orphan.
        if (record.status === 'active') record.status = 'kept';
        else if (record.status === 'repairing') settleStatus(record, 'conflict');
      }
      return removal;
    });
  }

  handoff(run: IsolationRun): Promise<IsolationHandoff> {
    return this.inTurn(() => this.admin(run.workspaceRoot, async () => {
      // A branch checked out in a worktree cannot be checked out in the main
      // one, and the user is about to review it.
      await this.removeIntegrationWorktrees(run);
      await this.settleLanding(run);
      return handoffOf(run);
    }));
  }

  pruneOrphans(run: IsolationRun): Promise<IsolationPruneResult> {
    return this.inTurn(() => this.admin(run.workspaceRoot, async () => {
      // A half-finished merge from a crash is easier to drop than to repair;
      // the branch refs are the only state that matters. What a landing had
      // merged goes back too, since the run was saved as not having it.
      await this.removeIntegrationWorktrees(run);
      await this.settleLanding(run);
      const kept: IsolationPruneResult['kept'] = [];
      const removal = noRemoval();
      for (const record of Object.values(run.tasks)) {
        if (record.status === 'active') {
          // Adopting a plan is not proof its runner died: another host may
          // have adopted the same record mid-run. Deleting an active worktree
          // that still holds work would take the runner's commits and edits
          // with it, so it is kept exactly as an interrupted attempt's is.
          if (await this.holdsUnlandedWork(run, record)) {
            record.status = 'kept';
            kept.push({ taskId: record.taskId, order: record.order, title: record.title });
          } else {
            absorbRemoval(removal, await this.removeTask(run, record, { dropRecord: true }));
          }
        } else if (record.status === 'merged') absorbRemoval(removal, await this.removeTask(run, record, { dropRecord: false }));
        // The work a repair was given is committed on the branch; only the attempt died.
        else if (record.status === 'repairing') settleStatus(record, 'conflict');
      }
      absorbRemoval(removal, await this.removeUnowned(run));
      for (const repo of run.repos) await this.tryGit(repo.root, ['worktree', 'prune']);
      return { kept, ...removal };
    }));
  }

  /**
   * Whether an attempt record still holds work nobody else has: commits its
   * branch carries that the integration branch does not, or edits in its
   * worktree. Only an attempt that left neither behind is safe to prune.
   */
  private async holdsUnlandedWork(run: IsolationRun, record: IsolationTaskRecord): Promise<boolean> {
    for (const repo of run.repos) {
      const entry = record.repos[repo.path];
      if (!entry) continue;
      if (await this.brings(repo, record.branch)) return true;
      if (await this.worktreeHasChanges(entry, await this.prefixOf(repo))) return true;
    }
    return false;
  }

  /**
   * Changes in a worktree, ignoring the artifacts Ordewell bootstrapped there
   * so a prepared-but-untouched attempt still reads as empty. `prefix` is where
   * the workspace sits in the repo, which is what the recorded link names are
   * relative to. A worktree git cannot read is treated as holding work: it is
   * out of sync, and deleting it is the one action that cannot be undone.
   */
  private async worktreeHasChanges(entry: IsolationTaskRepo, prefix: string): Promise<boolean> {
    if (!fs.existsSync(entry.worktree)) return false;
    const status = await this.tryGit(entry.worktree, ['status', '--porcelain', '-z']);
    if (!status.ok) return true;
    const linked = new Set(entry.linked);
    return statusPaths(status.stdout).some((p) => {
      const rel = (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p).replace(/\/+$/, '');
      return !linked.has(rel) && !linked.has(rel.split('/')[0]);
    });
  }

  async findInHead(run: IsolationRun): Promise<string[]> {
    const found: string[] = [];
    for (const record of Object.values(run.tasks)) {
      if (record.status !== 'merged' || record.inHead) continue;
      if (!(await this.headContains(run, record))) continue;
      record.inHead = true;
      found.push(record.taskId);
    }
    return found;
  }

  private async headContains(run: IsolationRun, record: IsolationTaskRecord): Promise<boolean> {
    for (const repo of run.repos) {
      const entry = record.repos[repo.path];
      if (!entry?.changed) continue;
      // A task landed before its tip was recorded counts as merged once the whole integration branch is.
      const merged = await this.tryGit(repo.root, ['merge-base', '--is-ancestor', entry.landedTip ?? repo.integrationBranch, 'HEAD']);
      if (!merged.ok) return false;
    }
    return true;
  }

  async snapshotTree(workspaceRoot: string, exclude: readonly string[]): Promise<TreeSnapshot | null> {
    const scan = await this.scanGroup(workspaceRoot);
    if ('refused' in scan) return null;
    const repos = (await this.committedRepos(workspaceRoot, scan.paths)).filter((repoPath) => !exclude.includes(repoPath));
    if (repos.length === 0) return null;
    const snapshot: TreeSnapshot = {};
    for (const repoPath of repos) {
      const states = await this.trackedStates(repoRootOf(workspaceRoot, repoPath));
      if (states) snapshot[repoPath] = states;
    }
    return snapshot;
  }

  async changedSince(workspaceRoot: string, snapshot: TreeSnapshot): Promise<string[]> {
    const changed: string[] = [];
    for (const [repoPath, before] of Object.entries(snapshot)) {
      const now = await this.trackedStates(repoRootOf(workspaceRoot, repoPath));
      if (!now) continue;
      for (const [file, state] of Object.entries(now)) {
        if (before[file] !== state) changed.push(repoPath === SELF_REPO ? file : `${repoPath}/${file}`);
      }
    }
    return changed.sort();
  }

  /**
   * Each tracked file that differs from HEAD, with what it holds. `git stash
   * create` records the working tree as a commit without touching the tree,
   * the index or the stash, so a file changed again is told apart from one
   * left as it was. Null when git cannot tell — a merge in progress, say.
   */
  private async trackedStates(root: string): Promise<Record<string, string> | null> {
    const stash = await this.tryGit(root, ['stash', 'create']);
    if (!stash.ok) return null;
    const commit = stash.stdout.trim();
    if (!commit) return {};
    const diff = await this.tryGit(root, ['diff', '--raw', '--no-abbrev', '--no-renames', '-z', 'HEAD', commit]);
    return diff.ok ? rawDiffStates(diff.stdout) : null;
  }

  /**
   * One section per repo with changes. A repo below the workspace root gets a
   * header and paths prefixed with its own, so the whole reads as one patch
   * over the workspace; a repo that is the workspace needs neither.
   */
  async reviewDiff(run: IsolationRun): Promise<string> {
    let diff = '';
    for (const repo of run.repos) {
      const prefixes = repo.path === SELF_REPO ? [] : [`--src-prefix=a/${repo.path}/`, `--dst-prefix=b/${repo.path}/`];
      const section = await this.git(repo.root, ['diff', ...prefixes, repo.baseRef, repo.integrationBranch]);
      if (section === '') continue;
      if (repo.path !== SELF_REPO) diff += `# ${repo.path} — ${repo.integrationBranch} against ${repo.baseRef.slice(0, 12)}\n`;
      diff += section;
    }
    return diff;
  }

  mergeIntoCheckedOut(run: IsolationRun): Promise<IsolationMergeResult> {
    return this.inTurn(() => this.mergeAll(run));
  }

  private async mergeAll(run: IsolationRun): Promise<IsolationMergeResult> {
    const partial = await this.settleLanding(run);
    if (partial.length > 0) return { outcome: 'blocked', blocked: partial.map((repo) => ({ repo, reason: 'partial-landing', files: [] })) };
    const repos = await this.reposWithWork(run);
    // One repo needs no preflight: its merge lands or is aborted whole, as it always has.
    if (run.repos.length === 1 || !(await this.canPreflight())) return this.mergeInTurn(repos);
    const blocked: IsolationMergeBlock[] = [];
    for (const repo of repos) {
      const block = await this.preflight(repo);
      if (block) blocked.push(block);
    }
    return blocked.length > 0 ? { outcome: 'blocked', blocked } : this.mergeInTurn(repos);
  }

  /** Repos whose integration branch holds commits their base does not; one git cannot tell about is kept, so its merge says what is wrong. */
  private async reposWithWork(run: IsolationRun): Promise<IsolationRepo[]> {
    const withWork: IsolationRepo[] = [];
    for (const repo of run.repos) {
      const ahead = await this.tryGit(repo.root, ['rev-list', '--count', `${repo.baseRef}..${repo.integrationBranch}`]);
      if (!ahead.ok || Number(ahead.stdout.trim()) > 0) withWork.push(repo);
    }
    return withWork;
  }

  /** `git merge-tree --write-tree`, which merges without touching a tree, arrived in git 2.38. */
  private async canPreflight(): Promise<boolean> {
    const version = await this.tryGit(undefined, ['--version']);
    const [, major, minor] = /(\d+)\.(\d+)/.exec(version.stdout) ?? [];
    return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 38);
  }

  /** Why this repo could not take its merge right now, found without touching the user's tree; null when it can. */
  private async preflight(repo: IsolationRepo): Promise<IsolationMergeBlock | null> {
    const block = (reason: IsolationMergeBlockReason, files: string[] = []): IsolationMergeBlock => ({ repo: repo.path, reason, files });
    if (await this.mergeInProgress(repo.root)) return block('merge-in-progress');

    const trial = await this.tryGit(repo.root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', 'HEAD', repo.integrationBranch]);
    if (!trial.ok) {
      const [tree, ...files] = trial.stdout.split('\0').filter(Boolean);
      // Exit 1 after a tree is a conflict; without one, git could not even try.
      return trial.code === 1 && /^[0-9a-f]{40,64}$/.test(tree ?? '') ? block('conflict', [...new Set(files)]) : block('git-error');
    }

    // Git would refuse to merge over these, or worse, leave a half-merge in a tree holding the user's edits.
    const incoming = await this.tryGit(repo.root, ['diff', '--name-only', '--no-renames', '-z', `HEAD...${repo.integrationBranch}`]);
    const status = await this.tryGit(repo.root, ['status', '--porcelain', '-z', '--untracked-files=no']);
    if (!incoming.ok || !status.ok) return block('git-error');
    const touched = new Set(incoming.stdout.split('\0').filter(Boolean));
    const overlap = statusPaths(status.stdout).filter((file) => touched.has(file));
    return overlap.length > 0 ? block('uncommitted-changes', overlap) : null;
  }

  /** Merge each repo in turn, stopping at the first that does not take its merge. Only a merge started here is ever aborted. */
  private async mergeInTurn(repos: IsolationRepo[]): Promise<IsolationMergeResult> {
    const landed: string[] = [];
    const stopped = (outcome: 'conflict' | 'failed', repo: IsolationRepo, files?: string[]): IsolationMergeResult => ({
      outcome,
      repo: repo.path,
      ...(files ? { files } : {}),
      ...(landed.length > 0 ? { landed } : {}),
    });
    for (const repo of repos) {
      // The user keeps working in this tree during a run. An unfinished merge
      // there is theirs: git refuses ours, and the abort below would otherwise
      // throw away their resolution as if it were ours.
      if (await this.mergeInProgress(repo.root)) return stopped('failed', repo);
      const merge = await this.tryGit(repo.root, ['merge', '--no-edit', repo.integrationBranch]);
      if (merge.ok) {
        landed.push(repo.path);
        continue;
      }
      const files = await this.unmergedPaths(repo.root);
      // Not `abortMerge`: its `reset --hard` fallback is for Ordewell's own
      // integration worktree, and here it would discard uncommitted work.
      if (await this.mergeInProgress(repo.root)) await this.tryGit(repo.root, ['merge', '--abort']);
      return files.length > 0 ? stopped('conflict', repo, files) : stopped('failed', repo);
    }
    return { outcome: 'merged' };
  }

  discard(run: IsolationRun, opts: { integration: IntegrationDisposal }): Promise<IsolationRemoval> {
    return this.inTurn(() => this.admin(run.workspaceRoot, async () => {
      await this.removeIntegrationWorktrees(run);
      const removal = noRemoval();
      for (const record of Object.values(run.tasks)) {
        absorbRemoval(removal, await this.removeTask(run, record, { dropRecord: record.status !== 'merged' }));
      }
      absorbRemoval(removal, await this.removeUnowned(run));
      if (opts.integration !== 'keep') {
        for (const repo of run.repos) {
          if (opts.integration === 'delete') await this.tryGit(repo.root, ['branch', '-D', repo.integrationBranch]);
          else await this.deleteIfMerged(repo.root, repo.integrationBranch);
        }
        // A refused worktree keeps its record: the one pointer left to what is still in it.
        const refused = new Set(removal.refused.flatMap((r) => (r.task ? [r.task.taskId] : [])));
        run.tasks = Object.fromEntries(Object.entries(run.tasks).filter(([taskId]) => refused.has(taskId)));
        this.removeIfEmpty(this.runRoot(run));
      }
      for (const repo of run.repos) await this.tryGit(repo.root, ['worktree', 'prune']);
      return removal;
    }));
  }

  sweep(run: IsolationRun): Promise<void> {
    return this.admin(run.workspaceRoot, async () => {
      const failed: string[] = [];
      for (const repo of run.repos) {
        if (!(await this.sweepRepo(run, repo))) failed.push(repo.path);
      }
      if (failed.length > 0) throw new Error(`git failed clearing merged branches of earlier runs in ${failed.join(', ')}`);
    });
  }

  /** False when git failed anywhere; the other branches are still tried. */
  private async sweepRepo(run: IsolationRun, repo: IsolationRepo): Promise<boolean> {
    await this.tryGit(repo.root, ['worktree', 'prune']);
    const worktrees = await this.tryGit(repo.root, ['worktree', 'list', '--porcelain']);
    const refs = await this.tryGit(repo.root, ['for-each-ref', '--format=%(refname)', 'refs/heads/ordewell/']);
    if (!worktrees.ok || !refs.ok) return false;

    const checkedOut = new Set<string>();
    const liveRuns = new Set<string>();
    for (const line of worktrees.stdout.split(/\r?\n/)) {
      if (line.startsWith('branch refs/heads/')) checkedOut.add(line.slice('branch refs/heads/'.length));
      const runId = line.startsWith('worktree ') ? RUN_WORKTREE.exec(line)?.[1] : undefined;
      if (runId) liveRuns.add(runId);
    }

    let ok = true;
    for (const ref of refs.stdout.split(/\r?\n/).filter(Boolean)) {
      const branch = ref.slice('refs/heads/'.length);
      const runId = RUN_BRANCH.exec(branch)?.[1];
      if (!runId || runId === run.id || liveRuns.has(runId) || checkedOut.has(branch)) continue;
      if ((await this.deleteIfMerged(repo.root, branch)) === 'failed') ok = false;
    }
    return ok;
  }

  /**
   * Delete `branch` only if the repo's checked-out HEAD already contains it —
   * HEAD, not an upstream: what the user has checked out is what they merged
   * into. `-d` rather than `-D`, so git also refuses a branch a worktree has
   * checked out.
   */
  private async deleteIfMerged(root: string, branch: string): Promise<'deleted' | 'kept' | 'failed'> {
    const merged = await this.tryGit(root, ['merge-base', '--is-ancestor', branch, 'HEAD']);
    if (!merged.ok) return merged.code === 1 ? 'kept' : 'failed';
    return (await this.tryGit(root, ['branch', '-d', branch])).ok ? 'deleted' : 'failed';
  }

  private async drain(): Promise<void> {
    try {
      while (this.waiting.length > 0) {
        // Only ever the lowest order among tasks already waiting: blocking for a
        // lower one that has not finished would deadlock against its dependents.
        const runId = this.waiting[0].run.id;
        let pick = -1;
        this.waiting.forEach((entry, i) => {
          if (entry.run.id === runId && (pick < 0 || entry.task.order < this.waiting[pick].task.order)) pick = i;
        });
        const [entry] = this.waiting.splice(pick, 1);
        entry.settle(await this.inTurn(() => this.land(entry.task, entry.run, entry.persist)).catch((): IsolationOutcome => 'failed'));
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Land a task in every repo it changed, or in none. The tips are recorded
   * on the run and persisted before the first merge, so a rollback — now, or
   * after a crash — knows exactly what to return to.
   */
  private async land(task: Task, run: IsolationRun, persist: () => void): Promise<IsolationOutcome> {
    const record = run.tasks[task.id];
    if (!record) return 'failed';
    if (record.status === 'merged') return 'merged';
    // A landing left half-rolled-back would have this one merged on top of it.
    if ((await this.settleLanding(run)).length > 0) return this.stopLanding(record, 'failed');

    const changed: IsolationRepo[] = [];
    for (const repo of run.repos) {
      const entry = record.repos[repo.path];
      if (!entry) continue;
      // Named before git is asked: a worktree removed under a running attempt
      // fails every git call with the same opaque error, and the user needs to
      // know the directory is gone, not that a command exited non-zero.
      if (!fs.existsSync(entry.worktree)) {
        return this.stopLanding(record, 'failed', repo, undefined, `its worktree is gone (${entry.worktree})`);
      }
      try {
        await this.commitWorktree(repo, entry, firstLine(record.title));
      } catch (err) {
        const detail = firstLine(err instanceof Error ? err.message : String(err));
        return this.stopLanding(record, 'failed', repo, undefined, `git could not commit its work (${detail})`);
      }
      // A resolver may have landed this branch already; what it changed stays recorded.
      if (await this.brings(repo, record.branch)) {
        entry.changed = true;
        changed.push(repo);
      } else {
        entry.changed ??= false;
      }
    }

    if (changed.length > 0) {
      try {
        const tips: Record<string, string> = {};
        for (const repo of changed) tips[repo.path] = (await this.git(repo.root, ['rev-parse', '--verify', repo.integrationBranch])).trim();
        run.landing = { taskId: task.id, tips };
        persist();
      } catch {
        delete run.landing;
        return this.stopLanding(record, 'failed');
      }
      for (const repo of changed) {
        const { outcome, files, error } = await this.mergeTask(run, repo, record);
        if (outcome === 'merged') continue;
        return (await this.settleLanding(run)).length === 0 ? this.stopLanding(record, outcome, repo, files, error) : this.stopLanding(record, 'failed', repo);
      }
    }

    for (const repo of changed) {
      const tip = await this.tryGit(repo.root, ['rev-parse', '--verify', '-q', repo.integrationBranch]);
      if (tip.ok) record.repos[repo.path].landedTip = tip.stdout.trim();
    }
    // No await between these: a persist must never see the landing cleared without the task merged.
    delete run.landing;
    settleStatus(record, 'merged');
    delete record.conflictRepo;
    delete record.conflictFiles;
    delete record.landingError;
    // The work is on the integration branches already; a stuck cleanup must
    // not turn that into a failure. `pruneOrphans` sweeps up whatever it leaves.
    await this.admin(run.workspaceRoot, () => this.removeTask(run, record, { dropRecord: false })).catch(() => undefined);
    return 'merged';
  }

  private stopLanding(record: IsolationTaskRecord, outcome: Exclude<IsolationOutcome, 'merged'>, repo?: IsolationRepo, files?: string[], error?: string): IsolationOutcome {
    settleStatus(record, outcome);
    if (error) record.landingError = error;
    else delete record.landingError;
    if (repo) record.conflictRepo = repo.path;
    else delete record.conflictRepo;
    if (files && files.length > 0) record.conflictFiles = files;
    else delete record.conflictFiles;
    return outcome;
  }

  /** Merge the task branch into one repo's integration branch. A merge that does not complete is aborted: it is Ordewell's own. */
  private async mergeTask(run: IsolationRun, repo: IsolationRepo, record: IsolationTaskRecord): Promise<{ outcome: IsolationOutcome; files: string[]; error?: string }> {
    let dir: string;
    try {
      dir = await this.ensureIntegrationWorktree(run, repo);
    } catch (err) {
      return { outcome: 'failed', files: [], error: await this.integrationWorktreeError(repo, err) };
    }
    const merge = await this.tryGit(dir, ['merge', '--no-ff', '--no-edit', '-m', `Merge: ${firstLine(record.title)}`, record.branch]);
    if (merge.ok) return { outcome: 'merged', files: [] };
    // A hook that refuses the merge commit leaves a merge in progress with nothing unmerged: a failure, not a conflict.
    const files = await this.unmergedPaths(dir);
    if (await this.mergeInProgress(dir)) await this.abortMerge(dir);
    return { outcome: files.length > 0 ? 'conflict' : 'failed', files };
  }

  /**
   * Why the integration worktree could not be prepared. Git refuses to check a
   * branch out in two worktrees at once, so the usual cause is the integration
   * branch sitting in the user's own checkout; naming it is the actionable part
   * of git's error, which would otherwise be dropped.
   */
  private async integrationWorktreeError(repo: IsolationRepo, err: unknown): Promise<string> {
    const holder = await this.worktreeHolding(repo, repo.integrationBranch);
    if (holder) return `the integration branch is checked out in ${holder}`;
    return `git could not prepare its integration worktree (${firstLine(err instanceof Error ? err.message : String(err))})`;
  }

  /**
   * Return every repo of the landing in flight to its recorded tip, then
   * forget the landing. Resolves to the repos still holding part of it: a tip
   * git would not move stays recorded, so the next attempt tries again rather
   * than building on top of it.
   */
  private async settleLanding(run: IsolationRun): Promise<string[]> {
    const landing = run.landing;
    if (!landing) return [];
    const unsettled: string[] = [];
    for (const repo of run.repos) {
      const tip = landing.tips[repo.path];
      if (tip !== undefined && !(await this.restoreTip(run, repo, tip))) unsettled.push(repo.path);
    }
    if (unsettled.length === 0) delete run.landing;
    return unsettled;
  }

  /**
   * Put a repo's integration branch back at `tip`. Only ever a branch
   * Ordewell owns, and only when what sits on it is one merge on top of `tip`
   * — the one the serialized queue made; anything else is left alone, since
   * resetting it could drop work that is not this landing's. The branch
   * moves with Ordewell's integration worktree if it is checked out there,
   * and not at all if it is checked out anywhere else.
   */
  private async restoreTip(run: IsolationRun, repo: IsolationRepo, tip: string): Promise<boolean> {
    const current = await this.tryGit(repo.root, ['rev-parse', '--verify', '-q', repo.integrationBranch]);
    if (!current.ok) return false;
    const head = current.stdout.trim();
    if (head === tip) return true;
    const parent = await this.tryGit(repo.root, ['rev-parse', '--verify', '-q', `${head}^1`]);
    const merge = await this.tryGit(repo.root, ['rev-parse', '--verify', '-q', `${head}^2`]);
    if (!merge.ok || parent.stdout.trim() !== tip) return false;

    const holder = await this.worktreeHolding(repo, repo.integrationBranch);
    if (holder === null) return (await this.tryGit(repo.root, ['update-ref', `refs/heads/${repo.integrationBranch}`, tip, head])).ok;
    if (!sameDir(holder, this.integrationDir(run, repo))) return false;
    return (await this.tryGit(holder, ['reset', '-q', '--hard', tip])).ok;
  }

  /** The worktree that has `branch` checked out, or null when none does. */
  private async worktreeHolding(repo: IsolationRepo, branch: string): Promise<string | null> {
    // Not `-z`: that needs git 2.36, and the Merge-all fallback serves older git.
    const listed = await this.tryGit(repo.root, ['worktree', 'list', '--porcelain']);
    let worktree: string | null = null;
    for (const line of listed.stdout.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) worktree = line.slice('worktree '.length);
      else if (line === `branch refs/heads/${branch}`) return worktree;
    }
    return null;
  }

  /** Whether the task branch holds commits the repo's integration branch does not. */
  private async brings(repo: IsolationRepo, branch: string): Promise<boolean> {
    const ahead = await this.tryGit(repo.root, ['rev-list', '--count', `${repo.integrationBranch}..${branch}`]);
    return ahead.ok && Number(ahead.stdout.trim()) > 0;
  }

  private async commitWorktree(repo: IsolationRepo, entry: Pick<IsolationTaskRepo, 'worktree' | 'linked'>, message: string, opts: { rescue?: boolean } = {}): Promise<void> {
    // Bootstrapped links are untracked, and an ignore rule like `node_modules/`
    // does not match a symlink — without this they would be committed. Staging
    // one that is a junction would even walk into the main tree's contents.
    // Only links git does not already ignore need excluding: naming an ignored
    // path such as `.env` in an exclude pathspec makes `add` refuse.
    const prefix = await this.prefixOf(repo);
    const excludes: string[] = [];
    for (const name of entry.linked) {
      if ((await this.tryGit(entry.worktree, ['check-ignore', '-q', '--', prefix + name])).ok) continue;
      excludes.push(`:(exclude,literal)${(prefix + name).replace(/\\/g, '/')}`);
    }
    await this.git(entry.worktree, ['add', '-A', '--', '.', ...excludes]);
    const staged = await this.tryGit(entry.worktree, ['diff', '--cached', '--quiet']);
    if (staged.ok) return;
    // A rescue exists only so a removal deletes nothing: a hook that refuses
    // the commit, or a signing prompt nobody will answer, must not stop it.
    const commit = opts.rescue ? ['-c', 'commit.gpgsign=false', 'commit', '--no-verify'] : ['commit'];
    await this.git(entry.worktree, [...commit, '-q', '-m', message]);
  }

  private integrationDir(run: IsolationRun, repo: IsolationRepo): string {
    return path.join(this.runRoot(run), INTEGRATION_DIR, repo.path);
  }

  private async ensureIntegrationWorktree(run: IsolationRun, repo: IsolationRepo): Promise<string> {
    return this.admin(run.workspaceRoot, async () => {
      const dir = this.integrationDir(run, repo);
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      await this.tryGit(repo.root, ['worktree', 'prune']);
      ensureStateDirIgnored(run.workspaceRoot);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await this.git(repo.root, ['worktree', 'add', '-q', dir, repo.integrationBranch]);
      return dir;
    });
  }

  private async removeIntegrationWorktrees(run: IsolationRun): Promise<void> {
    for (const repo of run.repos) await this.removeWorktreeDir(run, repo, this.integrationDir(run, repo), []);
  }

  /**
   * A task's worktrees and branch go, and with `dropRecord` its record — but
   * never work that has not landed: that is kept on a branch first
   * ({@link preserve}), and a task whose work cannot be kept in every repo
   * loses nothing, record included. `preserve: false` is only for what a
   * failed `prepare` made a moment ago, which holds no work yet.
   */
  private async removeTask(run: IsolationRun, record: IsolationTaskRecord, opts: { dropRecord: boolean; preserve?: boolean }): Promise<IsolationRemoval> {
    const task = { taskId: record.taskId, order: record.order, title: record.title };
    const removal = noRemoval();
    for (const repo of opts.preserve === false ? [] : run.repos) {
      const entry = record.repos[repo.path];
      const target: RemovalTarget = { worktree: entry?.worktree, linked: entry?.linked ?? [], branch: record.branch, name: path.basename(record.workspace), title: record.title };
      try {
        const kept = await this.preserve(run, repo, target);
        if (kept) removal.preserved.push({ task, ...kept });
      } catch (err) {
        removal.refused.push({ task, worktree: entry?.worktree ?? record.workspace, reason: firstLine(err instanceof Error ? err.message : String(err)) });
        return removal;
      }
    }
    for (const repo of run.repos) {
      const entry = record.repos[repo.path];
      if (entry) await this.removeWorktreeDir(run, repo, entry.worktree, entry.linked);
      await this.tryGit(repo.root, ['branch', '-D', record.branch]);
    }
    this.removeTaskWorkspace(run, record.workspace);
    if (opts.dropRecord) delete run.tasks[record.taskId];
    return removal;
  }

  /**
   * Keep what one repo's share of a worktree holds that has not landed, before
   * it is removed: edits never committed go into a rescue commit on whatever
   * the worktree has checked out, and that tip gets a branch of its own under
   * `ordewell-preserved/<run-id>/`. With no worktree left, it is the task
   * branch's tip that is kept. Null when there is nothing to keep — the tip is
   * on the integration branch, or in what the user has checked out. Throws when
   * there is work git cannot keep, and the caller then removes nothing.
   */
  private async preserve(run: IsolationRun, repo: IsolationRepo, target: RemovalTarget): Promise<Omit<PreservedWork, 'task'> | null> {
    const tip = await this.tipToKeep(repo, target);
    if (tip === null) return null;
    for (const into of [repo.integrationBranch, 'HEAD']) {
      if ((await this.tryGit(repo.root, ['merge-base', '--is-ancestor', tip, into])).ok) return null;
    }
    return { repo: repo.path, branch: await this.preservedBranch(run, repo, target.name, tip), commit: tip };
  }

  private async tipToKeep(repo: IsolationRepo, target: RemovalTarget): Promise<string | null> {
    const { worktree } = target;
    if (worktree && fs.existsSync(worktree)) {
      // Asked outside a worktree, git would answer for the repository around it.
      if (!hasGitEntry(worktree)) throw new Error('it is not a git worktree any more');
      if (await this.worktreeHasChanges({ worktree, linked: target.linked }, await this.prefixOf(repo))) {
        await this.commitWorktree(repo, { worktree, linked: target.linked }, `WIP: ${firstLine(target.title)} (kept by Ordewell before removing its worktree)`, { rescue: true });
      }
      return (await this.git(worktree, ['rev-parse', '--verify', 'HEAD'])).trim();
    }
    if (target.branch === null) return null;
    const branch = await this.tryGit(repo.root, ['rev-parse', '--verify', '-q', `refs/heads/${target.branch}`]);
    return branch.ok ? branch.stdout.trim() : null;
  }

  /** A new branch at `tip` named for the task; never one that already holds something else. */
  private async preservedBranch(run: IsolationRun, repo: IsolationRepo, name: string, tip: string): Promise<string> {
    const base = `${PRESERVED_BRANCHES}/${run.id}/${name}`;
    for (let n = 1; n < 100; n++) {
      const branch = n === 1 ? base : `${base}-${n}`;
      const existing = await this.tryGit(repo.root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
      if (existing.ok && existing.stdout.trim() === tip) return branch;
      if (existing.ok) continue;
      await this.git(repo.root, ['branch', '--no-track', branch, tip]);
      return branch;
    }
    throw new Error(`no free branch name under ${base}`);
  }

  /**
   * What is left of a task workspace once its worktrees are gone: the shared
   * links and the directories that held deeper repos. Links are unlinked
   * first, so removing the rest can never walk into the real workspace.
   */
  private removeTaskWorkspace(run: IsolationRun, dir: string): void {
    if (!isInside(this.runRoot(run), dir) || !fs.existsSync(dir)) return;
    this.unlinkLinksUnder(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  private unlinkLinksUnder(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) this.unlinkIfLink(target);
      else if (entry.isDirectory()) this.unlinkLinksUnder(target);
    }
  }

  /**
   * Task workspaces and branches under this run that no record accounts for —
   * what a crash or a lost save leaves. No record says what was linked in, so
   * whatever a workspace still has linked is left out of what counts as work.
   */
  private async removeUnowned(run: IsolationRun): Promise<IsolationRemoval> {
    const removal = noRemoval();
    const keep = async (repo: IsolationRepo, target: RemovalTarget, worktree: string): Promise<boolean> => {
      try {
        const kept = await this.preserve(run, repo, target);
        // A leftover workspace's branch is left over too, and is kept at the same tip.
        if (kept && !removal.preserved.some((p) => p.repo === kept.repo && p.branch === kept.branch)) removal.preserved.push(kept);
        return true;
      } catch (err) {
        removal.refused.push({ worktree, reason: firstLine(err instanceof Error ? err.message : String(err)) });
        return false;
      }
    };
    const owned = new Set(Object.values(run.tasks).map((r) => path.resolve(r.workspace)));
    const root = this.runRoot(run);
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        const dir = path.join(root, entry);
        if (entry === INTEGRATION_DIR || owned.has(path.resolve(dir))) continue;
        let kept = true;
        for (const repo of run.repos) {
          const worktree = path.join(dir, repo.path);
          const linked = leftoverLinks(path.join(worktree, await this.prefixOf(repo)));
          if (!(await keep(repo, { worktree, linked, branch: null, name: entry, title: entry }, worktree))) kept = false;
        }
        if (!kept) continue;
        for (const repo of run.repos) await this.removeWorktreeDir(run, repo, path.join(dir, repo.path), []);
        this.removeTaskWorkspace(run, dir);
      }
    }
    const taskBranches = Object.values(run.tasks).map((r) => r.branch);
    for (const repo of run.repos) {
      const ownedBranches = new Set([repo.integrationBranch, ...taskBranches]);
      const listed = await this.tryGit(repo.root, ['branch', '--list', `ordewell/${run.id}/*`, '--format=%(refname:short)']);
      for (const branch of listed.stdout.split('\n').map((b) => b.trim()).filter(Boolean)) {
        if (ownedBranches.has(branch)) continue;
        const name = branch.slice(branch.lastIndexOf('/') + 1);
        if (await keep(repo, { linked: [], branch, name, title: name }, branch)) await this.tryGit(repo.root, ['branch', '-D', branch]);
      }
    }
    return removal;
  }

  private async removeWorktreeDir(run: IsolationRun, repo: IsolationRepo, dir: string, linked: string[]): Promise<void> {
    // Links first, so no removal path can ever walk through one into the main
    // worktree's node_modules. A mirrored install is a real directory of links;
    // it is found again from package.json when no record names it.
    for (const name of new Set([...linked, ...installDirs(dir)])) {
      const target = path.join(dir, name);
      this.unlinkIfLink(target);
      this.unlinkLinksUnder(target);
    }
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (LINKED_ARTIFACTS.has(name) || isEnvFile(name)) this.unlinkIfLink(path.join(dir, name));
    }
    await this.tryGit(repo.root, ['worktree', 'remove', '--force', dir]);
    if (fs.existsSync(dir) && isInside(this.runRoot(run), dir)) fs.rmSync(dir, { recursive: true, force: true });
    await this.tryGit(repo.root, ['worktree', 'prune']);
    // A deeper repo's worktree leaves the directories above it behind.
    for (let parent = path.dirname(dir); isInside(this.runRoot(run), parent); parent = path.dirname(parent)) this.removeIfEmpty(parent);
  }

  private unlinkIfLink(target: string): void {
    try {
      if (fs.lstatSync(target).isSymbolicLink()) fs.rmSync(target, { force: true });
    } catch { /* nothing there */ }
  }

  private removeIfEmpty(dir: string): void {
    try { fs.rmdirSync(dir); } catch { /* not empty, or already gone */ }
  }

  private runRoot(run: IsolationRun): string {
    return path.join(run.workspaceRoot, STATE_DIR, 'worktrees', run.id);
  }

  private namesFor(run: IsolationRun, task: Task): { branch: string; dir: string } {
    const slug = sanitizeSlug(task.title).slice(0, 40).replace(/-+$/, '') || 'task';
    let name = `${task.order}-${slug}`;
    const clash = Object.values(run.tasks).some((r) => r.taskId !== task.id && r.branch === `ordewell/${run.id}/${name}`);
    if (clash) name = `${name}-${sanitizeSlug(task.id) || 'x'}`;
    return { branch: `ordewell/${run.id}/${name}`, dir: path.join(this.runRoot(run), name) };
  }

  private async unmergedPaths(cwd: string): Promise<string[]> {
    const listed = await this.tryGit(cwd, ['diff', '--name-only', '-z', '--diff-filter=U']);
    return [...new Set(listed.stdout.split('\0').filter(Boolean))];
  }

  private async mergeInProgress(cwd: string): Promise<boolean> {
    if ((await this.tryGit(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok) return true;
    return (await this.tryGit(cwd, ['ls-files', '-u'])).stdout.trim() !== '';
  }

  private async abortMerge(cwd: string): Promise<void> {
    if (!(await this.tryGit(cwd, ['merge', '--abort'])).ok) await this.tryGit(cwd, ['reset', '--hard']);
  }

  private inTurn<T>(fn: () => Promise<T>): Promise<T> {
    return this.locks.inTurn(fn);
  }

  private admin<T>(workspaceRoot: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.admin(workspaceRoot, fn);
  }

  private tryGit(cwd: string | undefined, args: string[]): Promise<GitResult> {
    return tryGit(this.gitInvoker, cwd, args);
  }

  private git(cwd: string, args: string[]): Promise<string> {
    return git(this.gitInvoker, cwd, args);
  }
}

export function createWorktreeIsolation(deps: WorktreeIsolationDeps): IWorktreeIsolation {
  return new GitWorktreeIsolation(deps);
}
