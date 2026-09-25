import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { IConfig } from '../interfaces/IConfig';
import type {
  IsolationAvailability,
  IsolationHandoff,
  IsolationMergeResult,
  IsolationOutcome,
  IsolationRepo,
  IsolationRun,
  IsolationTaskRecord,
  IsolationTaskRepo,
  IWorktreeIsolation,
} from '../interfaces/IWorktreeIsolation';
import type { Task } from '../models/Task';
import { augmentedPath, withPath } from '../utils/shellPath';
import { ensureStateDirIgnored, STATE_DIR } from '../utils/fsHelpers';
import { sanitizeSlug } from '../utils/prdStore';
import { handoffOf, integrationBranchFor, repoRootOf, SELF_REPO } from './isolationRecord';

export type GitExecFn = (
  file: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface WorktreeIsolationDeps {
  config: Pick<IConfig, 'worktreeIsolation' | 'worktreeSetupCommand'>;
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

interface QueuedMerge {
  task: Task;
  run: IsolationRun;
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

    // cwd may not exist; any failure here is "not a repository" as far as the caller can act on it.
    const toplevel = await this.tryGit(workspaceRoot, ['rev-parse', '--show-toplevel']);
    if (!toplevel.ok) {
      const repos = this.reposDirectlyIn(workspaceRoot);
      return repos.length > 0 ? { active: false, reason: 'not-git', repos } : { active: false, reason: 'not-git' };
    }
    const nested = await this.nestedRepos(workspaceRoot, toplevel.stdout.trim());
    if (nested.length > 0) return { active: false, reason: 'nested-repos', repos: nested };
    if (!(await this.tryGit(workspaceRoot, ['rev-parse', '--verify', '-q', 'HEAD'])).ok) return { active: false, reason: 'no-commits' };

    // Untracked and ignored files never block: the bootstrap step accounts for them.
    const status = await this.tryGit(workspaceRoot, ['status', '--porcelain', '--untracked-files=no']);
    if (!status.ok) return { active: false, reason: 'not-git' };
    if (status.stdout.trim() !== '') return { active: false, reason: 'dirty' };
    return { active: true };
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
    await this.git(workspaceRoot, ['stash', 'push', '-m', 'ordewell: stashed before an isolated run']);
  }

  async startRun(workspaceRoot: string): Promise<IsolationRun> {
    const id = this.mintRunId();
    return { id, workspaceRoot, repos: [await this.startRepo(workspaceRoot, SELF_REPO, id)], shared: [], tasks: {} };
  }

  private async startRepo(workspaceRoot: string, repoPath: string, runId: string): Promise<IsolationRepo> {
    const root = repoRootOf(workspaceRoot, repoPath);
    const baseRef = (await this.git(root, ['rev-parse', 'HEAD'])).trim();
    const branch = (await this.tryGit(root, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
    const repo: IsolationRepo = {
      path: repoPath,
      root,
      baseRef,
      ...(branch ? { baseBranch: branch } : {}),
      integrationBranch: integrationBranchFor(runId),
    };
    await this.git(root, ['branch', repo.integrationBranch, baseRef]);
    return repo;
  }

  prepare(task: Task, run: IsolationRun): Promise<{ cwd: string; branch: string }> {
    return this.admin(run.workspaceRoot, async () => {
      const previous = run.tasks[task.id];
      if (previous) await this.removeTask(run, previous, { dropRecord: true });

      const { branch, dir } = this.namesFor(run, task);
      ensureStateDirIgnored(run.workspaceRoot);
      const record: IsolationTaskRecord = { taskId: task.id, order: task.order, title: task.title, branch, workspace: dir, status: 'active', repos: {} };
      let cwd = dir;
      for (const repo of run.repos) {
        const worktree = path.join(dir, repo.path);
        const tip = (await this.git(repo.root, ['rev-parse', repo.integrationBranch])).trim();
        fs.mkdirSync(path.dirname(worktree), { recursive: true });
        // -B: the name is inside this run's namespace, so a leftover from a crashed attempt is ours to reset.
        await this.git(repo.root, ['worktree', 'add', '-q', '-B', branch, worktree, tip]);
        record.repos[repo.path] = { worktree, linked: [] };
      }

      try {
        for (const repo of run.repos) {
          const entry = record.repos[repo.path];
          const inRepo = await this.inWorkspacePlace(repo, entry.worktree);
          if (repo.path === SELF_REPO) cwd = inRepo;
          entry.linked = await this.bootstrap(repo.root, inRepo);
        }
      } catch (err) {
        record.status = 'failed';
        await this.removeTask(run, record, { dropRecord: false });
        throw err;
      }
      run.tasks[task.id] = record;
      return { cwd, branch };
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

  integrate(task: Task, run: IsolationRun): Promise<IsolationOutcome> {
    return new Promise((settle) => {
      this.waiting.push({ task, run, settle });
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
      return handoffOf(run);
    });
  }

  pruneOrphans(run: IsolationRun): Promise<void> {
    return this.admin(run.workspaceRoot, async () => {
      // A half-finished merge from a crash is easier to drop than to repair;
      // the branch ref is the only state that matters and it is intact.
      await this.removeIntegrationWorktrees(run);
      for (const record of Object.values(run.tasks)) {
        if (record.status === 'active') await this.removeTask(run, record, { dropRecord: true });
        else if (record.status === 'merged') await this.removeTask(run, record, { dropRecord: false });
      }
      await this.removeUnowned(run);
      for (const repo of run.repos) await this.tryGit(repo.root, ['worktree', 'prune']);
    });
  }

  async reviewDiff(run: IsolationRun): Promise<string> {
    let diff = '';
    for (const repo of run.repos) diff += await this.git(repo.root, ['diff', repo.baseRef, repo.integrationBranch]);
    return diff;
  }

  async mergeIntoCheckedOut(run: IsolationRun): Promise<IsolationMergeResult> {
    for (const repo of run.repos) {
      const result = await this.mergeRepoIntoCheckedOut(repo);
      if (result.outcome !== 'merged') return result;
    }
    return { outcome: 'merged' };
  }

  private async mergeRepoIntoCheckedOut(repo: IsolationRepo): Promise<IsolationMergeResult> {
    // The user keeps working in this tree during a run. An unfinished merge
    // there is theirs: git refuses ours, and the conflict path below would
    // otherwise abort their resolution as if it were ours.
    if (await this.mergeInProgress(repo.root)) return { outcome: 'failed', repo: repo.path };
    const merge = await this.tryGit(repo.root, ['merge', '--no-edit', repo.integrationBranch]);
    if (merge.ok) return { outcome: 'merged' };
    if (await this.mergeInProgress(repo.root)) {
      const files = (await this.tryGit(repo.root, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').map((f) => f.trim()).filter(Boolean);
      // Not `abortMerge`: its `reset --hard` fallback is for Ordewell's own
      // integration worktree, and here it would discard uncommitted work.
      await this.tryGit(repo.root, ['merge', '--abort']);
      return { outcome: 'conflict', repo: repo.path, files };
    }
    return { outcome: 'failed', repo: repo.path };
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
        entry.settle(await this.mergeOne(entry.task, entry.run).catch((): IsolationOutcome => 'failed'));
      }
    } finally {
      this.draining = false;
    }
  }

  private async mergeOne(task: Task, run: IsolationRun): Promise<IsolationOutcome> {
    const record = run.tasks[task.id];
    if (!record) return 'failed';
    if (record.status === 'merged') return 'merged';

    try {
      for (const repo of run.repos) {
        const entry = record.repos[repo.path];
        if (!entry) continue;
        await this.commitWorktree(repo, record, entry);
        if (await this.brings(repo, record.branch)) entry.changed = true;
        else entry.changed ??= false;
        const integrationDir = await this.ensureIntegrationWorktree(run, repo);
        const merge = await this.tryGit(integrationDir, [
          'merge', '--no-ff', '--no-edit', '-m', `Merge task ${record.order}: ${firstLine(record.title)}`, record.branch,
        ]);
        if (!merge.ok) {
          const conflicted = await this.mergeInProgress(integrationDir);
          if (conflicted) {
            await this.abortMerge(integrationDir);
            record.conflictRepo = repo.path;
          }
          record.status = conflicted ? 'conflict' : 'failed';
          return record.status;
        }
      }
    } catch {
      record.status = 'failed';
      return 'failed';
    }

    record.status = 'merged';
    delete record.conflictRepo;
    // The work is on the integration branch already; a stuck cleanup must not
    // turn that into a failure. `pruneOrphans` sweeps up whatever it leaves.
    await this.admin(run.workspaceRoot, () => this.removeTask(run, record, { dropRecord: false })).catch(() => undefined);
    return 'merged';
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
    if (opts.dropRecord) delete run.tasks[record.taskId];
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

  private async bootstrap(mainRoot: string, cwd: string): Promise<string[]> {
    const setup = this.deps.config.worktreeSetupCommand?.trim();
    if (setup) {
      await this.runSetup(setup, mainRoot, cwd);
      return [];
    }

    const linked: string[] = [];
    for (const name of fs.readdirSync(mainRoot)) {
      if (name === STATE_DIR || !(LINKED_ARTIFACTS.has(name) || isEnvFile(name))) continue;
      const target = path.join(cwd, name);
      // Present already means it is tracked: the checkout is the truth, not a link to the main tree's copy.
      if (this.lexists(target)) continue;
      const source = path.join(mainRoot, name);
      if (fs.statSync(source).isDirectory()) {
        // A junction needs no privilege; a directory symlink on Windows does.
        fs.symlinkSync(source, target, this.platform === 'win32' ? 'junction' : 'dir');
      } else if (this.platform === 'win32') {
        fs.copyFileSync(source, target);
      } else {
        fs.symlinkSync(source, target, 'file');
      }
      linked.push(name);
    }
    return linked;
  }

  private async runSetup(command: string, mainRoot: string, cwd: string): Promise<void> {
    const env = withPath(this.cleanEnv(), await this.resolvePath(), { ORDEWELL_MAIN_WORKTREE: mainRoot });
    try {
      await execAsync(command, { cwd, env, timeout: SETUP_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Worktree setup command failed: ${detail}`);
    }
  }

  private lexists(target: string): boolean {
    try { fs.lstatSync(target); return true; } catch { return false; }
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
