import { LegacyPlanState, Session, saveState, loadState, saveSession, flattenTasks } from '@ordewell/core';
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
}

export function saveCurrentSession(deps: PersistenceDeps): void {
  const plan = deps.getCurrentPlan();
  if (plan.tasks.length === 0) return;
  const goal = deps.getCurrentGoal() || plan.tasks[0]?.title || '(untitled)';
  try {
    const meta = saveSession(plan, goal, deps.workspaceRoot(), deps.session.sessionId);
    deps.log(`Session saved: ${meta.id} — "${goal}" (${meta.taskCount} tasks)`);
  } catch (err) {
    deps.log(`Session save error: ${err}`);
  }
}

export function restoreState(deps: PersistenceDeps): void {
  deps.log('Attempting to restore state...');
  // Keyed by workspace root, never process.cwd(): the extension host's cwd is
  // shared across windows, so an unkeyed state file leaks one workspace's
  // plan into another on restore.
  const saved = loadState(deps.workspaceRoot());
  const hasDialogue = (saved?.conversationHistory?.length ?? 0) > 0;
  // A planning conversation that hasn't produced tasks yet is still a session
  // worth restoring — otherwise a window reload mid-dialogue loses the chat.
  if (saved && (saved.tasks.length > 0 || hasDialogue || (saved.queuedMessages && saved.queuedMessages.length > 0))) {
    deps.log(`Restoring saved plan with ${saved.tasks.length} tasks, status: ${saved.status}`);
    deps.setCurrentPlan(saved);

    // The goal is not persisted on the plan; recover it from the dialogue so
    // later turns (session labels, goal display) don't run with an empty goal.
    if (!deps.getCurrentGoal()) {
      const firstUserMessage = saved.conversationHistory?.find((m) => m.role === 'user')?.content;
      if (firstUserMessage) deps.setCurrentGoal(firstUserMessage);
    }

    if (saved.status === 'running' || saved.status === 'approved') {
      for (const task of flattenTasks(saved.tasks)) {
        if (task.status === 'in_progress') { task.status = 'pending'; }
      }
      saved.status = 'draft';
    }
    // Adopt the plan into the Session so its tasks are executable and the
    // conversation can resume. persist:false — globalState has no session id,
    // so persisting here would fork a new session file on every reload.
    try {
      deps.session.loadPlan(saved, deps.getCurrentGoal(), deps.workspaceRoot(), { persist: false });
    } catch (err) {
      deps.log(`Restored plan could not be loaded into the session: ${err}`);
    }

    // After loadPlan — adopting a plan clears any queued messages, so the
    // saved queue must be re-applied on top of the adopted plan.
    if (saved.queuedMessages && saved.queuedMessages.length > 0) {
      deps.session.setQueuedMessages(saved.queuedMessages);
    }
    if (saved.tasks.length > 0) {
      deps.chatProvider.setState('planDraft');
      deps.chatProvider.showPlan(saved);
    }
    deps.log(`Restored plan with ${saved.tasks.length} tasks in draft state (was ${saved.status})`);
  } else {
    deps.log('No saved state found');
  }
}

export function persistState(deps: PersistenceDeps): void {
  const plan = deps.getCurrentPlan();
  if (plan.tasks.length === 0 && !(plan.conversationHistory && plan.conversationHistory.length > 0) && !(plan.queuedMessages && plan.queuedMessages.length > 0)) return;
  plan.lastUpdated = new Date().toISOString();
  plan.queuedMessages = deps.session.getQueuedMessages();
  if (deps.session.isExecuting) plan.status = 'running';
  else if (deps.session.status === 'completed') plan.status = 'completed';
  saveState(plan, deps.workspaceRoot());
}
