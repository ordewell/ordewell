import * as path from 'path';
import { createHash } from 'crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, type BigIntStats } from 'fs';
import type { IsolationRunController } from './IsolationRunController';
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

const HELD_FOR = 'repository configuration ';
/** What a hold for configuration with no base commit says, as it did before a spent run could be replaced: see {@link configHoldReason}. */
const FROM_CHECKOUT = '; remove it to continue, or start a new run once your branch holds it';
/** What a subplanner can do of its own with a task held for configuration (ADR-0055 D20). */
const IN_CHILD_PLAN = 'The subplanner can make this task read-only, which loads no project configuration, and start it, or take it out of the plan and say why in its report; a person can ask it to with a message';

/**
 * Where a start's configuration check found what differs from where its run
 * started (ADR-0028): `base`, in a worktree's tree, against the base commit
 * the run recorded; `live`, against what a directory with no base commit
 * held when the run first launched a task: the checkout an ops or shared task
 * runs in, and the `.claude` and `.opencode` a worktree links from it.
 */
export interface StartConfigFound {
  base: readonly string[];
  live: readonly string[];
}

/**
 * Why a start is held for configuration that would reach its launch without
 * a person's consent (ADR-0028), and what releases it, by what tripped it.
 * Configuration in the tree, which the run's base lacks, goes with the run: a
 * run begun from the user's branch, which only a person's own start of a
 * task in a worktree begins from a run that is spent (ADR-0013), has a base
 * that holds it. Configuration found only against a first look at a
 * directory with no base commit is said as it was before: that look is the
 * run's, and the next run takes its own (ADR-0028). In a child plan the
 * subplanner starts the tasks (ADR-0055 D20), and a read-only task loads no
 * project configuration (ADR-0046), so the hold says it can make the task
 * one. Read after "is on hold: ", so it opens in lower case.
 */
export function configHoldReason({ base, live }: StartConfigFound, inChildPlan = false): string {
  const paths = [...new Set([...base, ...live])].sort();
  const held = `${HELD_FOR}${quoted(paths)} differs from where this run started`;
  if (base.length === 0) return inChildPlan ? `${held}${FROM_CHECKOUT}. ${IN_CHILD_PLAN}` : `${held}${FROM_CHECKOUT}`;
  if (inChildPlan) return `${held}. ${IN_CHILD_PLAN}`;
  return `${held}; remove it to continue, or merge everything this run landed into your branch, with Merge all or a merge of your own (a squash or a rebase does not count), stop the run and start this task yourself: your own start of a task that works in a worktree then begins a new run from your branch, whose base holds this configuration, provided nothing of this run is left: no task running, and no work that never landed, this task's own included, no kept attempt and no delegated task's child plan. Where this task holds such work of its own, a Continue keeps it, and the run with it, so it is held again there; a fresh start (Start now, Retry or Run) discards that work and is held once more, and your next start then begins the new run`;
}

const quoted = (paths: readonly string[]): string => paths.map((p) => JSON.stringify(p)).join(', ');

/**
 * What a launch says that the check found configuration for and that goes
 * ahead (ADR-0028): one in Full whose task runs in its runner's Full mode,
 * whose runner does not ask before a command there.
 */
export function unheldConfigNotice(title: string, paths: readonly string[]): string {
  return `Task "${title}" starts with ${HELD_FOR}${quoted(paths)}, which differs from where this run started. In Full a task in its runner's Full mode is not held for it, so later tasks in Full load it without a hold too when they run in such a mode.`;
}

/** What a task's end says of configuration in the checkout that differs from the run's first look at it (ADR-0028): a write a landing does not carry. */
export function checkoutConfigNotice(title: string, paths: readonly string[]): string {
  return `As task "${title}" ends, ${HELD_FOR}${quoted(paths)} in your checkout differs from where this run started; a later task that starts there, or reads it through a worktree's link, can load it.`;
}

/** What a landing says that added, changed or removed configuration (ADR-0028), in Guarded and in Full. */
export function landedConfigNotice(title: string, paths: readonly string[]): string {
  return `Task "${title}" landed a change to ${HELD_FOR}${quoted(paths)}, which a runner loads as it starts.`;
}

/** Whether a hold is {@link configHoldReason}'s. */
export function isConfigHold(reason: string | undefined): boolean {
  return reason?.startsWith(HELD_FOR) === true;
}

/** Whether a hold is {@link configHoldReason}'s in a child plan. */
export function isChildPlanConfigHold(reason: string | undefined): boolean {
  return isConfigHold(reason) && reason!.includes(IN_CHILD_PLAN);
}

/** Whether a hold is {@link configHoldReason}'s for configuration with no base commit alone, whose release is the next run's. */
export function isCheckoutConfigHold(reason: string | undefined): boolean {
  return isConfigHold(reason) && reason!.includes(FROM_CHECKOUT);
}

