import * as vscode from 'vscode';
import {
  Session, LegacyPlanState, Task, flattenTasks, RunnerId, DiscoveredModel, enabledRunners,
  saveState, clearState, ModelResolver, RunnerRegistry, isCliProvider, taskStartedNotice,
  createEmptyPlan, markRequestFor, pastGateConfirmation, titledRefs, PlannerTurnDiscardedError, PlannerTurnStoppedError, type INotification, type ITerminalRunner, type TaskRowAction,
} from '@ordewell/core';
import type { TaskDraft, TaskEdit } from '../shared/protocol';
import type { ChatViewProvider } from '../providers/ChatViewProvider';
import { VsCodeConfig } from '../adapters/VsCodeConfig';
import { VsCodeFileSystem } from '../adapters/VsCodeFileSystem';
import { handleIsolationBlocked, handleIsolationHandoff } from './isolation';
import { removalPrompt, taskFromDraft } from './taskEdit';
import { ALREADY_HANDED_OVER } from '../providers/TaskLogPanel';

export interface PlanManagerDeps {
  session: Session;
  chatProvider: ChatViewProvider;
  modelResolver: ModelResolver;
  pluginRegistry: RunnerRegistry;
  config: VsCodeConfig;
  fsAdapter: VsCodeFileSystem;
  terminalRunner: ITerminalRunner;
  notifications: INotification;
  settingsService: { getTdd(): boolean; };
  getCurrentPlan: () => LegacyPlanState;
  setCurrentPlan: (plan: LegacyPlanState) => void;
  getCurrentGoal: () => string;
  setCurrentGoal: (goal: string) => void;
  /** Whether a planner turn holds the session — read off the session, never tracked here. */
  isGeneratingPlan: () => boolean;
  persistState: () => void;
  saveCurrentSession: () => void;
  log: (msg: string) => void;
}

export function findTask(plan: LegacyPlanState, id: string): Task | undefined {
  return flattenTasks(plan.tasks).find((t) => t.id === id);
}

export async function discoverModelsForPlan(deps: PlanManagerDeps): Promise<Partial<Record<RunnerId, DiscoveredModel[]>>> {
  return deps.modelResolver.modelsForRunners(enabledRunners(deps.config));
}

export function resolveRunnerSet(
  deps: PlanManagerDeps,
  pendingRunners?: RunnerId[],
  currentPlanRunners?: RunnerId[],
): RunnerId[] | null {
  const enabled = enabledRunners(deps.config).filter((r) => deps.pluginRegistry.get(r));
  if (enabled.length === 0) {
    deps.chatProvider.showError('No runner is enabled. Toggle runners in the chat header first.');
    return null;
  }
  if (pendingRunners && pendingRunners.length > 0) {
    const valid = pendingRunners.filter((r) => enabled.includes(r));
    if (valid.length > 0) return valid;
  }
  // Fall back to the current plan's runners (e.g. regeneration) rather than
  // expanding to ALL enabled runners — the user's prior selection should
  // persist, not be silently widened to include a runner they toggled off.
  if (currentPlanRunners && currentPlanRunners.length > 0) {
    const valid = currentPlanRunners.filter((r) => enabled.includes(r));
    if (valid.length > 0) return valid;
  }
  return enabled;
}

export function finishPlannerTurn(
  plan: LegacyPlanState,
  deps: PlanManagerDeps,
  opts?: { planChanged?: boolean },
): void {
  const planChanged = opts?.planChanged ?? true;
  if (plan.tasks.length > 0) {
    if (planChanged) {
      deps.chatProvider.planGenerated(plan);
    }
  } else {
    deps.chatProvider.setState('planDraft');
  }
  saveState(plan, deps.fsAdapter.getWorkspaceRoot());
  deps.saveCurrentSession();
}

