import * as vscode from 'vscode';
import { accountLimitsOf, assignedRunnerOf, lastServedModel, taskActionCommand, canContinue, taskLogHeaderView, type AccountLimitSnapshot, type CommandOutcome, type DisplayBlock, type ExecutionActor, type ExecutionCommand, type IsolationView, type PendingApproval, type SessionMessage, type Task, type TaskLogEvent } from '@ordewell/core';
import { EMPTY_TASK_LOG_FOLLOW, followTaskLog } from '@ordewell/core/plan-utils';
import { diffConversation } from '../shared/conversationPatch';
import { renderWebviewHtml } from './webviewHtml';
import type { HostToTaskLog, TaskLogStatus, TaskLogToHost } from '../shared/taskLogProtocol';

/**
 * The Session calls a task-log panel makes (ADR-0018, M1, A1, K1). Narrowed to
 * the ones the panel owns, so its test needs no Session — the concrete
 * Session satisfies this structurally.
 */
export interface TaskLogSession {
  taskLogAttempts(taskId: string): number[];
  taskLog(taskId: string, attempt: number): TaskLogEvent[];
  /** Every control in the panel is a command at the seam, run as the user (ADR-0029). */
  execute(command: ExecutionCommand, actor: ExecutionActor): Promise<CommandOutcome>;
  invokeTaskCommand(taskId: string, name: string, args: string): string;
  outstandingApprovals(): PendingApproval[];
  /** Each task's isolation as the scheduler reads it: a repair waiting to start is said nowhere else. */
  isolationView(): IsolationView | null;
}

export interface TaskLogPanelDeps {
  session: TaskLogSession;
  getTask: (taskId: string) => Task | undefined;
  /** The task's dotted reference ("2", "2.1"): a subtask's own order restarts at 1. */
  orderLabel?: (taskId: string) => string | undefined;
  /** Every runner's account limits; the panel shows only those of the runner its task is assigned to. */
  accountLimits?: () => readonly AccountLimitSnapshot[];
  /** Open a workspace-relative file the handoff saved, such as its patch (ADR-0050). */
  openFile: (path: string) => void;
  /** When the task's runner went quiet, if it has: seeds a panel that opens after the stream said so. */
  idleSince?: (taskId: string) => string | null;
  log: (msg: string) => void;
}

const NO_LIMITS = JSON.stringify([]);

// A plan event that can change the task the header describes. Everything else
// the panel hears is ignored, so a planner's text deltas cost it nothing.
const TASK_STATE_EVENTS: ReadonlySet<SessionMessage['type']> = new Set([
  'status_update', 'task_updated', 'task_started', 'execution_complete', 'execution_stopped',
]);

/**
 * One task's log tab (ADR-0018, V1): an editor webview that draws a structured
 * task's saved attempt and follows it live. It loads the attempt's file on
 * open, so closing and reopening shows the full history, then folds the
 * `task_log` broadcasts the recorder streams. It never writes the log and
 * never touches the task — messaging, removing a queued message, interrupting
 * and answering a request all go through the command seam as the user,
 * exactly as the chat's controls do.
 */
