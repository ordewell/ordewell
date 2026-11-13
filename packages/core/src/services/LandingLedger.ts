import type { IsolationRun, IsolationTaskRecord, LandedTask } from '../interfaces/IWorktreeIsolation';
import type { Task } from '../models/Task';

/*
 * The landing ledger (ADR-0054): what an isolated run keeps of who landed what
 * across every attempt, after a record has gone too. That is
 * `IsolationRun.landings`, `carried`, `landedTasks`, `landedOn`,
 * `keepsEveryLanding` and `reverted`, with each record's `landedTip` for a run
 * saved before `landings` were kept. Every read and write of those goes through
 * here and none of it asks git: GitWorktreeIsolation hands it what a merge made,
 * and FakeWorktreeIsolation hands it the same facts, so both keep one set of rules.
 */

/** What a run starts with: every merge kept from the first, and the record of what merges carried, empty until one does. */
export const freshLedger = (): Pick<IsolationRun, 'keepsEveryLanding' | 'carried'> => ({ keepsEveryLanding: true, carried: {} });

/** Every run started now holds {@link IsolationRun.carried}, empty or not, so one without it was saved by a build that kept no such record. */
export const startedOlder = (run: IsolationRun): boolean => run.carried === undefined;

/** Whether a revert was committed on the run: its branch holds commits no record names, so it carries on with no record left. */
export const hasReverted = (run: IsolationRun): boolean => run.reverted === true;

/** What a task landed as: its record while it has one, else what the ledger kept once a retry dropped it. */
export function landedTaskOf(run: IsolationRun | null | undefined, taskId: string): LandedTask | undefined {
  return run?.tasks[taskId] ?? run?.landedTasks?.[taskId];
}

/** What to call a task in a refusal: the id stands in once nothing names it. */
export const landedTitleOf = (run: IsolationRun, taskId: string): string => landedTaskOf(run, taskId)?.title ?? taskId;

/** The merges that landed a task in a repo, oldest first; a run saved before they were kept has only the record's latest. */
export function landingsOf(run: IsolationRun, taskId: string, repoPath: string): string[] {
  const latest = run.tasks[taskId]?.repos[repoPath]?.landedTip;
  return run.landings?.[taskId]?.[repoPath] ?? (latest ? [latest] : []);
}

/** Every kept merge in a repo, by the task it landed. */
export function landingsIn(run: IsolationRun, repoPath: string): Array<{ taskId: string; merge: string }> {
  return Object.entries(run.landings ?? {}).flatMap(([taskId, byRepo]) => (byRepo[repoPath] ?? []).map((merge) => ({ taskId, merge })));
}

/** Whether anything ever landed in a repo, by the ledger or a record's tip. */
export function hasLandingIn(run: IsolationRun, repoPath: string): boolean {
  if (Object.values(run.landings ?? {}).some((byRepo) => (byRepo[repoPath]?.length ?? 0) > 0)) return true;
  return Object.values(run.tasks).some((record) => record.repos[repoPath]?.landedTip !== undefined);
}

/** The repos the ledger holds a task's merges in. */
export const landedReposOf = (run: IsolationRun, taskId: string): string[] => Object.keys(run.landings?.[taskId] ?? {});

/** Whether another task's merge carried a task's work, in one repo or any. */
export function isCarried(run: IsolationRun | null | undefined, taskId: string, repoPath?: string): boolean {
  const tips = run?.carried?.[taskId];
  return repoPath === undefined ? tips !== undefined : tips?.[repoPath] !== undefined;
}

/** Every carried tip in a repo, by the task whose work it is. */
export function carriedTipsIn(run: IsolationRun, repoPath: string): Array<{ taskId: string; tip: string }> {
  return Object.entries(run.carried ?? {}).flatMap(([taskId, repos]) => (repos[repoPath] ?? []).map((tip) => ({ taskId, tip })));
}

/** Whether a task has work on the integration branch in a repo: a later attempt's record says nothing of the merges before it. */
export function landedIn(run: IsolationRun, taskId: string, repoPath: string): boolean {
  const record = run.tasks[taskId];
  return landingsOf(run, taskId, repoPath).length > 0 || isCarried(run, taskId, repoPath) || (record?.status === 'merged' && record.repos[repoPath]?.changed === true);
}

