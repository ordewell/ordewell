import * as vscode from 'vscode';
import { latestTaskCommands } from '../shared/taskCommands';
import {
  Session, LegacyPlanState, Task, flattenTasks, RunnerId, DiscoveredModel, enabledRunners,
  saveState, clearState, ModelResolver, RunnerRegistry, plannerNotReadyFor, describePlannerNotReady, CHAT_COMMANDS, taskStartedNotice,
  createEmptyPlan, installedPlannerAnswered, isRunnerApproval, loopRemovalRefusal, pastGateConfirmation, titledRefs, PlannerNotReadyError, PlannerTurnDiscardedError, PlannerTurnStoppedError, type INotification, type IRunner,
  taskActionCommand, revertEffect, revertListLine, runHoldsEditors, cardEditNeedsUnstarted, confirmedOverride, manualOverrideConfirmation, manualOverrideStopFirst, overrideNeedsConfirmation, titledTaskRefOf, type ExecutionCommand, type OverrideDirection, type TaskAction, type TaskEditOptions,
  recordedRunnerAuth, runnerForProvider, type RunnerInstallation,
} from '@ordewell/core';
import type { TaskDraft, TaskEdit, WebviewToHost } from '../shared/protocol';
import type { ChatViewProvider } from '../providers/ChatViewProvider';
import { VsCodeConfig } from '../adapters/VsCodeConfig';
import { VsCodeFileSystem } from '../adapters/VsCodeFileSystem';
import { handleIsolationBlocked } from './isolation';
import { removalPrompt, taskFromDraft } from './taskEdit';

export interface PlanManagerDeps {
  session: Session;
  chatProvider: ChatViewProvider;
  modelResolver: ModelResolver;
  runnerRegistry: RunnerRegistry;
  config: VsCodeConfig;
  fsAdapter: VsCodeFileSystem;
  runner: IRunner;
  /**
   * The host's login probe, asked again before a turn whose recorded verdict
   * says signed out: the refusal offers the runner's own login as a way back,
   * and that happens outside this process.
   */
  runnerInstallation?: Pick<RunnerInstallation, 'refresh' | 'plannerUsability'>;
  notifications: INotification;
  getCurrentPlan: () => LegacyPlanState;
  setCurrentPlan: (plan: LegacyPlanState) => void;
  getCurrentGoal: () => string;
  setCurrentGoal: (goal: string) => void;
  /** Whether a planner turn holds the session — read off the session, never tracked here. */
  isGeneratingPlan: () => boolean;
  persistState: () => void;
  /** Null once written; otherwise why nothing was. */
  saveCurrentSession: () => string | null;
  /** Push this window's run settings after its session is restored, loaded or replaced (ADR-0030). */
  sendRunSettings: () => void;
  /** Redraw the planner list after a re-probe changed the verdict, so the pill stops saying signed out. */
  refreshPlannerState?: () => Promise<void>;
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
  const enabled = enabledRunners(deps.config).filter((r) => deps.runnerRegistry.get(r));
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
      deps.chatProvider.showPlan(plan);
    }
  } else {
    deps.chatProvider.setState('planDraft');
  }
  saveState(plan, deps.fsAdapter.getWorkspaceRoot(), deps.session.sessionId);
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
  // The session refuses a turn on a planner that cannot plan; the chat says
  // so with its own commands, and as the way out rather than a failure.
  if (err instanceof PlannerNotReadyError) {
    deps.chatProvider.showError(describePlannerNotReady(err.reason, CHAT_COMMANDS));
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  deps.chatProvider.showError(`Planner failed: ${message}`);
}

/**
 * The rule the session's own planner gate applies to every turn (a harness
 * planner needs no key, ADR-0009), worded with the chat's own commands. Read
 * per provider, as the vendor transport reads its key: a fallback to another
 * vendor's key passed here only for the transport to refuse the turn. The
 * signed-out verdict is this workspace's own (ADR-0016): one daemon serves
 * several workspaces, whose accounts differ.
 */
