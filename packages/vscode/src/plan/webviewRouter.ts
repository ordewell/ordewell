import * as vscode from 'vscode';
import { latestTaskCommands } from '../shared/taskCommands';
import type { RunnerId } from '@ordewell/core';
import type { ChildCheckpointAnswer, SettingsChange, WebviewToHost } from '@ordewell/ui/protocol';
import { ChatSessionHost } from '@ordewell/ui/host';
import { isKnownSlashCommand } from '../commands/SlashParser';
import { handleIsolationAction } from './isolation';
import {
  handleAddTask, handleCheckpointAnswer, handleEscalationAnswer, handleResolveApproval, handleNewSession, handleRemoveTask,
  handleSendMessage, handleSendMessageNow, handleStopPlanning, handleSystemCommand, handleTaskControl, handleTaskEdit, type PlanManagerDeps,
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
  openChild(childId: string): Promise<void>;
  refreshChildren(): Promise<void>;
  closeChild(): void;
  messageChild(childId: string, text: string): Promise<void>;
  answerChildCheckpoint(answer: ChildCheckpointAnswer): Promise<void>;
  openChildTaskLog(childId: string, taskId: string): Promise<void>;
  /** Open a workspace-relative file Ordewell kept, such as a handoff's saved patch (ADR-0050). */
  openFile(path: string): void;
  setPlanDockHeight(height: number): void;
  changeSettings(change: SettingsChange): Promise<void>;
  /** Sign a coding agent in with its own login in a terminal; no runner means the active planner. */
  loginPlanner(runner?: string): Promise<void>;
  /** Save a Runners pill's choice; the host answers `requestId` with what was saved, whether or not the save lands. */
  setRunnerEnabled(runnerId: RunnerId, enabled: boolean, requestId: string): Promise<void>;
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
  // The host's listener drops this promise, so a rejection from any handler
  // would be unhandled and the user would be told nothing.
  try {
    await dispatchWebviewMessage(msg, deps);
  } catch (err) {
    reportFailure(msg.type, err, deps);
  }
}

function reportFailure(what: string, err: unknown, deps: WebviewRouterDeps): void {
  const message = err instanceof Error ? err.message : String(err);
  deps.log(`[ERROR] webview message "${what}" failed: ${message}`);
  deps.notifications.error(`Ordewell: ${message}`);
}

