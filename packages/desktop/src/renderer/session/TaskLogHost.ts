import type {
  AccountLimitSnapshot, DisplayBlock, ExecutionCommand, RunTask, SessionMessage, StreamStamp, TaskLogEvent,
} from '@ordewell/core';
import {
  accountLimitsOf, assignedRunnerOf, EMPTY_TASK_LOG_FOLLOW, followTaskLog, lastServedModel, taskActionCommand,
  taskLogHeaderView, type TaskLogFollow,
} from '@ordewell/core/plan-utils';
import { diffConversation, type HostToTaskLog, type TaskLogRefund, type TaskLogStatus, type TaskLogToHost } from '@ordewell/ui/protocol';
import type { TaskLogBridge } from '@ordewell/ui';
import { callDaemon, messageOf } from './daemon';

/** What a task log asks of the session it belongs to: the task as the run view holds it now, and what only the host keeps. */
export interface TaskLogPort {
  sessionId: string;
  workspace: string;
  task(taskId: string): { task: RunTask; label: string } | undefined;
  /** Every runner's account limits; the log shows only those of the runner its task is assigned to. */
  accountLimits(): readonly AccountLimitSnapshot[];
  openFile(path: string): void;
}

const NO_LIMITS = JSON.stringify([]);

// A plan event that can change what the header says; anything else costs the log nothing.
const TASK_STATE_EVENTS: ReadonlySet<SessionMessage['type']> = new Set([
  'status_update', 'task_updated', 'task_started', 'execution_complete', 'execution_stopped',
]);

/** A reassignment of runner or model is a new binding: what the old one was seen running on no longer speaks for it. */
function assignmentKey(task: RunTask): string {
  return `${task.assignedRunner}\0${task.assignedModel?.modelId ?? ''}`;
}

/**
 * One task's log, as the extension's `TaskLogPanel` draws it (ADR-0018, V1),
 * read over the daemon instead of from an in-process Session. The saved
 * attempt is read over REST and the socket's `task_log` batches are folded
 * after it by stream position, which the daemon stamps on both, so a batch the
 * read already holds is never drawn twice. It outlives the tab that shows it,
 * so switching between Details and Chat neither rereads nor loses the follow.
 * Every control is a command at the seam as the user (ADR-0029), as the
 * chat's own are.
 */
export class TaskLogHost implements TaskLogBridge {
  private follow: TaskLogFollow = followTaskLog(EMPTY_TASK_LOG_FOLLOW, { type: 'opened' });
  private sent: readonly DisplayBlock[] = [];
  private ready = false;
  private lastStatus = '';
  private lastLimits = NO_LIMITS;
  private served: { attempt: number; model?: string; assignment?: string } = { attempt: 0 };
  private readonly listeners = new Set<(message: HostToTaskLog) => void>();
  private saved: unknown;

  constructor(private readonly taskId: string, private readonly port: TaskLogPort) {}

