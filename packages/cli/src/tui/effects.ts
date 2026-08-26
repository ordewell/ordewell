import { execSync } from 'child_process';
import { ALL_PROVIDERS, clipboardCopyCommand, isCliProvider, truncateCheckpointSummary, type AiProvider, type ConversationMessage, type HasBinFn, type PlannerModelRecall } from '@ordewell/core';
import { summarizeToolCall } from '@ordewell/core/plan-utils';
import { describeConnectionRefused, isConnectionRefused } from '../daemonClient';
import { normalizeCatalog } from '../catalog';
import { describePlannerSwitch } from '../plannerModelSwitch';
import type { Action, Effect } from './reducer';
import type { SessionView } from './state';
import type { WsEvent } from '../apiClient';

/** The slice of the daemon client the TUI needs; `ApiClient` satisfies it. */
export interface OrdewellApi {
  startConversation(sessionId: string, goal: string, runners: string[] | undefined, workspace: string): Promise<any>;
  sendConversationMessage(sessionId: string, message: string): Promise<any>;
  executePlan(sessionId: string): Promise<{ status: string }>;
  stopExecution(sessionId: string): Promise<{ status: string }>;
  cancelPlanning(sessionId: string): Promise<{ cancelled: boolean }>;
  processQueued(sessionId: string): Promise<{ ok: boolean }>;
  taskControl(sessionId: string, taskId: string, action: 'force-start' | 'retry' | 'cancel'): Promise<{ ok: boolean }>;
  markTaskComplete(sessionId: string, taskId: string): Promise<{ ok: boolean }>;
  markTaskIncomplete(sessionId: string, taskId: string): Promise<{ ok: boolean }>;
  addTask(sessionId: string, task: Record<string, unknown>): Promise<{ ok: boolean }>;
  updateTask(sessionId: string, taskId: string, changes: Record<string, unknown>): Promise<{ ok: boolean }>;
  removeTask(sessionId: string, taskId: string): Promise<{ ok: boolean }>;
  getSessions(workspace?: string): Promise<any[]>;
  getSession(sessionId: string, workspace?: string): Promise<{ meta: any; plan: any }>;
  adoptSession(sessionId: string, workspace?: string): Promise<{ plan: any; goal: string }>;
  deleteSession(sessionId: string, workspace?: string): Promise<{ ok: boolean }>;
  closeSession(sessionId: string): Promise<{ ok: boolean }>;
  getSettings(): Promise<Record<string, unknown>>;
  updateSettings(changes: Record<string, unknown>): Promise<Record<string, unknown>>;
  sendCommand(name: string, args?: Record<string, string>): Promise<{ ok: boolean; settings?: Record<string, unknown> }>;
  getRunners(): Promise<{ runners: { id: string; name: string; enabled: boolean }[]; orchestratorModel: string }>;
  setRunnerEnabled(runner: string, enabled: boolean): Promise<{ ok: boolean }>;
  getModels(): Promise<{
    models: any[];
    modelsByRunner?: Record<string, any[]>;
    modesByRunner?: Record<string, any[]>;
    providers?: string[];
    orchestratorModels?: any[];
    providerErrors?: Record<string, string>;
  }>;
  streamPlanning(sessionId: string, onEvent: (event: WsEvent) => void): { close: () => void };
  respondToApproval(sessionId: string, approvalId: string, granted: boolean): Promise<{ ok: boolean }>;
  /** Opens the execution stream. `onReady` runs only once the subscription is live. */
  streamExecution(sessionId: string, onEvent: (event: WsEvent) => void, onReady?: (error?: Error) => void): Promise<void>;
}

