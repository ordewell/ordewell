import type { OrchestratorObserver, TaskOrchestrator } from './TaskOrchestrator';
import type { PlanStore } from './PlanStore';
import type { PlannerUsageLedger } from './PlannerUsage';
import {
  executionSummary,
  serializePlan,
  serializeTask,
  serializeTaskStatus,
  type SessionBroadcaster,
  type SessionMessage,
  type SessionNotice,
} from './SessionMessage';
import { surfaceStep } from '../conversation/records';
import { planUsage } from '../models/Usage';
import type { LegacyPlanState, ResearchProgress } from '../models/Task';
import type { Escalation } from './escalations';

type PlannerCompactionMessage = Extract<SessionMessage, { type: 'planner_compaction' }>;

export interface SessionEventRelayDeps {
  broadcast: SessionBroadcaster;
  /** Where isolation notices go, for a host whose notifications are not seen by the user. */
  onNotice?: (notice: SessionNotice) => void;
  store: Pick<PlanStore, 'allTasks' | 'snapshot'>;
  orchestrator: Pick<TaskOrchestrator, 'getIdleSince' | 'getCompletionReceipt' | 'getToolsAttaching' | 'getQueuedTaskMessages' | 'getMergeGate' | 'holdReason' | 'runMergeView' | 'activity' | 'taskIsolation'>;
  /** Shared with the Session, which snapshots, restores and clears it. */
  usage: PlannerUsageLedger;
  /** How many of a task's runner requests wait for an answer (ADR-0018, A1). */
  awaitingApproval?: (taskId: string) => number;
  /** What a task's waiting checkpoint asks, whole. */
  checkpointQuestion?: (taskId: string) => string | undefined;
  /** The task waits for the user's approval to start (ADR-0035). */
  waitsForApproval?: (taskId: string) => boolean;
  /** What waits on a person now (ADR-0053). */
  escalations?: () => Escalation[];
  /** The list as a status update carried it, for what must see each one with no surface attached. */
  escalationsSent?: (list: readonly Escalation[]) => void;
}

/**
 * Every orchestrator event the relay announces. `onTaskSettled` is persistence
 * only, so it is the Session's alone. Run settings and automatic merge records
 * also need persistence before announcement, so Session owns those two
 * observers. A wait on a usage limit, and a task gone idle, reach surfaces as
 * the task's status; `onUsageLimitWait` and `onTaskIdle` themselves are for
 * the supervisor to wake on. The end-of-run handoff is marked by supervision
 * and remembered for a surface joining late, so Session announces it too. A
 * model switch is a plan edit, which Session's editor announces as one.
 */
export type RelayObserver = Required<Omit<OrchestratorObserver, 'onTaskSettled' | 'onRunStarted' | 'onAutoMerge' | 'onUsageLimitWait' | 'onModelSwitched' | 'onTaskIdle' | 'onIsolationHandoff' | 'onRunClosed'>>;

/**
 * Turns orchestrator and planner events into {@link SessionMessage}
 * broadcasts — the one place a surface's view of a Session is produced. It
 * never persists, and holds nothing of a planner turn: a turn keeps what it
 * writes until it lands (`PlannerConversation`). Where an event also owes a
 * save, the Session does that before handing the event on, so no surface sees
 * state the disk lacks.
 */
export class SessionEventRelay {
  private readonly broadcast: SessionBroadcaster;
  private readonly onNotice?: (notice: SessionNotice) => void;
  private readonly store: SessionEventRelayDeps['store'];
  private readonly orchestrator: SessionEventRelayDeps['orchestrator'];
  private readonly usage: PlannerUsageLedger;
  private readonly awaitingApproval: (taskId: string) => number;
  private readonly checkpointQuestion: (taskId: string) => string | undefined;
  private readonly waitsForApproval: (taskId: string) => boolean;
  private readonly escalations: () => Escalation[];
  private readonly escalationsSent: (list: readonly Escalation[]) => void;
  private statusHeld = false;
  private statusOwed = false;
  /** The planner's requests announced and not yet settled, as they were announced: a surface joining now is owed them. */
  private readonly announced = new Map<string, Extract<SessionMessage, { type: 'approval_request' }>>();
  /** The planner compaction started and not yet ended, as it was announced: a surface joining now is owed it too. */
  private compacting: PlannerCompactionMessage | undefined;