/** Whether a landed record's work is in a repo, for what its handoff and Merge all name there. */
export function mergedIn(run: IsolationRun, record: IsolationTaskRecord, repoPath: string): boolean {
  return !!record.repos[repoPath]?.changed || run.landings?.[record.taskId]?.[repoPath] !== undefined;
}

/**
 * Whether a task has work of its own on the integration branch, this attempt's
 * or an earlier one's. A retry, a failed spawn or a continue that conflicted
 * leaves a record that is not `merged`, or none, over merges still on the branch.
 */
export function landedWork(run: IsolationRun | null, taskId: string): boolean {
  const record = run?.tasks[taskId];
  return run?.landings?.[taskId] !== undefined || isCarried(run, taskId) || (record?.status === 'merged' && Object.values(record.repos).some((r) => r.changed));
}

/** Whether a task of a run that did not keep its merges from the start can have landed in an attempt no record speaks for: nothing says it did not. */
export function mayHaveLanded(run: IsolationRun | null, task: Readonly<Task>): boolean {
  const record = run?.tasks[task.id];
  return !run?.keepsEveryLanding && !landedWork(run, task.id) && task.type === 'ai' && !task.ops && !record?.readOnly && (task.attempted === true || record !== undefined);
}

/** A task that landed and left the plan with no record of what it depended on, or of what to call it: whether it stands on the work nothing can say. */
export function unreadLanding(run: IsolationRun | null, planned: ReadonlySet<string>): string | undefined {
  if (!run) return undefined;
  const landed = [...Object.keys(run.landings ?? {}), ...Object.keys(run.carried ?? {}), ...Object.keys(run.tasks)].filter((id) => !planned.has(id) && landedWork(run, id));
  const unread = landed.find((id) => !run.landedOn?.[id] || !landedTaskOf(run, id));
  return unread === undefined ? undefined : landedTitleOf(run, unread);
}

/**
 * The title of another task recorded as landed by the same merge. No landing
 * makes one for two tasks: a run saved when a landing recorded the branch's tip
 * whether or not it had moved can say so, and reverting that merge would take
 * the work of whichever task really made it (ADR-0054).
 */
export function alsoLandedBy(run: IsolationRun, repoPath: string, taskId: string, merge: string): string | undefined {
  const ids = new Set([...Object.keys(run.tasks), ...Object.keys(run.landings ?? {})]);
  const other = [...ids].find((id) => id !== taskId && landingsOf(run, id, repoPath).includes(merge));
  return other === undefined ? undefined : landedTitleOf(run, other);
}

/**
 * Landed work a revert can undo (ADR-0054): a merge of its own in every repo it
 * changed, none of it in the user's branch yet, and nothing of it carried in by
 * a resolver. A task at work again keeps its mark off, and a revert would refuse
 * it. A run with no `carried` record, or none given, offers nothing: every
 * revert of such a run is refused.
 */
export function marksRevertible(record: IsolationTaskRecord, run?: Pick<IsolationRun, 'landings' | 'carried'>): boolean {
  if (record.inHead || record.status === 'active' || record.status === 'repairing' || !run?.carried || run.carried[record.taskId]) return false;
  const landings = run.landings?.[record.taskId];
  const changed = record.status === 'merged' ? Object.entries(record.repos).filter(([, r]) => r.changed).map(([repoPath]) => repoPath) : [];
  return (changed.length > 0 || landings !== undefined) && changed.every((repo) => record.repos[repo].landedTip || landings?.[repo]);
}

/** The tasks with merges on the branch and no record left, a retry having dropped it, that a revert can still take. */
export function recordlessRevertible(run: IsolationRun): string[] {
  return Object.keys(run.landings ?? {}).filter((taskId) => run.carried && !run.carried[taskId]);
}

/** What a task depends on in the plan, a check counting on its body as it does at a merge gate (ADR-0045 L9). */
const dependenciesOf = (task: Readonly<Task>): string[] => [...task.dependencies, ...task.loop?.body ?? []];