export class TaskLogPanel {
  private follow = followTaskLog(EMPTY_TASK_LOG_FOLLOW, { type: 'opened' });
  private sent: readonly DisplayBlock[] = [];
  private sequence = 0;
  private ready = false;
  private lastStatus = '';
  /** What the webview holds; a new one starts with none. */
  private lastLimits = NO_LIMITS;
  /** When the runner last went quiet, as the status stream says it: the Session keeps no per-task answer to ask for. */
  private idleSince: string | null = null;
  /**
   * The task's latest attempt, the model its own calls last ran on there, and
   * the assignment that was current when it was seen: an account that meters
   * one provider is drawn by what serves the task, not only by what was planned.
   */
  private served: { attempt: number; model?: string; assignment?: string } = { attempt: 0 };

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly taskId: string,
    private readonly deps: TaskLogPanelDeps,
    extensionUri: vscode.Uri,
    onDisposed: () => void,
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webviews')],
    };
    panel.webview.html = renderWebviewHtml({
      webview: panel.webview,
      extensionUri,
      script: 'tasklog.js',
      title: 'Task log',
    });
    this.idleSince = deps.idleSince?.(taskId) ?? null;
    panel.webview.onDidReceiveMessage((msg: TaskLogToHost) => this.handle(msg));
    panel.onDidDispose(() => onDisposed());
  }

  /** Bring the tab to the front; used when "Open chat" is clicked on an open panel. */
  reveal(): void { this.panel.reveal(); }

  dispose(): void { this.panel.dispose(); }

  /**
   * A session event. Only this task's log, on the attempt on screen, changes
   * the blocks; a task-bearing event refreshes the header either way.
   */
  receive(msg: SessionMessage): void {
    if (msg.type === 'task_log') {
      if (msg.taskId !== this.taskId) return;
      if (this.observeServed(msg.attempt, msg.events)) this.pushAccountLimits();
      const previous = this.follow.attempt;
      this.follow = followTaskLog(this.follow, { type: 'live', attempt: msg.attempt, events: msg.events, position: this.position(++this.sequence) });
      if (this.ready && this.follow.attempt > previous) this.load(this.follow.attempt);
      else this.push();
      return;
    }
    if (msg.type === 'status_update') this.idleSince = msg.tasks.find((t) => t.id === this.taskId)?.idleSince ?? null;
    if (TASK_STATE_EVENTS.has(msg.type)) {
      this.pushStatus();
      // A reassigned task draws its new runner's account.
      this.pushAccountLimits();
    }
  }

  /**
   * The limits of the account the task's runner uses now, when they differ
   * from what the panel was last sent. Never the planner's or another
   * runner's, and never from the attempt on screen: they are the account's
   * live state.
   */
  pushAccountLimits(): void {
    if (!this.ready) return;
    const task = this.deps.getTask(this.taskId);
    const limits = accountLimitsOf(this.deps.accountLimits?.() ?? [], task && assignedRunnerOf(task), task && this.servedModel(task));
    const key = JSON.stringify(limits);
    if (key === this.lastLimits) return;
    this.lastLimits = key;
    this.panel.webview.postMessage({ type: 'accountLimits', limits } satisfies HostToTaskLog);
  }

  /** Whether the latest attempt's own calls now name another model than before. */
  private observeServed(attempt: number, events: readonly TaskLogEvent[]): boolean {
    const before = this.served;
    if (attempt > this.served.attempt) this.served = { attempt };
    const model = attempt === this.served.attempt ? lastServedModel(events) : undefined;
    const task = model ? this.deps.getTask(this.taskId) : undefined;
    if (model && task) this.served = { attempt, model, assignment: assignmentKey(task) };
    return this.served.model !== before.model || this.served.assignment !== before.assignment;
  }

  /** What serves the task now: its latest attempt's model, while the assignment it ran under stands; else the assignment's. */
  private servedModel(task: Task): string | undefined {
    if (this.served.model && this.served.assignment === assignmentKey(task)) return this.served.model;
    return task.assignedModel?.modelId;
  }

  private handle(msg: TaskLogToHost): void {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        // The first attempt may not have existed when the panel was built.
        if (this.follow.attempt === 0) this.loadLatest();
        else this.postInit();
        // A reloaded webview holds nothing, so it is sent them whatever was sent before.
        this.lastLimits = NO_LIMITS;
        this.pushAccountLimits();
        return;
      case 'selectAttempt':
        this.selectAttempt(msg.attempt);
        return;
      case 'invokeTaskCommand':
        this.control(() => { this.deps.session.invokeTaskCommand(this.taskId, msg.name, msg.args); });
        return;
      case 'sendTaskMessage':
        this.controlAsync(() => this.userCommand({ command: 'message_task', task: this.taskId, text: msg.text }));
        return;
      case 'removeQueuedTaskMessage':
        this.controlAsync(() => this.userCommand({ command: 'remove_queued', task: this.taskId, id: msg.id }));
        return;
      case 'sendTaskMessageNow':
        this.controlAsync(() => this.userCommand({ command: 'message_task', task: this.taskId, text: msg.text, force: true }));
        return;
      case 'sendQueuedTaskMessageNow':
        this.controlAsync(() => this.userCommand({ command: 'force_send_queued', task: this.taskId, id: msg.id }));
        return;
      case 'interruptTask':
        this.controlAsync(() => this.userCommand({ command: 'interrupt_task', task: this.taskId }));
        return;
      case 'cancelResume':
        this.controlAsync(() => this.userCommand(taskActionCommand('cancel-resume', this.taskId)));
        return;
      case 'resumeNow':
        this.follow = { ...this.follow, followLatest: true };
        this.controlAsync(() => this.userCommand(taskActionCommand('resume-now', this.taskId)));
        return;
      case 'openFile':
        this.deps.openFile(msg.path);
        return;
      case 'continueTask':
        // The continue is a new attempt: show it, even from an earlier one.
        this.follow = { ...this.follow, followLatest: true };
        this.controlAsync(() => this.userCommand({ command: 'retry_task', task: this.taskId, from: 'session', message: msg.text }));
        return;
      // The card settles when the task log reports the answer.
      case 'answerApproval':
        this.controlAsync(() => this.userCommand({
          command: 'answer_approval',
          task: this.taskId,
          approval: msg.id,
          answer: msg.decision.decision,
          ...(msg.decision.decision === 'deny' && msg.decision.note ? { note: msg.decision.note } : {}),
        }));
        return;
    }
  }

  private selectAttempt(attempt: number): void {
    if (!this.follow.attempts.includes(attempt)) return;
    this.load(attempt);
  }

  private loadLatest(): void {
    const attempts = this.deps.session.taskLogAttempts(this.taskId);
    this.follow = { ...this.follow, attempts };
    this.load(attempts.at(-1) ?? 0);
  }

  private position(seq = this.sequence): { stream: string; seq: number } {
    return { stream: 'in-process', seq };
  }

  private load(attempt: number): void {
    this.follow = followTaskLog(this.follow, { type: 'picked', attempt });
    // Session reads and broadcasts share this stack, so the local sequence
    // marks exactly what the synchronous read contains, just as the daemon's.
    const events = attempt > 0 ? this.deps.session.taskLog(this.taskId, attempt) : [];
    // What served a saved attempt the panel did not hear live comes from this read, never from a second one.
    this.observeServed(attempt, events);
    this.follow = followTaskLog(this.follow, { type: 'loaded', attempt, events, position: this.position() });
    this.sent = [];
    if (this.ready) this.postInit();
  }

  private postInit(): void {
    const status = this.status();
    this.sent = this.follow.view.blocks;
    this.lastStatus = JSON.stringify(status);
    this.panel.title = taskTabTitle(status);
    this.panel.webview.postMessage({ type: 'init', status, blocks: this.follow.view.blocks } satisfies HostToTaskLog);
  }

  private push(): void {
    if (!this.ready) return;
    const patch = diffConversation(this.sent, this.follow.view.blocks);
    this.sent = this.follow.view.blocks;
    if (patch) {
      this.panel.webview.postMessage({ type: 'patch', order: patch.order, changed: patch.changed } satisfies HostToTaskLog);
    }
    this.pushStatus();
  }

  private pushStatus(): void {
    if (!this.ready) return;
    const status = this.status();
    const key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.panel.title = taskTabTitle(status);
    this.panel.webview.postMessage({ type: 'status', status } satisfies HostToTaskLog);
  }

  private status(): TaskLogStatus {
    const task = this.deps.getTask(this.taskId);
    const approvals = this.deps.session.outstandingApprovals()
      .filter((p) => p.request.kind === 'runner_tool' && p.request.taskId === this.taskId).length;
    const isolation = this.deps.session.isolationView()?.tasks[this.taskId];
    return {
      taskId: this.taskId,
      order: task?.order ?? 0,
      orderLabel: this.deps.orderLabel?.(this.taskId),
      title: task?.title ?? '',
      runner: (task && assignedRunnerOf(task)) ?? '',
      script: task?.type === 'script',
      header: taskLogHeaderView({
        status: task?.status ?? '',
        ...(task?.awaitingReason ? { awaitingReason: task.awaitingReason } : {}),
        ...(task?.skipReason !== undefined ? { skipReason: task.skipReason } : {}),
        resumeAt: task?.resumeAt ?? null,
        idleSince: this.idleSince,
        continuable: task ? canContinue(task) : false,
        ...(isolation?.state === 'conflict' && isolation.repairWaits ? { repairWaits: isolation.repairWaits } : {}),
        attemptUsage: task?.attemptUsage ?? [],
      }, this.follow, approvals, this.follow.attempt),
      taskStatus: task?.status ?? '',
      idleSince: this.idleSince,
      turnStartedAt: this.follow.view.turnStartedAt ?? null,
      lastTurnEnd: this.follow.view.lastTurnEnd ?? null,
      queued: this.follow.view.queued,
      attempts: this.follow.attempts,
      attempt: this.follow.attempt,
    };
  }

  private control(run: () => void): void {
    try {
      run();
    } catch (err) {
      this.showError(err);
    }
  }

  // A refusal is the seam's answer, shown in the panel rather than swallowed
  // by an unhandled rejection.
  private async userCommand(command: ExecutionCommand): Promise<void> {
    const outcome = await this.deps.session.execute(command, { kind: 'user' });
    if (!outcome.ok) throw new Error(outcome.message);
  }

  private controlAsync(run: () => Promise<void>): void {
    run().catch((err: unknown) => this.showError(err));
  }

  private showError(err: unknown): void {
    const error = err instanceof Error ? err.message : String(err);
    this.deps.log(`Task log control failed: ${error}`);
    this.panel.webview.postMessage({ type: 'showError', error } satisfies HostToTaskLog);
  }
}

/** A reassignment of runner or model is a new binding: what the old one was seen running on no longer speaks for it. */
function assignmentKey(task: Task): string {
  return `${task.assignedRunner}\0${task.assignedModel?.modelId ?? ''}`;
}

/** The tab title ADR-0018 asks for: `Task N · <title>`, with a subtask's dotted reference. */
export function taskTabTitle(status: Pick<TaskLogStatus, 'order' | 'orderLabel' | 'title'>): string {
  return `Task ${status.orderLabel ?? status.order} · ${status.title}`;
}
