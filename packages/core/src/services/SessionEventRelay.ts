import type { OrchestratorObserver, TaskOrchestrator } from './TaskOrchestrator';
import type { PlanStore } from './PlanStore';
import type { IsolationRunController } from './IsolationRunController';
import type { PlannerUsageLedger } from './PlannerUsage';
import {
  executionSummary,
  serializePlan,
  serializeTask,
  serializeTaskStatus,
  type SessionBroadcaster,
  type SessionNotice,
} from './SessionMessage';
import { surfaceStep } from '../conversation/records';
import type { LegacyPlanState, ResearchLogEntry, ResearchProgress, ResearchStep, SubagentLogEntry } from '../models/Task';

export interface SessionEventRelayDeps {
  broadcast: SessionBroadcaster;
  /** Where isolation notices go, for a host whose notifications are not seen by the user. */
  onNotice?: (notice: SessionNotice) => void;
  store: Pick<PlanStore, 'allTasks' | 'snapshot'>;
  orchestrator: Pick<TaskOrchestrator, 'getIdleSince' | 'getQueuedTaskMessages' | 'getMergeGate' | 'mergeGateView'>;
  runs: Pick<IsolationRunController, 'taskIsolation'>;
  /** Shared with the Session, which snapshots, restores and clears it. */
  usage: PlannerUsageLedger;
  /** How many of a task's runner requests wait for an answer (ADR-0018, A1). */
  awaitingApproval?: (taskId: string) => number;
  /** What a task's waiting checkpoint asks, whole. */
  checkpointQuestion?: (taskId: string) => string | undefined;
}

/**
 * Every orchestrator event the relay announces. `onTaskSettled` is persistence
 * only and `onQueueReady` is the Session's cue to drain its queue, so both are
 * the Session's alone.
 */
export type RelayObserver = Required<Omit<OrchestratorObserver, 'onTaskSettled' | 'onQueueReady'>>;

/** One subagent's activity seen during a turn: its log entry plus the steps it ran. */
interface SubagentRun {
  entry: SubagentLogEntry;
  steps: ResearchStep[];
}

/**
 * Turns orchestrator and planner events into {@link SessionMessage}
 * broadcasts — the one place a surface's view of a Session is produced. It
 * never persists: where an event also owes a save, the Session does that
 * before handing the event on, so no surface sees state the disk lacks.
 */
export class SessionEventRelay {
  private readonly broadcast: SessionBroadcaster;
  private readonly onNotice?: (notice: SessionNotice) => void;
  private readonly store: SessionEventRelayDeps['store'];
  private readonly orchestrator: SessionEventRelayDeps['orchestrator'];
  private readonly runs: SessionEventRelayDeps['runs'];
  private readonly usage: PlannerUsageLedger;
  private readonly awaitingApproval: (taskId: string) => number;
  private readonly checkpointQuestion: (taskId: string) => string | undefined;
  /**
   * The in-flight turn's subagent activity, grouped one run per subagent so a
   * replay nests each step under its own brief/result. Folded into the plan's
   * researchLog at persist — see {@link flushSubagentRuns}.
   */
  private pendingSubagents: SubagentRun[] = [];
  private statusHeld = false;
  private statusOwed = false;

  constructor(deps: SessionEventRelayDeps) {
    this.broadcast = deps.broadcast;
    this.onNotice = deps.onNotice;
    this.store = deps.store;
    this.orchestrator = deps.orchestrator;
    this.runs = deps.runs;
    this.usage = deps.usage;
    this.awaitingApproval = deps.awaitingApproval ?? (() => 0);
    this.checkpointQuestion = deps.checkpointQuestion ?? (() => undefined);
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
      onIsolationHandoff: (handoff) => {
        this.broadcast({ type: 'isolation_handoff', ...handoff });
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
    const gate = this.orchestrator.mergeGateView();
    this.broadcast({
      type: 'status_update',
      tasks: this.store.allTasks.map((t) => serializeTaskStatus(
        t,
        this.orchestrator.getIdleSince(t.id),
        this.runs.taskIsolation(t.id),
        this.orchestrator.getQueuedTaskMessages(t.id),
        this.awaitingApproval(t.id),
        this.orchestrator.getMergeGate(t.id),
        this.checkpointQuestion(t.id),
      )),
      ...(gate ? { gate } : {}),
    });
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
          // Child steps carry their subagent on the step itself; the initiating
          // spawn step does not, so it stays a plain parent step.
          if (progress.step.subagentId) this.subagentRun(progress.step.subagentId).steps.push(progress.step);
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
        if (subagentId) {
          const run = this.subagentRun(subagentId);
          run.entry.brief = progress.brief ?? run.entry.brief;
          if (progress.model) run.entry.model = progress.model;
          this.broadcast({ type: 'subagent_started', turnId, subagentId, brief: progress.brief ?? '', model: progress.model });
        }
        return;
      case 'subagent_finished':
        if (subagentId) {
          const run = this.subagentRun(subagentId);
          run.entry.outcome = progress.outcome ?? 'failed';
          run.entry.digest = progress.digest ?? '';
          if (progress.usage) run.entry.usage = progress.usage;
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
      case 'interrupted':
        return;
    }
  }

  /** The run for `subagentId`, created on first sighting so a step arriving
   * before (or without) its started event still gets a home. */
  private subagentRun(subagentId: string): SubagentRun {
    let run = this.pendingSubagents.find((r) => r.entry.subagentId === subagentId);
    if (!run) {
      run = {
        entry: { id: `sa-${subagentId}`, type: 'subagent', subagentId, brief: '', outcome: 'failed', digest: '', timestamp: new Date().toISOString() },
        steps: [],
      };
      this.pendingSubagents.push(run);
    }
    return run;
  }

  /**
   * Fold the turn's subagent runs into the plan's researchLog as one contiguous
   * group per subagent — its entry then its steps, in the order they started —
   * so a replay nests each step under its own subagent however the live stream
   * interleaved. A harness planner already logs its child steps through the
   * turn's researchLog; they are pulled out of that position and re-grouped
   * rather than duplicated.
   */
  flushSubagentRuns(plan: LegacyPlanState): void {
    if (this.pendingSubagents.length === 0) return;
    const childStepIds = new Set(this.pendingSubagents.flatMap((r) => r.steps.map((s) => s.id)));
    const additions: ResearchLogEntry[] = [];
    for (const run of this.pendingSubagents) {
      additions.push(run.entry, ...run.steps);
    }
    plan.researchLog = [
      ...(plan.researchLog ?? []).filter((e) => !childStepIds.has(e.id)),
      ...additions,
    ];
    this.pendingSubagents = [];
  }

  /** Forget a turn's subagent runs that will never be persisted. */
  dropSubagentRuns(): void {
    this.pendingSubagents = [];
  }
}
