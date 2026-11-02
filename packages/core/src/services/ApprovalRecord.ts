import { waitsForApproval, type LegacyPlanState, type RunnerId } from '../models/Task';
import { taggedReadOnlyMode, type RunnerModeInfo } from './ModeResolver';
import type { PlanStore } from './PlanStore';

/** What the plan carries of the user's consent: the lists this module keeps, and the plan's own mark (ADR-0029). */
export type ApprovalFields = Pick<LegacyPlanState, 'approved' | 'approvedTasks' | 'researchApprovals'>;

export interface ApprovalRecordDeps {
  /** The plan whose lists these are; null while the session has none. */
  plan: () => ApprovalFields | null;
  store: Pick<PlanStore, 'get' | 'update'>;
  /** The modes a runner offers, to tell a research task's read-only profile; read only while a research task is approved. */
  runnerModes: (runner: RunnerId) => readonly RunnerModeInfo[] | undefined;
  /** Told, once the lists are updated, which tasks lost approval: the change is the plan's to announce. */
  onWithdrawn?: (taskIds: readonly string[]) => void;
}

/**
 * The deep module behind a plan's `approvedTasks` and `researchApprovals`
 * (ADR-0029, ADR-0035, ADR-0037 R4): which tasks the user approved to run, and
 * which research profiles the planner approved as they landed. It keeps the
 * rules on every change rather than on a save, so nothing about approval
 * depends on which route last touched the plan:
 *
 * - approval is of a task the plan holds, never of an id that may later come to
 *   mean another task, so a task that leaves the plan takes its approval with it;
 * - research that is no longer research, or no longer in its read-only profile,
 *   loses its unasked approval and the report channel the planner gave it.
 *
 * Wire {@link reconcile} to `PlanStore.onTree`: it hears every route a task
 * enters or leaves the plan, loads and reconciled edits included. The lists
 * live on the plan (they are saved with it), so a save only writes them.
 */
export class ApprovalRecord {
  /** {@link approvedIds}' last reading. Every change here sets a new list, so a list unchanged is a set still good. */
  private read: { list: readonly string[] | undefined; ids: ReadonlySet<string> } = { list: undefined, ids: new Set() };

  constructor(private readonly deps: ApprovalRecordDeps) {}

  /** The plan's list as a set: a scheduler's pass and a status ask of every task, and the list is as long as the plan. */
  private approvedIds(plan: ApprovalFields): ReadonlySet<string> {
    if (plan.approvedTasks !== this.read.list) this.read = { list: plan.approvedTasks, ids: new Set(plan.approvedTasks) };
    return this.read.ids;
  }

  /**
   * Whether the user approved this task to run: it was in the plan they
   * executed, or they started it, added it or let it start since, and it has
   * been in the plan ever since. The one reading of the record — the seam and
   * the scheduler both ask it.
   */
  isApproved(taskId: string): boolean {
    const plan = this.deps.plan();
    return !!plan && !!this.deps.store.get(taskId) && this.approvedIds(plan).has(taskId);
  }

  /** The user approved the plan to run (ADR-0029); kept apart from the plan's display status. */
  get planApproved(): boolean {
    return this.deps.plan()?.approved === true;
  }

  approvePlan(): void {
    const plan = this.deps.plan();
    if (plan) plan.approved = true;
  }

  /** A task the scheduler leaves for the user to approve; see {@link waitsForApproval}. */
  waitsForApproval(taskId: string): boolean {
    const plan = this.deps.plan();
    const task = this.deps.store.get(taskId);
    return !!plan && !!task && !this.approvedIds(plan).has(taskId) && waitsForApproval(task, { approved: plan.approved });
  }

  /** What the user approved to run (ADR-0029): a start of their own approves the task and its subtasks. */
  approve(taskIds: readonly string[]): void {
    const plan = this.deps.plan();
    // Only tasks in the plan now: an id approved while absent would approve whatever task later comes to carry it.
    const present = taskIds.filter((id) => this.deps.store.get(id));
    if (!plan || present.length === 0) return;
    plan.approvedTasks = [...new Set([...(plan.approvedTasks ?? []), ...present])];
  }

  /** Take tasks out of the record: what they would run now is not what was approved. */
  withdraw(taskIds: readonly string[]): void {
    const plan = this.deps.plan();
    const approved = plan?.approvedTasks;
    if (!plan || !approved) return;
    const taken = approved.filter((id) => taskIds.includes(id));
    if (taken.length === 0) return;
    plan.approvedTasks = approved.filter((id) => !taskIds.includes(id));
    this.deps.onWithdrawn?.(taken);
  }

  /** A research task the planner added is approved as it lands (ADR-0037 R4); the record remembers why. */
  approveResearch(taskId: string): void {
    const plan = this.deps.plan();
    if (!plan || !this.deps.store.get(taskId)) return;
    this.approve([taskId]);
    plan.researchApprovals = [...new Set([...(plan.researchApprovals ?? []), taskId])];
  }

  researchApproved(taskId: string): boolean {
    return this.deps.plan()?.researchApprovals?.includes(taskId) ?? false;
  }

  /**
   * The rules, applied to the tree as it stands; `present` is every task id in
   * it. Run on each change to the tree, never from a save.
   */
  reconcile(present: ReadonlySet<string>): void {
    const plan = this.deps.plan();
    if (!plan) return;
    const gone = (plan.approvedTasks ?? []).filter((id) => !present.has(id));
    if (gone.length > 0) {
      plan.approvedTasks = plan.approvedTasks!.filter((id) => present.has(id));
    }
    const unsafe = (plan.researchApprovals ?? []).filter((id) => !present.has(id) || !this.safeResearch(id));
    if (unsafe.length > 0) {
      // Both lists are settled before the task is touched: updating it rebuilds the tree and runs this again.
      plan.researchApprovals = plan.researchApprovals!.filter((id) => !unsafe.includes(id));
      const approved = plan.approvedTasks?.filter((id) => unsafe.includes(id)) ?? [];
      plan.approvedTasks = plan.approvedTasks?.filter((id) => !unsafe.includes(id));
      gone.push(...approved);
      for (const id of unsafe) {
        if (this.deps.store.get(id)?.researchOrigin) this.deps.store.update(id, { reportTo: undefined, researchOrigin: undefined });
      }
    }
    if (gone.length > 0) this.deps.onWithdrawn?.(gone);
  }

  /** Removing research or its read-only profile ends its unasked approval on every edit route (ADR-0037 R4). */
  private safeResearch(taskId: string): boolean {
    const task = this.deps.store.get(taskId);
    if (!task?.research || task.type !== 'ai') return false;
    const modes = this.deps.runnerModes(task.assignedRunner);
    return modes === undefined || task.taskMode === taggedReadOnlyMode(modes);
  }
}
