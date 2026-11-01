import * as vscode from 'vscode';
import { checkoutRule, mergeTarget } from '@ordewell/core';
import type { PlanManagerDeps } from './PlanManager';

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
        // Mid-run, Merge all opens the merge gates and the run goes on (ADR-0020).
        const handoff = deps.session.isolationView()?.handoff;
        const target = handoff ? mergeTarget(handoff) : 'the branch you have checked out';
        const rule = handoff ? checkoutRule(handoff) : '';
        const confirm = await vscode.window.showWarningMessage(
          deps.session.isExecuting
            ? `Merge what the run has landed so far into ${target}.${rule} This cannot be undone from Ordewell. The run goes on: tasks waiting for Merge all start once it has merged, and later tasks land on the same branch.`
            : `Merge the isolated run into ${target}.${rule} This cannot be undone from Ordewell. Once it has merged, the run's worktrees and branches are removed unless a task still has work in its worktree that has not landed: then the run stays, and so does that work.`,
          { modal: true },
          'Merge',
        );
        if (confirm !== 'Merge') return;
        // The user's Merge all, through the command seam (ADR-0029) as the
        // other controls are. A merge git stopped is an outcome the handoff
        // card shows, not an error here; a refusal without one is thrown for
        // the catch below.
        let merged = await deps.session.execute({ command: 'merge_all' }, { kind: 'user' });
        // Work whose check has not passed is the seam's to name, and the yes goes with the next call (ADR-0055 D9).
        if (merged.payload?.kind === 'merge_hold') {
          const past = await vscode.window.showWarningMessage(`${merged.message} Merge ${target} anyway?`, { modal: true }, 'Merge anyway');
          if (past !== 'Merge anyway') return;
          merged = await deps.session.execute({ command: 'merge_all', pastChecks: true }, { kind: 'user' });
        }
        if (merged.payload?.kind === 'merge') break;
        if (!merged.ok) throw new Error(merged.message);
        throw new Error('Merge all answered without its result.');
      }
      case 'discard': {
        const confirm = await vscode.window.showWarningMessage(
          'Discard the whole run? Its worktrees, task branches and integration branch are removed. Tasks it completed stay completed.',
          { modal: true },
          'Discard',
        );
        if (confirm !== 'Discard') return;
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
