import { execFile, exec } from 'child_process';
import { promisify } from 'util';
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
  IsolationRepo,
  IsolationRun,
  IsolationTaskRecord,
  IsolationTaskRepo,
  IWorktreeIsolation,
  PreparedTask,
} from '../interfaces/IWorktreeIsolation';
import type { Task } from '../models/Task';
import { augmentedPath, withPath } from '../utils/shellPath';
import { ensureStateDirIgnored, STATE_DIR } from '../utils/fsHelpers';
import { sanitizeSlug } from '../utils/prdStore';
import { handoffOf, integrationBranchFor, repoRootOf, SELF_REPO } from './isolationRecord';
import { linkPath } from './worktreeLink';

export type GitExecFn = (
  file: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface WorktreeIsolationDeps {
  config: Pick<IConfig, 'worktreeIsolation' | 'worktreeSetupCommand' | 'workspaceRepos' | 'worktreeLinks'>;
  /** Test seam: every git invocation goes through this. */
  execFileImpl?: GitExecFn;
  resolvePath?: () => Promise<string>;
  platform?: NodeJS.Platform;
  mintRunId?: () => string;
}

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// Generous on purpose: `reviewDiff` returns the whole run's diff in one buffer.
const MAX_BUFFER = 64 * 1024 * 1024;
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

const defaultExecFile: GitExecFn = async (file, args, opts) => {
  const { stdout, stderr } = await execFileAsync(file, args, { cwd: opts.cwd, env: opts.env, maxBuffer: MAX_BUFFER, windowsHide: true });
  return { stdout: String(stdout), stderr: String(stderr) };
};

// A hook or wrapper that runs Ordewell can export these, and they would point
// every git call at the outer repository instead of the workspace's.
const INHERITED_GIT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY'];

/**
 * Ignored artifacts worth sharing with a task worktree so it is runnable at
 * once. `.ordewell/` is deliberately not here and never will be: session and
 * skills state stays at the main root where Ordewell owns it, and a runner
 * that could reach it could corrupt it.
 */
const LINKED_ARTIFACTS = new Set(['node_modules', 'vendor', '.venv', '.claude', '.opencode', '.codegraph', '.envrc']);
const isEnvFile = (name: string) => name.startsWith('.env');

const INTEGRATION_DIR = 'integration';

// How far below the workspace root a repository is looked for. Deeper ones are
// not scanned for: a walk of the whole tree would visit every dependency folder.
const NESTED_REPO_DEPTH = 2;
const NEVER_SCANNED = new Set(['.git', STATE_DIR, 'node_modules']);
const GITLINK_MODE = '160000';

interface GitResult { ok: boolean; stdout: string; stderr: string; code?: string | number }

/** The repo group a workspace forms, or the reason it forms none. */
type GroupScan = { paths: string[] } | { refused: IsolationAvailability };

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

// A `.git` file rather than a directory marks a linked worktree or a submodule checkout.
function hasGitEntry(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
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

function sameDir(a: string, b: string): boolean {
  const real = (p: string) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
}

function lexists(target: string): boolean {
  try { fs.lstatSync(target); return true; } catch { return false; }
}

function resolves(target: string): boolean {
  try { fs.statSync(target); return true; } catch { return false; }
}

function listDir(dir: string): string[] {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
}

/** An inactive availability naming `repos`; `.` is not a name, so a group of one names none. */
function inactive(reason: IsolationInactiveReason, repos: string[]): IsolationAvailability {
  const named = repos.filter((r) => r !== SELF_REPO);
  return named.length > 0 ? { active: false, reason, repos: named } : { active: false, reason };
}

/** A `workspaceRepos` entry as a group path, or null for one that is not below the workspace. */
function groupPathOf(listed: string): string | null {
  const slashed = listed.trim().replace(/\\/g, '/');
  if (path.posix.isAbsolute(slashed) || path.win32.isAbsolute(slashed)) return null;
  const rel = path.posix.normalize(slashed).replace(/\/+$/, '');
  return rel === '' || rel === '.' || rel === '..' || rel.startsWith('../') ? null : rel;
}

/**
 * The `worktreeLinks` entries present under `root`, relative to it. `*` and
 * `?` match within one path segment; there is no `**`, so a pattern never
 * walks a whole tree.
 */
function matchLinks(root: string, patterns: string[]): string[] {
  const found = new Set<string>();
  for (const pattern of patterns) {
    const segments = pattern.replace(/\\/g, '/').split('/').filter((seg) => seg !== '' && seg !== '.');
    if (segments.length === 0 || segments.includes('..')) continue;
    let matches = [''];
    for (const segment of segments) matches = matches.flatMap((base) => segmentMatches(root, base, segment));
    for (const match of matches) found.add(match);
  }
  return [...found];
}

function segmentMatches(root: string, base: string, segment: string): string[] {
  const under = (name: string) => (base ? `${base}/${name}` : name);
  if (!/[*?]/.test(segment)) return lexists(path.join(root, base, segment)) ? [under(segment)] : [];
  const pattern = new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return listDir(path.join(root, base)).filter((name) => !NEVER_SCANNED.has(name) && pattern.test(name)).map(under);
}

class GitWorktreeIsolation implements IWorktreeIsolation {
  private readonly execFileImpl: GitExecFn;
  private readonly resolvePath: () => Promise<string>;
  private readonly platform: NodeJS.Platform;
  private readonly mintRunId: () => string;

  // Worktree and branch bookkeeping serialised per repository: concurrent
  // `git worktree add`s race on the shared admin files.
  private readonly adminChains = new Map<string, Promise<unknown>>();
  private waiting: QueuedMerge[] = [];
  private draining = false;

  constructor(private readonly deps: WorktreeIsolationDeps) {
    this.execFileImpl = deps.execFileImpl ?? defaultExecFile;
    this.resolvePath = deps.resolvePath ?? (() => augmentedPath());
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
    return committed.includes(SELF_REPO) ? { active: true } : { active: true, repos: committed, shared: this.sharedPaths(workspaceRoot, committed) };
  }

  /**
   * A workspace inside a repository is a group of one at `.`. A folder that is
   * not forms a group from `workspaceRepos` when set, otherwise from the
   * repositories directly inside it.
   */
  private async scanGroup(workspaceRoot: string): Promise<GroupScan> {
    // cwd may not exist; any failure here is "not a repository" as far as the caller can act on it.
    const toplevel = await this.tryGit(workspaceRoot, ['rev-parse', '--show-toplevel']);
    if (toplevel.ok) {
      const nested = await this.nestedRepos(workspaceRoot, toplevel.stdout.trim());
      return nested.length > 0 ? { refused: { active: false, reason: 'nested-repos', repos: nested } } : { paths: [SELF_REPO] };
    }
    const paths = this.groupPaths(workspaceRoot);
    return paths.length > 0 ? { paths } : { refused: { active: false, reason: 'not-git' } };
  }

  private groupPaths(workspaceRoot: string): string[] {
    const listed = this.deps.config.workspaceRepos;
    if (listed.length === 0) return this.reposDirectlyIn(workspaceRoot);
    const paths = listed
      .map(groupPathOf)
      .filter((rel): rel is string => rel !== null && hasGitEntry(path.join(workspaceRoot, rel)));
    return [...new Set(paths)].sort();
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

  private reposDirectlyIn(dir: string): string[] {
    return this.childDirs(dir).filter((name) => hasGitEntry(path.join(dir, name)));
  }

  private childDirs(dir: string): string[] {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !NEVER_SCANNED.has(e.name))
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Repositories below the workspace that the outer repository does not own as
   * submodules. Isolating the outer one would leave them out of every task
   * worktree, so the agents would edit them live.
   */
  private async nestedRepos(workspaceRoot: string, toplevel: string): Promise<string[]> {
    const found: string[] = [];
    const walk = (rel: string, depth: number): void => {
      for (const name of this.childDirs(path.join(workspaceRoot, rel))) {
        const child = rel ? `${rel}/${name}` : name;
        if (hasGitEntry(path.join(workspaceRoot, child))) found.push(child);
        else if (depth < NESTED_REPO_DEPTH) walk(child, depth + 1);
      }
    };
    walk('', 1);
    if (found.length === 0) return [];

    // One call each rather than a batch: `-z` needs `--stdin`, and unquoted output is not guaranteed for odd names.
    const ignored = new Set(
      (await Promise.all(found.map(async (rel) => ((await this.tryGit(workspaceRoot, ['check-ignore', '-q', '--', rel])).ok ? rel : null))))
        .filter((rel): rel is string => rel !== null),
    );
    const owned = await this.submodulePaths(workspaceRoot, toplevel);
    const prefix = (await this.tryGit(workspaceRoot, ['rev-parse', '--show-prefix'])).stdout.trim();
    return found.filter((rel) => !ignored.has(rel) && !owned.has(`${prefix}${rel}`));
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
      const run: IsolationRun = { id: this.mintRunId(), workspaceRoot, repos: [], shared: [], sharedRepos: [], tasks: {} };
      for (const repoPath of 'paths' in scan ? scan.paths : [SELF_REPO]) {
        const repo = await this.startRepo(run, repoPath);
        if (repo) run.repos.push(repo);
        else run.sharedRepos.push(repoPath);
      }
      if (run.repos.length === 0) throw new Error(`No repository could be isolated: ${run.sharedRepos.join(', ')}`);
      run.shared = this.sharedPaths(workspaceRoot, run.repos.map((r) => r.path));
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
      if (previous) await this.removeTask(run, previous, { dropRecord: true });

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

        // Taken afresh for every task: a loose file the user adds mid-run is shared from the next one on.
        run.shared = this.sharedPaths(run.workspaceRoot, run.repos.map((r) => r.path));
        for (const rel of run.shared) {
          const target = path.join(dir, rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (linkPath(path.join(run.workspaceRoot, rel), target, this.platform) === 'copy') copied.push(rel);
        }

        for (const repo of run.repos) {
          const entry = record.repos[repo.path];
          const inRepo = await this.inWorkspacePlace(repo, entry.worktree);
          if (repo.path === SELF_REPO) cwd = inRepo;
          const boot = await this.bootstrap(repo, inRepo);
          entry.linked = boot.linked;
          copied.push(...boot.copied.map((name) => path.posix.join(repo.path, name)));
        }
      } catch (err) {
        record.status = 'failed';
        await this.removeTask(run, record, { dropRecord: false });
        throw err;
      }
      run.tasks[task.id] = record;
      return { cwd, branch, copied };
    });
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

  release(run: IsolationRun, taskId: string, opts: { keep: boolean }): Promise<void> {
    return this.admin(run.workspaceRoot, async () => {
      const record = run.tasks[taskId];
      if (!record) return;
      if (opts.keep) {
        // Off `active` so a crash-recovery prune does not mistake a kept attempt for an orphan.
        if (record.status === 'active') record.status = 'kept';
        return;
      }
      await this.removeTask(run, record, { dropRecord: true });
    });
  }

  handoff(run: IsolationRun): Promise<IsolationHandoff> {
    return this.admin(run.workspaceRoot, async () => {
      // A branch checked out in a worktree cannot be checked out in the main
      // one, and the user is about to review it.
      await this.removeIntegrationWorktrees(run);
      await this.settleLanding(run);
      return handoffOf(run);
    });
  }

  pruneOrphans(run: IsolationRun): Promise<void> {
    return this.admin(run.workspaceRoot, async () => {
      // A half-finished merge from a crash is easier to drop than to repair;
      // the branch refs are the only state that matters. What a landing had
      // merged goes back too, since the run was saved as not having it.
      await this.removeIntegrationWorktrees(run);
      await this.settleLanding(run);
      for (const record of Object.values(run.tasks)) {
        if (record.status === 'active') await this.removeTask(run, record, { dropRecord: true });
        else if (record.status === 'merged') await this.removeTask(run, record, { dropRecord: false });
      }
      await this.removeUnowned(run);
      for (const repo of run.repos) await this.tryGit(repo.root, ['worktree', 'prune']);
    });
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

  async mergeIntoCheckedOut(run: IsolationRun): Promise<IsolationMergeResult> {
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

  discard(run: IsolationRun, opts: { keepIntegration: boolean }): Promise<void> {
    return this.admin(run.workspaceRoot, async () => {
      await this.removeIntegrationWorktrees(run);
      for (const record of Object.values(run.tasks)) {
        await this.removeTask(run, record, { dropRecord: record.status !== 'merged' });
      }
      await this.removeUnowned(run);
      if (!opts.keepIntegration) {
        for (const repo of run.repos) await this.tryGit(repo.root, ['branch', '-D', repo.integrationBranch]);
        run.tasks = {};
        this.removeIfEmpty(this.runRoot(run));
      }
      for (const repo of run.repos) await this.tryGit(repo.root, ['worktree', 'prune']);
    });
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
        entry.settle(await this.land(entry.task, entry.run, entry.persist).catch((): IsolationOutcome => 'failed'));
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
      try {
        await this.commitWorktree(repo, record, entry);
      } catch {
        return this.stopLanding(record, 'failed', repo);
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
        const outcome = await this.mergeTask(run, repo, record);
        if (outcome === 'merged') continue;
        return (await this.settleLanding(run)).length === 0 ? this.stopLanding(record, outcome, repo) : this.stopLanding(record, 'failed', repo);
      }
    }

    // No await between these: a persist must never see the landing cleared without the task merged.
    delete run.landing;
    record.status = 'merged';
    delete record.conflictRepo;
    // The work is on the integration branches already; a stuck cleanup must
    // not turn that into a failure. `pruneOrphans` sweeps up whatever it leaves.
    await this.admin(run.workspaceRoot, () => this.removeTask(run, record, { dropRecord: false })).catch(() => undefined);
    return 'merged';
  }

  private stopLanding(record: IsolationTaskRecord, outcome: Exclude<IsolationOutcome, 'merged'>, repo?: IsolationRepo): IsolationOutcome {
    record.status = outcome;
    if (repo) record.conflictRepo = repo.path;
    else delete record.conflictRepo;
    return outcome;
  }

  /** Merge the task branch into one repo's integration branch. A merge that does not complete is aborted: it is Ordewell's own. */
  private async mergeTask(run: IsolationRun, repo: IsolationRepo, record: IsolationTaskRecord): Promise<IsolationOutcome> {
    let dir: string;
    try {
      dir = await this.ensureIntegrationWorktree(run, repo);
    } catch {
      return 'failed';
    }
    const merge = await this.tryGit(dir, ['merge', '--no-ff', '--no-edit', '-m', `Merge task ${record.order}: ${firstLine(record.title)}`, record.branch]);
    if (merge.ok) return 'merged';
    // A hook that refuses the merge commit leaves a merge in progress with nothing unmerged: a failure, not a conflict.
    const conflicted = (await this.unmergedPaths(dir)).length > 0;
    if (await this.mergeInProgress(dir)) await this.abortMerge(dir);
    return conflicted ? 'conflict' : 'failed';
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

  private async commitWorktree(repo: IsolationRepo, record: IsolationTaskRecord, entry: IsolationTaskRepo): Promise<void> {
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
    await this.git(entry.worktree, ['commit', '-q', '-m', `ordewell: task ${record.order} ${firstLine(record.title)}`]);
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

  private async removeTask(run: IsolationRun, record: IsolationTaskRecord, opts: { dropRecord: boolean }): Promise<void> {
    for (const repo of run.repos) {
      const entry = record.repos[repo.path];
      if (entry) await this.removeWorktreeDir(run, repo, entry.worktree, entry.linked);
      await this.tryGit(repo.root, ['branch', '-D', record.branch]);
    }
    this.removeTaskWorkspace(run, record.workspace);
    if (opts.dropRecord) delete run.tasks[record.taskId];
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

  /** Task workspaces and branches under this run that no record accounts for. */
  private async removeUnowned(run: IsolationRun): Promise<void> {
    const owned = new Set(Object.values(run.tasks).map((r) => path.resolve(r.workspace)));
    const root = this.runRoot(run);
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        const dir = path.join(root, entry);
        if (entry === INTEGRATION_DIR || owned.has(path.resolve(dir))) continue;
        for (const repo of run.repos) await this.removeWorktreeDir(run, repo, path.join(dir, repo.path), []);
        this.removeTaskWorkspace(run, dir);
      }
    }
    const taskBranches = Object.values(run.tasks).map((r) => r.branch);
    for (const repo of run.repos) {
      const ownedBranches = new Set([repo.integrationBranch, ...taskBranches]);
      const listed = await this.tryGit(repo.root, ['branch', '--list', `ordewell/${run.id}/*`, '--format=%(refname:short)']);
      for (const branch of listed.stdout.split('\n').map((b) => b.trim()).filter(Boolean)) {
        if (!ownedBranches.has(branch)) await this.tryGit(repo.root, ['branch', '-D', branch]);
      }
    }
  }

  private async removeWorktreeDir(run: IsolationRun, repo: IsolationRepo, dir: string, linked: string[]): Promise<void> {
    // Links first, so no removal path can ever walk through one into the main
    // worktree's node_modules.
    for (const name of linked) this.unlinkIfLink(path.join(dir, name));
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

  /**
   * Make one repo's worktree runnable: the default artifacts, unless a setup
   * command replaces them, then the `worktreeLinks` matches, then the setup
   * command, which can rely on those. Returns what it linked and, of that,
   * what had to be copied.
   */
  private async bootstrap(repo: IsolationRepo, cwd: string): Promise<{ linked: string[]; copied: string[] }> {
    const setup = this.deps.config.worktreeSetupCommand?.trim();
    const linked: string[] = [];
    const copied: string[] = [];
    const link = (name: string): void => {
      const target = path.join(cwd, name);
      // Present already means it is tracked: the checkout is the truth, not a link to the main tree's copy.
      if (lexists(target)) return;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (linkPath(path.join(repo.root, name), target, this.platform) === 'copy') copied.push(name);
      linked.push(name);
    };

    if (!setup) {
      for (const name of fs.readdirSync(repo.root)) {
        if (name !== STATE_DIR && (LINKED_ARTIFACTS.has(name) || isEnvFile(name))) link(name);
      }
    }
    for (const name of matchLinks(repo.root, this.deps.config.worktreeLinks)) link(name);
    if (setup) await this.runSetup(setup, repo, cwd);
    return { linked, copied };
  }

  private async runSetup(command: string, repo: IsolationRepo, cwd: string): Promise<void> {
    const env = withPath(this.cleanEnv(), await this.resolvePath(), {
      ORDEWELL_REPO: repo.path,
      ORDEWELL_MAIN_REPO: repo.root,
      ORDEWELL_MAIN_WORKTREE: repo.root,
    });
    try {
      await execAsync(command, { cwd, env, timeout: SETUP_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Worktree setup command failed: ${detail}`);
    }
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

  private admin<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.adminChains.get(repoKey) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    this.adminChains.set(repoKey, next.catch(() => undefined));
    return next;
  }

  private cleanEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    for (const key of INHERITED_GIT_VARS) delete env[key];
    return env;
  }

  private async tryGit(cwd: string | undefined, args: string[]): Promise<GitResult> {
    try {
      const env = withPath(this.cleanEnv(), await this.resolvePath());
      const { stdout, stderr } = await this.execFileImpl('git', args, { cwd, env });
      return { ok: true, stdout, stderr };
    } catch (err) {
      const e = err as { stdout?: unknown; stderr?: unknown; code?: string | number };
      return { ok: false, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? ''), code: e.code };
    }
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await this.tryGit(cwd, args);
    if (!result.ok) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || String(result.code ?? 'unknown error')}`);
    return result.stdout;
  }
}

export function createWorktreeIsolation(deps: WorktreeIsolationDeps): IWorktreeIsolation {
  return new GitWorktreeIsolation(deps);
}
