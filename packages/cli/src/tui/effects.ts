import { execSync } from 'child_process';
import {
  clipboardCopyCommand, getProviderMeta, isApiProvider, isCliProvider, isUserMessage, mergeOutcome, confirmedOverride, newTaskFields, taskActionCommand, TERMINAL_UI_COMMANDS, type HasBinFn, type SerializedConversationMessage, type SurfacePlan,
  type PlannerModelRecall,
  type RunnersResponse,
} from '@ordewell/core';
import { describeConnectionRefused, isConnectionRefused } from '../daemon';
import { DaemonError, RequestTimeoutError, UnreadableResponseError, WorkspaceInitNeededError, deliveryOf, type ApiClient, type SessionFollow } from '../apiClient';
import { normalizeCatalog } from '../catalog';
import { plannerSwitchRecall, uninstalledPlannerRefusal } from '../plannerModelSwitch';
import type { Action, Effect } from './reducer';
import type { ChatRestored } from './reducers/shared';
import type { SessionView } from './state';
import { inboundFor, forgetInbound } from './inbound';

/**
 * The slice of the daemon client the TUI needs. Derived from `ApiClient` rather
 * than restated, so a response type is declared once (the daemon contract) and
 * a test double is checked against what the client really returns.
 */
export type OrdewellApi = Pick<ApiClient,
  | 'startConversation' | 'sendConversationMessage' | 'forceSendPlannerMessage' | 'executePlan' | 'stopExecution' | 'cancelPlanning'
  | 'execute' | 'cancelPlannerResend' | 'retryPlannerCompaction'
  | 'getTaskLogAttempts' | 'getTaskLog'
  | 'invokeTaskCommand' | 'approveTaskCheckpoint' | 'rejectTaskCheckpoint'
  | 'addTask' | 'updateTask' | 'removeTask'
  | 'getSessions' | 'getSession' | 'adoptSession' | 'deleteSession' | 'closeSession'
  | 'getIsolationPreview' | 'revertPreview'
  | 'forkConversation' | 'rewindTargets' | 'rewindConversation' | 'compactConversation'
  | 'reviewRunDiff' | 'mergeRun' | 'discardRun' | 'cleanupRun' | 'continueWithStash' | 'continueWithoutIsolation' | 'resolveConflictAsTask'
  | 'getSettings' | 'updateSettings' | 'updateRunSettings'
  | 'getRunners' | 'setRunnerEnabled' | 'getModels'
  | 'streamPlanning' | 'respondToApproval' | 'streamExecution' | 'closeExecutionStream' | 'followSession'
>;

export interface EffectDeps {
  api: OrdewellApi;
  workspace: string;
  /** The local daemon's port. */
  port: number;
  dispatch(action: Action): void;
  newSessionId(): string;
  /** Persists to the resolved `.env` and to `process.env`. */
  setEnvVar(key: string, value: string): void;
  /** Saves Full or Guarded in the user's settings (ADR-0030); `overridden` when the environment decides it anyway. */
  saveAutonomy(enabled: boolean): { overridden: boolean };
  /**
   * Brings the daemon back after it has gone away, resolving to whether it is
   * now answering. The TUI outlives its daemon in every direction — the daemon
   * can crash, another client can `ordewell stop --server`, a rebuild can be
   * followed by a manual restart — and `ensureDaemonOwned` runs once, at
   * launch. Without this the session is dead from the first refused connection
   * onward, with no way back short of quitting.
   */
  reviveDaemon(): Promise<boolean>;
  /** Hands the mouse to the app (wheel events) or back to the terminal (drag-select). */
  setMouseCapture(enabled: boolean): void;
  /**
   * Which binaries this host has — `clipboardCopyCommand`'s feature probe.
   * Injected only so a test can drive both the found and the missing branch;
   * the runtime leaves it out and takes core's `which`/`where` default.
   */
  hasBin?: HasBinFn;
  /** Runs `command` with `text` on its stdin. Injected for the same reason. */
  pipeToClipboard?(command: string, text: string): void;
  /**
   * Hands the terminal to a coding agent's own login command and resolves
   * when the child exits. Injected so no test starts a real agent.
   */
  login(command: readonly string[]): Promise<{ ok: boolean; message?: string }>;
  /** Writes raw bytes to the terminal — the OSC 52 fallback's only route out. */
  writeTerminal(data: string): void;
  exit(): void;
}

/**
 * Performs one effect and feeds results back as actions. Every path is
 * caught: a daemon hiccup becomes an error turn in the transcript, never an
 * unhandled rejection that tears down the raw-mode terminal.
 *
 * Conversation turns need no client-side queue: the reducer only routes a
 * prompt to `sendMessage` when no planner turn is in flight (see
 * `drainQueue`/`submit`), so turn serialization is decided at the source and
 * the daemon's first-turn registration race never comes up.
 */
export async function runEffect(effect: Effect, deps: EffectDeps): Promise<void> {
  // An opening turn's session is minted before the first attempt, so its
  // failure can name it, and a revived daemon's retry opens the same one.
  const performed: Performed = effect.type === 'startConversation' ? { ...effect, sessionId: effect.sessionId ?? deps.newSessionId() } : effect;
  const opening = performed.type === 'startConversation' ? performed : null;
  const turn = isPlannerTurn(effect);
  // The user may have loaded another session while the turn ran; its failure
  // must not end that one's turn or drain that one's queue.
  const turnSession = turn && 'sessionId' in performed ? { sessionId: performed.sessionId } : {};
  const fail = (action: Extract<Action, { type: 'failed' }>): void => deps.dispatch(turn ? { ...action, turn, ...turnSession } : action);
  try {
    await perform(performed, deps);
  } catch (err) {
    if (!isConnectionRefused(err)) {
      fail(failedFrom(err));
      return;
    }

    // Refused at the handshake means the request never reached a server, so
    // replaying it cannot be a second execution — which is the whole reason
    // only this one errno is retried. See `isConnectionRefused`. An opening
    // that carries its session is already the retry after a revive.
    let revived = false;
    if (effect.type !== 'startConversation' || effect.sessionId === undefined) {
      try {
        revived = await deps.reviveDaemon();
      } catch {
        revived = false;
      }
    }

    if (!revived) {
      // A refused opening kept its session for the retry; with none coming,
      // nothing holds it, so it is let go as any refused opening is.
      if (opening) deps.dispatch({ type: 'sessionCleared', sessionId: opening.sessionId, unreached: true });
      fail({ type: 'failed', message: describeConnectionRefused(deps.port) });
      // The welcome is not any session: its run settings are the file's again
      // (ADR-0030). Read after the failure is shown, so a daemon that never
      // answers cannot hold the welcome in planning.
      if (opening) await reloadSettings(deps);
      return;
    }

    if (opening) {
      // The user may have loaded, forked or started another session while the
      // daemon came back. Whether this opening is still the one on screen is
      // the reducer's to say: a retry from here would take that one over.
      deps.dispatch({ type: 'daemonReconnected' });
      deps.dispatch({
        type: 'openingRevived', sessionId: opening.sessionId, goal: opening.goal,
        ...(opening.allowInit ? { allowInit: opening.allowInit } : {}),
      });
      return;
    }

    deps.dispatch({ type: 'notice', message: 'The server had stopped; started a new one and retried.' });
    // A replacement daemon may serve a different workspace configuration, so
    // the welcome's repository read starts again instead of outliving it. A
    // refresh or loadScope about to be retried asks for it anyway.
    if (effect.type !== 'loadIsolationPreview' && effect.type !== 'refresh' && effect.type !== 'loadScope') {
      deps.dispatch({ type: 'daemonReconnected' });
    }
    try {
      await perform(performed, deps);
    } catch (retryErr) {
      // A fresh daemon holds no sessions, so the retry of anything
      // session-scoped legitimately 404s. Say which of the two happened.
      fail(isConnectionRefused(retryErr) ? { type: 'failed', message: describeConnectionRefused(deps.port) } : failedFrom(retryErr));
    }
  }
}