/** What a task depends on, directly or not, for {@link keepLandedOn} to keep as it is cut and as it lands. */
export function landedOnOf(taskId: string, tasks: readonly Readonly<Task>[]): string[] {
  const found = new Set<string>();
  const queue = [taskId];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const task = tasks.find((t) => t.id === id);
    for (const dependency of task ? dependenciesOf(task) : []) {
      if (found.has(dependency)) continue;
      found.add(dependency);
      queue.push(dependency);
    }
  }
  return [...found];
}

/** Everything that depends on the task, directly or not, by the plan or by what the ledger kept: the plan lets go of a task that leaves it, and of what stood on it through that task. */
export function dependentsOf(tasks: readonly Readonly<Task>[], run: IsolationRun | null, taskId: string): Set<string> {
  const edges = new Map(tasks.map((t) => [t.id, dependenciesOf(t)]));
  for (const [id, landedOn] of Object.entries(run?.landedOn ?? {})) edges.set(id, [...edges.get(id) ?? [], ...landedOn]);
  const found = new Set<string>([taskId]);
  const queue = [taskId];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const [other, dependencies] of edges) {
      if (found.has(other) || !dependencies.includes(id)) continue;
      found.add(other);
      queue.push(other);
    }
  }
  found.delete(taskId);
  return found;
}

/** The tasks a revert of this one stands to change the ground of, landed or not: no start of one may be claimed while it runs. */
export function revertReach(taskId: string, tasks: readonly Readonly<Task>[], run: IsolationRun | null): ReadonlySet<string> {
  return new Set([taskId, ...dependentsOf(tasks, run, taskId)]);
}

const landedTask = ({ taskId, order, title, commit }: LandedTask): LandedTask => ({ taskId, order, title, ...(commit ? { commit } : {}) });

/** A task's merges, by repo, as its landing went through: each repo's tip on the record and kept in the ledger once, newest last. */
export function recordLanding(run: IsolationRun, record: IsolationTaskRecord, tips: readonly (readonly [repoPath: string, merge: string])[]): void {
  for (const [repoPath, tip] of tips) {
    const entry = record.repos[repoPath];
    if (entry) entry.landedTip = tip;
    ((run.landings ??= {})[record.taskId] ??= {})[repoPath] = [...landingsOf(run, record.taskId, repoPath).filter((merge) => merge !== tip), tip];
    (run.landedTasks ??= {})[record.taskId] = landedTask(record);
  }
}

/**
 * Tips of tasks yet to land that a landing's merges brought in. A run that
 * started without the record never gets one: it would miss what landed before
 * it, and its absence is what refuses a revert (ADR-0054).
 */
export function recordCarried(run: IsolationRun, carried: readonly { record: LandedTask; repoPath: string; tip: string }[]): void {
  if (!run.carried) return;
  for (const { record, repoPath, tip } of carried) {
    const tips = (run.carried[record.taskId] ??= {});
    tips[repoPath] = [...tips[repoPath] ?? [], tip];
    (run.landedTasks ??= {})[record.taskId] = landedTask(record);
  }
}

/** What a task depends on, added to what it ever did: a plan edit takes a link off while its worktree stays cut from the work (ADR-0054). */
export function keepLandedOn(run: IsolationRun, taskId: string, dependsOn: readonly string[]): void {
  (run.landedOn ??= {})[taskId] = [...new Set([...run.landedOn?.[taskId] ?? [], ...dependsOn])];
}

/**
 * The tasks a revert took back, all in one step with no await between: a
 * landed record goes; a later attempt's that never landed stays, `kept`, for
 * the worktree only it names, its conflict over and nothing to repair or land;
 * the ledger lets go of each; and the run is marked as reverted.
 */
export function forgetReverted(run: IsolationRun, taskIds: readonly string[]): void {
  for (const taskId of taskIds) {
    const record = run.tasks[taskId];
    if (record?.status === 'merged') delete run.tasks[taskId];
    else if (record?.status === 'conflict') {
      record.status = 'kept';
      delete record.repairBase;
      delete record.conflictRepo;
      delete record.conflictFiles;
    }
    delete run.landings?.[taskId];
    delete run.landedTasks?.[taskId];
    delete run.landedOn?.[taskId];
  }
  run.reverted = true;
}
