import * as vscode from 'vscode';
import { taskChatAvailable, type AccountLimitSnapshot, type SessionMessage, type Task } from '@ordewell/core';
import { TaskLogPanel, taskTabTitle, type TaskLogSession } from './TaskLogPanel';

/** The editor tab's view type; one panel per task is keyed by task id, not by this. */
export const TASK_LOG_VIEW_TYPE = 'ordewellTaskLog';

export interface TaskLogRegistryDeps {
  extensionUri: vscode.Uri;
  session: () => TaskLogSession;
  getTask: (taskId: string) => Task | undefined;
  /** The task's dotted reference ("2", "2.1"): a subtask's own order restarts at 1. */
  orderLabel?: (taskId: string) => string | undefined;
  /** Every runner's account limits as the host's monitor last read them; each panel picks its task's runner. */
  accountLimits?: () => readonly AccountLimitSnapshot[];
  /** Open a workspace-relative file the log's handoff saved, from the panel's own link (ADR-0050). */
  openFile: (path: string) => void;
  /** When the task's runner went quiet, if it has, as the Session's run holds it: a tab opened or restored later learns it from here, as no update need follow. */
  idleSince?: (taskId: string) => string | null;
  log: (msg: string) => void;
}

/**
 * The open task-log tabs, keyed by task (ADR-0018, V1). Nothing here opens a
 * panel by itself: `open` is what the chat's "Open chat" reaches, and reusing an
 * already-open tab focuses it rather than opening a second. Every session
 * event is offered to each open panel, which filters to its own task.
 */
export class TaskLogRegistry {
  private readonly panels = new Map<string, TaskLogPanel>();

  constructor(private readonly deps: TaskLogRegistryDeps) {}

  open(taskId: string): void {
    const existing = this.panels.get(taskId);
    if (existing) {
      existing.reveal();
      return;
    }
    const task = this.deps.getTask(taskId);
    if (!task) {
      this.deps.log(`No task ${taskId} to open a task log for.`);
      return;
    }
    // A click can outlive what it named: a chat exists only once an attempt does.
    if (!this.hasChat(task)) {
      this.deps.log(`Task ${taskId} has not started, so it has no chat to open.`);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      TASK_LOG_VIEW_TYPE,
      taskTabTitle({ order: task.order, orderLabel: this.deps.orderLabel?.(taskId), title: task.title }),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.attach(panel, taskId);
  }

  /**
   * Ties a panel to its task. A restored panel is one VS Code recreated after
   * a window reload, so its task may have left the plan meanwhile: it is
   * dropped rather than left empty. The webview saves its task id with
   * `setState` exactly so a reload can find it again.
   */
  restore(panel: vscode.WebviewPanel, state: unknown): void {
    const taskId = restoredTaskId(state);
    const existing = taskId ? this.panels.get(taskId) : undefined;
    const task = taskId ? this.deps.getTask(taskId) : undefined;
    if (!taskId || !task || existing || !this.hasChat(task)) {
      panel.dispose();
      return;
    }
    this.attach(panel, taskId);
  }

  /**
   * The one rule the chat controls and a restored tab read: an attempt of the
   * task has started. A saved attempt log stands in for a plan written before
   * the task kept that mark; a manual task's handoff log is not an attempt.
   */
  private hasChat(task: Task): boolean {
    return taskChatAvailable(task) || (task.type !== 'user' && this.deps.session().taskLogAttempts(task.id).length > 0);
  }

  /** Registers the serializer that reopens task-log tabs across a window reload. */
  register(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(TASK_LOG_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state) => { this.restore(panel, state); },
    });
  }

  receive(msg: SessionMessage): void {
    for (const panel of this.panels.values()) panel.receive(msg);
  }

  /** The monitor read an account again. */
  accountLimitsChanged(): void {
    for (const panel of this.panels.values()) panel.pushAccountLimits();
  }

  dispose(): void {
    for (const panel of [...this.panels.values()]) panel.dispose();
    this.panels.clear();
  }

  private attach(panel: vscode.WebviewPanel, taskId: string): void {
    const controller = new TaskLogPanel(
      panel,
      taskId,
      { session: this.deps.session(), getTask: this.deps.getTask, orderLabel: this.deps.orderLabel, accountLimits: this.deps.accountLimits, idleSince: this.deps.idleSince, openFile: this.deps.openFile, log: this.deps.log },
      this.deps.extensionUri,
      () => { this.panels.delete(taskId); },
    );
    this.panels.set(taskId, controller);
  }
}

function restoredTaskId(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const id = (state as { taskId?: unknown }).taskId;
  return typeof id === 'string' ? id : undefined;
}