export interface EffectDeps {
  api: OrdewellApi;
  workspace: string;
  /** Serializes planner turns so a follow-up cannot race session creation. */
  conversationQueue: ConversationQueue;
  /** The local daemon's port — also the tmux session a task's terminal lives in. */
  port: number;
  dispatch(action: Action): void;
  newSessionId(): string;
  /** Persists to the resolved `.env` and to `process.env`. */
  setEnvVar(key: string, value: string): void;
  /**
   * Brings the daemon back after it has gone away, resolving to whether it is
   * now answering. The TUI outlives its daemon in every direction — the daemon
   * can crash, another client can `ordewell stop --server`, a rebuild can be
   * followed by a manual restart — and `ensureDaemonOwned` runs once, at
   * launch. Without this the session is dead from the first refused connection
   * onward, with no way back short of quitting.
   */
  reviveDaemon(): Promise<boolean>;
  /** Opens a real OS terminal attached to a task's tmux window, if it has one. */
  openTerminal(sessionId: string, taskId: string): Promise<{ ok: boolean; message: string }>;
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
  /** Writes raw bytes to the terminal — the OSC 52 fallback's only route out. */
  writeTerminal(data: string): void;
  exit(): void;
}

/**
 * A planner conversation accepts one turn at a time. In particular, the
 * daemon only registers a newly-created session once its first turn returns,
 * so a second request must wait rather than receive a misleading 404.
 */
export class ConversationQueue {
  private tail: Promise<void> = Promise.resolve();
  private active = false;

  enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = () => {
      try {
        return Promise.resolve(work());
      } catch (error) {
        return Promise.reject(error);
      }
    };

    const result = this.active ? this.tail.then(run) : run();
    this.active = true;
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.tail = settled;
    void settled.then(() => {
      if (this.tail === settled) this.active = false;
    });
    return result;
  }
}

/**
 * Performs one effect and feeds results back as actions. Every path is
 * caught: a daemon hiccup becomes an error turn in the transcript, never an
 * unhandled rejection that tears down the raw-mode terminal.
 */
export async function runEffect(effect: Effect, deps: EffectDeps): Promise<void> {
  const isConversationTurn = effect.type === 'startConversation' || effect.type === 'sendMessage';
  const run = () => {
    const work = () => perform(effect, deps);
    return isConversationTurn ? deps.conversationQueue.enqueue(work) : work();
  };

  try {
    await run();
  } catch (err) {
    if (!isConnectionRefused(err)) {
      const message = err instanceof Error ? err.message : String(err);
      deps.dispatch({ type: 'failed', message: explain(message) });
      return;
    }

    // Refused at the handshake means the request never reached a server, so
    // replaying it cannot be a second execution — which is the whole reason
    // only this one errno is retried. See `isConnectionRefused`.
    let revived = false;
    try {
      revived = await deps.reviveDaemon();
    } catch {
      revived = false;
    }

    if (!revived) {
      deps.dispatch({ type: 'failed', message: describeConnectionRefused(deps.port) });
      return;
    }

    deps.dispatch({ type: 'notice', message: 'The server had stopped; started a new one and retried.' });
    try {
      await run();
    } catch (retryErr) {
      const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
      deps.dispatch({
        type: 'failed',
        // A fresh daemon holds no sessions, so the retry of anything
        // session-scoped legitimately 404s. Say which of the two happened.
        message: isConnectionRefused(retryErr) ? describeConnectionRefused(deps.port) : explain(message),
      });
    }
  }
}

/**
 * Loading a session adopts it, so a 404 here means the daemon dropped it —
 * almost always a restart. Reloading re-adopts it; say so rather than passing
 * the daemon's bare wording through.
 */
function explain(message: string): string {
  if (message === 'Session not found') {
    return 'This server is no longer holding that session — it was probably restarted. Reload it with /sessions.';
  }
  return message;
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
      return `Using its default model, ${recall.model} — pick another with /model.`;
    case 'none':
      return 'Pick a model with /model.';
  }
}

