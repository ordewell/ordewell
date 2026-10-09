import * as vscode from 'vscode';
import { canContinue, type ApprovalAnswer, type DisplayBlock, type PendingApproval, type SessionMessage, type Task, type TaskLogEvent } from '@ordewell/core';
import { EMPTY_TASK_LOG, reduceTaskLog, replayTaskLog, type TaskLogView } from '@ordewell/core/plan-utils';
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
  sendTaskMessage(taskId: string, text: string): string;
  removeQueuedTaskMessage(taskId: string, id: string): boolean;
  forceSendTaskMessage(taskId: string, text: string): string;
  forceSendQueuedTaskMessage(taskId: string, id: string): boolean;
  interruptTask(taskId: string): Promise<void>;
  continueTask(taskId: string, message: string): Promise<void>;
  outstandingApprovals(): PendingApproval[];
  resolveApproval(id: string, answer: ApprovalAnswer): boolean;
}

/** Why a queued message could not be force sent: the runner took it in the meantime (ADR-0023, D3). */
export const ALREADY_HANDED_OVER = 'The runner already has that message; it reads it after its current step.';

export interface TaskLogPanelDeps {
  session: TaskLogSession;
  getTask: (taskId: string) => Task | undefined;
  log: (msg: string) => void;
}

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
 * never touches the task — messaging, removing a queued message and
 * interrupting all go through the Session, exactly as the chat's controls do.
 */
export class TaskLogPanel {
  private view: TaskLogView = EMPTY_TASK_LOG;
  private sent: readonly DisplayBlock[] = [];
  private attempts: readonly number[] = [];
  /** Which attempt the blocks belong to; 0 until an attempt is known. */
  private attempt = 0;
  /** Follow the newest attempt until the user picks an earlier one. */
  private followLive = true;
  private ready = false;
  private lastStatus = '';

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
    panel.webview.onDidReceiveMessage((msg: TaskLogToHost) => this.handle(msg));
    panel.onDidDispose(() => onDisposed());
  }

  /** Bring the tab to the front; used when "Open log" is clicked on an open panel. */
  reveal(): void { this.panel.reveal(); }

  dispose(): void { this.panel.dispose(); }

  /**
   * A session event. Only this task's log, on the attempt on screen, changes
   * the blocks; a task-bearing event refreshes the header either way.
   */
  receive(msg: SessionMessage): void {
    if (msg.type === 'task_log') {
      if (msg.taskId !== this.taskId) return;
      // A follow of a new attempt reloads from the file, which already holds
      // the batch this event carries — reducing it too would double it.
      const reloaded = this.noteAttempt(msg.attempt);
      if (!reloaded && msg.attempt === this.attempt) {
        this.view = msg.events.reduce(reduceTaskLog, this.view);
        this.push();
      } else {
        this.pushStatus();
      }
      return;
    }
    if (TASK_STATE_EVENTS.has(msg.type)) this.pushStatus();
  }

  private handle(msg: TaskLogToHost): void {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        // The first attempt may not have existed when the panel was built.
        if (this.attempt === 0) this.loadLatest();
        else this.postInit();
        return;
      case 'selectAttempt':
        this.selectAttempt(msg.attempt);
        return;
      case 'sendTaskMessage':
        this.control(() => { this.deps.session.sendTaskMessage(this.taskId, msg.text); });
        return;
      case 'removeQueuedTaskMessage':
        this.control(() => { this.deps.session.removeQueuedTaskMessage(this.taskId, msg.id); });
        return;
      case 'sendTaskMessageNow':
        this.control(() => { this.deps.session.forceSendTaskMessage(this.taskId, msg.text); });
        return;
      case 'sendQueuedTaskMessageNow':
        this.control(() => {
          if (!this.deps.session.forceSendQueuedTaskMessage(this.taskId, msg.id)) throw new Error(ALREADY_HANDED_OVER);
        });
        return;
      case 'interruptTask':
        this.controlAsync(() => this.deps.session.interruptTask(this.taskId));
        return;
      case 'continueTask':
        // The continue is a new attempt: show it, even from an earlier one.
        this.followLive = true;
        this.controlAsync(() => this.deps.session.continueTask(this.taskId, msg.text));
        return;
      // The card settles when the task log reports the answer.
      case 'answerApproval':
        this.control(() => {
          if (!this.deps.session.resolveApproval(msg.id, msg.decision)) throw new Error('That request is no longer waiting for an answer.');
        });
        return;
    }
  }

  private selectAttempt(attempt: number): void {
    if (!this.attempts.includes(attempt)) return;
    this.followLive = attempt === this.attempts[this.attempts.length - 1];
    this.load(attempt);
  }

  private loadLatest(): void {
    const attempts = this.deps.session.taskLogAttempts(this.taskId);
    this.attempts = attempts;
    this.load(attempts.length > 0 ? attempts[attempts.length - 1] : 0);
  }

  private load(attempt: number): void {
    this.attempt = attempt;
    this.view = attempt > 0 ? replayTaskLog(this.deps.session.taskLog(this.taskId, attempt)) : EMPTY_TASK_LOG;
    this.sent = [];
    if (this.ready) this.postInit();
  }

  /** Track an attempt a broadcast named; returns true when it switched to it. */
  private noteAttempt(attempt: number): boolean {
    if (attempt > 0 && !this.attempts.includes(attempt)) {
      this.attempts = [...this.attempts, attempt].sort((a, b) => a - b);
    }
    // A retry mints a new attempt while the tab is open: follow it if the user
    // was on the newest one, leave an earlier attempt the user chose alone.
    // Before `ready` there is nothing to switch, and `loadLatest` will pick it.
    if (this.followLive && this.ready && attempt > 0 && attempt !== this.attempt) {
      this.load(attempt);
      return true;
    }
    return false;
  }

  private postInit(): void {
    const status = this.status();
    this.sent = this.view.blocks;
    this.lastStatus = JSON.stringify(status);
    this.panel.title = taskTabTitle(status);
    this.panel.webview.postMessage({ type: 'init', status, blocks: this.view.blocks } satisfies HostToTaskLog);
  }

  private push(): void {
    if (!this.ready) return;
    const patch = diffConversation(this.sent, this.view.blocks);
    this.sent = this.view.blocks;
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
    return {
      taskId: this.taskId,
      order: task?.order ?? 0,
      title: task?.title ?? '',
      runner: task?.assignedRunner ?? '',
      planStatus: task?.status ?? 'pending',
      awaitingReason: task?.awaitingReason,
      awaitingApproval: this.deps.session.outstandingApprovals()
        .filter((p) => p.request.kind === 'runner_tool' && p.request.taskId === this.taskId).length,
      working: this.view.working,
      lastTurnEnd: this.view.lastTurnEnd,
      queued: this.view.queued,
      attempts: this.attempts,
      attempt: this.attempt,
      continuable: task ? canContinue(task) : false,
    };
  }

  // A refusal (a task not running) is the Session's answer,
  // shown in the panel rather than swallowed by an unhandled rejection.
  private control(run: () => void): void {
    try {
      run();
    } catch (err) {
      this.showError(err);
    }
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

/** The tab title ADR-0018 asks for: `Task N · <title>`. */
export function taskTabTitle(status: Pick<TaskLogStatus, 'order' | 'title'>): string {
  return `Task ${status.order} · ${status.title}`;
}