/** What a check reads of the run: where a task's worktrees are and the base each one started from. */
export type StartConfigRuns = Pick<IsolationRunController, 'taskRepos' | 'workspaceOf'>;

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
  /** What a notice has said, by run, by where it said it and by path. */
  private readonly told = new Set<string>();
  /** What each {@link check} found against the run's base, by the paths it answered. */
  private readonly againstBase = new WeakMap<readonly string[], readonly string[]>();

  /**
   * `epoch` names the run the check belongs to; a new run takes a new
   * baseline. `root` is the workspace root, the checkout a worktree run lands
   * in; `cwd` is where the runner starts, and `worktree` whether that is a
   * worktree prepared for it.
   */
  async check(runs: StartConfigRuns, taskId: string, where: { epoch: number; root: string; cwd: string | null; worktree: boolean }): Promise<string[]> {
    const base = where.worktree ? await this.gitDifferences(runs, taskId) : [];
    const found = [...base];
    const id = String(where.epoch);
    const checkout = readDirs(where.root).flatMap(({ dir, prefix }) =>
      this.liveDifferences(`${id}:checkout:${dir}`, dir).map((name) => `${prefix}${name}`));
    if (!where.worktree) found.push(...checkout);
    else {
      // The runner's own directory, where the checkout's links land; the
      // worktree root only stands in for a repair, which starts before its
      // directory is resolved.
      const cwd = where.cwd ?? runs.workspaceOf(taskId);
      if (cwd) found.push(...this.worktreeDifferences(id, cwd, where.root));
    }
    const paths = [...new Set(found)].sort();
    this.againstBase.set(paths, [...new Set(base)].sort());
    return paths;
  }

  /** What a {@link check} answered, by what each path was compared with ({@link StartConfigFound}). */
  found(paths: readonly string[]): StartConfigFound {
    const base = this.againstBase.get(paths) ?? [];
    return { base, live: paths.filter((name) => !base.includes(name)) };
  }

  /**
   * What the checkout's configuration holds that differs from the run's first
   * look at it, at each level {@link check} reads there: what a task wrote
   * that a landing does not carry, in the checkout or through a worktree's link to
   * it. Only where a check took that look, so this never takes one.
   */
  checkoutChanges(epoch: number, root: string): string[] {
    const id = String(epoch);
    return [...new Set(readDirs(root).flatMap(({ dir, prefix }) =>
      this.sinceBaseline(`${id}:checkout:${dir}`, dir).map((name) => `${prefix}${name}`)))].sort();
  }

  /**
   * Of `paths`, those no notice has said yet in run `epoch`, now said: a
   * launch says each once per run, and an end says only what neither a
   * launch nor an earlier end has.
   */
  untold(epoch: number, at: 'launch' | 'end', paths: readonly string[]): string[] {
    const said = (where: 'launch' | 'end', name: string) => this.told.has(`${epoch}:${where}:${name}`);
    const fresh = paths.filter((name) => !said('launch', name) && (at === 'launch' || !said('end', name)));
    for (const name of fresh) this.told.add(`${epoch}:${at}:${name}`);
    return fresh;
  }

  /** The baselines go with the plan they belong to, and what was said with them. */
  clear(): void {
    this.live.clear();
    this.told.clear();
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
    if (!this.live.has(key)) {
      this.live.set(key, liveConfig(dir));
      return [];
    }
    return this.sinceBaseline(key, dir);
  }

  /** What `dir` holds that differs from the baseline under `key`; nothing where none was taken. */
  private sinceBaseline(key: string, dir: string): string[] {
    const before = this.live.get(key);
    if (!before) return [];
    return [...liveConfig(dir)].filter(([name, hash]) => before.get(name) !== hash).map(([name]) => name);
  }

  private async gitDifferences(runs: StartConfigRuns, taskId: string): Promise<string[]> {
    const invoker = { exec: defaultExecFile, resolvePath: augmentedPath };
    const found: string[] = [];
    for (const repo of runs.taskRepos(taskId)) {
      const cwd = repo.worktree;
      if (!cwd || !repo.baseRef || !existsSync(cwd)) continue;
      // A workspace below its repository's top starts the runner there, and Claude reads that directory's own config.
      const prefix = repo.path === '.' ? (await tryGit(invoker, repo.root, ['rev-parse', '--show-prefix'])).stdout.trim() : '';
      const roots = [...RUNNER_CONFIG_ROOTS, ...(prefix ? RUNNER_CONFIG_ROOTS.map((r) => `${prefix}${r}`) : [])];
      // A root of the runner's own directory that the worktree links from the
      // checkout's same root holds the checkout's own files, which
      // worktreeDifferences compares. Git elsewhere lists such a link as one
      // entry, but Git for Windows walks into a junction and lists its files.
      // A link anywhere else, or to anywhere else, is what a task left: nothing
      // else compares what it leads to, so git's listing still answers for it.
      const top = path.resolve(repo.root, ...prefix.split('/').filter(Boolean).map(() => '..'));
      const runnerRoots = prefix ? roots.filter((root) => root.startsWith(prefix)) : roots;
      const linked = runnerRoots.filter((root) => linksTo(path.join(cwd, root), path.join(top, root))).map((root) => `${root}/`);
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
