import * as vscode from 'vscode';
import { listTaskLogAttempts, readTaskLog, type ChildDirectory, type ChildPlanHandle, type CommandOutcome, type ExecutionCommand, type SurfaceTask, type Task } from '@ordewell/core';
import { refusalText } from './ChildViewHost';
import { TaskLogPanel, taskTabTitle, type TaskLogSession } from './TaskLogPanel';

/** The child tab's own view type: a root tab's serializer must never revive one, as its id means nothing in the root's plan. */
export const CHILD_TASK_LOG_VIEW_TYPE = 'ordewellChildTaskLog';

const NOT_IN_TREE = 'This child plan is no longer in this session.';

export interface ChildTaskLogsDeps {
  extensionUri: vscode.Uri;
  directory: () => Pick<ChildDirectory, 'find' | 'onChange'>;
  rootId: () => string;
  openFile: (path: string) => void;
  log: (message: string) => void;
}

function findTask(tasks: readonly SurfaceTask[], taskId: string): SurfaceTask | undefined {
  for (const task of tasks) {
    if (task.id === taskId) return task;
    const nested = findTask(task.subtasks, taskId);
    if (nested) return nested;
  }
  return undefined;
}

/** The tab's whole authority: a child and task id, each proved against the tree when a tab comes back. */
function savedIdentity(state: unknown): { childId: string; taskId: string } | null {
  if (typeof state !== 'object' || state === null) return null;
  const { childId, taskId } = state as { childId?: unknown; taskId?: unknown };
  return typeof childId === 'string' && typeof taskId === 'string' ? { childId, taskId } : null;
}

/** Why this runner takes no message now, so the tab says so before anyone types one. */
function silence(child: ChildPlanHandle, task: Task | undefined): string | undefined {
  const entry = child.entry();
  if (entry.state === 'ended') return refusalText({ code: 'view_only', message: '' });
  if (entry.refused) return entry.refused;
  if (task?.status === 'awaiting_user' && task.awaitingReason === 'checkpoint') return 'This task is waiting at a checkpoint: answer it in the chat, on this subplanner.';
  return task?.status === 'in_progress' || task?.status === 'awaiting_user' ? undefined : 'This task is not running, so it takes no message.';
}

/**
 * Child runner tabs: each reads and speaks through a tree-authorized handle,
 * never the root Session, so a person's message is judged under the child
 * plan's own mandate (ADR-0055 D20). No force, interrupt or Continue reaches a
 * child from here: the seam has none (ADR-0056 M8).
 */
export class ChildTaskLogs {
  private readonly tabs = new Map<string, { panel: TaskLogPanel; root: string; stop: () => void }>();
  private unlisten: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly deps: ChildTaskLogsDeps) {}

  /** Throws what to tell the person, since nothing opening says nothing. */
  async open(childId: string, taskId: string): Promise<void> {
    const key = tabKey(childId, taskId);
    const existing = this.tabs.get(key);
    if (existing) { existing.panel.reveal(); return; }
    const root = this.deps.rootId();
    const child = await this.deps.directory().find(childId);
    if (!child || root !== this.deps.rootId() || this.disposed) throw new Error(NOT_IN_TREE);
    const task = this.readTask(child, taskId);
    if (!task || !listTaskLogAttempts(child.logLocation(), taskId).length) throw new Error('This task has no runner chat yet.');
    const raced = this.tabs.get(key);
    if (raced) { raced.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel(CHILD_TASK_LOG_VIEW_TYPE, taskTabTitle(task), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.attach(panel, child, childId, taskId, root);
  }

  /**
   * A tab VS Code brings back holds only what it saved, so nothing it says is
   * believed until the tree agrees: anything else closes rather than speak to
   * a plan outside this session.
   */
  async restore(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const identity = savedIdentity(state);
    if (!identity) { panel.dispose(); return; }
    const { childId, taskId } = identity;
    let closed = false;
    const closing = panel.onDidDispose(() => { closed = true; });
    const root = this.deps.rootId();
    let child: ChildPlanHandle | null = null;
    try { child = await this.deps.directory().find(childId); }
    catch (error) { this.deps.log(`Could not restore a child runner tab: ${error}`); }
    closing.dispose();
    if (closed) return;
    const held = child && this.readTask(child, taskId) && listTaskLogAttempts(child.logLocation(), taskId).length > 0;
    if (!child || !held || root !== this.deps.rootId() || this.disposed || this.tabs.has(tabKey(childId, taskId))) { panel.dispose(); return; }
    this.attach(panel, child, childId, taskId, root);
  }

  register(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(CHILD_TASK_LOG_VIEW_TYPE, {
      deserializeWebviewPanel: (panel, state) => this.restore(panel, state),
    });
  }

  /** A tab belongs to its root: under another its ids name nothing, so it goes rather than linger read-only. */
  rootChanged(): void {
    const root = this.deps.rootId();
    for (const tab of [...this.tabs.values()]) if (tab.root !== root) tab.panel.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = undefined;
    for (const { panel } of [...this.tabs.values()]) panel.dispose();
  }

  private readTask(child: ChildPlanHandle, taskId: string): Task | undefined {
    const task = findTask(child.view().plan?.tasks ?? [], taskId);
    return task ? { ...task, attemptSkills: undefined, subtasks: [] } : undefined;
  }

  private attach(panel: vscode.WebviewPanel, child: ChildPlanHandle, childId: string, taskId: string, root: string): void {
    const key = tabKey(childId, taskId);
    const location = child.logLocation();
    const session: TaskLogSession = {
      taskLogAttempts: (id) => listTaskLogAttempts(location, id),
      taskLog: (id, attempt) => readTaskLog(location, id, attempt),
      execute: (command) => this.speak(childId, taskId, root, command),
      invokeTaskCommand: () => '',
      outstandingApprovals: () => [],
      isolationView: () => null,
    };
    const getTask = (): Task | undefined => this.readTask(child, taskId);
    const controller = new TaskLogPanel(panel, taskId, {
      session,
      getTask,
      child: () => {
        const note = silence(child, getTask());
        return { id: childId, ...(note ? { note } : {}) };
      },
      openFile: this.deps.openFile,
      log: this.deps.log,
    }, this.deps.extensionUri, () => {
      this.tabs.get(key)?.stop();
      this.tabs.delete(key);
    });
    const stop = child.watch((frame) => { if (frame.type !== 'notice') controller.receive(frame); });
    this.tabs.set(key, { panel: controller, root, stop });
    // The tree's own change, as a child can stop listening without a frame of its own.
    this.unlisten ??= this.deps.directory().onChange(() => { for (const { panel: open } of this.tabs.values()) open.statusChanged(); });
  }

  /** The child is found again for each message: the handle the tab holds speaks for the tree it was found in. */
  private async speak(childId: string, taskId: string, root: string, command: ExecutionCommand): Promise<CommandOutcome> {
    if (command.command !== 'message_task' || command.force) return { ok: false, outcome: 'refused', message: 'A child runner takes only a message.' };
    const child = await this.deps.directory().find(childId);
    if (!child || root !== this.deps.rootId()) return { ok: false, outcome: 'refused', message: NOT_IN_TREE };
    const outcome = await child.control(taskId, { kind: 'message', text: command.text });
    return outcome.ok ? { ok: true, message: outcome.message } : { ok: false, outcome: 'refused', message: refusalText(outcome) };
  }
}

function tabKey(childId: string, taskId: string): string { return `${childId}\0${taskId}`; }
