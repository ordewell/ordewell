import { LegacyPlanState, Session, SessionHeldError, describeHeld, saveState, loadState, saveSession, loadSession, isUserMessage } from '@ordewell/core';
import type { ChatViewProvider } from '../providers/ChatViewProvider';

export interface PersistenceDeps {
  session: Session;
  chatProvider: ChatViewProvider;
  getCurrentPlan: () => LegacyPlanState;
  setCurrentPlan: (plan: LegacyPlanState) => void;
  getCurrentGoal: () => string;
  setCurrentGoal: (goal: string) => void;
  workspaceRoot: () => string;
  log: (msg: string) => void;
  /** Said to the user, not only to the output channel. */
  warn: (msg: string) => void;
}

/** Null once the session is written; otherwise why nothing was, for a caller that tells the user. */
export function saveCurrentSession(deps: PersistenceDeps): string | null {
  const plan = deps.getCurrentPlan();
  if (plan.tasks.length === 0) return 'it has no tasks yet.';
  const goal = deps.getCurrentGoal() || plan.tasks[0]?.title || '(untitled)';
  // The Session's own saves check the lease; this one writes the file directly (ADR-0049).
  const held = deps.session.heldElsewhere();
  if (held) {
    deps.log(`Session not saved: ${describeHeld(held)}`);
    return describeHeld(held);
  }
  try {
    const meta = saveSession(plan, goal, deps.workspaceRoot(), deps.session.sessionId);
    deps.log(`Session saved: ${meta.id}: "${goal}" (${meta.taskCount} tasks)`);
    return null;
  } catch (err) {
    deps.log(`Session save error: ${err}`);
    return err instanceof Error ? err.message : String(err);
  }
}

export function restoreState(deps: PersistenceDeps): void {
  deps.log('Attempting to restore state...');
  // Keyed by workspace root, never process.cwd(): the extension host's cwd is
  // shared across windows, so an unkeyed state file leaks one workspace's
  // plan into another on restore.
  const restored = loadState(deps.workspaceRoot());
  // Task settlements save the session before the restore snapshot is next
  // written. After a crash, reopening that older snapshot under the same id
  // would overwrite completed work on the next save.
  const latest = restored?.sessionId ? loadSession(restored.sessionId, deps.workspaceRoot()) : null;
  const saved = latest && restored && Date.parse(latest.meta.updatedAt) >= Date.parse(restored.plan.lastUpdated)
    ? latest.plan
    : restored?.plan;
  const hasDialogue = (saved?.conversationHistory?.length ?? 0) > 0;
  // A planning conversation that hasn't produced tasks yet is still a session
  // worth restoring — otherwise a window reload mid-dialogue loses the chat.
  if (saved && (saved.tasks.length > 0 || hasDialogue)) {
    deps.log(`Restoring saved plan with ${saved.tasks.length} tasks, status: ${saved.status}`);
    const shownBefore = { plan: deps.getCurrentPlan(), goal: deps.getCurrentGoal() };
    deps.setCurrentPlan(saved);

    // The goal is not persisted on the plan; recover it from the dialogue so
    // later turns (session labels, goal display) don't run with an empty goal.
    if (!deps.getCurrentGoal()) {
      const firstUserMessage = saved.conversationHistory?.find(isUserMessage)?.content;
      if (firstUserMessage) deps.setCurrentGoal(firstUserMessage);
    }

    // The plan's own status stays as saved: an older plan's approval is read
    // from it once, as the Session adopts it.
    // Adopt the plan into the Session so its tasks are executable and the
    // conversation can resume when the user sends a message. The saved id keeps
    // later persists in the session file the run was already writing; without
    // it (an older state file) the Session's fresh id would fork a new one, so
    // the restore itself never persists.
    try {
      deps.session.loadPlan(saved, deps.getCurrentGoal(), deps.workspaceRoot(), { sessionId: restored?.sessionId, persist: false });
    } catch (err) {
      // Another host is running it (ADR-0049): this window shows nothing it
      // could neither run nor save, and says who has it.
      if (err instanceof SessionHeldError) {
        deps.setCurrentPlan(shownBefore.plan);
        deps.setCurrentGoal(shownBefore.goal);
        deps.log(`Restored session not opened: ${err.message}`);
        deps.warn(err.message);
        return;
      }
      deps.log(`Restored plan could not be loaded into the session: ${err}`);
    }
    deps.chatProvider.conversation.reload(saved);
    if (saved.tasks.length > 0) {
      deps.chatProvider.setState('planDraft');
      deps.chatProvider.showPlan(saved, 'draft');
    }
    deps.log(`Restored plan with ${saved.tasks.length} tasks, not running (saved as ${saved.status})`);
  } else {
    deps.log('No saved state found');
  }
}

export function persistState(deps: PersistenceDeps): void {
  const plan = deps.getCurrentPlan();
  if (plan.tasks.length === 0 && !(plan.conversationHistory && plan.conversationHistory.length > 0)) return;
  plan.lastUpdated = new Date().toISOString();
  saveState(plan, deps.workspaceRoot(), deps.session.sessionId);
}