/** An effect as `perform` runs it: an opening turn carries the session `runEffect` minted for it. */
type Performed = Exclude<Effect, { type: 'startConversation' }> | (Extract<Effect, { type: 'startConversation' }> & { sessionId: string });

/** The effects that are a planner turn: their failure is the turn's, and ends it. */
function isPlannerTurn(effect: Effect): boolean {
  return effect.type === 'startConversation' || effect.type === 'sendMessage'
    || effect.type === 'forceSendPlannerMessage' || effect.type === 'compactConversation' || effect.type === 'retryPlannerCompaction';
}

/**
 * Loading a session adopts it, so a 404 here means the daemon dropped it — a
 * restart, or another surface deleted it. Reloading re-adopts one that is still
 * saved; say so rather than passing the daemon's bare wording through.
 */
function explain(err: unknown): string {
  if (err instanceof DaemonError && err.code === 'session_not_found') {
    return 'This server is no longer holding that session: it was deleted, or the server restarted. Reload it with /sessions if it is still listed.';
  }
  return err instanceof Error ? err.message : String(err);
}

/** The failure a rejected call becomes, carrying the daemon's reason when it gave one. */
function failedFrom(err: unknown): Extract<Action, { type: 'failed' }> {
  const code = err instanceof DaemonError ? err.code : undefined;
  return { type: 'failed', message: explain(err), ...(code ? { code } : {}) };
}

/**
 * Write settings to `.env` only once the daemon has accepted them.
 *
 * The reverse order looks harmless and is not: `.env` is the disk, and a
 * refused connection left it holding a choice that neither the daemon nor the
 * on-screen state ever saw. A planner switch writes `ORCHESTRATOR_MODEL` and
 * `ORDEWELL_PLANNER_EFFORT` in the same breath as `AI_PROVIDER` — whatever the
 * daemon resolved them to — so a failed half-write would have persisted a
 * provider with a model from the backend it just left, and the next daemon
 * started from that file, silently, with the TUI still showing the old planner.
 */
function persistAfterDaemon(deps: EffectDeps, env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) deps.setEnvVar(key, value);
}

/** Names which of the three model outcomes a planner switch landed on — one line, into the chat pane. */
function plannerModelNotice(recall: PlannerModelRecall): string {
  switch (recall.source) {
    case 'remembered':
      return `Restored ${recall.model}.`;
    case 'catalog-default':
      return `Using its default model, ${recall.model}. Pick another with /planner.`;
    case 'none':
      return 'Pick a model with /planner.';
  }
}

