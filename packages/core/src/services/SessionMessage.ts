import type { LegacyPlanState, QueuedMessage, ResearchStep, RunnerId, Task, Verdict } from '../models/Task';
import type { ApprovalKind } from '../interfaces/IApproval';
import type { ApprovalSource } from './ApprovalPolicy';

export type SerializedTaskStatus = {
  id: string;
  status: string;
  verdict: { outcome: 'pass' | 'fail'; reason: string; checks: Verdict['checks'] } | null;
};

export type SerializedTask = {
  id: string;
  order: number;
  title: string;
  type: string;
  description: string;
  dependencies: string[];
  assignedRunner: RunnerId;
  assignedModel: Task['assignedModel'] | null;
  taskMode: string;
  prompt: string | null;
  subtasks: SerializedTask[];
  userSteps: Task['userSteps'];
  thinkingEffort: Task['thinkingEffort'];
  autonomy: Task['autonomy'];
  sliceType: Task['sliceType'];
  userStoriesCovered: Task['userStoriesCovered'];
};

export type SerializedPlan = {
  tasks: SerializedTask[];
  runners: RunnerId[];
  generatedAt: string;
  conversationHistory?: LegacyPlanState['conversationHistory'];
  prdMarkdown?: string;
  queuedMessages?: QueuedMessage[];
};

export type SessionMessage =
  | { type: 'plan_generated'; plan: SerializedPlan; goal: string; runners: RunnerId[] }
  | { type: 'planner_message'; content: string; timestamp: string }
  | { type: 'status_update'; tasks: SerializedTaskStatus[] }
  | { type: 'review_needed'; tasks: SerializedTask[] }
  | { type: 'review_approved' }
  | { type: 'checkpoint'; taskId: string; taskTitle: string; summary: string }
  | { type: 'execution_complete'; summary: { total: number; completed: number; failed: number } }
  | { type: 'execution_stopped' }
  | { type: 'queue_ready' }
  | { type: 'task_updated'; taskId: string; changes: Record<string, unknown> }
  | { type: 'task_started'; taskId: string; order: number; title: string; runner: RunnerId; modelId?: string }
  | { type: 'task_output'; taskId: string; text: string }
  | { type: 'plan_thinking'; text: string }
  // `toolLabel` carries a harness planner's own name for the tool (ADR-0009) —
  // always set when `tool` is `agent_tool`, so no surface has to render the
  // catch-all member name at the user.
  | { type: 'research_step'; tool: string; toolLabel?: string; args: string; subagentId?: string; toolCallId?: string }
  | { type: 'plan_token'; token: string }
  | { type: 'research_step_done'; step: ResearchStep; subagentId?: string }
  // Planner research wants something outside its default envelope and is
  // blocked until a human answers. Broadcast rather than returned, because the
  // human may be on any surface (or several at once) and the request outlives
  // whichever HTTP call triggered it.
  | { type: 'approval_request'; id: string; kind: ApprovalKind; subject: string; scope: string; detail?: string }
  | { type: 'approval_settled'; id: string; granted: boolean }
  // A decision reached with no round-trip prompt: pre-approved via config,
  // remembered from earlier in this session, or the operator's mode floor
  // (allow/deny skipping the human entirely). The interactive path above
  // already has full visibility via approval_request/approval_settled; this
  // is the one that previously had none — a model silently auto-running
  // `npm test` because the scope was already granted looked identical, from
  // every UI, to it never having been asked in the first place.
  | {
      type: 'approval_decided';
      kind: ApprovalKind;
      subject: string;
      scope: string;
      detail?: string;
      granted: boolean;
      source: Exclude<ApprovalSource, 'asked'>;
    };

export type SessionBroadcaster = (msg: SessionMessage) => void;

export function serializeTask(t: Task): SerializedTask {
  return {
    id: t.id,
    order: t.order,
    title: t.title,
    type: t.type,
    description: t.description,
    dependencies: t.dependencies || [],
    assignedRunner: t.assignedRunner,
    assignedModel: t.assignedModel || null,
    taskMode: t.taskMode || 'build',
    prompt: t.prompt || null,
    subtasks: (t.subtasks || []).map(serializeTask),
    userSteps: t.userSteps || undefined,
    thinkingEffort: t.thinkingEffort || undefined,
    autonomy: t.autonomy || undefined,
    sliceType: t.sliceType || undefined,
    userStoriesCovered: t.userStoriesCovered || undefined,
  };
}

export function serializeTaskStatus(t: Task): SerializedTaskStatus {
  return {
    id: t.id,
    status: t.status,
    verdict: t.verdict
      ? { outcome: t.verdict.outcome, reason: t.verdict.reason, checks: t.verdict.checks || [] }
      : null,
  };
}

export function serializePlan(plan: LegacyPlanState): SerializedPlan {
  return {
    tasks: plan.tasks.map(serializeTask),
    runners: plan.runners,
    generatedAt: plan.generatedAt,
    conversationHistory: plan.conversationHistory,
    prdMarkdown: plan.prdMarkdown,
    queuedMessages: plan.queuedMessages,
  };
}

export function executionSummary(tasks: Task[]): { total: number; completed: number; failed: number } {
  return {
    total: tasks.length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
  };
}
