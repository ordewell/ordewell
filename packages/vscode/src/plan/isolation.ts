import * as vscode from 'vscode';
import { checkoutRule, mergeTarget } from '@ordewell/core';
import {
  discardRunConfirmation, mergeAllConfirmation, mergeBesideOpsQuestion, mergePastChecksQuestion,
  type ConfirmationRequest, type IsolationBlockedChoice,
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
        if (!(await confirm(mergeAllConfirmation(target, rule, deps.session.isExecuting)))) return;
        // The user's Merge all, through the command seam (ADR-0029) as the
        // other controls are. A merge git stopped is an outcome the handoff
        // card shows, not an error here; a refusal without one is thrown for
        // the catch below.
        // Work whose check has not passed (ADR-0055 D9), and ops tasks running
        // in the checkout (ADR-0020), are the seam's to name, one question at a
        // time: each yes goes with the next call, beside the ones before it.
        const yes: { pastChecks?: true; besideOps?: true } = {};
        let merged = await deps.session.execute({ command: 'merge_all' }, { kind: 'user' });
        for (;;) {
          if (merged.payload?.kind === 'merge_hold' && !yes.pastChecks) {
            if (!(await confirm(mergePastChecksQuestion(merged.message, target)))) return;
            yes.pastChecks = true;
          } else if (merged.payload?.kind === 'merge_beside_ops' && !yes.besideOps) {
            if (!(await confirm(mergeBesideOpsQuestion(merged.message, target)))) return;
            yes.besideOps = true;
          } else break;
          merged = await deps.session.execute({ command: 'merge_all', ...yes }, { kind: 'user' });
        }
        if (merged.payload?.kind === 'merge') break;
        if (!merged.ok) throw new Error(merged.message);
        throw new Error('Merge all answered without its result.');
      }
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