export function plannerPreflightError(config: PlanManagerDeps['config'], workspace: string): string | null {
  const reason = plannerNotReadyFor(config, (runner) => recordedRunnerAuth(runner, workspace));
  return reason ? describePlannerNotReady(reason, CHAT_COMMANDS) : null;
}

/**
 * Ask this workspace's account again when the last verdict was signed out. The
 * gate is synchronous and the refusal itself offers the runner's own login as
 * a way back, which runs in another process; without this the user who took
 * that route stays refused until a runner-list refresh.
 */
export function recheckSignedOutPlanner(
  deps: Pick<PlanManagerDeps, 'config' | 'fsAdapter' | 'runnerInstallation' | 'refreshPlannerState'>,
): Promise<void> | null {
  const installation = deps.runnerInstallation;
  if (!installation) return null;
  const runner = runnerForProvider(deps.config.aiProvider);
  const root = deps.fsAdapter.getWorkspaceRoot();
  if (!runner || recordedRunnerAuth(runner, root)?.state !== 'signed-out') return null;
  installation.refresh();
  return installation.plannerUsability(runner).then(async () => {
    // The gate re-probed so the turn can go ahead; the pill and empty state
    // must stop saying signed out too, or they offer a login already done.
    if (recordedRunnerAuth(runner, root)?.state !== 'signed-out') await deps.refreshPlannerState?.();
  });
}

/**
 * The session owns the turn — its busy state, its stop, and its planner gate,
 * which waits for the activation probe and judges readiness (ADR-0009); a
 * failure is all that is left to report. Nothing waits here: a wait the
 * session could not see read as idle, and a prompt typed during it started
 * over as a new goal.
 */
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
  const runners = resolveRunnerSet(deps, pendingRunners, deps.getCurrentPlan().runners);
  if (!runners) {
    return;
  }
  // Until the installed agents are detected, the enabled default is a guess:
  // with no pick of the user's, the session reads the enabled runners itself
  // once its planner gate opens, rather than plan for an agent not installed.
  const requested = !pendingRunners?.length && !installedPlannerAnswered() ? undefined : runners;
  // A login done with the runner's own command is seen before the gate judges.
  const recheck = recheckSignedOutPlanner(deps);
  if (recheck) await recheck;
  // A goal still waiting for the probe is replaced by this one in the session.
  await inPlannerTurn(deps, async () => {
    const plan = await deps.session.startPlanning(userDescription, requested);
    deps.setCurrentGoal(userDescription);
    deps.setCurrentPlan(plan);
    finishPlannerTurn(plan, deps);
    // A plan makes this window's session the one its Run block speaks for.
    deps.sendRunSettings();
  });
}

export async function handleContinueConversation(
  text: string,
  deps: PlanManagerDeps,
): Promise<void> {
  // A reply is a planner turn too, and the signed-out refusal's way back runs
  // in another process: ask again before the session's gate judges.
  const recheck = recheckSignedOutPlanner(deps);
  if (recheck) await recheck;
  await inPlannerTurn(deps, async () => {
    const prior = JSON.stringify(deps.getCurrentPlan().tasks);
    adoptTurnPlan(prior, await deps.session.continueConversation(text), deps);
  });
}

/**
 * Send now in the planner chat (ADR-0023, F5): the Session stops the turn in
 * flight and answers `text` in the turn that replaces it. The run's tasks are
 * untouched, and the host's held prompts are not given back — they drain in
 * order once the forced turn ends.
 */
export async function handleSendMessageNow(
  text: string,
  deps: PlanManagerDeps,
): Promise<void> {
  const recheck = recheckSignedOutPlanner(deps);
  if (recheck) await recheck;
  await inPlannerTurn(deps, async () => {
    const prior = JSON.stringify(deps.getCurrentPlan().tasks);
    adoptTurnPlan(prior, await deps.session.forceSendPrompt(text), deps);
  });
}

/**
 * One execution button's command, run as the user through the command seam
 * (ADR-0029), so it is checked and kept in the timeline with who asked. A
 * refusal is thrown, so the caller's existing catch shows it.
 */
