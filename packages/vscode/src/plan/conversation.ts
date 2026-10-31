import * as vscode from 'vscode';
import { CHAT_COMMANDS, describePlannerNotReady, PlannerNotReadyError, PlannerTurnDiscardedError, PlannerTurnStoppedError, type Session } from '@ordewell/core';
import type { ChatViewProvider } from '../providers/ChatViewProvider';
import { recheckSignedOutPlanner, type PlanManagerDeps } from './PlanManager';

export interface ConversationDeps {
  session: Pick<Session, 'sessionId' | 'isExecuting' | 'planState' | 'forkConversation' | 'rewindTargets' | 'rewindConversation' | 'compactConversation'>;
  chatProvider: Pick<ChatViewProvider, 'showError'>;
  setCurrentPlan: PlanSetter;
  persistState: () => void;
  isGeneratingPlan: () => boolean;
  /** For {@link recheckSignedOutPlanner}: a compaction is a planner turn. */
  config: PlanManagerDeps['config'];
  fsAdapter: PlanManagerDeps['fsAdapter'];
  runnerInstallation?: PlanManagerDeps['runnerInstallation'];
  refreshPlannerState?: PlanManagerDeps['refreshPlannerState'];
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
  void vscode.window.showWarningMessage('The planner is still answering: wait for its reply, or stop it first.');
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
    // Its error is already on screen, and the user is still where they were.
    if (await vscode.commands.executeCommand<boolean>('ordewell.loadSessionById', fork.sessionId) === false) return;
    void vscode.window.showInformationMessage(
      `Forked ${originalId} into ${fork.sessionId}: you are in the fork now, and the original is kept. Use /sessions to go back.`,
    );
  } catch (err) {
    deps.chatProvider.showError(`Could not fork the conversation: ${message(err)}`);
  }
}

/**
 * A rewind is a fork from just before the chosen message, so it switches
 * sessions the way `/fork` does — and asks first for the same reason.
 */
export async function rewindConversation(deps: ConversationDeps, arg?: string): Promise<void> {
  if (plannerIsAnswering(deps)) return;
  if (arg !== undefined && !/^\d+$/.test(arg)) {
    void vscode.window.showWarningMessage('Usage: /rewind [<message>]: or /rewind alone to pick one.');
    return;
  }
  try {
    let index: number;
    if (arg !== undefined) {
      index = Number(arg);
    } else {
      const targets = deps.session.rewindTargets();
      if (targets.length === 0) {
        void vscode.window.showInformationMessage('Nothing to rewind to yet: the only message so far is the goal.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        [...targets].reverse().map((t) => ({ label: `${t.index}  ${t.preview}`, index: t.index })),
        { placeHolder: 'Rewind to before… (forks the conversation from just before the chosen message; the original is kept)' },
      );
      if (!picked) return;
      index = picked.index;
    }
    if (!(await confirmLeavingRun(deps.session))) return;
    const originalId = deps.session.sessionId;
    const fork = deps.session.rewindConversation(index);
    if (await vscode.commands.executeCommand<boolean>('ordewell.loadSessionById', fork.sessionId) === false) return;
    void vscode.window.showInformationMessage(
      `Rewound ${originalId} into a fork, ${fork.sessionId}: you are in the fork now, and the original is kept. Use /sessions to go back.`,
    );
  } catch (err) {
    deps.chatProvider.showError(`Could not rewind the conversation: ${message(err)}`);
  }
}

/**
 * The session's own events draw it where it happens (ADR-0017): a status
 * while it runs, which the composer's Stop stops like a turn, and a quiet
 * marker after, the summary there to open. So nothing here redraws or pops up
 * on success, and a stop needs no word either: the marker says it. A failed
 * or stopped turn changes nothing in core, hence nothing to undo here.
 */
export async function compactConversation(deps: ConversationDeps): Promise<void> {
  if (plannerIsAnswering(deps)) return;
  // A compaction is a planner turn too, and the signed-out refusal's login
  // runs outside this host: ask the account again before the gate judges.
  const recheck = recheckSignedOutPlanner(deps);
  try {
    if (recheck) await recheck;
    await deps.session.compactConversation();
    const plan = deps.session.planState;
    if (!plan) return;
    deps.setCurrentPlan(plan);
    deps.persistState();
  } catch (err) {
    if (err instanceof PlannerTurnStoppedError || err instanceof PlannerTurnDiscardedError) return;
    if (err instanceof PlannerNotReadyError) {
      // The refusal ends in its own full stop, and its commands are the core's spelling, not the chat's.
      deps.chatProvider.showError(`Could not condense the conversation: ${describePlannerNotReady(err.reason, CHAT_COMMANDS)} Nothing was changed.`);
    } else {
      deps.chatProvider.showError(`Could not condense the conversation: ${message(err)}: nothing was changed.`);
    }
  }
}
