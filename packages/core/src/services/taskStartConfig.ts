import * as path from 'path';
import { createHash } from 'crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, type BigIntStats } from 'fs';
import type { IsolationRun } from '../interfaces/IWorktreeIsolation';
import { defaultExecFile, tryGit } from './gitExec';
import { repositoryRunnerConfigPaths, RUNNER_CONFIG_ROOTS } from './repositoryRunnerConfig';
import { augmentedPath } from '../utils/shellPath';
import { realPathOf } from '../utils/realPath';

const MAX_FILES = 2000;
const MAX_DEPTH = 8;

/**
 * Content hash of every runner-configuration file under `dir`; a missing
 * directory holds none. Read synchronously: the few small files are cheaper
 * than the turns an async walk would add before the spawn.
 */
function liveConfig(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (rel: string, depth: number): void => {
    if (found.size >= MAX_FILES || depth > MAX_DEPTH) return;
    const full = path.join(dir, rel);
    try {
      // A link is read through: a group shares its root config live that way,
      // and a worktree reaches the main checkout's `.claude` and `.opencode`
      // through one. The depth bound ends a cycle.
      const info = statSync(full);
      if (info.isFile()) {
        found.set(rel, createHash('sha1').update(readFileSync(full)).digest('hex'));
      } else if (info.isDirectory() && path.basename(rel) !== 'node_modules') {
        for (const name of readdirSync(full)) visit(path.posix.join(rel, name), depth + 1);
      }
    } catch { /* gone or unreadable: nothing for the runner to read either */ }
  };
  for (const root of RUNNER_CONFIG_ROOTS) visit(root, 0);
  const selected = new Set(repositoryRunnerConfigPaths([...found.keys()]));
  return new Map([...found].filter(([name]) => selected.has(name)));
}

/**
 * The configuration roots `dir` holds as links to the checkout at `checkout`,
 * which is how a worktree reads the `.claude` and `.opencode` directories it
 * did not check out itself, and a group task a root file shared live.
 */
function linkedRoots(dir: string, checkout: string): Set<string> {
  const linked = new Set<string>();
  for (const root of RUNNER_CONFIG_ROOTS) {
    try {
      const here = lstatSync(path.join(dir, root), { bigint: true });
      if (here.isSymbolicLink() || (here.isFile() && here.nlink > 1n && sameFile(here, statSync(path.join(checkout, root), { bigint: true })))) linked.add(root);
    } catch { /* absent: nothing is linked */ }
  }
  return linked;
}

/**
 * A hard link is how Windows links a file without privilege (ADR-0010): no
 * symlink, but the checkout's file itself. Big, as an NTFS file id is past
 * what a Number holds exactly.
 */
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Whether `link` is a link to `target` itself: not to wherever else a task pointed one. */
function linksTo(link: string, target: string): boolean {
  try {
    return lstatSync(link).isSymbolicLink() && realPathOf(link) === realPathOf(target);
  } catch {
    return false;
  }
}

/**
 * The directories the runner reads from when a task starts in `root`, each
 * with the prefix that names it from there: `root` and every level up to the
 * repository's top, because Claude reads the top's `.claude/settings.local.json`
 * and OpenCode and Codex read every level on the way.
 */
function readDirs(root: string): Array<{ dir: string; prefix: string }> {
  const dirs = [{ dir: root, prefix: '' }];
  // Found by walking up, as git does, because a subprocess here would put a
  // wait before the spawn of every task of a plan that never isolates.
  for (let dir = root, prefix = ''; !existsSync(path.join(dir, '.git')); ) {
    const parent = path.dirname(dir);
    if (parent === dir) return [dirs[0]];
    dir = parent;
    prefix += '../';
    dirs.push({ dir, prefix });
  }
  return dirs;
}

/**
 * Configuration that reaches a task's launch without the user having consented
 * to it (ADR-0028): what differs, in the directories the runner reads, from
 * where the run started.
 *
 * Git trees are compared with the base commit the run recorded, which survives
 * a restart. A directory outside a worktree — the checkout an ops or shared
 * task runs in, a group's loose entries shared live — has no commit to
 * compare with, and its files existed before the run as often as not, so it
 * is compared with its own contents when the run first launched a task of any
 * kind: before a landing can reach it. A worktree is compared that way too
 * for the `.claude` and `.opencode` directories it holds as links into the
 * main checkout, which git sees as one symlink: what a task wrote through one
 * is a difference in the checkout, never a first state of the worktree's own.
 */
export class TaskStartConfig {
  private readonly live = new Map<string, Map<string, string>>();