export async function executeUserCommand(session: Pick<Session, 'execute'>, command: ExecutionCommand): Promise<void> {
  const outcome = await session.execute(command, { kind: 'user' });
  if (!outcome.ok) throw new Error(outcome.message);
}

export async function handleApprovePlan(deps: PlanManagerDeps, requestId?: number): Promise<void> {
  deps.log('=== handleApprovePlan START ===');
  // The session this Execute was asked of: a load or a new session meanwhile
  // must not make its late answer speak for the one now on screen.
  const session = deps.session;
  try {
    // A run under way keeps going: Execute then approves what waits for approval, and the session says how many (#95).
    if (session.isExecuting) {
      try {
        await executeUserCommand(session, { command: 'run_plan' });
      } catch (err) {
        vscode.window.showErrorMessage(`Could not approve the waiting tasks: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    const plan = deps.getCurrentPlan();
    // The run_plan below is the approval, and the Session records it and readies
    // the tasks; rewriting their statuses here would approve a manual task the
    // run has not reached. Only a plan the Session does not hold yet is loaded.
    if (!session.planState) {
      session.loadPlan(plan, deps.getCurrentGoal(), deps.fsAdapter.getWorkspaceRoot());
      // Adopting the plan also moves the Run block off the bare welcome's file values.
      deps.sendRunSettings();
    }
    deps.chatProvider.planApproved();
    saveState(plan, deps.fsAdapter.getWorkspaceRoot(), session.sessionId);
    deps.saveCurrentSession();
    try {
      deps.log('Running the plan through the command seam...');
      await executeUserCommand(session, { command: 'run_plan' });
      // Cleared only once the seam accepts it: a refused Execute replaced no run,
      // and the Session still holds every mark and the handoff.
      deps.chatProvider.clearIsolationHandoff();
      deps.log(`run_plan returned. isRunning=${session.isExecuting}, status=${session.status}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log(`Orchestrator start failed: ${msg}`);
      vscode.window.showErrorMessage(`Failed to start execution: ${msg}`);
    }
  } finally {
    // The click showed "Starting…" before this ever answered: settle it on the
    // run's own state, refusal and immediate finish included, so no spinner
    // outlives the start it was drawn for.
    deps.chatProvider.showRunActivity(session.activity, requestId);
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
    // The plan that was only on the host is now the session the Run block speaks for.
    deps.sendRunSettings();
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
  setPendingRunners(pendingRunners);

  const plan = deps.getCurrentPlan();
  const hasDialogue = (plan.conversationHistory?.length ?? 0) > 0;

  // Unified loop (post-plan chat included): the model decides per turn whether
  // to reply, emit targeted task edits, or re-plan. While a runner is live the
  // turn is taken at once too, and its edits apply to tasks not yet started
  // (ADR-0029). handleStartPlanning remains only for a truly fresh session.
  if (deps.session.isExecuting || plan.tasks.length > 0 || hasDialogue || deps.session.isConversationActive) {
    ensureSessionPlan(deps);
    await handleContinueConversation(text, deps);
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

function applyTaskEdit(session: Session, taskId: string, edit: TaskEdit, options?: TaskEditOptions): Promise<unknown> {
  // An idle plan keeps the call it always made, without the card's condition.
  const update = (changes: Partial<Task>) => options
    ? session.updateTask(taskId, changes, options)
    : session.updateTask(taskId, changes);
  switch (edit.kind) {
    // A runner change re-derives the task's model, effort and mode from the
    // new runner's catalog, which only the session can read.
    case 'runner': return options ? session.setTaskRunner(taskId, edit.runner, options) : session.setTaskRunner(taskId, edit.runner);
    case 'model': return update({ assignedModel: edit.assignment });
    case 'mode': return update({ taskMode: edit.mode });
    case 'prompt': return update({ prompt: edit.prompt, description: edit.prompt || undefined });
    case 'dependencies': return options ? session.setTaskDependencies(taskId, edit.dependencies, options) : session.setTaskDependencies(taskId, edit.dependencies);
    case 'skills': return update({ skills: edit.skills });
    case 'ops': return update({ ops: edit.ops });
  }
}

/**
 * A field edit from a task card, through the Session like every other edit
 * so it is validated, broadcast and scheduled for. The plan is re-shown
 * either way: the card must end up showing what was accepted, not what was
 * attempted.
 */
export async function handleTaskEdit(taskId: string, edit: TaskEdit, deps: PlanManagerDeps): Promise<void> {
  // The card's own rule, from the same run fact: a run that could still move
  // a task on holds its editors to a task that has not started, and the
  // Session checks that again after its own waits. A task that has not started
  // is held to it in an idle plan too, as a start can claim it while the edit
  // waits on discovery. A settled task of an idle plan, a failed one a run
  // ended on included, keeps the wider direct-edit contract.
  const { session } = deps;
  const target = flattenTasks(session.planTasks).find((t) => t.id === taskId);
  const held = runHoldsEditors(session.isExecuting, session.activity);
  const options: TaskEditOptions | undefined = (target ? cardEditNeedsUnstarted(held, target) : held) ? { requireUnstarted: true } : undefined;
  try {
    await applyTaskEdit(deps.session, taskId, edit, options);
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
  // Core refuses a loop's check; asking first would promise a removal it will not make (ADR-0045 L8).
  const target = flattenTasks(deps.session.planTasks).find((t) => t.id === taskId);
  const refusal = target && loopRemovalRefusal(target);
  if (refusal) {
    void vscode.window.showWarningMessage(refusal);
    return;
  }
  const confirm = await vscode.window.showWarningMessage(removalPrompt(deps.session.planTasks, taskId), { modal: true }, 'Remove');
  if (confirm !== 'Remove') return;
  await deps.session.removeTask(taskId);
  if (deps.session.planTasks.length > 0) {
    settleDirectEdit(deps);
    return;
  }
  if (deps.session.planState) deps.setCurrentPlan(deps.session.planState);
  deps.chatProvider.setState('empty');
  deps.chatProvider.run.reset();
  clearState(deps.fsAdapter.getWorkspaceRoot());
  deps.persistState();
}

/** Shows what a control's refusal said, in the seam's own words. */
function showRefusal(err: unknown): void {
  void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
}

/** A rejection resumes the paused agent with the reason, rather than cancelling the task. */
export async function handleCheckpointAnswer(taskId: string, approved: boolean, reason: string | undefined, deps: Pick<PlanManagerDeps, 'session'>): Promise<void> {
  try {
    await executeUserCommand(deps.session, approved
      ? { command: 'answer_checkpoint', task: taskId, answer: 'approve' }
      : { command: 'answer_checkpoint', task: taskId, answer: 'reject', ...(reason ? { reason } : {}) });
  } catch (err) {
    showRefusal(err);
  }
}

/**
 * An inbox answer (ADR-0053) goes through `Session.answerEscalation`, which
 * derives the list afresh and refuses a stale id. Unlike the cards' controls,
 * the verdict goes back to the inbox rather than to a toast: the entry it names
 * has usually left the list by the time a refusal arrives.
 */
export async function handleEscalationAnswer(
  answer: Extract<WebviewToHost, { type: 'answerEscalation' }>,
  deps: Pick<PlanManagerDeps, 'session' | 'chatProvider'>,
): Promise<void> {
  const { requestId, id } = answer;
  try {
    const outcome = await deps.session.answerEscalation(id, answer.option, answer.note, answer.confirmed);
    deps.chatProvider.postMessage(outcome.ok
      ? { type: 'escalationAnswered', requestId, id, ok: true }
      : { type: 'escalationAnswered', requestId, id, ok: false, message: outcome.message });
  } catch (err) {
    deps.chatProvider.postMessage({ type: 'escalationAnswered', requestId, id, ok: false, message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Talking to a task (ADR-0018, M1). Every control is a command at the seam,
 * so a refusal (a task not running, a message already read) is the seam's
 * answer, shown rather than swallowed.
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
    switch (control.kind) {
      case 'message': return await executeUserCommand(deps.session, { command: 'message_task', task: taskId, text: control.text });
      case 'messageNow': return await executeUserCommand(deps.session, { command: 'message_task', task: taskId, text: control.text, force: true });
      case 'removeQueued': return await executeUserCommand(deps.session, { command: 'remove_queued', task: taskId, id: control.id });
      case 'queuedNow': return await executeUserCommand(deps.session, { command: 'force_send_queued', task: taskId, id: control.id });
      case 'interrupt': return await executeUserCommand(deps.session, { command: 'interrupt_task', task: taskId });
    }
  } catch (err) {
    showRefusal(err);
  }
}

/**
 * A runner's request answered from its chat card goes through the seam as the
 * user, so the timeline keeps it and the supervisor hears of it (ADR-0029).
 * Any other request (a planner's, a task start's) is not a task's to answer
 * there, and keeps the approval path.
 */
export async function handleResolveApproval(id: string, granted: boolean, deps: Pick<PlanManagerDeps, 'session'>): Promise<void> {
  const request = deps.session.outstandingApprovals().find((pending) => pending.id === id)?.request;
  if (request && isRunnerApproval(request) && request.taskId) {
    try {
      await executeUserCommand(deps.session, { command: 'answer_approval', task: request.taskId, approval: id, answer: granted ? 'allow' : 'deny' });
    } catch (err) {
      showRefusal(err);
    }
    return;
  }
  deps.session.resolveApproval(id, granted);
}

/**
 * Stop aborts the current planner turn only — never the plan, the dialogue or
 * the persisted state; that is a new session. The session stays busy until the
 * turn has unwound, so a prompt sent meanwhile is held, not raced against it.
 */
export function handleStopPlanning(deps: PlanManagerDeps): void {
  deps.session.abortPlannerTurn();
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
  'session' | 'chatProvider' | 'fsAdapter' | 'setCurrentPlan' | 'setCurrentGoal' | 'sendRunSettings' | 'log'>): void {
  // Abandons the planner turn in flight, or one still waiting for the probe:
  // it settles as discarded, which is not reported into the new session.
  deps.session.reset();
  deps.setCurrentPlan(createEmptyPlan());
  deps.setCurrentGoal('');
  deps.chatProvider.setState('empty');
  deps.chatProvider.conversation.reset();
  deps.chatProvider.run.reset();
  clearState(deps.fsAdapter.getWorkspaceRoot());
  // With no session open, the Run block shows the file the next one opens with (ADR-0030).
  deps.sendRunSettings();
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

/**
 * A force start, and a run of a gated task, pass a merge gate the user has
 * seen named. One path for the plan pane and the command palette, so the
 * start clears a handoff the same way from either.
 */
export async function forceStartPastGate(taskId: string, deps: Pick<PlanManagerDeps, 'session' | 'chatProvider'>): Promise<void> {
  if (!(await confirmPastGate(taskId, deps.session))) return;
  await startTask(deps, taskActionCommand('force-start', taskId));
}

/**
 * Mark complete and Mark not done, from the card and from the command palette
 * alike (ADR-0029). An AI or script task's override vouches for work no verdict
 * passed, so a real modal explains it first and the seam gets the user's yes on
 * the command; the core refuses it anyway while a run could advance the task,
 * and the modal is not offered then. A manual task's is the user's own sign-off
 * and asks nothing. The task is named by id and the status the user was asked
 * about travels with the yes, so a task that moved on while the modal was open
 * is refused rather than overridden.
 */
export async function markTaskByHand(direction: OverrideDirection, taskId: string, deps: Pick<PlanManagerDeps, 'session'>): Promise<void> {
  const { session } = deps;
  const tasks = session.planState?.tasks ?? [];
  const task = flattenTasks(tasks).find((t) => t.id === taskId);
  const command = taskActionCommand(direction, taskId);
  if (!task || !overrideNeedsConfirmation(task)) {
    await executeUserCommand(session, command);
    return;
  }
  const label = `task ${titledTaskRefOf(tasks, taskId) ?? taskId}`;
  // The seam's own guard, not a narrower reading of it: a queued force start or
  // a usage-limit hold refuses an override too, though nothing is starting,
  // running or scheduled (ADR-0029).
  if (session.activity.advancesOnItsOwn) {
    showRefusal(new Error(manualOverrideStopFirst(direction, label)));
    return;
  }
  const yes = direction === 'complete' ? 'Mark complete' : 'Mark not done';
  const choice = await vscode.window.showWarningMessage(manualOverrideConfirmation(direction, label), { modal: true }, yes);
  if (choice !== yes) return;
  await executeUserCommand(session, confirmedOverride(command, task.status));
}

/**
 * Revert a task's landed work (ADR-0054), from its card. Core's preview says
 * what goes with it, or why nothing does, and a real modal shows that list
 * (a `confirm()` in the webview would never fire). The yes carries the ids the
 * user was shown, so a plan that changed meanwhile is refused, not reverted.
 * A refusal at any point is core's own words.
 */
export async function revertTaskByHand(taskId: string, deps: Pick<PlanManagerDeps, 'session'>): Promise<void> {
  const { session } = deps;
  const preview = await session.revertPreview(taskId);
  if (!preview.revertible) {
    showRefusal(new Error(preview.message));
    return;
  }
  const asked = preview.tasks.find((t) => t.taskId === taskId) ?? preview.tasks.at(-1);
  const list = preview.tasks.map(revertListLine);
  const choice = await vscode.window.showWarningMessage(
    `Revert task ${asked ? `#${asked.order} ${asked.title}` : 'this task'}? ${revertEffect}`,
    { modal: true, detail: `Reverting, newest first:\n${list.join('\n')}` },
    'Revert',
  );
  if (choice !== 'Revert') return;
  await executeUserCommand(session, { command: 'revert_task', task: taskId, confirmed: true, seen: preview.tasks.map((t) => t.taskId) });
}

/**
 * A start reopens the run whose cards its last end left up. Cleared only once
 * the seam accepts it: a refused start replaced no run, and the Session still
 * holds every mark and the handoff.
 */
async function startTask(deps: Pick<PlanManagerDeps, 'session' | 'chatProvider'>, command: ExecutionCommand): Promise<void> {
  await executeUserCommand(deps.session, command);
  deps.chatProvider.clearIsolationHandoff();
}

/** The webview's names for the task controls that are one command each; Force start and Run go through the merge gate's confirmation instead. */
const SYSTEM_TASK_ACTIONS = {
  cancel: 'cancel',
  cancelResume: 'cancel-resume',
  resumeNow: 'resume-now',
  retry: 'retry',
  skip: 'skip',
  markComplete: 'complete',
  markIncomplete: 'uncomplete',
} as const satisfies Record<string, TaskAction>;

export async function handleSystemCommand(
  command: string,
  taskId: string,
  deps: PlanManagerDeps,
  requestId?: number,
): Promise<void> {
  try {
    switch (command) {
      case 'cancelPlannerResend':
        deps.session.cancelPlannerResend();
        break;
      // A planner turn: it streams to the chat as any does, and fails as one.
      case 'retryPlannerCompaction':
        try {
          // The retry is a planner turn too, and the signed-out refusal's
          // login runs outside this host: ask the account again before the
          // session's gate judges.
          const recheck = recheckSignedOutPlanner(deps);
          if (recheck) await recheck;
          await deps.session.retryPlannerCompaction();
        } catch (err) {
          reportPlannerError(err, deps);
        }
        break;
      // Skip lands nothing, so it is never a mark: only Mark complete vouches for work.
      case 'cancel':
      case 'cancelResume':
      case 'resumeNow':
      case 'retry':
      case 'skip':
        await executeUserCommand(deps.session, taskActionCommand(SYSTEM_TASK_ACTIONS[command], taskId));
        break;
      case 'markComplete':
      case 'markIncomplete':
        await markTaskByHand(SYSTEM_TASK_ACTIONS[command], taskId, deps);
        break;
      case 'revertTask':
        await revertTaskByHand(taskId, deps);
        break;
      case 'forceStart':
        await forceStartPastGate(taskId, deps);
        break;
      case 'runTask': {
        // A start past a merge gate is a force start, confirmed first; the seam's
        // run_task refuses a gated one.
        if (deps.session.mergeGate(taskId).length > 0) {
          await forceStartPastGate(taskId, deps);
          break;
        }
        await startTask(deps, taskActionCommand('run', taskId));
        break;
      }
      case 'executePlan':
        await handleApprovePlan(deps, requestId);
        break;
      case 'stopExecution':
        // The seam answers a stop with nothing running, and nothing about to start, as an ok no-op; a refusal is a stop that could not be kept.
        await executeUserCommand(deps.session, { command: 'stop_run' });
        deps.runner.stopAll();
        deps.chatProvider.setState('planDraft');
        break;
    }
  } catch (err) {
    void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
  }
  deps.chatProvider.showPlan(deps.getCurrentPlan());
  deps.persistState();
}

export function handleSessionMessage(
  msg: import('@ordewell/core').SessionMessage,
  deps: PlanManagerDeps,
): void {
  deps.chatProvider.conversation.receive(msg);
  // Every session event feeds the run view too; the card badges, isolation
  // marks and merge/handoff cards are drawn from it, not from the plan.
  deps.chatProvider.run.receive(msg);
  if (msg.type === 'approval_request') {
    // The chat card is the question now, so make sure the user is looking at
    // it. Nothing blocks here: the session's research loop awaits the answer on
    // the broadcast seam, and the webview answers through `resolveApproval`.
    deps.chatProvider.reveal();
    return;
  }
  switch (msg.type) {
    // Runner chatter was dropped here entirely, so a task that failed mid-run
    // showed a red card and nothing else. The webview keeps only the tail.
    case 'task_output':
      deps.chatProvider.sendTaskOutput(msg.taskId, msg.text);
      break;
    case 'task_started':
      deps.chatProvider.postMessage({ type: 'taskCommands', taskId: msg.taskId, commands: [] });
      deps.chatProvider.conversation.note('system', taskStartedNotice(msg.title, msg.runner));
      break;
    case 'status_update': {
      // The run view already holds each task's status; the dock reads a
      // plan-level one, the provider's to keep, never the Session's plan's.
      deps.chatProvider.showPlan(deps.getCurrentPlan(), deps.session.isExecuting
        ? 'running'
        : deps.session.status === 'completed'
          ? 'completed'
          : 'draft');
      break;
    }
    // The Session changes the plan itself (a live turn's edits, a run setting)
    // and announces the result; the card follows it.
    case 'plan_generated':
      deps.chatProvider.showPlan(deps.getCurrentPlan());
      break;
    case 'execution_complete': {
      const plan = deps.getCurrentPlan();
      deps.chatProvider.showPlan(plan);
      deps.chatProvider.showRunActivity(deps.session.activity);
      deps.persistState();
      break;
    }
    case 'execution_stopped': {
      deps.chatProvider.showPlan(deps.getCurrentPlan(), 'draft');
      // A Stop can come from another surface while this webview still shows a
      // starting plan: the run's own word clears it.
      deps.chatProvider.showRunActivity(deps.session.activity);
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
    // Drawn by the conversation view or the run view above, or not by this
    // surface at all. Named so a new SessionMessage variant fails to compile
    // until someone decides what it means here. `isolation_merge` and
    // `run_closed` fold onto the run view: what Merge all did, and the
    // Session's word that the run is closed, which takes the marks and cards.
    case 'checkpoint':
    case 'isolation_handoff':
    case 'isolation_merge':
    case 'run_closed':
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
    case 'planner_compaction':
    case 'subagent_started':
    case 'subagent_finished':
    case 'approval_settled':
    case 'approval_decided':
    case 'execution_action':
      break;
    case 'task_log':
      if (msg.events.some((event) => event.type === 'runner_loaded')) {
        deps.chatProvider.postMessage({ type: 'taskCommands', taskId: msg.taskId, commands: latestTaskCommands(deps.session, msg.taskId) });
      }
      break;
    default: {
      const exhaustive: never = msg;
      return exhaustive;
    }
  }
}
