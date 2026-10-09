import * as vscode from 'vscode';
import type { RunnerId } from '@ordewell/core';
import type { WebviewToHost } from '../shared/protocol';
import { isKnownSlashCommand } from '../commands/SlashParser';
import { handleIsolationAction } from './isolation';
import {
  handleAddTask, handleCheckpointAnswer, handleMergePlan, handleNewSession, handleRemoveTask,
  handleSendMessage, handleSplitPlan, handleStopPlanning, handleSystemCommand, handleTaskControl, handleTaskEdit, type PlanManagerDeps,
} from './PlanManager';

/** What the extension itself answers: the catalog, the planner choice and the task skills — none of it a plan action. */
export interface ExtensionHandlers {
  ready(): void;
  refreshModels(): void;
  runSlashCommand(text: string): Promise<void>;
  setPlanner(provider: string): Promise<void>;
  setPlannerModel(modelId: string, effort?: string): Promise<void>;
  /** Open (or focus) the on-demand task-log tab for a structured task (ADR-0018, V1). */
  openTaskLog(taskId: string): void;
  setPlanDockHeight(height: number): void;
}

export interface WebviewRouterDeps extends PlanManagerDeps {
  extension: ExtensionHandlers;
  /** The runner set the webview last planned with, for the next plan started from chat. */
  getPendingRunners(): RunnerId[] | undefined;
  setPendingRunners(runners: RunnerId[] | undefined): void;
}

/**
 * Every message the chat webview sends, to the one handler that owns it.
 * Nothing here decides anything about the plan: each variant names its
 * action, and its handler goes through the Session.
 */
export async function routeWebviewMessage(msg: WebviewToHost, deps: WebviewRouterDeps): Promise<void> {
  switch (msg.type) {
    case 'ready':
      deps.extension.ready();
      return;
    // A per-task model dropdown opened: a runner cold at activation would
    // otherwise keep showing an empty catalog until the next reconnect.
    case 'refreshModels':
      deps.extension.refreshModels();
      return;
    case 'sendMessage':
      await sendChat(msg.text, msg.typed ?? false, msg.runners, deps);
      return;
    // Typed while the webview saw a turn in flight. If the turn has ended by
    // the time it lands, there is nothing left to wait for.
    case 'holdPrompt':
      if (deps.isGeneratingPlan()) deps.chatProvider.conversation.holdPrompt(msg.text);
      else await sendChat(msg.text, true, undefined, deps);
      return;
    case 'unsendPrompt':
      deps.chatProvider.conversation.unsendPrompt();
      return;
    case 'sendSystemCommand':
      await handleSystemCommand(msg.command, msg.taskId ?? '', deps);
      return;
    case 'editTask':
      await handleTaskEdit(msg.taskId, msg.edit, deps);
      return;
    case 'removeTask':
      await handleRemoveTask(msg.taskId, deps);
      return;
    case 'addTask':
      await handleAddTask(msg.draft, deps);
      return;
    case 'answerCheckpoint':
      handleCheckpointAnswer(msg.taskId, msg.approved, msg.reason, deps);
      return;
    case 'sendTaskMessage':
      await handleTaskControl({ kind: 'message', text: msg.text }, msg.taskId, deps);
      return;
    case 'removeQueuedTaskMessage':
      await handleTaskControl({ kind: 'removeQueued', id: msg.id }, msg.taskId, deps);
      return;
    case 'sendTaskMessageNow':
      await handleTaskControl({ kind: 'messageNow', text: msg.text }, msg.taskId, deps);
      return;
    case 'sendQueuedTaskMessageNow':
      await handleTaskControl({ kind: 'queuedNow', id: msg.id }, msg.taskId, deps);
      return;
    case 'interruptTask':
      await handleTaskControl({ kind: 'interrupt' }, msg.taskId, deps);
      return;
    case 'mergeTasks':
      await handleMergePlan(msg.taskIds, deps);
      sendNextHeldPrompt(deps);
      return;
    case 'splitTask':
      await handleSplitPlan(msg.taskId, deps);
      sendNextHeldPrompt(deps);
      return;
    case 'isolationAction':
      await handleIsolationAction(msg.action, msg.taskId, deps);
      return;
    case 'addNote':
      deps.chatProvider.conversation.note('system', msg.text);
      return;
    // The echo is authoritative: the webview removed the edit optimistically,
    // and this settles which edits really remain.
    case 'removePendingPlanEdit':
      deps.session.removeQueuedMessage(msg.id);
      deps.chatProvider.showPendingPlanEdits(deps.session.getQueuedMessages());
      deps.persistState();
      return;
    // The same resolution every surface funnels through: the session
    // broadcasts `approval_settled`, which redraws the card with its outcome.
    case 'resolveApproval':
      try {
        deps.session.resolveApproval(msg.id, msg.granted);
      } catch (err) {
        deps.log(`Approval ${msg.id} could not be resolved: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    // The panel is its own webview; the chat only asks for it to be opened.
    case 'openTaskLog':
      deps.extension.openTaskLog(msg.taskId);
      return;
    case 'setPlanDockHeight':
      deps.extension.setPlanDockHeight(msg.height);
      return;
    case 'setPlanner':
      await deps.extension.setPlanner(msg.provider);
      return;
    case 'setPlannerModel':
      await deps.extension.setPlannerModel(msg.modelId, msg.effort);
      return;
    case 'stopResearch':
      handleStopPlanning(deps);
      return;
    case 'newSession':
      handleNewSession(deps);
      return;
    default: {
      const exhaustive: never = msg;
      return exhaustive;
    }
  }
}

async function sendChat(text: string, typed: boolean, runners: RunnerId[] | undefined, deps: WebviewRouterDeps): Promise<void> {
  const command = text.startsWith('/') && isKnownSlashCommand(text);
  // A prompt that reaches the host while a turn is still its own — typed in
  // the gap before the webview saw the turn close, or just after a stop that
  // has not unwound — waits for it: starting another turn now would race it.
  if (typed && !command && deps.isGeneratingPlan()) {
    deps.chatProvider.conversation.holdPrompt(text);
    return;
  }
  if (typed && text.trim()) deps.chatProvider.conversation.note('user', text);
  if (command) {
    try {
      await deps.extension.runSlashCommand(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`[ERROR] slash command "${text}" failed: ${message}`);
      void vscode.window.showErrorMessage(`Command failed: ${message}`);
    }
  } else {
    await handleSendMessage(text, deps, runners ?? deps.getPendingRunners(), deps.setPendingRunners);
  }
  sendNextHeldPrompt(deps);
}

/**
 * The turn is over once its handler has returned — its abort cleared, its
 * plan applied — so the oldest queued prompt goes now. A handler that returns
 * mid-turn (a slash command) sends nothing: the turn still generating drains
 * the queue when it ends.
 */
function sendNextHeldPrompt(deps: WebviewRouterDeps): void {
  if (deps.isGeneratingPlan()) return;
  const next = deps.chatProvider.conversation.nextPrompt();
  if (next !== undefined) void sendChat(next, true, undefined, deps);
}