async function perform(effect: Performed, deps: EffectDeps): Promise<void> {
  const { api, dispatch, workspace } = deps;

  switch (effect.type) {
    case 'startConversation': {
      const { sessionId } = effect;
      dispatch({ type: 'sessionStarted', sessionId, goal: effect.goal });
      try {
        await converse(deps, sessionId, () => api.startConversation(sessionId, effect.goal, undefined, workspace, effect.allowInit), true);
      } catch (err) {
        // The daemon registers a session before the opening turn runs, so a
        // stopped one — by a force send, whose forced turn carries on — leaves
        // a session the next reply belongs to.
        if (err instanceof DaemonError && err.code === 'planner_turn_stopped') {
          await reloadSettings(deps, sessionId);
          throw err;
        }
        // Refused, it reached no server: the session stays on screen for a
        // revived daemon's retry, so a session loaded meanwhile replaces it,
        // and the retry can tell (`openingRevived`). `runEffect` lets it go
        // when no retry comes.
        if (isConnectionRefused(err)) {
          unfollow(deps, sessionId);
          throw err;
        }
        // What reaches here is a refusal the daemon answered, or a request that
        // never went out for another reason (a lost reply is settled inside
        // `converse`, the session kept). Neither leaves a conversation a reply
        // could continue, so the id is let go: keeping it would 404 every
        // following message.
        unfollow(deps, sessionId);
        dispatch({ type: 'sessionCleared', sessionId });
        // The welcome is not any session: its run settings are the file's again (ADR-0030).
        await reloadSettings(deps);
        // Offer to initialize instead of just reporting failure — but only
        // once: a rejection on the confirmed retry (allowInit already true)
        // falls through to the generic error path instead of looping the
        // prompt forever.
        if (err instanceof WorkspaceInitNeededError && !effect.allowInit) {
          dispatch({ type: 'workspaceNeedsInit', goal: effect.goal, workspace: err.workspace, sessionId });
          return;
        }
        throw err;
      }
      // Outside the block above: a settings read that fails must not take a
      // session that opened. The session holds its own run settings, seeded from
      // the file as it stood when the daemon opened it (ADR-0030).
      await reloadSettings(deps, sessionId);
      return;
    }

    // The stream said a turn whose reply was lost has ended: read it back.
    case 'reconcileTurn':
      await readBackSession(deps, effect.sessionId, { opening: false, turnEnded: true });
      return;

    case 'sendMessage':
      await converse(deps, effect.sessionId, () => api.sendConversationMessage(effect.sessionId, effect.message));
      return;

    // Send now in the planner chat (ADR-0023, F5): the daemon stops the turn
    // in flight and answers the forced prompt in the turn that replaces it,
    // ahead of the queue; its reply settles here like any turn's.
    case 'forceSendPlannerMessage':
      await converse(deps, effect.sessionId, () => api.forceSendPlannerMessage(effect.sessionId, effect.message));
      return;

    case 'execute':
      await withExecutionStream(deps, effect.sessionId, () => api.executePlan(effect.sessionId));
      return;

    // The seam keeps its own line of a Stop in the timeline and the stream
    // announces the run's end, so this adds none (ADR-0029).
    case 'stopExecution':
      await api.stopExecution(effect.sessionId);
      return;

    case 'cancelPlanning': {
      const { cancelled } = await api.cancelPlanning(effect.sessionId);
      // Nothing to cancel — the turn already settled (a race with the daemon,
      // not a stale request), and its own planner_message/planUpdated already
      // carries whatever feedback there is.
      if (cancelled) dispatch({ type: 'notice', message: 'Planning stopped.' });
      return;
    }

    // The arm's expiry is the runtime's to schedule: the reducer is pure, so
    // it names the delay and this owns the timer that ends the arming. Unref'd,
    // so a pending arm never holds the process open on its way out.
    case 'disarmStop': {
      const timer = setTimeout(() => dispatch({ type: 'stopDisarmed', arm: effect.arm }), effect.afterMs);
      timer.unref?.();
      return;
    }

    case 'taskAction': {
      const { sessionId, taskId, action } = effect;
      // A refusal comes back in the seam's words, a task with no resume scheduled included.
      const command = taskActionCommand(action, taskId);
      const request = () => api.execute(sessionId, effect.confirmed ? confirmedOverride(command, effect.confirmed.seen) : command);
      // A spawning action (see `taskActionEffect`) reports its progress the same
      // way a whole run does, so it needs the same stream open around it.
      await (effect.watch ? withExecutionStream(deps, sessionId, request) : request());
      await refreshPlan(deps, sessionId);
      return;
    }

    case 'previewRevert':
      dispatch({ type: 'revertPreviewed', sessionId: effect.sessionId, taskId: effect.taskId, preview: await api.revertPreview(effect.sessionId, effect.taskId) });
      return;

    // A refusal at this point (a plan that changed, a conflict) comes back as the failure the seam worded.
    case 'revertTask': {
      const { message } = await api.execute(effect.sessionId, { command: 'revert_task', task: effect.taskId, confirmed: true, seen: effect.seen });
      await refreshPlan(deps, effect.sessionId);
      dispatch({ type: 'notice', message });
      return;
    }

    case 'addTask': {
      const fields = newTaskFields(effect.title);
      if (!fields) return;
      await api.addTask(effect.sessionId, { ...fields });
      await refreshPlan(deps, effect.sessionId);
      return;
    }

    case 'updateTask':
      await api.updateTask(effect.sessionId, effect.taskId, effect.changes);
      await refreshPlan(deps, effect.sessionId);
      dispatch({ type: 'notice', message: effect.message });
      return;

    case 'removeTask':
      await api.removeTask(effect.sessionId, effect.taskId);
      await refreshPlan(deps, effect.sessionId);
      return;

    case 'respondApproval': {
      try {
        await api.respondToApproval(effect.sessionId, effect.approvalId, effect.granted);
      } catch {
        // The planner's own timeout denies an unanswered request, so a lost
        // answer degrades to a denial rather than a stuck session.
        dispatch({ type: 'failed', message: 'Could not deliver the approval answer: the planner will treat it as denied.', sessionId: effect.sessionId });
      }
      return;
    }

    // The card settles when the task log reports the answer, not here.
    case 'answerTaskApproval': {
      try {
        await api.respondToApproval(effect.sessionId, effect.approvalId, effect.answer);
      } catch {
        // A runner's request never times out, so a lost answer leaves it
        // waiting rather than denied.
        dispatch({ type: 'failed', message: 'Could not deliver the answer: the task is still waiting for approval.', sessionId: effect.sessionId });
      }
      return;
    }

    // The card goes when the daemon's next status says the task left the
    // checkpoint; a refusal (settled elsewhere, withdrawn) surfaces as the
    // failure the daemon words.
    case 'answerTaskCheckpoint':
      if (effect.answer === 'approve') await api.approveTaskCheckpoint(effect.sessionId, effect.taskId);
      else await api.rejectTaskCheckpoint(effect.sessionId, effect.taskId, effect.reason);
      return;

    // The saved log is read off disk (ADR-0018, P1) so the view opens with the
    // task's history; the live `task_log` stream then catches it up in place.
    case 'openTaskLog': {
      const { attempts, position } = await api.getTaskLogAttempts(effect.sessionId, effect.taskId, workspace);
      if (attempts.length === 0) {
        dispatch({ type: 'taskLogLoaded', taskId: effect.taskId, attempts: [], attempt: 0, events: [], position, sessionId: effect.sessionId });
        return;
      }
      const attempt = attempts[attempts.length - 1];
      const log = await api.getTaskLog(effect.sessionId, effect.taskId, attempt, workspace);
      dispatch({ type: 'taskLogLoaded', taskId: effect.taskId, attempts, ...log, sessionId: effect.sessionId });
      return;
    }

    case 'loadTaskAttempt': {
      const log = await api.getTaskLog(effect.sessionId, effect.taskId, effect.attempt, workspace);
      dispatch({ type: 'taskLogLoaded', taskId: effect.taskId, ...log, sessionId: effect.sessionId });
      return;
    }

    // The daemon queues the message (or delivers it to a waiting task) and
    // broadcasts the `task_log` event that shows it; nothing to dispatch here.
    case 'sendTaskMessage':
      await api.execute(effect.sessionId, { command: 'message_task', task: effect.taskId, text: effect.text });
      return;
    case 'invokeTaskCommand':
      await api.invokeTaskCommand(effect.sessionId, effect.taskId, effect.name, effect.args);
      return;

    // The daemon starts the new attempt; its `task_log` and status arrive over
    // the execution stream, which a TUI not already watching a run holds open.
    case 'continueTask': {
      const { sessionId, taskId, text } = effect;
      const request = () => api.execute(sessionId, { command: 'retry_task', task: taskId, from: 'session', message: text });
      await (effect.watch ? withExecutionStream(deps, sessionId, request) : request());
      await refreshPlan(deps, sessionId);
      return;
    }

    // One already delivered is refused in the daemon's words.
    case 'removeTaskMessage':
      await api.execute(effect.sessionId, { command: 'remove_queued', task: effect.taskId, id: effect.messageId });
      return;

    // The task log shows the forced message at the head of the queue, then
    // the interrupt, then the turn it opens; nothing to dispatch here.
    case 'forceSendTaskMessage':
      await api.execute(effect.sessionId, { command: 'message_task', task: effect.taskId, text: effect.text, force: true });
      return;

    case 'forceSendQueuedTaskMessage':
      await api.execute(effect.sessionId, { command: 'force_send_queued', task: effect.taskId, id: effect.messageId });
      return;

    case 'interruptTask':
      await api.execute(effect.sessionId, { command: 'interrupt_task', task: effect.taskId });
      return;

    case 'setPlanner': {
      const meta = getProviderMeta(effect.provider);
      if (!meta) throw new Error(`Unknown planner: ${effect.provider}`);
      // Asked afresh rather than read from state: a list not loaded yet would
      // claim every agent is missing.
      if (isCliProvider(effect.provider)) {
        const installed = ((await api.getRunners()).runners ?? []).map((r) => r.id);
        const refusal = uninstalledPlannerRefusal(effect.provider, installed, TERMINAL_UI_COMMANDS.pickPlanner);
        if (refusal) throw new Error(refusal);
      }
      // Pushed to the live daemon and written to .env, like every other
      // provider setting. The daemon builds a fresh config per session, so the
      // switch lands on the next plan without a restart. Only the provider is
      // ours to send — the daemon resolves what its model and effort should
      // become (remembered for it, that backend's catalog default, or
      // nothing) and this consumes whatever comes back.
      const env: Record<string, string> = { AI_PROVIDER: effect.provider };
      const settings = await api.updateSettings({ env });
      const recall = plannerSwitchRecall(settings);
      persistAfterDaemon(deps, { ...env, ORCHESTRATOR_MODEL: recall.model, ORDEWELL_PLANNER_EFFORT: recall.effort });
      dispatchSettings(deps, { aiProvider: effect.provider, orchestratorModel: recall.model, plannerThinkingEffort: recall.effort });
      dispatch({
        type: 'notice',
        message: `${isCliProvider(effect.provider)
          ? `Planning with ${meta.label}: no API key needed.`
          : `Planner set to ${meta.label}.`} ${plannerModelNotice(recall)}`,
      });
      await loadModels(deps);
      return;
    }

    case 'setPlannerChoice': {
      // One write, so the daemon never holds the new provider with the old
      // backend's model. An explicit model also turns off its switch recall
      // and is remembered for this provider, the way VS Code's
      // `PlannerSelection.setModel` remembers a pick.
      const env = { AI_PROVIDER: effect.provider, ORCHESTRATOR_MODEL: effect.modelId, ORDEWELL_PLANNER_EFFORT: effect.effort };
      const settings = await api.updateSettings({ env });
      persistAfterDaemon(deps, env);
      dispatchSettings(deps, {
        ...settings,
        aiProvider: effect.provider,
        orchestratorModel: effect.modelId,
        plannerThinkingEffort: effect.effort,
      });
      dispatch({ type: 'notice', message: effect.notice, ...(effect.noticeLevel ? { level: effect.noticeLevel } : {}) });
      return;
    }

    case 'setApiKey': {
      const meta = isApiProvider(effect.provider) ? getProviderMeta(effect.provider) : undefined;
      if (!meta) throw new Error(`Unknown provider: ${effect.provider}`);
      await api.updateSettings({ env: { [meta.apiKeyEnvVar]: effect.key } });
      deps.setEnvVar(meta.apiKeyEnvVar, effect.key);
      // Deliberately reports the provider, never the key — this line is on screen.
      dispatch({ type: 'notice', message: `${meta.label} key saved to ${meta.apiKeyEnvVar}.` });
      await loadModels(deps);
      return;
    }

    case 'setAllowlist': {
      // null deletes the runner's entry server-side; [] would sit in
      // settings.json as a lingering no-op restriction.
      const ids = effect.modelIds.length > 0 ? effect.modelIds : null;
      const settings = await api.updateSettings({ modelAllowlist: { [effect.runner]: ids } });
      dispatchSettings(deps, settings);
      dispatch({
        type: 'notice',
        message: effect.modelIds.length
          ? `${effect.runner} limited to ${effect.modelIds.length} model(s).`
          : `${effect.runner} allowlist cleared.`,
      });
      return;
    }

    case 'setRunnerEnabled':
      await api.setRunnerEnabled(effect.runner, effect.enabled);
      await loadRunners(deps);
      dispatch({ type: 'notice', message: `${effect.runner} ${effect.enabled ? 'enabled' : 'disabled'}.` });
      return;

    // The child owns the terminal for as long as it runs (`deps.login` hands it
    // over and takes it back); the answer only reaches the transcript once the
    // probes have been asked again, so the welcome line and picker agree.
    case 'plannerLogin': {
      const result = await deps.login(effect.command);
      // The login has already run, so a reload that cannot reach the daemon must
      // not escape to `runEffect`'s connection-refused retry: that would hand
      // the tty to the same command a second time. Say the list is stale and
      // leave the revival to a later /refresh.
      let refreshed: RunnersResponse | undefined;
      try {
        refreshed = await loadRunners(deps);
      } catch (err) {
        if (!isConnectionRefused(err)) throw err;
      }
      // The child's exit code is not the runner's verdict: a login can print
      // success and persist nothing, so the fresh probe decides what to claim.
      const fresh = refreshed?.runners.find((r) => r.name === effect.label)?.auth?.state;
      const message = fresh === 'signed-in'
        ? `${effect.label} is signed in.`
        : fresh === 'signed-out'
          ? `${effect.label} still reports not logged in.${
            result.ok ? '' : ` ${result.message ?? 'The login did not finish.'}`
          }`
          : result.ok
            ? `Could not confirm that ${effect.label} is signed in.`
            : `Could not confirm that ${effect.label} is signed in: ${result.message ?? 'the login did not finish'}`;
      dispatch({
        type: 'notice',
        message: refreshed ? message : `${message} The runner list could not be refreshed: the server is not answering.`,
      });
      return;
    }

    case 'setRunners': {
      // One at a time: each request rewrites the same stored list, so firing
      // them together would have the last write drop the others.
      for (const change of effect.changes) {
        await api.setRunnerEnabled(change.runner, change.enabled);
      }
      await loadRunners(deps);
      dispatch({ type: 'notice', message: effect.message });
      return;
    }

    case 'saveSettings': {
      if (Object.keys(effect.run).length > 0) {
        const settings = await api.updateRunSettings(effect.run, effect.sessionId);
        // Numbered when it answers: the save is newer than any read already in
        // flight, and must not be dropped by one that started before it.
        dispatchSettings(deps, settings, effect.sessionId);
        if (effect.sessionId) await refreshPlan(deps, effect.sessionId);
      }
      if (effect.maxParallel !== undefined) await saveMaxParallel(deps, effect.maxParallel);
      const overridden = effect.autonomous !== undefined && deps.saveAutonomy(effect.autonomous).overridden;
      dispatch({ type: 'notice', message: overridden
        ? `${effect.message}: ORDEWELL_AUTONOMOUS_MODE in the environment decides the autonomy level until it is unset.`
        : effect.message });
      return;
    }

    case 'setMouseCapture':
      // The reducer already said which trade this is; persisting it only makes
      // the choice survive the next launch.
      deps.setMouseCapture(effect.enabled);
      deps.setEnvVar('ORDEWELL_TUI_MOUSE', String(effect.enabled));
      return;

    case 'copyText':
      copySelection(deps, effect.text);
      return;

    case 'loadModels':
      await loadModels(deps);
      return;

    case 'loadSessions':
      await loadSessions(deps);
      return;

    case 'loadSession': {
      // Followed first: a session still running goes on reporting while it loads.
      const shown = follows.get(deps.api)?.sessionId;
      // The daemon greets a live session's socket with its run before this
      // session is the one on screen, where the reducer would drop it as stale;
      // it is held, with every broadcast after it, until the session is on
      // screen and drawn from its transcript — which holds no approval card,
      // so the requests the snapshot says are waiting go on after it.
      const inbound = inboundFor(deps.api, deps.dispatch, effect.sessionId);
      inbound.holdSnapshot();
      try {
        await follow(deps, effect.sessionId);
      } catch (err) {
        inbound.releaseSnapshot(false);
        throw err;
      }
      // Adopting registers the session with the daemon, which is what makes the
      // restored plan executable — `getSession` alone only reads the file.
      let adopted: Awaited<ReturnType<OrdewellApi['adoptSession']>>;
      try {
        adopted = await api.adoptSession(effect.sessionId, workspace);
      } catch (err) {
        inbound.releaseSnapshot(false);
        // The TUI stays on the session it showed, so it goes on following that one.
        if (shown) await follow(deps, shown);
        else unfollow(deps, effect.sessionId);
        throw err;
      }
      const { plan, goal, run } = adopted;
      dispatch({ type: 'sessionLoaded', sessionId: effect.sessionId, goal });
      dispatch(restoredChat(plan, effect.sessionId));
      dispatch({ type: 'planUpdated', plan, sessionId: effect.sessionId });
      if (run) dispatch({ type: 'runSnapshot', view: run, sessionId: effect.sessionId });
      // After the turn-settling `planUpdated`, which would otherwise read the
      // planner as free.
      if (adopted.plannerTurnId) dispatch({ type: 'turnJoined', turnId: adopted.plannerTurnId, sessionId: effect.sessionId });
      if (adopted.plannerCompaction) dispatch({ type: 'sessionMessage', message: adopted.plannerCompaction, sessionId: effect.sessionId });
      // What was held is newer than what the load read, so it goes on top, in
      // the order it was sent: a plan landed meanwhile replaces the one read,
      // and an end heard meanwhile frees the turn or compaction just joined.
      // All in one synchronous pass, so no key lands in between.
      inbound.releaseSnapshot(true);
      // The restored session has its own run settings, seeded when it opened;
      // the file's values belong to whatever session starts next (ADR-0030).
      await reloadSettings(deps, effect.sessionId);
      dispatch({ type: 'notice', message: `Loaded "${goal || effect.sessionId}".` });
      return;
    }

    // The daemon has already adopted the fork, so switching is only the TUI
    // catching up — the original session is not closed: it may be running.
    case 'forkConversation': {
      const fork = await api.forkConversation(effect.sessionId);
      await follow(deps, fork.sessionId);
      dispatch({ type: 'sessionForked', sessionId: fork.sessionId, goal: fork.goal });
      dispatch(restoredChat(fork.plan, fork.sessionId));
      dispatch({ type: 'planUpdated', plan: fork.plan, sessionId: fork.sessionId });
      await reloadSettings(deps, fork.sessionId);
      dispatch({ type: 'notice', message: `Forked ${effect.sessionId} into ${fork.sessionId}: you are in the fork now. /sessions to go back.` });
      return;
    }

    case 'loadRewindTargets':
      dispatch({
        type: 'rewindTargetsLoaded',
        targets: await api.rewindTargets(effect.sessionId),
        sessionId: effect.sessionId,
        ...(effect.pick !== undefined && { pick: effect.pick }),
      });
      return;

    // A rewind is a fork from an earlier point, so the TUI follows it the way
    // it follows `/fork`; the original keeps its whole conversation. The
    // rewound message comes back into the input, to edit and send again.
    case 'rewindConversation': {
      const fork = await api.rewindConversation(effect.sessionId, effect.index);
      await follow(deps, fork.sessionId);
      dispatch({ type: 'sessionForked', sessionId: fork.sessionId, goal: fork.goal });
      dispatch(restoredChat(fork.plan, fork.sessionId));
      dispatch({ type: 'planUpdated', plan: fork.plan, sessionId: fork.sessionId });
      await reloadSettings(deps, fork.sessionId);
      dispatch({ type: 'inputPrefilled', text: fork.rewoundMessage, sessionId: fork.sessionId });
      dispatch({ type: 'notice', message: `Forked ${effect.sessionId} into ${fork.sessionId} from before that message: the original is kept (/sessions to go back). The message is ready to edit and resend.` });
      return;
    }

    // The paused turn opens again on the daemon and streams as any turn does;
    // its answer is the plan it landed, or paused again on.
    case 'retryPlannerCompaction':
      await converse(deps, effect.sessionId, () => api.retryPlannerCompaction(effect.sessionId));
      return;

    case 'cancelPlannerResend': {
      const { cancelled } = await api.cancelPlannerResend(effect.sessionId);
      dispatch({ type: 'notice', message: cancelled ? 'Resend cancelled: what waits goes with your next message.' : "Nothing waits on the planner's usage limit to be sent at a reset." });
      await refreshPlan(deps, effect.sessionId);
      return;
    }
    // The compaction folds into the conversation on screen as its events
    // arrive (ADR-0017), so the answer only has to carry what a lost frame
    // would have: the plan, whose transcript holds the summary. Nothing is
    // redrawn, which would drop the reader's place.
    case 'compactConversation': {
      const inbound = inboundFor(deps.api, deps.dispatch, effect.sessionId);
      const stream = api.streamPlanning(effect.sessionId, inbound.planning());
      let plan: unknown;
      let lost: string | null = null;
      try {
        await Promise.all([stream.ready, follow(deps, effect.sessionId)]);
        const sentAt = Date.now();
        try {
          ({ plan } = await api.compactConversation(effect.sessionId));
        } catch (err) {
          if (deliveryOf(err) !== 'unknown') throw err;
          lost = describeLoss(err, Date.now() - sentAt);
        }
      } finally {
        inbound.flush();
        stream.close();
      }
      if (lost !== null) {
        await settleLostReply(deps, effect.sessionId, { opening: false, reason: lost });
        return;
      }
      dispatch({ type: 'compacted', plan, sessionId: effect.sessionId });
      return;
    }

    case 'isolationReviewDiff':
      dispatch({ type: 'handoffDiff', diff: await api.reviewRunDiff(effect.sessionId), sessionId: effect.sessionId });
      return;

    // A conflict or a refusal is an answer, not a fault: either way the user's
    // tree is exactly as it was, and the words say what to do next. A full
    // merge of a settled run leaves nothing to hand over — the daemon has
    // cleared the run up and says so on the stream (`run_closed`); one
    // mid-run leaves the run going (ADR-0020).
    case 'isolationMerge': {
      const { ok, message } = mergeOutcome(await api.mergeRun(effect.sessionId), effect.branch, effect.group === true, effect.repaired ?? []);
      dispatch({ type: ok ? 'notice' : 'failed', message });
      return;
    }

    case 'isolationDiscard':
      await api.discardRun(effect.sessionId);
      dispatch({ type: 'notice', message: `Discarded the run and ${effect.branch}.` });
      return;

    case 'isolationCleanup':
      await api.cleanupRun(effect.sessionId);
      await refreshPlan(deps, effect.sessionId);
      dispatch({ type: 'notice', message: `Removed the run's worktrees and task branches; ${effect.branch} is kept.` });
      return;

    // Spawns runners again, so it needs the stream a run needs. Opening it ends
    // the blocked run's, which stayed open to show the ops tasks still running.
    case 'isolationContinue': {
      const { sessionId } = effect;
      await withExecutionStream(deps, sessionId, () => effect.mode === 'stash' ? api.continueWithStash(sessionId) : api.continueWithoutIsolation(sessionId));
      await refreshPlan(deps, sessionId);
      return;
    }

    case 'resolveConflict':
      await api.resolveConflictAsTask(effect.sessionId, effect.taskId);
      await refreshPlan(deps, effect.sessionId);
      dispatch({ type: 'notice', message: 'Added a task that merges the conflicted branch by hand. Run it with E (run plan); when it lands, the conflicted task lands through it.' });
      return;

    case 'deleteSession': {
      const { ok } = await api.deleteSession(effect.sessionId, workspace);
      await loadSessions(deps);
      // The session is gone: a reconnect would open a socket on nothing.
      if (ok) unfollow(deps, effect.sessionId);
      forgetInbound(deps.api, effect.sessionId);
      if (ok) dispatch({ type: 'sessionDeleted', sessionId: effect.sessionId });
      dispatch(ok
        ? { type: 'notice', message: `Deleted ${effect.sessionId}.` }
        : { type: 'failed', message: `Could not delete ${effect.sessionId}: no saved session was removed.` });
      return;
    }

    case 'saveSession':
      // Plans are persisted server-side as they change; this only confirms it.
      dispatch({ type: 'notice', message: `Session ${effect.sessionId} saved.` });
      return;

    case 'closeSession':
      unfollow(deps, effect.sessionId);
      forgetInbound(deps.api, effect.sessionId);
      // Local state already moved on; a failure here must not surface as an
      // error in the new session's transcript.
      try {
        await api.closeSession(effect.sessionId);
      } catch {
        // ignore
      }
      // Back on the welcome, which shows the file's values, not the closed session's (ADR-0030).
      await reloadSettings(deps);
      return;

    case 'loadRunners':
      await loadRunners(deps);
      return;

    case 'loadScope':
      await Promise.all([loadRunners(deps), loadSettings(deps, effect.sessionId), loadIsolationPreview(deps)]);
      return;

    case 'loadIsolationPreview':
      await loadIsolationPreview(deps);
      return;

    case 'refresh':
      await Promise.all([loadRunners(deps), loadSettings(deps, effect.sessionId), loadModels(deps), loadIsolationPreview(deps)]);
      if (effect.announce) dispatch({ type: 'notice', message: 'Refreshed runners, settings, models and repositories.' });
      return;

    case 'exit':
      deps.exit();
      return;
  }
}