  constructor(deps: SessionEventRelayDeps) {
    this.broadcast = deps.broadcast;
    this.onNotice = deps.onNotice;
    this.store = deps.store;
    this.orchestrator = deps.orchestrator;
    this.usage = deps.usage;
    this.awaitingApproval = deps.awaitingApproval ?? (() => 0);
    this.checkpointQuestion = deps.checkpointQuestion ?? (() => undefined);
    this.waitsForApproval = deps.waitsForApproval ?? (() => false);
    this.escalations = deps.escalations ?? (() => []);
    this.escalationsSent = deps.escalationsSent ?? (() => {});
  }

  /** `plan` is read per event: a Session with no plan (or mid-reset) announces nothing about tasks. */
  observer(plan: () => LegacyPlanState | null): RelayObserver {
    return {
      onTaskChanged: () => this.status(plan()),
      onReviewNeeded: () => this.broadcast({ type: 'review_needed', tasks: this.store.allTasks.map(serializeTask) }),
      onReviewApproved: () => this.broadcast({ type: 'review_approved' }),
      onCheckpoint: (data) => {
        this.broadcast({ type: 'checkpoint', taskId: data.taskId, taskTitle: data.taskTitle, summary: data.summary });
      },
      onTick: () => this.status(plan()),
      onUsageChanged: () => this.status(plan()),
      onIsolationChanged: () => this.status(plan()),
      onIsolationBlocked: ({ reason, repos }) => {
        const where = repos.length > 0 ? ` in ${repos.join(', ')}` : '';
        this.broadcast({
          type: 'isolation_blocked',
          reason,
          ...(repos.length > 0 ? { repos } : {}),
          message: `Tracked files have uncommitted changes${where}, so tasks cannot run in isolated worktrees. Stash them, or run this plan without isolation.`,
        });
      },
      onIsolationNotice: ({ level, message }) => {
        this.onNotice?.({ type: 'notice', level, message });
      },
      onExecutionComplete: () => this.executionComplete(plan()),
    };
  }

  status(plan: LegacyPlanState | null): void {
    if (!plan) return;
    this.statusOwed = this.statusHeld;
    if (this.statusHeld) return;
    // Hosts that render from the plan object (VS Code) read statuses off it
    // when a status_update arrives, so it has to be current by then.
    plan.tasks = this.store.snapshot();
    const message = this.statusMessage();
    this.broadcast(message);
    this.escalationsSent(message.escalations ?? []);
  }

  /** Every task's status as it stands, in the message a status update carries. */
  statusMessage(): Extract<SessionMessage, { type: 'status_update' }> {
    const runMerge = this.orchestrator.runMergeView();
    return {
      type: 'status_update',
      usage: planUsage(this.store.snapshot()),
      tasks: this.store.allTasks.map((t) => serializeTaskStatus(
        t,
        this.orchestrator.getIdleSince(t.id),
        this.orchestrator.taskIsolation(t.id),
        this.orchestrator.getQueuedTaskMessages(t.id),
        this.awaitingApproval(t.id),
        this.orchestrator.getMergeGate(t.id),
        this.checkpointQuestion(t.id),
        this.waitsForApproval(t.id),
        this.orchestrator.holdReason(t.id),
        this.orchestrator.getCompletionReceipt(t.id),
        this.orchestrator.getToolsAttaching(t.id),
      )),
      ...(runMerge ? { runMerge } : {}),
      activity: this.orchestrator.activity,
      escalations: this.escalations(),
    };
  }

  /**
   * Run `op` with status broadcasts held back. Store ops signal the observer
   * as they go, which would put a status_update on the wire before the
   * persist the caller owes — surfaces must never see plan state the disk
   * does not have yet. {@link releaseStatus} sends the one held back.
   */
  holdStatus<T>(op: () => T): T {
    const outer = this.statusHeld;
    this.statusHeld = true;
    try {
      return op();
    } finally {
      this.statusHeld = outer;
    }
  }