async function perform(effect: Effect, deps: EffectDeps): Promise<void> {
  const { api, dispatch, workspace } = deps;

  switch (effect.type) {
    case 'startConversation': {
      const sessionId = deps.newSessionId();
      dispatch({ type: 'sessionStarted', sessionId, goal: effect.goal });
      try {
        await converse(deps, sessionId, () => api.startConversation(sessionId, effect.goal, undefined, workspace));
      } catch (err) {
        // The daemon registers a session only after planning succeeds, so this
        // id points at nothing — keeping it would 404 every following message.
        dispatch({ type: 'sessionCleared' });
        throw err;
      }
      return;
    }

    case 'sendMessage':
      await converse(deps, effect.sessionId, () => api.sendConversationMessage(effect.sessionId, effect.message));
      return;

    case 'execute':
      await withExecutionStream(deps, effect.sessionId, () => api.executePlan(effect.sessionId));
      return;

    case 'stopExecution':
      await api.stopExecution(effect.sessionId);
      dispatch({ type: 'notice', message: 'Execution stopped.' });
      return;

    case 'cancelPlanning': {
      const { cancelled } = await api.cancelPlanning(effect.sessionId);
      // Nothing to cancel — the turn already settled (a race with the daemon,
      // not a stale request), and its own planner_message/planUpdated already
      // carries whatever feedback there is.
      if (cancelled) dispatch({ type: 'notice', message: 'Planning stopped.' });
      return;
    }

    case 'processQueued':
      await api.processQueued(effect.sessionId);
      await refreshPlan(deps, effect.sessionId);
      return;

    case 'taskAction': {
      const { sessionId, taskId, action } = effect;
      // The daemon has no skip endpoint: the VS Code extension implements skip
      // as "mark it done and move on", so the TUI does the same thing.
      const request =
        action === 'complete' || action === 'skip'
          ? () => api.markTaskComplete(sessionId, taskId)
          : action === 'uncomplete'
            ? () => api.markTaskIncomplete(sessionId, taskId)
            : () => api.taskControl(sessionId, taskId, action);
      // A spawning action (see `taskActionEffect`) reports its progress the same
      // way a whole run does, so it needs the same stream open around it.
      await (effect.watch ? withExecutionStream(deps, sessionId, request) : request());
      await refreshPlan(deps, sessionId);
      return;
    }

    case 'addTask':
      await api.addTask(effect.sessionId, {
        title: effect.title,
        description: effect.title,
        prompt: effect.title,
        type: 'ai',
      });
      await refreshPlan(deps, effect.sessionId);
      return;

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
        dispatch({ type: 'failed', message: 'Could not deliver the approval answer — the planner will treat it as denied.' });
      }
      return;
    }

    case 'openTaskTerminal': {
      const result = await deps.openTerminal(effect.sessionId, effect.taskId);
      dispatch(result.ok ? { type: 'notice', message: result.message } : { type: 'failed', message: result.message });
      return;
    }

    case 'command': {
      const result = await api.sendCommand(effect.name, { action: effect.action });
      if (result.settings) dispatch({ type: 'settingsLoaded', settings: result.settings });
      dispatch({ type: 'notice', message: `${effect.name} is ${effect.action}.` });
      return;
    }

    case 'setModel':
      // Daemon first, `.env` second — see `persistAfterDaemon` below.
      await api.updateSettings({ orchestratorModel: effect.modelId });
      deps.setEnvVar('ORCHESTRATOR_MODEL', effect.modelId);
      dispatch({ type: 'settingsLoaded', settings: { orchestratorModel: effect.modelId } });
      dispatch({ type: 'notice', message: `Orchestrator model set to ${effect.modelId}.` });
      return;

    case 'setPlanner': {
      const meta = ALL_PROVIDERS[effect.provider as AiProvider];
      if (!meta) throw new Error(`Unknown planner: ${effect.provider}`);
      // Pushed to the live daemon and written to .env, like every other
      // provider setting. The daemon builds a fresh config per session, so the
      // switch lands on the next plan without a restart. Only the provider is
      // ours to send — the daemon resolves what its model and effort should
      // become (remembered for it, that backend's catalog default, or
      // nothing) and this consumes whatever comes back.
      const env: Record<string, string> = { AI_PROVIDER: effect.provider };
      const settings = await api.updateSettings({ env });
      const recall = describePlannerSwitch(settings, effect.provider as AiProvider);
      persistAfterDaemon(deps, { ...env, ORCHESTRATOR_MODEL: recall.model, ORDEWELL_PLANNER_EFFORT: recall.effort });
      dispatch({
        type: 'settingsLoaded',
        settings: { aiProvider: effect.provider, orchestratorModel: recall.model, plannerThinkingEffort: recall.effort },
      });
      dispatch({
        type: 'notice',
        message: `${isCliProvider(effect.provider as AiProvider)
          ? `Planning with ${meta.label} — no API key needed.`
          : `Planner set to ${meta.label}.`} ${plannerModelNotice(recall)}`,
      });
      await loadModels(deps);
      return;
    }

    case 'setPlannerEffort':
      await api.updateSettings({ env: { ORDEWELL_PLANNER_EFFORT: effect.effort } });
      deps.setEnvVar('ORDEWELL_PLANNER_EFFORT', effect.effort);
      dispatch({ type: 'settingsLoaded', settings: { plannerThinkingEffort: effect.effort } });
      dispatch({ type: 'notice', message: `Planner effort set to ${effect.effort || 'the runner default'}.` });
      return;

    case 'setApiKey': {
      const meta = ALL_PROVIDERS[effect.provider as AiProvider];
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
      dispatch({ type: 'settingsLoaded', settings });
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

    case 'setAutonomous':
      deps.setEnvVar('ORDEWELL_AUTONOMOUS_MODE', String(effect.enabled));
      dispatch({ type: 'notice', message: `Autonomous mode ${effect.enabled ? 'on' : 'off'}.` });
      return;

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
      // Adopting registers the session with the daemon, which is what makes the
      // restored plan executable — `getSession` alone only reads the file.
      const { plan, goal } = await api.adoptSession(effect.sessionId, workspace);
      dispatch({ type: 'sessionStarted', sessionId: effect.sessionId, goal });
      dispatch({ type: 'chatRestored', history: (plan as { conversationHistory?: ConversationMessage[] }).conversationHistory ?? [], sessionId: effect.sessionId });
      dispatch({ type: 'planUpdated', plan, sessionId: effect.sessionId });
      dispatch({ type: 'notice', message: `Loaded "${goal || effect.sessionId}".` });
      return;
    }

    case 'deleteSession':
      await api.deleteSession(effect.sessionId, workspace);
      await loadSessions(deps);
      dispatch({ type: 'notice', message: `Deleted ${effect.sessionId}.` });
      return;

    case 'saveSession':
      // Plans are persisted server-side as they change; this only confirms it.
      dispatch({ type: 'notice', message: `Session ${effect.sessionId} saved.` });
      return;

    case 'closeSession':
      // Local state already moved on; a failure here must not surface as an
      // error in the new session's transcript.
      try {
        await api.closeSession(effect.sessionId);
      } catch {
        // ignore
      }
      return;

    case 'refresh':
      await Promise.all([loadRunners(deps), loadSettings(deps), loadModels(deps)]);
      dispatch({ type: 'notice', message: 'Refreshed runners, settings and models.' });
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
      deps.dispatch({ type: 'notice', message: `Copied ${lines} ${lines === 1 ? 'line' : 'lines'}.` });
      return;
    } catch {
      // fall through to OSC 52
    }
  }

  deps.writeTerminal(osc52(text));
  deps.dispatch({
    type: 'notice',
    message: `Copied ${lines} ${lines === 1 ? 'line' : 'lines'} through the terminal — no clipboard tool here (pbcopy, xclip, xsel or wl-copy), so it only lands if your terminal supports OSC 52.`,
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
  let settleReady: (error?: Error) => void = () => {};
  const streamReady = new Promise<void>((resolve, reject) => {
    settleReady = (error) => error ? reject(error) : resolve();
  });
  const stream = deps.api.streamExecution(
    sessionId,
    (event) => onExecutionEvent(deps.dispatch, event, sessionId),
    settleReady,
  );
  // Surface a failed connection while it is still being established.
  void stream.catch(settleReady);
  await streamReady;
  await request();
  await stream;
}

/**
 * One planner turn: research progress streams over the websocket while the
 * REST call is in flight, and the reply is either a question or a plan.
 */
async function converse(deps: EffectDeps, sessionId: string, call: () => Promise<any>): Promise<void> {
  // What the socket already delivered for this turn. The plan the REST call
  // returns carries the same reply as its last assistant entry, so without this
  // the turn is spoken twice — see `alreadySpoken`, which catches the remaining
  // case of two subscriptions to one channel during a run.
  let streamed: string | null = null;

  // Rapid plan_token deltas are coalesced into one dispatch instead of one per
  // token — see layout.ts's array-identity memoization for the same reasoning.
  // Flushed immediately whenever a different event type lands in the same
  // callback, so dispatch order stays exactly chronological relative to those.
  const TOKEN_DEBOUNCE_MS = 75;
  let tokenBuffer = '';
  let tokenTimer: ReturnType<typeof setTimeout> | null = null;

  const flushTokens = (): void => {
    if (tokenTimer !== null) {
      clearTimeout(tokenTimer);
      tokenTimer = null;
    }
    if (!tokenBuffer) return;
    const text = tokenBuffer;
    tokenBuffer = '';
    deps.dispatch({ type: 'plannerToken', text, sessionId });
  };

  const stream = deps.api.streamPlanning(sessionId, (event) => {
    if (event?.type === 'plan_token' && event.token) {
      tokenBuffer += event.token;
      if (tokenTimer === null) {
        tokenTimer = setTimeout(flushTokens, TOKEN_DEBOUNCE_MS);
      }
      return;
    }
    flushTokens();
    if (event?.type === 'approval_request') {
      deps.dispatch({
        type: 'approvalRequested',
        sessionId,
        request: { id: event.id, kind: event.kind, subject: event.subject, scope: event.scope, detail: event.detail },
      });
      return;
    }
    if (event?.type === 'approval_settled') {
      deps.dispatch({ type: 'approvalSettled', sessionId, approvalId: event.id });
      return;
    }
    if (event?.type === 'approval_decided') {
      deps.dispatch({ type: 'notice', message: describeApprovalDecision(event) });
      return;
    }
    if (event?.type === 'research_step') {
      const summary = summarizeToolCall(event.tool, event.args || '{}', event.toolLabel);
      deps.dispatch({
        type: 'researchStep',
        summary: event.subagentId ? `↳ ${summary}` : summary,
        toolCallId: event.toolCallId,
        sessionId,
      });
      return;
    }
    if (event?.type === 'research_step_done' && event.step) {
      const step = event.step;
      const summary = summarizeToolCall(step.tool, step.args, step.toolLabel);
      deps.dispatch({
        type: 'researchStepDone',
        summary: event.subagentId ? `↳ ${summary}` : summary,
        toolCallId: step.toolCallId,
        outcome: step.outcome,
        result: step.result ?? '',
        sessionId,
      });
      return;
    }
    if (event?.type === 'planner_message') {
      streamed = String(event.content ?? '');
      deps.dispatch({ type: 'plannerMessage', content: streamed, sessionId });
      return;
    }
    if (event?.type === 'plan_thinking' && event.text) {
      deps.dispatch({ type: 'plannerThinking', text: event.text, sessionId });
    }
  });

  try {
    const plan = await call();
    deps.dispatch({ type: 'planUpdated', plan, sessionId });

    const question = lastAssistantMessage(plan);
    if (question && question !== streamed) {
      deps.dispatch({ type: 'plannerMessage', content: question, sessionId });
    }
  } finally {
    if (tokenTimer !== null) clearTimeout(tokenTimer);
    stream.close();
  }
}

/**
 * A decision reached with no round-trip prompt (pre-approved, remembered from
 * earlier this session, or the operator's mode floor) previously had no
 * transcript line at all — indistinguishable from the model never having
 * needed approval in the first place. One line, same channel as the
 * interactive verdict.
 */
function describeApprovalDecision(event: Extract<WsEvent, { type: 'approval_decided' }>): string {
  const label = event.source === 'pre-approved' ? 'pre-approved'
    : event.source === 'remembered' ? 'remembered'
    : event.source === 'mode' ? 'policy'
    : 'no approval channel';
  return `${event.granted ? 'Auto-approved' : 'Auto-denied'} (${label}): ${event.subject}`;
}

function lastAssistantMessage(plan: any): string | null {
  const history = (plan?.conversationHistory ?? []) as { role: string; content: string }[];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') return history[i].content;
  }
  return null;
}