// ── Clipboard ────────────────────────────────────────────────────────────────

const pipeToClipboardDefault = (command: string, text: string): void => {
  execSync(command, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
};

/**
 * The terminal's own "put this on the clipboard": ESC ] 52 ; c ; <base64> BEL.
 * Only reached when the host has no clipboard binary — plenty of emulators
 * (VTE before 0.76, xterm without `allowWindowOps`) drop it on the floor, which
 * is why `clipboardCopyCommand` is tried first.
 */
function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

async function saveMaxParallel(deps: EffectDeps, limit: number): Promise<void> {
  await deps.api.updateSettings({ env: { ORDEWELL_MAX_PARALLEL: String(limit) } });
  deps.setEnvVar('ORDEWELL_MAX_PARALLEL', String(limit));
}

/**
 * A released selection, onto the clipboard. Synchronous and never throwing: a
 * missing `xclip`, or one that cannot open the display, falls through to the
 * terminal route rather than reporting a copy that did not happen.
 */
function copySelection(deps: EffectDeps, text: string): void {
  if (!text) return;
  const lines = text.split('\n').length;
  const command = clipboardCopyCommand(deps.hasBin);

  if (command) {
    try {
      (deps.pipeToClipboard ?? pipeToClipboardDefault)(command, text);
      deps.dispatch({ type: 'notice', message: `Copied ${lines} ${lines === 1 ? 'line' : 'lines'}.`, holdPlace: true });
      return;
    } catch {
      // fall through to OSC 52
    }
  }

  deps.writeTerminal(osc52(text));
  deps.dispatch({
    type: 'notice',
    holdPlace: true,
    message: `Copied ${lines} ${lines === 1 ? 'line' : 'lines'} through the terminal: no clipboard tool here (pbcopy, xclip, xsel or wl-copy), so it only lands if your terminal supports OSC 52.`,
  });
}

// ── Shared steps ─────────────────────────────────────────────────────────────

/**
 * Runs a request that spawns runner work with the session's execution stream
 * live around it, and stays until the run settles. The stream is subscribed
 * *before* the request because the orchestrator may launch immediately: a
 * status_update emitted before the socket is listening is simply lost, which is
 * how a started task ended up with no running icon.
 */
async function withExecutionStream(
  deps: EffectDeps,
  sessionId: string,
  request: () => Promise<unknown>,
): Promise<void> {
  await follow(deps, sessionId);
  const open = runStreamsOf(deps.api);
  open.set(sessionId, (open.get(sessionId) ?? 0) + 1);
  try {
    await streamRun(deps, sessionId, request);
  } finally {
    const left = (open.get(sessionId) ?? 1) - 1;
    if (left > 0) open.set(sessionId, left);
    else open.delete(sessionId);
  }
}

async function streamRun(
  deps: EffectDeps,
  sessionId: string,
  request: () => Promise<unknown>,
): Promise<void> {
  let settleReady: (error?: Error) => void = () => {};
  const streamReady = new Promise<void>((resolve, reject) => {
    settleReady = (error) => error ? reject(error) : resolve();
  });
  const inbound = inboundFor(deps.api, deps.dispatch, sessionId);
  const stream = deps.api.streamExecution(sessionId, inbound.execution(), settleReady);
  // Surface a failed connection while it is still being established.
  void stream.catch(settleReady);
  try {
    await streamReady;
    await request();
  } catch (err) {
    // Nothing else holds this socket; left open it outlives the failed run.
    // Closed by handle: a newer stream on this session is not ours to end.
    deps.api.closeExecutionStream(stream);
    throw err;
  }
  if (await stream === 'lost') deps.dispatch({ type: 'executionLost', sessionId });
}

// ── Following the session ────────────────────────────────────────────────────

const follows = new WeakMap<object, { sessionId: string; follow: SessionFollow; opened: boolean }>();
const runStreams = new WeakMap<object, Map<string, number>>();
/** Consecutive reconnects that failed before opening, for the backoff. */
const followFailures = new WeakMap<object, number>();
const followRetryTimers = new WeakMap<object, { sessionId: string; timer: ReturnType<typeof setTimeout> }>();
/** Per client, the newest preview read it started; answers carry the number they answer. */
const previewReads = new WeakMap<object, number>();
/** Per client, the newest settings read it started; an older answer must not paint over a newer one (ADR-0030). */
const settingsReads = new WeakMap<object, number>();

type SettingsAnswer = Awaited<ReturnType<OrdewellApi['getSettings']>>;

function nextSettingsRead(api: object): number {
  const read = (settingsReads.get(api) ?? 0) + 1;
  settingsReads.set(api, read);
  return read;
}

/** One settings answer, numbered so an older read cannot replace a newer one. */
function dispatchSettings(deps: EffectDeps, settings: Partial<SettingsAnswer>, sessionId?: string, read = nextSettingsRead(deps.api)): void {
  deps.dispatch({ type: 'settingsLoaded', settings, read, ...(sessionId ? { sessionId } : {}) });
}
const FOLLOW_RETRY_MS = 500;
const FOLLOW_RETRY_MAX_MS = 8_000;

function runStreamsOf(api: object): Map<string, number> {
  let open = runStreams.get(api);
  if (!open) {
    open = new Map();
    runStreams.set(api, open);
  }
  return open;
}

/** Drop a pending reconnect — the api's own, or only the one for `sessionId`. Says whether one went. */
function cancelFollowRetry(api: object, sessionId?: string): boolean {
  const pending = followRetryTimers.get(api);
  if (pending === undefined || (sessionId !== undefined && pending.sessionId !== sessionId)) return false;
  clearTimeout(pending.timer);
  followRetryTimers.delete(api);
  return true;
}

/**
 * Reopen a follow the daemon dropped, backing off while it stays down. The
 * session the TUI shows must keep following it: a run started by the daemon's
 * own timer or by another client broadcasts to sockets only, so an idle TUI
 * that gave up would never see it. Timers are unref'd, so a pending reconnect
 * does not hold the process open.
 */
function scheduleFollowRetry(deps: EffectDeps, sessionId: string, failures: number): void {
  cancelFollowRetry(deps.api);
  const delay = Math.min(FOLLOW_RETRY_MS * 2 ** Math.min(failures, 4), FOLLOW_RETRY_MAX_MS);
  const timer = setTimeout(() => {
    followRetryTimers.delete(deps.api);
    // A send, a load or a new session reopened it meanwhile: that follow owns the session now.
    if (follows.get(deps.api) !== undefined) return;
    void follow(deps, sessionId, true).catch(() => {});
  }, delay);
  timer.unref?.();
  followRetryTimers.set(deps.api, { sessionId, timer });
}

/**
 * Holds the TUI's one standing subscription, to the session it shows. A run's
 * own stream exists only around a request this surface made, and the planning
 * one only around a turn; a run started by anyone else — autorun as the turn
 * ends, the planner's `run_plan`, the supervisor after the last task settled —
 * was broadcast into nothing. Ensured before each request, for the reason
 * `withExecutionStream` subscribes first; anchored to the client, like
 * `inboundFor`, so a new daemon connection starts clean.
 */
async function follow(deps: EffectDeps, sessionId: string, restored = false): Promise<void> {
  const current = follows.get(deps.api);
  if (current?.sessionId === sessionId) {
    await current.follow.ready;
    return;
  }
  current?.follow.close();
  cancelFollowRetry(deps.api);
  const inbound = inboundFor(deps.api, deps.dispatch, sessionId);
  const entry = { sessionId, follow: deps.api.followSession(sessionId, inbound.execution()), opened: false };
  follows.set(deps.api, entry);
  void entry.follow.ended.then((outcome) => {
    if (follows.get(deps.api) !== entry) return;
    follows.delete(deps.api);
    if (outcome !== 'lost') return;
    const failures = followFailures.get(deps.api) ?? 0;
    // One notice per outage: a daemon that stays down would otherwise add a
    // line every backoff interval. A run's own stream says so itself when it
    // goes with the daemon; two notices for one loss is noise.
    if (failures === 0 && !runStreamsOf(deps.api).has(sessionId)) deps.dispatch({ type: 'followLost', sessionId });
    followFailures.set(deps.api, failures + 1);
    scheduleFollowRetry(deps, sessionId, failures);
  });
  entry.opened = await entry.follow.ready;
  if (!entry.opened) return;
  followFailures.delete(deps.api);
  // A turn whose reply was lost has no `planner_turn_ended` to settle it; a
  // reconnect is the moment the session can be read back for its end.
  if (restored) deps.dispatch({ type: 'followRestored', sessionId });
}

function unfollow(deps: EffectDeps, sessionId: string): void {
  // A follow that was already lost leaves no entry behind, only its retry. That
  // timer must not reopen a session the user is closing, so it is cancelled
  // whether or not there is still a socket to close.
  const retried = cancelFollowRetry(deps.api, sessionId);
  const current = follows.get(deps.api);
  if (current?.sessionId !== sessionId) {
    if (retried) followFailures.delete(deps.api);
    return;
  }
  follows.delete(deps.api);
  followFailures.delete(deps.api);
  current.follow.close();
}

/**
 * One planner turn: its messages stream over the websocket while the REST call
 * is in flight, and the reply is either a question or a plan.
 */
async function converse(deps: EffectDeps, sessionId: string, call: () => Promise<unknown>, opening = false): Promise<void> {
  const inbound = inboundFor(deps.api, deps.dispatch, sessionId);
  const stream = deps.api.streamPlanning(sessionId, inbound.planning());
  let lost: string | null = null;
  // A reply that arrived but could not be used or shown. The daemon took the
  // turn and answered it, so it is its own error, not a loss: the session stays.
  let unusable: { err: unknown; shown: boolean } | null = null;

  try {
    await Promise.all([stream.ready, follow(deps, sessionId)]);
    const sentAt = Date.now();
    let plan: unknown;
    try {
      plan = await call();
    } catch (err) {
      // Only a failure of the call itself can leave the turn running: one
      // before it went out, or one the daemon answered, is the turn's own end.
      if (err instanceof UnreadableResponseError) unusable = { err, shown: false };
      else if (deliveryOf(err) === 'unknown') lost = describeLoss(err, Date.now() - sentAt);
      else throw err;
    }
    if (lost === null && unusable === null) {
      try {
        inbound.flush();
        // Speak the turn before `planUpdated` settles it: the settle is also what
        // drains the next queued prompt, so the reply would otherwise land after
        // the prompt that queue sent, in the wrong order. The socket usually
        // delivered the same words; the backfill is dropped when it did.
        for (const reply of turnReplies(plan)) inbound.backfill(reply.content, reply.timestamp, reply.runs);
        deps.dispatch({ type: 'planUpdated', plan, sessionId });
      } catch (err) {
        unusable = { err, shown: true };
      }
    }
  } finally {
    inbound.flush();
    stream.close();
  }
  if (unusable) {
    const { err, shown } = unusable;
    deps.dispatch({ ...failedFrom(shown ? new Error(`The planner's reply arrived but could not be shown: ${explain(err)}`) : err), turn: true, sessionId });
  } else if (lost !== null) {
    await settleLostReply(deps, sessionId, { opening, reason: lost });
  }
  // A turn's gate can have re-probed a signed-out planner and found it signed
  // in outside the TUI; the welcome line and picker still hold the old verdict.
  // A reload that fails is not the turn's failure.
  try {
    await loadRunners(deps);
  } catch {
    // The turn's own outcome stands; the next refresh asks again.
  }
}

/**
 * Why a request that went out got no answer, in a few words and without the
 * request: the error's name or code, how long it waited and, for a timeout, the
 * bound it hit — when the request had one. What the user needs to tell a
 * configured bound from a reset, and a turn's own end from either.
 */
function describeLoss(err: unknown, elapsedMs: number): string {
  const waited = `after ${formatElapsed(elapsedMs)}`;
  if (err instanceof RequestTimeoutError) {
    if (err.timeoutMs === undefined) return `timed out ${waited}, no bound configured`;
    const bound = `${formatElapsed(err.timeoutMs)}${err.viaEnv ? ' from ORDEWELL_HTTP_TIMEOUT_MS' : ''}`;
    return `timed out ${waited}, limit ${bound}`;
  }
  const code = (err as { code?: unknown } | null)?.code;
  const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 80);
  const named = typeof code === 'string' && !message.includes(code) ? `${code}: ${message}` : message;
  return `${named} ${waited}`;
}

