import type { LegacyPlanState, PlanStatus, RunnerId } from './Task';

export interface SessionMeta {
  id: string;
  goal: string;
  runners: RunnerId[];
  taskCount: number;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SessionData {
  meta: SessionMeta;
  /** The full plan state — including conversationHistory, prdMarkdown, and queuedMessages. */
  plan: LegacyPlanState;
}

/**
 * A plan's status as its session is listed. A plan the user ran keeps
 * 'approved' through its run and after it ends or merges, so one whose every
 * task is done or skipped is listed 'completed': the lists say it settled,
 * not that it started.
 */
export function listedPlanStatus(plan: Pick<LegacyPlanState, 'status' | 'tasks'>): PlanStatus {
  const settled = plan.tasks.length > 0 && plan.tasks.every((task) => task.status === 'completed' || task.status === 'skipped');
  return plan.status === 'approved' && settled ? 'completed' : plan.status;
}