/**
 * Maps the daemon's `SessionMessage` broadcast to actions. Task progress
 * arrives as a whole-plan `status_update`, not per-task events, so the pane is
 * re-synced from each snapshot rather than patched incrementally.
 */
function onExecutionEvent(dispatch: (action: Action) => void, event: WsEvent, sessionId: string): void {
  switch (event?.type) {
    case 'status_update': {
      const updates: Record<string, { status: string; idleSince?: string | null }> = {};
      for (const task of event.tasks ?? []) {
        updates[String(task.id)] = { status: String(task.status), idleSince: task.idleSince ?? null };
      }
      dispatch({ type: 'tasksStatus', updates, sessionId });
      return;
    }

    case 'task_started':
      dispatch({ type: 'researchStep', summary: `${event.title ?? event.taskId} · ${event.runner ?? ''}`.trim(), sessionId });
      return;

    // The extension shows these in its checkpoint panel; here they are
    // transcript lines, which is the TUI's equivalent surface.
    case 'checkpoint':
      dispatch({ type: 'notice', message: `· Checkpoint — ${event.taskTitle}: ${truncateCheckpointSummary(event.summary)}` });
      return;

    case 'approval_decided':
      dispatch({ type: 'notice', message: describeApprovalDecision(event) });
      return;

    case 'review_needed':
      dispatch({ type: 'notice', message: 'Plan needs your sign-off — /approve to continue.' });
      return;

    case 'review_approved':
      dispatch({ type: 'notice', message: 'Plan approved.' });
      return;

    case 'plan_generated':
      dispatch({ type: 'planUpdated', plan: event.plan, sessionId });
      return;

    case 'planner_message':
      dispatch({ type: 'plannerMessage', content: String(event.content ?? ''), sessionId });
      return;

    // The orchestrator paused fan-out because a structural edit is queued; drain
    // it so the planner reconciles the plan and dependents resume spawning.
    // Dropped on the floor, the queue suppresses every later tick() — which is
    // exactly "tasks did not fan out when the dependent ones finished."
    case 'queue_ready':
      dispatch({ type: 'queueReady', sessionId });
      return;

    case 'execution_complete':
      dispatch({ type: 'executionComplete', summary: event.summary, sessionId });
      return;

    // A stop carries no tally — the reducer counts the pane instead.
    case 'execution_stopped':
      dispatch({ type: 'executionComplete', stopped: true, sessionId });
      return;

    // task_output / plan_token / plan_thinking are raw runner chatter; the
    // status line and the plan pane already say everything the user needs.
    default:
      return;
  }
}