  /**
   * `epoch` names the run the check belongs to; a new run takes a new
   * baseline. `root` is the workspace root, the checkout a worktree run lands
   * in; `cwd` is where the runner starts, and `worktree` whether that is a
   * worktree prepared for it.
   */
  async check(run: IsolationRun | null, taskId: string, where: { epoch: number; root: string; cwd: string | null; worktree: boolean }): Promise<string[]> {
    const found = where.worktree ? await this.gitDifferences(run, taskId) : [];
    const id = String(where.epoch);
    const checkout = readDirs(where.root).flatMap(({ dir, prefix }) =>
      this.liveDifferences(`${id}:checkout:${dir}`, dir).map((name) => `${prefix}${name}`));
    if (!where.worktree) found.push(...checkout);
    else {
      // The runner's own directory, where the checkout's links land; the
      // worktree root only stands in for a repair, which starts before its
      // directory is resolved.
      const cwd = where.cwd ?? run?.tasks[taskId]?.workspace;
      if (cwd) found.push(...this.worktreeDifferences(id, cwd, where.root));
    }
    return [...new Set(found)].sort();
  }

  /** The baselines go with the plan they belong to. */
  clear(): void {
    this.live.clear();
  }

  /**
   * What a worktree's runner reads that differs from where the run started.
   * The `.claude` and `.opencode` directories it links from the checkout are
   * the checkout's own, so they are compared with the checkout's first state,
   * which an earlier task's write there does not move. Anything else is the
   * worktree's, and is compared with its own first state: a setup command's
   * files are trusted, and a task's later write is not.
   */
  private worktreeDifferences(id: string, dir: string, root: string): string[] {
    const now = liveConfig(dir);
    const linked = linkedRoots(dir, root);
    const fromCheckout = (name: string) => linked.has(name.split('/')[0]);
    const key = `${id}:worktree:${dir}`;
    let local = this.live.get(key);
    if (!local) {
      local = new Map([...now].filter(([name]) => !fromCheckout(name)));
      this.live.set(key, local);
    }
    const checkout = this.live.get(`${id}:checkout:${root}`);
    return [...now]
      .filter(([name, hash]) => (fromCheckout(name) ? checkout?.get(name) !== hash : local.get(name) !== hash))
      .map(([name]) => name);
  }

  private liveDifferences(key: string, dir: string): string[] {
    const now = liveConfig(dir);
    const before = this.live.get(key);
    if (!before) {
      this.live.set(key, now);
      return [];
    }
    return [...now].filter(([name, hash]) => before.get(name) !== hash).map(([name]) => name);
  }

  private async gitDifferences(run: IsolationRun | null, taskId: string): Promise<string[]> {
    if (!run) return [];
    const invoker = { exec: defaultExecFile, resolvePath: augmentedPath };
    const found: string[] = [];
    for (const repo of run.repos) {
      const cwd = run.tasks[taskId]?.repos[repo.path]?.worktree;
      if (!cwd || !repo.baseRef || !existsSync(cwd)) continue;
      // A workspace below its repository's top starts the runner there, and Claude reads that directory's own config.
      const prefix = repo.path === '.' ? (await tryGit(invoker, repo.root, ['rev-parse', '--show-prefix'])).stdout.trim() : '';
      const roots = [...RUNNER_CONFIG_ROOTS, ...(prefix ? RUNNER_CONFIG_ROOTS.map((r) => `${prefix}${r}`) : [])];
      // A root the worktree links from the checkout's same root holds the
      // checkout's own files, which worktreeDifferences compares. Git elsewhere
      // lists such a link as one entry, but Git for Windows walks into a
      // junction and lists its files. A link to anywhere else is what a task
      // left, and what it leads to is the worktree's to answer for.
      const top = path.resolve(repo.root, ...prefix.split('/').filter(Boolean).map(() => '..'));
      const linked = roots.filter((root) => linksTo(path.join(cwd, root), path.join(top, root))).map((root) => `${root}/`);
      const diff = await tryGit(invoker, cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '--diff-filter=ACMRTU', '-z', repo.baseRef, '--']);
      const untracked = await tryGit(invoker, cwd, ['ls-files', '--others', '-z', '--', ...roots]);
      // Old restored runs and test doubles may have no reachable base or diff;
      // without evidence of a difference there is no reason to hold the start.
      if (!diff.ok || !untracked.ok) continue;
      for (const name of [...diff.stdout.split('\0'), ...untracked.stdout.split('\0')]) {
        if (linked.some((root) => name.startsWith(root))) continue;
        const here = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : undefined;
        if (repositoryRunnerConfigPaths([name]).length || (here !== undefined && repositoryRunnerConfigPaths([here]).length)) {
          found.push(repo.path === '.' ? name : path.posix.join(repo.path, name));
        }
      }
    }
    return found;
  }
}
