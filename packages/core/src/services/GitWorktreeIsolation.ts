import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { IConfig } from '../interfaces/IConfig';
import type {
  IsolationAvailability,
  IsolationHandoff,
  IsolationOutcome,
  IsolationRun,
  IsolationTaskRecord,
  IWorktreeIsolation,
} from '../interfaces/IWorktreeIsolation';
import type { Task } from '../models/Task';
import { augmentedPath, withPath } from '../utils/shellPath';
import { ensureStateDirIgnored, STATE_DIR } from '../utils/fsHelpers';
import { sanitizeSlug } from '../utils/prdStore';

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

interface GitResult { ok: boolean; stdout: string; stderr: string; code?: string | number }

interface QueuedMerge {
  task: Task;
  run: IsolationRun;
  settle: (outcome: IsolationOutcome) => void;
}

/** What a run hands over: its integration branch, its base, and what landed there, in plan order. */
export function handoffOf(run: IsolationRun): IsolationHandoff {
  const landed = Object.values(run.tasks)
    .filter((r) => r.status === 'merged')
    .sort((a, b) => a.order - b.order)
    .map((r) => ({ taskId: r.taskId, order: r.order, title: r.title }));
  return { branch: run.integrationBranch, baseRef: run.baseRef, landed };
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
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
    if (!(await this.tryGit(workspaceRoot, ['rev-parse', '--show-toplevel'])).ok) return { active: false, reason: 'not-git' };
    if (!(await this.tryGit(workspaceRoot, ['rev-parse', '--verify', '-q', 'HEAD'])).ok) return { active: false, reason: 'no-commits' };

    // Untracked and ignored files never block: the bootstrap step accounts for them.
    const status = await this.tryGit(workspaceRoot, ['status', '--porcelain', '--untracked-files=no']);
    if (!status.ok) return { active: false, reason: 'not-git' };
    if (status.stdout.trim() !== '') return { active: false, reason: 'dirty' };
    return { active: true };
  }

  async stash(workspaceRoot: string): Promise<void> {
    await this.git(workspaceRoot, ['stash', 'push', '-m', 'ordewell: stashed before an isolated run']);
  }

  async startRun(workspaceRoot: string): Promise<IsolationRun> {
    const baseRef = (await this.git(workspaceRoot, ['rev-parse', 'HEAD'])).trim();
    const branch = (await this.tryGit(workspaceRoot, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
    const id = this.mintRunId();
    const run: IsolationRun = {
      id,
      workspaceRoot,
      baseRef,
      ...(branch ? { baseBranch: branch } : {}),
      integrationBranch: `ordewell/${id}/integration`,
      tasks: {},
    };
    await this.git(workspaceRoot, ['branch', run.integrationBranch, baseRef]);
    return run;
  }

  prepare(task: Task, run: IsolationRun): Promise<{ cwd: string; branch: string }> {
    return this.admin(run.workspaceRoot, async () => {
      const previous = run.tasks[task.id];
      if (previous) await this.removeTask(run, previous, { dropRecord: true });

      const { branch, dir } = this.namesFor(run, task);
      const tip = (await this.git(run.workspaceRoot, ['rev-parse', run.integrationBranch])).trim();
      ensureStateDirIgnored(run.workspaceRoot);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      // -B: the name is inside this run's namespace, so a leftover from a crashed attempt is ours to reset.
      await this.git(run.workspaceRoot, ['worktree', 'add', '-q', '-B', branch, dir, tip]);

      const prefix = (await this.git(run.workspaceRoot, ['rev-parse', '--show-prefix'])).trim();
      const cwd = prefix ? path.join(dir, prefix) : dir;
      const record: IsolationTaskRecord = { taskId: task.id, order: task.order, title: task.title, branch, worktree: dir, status: 'active', linked: [] };
      try {
        record.linked = await this.bootstrap(run.workspaceRoot, cwd);
      } catch (err) {
        record.status = 'failed';
        await this.removeTask(run, record, { dropRecord: false });
        throw err;
      }
      run.tasks[task.id] = record;
      return { cwd, branch };
    });
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
      await this.removeIntegrationWorktree(run);
      return handoffOf(run);
    });
  }

  pruneOrphans(run: IsolationRun): Promise<void> {
    return this.admin(run.workspaceRoot, async () => {
      // A half-finished merge from a crash is easier to drop than to repair;
      // the branch ref is the only state that matters and it is intact.
      await this.removeIntegrationWorktree(run);
      for (const record of Object.values(run.tasks)) {
        if (record.status === 'active') await this.removeTask(run, record, { dropRecord: true });
        else if (record.status === 'merged') await this.removeTask(run, record, { dropRecord: false });
      }
      await this.removeUnowned(run);
      await this.tryGit(run.workspaceRoot, ['worktree', 'prune']);
    });
  }

  async reviewDiff(run: IsolationRun): Promise<string> {
    return this.git(run.workspaceRoot, ['diff', run.baseRef, run.integrationBranch]);
  }

  async mergeIntoCheckedOut(run: IsolationRun): Promise<IsolationOutcome> {
    // The user keeps working in this tree during a run. An unfinished merge
    // there is theirs: git refuses ours, and the conflict path below would
    // otherwise abort their resolution as if it were ours.
    if (await this.mergeInProgress(run.workspaceRoot)) return 'failed';
    const merge = await this.tryGit(run.workspaceRoot, ['merge', '--no-edit', run.integrationBranch]);
    if (merge.ok) return 'merged';
    if (await this.mergeInProgress(run.workspaceRoot)) {
      // Not `abortMerge`: its `reset --hard` fallback is for Ordewell's own
      // integration worktree, and here it would discard uncommitted work.
      await this.tryGit(run.workspaceRoot, ['merge', '--abort']);
      return 'conflict';
    }
    return 'failed';
  }

  discard(run: IsolationRun, opts: { keepIntegration: boolean }): Promise<void> {
    return this.admin(run.workspaceRoot, async () => {
      await this.removeIntegrationWorktree(run);
      for (const record of Object.values(run.tasks)) {
        await this.removeTask(run, record, { dropRecord: record.status !== 'merged' });
      }
      await this.removeUnowned(run);
      if (!opts.keepIntegration) {
        await this.tryGit(run.workspaceRoot, ['branch', '-D', run.integrationBranch]);
        run.tasks = {};
        this.removeIfEmpty(this.runRoot(run));
      }
      await this.tryGit(run.workspaceRoot, ['worktree', 'prune']);
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
      await this.commitWorktree(run, record);
      const integrationDir = await this.ensureIntegrationWorktree(run);
      const merge = await this.tryGit(integrationDir, [
        'merge', '--no-ff', '--no-edit', '-m', `Merge task ${record.order}: ${firstLine(record.title)}`, record.branch,
      ]);
      if (!merge.ok) {
        const conflicted = await this.mergeInProgress(integrationDir);
        if (conflicted) await this.abortMerge(integrationDir);
        record.status = conflicted ? 'conflict' : 'failed';
        return record.status;
      }
    } catch {
      record.status = 'failed';
      return 'failed';
    }

    record.status = 'merged';
    // The work is on the integration branch already; a stuck cleanup must not
    // turn that into a failure. `pruneOrphans` sweeps up whatever it leaves.
    await this.admin(run.workspaceRoot, () => this.removeTask(run, record, { dropRecord: false })).catch(() => undefined);
    return 'merged';
  }

  private async commitWorktree(run: IsolationRun, record: IsolationTaskRecord): Promise<void> {
    // Bootstrapped links are untracked, and an ignore rule like `node_modules/`
    // does not match a symlink — without this they would be committed. Staging
    // one that is a junction would even walk into the main tree's contents.
    // Only links git does not already ignore need excluding: naming an ignored
    // path such as `.env` in an exclude pathspec makes `add` refuse.
    const prefix = (await this.git(run.workspaceRoot, ['rev-parse', '--show-prefix'])).trim();
    const excludes: string[] = [];
    for (const name of record.linked) {
      if ((await this.tryGit(record.worktree, ['check-ignore', '-q', '--', prefix + name])).ok) continue;
      excludes.push(`:(exclude,literal)${(prefix + name).replace(/\\/g, '/')}`);
    }
    await this.git(record.worktree, ['add', '-A', '--', '.', ...excludes]);
    const staged = await this.tryGit(record.worktree, ['diff', '--cached', '--quiet']);
    if (staged.ok) return;
    await this.git(record.worktree, ['commit', '-q', '-m', `ordewell: task ${record.order} ${firstLine(record.title)}`]);
  }

  private async ensureIntegrationWorktree(run: IsolationRun): Promise<string> {
    return this.admin(run.workspaceRoot, async () => {
      const dir = path.join(this.runRoot(run), INTEGRATION_DIR);
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      await this.tryGit(run.workspaceRoot, ['worktree', 'prune']);
      ensureStateDirIgnored(run.workspaceRoot);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await this.git(run.workspaceRoot, ['worktree', 'add', '-q', dir, run.integrationBranch]);
      return dir;
    });
  }

  private async removeIntegrationWorktree(run: IsolationRun): Promise<void> {
    await this.removeWorktreeDir(run, path.join(this.runRoot(run), INTEGRATION_DIR), []);
  }

  private async removeTask(run: IsolationRun, record: IsolationTaskRecord, opts: { dropRecord: boolean }): Promise<void> {
    await this.removeWorktreeDir(run, record.worktree, record.linked);
    await this.tryGit(run.workspaceRoot, ['branch', '-D', record.branch]);
    if (opts.dropRecord) delete run.tasks[record.taskId];
  }

  /** Worktree directories and branches under this run that no record accounts for. */
  private async removeUnowned(run: IsolationRun): Promise<void> {
    const owned = new Set(Object.values(run.tasks).map((r) => path.resolve(r.worktree)));
    const root = this.runRoot(run);
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        const dir = path.join(root, entry);
        if (entry === INTEGRATION_DIR || owned.has(path.resolve(dir))) continue;
        await this.removeWorktreeDir(run, dir, []);
      }
    }
    const ownedBranches = new Set([run.integrationBranch, ...Object.values(run.tasks).map((r) => r.branch)]);
    const listed = await this.tryGit(run.workspaceRoot, ['branch', '--list', `ordewell/${run.id}/*`, '--format=%(refname:short)']);
    for (const branch of listed.stdout.split('\n').map((b) => b.trim()).filter(Boolean)) {
      if (!ownedBranches.has(branch)) await this.tryGit(run.workspaceRoot, ['branch', '-D', branch]);
    }
  }

  private async removeWorktreeDir(run: IsolationRun, dir: string, linked: string[]): Promise<void> {
    // Links first, so no removal path can ever walk through one into the main
    // worktree's node_modules.
    for (const name of linked) this.unlinkIfLink(path.join(dir, name));
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (LINKED_ARTIFACTS.has(name) || isEnvFile(name)) this.unlinkIfLink(path.join(dir, name));
    }
    await this.tryGit(run.workspaceRoot, ['worktree', 'remove', '--force', dir]);
    if (fs.existsSync(dir) && isInside(this.runRoot(run), dir)) fs.rmSync(dir, { recursive: true, force: true });
    await this.tryGit(run.workspaceRoot, ['worktree', 'prune']);
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