async function dispatchWebviewMessage(msg: WebviewToHost, deps: WebviewRouterDeps): Promise<void> {
  switch (msg.type) {
    case 'refreshChildren':
      await deps.extension.refreshChildren();
      return;
    case 'openChild':
      await deps.extension.openChild(msg.childId);
      return;
    case 'closeChild':
      deps.extension.closeChild();
      return;
    case 'messageChild':
      await deps.extension.messageChild(msg.childId, msg.text);
      return;
    case 'answerChildCheckpoint':
      await deps.extension.answerChildCheckpoint(msg);
      return;
    case 'openChildTaskLog':
      await deps.extension.openChildTaskLog(msg.childId, msg.taskId);
      return;
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
      if (!chatSession(deps).hold(msg.text)) await sendChat(msg.text, true, undefined, deps);
      return;
    case 'unsendPrompt':
      chatSession(deps).unsend(msg.toComposer);
      return;
    case 'sendMessageNow':
      await sendChatNow(msg.text, deps);
      return;
    // A Retry compaction is a planner turn the chat did not send, so nothing
    // else releases what was typed while it ran.
    case 'sendSystemCommand':
      await handleSystemCommand(msg.command, msg.taskId ?? '', deps, msg.requestId);
      await chatSession(deps).release();
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
      await handleCheckpointAnswer(msg, deps);
      return;
    case 'answerEscalation':
      await handleEscalationAnswer(msg, deps);
      return;
    case 'getTaskCommands':
      deps.chatProvider.postMessage({ type: 'taskCommands', taskId: msg.taskId, commands: latestTaskCommands(deps.session, msg.taskId) });
      return;
    case 'invokeTaskCommand':
      deps.session.invokeTaskCommand(msg.taskId, msg.name, msg.args);
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
    case 'isolationAction':
      await handleIsolationAction(msg.action, msg.taskId, deps);
      return;
    case 'addNote':
      deps.chatProvider.conversation.note('system', msg.text);
      return;
    // The same resolution every surface funnels through: the session
    // broadcasts `approval_settled`, which redraws the card with its outcome.
    case 'resolveApproval':
      try {
        await handleResolveApproval(msg.id, msg.granted, deps);
      } catch (err) {
        deps.log(`Approval ${msg.id} could not be resolved: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    // The panel is its own webview; the chat only asks for it to be opened.
    case 'openTaskLog':
      deps.extension.openTaskLog(msg.taskId);
      return;
    case 'openFile':
      deps.extension.openFile(msg.path);
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
    case 'changeSettings':
      await deps.extension.changeSettings(msg.change);
      return;
    case 'setRunnerEnabled':
      await deps.extension.setRunnerEnabled(msg.runnerId, msg.enabled, msg.requestId);
      return;
    // Awaited on purpose: the flow waits on the user's own terminal, and a
    // poll that throws must still reach the user instead of vanishing.
    case 'loginPlanner':
      await deps.extension.loginPlanner(msg.runner);
      return;
    case 'stopResearch':
      handleStopPlanning(deps);
      return;
    case 'newSession':
      handleNewSession(deps);
      await deps.extension.refreshChildren();
      return;
    default: {
      const exhaustive: never = msg;
      return exhaustive;
    }
  }
}

/**
 * The chat's prompt actions over the in-process Session (ADR-0017 Q2). The
 * hold lives in the chat's conversation, so one is built per message.
 */
function chatSession(deps: WebviewRouterDeps): ChatSessionHost {
  return new ChatSessionHost(deps.chatProvider.conversation, {
    generating: () => deps.isGeneratingPlan(),
    // The Session's busy state is the turn itself, with no frame to trail it.
    answering: () => deps.isGeneratingPlan(),
    converse: async (text, turn) => {
      if (turn.now) return handleSendMessageNow(text, deps);
      await handleSendMessage(text, deps, turn.runners ? [...turn.runners] : deps.getPendingRunners(), deps.setPendingRunners);
      // Only a Send now's outcome is read, for its give-back; this turn reported its own failure.
      return { ok: true };
    },
  });
}

/**
 * A known slash command is the extension's to run, not a prompt: it is never
 * held, and takes nothing from the hold. A handler that returns mid-turn sends
 * nothing held: the turn still generating releases it when it ends.
 */
async function sendChat(text: string, typed: boolean, runners: RunnerId[] | undefined, deps: WebviewRouterDeps): Promise<void> {
  const chat = chatSession(deps);
  if (!(text.startsWith('/') && isKnownSlashCommand(text))) {
    await chat.send(text, typed, runners);
    return;
  }
  if (typed) deps.chatProvider.conversation.note('user', text);
  try {
    await deps.extension.runSlashCommand(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log(`[ERROR] slash command "${text}" failed: ${message}`);
    void vscode.window.showErrorMessage(`Command failed: ${message}`);
  }
  await chat.release();
}

/** Send now (ADR-0017 Q2, ADR-0023 F5); a slash command is a plain send. */
async function sendChatNow(text: string, deps: WebviewRouterDeps): Promise<void> {
  if (text.startsWith('/') && isKnownSlashCommand(text)) {
    await sendChat(text, true, undefined, deps);
    return;
  }
  await chatSession(deps).sendNow(text);
}

/**
 * A planner turn the chat did not send has returned (the Command Palette's
 * compaction): everything held goes now, as one message, unless the planner
 * is busy with another turn, whose end releases it instead.
 */
export function sendNextHeldPrompt(deps: WebviewRouterDeps): void {
  chatSession(deps).release().catch((err: unknown) => reportFailure('sendMessage', err, deps));
}
