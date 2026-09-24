import type { ConversationMessage, LegacyPlanState, ResearchLogEntry, Task, TaskStatus } from '../models/Task';

/** The dialogue record a fork carries — what {@link PlannerConversation.clone} returns. */
export interface ForkedDialogue {
  conversationHistory: ConversationMessage[];
  researchLog: ResearchLogEntry[];
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
export function forkPlanState(plan: LegacyPlanState, tasks: Task[], dialogue: ForkedDialogue, now: string): LegacyPlanState {
  return {
    tasks: tasks.map(forkTask),
    // The fork is a new session: it lists as the newest, not beside the original.
    generatedAt: now,
    lastUpdated: now,
    status: plan.status,
    runners: [...plan.runners],
    conversationHistory: dialogue.conversationHistory,
    researchLog: dialogue.researchLog,
    ...(plan.prdMarkdown !== undefined ? { prdMarkdown: plan.prdMarkdown } : {}),
  };
}
