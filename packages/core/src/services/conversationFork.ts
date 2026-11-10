import { flattenTasks, type ConversationMessage, type DecisionRecordEntry, type LegacyPlanState, type ResearchLogEntry, type Task, type TaskStatus } from '../models/Task';

/** The dialogue record a fork carries — what {@link PlannerConversation.clone} returns. */
export interface ForkedDialogue {
  conversationHistory: ConversationMessage[];
  researchLog: ResearchLogEntry[];
  /** What the planner recorded in that dialogue (ADR-0067): a rewind keeps what came before its point. */
  decisionRecord?: DecisionRecordEntry[];
}

/**
 * Statuses that only mean something while a run is live. A fork has no run,
 * so a task caught mid-attempt or parked on a checkpoint starts over as
 * pending; finished tasks keep their outcome.
 */
const RUN_BOUND_STATUSES: ReadonlySet<TaskStatus> = new Set(['in_progress', 'awaiting_user']);

function forkTask(task: Task): Task {
  const copy = structuredClone(task);
  copy.subtasks = task.subtasks.map(forkTask);
  if (RUN_BOUND_STATUSES.has(task.status)) {
    copy.status = 'pending';
    copy.outputSummary = undefined;
    delete copy.handoff;
    delete copy.awaitingReason;
    delete copy.resumeAt;
  }
  return copy;
}

/**
 * The one place a forked session's plan state is built from the original's.
 * Fields are listed rather than spread: a fork carries the conversation and
 * the task list as-is and nothing that belongs to a run (queued mid-run edits,
 * per-run execution records). A field added to the plan later stays behind
 * until someone decides here that it should travel.
 */
export function forkPlanState(plan: LegacyPlanState, tasks: readonly Task[], dialogue: ForkedDialogue, now: string): LegacyPlanState {
  const carried = new Set(flattenTasks(tasks).map((t) => t.id));
  return {
    tasks: tasks.map(forkTask),
    // The fork is a new session: it lists as the newest, not beside the original.
    generatedAt: now,
    lastUpdated: now,
    status: plan.status,
    runners: [...plan.runners],
    conversationHistory: dialogue.conversationHistory,
    researchLog: dialogue.researchLog,
    ...(dialogue.decisionRecord && dialogue.decisionRecord.length > 0 ? { decisionRecord: dialogue.decisionRecord } : {}),
    ...(plan.prdMarkdown !== undefined ? { prdMarkdown: plan.prdMarkdown } : {}),
    // The user's approval is of the tasks, which travel; without it a fork of an executed plan would count every task approved.
    // Only of the tasks that travel: an id left behind would approve whatever task the fork's planner later gives it (ADR-0029).
    ...(plan.approvedTasks !== undefined ? { approvedTasks: plan.approvedTasks.filter((id) => carried.has(id)) } : {}),
    // Not left to the status, which a surface may have rewritten for display.
    ...(plan.approved !== undefined ? { approved: plan.approved } : {}),
  };
}
