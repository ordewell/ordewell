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