export function reportPlannerError(err: unknown, deps: PlanManagerDeps): void {
  // Message text is not evidence: a real failure can mention "aborted" (a
  // runner's "transaction aborted"). Core converts a stop, whatever the backend
  // named its error, to PlannerTurnStoppedError; only that and a platform
  // AbortError count.
  const isAbort = err instanceof PlannerTurnDiscardedError || err instanceof PlannerTurnStoppedError || (err instanceof Error && err.name === 'AbortError');
  // The stop already ended the turn on screen; a discarded turn belonged to a
  // session the user has already left.
  if (isAbort) return;
  const message = err instanceof Error ? err.message : String(err);
  deps.chatProvider.showError(`Planner failed: ${message}`);
}

/**
 * What the selected planner still needs before it can plan, or null when it is
 * ready. There are two ways in (ADR-0009), and only one of them involves a
 * credential: a harness planner drives a coding agent already installed on the
 * machine, authenticated by the user's own subscription, so demanding an API
 * key of it turns a working setup into a wall — the exact failure reported when
 * Claude Code was the selected planner. Its model is optional too: an unset id
 * means "the agent's own default" (`CliAgentAiService.plannerModel`), which is
 * what `applyPlanner` deliberately leaves behind when it clears a model id the
 * new backend cannot serve.
 */
export function plannerPreflightError(config: PlanManagerDeps['config']): string | null {
  if (isCliProvider(config.aiProvider)) return null;
  if (!config.apiKey) {
    return 'API key not configured. Run "Ordewell: Configure API Key" to set it.';
  }
  if (!config.planningModel) {
    return 'No orchestrator model selected. Type /model set to pick one first.';
  }
  return null;
}

/** Reports the preflight failure to the chat and returns false when not ready. */
function plannerReady(deps: PlanManagerDeps): boolean {
  const error = plannerPreflightError(deps.config);
  if (!error) return true;
  deps.chatProvider.showError(error);
  return false;
}

/** The session owns the turn — its busy state and its stop; a failure is all that is left to report. */
async function inPlannerTurn(deps: PlanManagerDeps, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    reportPlannerError(err, deps);
  }
}

/**
 * Settle a plan a planner turn handed back: it becomes the host's plan, and
 * the webview is re-shown it only when its tasks changed.
 */
function adoptTurnPlan(prior: string, plan: LegacyPlanState, deps: PlanManagerDeps): void {
  deps.setCurrentPlan(plan);
  finishPlannerTurn(plan, deps, { planChanged: JSON.stringify(plan.tasks) !== prior });
}

export async function handleStartPlanning(
  userDescription: string,
  deps: PlanManagerDeps,
  pendingRunners?: RunnerId[],
): Promise<void> {
  if (!plannerReady(deps)) return;
  const runners = resolveRunnerSet(deps, pendingRunners, deps.getCurrentPlan().runners);
  if (!runners) {
    return;
  }
  await inPlannerTurn(deps, async () => {
    const plan = await deps.session.startPlanning(userDescription, runners);
    deps.setCurrentGoal(userDescription);
    deps.setCurrentPlan(plan);
    finishPlannerTurn(plan, deps);
  });
}

export async function handleContinueConversation(
  text: string,
  deps: PlanManagerDeps,
): Promise<void> {
  await inPlannerTurn(deps, async () => {
    const prior = JSON.stringify(deps.getCurrentPlan().tasks);
    adoptTurnPlan(prior, await deps.session.continueConversation(text), deps);
  });
}

/**
 * Planner-driven merge (issue #18): route a merge request through the planner
 * conversation loop so the LLM produces the combined task, validated atomically
 * via applyTaskOps with corrective retries — not a mechanical client-side stub.
 * A pre-flight compatibility failure (canMergeTasks) throws before any LLM call.
 */
export async function handleMergePlan(taskIds: string[], deps: PlanManagerDeps): Promise<void> {
  if (taskIds.length < 2) return;
  await inPlannerTurn(deps, async () => {
    const prior = JSON.stringify(deps.getCurrentPlan().tasks);
    adoptTurnPlan(prior, await deps.session.requestMerge(taskIds), deps);
  });
}

/**
 * Planner-driven split (issue #18): ask the planner LLM to decompose one task
 * into a sequence of smaller tasks. Same conversation-loop / repair path as
 * merge; the model generates the breakdown (no manual per-task specs).
 */