  subscribe(listener: (message: HostToTaskLog) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      // A tab that comes back says ready again and is sent the whole view then.
      if (this.listeners.size === 0) this.ready = false;
    };
  }

  getState(): unknown { return this.saved; }
  setState(state: unknown): void { this.saved = state; }

  /** A session broadcast, with the stamp its frame carried when the daemon numbers them. */
  receive(msg: SessionMessage & Partial<StreamStamp>): void {
    if (msg.type === 'task_log') {
      if (msg.taskId !== this.taskId) return;
      if (this.observeServed(msg.attempt, msg.events)) this.pushAccountLimits();
      const previous = this.follow.attempt;
      const position = msg.stream !== undefined && msg.seq !== undefined ? { stream: msg.stream, seq: msg.seq } : undefined;
      this.follow = followTaskLog(this.follow, { type: 'live', attempt: msg.attempt, events: msg.events, ...(position ? { position } : {}) });
      // A new attempt's batch carries only its own events from here: the file holds what came before them.
      if (this.ready && this.follow.attempt > previous) void this.load(this.follow.attempt);
      else this.push();
      return;
    }
    if (TASK_STATE_EVENTS.has(msg.type)) this.refresh();
  }

  /** The run moved outside a task_log batch (a snapshot adopted): the header and limits are read again. */
  refresh(): void {
    this.pushStatus();
    this.pushAccountLimits();
  }

  pushAccountLimits(): void {
    if (!this.ready) return;
    const task = this.port.task(this.taskId)?.task;
    const limits = accountLimitsOf(this.port.accountLimits(), task && assignedRunnerOf(task), task && this.servedModel(task));
    const key = JSON.stringify(limits);
    if (key === this.lastLimits) return;
    this.lastLimits = key;
    this.emit({ type: 'accountLimits', limits });
  }

  post(msg: TaskLogToHost): void {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        if (this.follow.attempt === 0) void this.loadLatest();
        else this.postInit();
        this.lastLimits = NO_LIMITS;
        this.pushAccountLimits();
        return;
      case 'selectAttempt':
        if (this.follow.attempts.includes(msg.attempt)) void this.load(msg.attempt);
        return;
      case 'invokeTaskCommand':
        this.control(callDaemon('plans.taskCommands', { sessionId: this.port.sessionId, taskId: this.taskId }, { name: msg.name, args: msg.args }));
        return;
      case 'sendTaskMessage':
        this.control(this.command({ command: 'message_task', task: this.taskId, text: msg.text }), { draft: msg.text });
        return;
      case 'removeQueuedTaskMessage':
        this.control(this.command({ command: 'remove_queued', task: this.taskId, id: msg.id }), { takeBack: msg.id });
        return;
      case 'sendTaskMessageNow':
        this.control(this.command({ command: 'message_task', task: this.taskId, text: msg.text, force: true }));
        return;
      case 'sendQueuedTaskMessageNow':
        this.control(this.command({ command: 'force_send_queued', task: this.taskId, id: msg.id }));
        return;
      case 'interruptTask':
        this.control(this.command({ command: 'interrupt_task', task: this.taskId }));
        return;
      case 'cancelResume':
        this.control(this.command(taskActionCommand('cancel-resume', this.taskId)));
        return;
      case 'resumeNow':
        this.follow = { ...this.follow, followLatest: true };
        this.control(this.command(taskActionCommand('resume-now', this.taskId)));
        return;
      case 'continueTask':
        // The continue is a new attempt: show it, even from an earlier one.
        this.follow = { ...this.follow, followLatest: true };
        this.control(this.command({ command: 'retry_task', task: this.taskId, from: 'session', message: msg.text }));
        return;
      // The card settles when the task log reports the answer.
      case 'answerApproval':
        this.control(this.command({
          command: 'answer_approval',
          task: this.taskId,
          approval: msg.id,
          answer: msg.decision.decision,
          ...(msg.decision.decision === 'deny' && msg.decision.note ? { note: msg.decision.note } : {}),
        }));
        return;
      case 'openFile':
        this.port.openFile(msg.path);
        return;
    }
  }

  private emit(message: HostToTaskLog): void {
    for (const listener of [...this.listeners]) listener(message);
  }

  private observeServed(attempt: number, events: readonly TaskLogEvent[]): boolean {
    const before = this.served;
    if (attempt > this.served.attempt) this.served = { attempt };
    const model = attempt === this.served.attempt ? lastServedModel(events) : undefined;
    const task = model ? this.port.task(this.taskId)?.task : undefined;
    if (model && task) this.served = { attempt, model, assignment: assignmentKey(task) };
    return this.served.model !== before.model || this.served.assignment !== before.assignment;
  }

  private servedModel(task: RunTask): string | undefined {
    if (this.served.model && this.served.assignment === assignmentKey(task)) return this.served.model;
    return task.assignedModel?.modelId;
  }

  private params(attempt?: number): Record<string, string> {
    return {
      id: this.port.sessionId, workspace: this.port.workspace, taskId: this.taskId,
      ...(attempt !== undefined ? { attempt: String(attempt) } : {}),
    };
  }

  private async loadLatest(): Promise<void> {
    try {
      const listing = await callDaemon('sessions.taskLog', this.params());
      this.follow = { ...this.follow, attempts: listing.attempts };
      const latest = listing.attempts.at(-1) ?? 0;
      if (latest === 0) this.settle(0, [], listing.position);
      else await this.load(latest);
    } catch (error) {
      this.showError(error);
    }
  }

  private async load(attempt: number): Promise<void> {
    this.follow = followTaskLog(this.follow, { type: 'picked', attempt });
    try {
      const read = await callDaemon('sessions.taskLogAttempt', this.params(attempt));
      this.observeServed(attempt, read.events);
      this.settle(attempt, read.events, read.position);
    } catch (error) {
      this.showError(error);
    }
  }

  private settle(attempt: number, events: TaskLogEvent[], position: StreamStamp | undefined): void {
    const before = this.follow;
    this.follow = followTaskLog(this.follow, { type: 'loaded', attempt, events, ...(position ? { position } : {}) });
    // A read another pick overtook changes nothing, and draws nothing.
    if (this.follow === before) return;
    this.sent = [];
    if (this.ready) this.postInit();
  }

  private postInit(): void {
    const status = this.status();
    this.sent = this.follow.view.blocks;
    this.lastStatus = JSON.stringify(status);
    this.emit({ type: 'init', status, blocks: this.follow.view.blocks });
  }

  private push(): void {
    if (!this.ready) return;
    const patch = diffConversation(this.sent, this.follow.view.blocks);
    this.sent = this.follow.view.blocks;
    if (patch) this.emit({ type: 'patch', order: patch.order, changed: patch.changed });
    this.pushStatus();
  }

  private pushStatus(): void {
    if (!this.ready) return;
    const status = this.status();
    const key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.emit({ type: 'status', status });
  }

  status(): TaskLogStatus {
    const found = this.port.task(this.taskId);
    const task = found?.task;
    const idleSince = task?.idleSince ?? null;
    const isolation = task?.isolation;
    return {
      taskId: this.taskId,
      order: task?.order ?? 0,
      ...(found ? { orderLabel: found.label } : {}),
      title: task?.title ?? '',
      runner: (task && assignedRunnerOf(task)) ?? '',
      script: task?.type === 'script',
      header: taskLogHeaderView({
        status: task?.status ?? '',
        ...(task ? { type: task.type } : {}),
        ...(task?.awaitingReason ? { awaitingReason: task.awaitingReason } : {}),
        ...(task?.skipReason !== undefined ? { skipReason: task.skipReason } : {}),
        resumeAt: task?.resumeAt ?? null,
        idleSince,
        continuable: task?.continuable === true,
        ...(isolation?.state === 'conflict' && isolation.repairWaits ? { repairWaits: isolation.repairWaits } : {}),
        attemptUsage: task?.attemptUsage ?? [],
      }, this.follow, task?.awaitingApproval ?? 0, this.follow.attempt),
      taskStatus: task?.status ?? '',
      idleSince,
      turnStartedAt: this.follow.view.turnStartedAt ?? null,
      lastTurnEnd: this.follow.view.lastTurnEnd ?? null,
      queued: this.follow.view.queued,
      attempts: this.follow.attempts,
      attempt: this.follow.attempt,
    };
  }

  private async command(command: ExecutionCommand): Promise<unknown> {
    return callDaemon('plans.executeCommand', { sessionId: this.port.sessionId }, command);
  }

  private control(run: Promise<unknown>, refund: TaskLogRefund = {}): void {
    run.catch((error: unknown) => this.showError(error, refund));
  }

  private showError(error: unknown, { draft, takeBack }: TaskLogRefund = {}): void {
    this.emit({ type: 'showError', error: messageOf(error), ...(draft ? { draft } : {}), ...(takeBack ? { takeBack } : {}) });
  }
}