async function refreshPlan(deps: EffectDeps, sessionId: string): Promise<void> {
  const { plan } = await deps.api.getSession(sessionId, deps.workspace);
  deps.dispatch({ type: 'planUpdated', plan, sessionId });
}

async function loadModels(deps: EffectDeps): Promise<void> {
  deps.dispatch({ type: 'modelsLoaded', ...normalizeCatalog(await deps.api.getModels()) });
}

async function loadSessions(deps: EffectDeps): Promise<void> {
  const sessions = await deps.api.getSessions(deps.workspace);
  const list: SessionView[] = sessions.map((s: any) => ({
    id: String(s.id),
    goal: String(s.goal ?? ''),
    taskCount: Number(s.taskCount ?? 0),
    status: String(s.status ?? ''),
    createdAt: String(s.createdAt ?? ''),
  }));
  deps.dispatch({ type: 'sessionsLoaded', sessions: list });
}

async function loadRunners(deps: EffectDeps): Promise<void> {
  const state = await deps.api.getRunners();
  deps.dispatch({
    type: 'runnersLoaded',
    runners: (state.runners ?? []).map((r) => ({ id: r.id, name: r.name, enabled: r.enabled })),
    orchestratorModel: state.orchestratorModel,
  });
}

async function loadSettings(deps: EffectDeps): Promise<void> {
  deps.dispatch({ type: 'settingsLoaded', settings: await deps.api.getSettings() });
}