function formatElapsed(ms: number): string {
  return ms < 10_000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 1000)} s`;
}

/**
 * The reply to a planner turn's call never came back, so whether the turn is
 * running, finished or never arrived is the daemon's to say. The session and
 * the queue stay as they are, nothing is sent again, and the session is read
 * back to show what the daemon holds. Cleared only when the daemon holds none.
 */
async function settleLostReply(deps: EffectDeps, sessionId: string, how: { opening: boolean; reason: string }): Promise<void> {
  deps.dispatch({ type: 'turnLost', sessionId, reason: how.reason });
  await readBackSession(deps, sessionId, { opening: how.opening, turnEnded: false, reason: how.reason });
}

/**
 * Adopting a live session returns the daemon's current state without
 * disturbing it. `turnEnded` is whether the stream has already said the turn is
 * over: only then is a failure to read back one that ends it.
 */
async function readBackSession(deps: EffectDeps, sessionId: string, how: { opening: boolean; turnEnded: boolean; reason?: string }): Promise<void> {
  try {
    const { plan, plannerTurnId, plannerCompaction } = await deps.api.adoptSession(sessionId, deps.workspace);
    deps.dispatch({
      type: 'turnReconciled', plan, plannerTurnId, ...(plannerCompaction ? { plannerCompaction } : {}),
      chat: restoredChat(plan, sessionId), sessionId, ...(how.reason ? { reason: how.reason } : {}),
    });
    // A daemon that had dropped the session re-adopted it from the file: its
    // run settings may be the file's now, not the copy this view held (ADR-0030).
    await reloadSettings(deps, sessionId);
  } catch (err) {
    if (err instanceof DaemonError && err.code === 'session_not_found' && how.opening) {
      unfollow(deps, sessionId);
      deps.dispatch({ type: 'sessionCleared', sessionId });
      deps.dispatch({ type: 'failed', message: 'The reply was lost and the server holds no session for it. Send your goal again to start over.', code: err.code, turn: true, sessionId });
      return;
    }
    if (how.turnEnded || (err instanceof DaemonError && err.code === 'session_not_found')) {
      deps.dispatch({ ...failedFrom(err), turn: true, sessionId });
      return;
    }
    deps.dispatch({ type: 'notice', level: 'error', message: `Could not read the session back from the server: ${explain(err)}`, sessionId });
  }
}

/** The conversation a saved plan reopens with: its transcript, research log and token line. */
function restoredChat(plan: unknown, sessionId: string): ChatRestored {
  const saved = plan as Pick<SurfacePlan, 'conversationHistory' | 'researchLog' | 'plannerUsage' | 'pendingTurns'> | null;
  return {
    type: 'chatRestored',
    history: saved?.conversationHistory ?? [],
    ...(saved?.researchLog ? { researchLog: saved.researchLog } : {}),
    ...(saved?.plannerUsage ? { plannerUsage: saved.plannerUsage } : {}),
    ...(saved?.pendingTurns ? { pendingTurns: saved.pendingTurns } : {}),
    sessionId,
  };
}

/**
 * The replies the turn settled on, in order, each with the timestamp and runs a
 * socket copy of it would carry. Only a plain entry is a reply: the markers a
 * turn leaves after it — a plan committed, a run autorun started, a skill
 * loaded — are drawn by their own broadcasts, and spoken here they were a
 * second planner line. Nothing before the user's message is this turn's.
 */
function turnReplies(plan: unknown): Array<Pick<SerializedConversationMessage, 'content' | 'runs'> & { timestamp?: string }> {
  const history = (plan as Pick<SurfacePlan, 'conversationHistory'> | null)?.conversationHistory ?? [];
  const replies: Array<Pick<SerializedConversationMessage, 'content' | 'runs'> & { timestamp?: string }> = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (isUserMessage(entry)) break;
    if (entry.role === 'assistant' && entry.kind === undefined) {
      const { content, timestamp, runs } = entry;
      replies.unshift({ content, ...(timestamp ? { timestamp } : {}), ...(runs ? { runs } : {}) });
    }
  }
  return replies;
}

async function refreshPlan(deps: EffectDeps, sessionId: string): Promise<void> {
  const { plan, run } = await deps.api.getSession(sessionId, deps.workspace);
  // Not `planUpdated`: that is a turn's end, and a refresh can land in the middle of one.
  deps.dispatch({ type: 'planRefreshed', plan, sessionId });
  // The Session's own word on the run, isolation marks and handoff included.
  if (run) deps.dispatch({ type: 'runSnapshot', view: run, sessionId });
}

async function loadModels(deps: EffectDeps): Promise<void> {
  deps.dispatch({ type: 'modelsLoaded', ...normalizeCatalog(await deps.api.getModels()) });
}

async function loadSessions(deps: EffectDeps): Promise<void> {
  const sessions = await deps.api.getSessions(deps.workspace);
  const list: SessionView[] = sessions.map((s) => ({
    id: String(s.id),
    goal: String(s.goal ?? ''),
    taskCount: Number(s.taskCount ?? 0),
    status: String(s.status ?? ''),
    createdAt: String(s.createdAt ?? ''),
  }));
  deps.dispatch({ type: 'sessionsLoaded', sessions: list });
}

async function loadRunners(deps: EffectDeps): Promise<RunnersResponse> {
  const state = await deps.api.getRunners();
  deps.dispatch({
    type: 'runnersLoaded',
    // The daemon's own rows, auth included: re-typing the bag here is how the
    // login verdict used to get dropped before any surface could flag it.
    runners: state.runners ?? [],
    orchestratorModel: state.orchestratorModel,
  });
  return state;
}

async function loadSettings(deps: EffectDeps, sessionId?: string): Promise<void> {
  const read = nextSettingsRead(deps.api);
  const settings = await deps.api.getSettings(sessionId);
  dispatchSettings(deps, settings, sessionId, read);
}

/**
 * A lifecycle's own settings read. The session already opened, adopted or
 * closed, so a read that fails must not undo that: a later refresh asks again.
 */
async function reloadSettings(deps: EffectDeps, sessionId?: string): Promise<void> {
  try {
    await loadSettings(deps, sessionId);
  } catch {
    // The session itself is the operation that mattered; the panel keeps what it has.
  }
}

/**
 * Reads what the welcome says about repositories and branches. Reads can
 * overlap (launch, a settings change, a refresh); each gets a number the
 * reducer compares, so a slower older answer cannot replace a newer one.
 * A refused connection is left to the caller's revive-and-retry; any other
 * failure is a `failed` preview, never a claim that there is no repository.
 */
async function loadIsolationPreview(deps: EffectDeps): Promise<void> {
  const read = (previewReads.get(deps.api) ?? 0) + 1;
  previewReads.set(deps.api, read);
  deps.dispatch({ type: 'isolationPreviewLoading', read });
  try {
    const { preview } = await deps.api.getIsolationPreview(deps.workspace);
    deps.dispatch({ type: 'isolationPreviewLoaded', preview, read });
  } catch (err) {
    if (isConnectionRefused(err)) throw err;
    deps.dispatch({ type: 'isolationPreviewFailed', message: explain(err), read });
  }
}
