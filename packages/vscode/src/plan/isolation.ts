import * as vscode from 'vscode';
import {
  discardRunConfirmation, type ChatSessionHost, type ConfirmationRequest, type IsolationBlockedChoice, type MergePort,
} from '@ordewell/ui/host';
import { confirm } from './confirm';
import type { PlanManagerDeps } from './PlanManager';

export type IsolationActionKind = 'reviewDiff' | 'merge' | 'discard' | 'cleanup' | 'resolveConflict';

/**
 * A dirty tree blocked an isolated run. The choice is the host's to offer: the
 * webview has no working modal (`window.confirm` is inert there), and stashing
 * is a change to the user's real tree, so it must be asked for in a modal that
 * names the alternative.
 */
export async function handleIsolationBlocked(
  request: ConfirmationRequest<IsolationBlockedChoice>,
  deps: Pick<PlanManagerDeps, 'session' | 'chatProvider'>,
): Promise<void> {
  const choice = await confirm(request);
  try {
    if (choice === 'stash') await deps.session.continueWithStash();
    else if (choice === 'shared_root') await deps.session.continueWithoutIsolation();
  } catch (err) {
    deps.chatProvider.showError(`Could not continue the run: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The extension's side of Merge all (ADR-0020, ADR-0029): the in-process Session
 * as the command seam, and real modals to ask in. What to ask, and in which
 * order, lives in `@ordewell/ui/host`, shared with the desktop.
 */
export function mergePort(deps: Pick<PlanManagerDeps, 'session'>): MergePort {
  return {
    handoff: () => deps.session.isolationView()?.handoff,
    isExecuting: () => deps.session.isExecuting,
    // The user's Merge all, through the command seam as the other controls are.
    mergeCall: () => async (yes) => {
      const merged = await deps.session.execute({ command: 'merge_all', ...yes }, { kind: 'user' });
      switch (merged.payload?.kind) {
        // A merge git stopped is an outcome the handoff card shows, not an error.
        case 'merge': return { kind: 'done' };
        case 'merge_hold': return { kind: 'held', hold: 'pastChecks', message: merged.message };
        case 'merge_beside_ops': return { kind: 'held', hold: 'besideOps', message: merged.message };
      }
      if (!merged.ok) throw new Error(merged.message);
      throw new Error('Merge all answered without its result.');
    },
    ask: confirm,
  };
}

/**
 * The handoff and conflict actions the webview cannot perform itself: opening a
 * diff, and the irreversible merge or discard. Merge and discard are confirmed
 * here rather than in the webview for the same reason removal is — a sandboxed
 * webview's `confirm()` is inert, and only the host can name what changes. The
 * chat is the one Merge all goes through, so what it asks is not this file's.
 */
export async function handleIsolationAction(
  action: IsolationActionKind,
  taskId: string | undefined,
  deps: PlanManagerDeps,
  chat: Pick<ChatSessionHost, 'mergeAll'>,
): Promise<void> {
  try {
    switch (action) {
      case 'reviewDiff':
        await openDiff(await deps.session.reviewRunDiff());
        return;
      case 'merge':
        // Mid-run, Merge all opens the merge gates and the run goes on (ADR-0020).
        if (!(await chat.mergeAll())) return;
        break;
      case 'discard': {
        if (!(await confirm(discardRunConfirmation()))) return;
        await deps.session.discardRun();
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
    // The cards follow the Session's broadcasts through the run view; the
    // plan is re-shown and saved for what the action changed in it, such as a
    // task's status, without waiting for the next tick.
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
