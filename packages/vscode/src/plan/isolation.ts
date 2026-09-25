import * as vscode from 'vscode';
import type { IsolationHandoff, Session } from '@ordewell/core';
import type { PlanManagerDeps } from './PlanManager';
import type { ChatViewProvider } from '../providers/ChatViewProvider';

export type IsolationActionKind = 'reviewDiff' | 'merge' | 'discard' | 'cleanup' | 'resolveConflict';

/**
 * A dirty tree blocked an isolated run. The choice is the host's to offer: the
 * webview has no working modal (`window.confirm` is inert there), and stashing
 * is a change to the user's real tree, so it must be asked for in a modal that
 * names the alternative.
 */
export function handleIsolationBlocked(message: string, deps: PlanManagerDeps): void {
  void vscode.window.showWarningMessage(
    message,
    { modal: true },
    'Stash and continue',
    'Run without isolation',
    'Cancel',
  ).then(async (choice) => {
    try {
      if (choice === 'Stash and continue') await deps.session.continueWithStash();
      else if (choice === 'Run without isolation') await deps.session.continueWithoutIsolation();
    } catch (err) {
      deps.chatProvider.showError(`Could not continue the run: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/** Show the end-of-run handoff card. */
export function handleIsolationHandoff(handoff: IsolationHandoff, deps: PlanManagerDeps): void {
  deps.chatProvider.showIsolationHandoff(handoff);
}

/**
 * Re-tell a webview the plan's isolation from the run record: the stream only
 * reports changes, and a webview's state goes whenever it is disposed or a
 * session is loaded. The handoff card waits for a run in progress to settle,
 * as it would have on the stream.
 */
export function replayIsolation(
  session: Pick<Session, 'isolationView' | 'isExecuting'>,
  chatProvider: Pick<ChatViewProvider, 'sendTaskIsolation' | 'showIsolationHandoff'>,
): void {
  const view = session.isolationView();
  if (!view) return;
  for (const [taskId, isolation] of Object.entries(view.tasks)) chatProvider.sendTaskIsolation(taskId, isolation);
  if (!session.isExecuting) chatProvider.showIsolationHandoff(view.handoff);
}

/**
 * The handoff and conflict actions the webview cannot perform itself: opening a
 * diff, and the irreversible merge or discard. Merge and discard are confirmed
 * here rather than in the webview for the same reason removal is — a sandboxed
 * webview's `confirm()` is inert, and only the host can name what changes.
 */
export async function handleIsolationAction(
  action: IsolationActionKind,
  taskId: string | undefined,
  deps: PlanManagerDeps,
): Promise<void> {
  try {
    switch (action) {
      case 'reviewDiff':
        await openDiff(await deps.session.reviewRunDiff());
        return;
      case 'merge': {
        const confirm = await vscode.window.showWarningMessage(
          'Merge the isolated run into your checked-out branch? This cannot be undone from Ordewell.',
          { modal: true },
          'Merge',
        );
        if (confirm !== 'Merge') return;
        await deps.session.mergeRun();
        break;
      }
      case 'discard': {
        const confirm = await vscode.window.showWarningMessage(
          'Discard the whole run? Its worktrees, task branches and integration branch are removed. Tasks it completed stay completed.',
          { modal: true },
          'Discard',
        );
        if (confirm !== 'Discard') return;
        await deps.session.discardRun();
        deps.chatProvider.clearIsolationHandoff();
        break;
      }
      case 'cleanup':
        await deps.session.cleanupRun();
        break;
      case 'resolveConflict': {
        if (!taskId) return;
        const plan = await deps.session.resolveConflictAsTask(taskId);
        if (plan) {
          deps.setCurrentPlan(plan);
          deps.chatProvider.showPlan(plan);
          deps.persistState();
        }
        return;
      }
    }
    // The Session broadcasts a fresh status_update as the run record changes,
    // but the persisted plan state is the source the dock reads; re-show it so
    // the card reflects the action without waiting for the next tick.
    if (deps.session.planState) deps.setCurrentPlan(deps.session.planState);
    deps.chatProvider.showPlan(deps.getCurrentPlan());
    deps.persistState();
  } catch (err) {
    deps.chatProvider.showError(`Isolation action failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Open the run's unified diff in a read-only editor tab rather than a temp file. */
async function openDiff(diff: string): Promise<void> {
  if (!diff.trim()) {
    void vscode.window.showInformationMessage('The isolated run has no changes against its base ref.');
    return;
  }
  const doc = await vscode.workspace.openTextDocument({ content: diff, language: 'diff' });
  await vscode.window.showTextDocument(doc, { preview: false });
}