  releaseStatus(plan: LegacyPlanState | null): void {
    if (this.statusOwed) this.status(plan);
  }

  approvalRequested(request: Extract<SessionMessage, { type: 'approval_request' }>): void {
    this.announced.set(request.id, request);
    this.broadcast(request);
  }

  approvalSettled(id: string, granted: boolean): void {
    this.announced.delete(id);
    this.broadcast({ type: 'approval_settled', id, granted });
  }

  /** The planner's approval requests still waiting, in the order they were asked. */
  announcedApprovals(): Extract<SessionMessage, { type: 'approval_request' }>[] {
    return [...this.announced.values()];
  }

  /** The planner compaction running now, as its start was announced; undefined when none is. */
  currentCompaction(): PlannerCompactionMessage | undefined {
    return this.compacting;
  }

  executionComplete(plan: LegacyPlanState | null): void {
    if (!plan) return;
    this.broadcast({ type: 'execution_complete', summary: executionSummary(this.store.allTasks) });
  }

  /** `turnId`: the planner turn whose commit this is, when one is. */
  planGenerated(plan: LegacyPlanState | null, goal: string, turnId?: string): void {
    if (!plan) return;
    plan.tasks = this.store.snapshot();
    this.broadcast({
      type: 'plan_generated',
      plan: serializePlan(plan),
      goal,
      runners: plan.runners,
      ...(turnId ? { turnId } : {}),
    });
  }

  progress(progress: ResearchProgress): void {
    const { turnId, subagentId, segmentId } = progress;
    switch (progress.type) {
      case 'liveness':
        this.broadcast({ type: 'planner_liveness' });
        return;
      case 'thinking':
        if (!progress.text) return;
        this.broadcast({ type: 'planner_thinking_delta', turnId, segmentId, subagentId, text: progress.text });
        return;
      case 'tool_call':
        if (progress.tool) this.broadcast({ type: 'research_step', tool: progress.tool, toolLabel: progress.toolLabel, args: progress.toolArgs || '', subagentId, toolCallId: progress.toolCallId, turnId });
        return;
      case 'plan_token':
        if (progress.planToken) this.broadcast({ type: 'plan_token', token: progress.planToken, turnId, segmentId });
        return;
      case 'tool_result':
        if (progress.step) {
          this.broadcast({ type: 'research_step_done', step: surfaceStep(progress.step), subagentId, turnId });
        }
        return;
      case 'text_delta':
        if (!progress.text) return;
        // Only the one-shot plan path streams prose outside a turn, and its only
        // surface (`plan --no-chat`) draws steps, not reply text.
        if (turnId && segmentId) this.broadcast({ type: 'planner_text_delta', turnId, segmentId, text: progress.text });
        return;
      case 'text_retracted':
        // Outside a turn there is no streamed text a surface could take back.
        if (turnId) this.broadcast({ type: 'planner_text_retracted', turnId, segmentId });
        return;
      case 'subagent_started':
        if (subagentId) this.broadcast({ type: 'subagent_started', turnId, subagentId, brief: progress.brief ?? '', model: progress.model });
        return;
      case 'subagent_finished':
        if (subagentId) {
          this.broadcast({
            type: 'subagent_finished', turnId, subagentId,
            outcome: progress.outcome ?? 'failed', digest: progress.digest ?? '', usage: progress.usage,
          });
        }
        return;
      case 'usage': {
        if (!progress.record) return;
        this.usage.record(progress.record);
        this.broadcast(this.usage.message(turnId));
        return;
      }
      case 'compaction': {
        const { compaction } = progress;
        if (!compaction) return;
        const message: PlannerCompactionMessage = { type: 'planner_compaction', compaction, ...(turnId ? { turnId } : {}) };
        if (compaction.phase === 'started') this.compacting = message;
        else if (this.compacting?.compaction.id === compaction.id) this.compacting = undefined;
        this.broadcast(message);
        return;
      }
      case 'interrupted':
        return;
    }
  }
}