export async function handleSplitPlan(taskId: string, deps: PlanManagerDeps): Promise<void> {
  await inPlannerTurn(deps, async () => {
    const prior = JSON.stringify(deps.getCurrentPlan().tasks);
    adoptTurnPlan(prior, await deps.session.requestSplit(taskId), deps);
  });
}

function approvedTasks(tasks: Task[]): Task[] {
  return tasks.map((t) => ({
    ...t,
    status: t.status === 'completed' ? t.status : 'approved',
    subtasks: approvedTasks(t.subtasks ?? []),
  }));
}

export async function handleApprovePlan(deps: PlanManagerDeps): Promise<void> {
  deps.log('=== handleApprovePlan START ===');
  if (deps.session.isExecuting) {
    deps.log('Stopping existing orchestrator run before approving new plan');
    deps.session.stopExecution();
    deps.terminalRunner.stopAll();
  }
  const plan = deps.getCurrentPlan();
  plan.status = 'approved';
  saveState(plan, deps.fsAdapter.getWorkspaceRoot());
  // New task objects, not edits in place: the plan's tasks are the Session's
  // snapshot of its store, and the plan object itself must stay the same one
  // so `loadPlan` keeps the live planner conversation.
  plan.tasks = approvedTasks(plan.tasks);
  deps.session.loadPlan(plan, deps.getCurrentGoal(), deps.fsAdapter.getWorkspaceRoot());
  deps.chatProvider.planApproved();
  deps.chatProvider.clearIsolationHandoff();
  saveState(plan, deps.fsAdapter.getWorkspaceRoot());
  deps.saveCurrentSession();
  try {
    deps.log('Calling session.executePlan()...');
    await deps.session.executePlan();
    deps.log(`executePlan() returned. isRunning=${deps.session.isExecuting}, status=${deps.session.status}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log(`Orchestrator start failed: ${msg}`);
    vscode.window.showErrorMessage(`Failed to start execution: ${msg}`);
  }
  deps.log('=== handleApprovePlan END ===');
}

/**
 * A restored plan can exist on the host before the Session has adopted it
 * (legacy globalState, defensive paths). Adopt it so the conversational loop
 * has plan state to work with — without forking a new session file.
 */
function ensureSessionPlan(deps: PlanManagerDeps): void {
  if (deps.session.planState) return;
  const plan = deps.getCurrentPlan();
  if (plan.tasks.length === 0 && !(plan.conversationHistory && plan.conversationHistory.length > 0)) return;
  try {
    deps.session.loadPlan(plan, deps.getCurrentGoal(), deps.fsAdapter.getWorkspaceRoot(), { persist: false });
  } catch (err) {
    deps.log(`ensureSessionPlan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleSendMessage(
  text: string,
  deps: PlanManagerDeps,
  pendingRunners: RunnerId[] | undefined,
  setPendingRunners: (r: RunnerId[] | undefined) => void,
): Promise<void> {
  if (!plannerReady(deps)) return;

  setPendingRunners(pendingRunners);

  const plan = deps.getCurrentPlan();
  const hasDialogue = (plan.conversationHistory?.length ?? 0) > 0;

  // Unified loop (post-plan chat included): the model decides per turn whether
  // to reply, emit targeted task edits, or re-plan. While a runner is live the
  // Session answers questions live and queues structural edits for the next
  // batch boundary. handleStartPlanning remains only for a truly fresh session.
  if (deps.session.isExecuting || plan.tasks.length > 0 || hasDialogue || deps.session.isConversationActive) {
    ensureSessionPlan(deps);
    await handleContinueConversation(text, deps);
    // Only a live runner can queue an edit — an armed-but-idle scheduler applies
    // it, so the strip would announce a queue that never forms.
    if (deps.session.isExecuting) deps.chatProvider.showPendingPlanEdits(deps.session.getQueuedMessages());
  } else {
    await handleStartPlanning(text, deps, pendingRunners);
  }
}

/** The Session's plan becomes the host's, and the webview is shown it. */
function showSessionPlan(deps: PlanManagerDeps): void {
  if (deps.session.planState) deps.setCurrentPlan(deps.session.planState);
  deps.chatProvider.showPlan(deps.getCurrentPlan());
}

function settleDirectEdit(deps: PlanManagerDeps): void {
  showSessionPlan(deps);
  deps.persistState();
  deps.saveCurrentSession();
}

function applyTaskEdit(session: Session, taskId: string, edit: TaskEdit): Promise<unknown> {
  switch (edit.kind) {
    // A runner change re-derives the task's model, effort and mode from the
    // new runner's catalog, which only the session can read.
    case 'runner': return session.setTaskRunner(taskId, edit.runner);
    case 'model': return session.updateTask(taskId, { assignedModel: edit.assignment });
    case 'mode': return session.updateTask(taskId, { taskMode: edit.mode });
    case 'prompt': return session.updateTask(taskId, { prompt: edit.prompt, description: edit.prompt || undefined });
    case 'dependencies': return session.setTaskDependencies(taskId, edit.dependencies);
    case 'ops': return session.updateTask(taskId, { ops: edit.ops });
  }
}

/**
 * A field edit from a task card, through the Session like every other edit
 * so it is validated, broadcast and scheduled for. The plan is re-shown
 * either way: the card must end up showing what was accepted, not what was
 * attempted.
 */
export async function handleTaskEdit(taskId: string, edit: TaskEdit, deps: PlanManagerDeps): Promise<void> {
  try {
    await applyTaskEdit(deps.session, taskId, edit);
  } catch (err) {
    void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
  }
  settleDirectEdit(deps);
}

export async function handleAddTask(draft: TaskDraft, deps: PlanManagerDeps): Promise<void> {
  const task = taskFromDraft(draft);
  if (!task) return;
  await deps.session.addTask(task);
  settleDirectEdit(deps);
}

export async function handleRemoveTask(taskId: string, deps: PlanManagerDeps): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(removalPrompt(deps.session.planTasks, taskId), { modal: true }, 'Remove');
  if (confirm !== 'Remove') return;
  await deps.session.removeTask(taskId);
  if (deps.session.planTasks.length > 0) {
    settleDirectEdit(deps);
    return;
  }
  if (deps.session.planState) deps.setCurrentPlan(deps.session.planState);
  deps.chatProvider.setState('empty');
  clearState(deps.fsAdapter.getWorkspaceRoot());
  deps.persistState();
}

/** A rejection resumes the paused agent with the reason, rather than cancelling the task. */
export function handleCheckpointAnswer(taskId: string, approved: boolean, reason: string | undefined, deps: PlanManagerDeps): void {
  if (approved) deps.session.approveCheckpoint(taskId);
  else deps.session.rejectCheckpoint(taskId, reason ?? '');
}

/**
 * Talking to a structured task (ADR-0018, M1). A refusal — a terminal task, or
 * one not running — is the Session's answer, shown rather than swallowed.
 */
export async function handleTaskControl(
  control:
    | { kind: 'message' | 'messageNow'; text: string }
    | { kind: 'removeQueued' | 'queuedNow'; id: string }
    | { kind: 'interrupt' },
  taskId: string,
  deps: Pick<PlanManagerDeps, 'session'>,
): Promise<void> {
  try {
    if (control.kind === 'message') deps.session.sendTaskMessage(taskId, control.text);
    else if (control.kind === 'messageNow') deps.session.forceSendTaskMessage(taskId, control.text);
    else if (control.kind === 'removeQueued') deps.session.removeQueuedTaskMessage(taskId, control.id);
    else if (control.kind === 'queuedNow') {
      if (!deps.session.forceSendQueuedTaskMessage(taskId, control.id)) throw new Error(ALREADY_HANDED_OVER);
    } else await deps.session.interruptTask(taskId);
  } catch (err) {
    void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Stop aborts the current planner turn only — never the plan, the dialogue or
 * the persisted state; that is a new session. The session stays busy until the
 * turn has unwound, so a prompt sent meanwhile is held, not raced against it.
 */
export function handleStopPlanning(deps: PlanManagerDeps): void {
  deps.session.abortPlannerTurn();
  deps.session.aiServiceInstance.reset();
  deps.chatProvider.conversation.stop();
  deps.log('Research stopped');
}

/**
 * Everything of the old session goes: the planner turn, the runners, the
 * Session's own plan and conversation (a partial reset leaves the old tasks
 * in its PlanStore, and the planner presents them as the current plan), the
 * view and the saved state.
 */
export function handleNewSession(deps: Pick<PlanManagerDeps,
  'session' | 'chatProvider' | 'terminalRunner' | 'fsAdapter' | 'setCurrentPlan' | 'setCurrentGoal' | 'log'>): void {
  // Abandons the planner turn in flight: it settles as discarded, which is
  // not reported into the new session.
  deps.session.reset();
  deps.terminalRunner.stopAll();
  deps.setCurrentPlan(createEmptyPlan());
  deps.setCurrentGoal('');
  deps.chatProvider.setState('empty');
  deps.chatProvider.conversation.reset();
  clearState(deps.fsAdapter.getWorkspaceRoot());
  deps.log('New session started');
}

/**
 * A force start or a single-task run passes a merge gate (ADR-0020) once the
 * user has seen, in a real modal, which work the task would act without. True
 * when nothing gates the task or the user went ahead.
 */
export async function confirmPastGate(taskId: string, session: Pick<Session, 'mergeGate' | 'planState'>): Promise<boolean> {
  const unmerged = session.mergeGate(taskId);
  if (unmerged.length === 0) return true;
  const choice = await vscode.window.showWarningMessage(
    pastGateConfirmation(titledRefs(unmerged, session.planState?.tasks ?? [])),
    { modal: true },
    'Start anyway',
  );
  return choice === 'Start anyway';
}

/** The webview's names for the task row actions that end in a mark. */
const ROW_ACTION: Record<string, TaskRowAction> = { skip: 'skip', markComplete: 'complete', markIncomplete: 'uncomplete' };

export async function handleSystemCommand(
  command: string,
  taskId: string,
  deps: PlanManagerDeps,
): Promise<void> {
  switch (command) {
    case 'cancel':
      await deps.session.cancelTask(taskId);
      break;
    case 'retry':
      await deps.session.retryTask(taskId);
      break;
    case 'skip':
    case 'markComplete':
    case 'markIncomplete':
      await (markRequestFor(ROW_ACTION[command]) === 'uncomplete'
        ? deps.session.markTaskIncomplete(taskId)
        : deps.session.markTaskComplete(taskId));
      break;
    case 'forceStart':
      if (!(await confirmPastGate(taskId, deps.session))) return;
      deps.chatProvider.clearIsolationHandoff();
      await deps.session.forceStartTask(taskId);
      break;
    case 'runTask':
      if (!(await confirmPastGate(taskId, deps.session))) return;
      deps.chatProvider.clearIsolationHandoff();
      await deps.session.runTask(taskId);
      break;
    case 'executePlan':
      await handleApprovePlan(deps);
      break;
    case 'stopExecution':
      deps.session.stopExecution();
      deps.terminalRunner.stopAll();
      deps.chatProvider.setState('planDraft');
      break;
  }
  deps.chatProvider.showPlan(deps.getCurrentPlan());
  deps.persistState();
}

export function handleSessionMessage(
  msg: import('@ordewell/core').SessionMessage,
  deps: PlanManagerDeps,
): void {
  deps.chatProvider.conversation.receive(msg);
  if (msg.type === 'approval_request') {
    // The chat card is the question now, so make sure the user is looking at
    // it. Nothing blocks here: the session's research loop awaits the answer on
    // the broadcast seam, and the webview answers through `resolveApproval`.
    deps.chatProvider.reveal();
    return;
  }
  switch (msg.type) {
    case 'checkpoint':
      deps.chatProvider.showCheckpoint(msg.taskId, msg.taskTitle, msg.summary);
      break;
    // Runner chatter was dropped here entirely, so a task that failed mid-run
    // showed a red card and nothing else. The webview keeps only the tail.
    case 'task_output':
      deps.chatProvider.sendTaskOutput(msg.taskId, msg.text);
      break;
    case 'task_started':
      deps.chatProvider.conversation.note('system', taskStartedNotice(msg.title, msg.runner));
      break;
    case 'status_update': {
      const plan = deps.getCurrentPlan();
      plan.status = deps.session.isExecuting
        ? 'running'
        : deps.session.status === 'completed'
          ? 'completed'
          : 'draft';
      const gates: Record<string, string[]> = {};
      for (const task of msg.tasks) {
        deps.chatProvider.sendTaskIdle(task.id, task.idleSince ?? null);
        deps.chatProvider.sendTaskApprovals(task.id, task.awaitingApproval ?? 0);
        // A shared-root plan sends none; only a task with isolated work reports
        // it, so the cards stay quiet unless isolation has something to say.
        if (task.isolation) deps.chatProvider.sendTaskIsolation(task.id, task.isolation);
        if (task.mergeGate) gates[task.id] = task.mergeGate;
      }
      deps.chatProvider.showMergeGate(msg.gate ?? null, gates);
      deps.chatProvider.showPlan(plan);
      break;
    }
    // The Session applies a run's queued edits itself and announces the plan
    // they made, which carries what is still queued; the strip follows it, so
    // an applied edit stops showing as waiting.
    case 'plan_generated':
      deps.chatProvider.showPendingPlanEdits(msg.plan.queuedMessages ?? []);
      break;
    case 'execution_complete': {
      const plan = deps.getCurrentPlan();
      deps.chatProvider.showPlan(plan);
      deps.persistState();
      break;
    }
    case 'execution_stopped': {
      const plan = deps.getCurrentPlan();
      plan.status = 'draft';
      deps.chatProvider.showPlan(plan);
      deps.persistState();
      break;
    }
    case 'review_needed': {
      const plan = deps.getCurrentPlan();
      deps.chatProvider.showPlan(plan);
      break;
    }
    // A dirty tree parked the run. The user's way out is a real modal: stash
    // and continue, run in the shared root this once, or cancel.
    case 'isolation_blocked':
      handleIsolationBlocked(msg.message, deps);
      break;
    // An isolated run settled: the branch its work landed on and what landed.
    // Sent before `execution_complete`; the webview shows the handoff card.
    case 'isolation_handoff':
      handleIsolationHandoff({ repos: msg.repos, landed: msg.landed }, deps);
      break;
    // Drawn by the conversation view above, or not by this surface at all.
    // Named so a new SessionMessage variant fails to compile until someone
    // decides what it means here.
    case 'planner_message':
    case 'plan_token':
    case 'planner_text_delta':
    case 'planner_thinking_delta':
    case 'planner_liveness':
    case 'research_step':
    case 'research_step_done':
    case 'review_approved':
    case 'task_updated':
    case 'planner_turn_started':
    case 'planner_skill_loaded':
    case 'planner_turn_ended':
    case 'planner_text_retracted':
    case 'planner_usage':
    case 'subagent_started':
    case 'subagent_finished':
    case 'approval_settled':
    case 'approval_decided':
    case 'task_log':
      break;
    // What Merge all did, whether this host asked for it or another surface did.
    // The webview shows a blocked or part-landed group per repo; core's notices
    // already told the user in prose. A full merge is the end of the run: core
    // has cleared it up, so there is no card left to show.
    case 'isolation_merge':
      // A run merged at a gate goes on (ADR-0020): its record, and the marks
      // the next status update re-sends, stay.
      if (msg.result.outcome !== 'merged') deps.chatProvider.showIsolationMergeResult(msg.result);
      else if (!deps.session.isolationView()) deps.chatProvider.clearIsolationHandoff();
      break;
    default: {
      const exhaustive: never = msg;
      return exhaustive;
    }
  }
}
