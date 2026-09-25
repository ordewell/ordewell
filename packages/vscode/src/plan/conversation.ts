import * as vscode from 'vscode';
import type { Session } from '@ordewell/core';
import type { ChatViewProvider } from '../providers/ChatViewProvider';

export interface ConversationDeps {
  session: Pick<Session, 'sessionId' | 'isExecuting' | 'planState' | 'forkConversation' | 'rewindTargets' | 'rewindConversation' | 'compactConversation'>;
  chatProvider: Pick<ChatViewProvider, 'showError' | 'replaceConversation' | 'setConversationBusy'>;
  setCurrentPlan: PlanSetter;
  persistState: () => void;
  isGeneratingPlan: () => boolean;
}

type PlanSetter = (plan: NonNullable<Session['planState']>) => void;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * These edit the transcript a planner turn is writing to, so they wait it out.
 * A warning rather than `chatProvider.showError`: the webview treats an error
 * as the end of the turn, which would unlock the input under a live one.
 */
function plannerIsAnswering(deps: ConversationDeps): boolean {
  if (!deps.isGeneratingPlan()) return false;
  void vscode.window.showWarningMessage('The planner is still answering — wait for its reply, or stop it first.');
  return true;
}

/**
 * Loading the fork replaces the Session's plan and stops any run, which the
 * user would otherwise learn about only after the fact — and the run's own
 * session is the one left behind.
 */
async function confirmLeavingRun(session: ConversationDeps['session']): Promise<boolean> {
  if (!session.isExecuting) return true;
  const choice = await vscode.window.showWarningMessage(
    'A run is executing. Switching to the fork stops it; the original session is kept as it is.',
    { modal: true },
    'Fork and stop the run',
  );
  return choice === 'Fork and stop the run';
}

export async function forkConversation(deps: ConversationDeps): Promise<void> {
  if (plannerIsAnswering(deps)) return;
  try {
    if (!(await confirmLeavingRun(deps.session))) return;
    const originalId = deps.session.sessionId;
    const fork = deps.session.forkConversation();
    await vscode.commands.executeCommand('ordewell.loadSessionById', fork.sessionId);
    void vscode.window.showInformationMessage(
      `Forked ${originalId} into ${fork.sessionId} — you are in the fork now, and the original is kept. Use /sessions to go back.`,
    );
  } catch (err) {
    deps.chatProvider.showError(`Could not fork the conversation: ${message(err)}`);
  }
}

/**
 * Both edits leave the tasks alone, so the webview only needs its transcript
 * redrawn — `restoreChat` would also wipe the task output and isolation state
 * of a run that is still going.
 */
function showConversation(plan: NonNullable<Session['planState']>, deps: ConversationDeps): void {
  deps.setCurrentPlan(plan);
  deps.chatProvider.replaceConversation(plan.conversationHistory ?? [], plan.tasks.length > 0);
  deps.persistState();
}

export async function rewindConversation(deps: ConversationDeps, arg?: string): Promise<void> {
  if (plannerIsAnswering(deps)) return;
  if (arg !== undefined && !/^\d+$/.test(arg)) {
    void vscode.window.showWarningMessage('Usage: /rewind [<message>] — or /rewind alone to pick one.');
    return;
  }
  try {
    let index: number;
    if (arg !== undefined) {
      index = Number(arg);
    } else {
      const targets = deps.session.rewindTargets();
      if (targets.length === 0) {
        void vscode.window.showInformationMessage('Nothing to rewind to yet — the only message so far is the goal.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        [...targets].reverse().map((t) => ({ label: `${t.index}  ${t.preview}`, index: t.index })),
        { placeHolder: 'Rewind to before… (the chosen message and everything after it are discarded; the tasks stay as they are)' },
      );
      if (!picked) return;
      index = picked.index;
    }
    showConversation(deps.session.rewindConversation(index), deps);
    void vscode.window.showInformationMessage('Rewound the conversation. The tasks are unchanged; your next message continues from here.');
  } catch (err) {
    deps.chatProvider.showError(`Could not rewind the conversation: ${message(err)}`);
  }
}

/**
 * The summary comes back as the transcript's first entry, so redrawing it is
 * what shows the user what the planner will carry forward. A failed or
 * cancelled turn changes nothing in core, hence nothing to undo here.
 */
export async function compactConversation(deps: ConversationDeps): Promise<void> {
  if (plannerIsAnswering(deps)) return;
  const abort = new AbortController();
  // The webview would let a message through that core refuses mid-compaction.
  deps.chatProvider.setConversationBusy(true);
  try {
    const { keptMessages } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Condensing the conversation…', cancellable: true },
      (_progress, token) => {
        token.onCancellationRequested(() => abort.abort());
        return deps.session.compactConversation(abort.signal);
      },
    );
    const plan = deps.session.planState;
    if (plan) showConversation(plan, deps);
    void vscode.window.showInformationMessage(
      `Condensed the conversation. The last ${keptMessages} messages were kept as they were; the tasks are unchanged.`,
    );
  } catch (err) {
    if (abort.signal.aborted) {
      void vscode.window.showInformationMessage('Condensing cancelled — nothing was changed.');
    } else {
      deps.chatProvider.showError(`Could not condense the conversation: ${message(err)} — nothing was changed.`);
    }
  } finally {
    deps.chatProvider.setConversationBusy(false);
  }
}
