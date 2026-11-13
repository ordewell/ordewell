import type {
  AdoptSessionResponse, AiProvider, AnswerEscalationRequest, ConversationForkResponse, ConversationRewindResponse, ExecutionCommand, GlobalRunSettings, MergeGateResponse, PlanResponse, RunnerId, RunTask,
  SessionHeld, SessionMessage, RunnerCommand, SessionResponse, SettingsResponse, SettingsUpdateResponse, StreamStamp, SurfacePlan,
  SurfacePlanState, Task,
} from '@ordewell/core';
import {
  checkoutRule, confirmedOverride, DELEGATION_OFFERED, loopRemovalRefusal, manualOverrideStopFirst, mergeTarget, overrideNeedsConfirmation,
  ReconnectBackoff, rejoinPlanTree, signInAction, signInOfVerdict, taskActionCommand, titledRefs, titledTaskRefOf, VENDORS, walkPlan, type OverrideDirection,
} from '@ordewell/core/plan-utils';
import { INITIAL_HOST_STATE, reduceHost, type ChatBridge, type HostState } from '@ordewell/ui';
import {
  DaemonSessionStream, SessionView, discardRunConfirmation, mergeAllConfirmation, mergeBesideOpsQuestion, mergePastChecksQuestion,
  overrideConfirmation, removeTaskConfirmation, revertConfirmation, runSettingRiskConfirmations, startPastGateConfirmation,
  type ConfirmationRequest, type DaemonFrame, type DaemonSessionState, type SessionCue,
} from '@ordewell/ui/host';
import {
  isBuiltinSlashCommand, resolveSlashAlias, slashHelp,
  type HostToWebview, type IsolationActionKind, type SettingsChange, type WebviewToHost,
} from '@ordewell/ui/protocol';
import { runnerName } from '@ordewell/ui/design';
import { confirm as askInWindow } from './ConfirmDialog';
import { askForKey, type KeyEntryAnswer, type KeyEntryRequest } from './KeyEntryDialog';
import { AgentDetection } from './agentDetection';
import { callDaemon, DaemonError, messageOf } from './daemon';
import { takeOverRefusal } from './holder';
import { openLoginTerminal, type OpenLoginTerminal } from './loginTerminal';
import { revealTask as revealInPlan } from './selection';
import { SIGN_IN_TIMEOUT, waitForSignIn } from './signInWait';
import { TaskLogHost } from './TaskLogHost';
import type { HolderView, JoinRefusal, JoinResult } from '../../shared/bridge';

/** What the frame shows of the session; the chat instances read their own state off the messages instead. */
export interface SessionSnapshotView {
  sessionId: string;
  goal: string;
  /** The chat's state as every message so far reduced it: the same fold each ChatApp makes. */
  state: HostState;
  /** Set when the daemon refused the lease: another host holds the session (#16 draws the banner). */
  held: SessionHeld | null;
  /** A saved session adopted from disk whose run was not live when this daemon opened it (W17). */
  restored: boolean;
  /** The saved state of a session another host holds: drawn, and nothing writes (W16). */
  readOnly: boolean;
  /** How this window reaches a session another Ordewell daemon holds (W16, ADR-0063 H8); null for its own sessions and a VS Code holder. */
  link: HeldLink | null;
}

/**
 * The window's tie to the daemon that holds its session. *Joined* drives the
 * session through that daemon, live; *refused* says why it could not and
 * shows the saved state instead; *gone* is a holder that exited, whose session
 * nothing runs until the person continues it here.
 */
export type HeldLink =
  | { kind: 'joining'; port: number }
  /** `away`: its socket dropped and its daemon does not answer yet, while its pid still holds the lease. */
  | { kind: 'joined'; holder: HolderView; away?: boolean }
  | { kind: 'refused'; reason: JoinRefusal; message: string }
  | { kind: 'gone'; holder: HolderView };

/** What only the frame can do for the session: open a tab, a file, the plan panel. */
export interface SessionNavigator {
  openTask(taskId: string, view: 'chat' | 'changes', options?: { preview?: boolean }): void;
  openFile(path: string): void;
  /** Dock the plan panel, or open it as a drawer where the window is too narrow for it. */
  showPlan(): void;
  /** Show the workspace's sessions, for the chat's own Load session. */
  showSessions?(): void;
  /** Open the Settings tab, where the chat's /planner and /allowlist pick. */
  showSettings?(): void;
}

/** What the Changes view does for the session: show the run's review, and Merge all behind its preflight. */
export interface Reviewer {
  open(): void;
  mergeAll(): Promise<void>;
}

export type Confirm = <C extends string>(request: ConfirmationRequest<C>) => Promise<C | null>;

/**
 * What the workspace's agent detection says: it holds across a session switch,
 * held or joined, because no session changes which agents are installed. The
 * settings detection reads with them go too, since a mounted chat's state
 * keeps them across a switch and a chat that mounts later must match it.
 */
const CATALOG: ReadonlySet<HostToWebview['type']> = new Set<HostToWebview['type']>([
  'setRunners', 'setModels', 'setModelsByRunner', 'setModesByRunner', 'setConfiguredProviders', 'setModelConfig',
  'setPlannerBackends', 'agentDetection', 'setModelDiscoveryErrors', 'setModelOptions', 'setModelAllowlist', 'setRunSettings',
]);

// The last of each of these says all there is: a chat that mounts after it was sent is given it again.
const STICKY: ReadonlySet<HostToWebview['type']> = new Set<HostToWebview['type']>([
  'setState', 'planUpdated', 'runView', 'runActivity', 'accountLimits', 'children', ...CATALOG,
]);

/** What Take over came to, said to the person either way (W16). */
export interface TakeOverOutcome {
  ok: boolean;
  message: string;
}

/** How often a read-only view reads the holder's saved state again: the file changes as the holder saves, never by a frame. */
const WATCH_MS = 2000;

const LOGIN_NO_TERMINAL = 'The login terminal could not be opened.';

/** Where the chat's dragged plan-dock height is kept between sessions, as VS Code keeps it in its global state. */
const PLAN_DOCK_HEIGHT_KEY = 'ordewell.planDockHeight';

/** A window with no storage (a test's jsdom) still keeps a height for its own session. */
const rememberedDockHeights = new Map<string, string>();

/** The app's own window storage; a test's jsdom has none, and Node's global one is not the window's. */
function windowStorage(): Storage | undefined {
  if (typeof window === 'undefined' || !window.navigator?.userAgent.includes('Electron')) return undefined;
  return window.localStorage;
}

function storedItem(key: string): string | null {
  return windowStorage()?.getItem(key) ?? rememberedDockHeights.get(key) ?? null;
}

function storeItem(key: string, value: string): void {
  windowStorage()?.setItem(key, value);
  rememberedDockHeights.set(key, value);
}

/** What a host may replace in a test, or let the window supply in the app. */
export interface DaemonHostOptions {
  detectionTimeoutMs?: number;
  watchMs?: number;
  /** The login terminal, from the view that can draw it; absent asks the registered opener. */
  openLogin?: OpenLoginTerminal;
  /** The key entry dialog; absent draws the window's own. */
  askForKey?: (request: KeyEntryRequest) => Promise<KeyEntryAnswer | null>;
  pollMs?: number;
  loginTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const SYSTEM_TASK_ACTIONS = {
  cancel: 'cancel',
  cancelResume: 'cancel-resume',
  resumeNow: 'resume-now',
  retry: 'retry',
  skip: 'skip',
} as const;

/** What a read-only view may still ask: local navigation, the catalog, and leaving for a new session. */
const READ_ONLY_ALLOWED: ReadonlySet<WebviewToHost['type']> = new Set<WebviewToHost['type']>([
  'ready', 'refreshModels', 'openTaskLog', 'openFile', 'getTaskCommands', 'newSession',
]);

function mintSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `session-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A saved session's phase-tagged plan as the chat draws a plan: its pending tasks and its execution log, joined. */
function planOfSaved(state: SurfacePlanState): SurfacePlan {
  const saved = state as unknown as { phase?: string; pendingTasks?: Task[]; executionLog?: Task[] };
  const tasks = rejoinPlanTree(saved.pendingTasks ?? [], saved.phase === 'executing' ? saved.executionLog ?? [] : []);
  const rest = { ...(state as unknown as Record<string, unknown>) };
  delete rest.pendingTasks;
  delete rest.executionLog;
  delete rest.phase;
  return { ...rest, tasks } as unknown as SurfacePlan;
}

/** The holder a load was refused for, when the refusal is the lease's (ADR-0049). */
function heldOf(error: unknown): SessionHeld | null {
  if (!(error instanceof DaemonError) || error.code !== 'session_held' || !isRecord(error.body) || !isRecord(error.body.sessionHeld)) return null;
  return error.body.sessionHeld as unknown as SessionHeld;
}

/** Whether anything has happened in this plan: a run, or a task that left `pending`. */
function hasRunHistory(plan: SurfacePlan): boolean {
  if (plan.status === 'running' || plan.status === 'completed') return true;
  return [...walkPlan(plan.tasks)].some(({ task }) => task.status !== 'pending' && task.status !== 'approved');
}

function isFrame(value: unknown): value is DaemonFrame {
  return isRecord(value) && typeof value.type === 'string';
}

/** The holder as a link to a gone one keeps it: the lease names who, and the version was never proved. */
function holderViewOf(record: SessionHeld['holder']): HolderView {
  const host = record.host;
  return {
    port: host?.kind === 'daemon' ? host.port : 0,
    pid: record.pid,
    ...(host?.kind === 'daemon' && host.ownerPid !== undefined ? { ownerPid: host.ownerPid } : {}),
    since: record.since,
  };
}

/**
 * Keeps the newest of one kind of read in flight at most once, with one more
 * queued behind it: plan cues come with every status tick of a run, and each
 * would otherwise be a read of its own.
 */
class Coalesced {
  private running = false;
  private again = false;
  constructor(private readonly run: () => Promise<void>) {}
  request(): void {
    if (this.running) { this.again = true; return; }
    this.running = true;
    void this.run().finally(() => {
      this.running = false;
      if (this.again) { this.again = false; this.request(); }
    });
  }
}

/**
 * A daemon socket's stream that knows the session it follows may not exist on
 * disk yet. A new session's transcript is the planner's first turn, which the
 * socket is already streaming: redrawing from a load would wipe it, so while
 * the session is fresh only the run is taken from what was read.
 */
class SessionStream extends DaemonSessionStream {
  constructor(private readonly sessionView: SessionView, post: (msg: HostToWebview) => void, hooks: ConstructorParameters<typeof DaemonSessionStream>[2], private readonly fresh: () => boolean) {
    super(sessionView, post, hooks);
  }

  protected override loaded(state: DaemonSessionState): StreamStamp | undefined {
    if (!this.fresh()) return super.loaded(state);
    if (state.run) this.sessionView.adopt({ run: state.run });
    return undefined;
  }
}

/**
 * One workspace's session, as the desktop renderer follows it over the daemon
 * (ADR-0063): the host side of every chat instance's bridge, folding the
 * session socket through ui's {@link SessionView} as the extension host folds
 * its in-process Session, and answering each webview message with the daemon
 * route that does the same. The plan pane, the planner panel and each task tab
 * read the one session through it, so they never disagree about what it holds.
 */
export class DaemonHost {
  private readonly view: SessionView;
  private readonly ports = new Set<(msg: HostToWebview) => void>();
  private readonly sticky = new Map<HostToWebview['type'], HostToWebview>();
  private readonly taskLogs = new Map<string, TaskLogHost>();
  private readonly storeListeners = new Set<() => void>();
  private readonly reread = new Coalesced(() => this.readPlan());
  private snapshot: SessionSnapshotView;
  private stream: SessionStream | null = null;
  private unsubscribe: (() => void) | null = null;
  /** A session the planner is starting: the daemon has no file for it until its first turn returns. */
  private fresh = true;
  /**
   * Planner turns in flight, by the session each was asked in: a switch does
   * not end the last session's turn, and its end must not count against the
   * next session's.
   */
  private readonly turns = new Map<string, number>();
  private catalogRead = false;
  private readonly agents: AgentDetection;
  /** What each chat instance keeps across a remount, by the place it is drawn in. */
  private readonly savedStates = new Map<string, unknown>();
  private rejoin: (() => void) | null = null;
  private readonly rejoinBackoff = new ReconnectBackoff();
  /** Continue here is adopting the session: a second click is the same takeover, not another. */
  private continuing = false;
  private navigator: SessionNavigator | null = null;
  /** The Changes view's review of the run and its preflighted Merge all (#19); absent while that view is not registered. */
  private reviewer: Reviewer | null = null;
  /** Text for the planner's composer that no planner chat was mounted to take yet. */
  private prefill: string | null = null;
  private plannerChats = 0;
  /** The last status a plan cue gave the dock, kept over re-reads until the next one: a stop is a draft at once. */
  private dock: 'draft' | null = null;
  /** The session main has joined a holder's daemon for on this window's behalf, until the window leaves it. */
  private holderSession: string | null = null;
  /**
   * The newest request to show a session, numbered. The plan list opens a
   * session on every click without waiting for the last, so two loads race and
   * the one that answers last would win; only the newest request may draw.
   */
  private shown = 0;
  private stopWatching: (() => void) | null = null;
  /** A refused join's holder is watched for its exit, so Continue here can be offered (W16). */
  private stopHolderWatch: (() => void) | null = null;
  private readonly watchMs: number;
  private readonly options: DaemonHostOptions;
  /** Views that re-read the catalog after a sign-in or a key: Settings draws its own copy of it. */
  private readonly catalogListeners = new Set<() => void>();

  constructor(readonly workspace: string, private readonly ask: Confirm = askInWindow, options: DaemonHostOptions = {}) {
    this.options = options;
    this.watchMs = options.watchMs ?? WATCH_MS;
    this.view = new SessionView((msg) => this.emit(msg));
    this.agents = new AgentDetection(workspace, (msg) => this.emit(msg), options.detectionTimeoutMs, () => this.sessionId);
    const sessionId = mintSessionId();
    this.snapshot = { sessionId, goal: '', state: INITIAL_HOST_STATE, held: null, restored: false, readOnly: false, link: null };
    this.follow(sessionId);
  }

  get sessionId(): string { return this.snapshot.sessionId; }

  // useSyncExternalStore's pair: the snapshot object changes only when something in it did.
  readonly subscribe = (listener: () => void): (() => void) => {
    this.storeListeners.add(listener);
    return () => this.storeListeners.delete(listener);
  };

  readonly getSnapshot = (): SessionSnapshotView => this.snapshot;

  setNavigator(navigator: SessionNavigator | null): void {
    this.navigator = navigator;
  }

  setReviewer(reviewer: Reviewer | null): void {
    this.reviewer = reviewer;
  }

  /**
   * A sign-in, a key or a planner switch changed what the daemon lists: a
   * view that holds its own copy (Settings) re-reads it. Returns the undo.
   */
  onCatalogChange(listener: () => void): () => void {
    this.catalogListeners.add(listener);
    return () => { this.catalogListeners.delete(listener); };
  }

  /** Detect the agents again and tell every catalog reader, after a save that changed them. */
  private async refreshCatalog(): Promise<void> {
    await this.agents.detect();
    for (const listener of [...this.catalogListeners]) listener();
  }

  /** The height the person last dragged the plan dock to, as the chat expects it on its ready. */
  private replayPlanDockHeight(): void {
    const saved = Number(storedItem(PLAN_DOCK_HEIGHT_KEY));
    if (Number.isFinite(saved) && saved > 0) this.emit({ type: 'planDockHeight', height: saved });
  }

  /**
   * The workspace's isolation as the startup view and the approval card show
   * it (W2, W4). Read per chat that mounts, as VS Code reads it per webview;
   * a failed read is a `failed` preview, never a missing one.
   */
  private async readIsolationPreview(): Promise<void> {
    try {
      const answer = await callDaemon('workspaces.isolationPreview', { workspace: this.workspace });
      this.emit({ type: 'isolationPreview', preview: answer.preview });
    } catch (error) {
      this.emit({ type: 'isolationPreview', preview: { status: 'failed', repos: [], shared: [], error: messageOf(error) } });
    }
  }

  /**
   * The key entry, from Settings or the command palette: one vendor's key,
   * written through the daemon's settings route as the TUI's `/key` does.
   * True when a key was saved. The key is never kept here or logged.
   */
  async enterApiKey(provider?: AiProvider, runnerLabel?: string): Promise<boolean> {
    if (provider !== undefined && !Object.hasOwn(VENDORS, provider)) {
      this.showError(new Error(`Unknown provider: ${provider}`));
      return false;
    }
    let answer: KeyEntryAnswer | null;
    try {
      const request: KeyEntryRequest = {
        ...(provider !== undefined ? { provider } : {}),
        ...(runnerLabel !== undefined ? { runnerLabel } : {}),
      };
      answer = await (this.options.askForKey ?? askForKey)(request);
    } catch (error) {
      this.showError(error);
      return false;
    }
    if (!answer) return false;
    try {
      await this.saveApiKey(answer);
      return true;
    } catch (error) {
      this.showError(error);
      return false;
    }
  }

  private async saveApiKey(answer: KeyEntryAnswer): Promise<void> {
    const meta = VENDORS[answer.provider];
    const saved = await callDaemon('settings.update', undefined, {
      env: { [meta.apiKeyEnvVar]: answer.key },
      workspace: this.workspace,
      sessionId: this.sessionId,
    });
    if (saved.rejectedEnvKeys?.includes(meta.apiKeyEnvVar)) {
      throw new Error(`The daemon refused the ${meta.label} key.`);
    }
    await this.refreshCatalog();
  }

  /** Whether a review of the run can be shown, so Review & Merge all has a review step to take. */
  get reviewing(): boolean {
    return this.reviewer !== null;
  }

  /**
   * Put text in the planner's composer ahead of the draft, unsent, as a
   * queued prompt taken back is: the person reads it and sends it. A planner
   * chat that mounts later is given it on its `ready`.
   */
  askPlanner(text: string): void {
    if (this.plannerChats > 0) { this.emit({ type: 'promptUnsent', text }); return; }
    this.prefill = text;
  }

  /** Show a task's chat in its tab, the way a card's "Open chat" does; nothing while no task tab kind is registered. */
  openTask(taskId: string, view: 'chat' | 'changes', options?: { preview?: boolean }): void {
    if (options) this.navigator?.openTask(taskId, view, options);
    else this.navigator?.openTask(taskId, view);
  }

  /**
   * Show a task where the plan lists it: selected, its card open, scrolled
   * into view in the plan panel. Only a chat earns a tab of its own.
   */
  revealTask(taskId: string): void {
    revealInPlan(this, taskId);
    this.navigator?.showPlan();
  }

  /**
   * A bridge for one chat instance: each mounts on its own and says `ready`
   * when it can draw. `place` keys what the instance saves, so the planner and
   * the plan list do not overwrite each other's.
   */
  port(place: string): ChatBridge {
    let listener: ((msg: HostToWebview) => void) | null = null;
    return {
      post: (msg) => {
        if (msg.type === 'ready' && listener) {
          this.replay(listener);
          if (place === 'conversation' && this.prefill !== null) { listener({ type: 'promptUnsent', text: this.prefill }); this.prefill = null; }
        }
        void this.handle(msg);
      },
      subscribe: (next) => {
        listener = next;
        this.ports.add(next);
        if (place === 'conversation') this.plannerChats++;
        return () => {
          this.ports.delete(next);
          if (place === 'conversation') this.plannerChats--;
          if (listener === next) listener = null;
        };
      },
      getState: () => this.savedStates.get(place),
      setState: (state) => { this.savedStates.set(place, state); },
    };
  }

  /** A task's log, kept for as long as the session: a tab that closes and comes back finds its place. */
  taskLog(taskId: string): TaskLogHost {
    let log = this.taskLogs.get(taskId);
    if (!log) {
      log = new TaskLogHost(taskId, {
        sessionId: this.sessionId,
        workspace: this.workspace,
        task: (id) => this.task(id),
        accountLimits: () => this.snapshot.state.accountLimits,
        openFile: (path) => this.navigator?.openFile(path),
      });
      this.taskLogs.set(taskId, log);
    }
    return log;
  }

  /** A task of the run as it stands, with its plan label. */
  task(taskId: string): { task: RunTask; label: string } | undefined {
    for (const placed of walkPlan(this.view.run.current.tasks)) {
      if (placed.task.id === taskId) return { task: placed.task, label: placed.label };
    }
    return undefined;
  }

  /**
   * Open a saved session, taking its lease (ADR-0063). A session another host
   * holds is refused with that host named: the saved state is shown read-only,
   * and the frame offers what to do about it (W16).
   */
  async open(sessionId: string): Promise<void> {
    const request = ++this.shown;
    // A newer open (or New session) supersedes this one. What it loaded stays
    // with the daemon, which keeps every session it has loaded live; it is
    // just never drawn here, nor its error shown over the newer session.
    const superseded = (): boolean => request !== this.shown;
    // Read before the load: a session this daemon already holds is live, and a
    // load of a saved one always answers with a run. This is what tells a
    // restored session (W17) from one that was already at work.
    const wasLive = await this.savedIsLive(sessionId);
    if (superseded()) return;
    let adopted: AdoptSessionResponse;
    try {
      adopted = await callDaemon('sessions.load', { id: sessionId, workspace: this.workspace });
    } catch (error) {
      if (superseded()) return;
      const held = heldOf(error);
      if (held) {
        if (held.holder.host?.kind === 'daemon') { await this.join(sessionId, held, superseded); return; }
        this.update({ held, link: null });
        await this.viewHeld(sessionId, superseded);
        return;
      }
      this.showError(error);
      return;
    }
    if (superseded()) return;
    this.adopt(sessionId, adopted, wasLive);
  }

  private adopt(sessionId: string, adopted: AdoptSessionResponse, wasLive: boolean): void {
    this.switchTo(sessionId, false, adopted.goal);
    this.showLoaded(adopted);
    this.update({ restored: !wasLive && hasRunHistory(adopted.plan) });
  }

  /**
   * Drive a session another Ordewell daemon holds through that daemon, as one
   * more of its clients (ADR-0063 H8): main checks the holder and routes the
   * session's calls and socket there, so it stays the session's one live host
   * (ADR-0049). A join main refuses shows why, over the saved state.
   */
  private async join(sessionId: string, held: SessionHeld, superseded: () => boolean): Promise<void> {
    this.cancelHolderWatch();
    const host = held.holder.host;
    if (host?.kind === 'daemon') this.update({ held, link: { kind: 'joining', port: host.port } });
    const joined = await window.ordewell.daemon.join(sessionId);
    // A join main made for a window that has moved on is let go, so main closes the holder's connection once nothing else uses it.
    if (superseded()) {
      if (joined.ok && this.holderSession !== sessionId) void window.ordewell.daemon.leave(sessionId);
      return;
    }
    if (!joined.ok) {
      this.update({ held, link: { kind: 'refused', reason: joined.reason, message: joined.message } });
      await this.viewHeld(sessionId);
      this.watchRefused(sessionId, held);
      return;
    }
    let saved: SessionResponse | null;
    try {
      saved = await this.readJoined(sessionId);
    } catch (error) {
      if (this.holderSession !== sessionId) void window.ordewell.daemon.leave(sessionId);
      if (superseded()) return;
      this.update({ link: null });
      this.showError(error);
      return;
    }
    if (superseded()) {
      if (this.holderSession !== sessionId) void window.ordewell.daemon.leave(sessionId);
      return;
    }
    this.switchTo(sessionId, false, saved?.meta.goal ?? '', { held, link: { kind: 'joined', holder: joined.holder } });
    this.holderSession = sessionId;
    if (saved) this.showPlan(planOfSaved(saved.plan));
  }

  /** The session as its holder serves it now; null before its planner's first turn has written a file. */
  private async readJoined(sessionId: string): Promise<SessionResponse | null> {
    try {
      return await callDaemon('sessions.get', { id: sessionId, workspace: this.workspace });
    } catch (error) {
      if (error instanceof DaemonError && error.code === 'session_not_found') return null;
      throw error;
    }
  }

  private get joined(): boolean {
    return this.snapshot.link?.kind === 'joined';
  }

  /** Whether the daemon already holds this session live, read before a load adopts it. */
  private async savedIsLive(sessionId: string): Promise<boolean> {
    // Only a session this daemon runs is live by being shown: a held one's was another host's.
    if (sessionId === this.sessionId && !this.fresh && !this.snapshot.held) return true;
    try {
      const saved = await callDaemon('sessions.get', { id: sessionId, workspace: this.workspace });
      return saved.run !== undefined;
    } catch {
      // The load will answer with the refusal that matters.
      return false;
    }
  }

  /**
   * Show what the daemon serves of a session another host holds, from its file
   * (W16). Every write is refused while it is drawn; taking the session over
   * is the way out (ADR-0049).
   */
  async viewHeld(sessionId: string, superseded: () => boolean = () => false): Promise<void> {
    try {
      const saved = await callDaemon('sessions.get', { id: sessionId, workspace: this.workspace });
      if (superseded()) return;
      this.showReadOnly(sessionId, saved);
      this.watch(sessionId, JSON.stringify(saved));
    } catch (error) {
      if (!superseded()) this.showError(error);
    }
  }

  /** Redraw a read-only view whenever the holder saves the session: it sends this window no frames. */
  private watch(sessionId: string, seen: string): void {
    let last = seen;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = (): void => { timer = setTimeout(() => { void read(); }, this.watchMs); };
    const read = async (): Promise<void> => {
      try {
        const saved = await callDaemon('sessions.get', { id: sessionId, workspace: this.workspace });
        const now = JSON.stringify(saved);
        if (stopped) return;
        if (now !== last) {
          last = now;
          if (saved.meta.goal !== this.snapshot.goal) this.update({ goal: saved.meta.goal });
          if (saved.conversation) this.view.reload(saved.conversation);
          this.showPlan(planOfSaved(saved.plan));
          if (saved.run) this.emit({ type: 'runView', view: saved.run });
        }
      } catch {
        // A file mid-write or a daemon away: the next read tells.
      }
      if (!stopped) next();
    };
    this.stopWatching = () => { stopped = true; clearTimeout(timer); };
    next();
  }

  /**
   * A refused join leaves no socket to close, so its holder's exit is read
   * from the lease instead: asking main to join again answers `free` once the
   * lease is gone, which is the moment Continue here may adopt the session
   * (W16). A holder that becomes joinable is joined then, and the saved state
   * stays on screen read-only until either answer arrives.
   */
  private watchRefused(sessionId: string, held: SessionHeld): void {
    this.cancelHolderWatch();
    const link = this.snapshot.link;
    if (link?.kind !== 'refused' || held.holder.host?.kind !== 'daemon') return;
    if (link.reason === 'free') {
      this.update({ link: { kind: 'gone', holder: holderViewOf(held.holder) } });
      return;
    }
    if (link.reason === 'own' || link.reason === 'vscode' || link.reason === 'no-host') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      stopped = true;
      clearTimeout(timer);
      if (this.stopHolderWatch === stop) this.stopHolderWatch = null;
    };
    this.stopHolderWatch = stop;
    const current = (): boolean => !stopped && this.sessionId === sessionId && this.snapshot.link === link;
    const tick = async (): Promise<void> => {
      if (!current()) { stop(); return; }
      let joined: JoinResult;
      try {
        joined = await window.ordewell.daemon.join(sessionId);
      } catch {
        if (!stopped) timer = setTimeout(() => { void tick(); }, this.watchMs);
        return;
      }
      if (!current()) { stop(); return; }
      if (!joined.ok && joined.reason === 'free') {
        stop();
        this.update({ link: { kind: 'gone', holder: holderViewOf(held.holder) } });
        return;
      }
      if (joined.ok) {
        stop();
        await this.open(sessionId);
        return;
      }
      timer = setTimeout(() => { void tick(); }, this.watchMs);
    };
    timer = setTimeout(() => { void tick(); }, this.watchMs);
  }

  private cancelHolderWatch(): void {
    this.stopHolderWatch?.();
    this.stopHolderWatch = null;
  }

  /** Adopt a session whose holder has exited into the app's own daemon (W16): a run it left is drawn as W17's restored one. */
  async continueHere(): Promise<void> {
    // The banner and the read-only view stay until the adoption is through: a
    // write offered as the banner disappears would be refused (W16).
    if (this.snapshot.link?.kind !== 'gone' || this.continuing) return;
    this.continuing = true;
    try {
      await this.open(this.sessionId);
    } finally {
      this.continuing = false;
    }
  }

  /**
   * Try the lease again: refused while the holder lives, allowed once it and
   * its runners are gone (ADR-0049 L3). Either way the outcome is the
   * person's to read, the refusal naming who still holds the session.
   */
  async takeOver(): Promise<TakeOverOutcome> {
    const sessionId = this.sessionId;
    let adopted: AdoptSessionResponse;
    try {
      adopted = await callDaemon('sessions.load', { id: sessionId, workspace: this.workspace });
    } catch (error) {
      const held = heldOf(error);
      if (!held) return { ok: false, message: messageOf(error) };
      this.update({ held });
      return { ok: false, message: takeOverRefusal(held) };
    }
    this.adopt(sessionId, adopted, false);
    return { ok: true, message: 'This window now runs the session.' };
  }

  /** A new session in this workspace, offered the held one's goal as its first message, unsent (W16). */
  startHere(): void {
    const goal = this.snapshot.goal;
    this.newSession();
    if (goal) this.askPlanner(goal);
  }

  /**
   * Rejoin the session's socket and take its fresh `run_snapshot`, so a view
   * that outlived a disconnected daemon never infers progress it did not see.
   */
  resync(): void {
    if (this.snapshot.readOnly) return;
    const sessionId = this.sessionId;
    this.cancelRejoin();
    this.dispose();
    this.follow(sessionId);
    this.refreshPlan();
  }

  /** A blank session: nothing is created on the daemon until the first message starts the planner. */
  newSession(): void {
    this.shown++;
    this.switchTo(mintSessionId(), true, '');
    this.emit({ type: 'setState', state: 'empty' });
  }

  /** Re-read the plan now, as after a command whose result the socket may not carry. */
  refreshPlan(): void {
    if (!this.fresh && !this.snapshot.readOnly) this.reread.request();
  }

  /** What a held session's saved state draws: its conversation, the plan, its run if the file carries one, and no socket. */
  private showReadOnly(sessionId: string, saved: SessionResponse): void {
    this.leaveHolder(sessionId);
    this.dispose();
    this.cancelRejoin();
    for (const log of this.taskLogs.values()) log.setState(undefined);
    this.taskLogs.clear();
    this.fresh = false;
    this.dock = null;
    this.emit({ type: 'restoreChat' });
    this.view.conversation.reset();
    this.view.run.reset();
    for (const type of [...this.sticky.keys()]) if (!CATALOG.has(type)) this.sticky.delete(type);
    this.update({
      sessionId,
      goal: saved.meta.goal,
      restored: false,
      readOnly: true,
      state: reduceHost(this.snapshot.state, { type: 'restoreChat', now: Date.now() }),
    });
    if (saved.conversation) this.view.reload(saved.conversation);
    this.showPlan(planOfSaved(saved.plan));
    if (saved.run) this.emit({ type: 'runView', view: saved.run });
  }

  /** Every message a chat instance posts, answered as the extension host answers it (PlanManager). */
  async handle(msg: WebviewToHost): Promise<void> {
    try {
      await this.dispatch(msg);
    } catch (error) {
      this.showError(error);
    }
  }

  dispose(): void {
    this.cancelRejoin();
    this.cancelHolderWatch();
    this.stopWatching?.();
    this.stopWatching = null;
    this.stream?.close();
    this.unsubscribe?.();
    this.stream = null;
    this.unsubscribe = null;
  }

  private async dispatch(msg: WebviewToHost): Promise<void> {
    if (this.snapshot.readOnly && !READ_ONLY_ALLOWED.has(msg.type)) {
      throw new Error('This session is open in another Ordewell host, so this view is read-only. Take it over to make changes here.');
    }
    switch (msg.type) {
      case 'ready':
        this.view.conversation.resync();
        this.replayPlanDockHeight();
        void this.readIsolationPreview();
        if (!this.catalogRead) { this.catalogRead = true; await this.agents.detect(); }
        return;
      case 'refreshModels':
        await this.agents.detect();
        return;
      case 'sendMessage': {
        const text = msg.text.trim();
        if (text.startsWith('/')) {
          // A '/' word no built-in names is a skill the planner resolves, as in
          // the extension and the TUI; a button's message is never one.
          if (isBuiltinSlashCommand(text)) {
            const [word, ...args] = text.split(/\s+/);
            await this.slashCommand(resolveSlashAlias(word ?? ''), args);
            return;
          }
          if (!msg.typed) {
            this.view.conversation.note('system', `${text.split(/\s+/)[0]} is not available in the desktop app yet.`);
            return;
          }
        }
        // A prompt typed while a turn is still the planner's waits for it, as in the extension's sendChat.
        if (msg.typed && this.generating) { this.view.conversation.holdPrompt(msg.text); return; }
        await (msg.typed ? this.say(msg.text, false, msg.runners) : this.turn(msg.text, false, msg.runners));
        return;
      }
      case 'loginPlanner':
        await this.loginPlanner(msg.runner);
        return;
      case 'setPlanner':
        await this.setPlanner(msg.provider);
        return;
      case 'setPlannerModel':
        await this.setPlannerModel(msg.modelId, msg.effort);
        return;
      case 'setRunnerEnabled':
        await this.setRunnerEnabled(msg.runnerId, msg.enabled, msg.requestId);
        return;
      case 'changeSettings':
        await this.changeSettings(msg.change);
        return;
      // Send now (ADR-0017 Q2): everything held goes with the composer's text,
      // as one message. Only a turn in flight is stopped for it; with none, it
      // is a plain send, as in the extension's sendChatNow.
      case 'sendMessageNow': {
        const text = this.view.conversation.takeAll(msg.text);
        if (!text.trim()) return;
        if (!this.generating) { await this.say(text, false); return; }
        // A forced turn that is refused gives back what it took, as in the extension's sendChatNow.
        await this.say(text, true, undefined, () => this.view.conversation.giveBack(text));
        return;
      }
      // Typed while the chat saw a turn in flight: one that has ended since leaves nothing to wait for, as in the extension.
      case 'holdPrompt':
        if (this.generating) this.view.conversation.holdPrompt(msg.text);
        else await this.handle({ type: 'sendMessage', text: msg.text, typed: true });
        return;
      case 'unsendPrompt':
        this.view.conversation.unsendPrompt(msg.toComposer);
        return;
      case 'stopResearch':
        this.view.conversation.stop();
        if (!this.fresh) await callDaemon('plans.stopPlanning', { sessionId: this.sessionId });
        return;
      case 'newSession':
        this.newSession();
        return;
      case 'addNote':
        this.view.conversation.note('system', msg.text);
        return;
      case 'resolveApproval':
        await callDaemon('approvals.decide', { sessionId: this.sessionId, approvalId: msg.id }, { granted: msg.granted });
        return;
      case 'answerCheckpoint': {
        const params = { sessionId: this.sessionId, taskId: msg.taskId };
        try {
          if (msg.approved) await callDaemon('plans.checkpointApprove', params, { ...(msg.reason ? { reason: msg.reason } : {}), ...(msg.raiseTokens ? { raiseTokens: msg.raiseTokens } : {}) });
          else await callDaemon('plans.checkpointReject', params, msg.reason ? { reason: msg.reason } : {});
          this.emit({ type: 'checkpointResult', answerId: msg.answerId });
        } catch (error) {
          this.emit({ type: 'checkpointResult', answerId: msg.answerId, error: messageOf(error) });
        }
        return;
      }
      case 'answerEscalation': {
        const { requestId } = msg;
        const answer: AnswerEscalationRequest = { id: msg.id, option: msg.option, ...(msg.note !== undefined ? { note: msg.note } : {}), ...(msg.confirmed ? { confirmed: true } : {}) };
        try {
          await callDaemon('plans.answerEscalation', { sessionId: this.sessionId }, answer);
          this.emit({ type: 'escalationAnswered', requestId, id: msg.id, ok: true });
        } catch (error) {
          this.emit({ type: 'escalationAnswered', requestId, id: msg.id, ok: false, message: messageOf(error) });
        }
        return;
      }
      case 'editTask':
        await this.planEdit(callDaemon('plans.cardEdit', { sessionId: this.sessionId, taskId: msg.taskId }, msg.edit));
        return;
      case 'removeTask':
        await this.removeTask(msg.taskId);
        return;
      case 'addTask':
        await this.planEdit(callDaemon('plans.addTask', { sessionId: this.sessionId }, msg.draft));
        return;
      case 'sendSystemCommand': {
        await this.systemCommand(msg.command, msg.taskId ?? '', msg.requestId);
        // A Retry compaction is a planner turn the chat did not send, so no
        // turn() of ours ends to release what was typed while it ran.
        if (!this.generating) await this.sendHeldPrompt();
        return;
      }
      case 'sendTaskMessage':
      case 'sendTaskMessageNow':
      case 'removeQueuedTaskMessage':
      case 'sendQueuedTaskMessageNow':
      case 'interruptTask':
        // The log is the task's composer; the card's box speaks through the same host.
        this.taskLog(msg.taskId).post(msg);
        return;
      case 'getTaskCommands':
        await this.postTaskCommands(msg.taskId);
        return;
      case 'invokeTaskCommand':
        await callDaemon('plans.taskCommands', { sessionId: this.sessionId, taskId: msg.taskId }, { name: msg.name, args: msg.args });
        return;
      case 'isolationAction':
        await this.isolation(msg.action, msg.taskId);
        return;
      case 'openTaskLog':
        this.navigator?.openTask(msg.taskId, 'chat');
        return;
      case 'openFile':
        this.navigator?.openFile(msg.path);
        return;
      case 'setPlanDockHeight':
        storeItem(PLAN_DOCK_HEIGHT_KEY, String(msg.height));
        return;
      // Child plans are the frame's other views' (#16): nothing here answers for them yet.
      default:
        return;
    }
  }

  private get generating(): boolean {
    return this.snapshot.state.isResearchActive || this.turnsIn(this.sessionId) > 0;
  }

  private turnsIn(sessionId: string): number {
    return this.turns.get(sessionId) ?? 0;
  }

  /** One planner turn: the first of a fresh session starts it, every later one is a message. */
  private async turn(text: string, now: boolean, runners?: readonly RunnerId[], refused?: () => void): Promise<void> {
    await this.plannerTurn(async (sessionId) => {
      let response: PlanResponse;
      if (this.fresh) {
        // The chat sends the runners its pills have on, including a click still
        // being saved; the daemon's list is only the fallback (as VS Code does).
        const chosen = runners ?? this.snapshot.state.enabledRunnerIds;
        response = await callDaemon('plans.converseStart', { sessionId, workspace: this.workspace }, { goal: text, ...(chosen.length ? { runners: [...chosen] } : {}) });
        if (sessionId !== this.sessionId) return;
        this.fresh = false;
        this.update({ goal: text });
      } else {
        response = await callDaemon(now ? 'plans.converseMessageNow' : 'plans.converseMessage', { sessionId }, { message: text });
        if (sessionId !== this.sessionId) return;
      }
      this.showPlan(response.plan);
    }, (error) => {
      this.showError(error);
      // A stop or a left session ended the turn on purpose; anything else refused it, and what it carried is not lost.
      if (!(error instanceof DaemonError && (error.code === 'planner_turn_stopped' || error.code === 'planner_turn_discarded'))) refused?.();
    });
  }

  /**
   * A call that is a planner turn: what is typed meanwhile is held, and the
   * held prompts go once it ends, as one message, whoever asked for the turn.
   */
  private async plannerTurn(run: (sessionId: string) => Promise<void>, failed: (error: unknown) => void): Promise<void> {
    const sessionId = this.sessionId;
    this.turns.set(sessionId, this.turnsIn(sessionId) + 1);
    try {
      await run(sessionId);
    } catch (error) {
      if (sessionId === this.sessionId) failed(error);
    } finally {
      const left = this.turnsIn(sessionId) - 1;
      if (left > 0) this.turns.set(sessionId, left);
      else this.turns.delete(sessionId);
    }
    if (sessionId !== this.sessionId) return;
    if (this.turnsIn(sessionId) === 0) await this.sendHeldPrompt();
  }

  /** Every prompt typed while the planner was busy, glued and sent now that it is not. */
  private async sendHeldPrompt(): Promise<void> {
    const next = this.view.conversation.nextPrompt();
    if (next !== undefined) await this.say(next, false);
  }

  /** A prompt the user sent, shown as theirs and answered in a turn, as the extension's sendChat does (webviewRouter). */
  private async say(text: string, now: boolean, runners?: readonly RunnerId[], refused?: () => void): Promise<void> {
    if (text.trim()) this.view.conversation.note('user', text);
    await this.turn(text, now, runners, refused);
  }

  /**
   * A built-in the composer offers, as the extension's SlashParser and the
   * TUI answer it. The extension's quick picks are the Settings tab's rows here.
   */
  private async slashCommand(command: string, args: readonly string[]): Promise<void> {
    switch (command) {
      case '/key': {
        // `/key set <provider>` is the terminal's spelling; the dialog is the desktop's.
        const named = args[0] === 'set' ? args[1] : args[0];
        if (named !== undefined && !Object.hasOwn(VENDORS, named)) {
          this.showError(new Error(`Unknown provider: ${named}. Run /key with no provider to see the list.`));
          return;
        }
        await this.enterApiKey(named as AiProvider | undefined);
        return;
      }
      case '/login': {
        const named = args.join(' ').trim();
        if (!named) { await this.loginPlanner(); return; }
        const backend = this.snapshot.state.planner.backends.find((b) => (
          (b.runner ?? b.id) === named || b.label.toLowerCase() === named.toLowerCase()
        ));
        if (!backend) {
          this.showError(new Error(`Unknown coding agent: ${named}.`));
          return;
        }
        await this.loginPlanner(backend.runner ?? backend.id);
        return;
      }
      case '/refresh':
        await this.agents.detect();
        return;
      case '/sessions':
        if (this.navigator?.showSessions) this.navigator.showSessions();
        else this.view.conversation.note('system', 'Open a session from the Sessions list in the sidebar.');
        return;
      case '/settings':
        this.emit({ type: 'openSettings' });
        return;
      case '/planner':
        if (args[0] !== undefined) { await this.pickPlanner(args[0]); return; }
        this.showSettings('Pick the planner, its model and its effort in Settings.');
        return;
      case '/allowlist':
        this.showSettings('Pick the models each coding agent may use in Settings, under its row.');
        return;
      case '/compact':
        await this.compact();
        return;
      case '/fork':
        await this.fork();
        return;
      case '/rewind':
        await this.rewind(args[0]);
        return;
      case '/help':
        this.view.conversation.note('system', slashHelp());
        return;
      // The chat answers /new and /inbox itself; nothing else is a built-in.
      default:
        this.view.conversation.note('system', `${command} is not available in the desktop app yet.`);
    }
  }

  private showSettings(fallback: string): void {
    if (this.navigator?.showSettings) this.navigator.showSettings();
    else this.view.conversation.note('system', fallback);
  }

  /** `/planner <id>`: straight to that planner, refused with why when it cannot plan, as SlashParser does. */
  private async pickPlanner(arg: string): Promise<void> {
    const chosen = this.snapshot.state.planner.backends.find((b) => b.id === arg.toLowerCase());
    if (!chosen) {
      this.view.conversation.note('system', `Unknown planner: ${arg}. Run /planner with no argument to see the list.`);
      return;
    }
    if (!chosen.usable) {
      this.view.conversation.note('system', chosen.reason ?? `${chosen.label} is not available.`);
      return;
    }
    await this.setPlanner(chosen.id);
  }

  /**
   * These edit the transcript a planner turn is writing to, so they wait it
   * out. A note rather than an error: the chat takes an error as the end of
   * the turn, which would unlock the input under a live one.
   */
  private plannerIsAnswering(): boolean {
    if (!this.generating) return false;
    this.view.conversation.note('system', 'The planner is still answering: wait for its reply, or stop it first.');
    return true;
  }

  /** The session's own events draw the compaction where it happens (ADR-0017); the answer only carries the plan. */
  private async compact(): Promise<void> {
    if (this.plannerIsAnswering()) return;
    await this.plannerTurn(async (sessionId) => {
      const response = await callDaemon('plans.compact', { sessionId });
      if (sessionId === this.sessionId) this.showPlan(response.plan);
    }, (error) => this.showError(new Error(`Could not condense the conversation: ${messageOf(error)}: nothing was changed.`)));
  }

  /**
   * The daemon has already adopted the fork, so the window only follows it,
   * without the extension's run question: the original is not closed and may
   * go on running, as in the TUI.
   */
  private async fork(): Promise<void> {
    if (this.plannerIsAnswering()) return;
    const original = this.sessionId;
    let fork: ConversationForkResponse;
    try {
      fork = await callDaemon('plans.fork', { sessionId: original });
    } catch (error) {
      this.showError(new Error(`Could not fork the conversation: ${messageOf(error)}`));
      return;
    }
    await this.open(fork.sessionId);
    if (this.sessionId !== fork.sessionId) return;
    this.view.conversation.note('system', `Forked ${original} into ${fork.sessionId}: you are in the fork now, and the original is kept. Use /sessions to go back.`);
  }

  /**
   * A rewind is a fork from just before the chosen message, followed as /fork
   * is; the message comes back into the composer to edit and send again. With
   * no message named, the chat lists the ones it can go back to.
   */
  private async rewind(arg: string | undefined): Promise<void> {
    if (this.plannerIsAnswering()) return;
    const original = this.sessionId;
    if (arg === undefined) {
      try {
        const { targets } = await callDaemon('plans.rewindTargets', { sessionId: original });
        this.view.conversation.note('system', targets.length === 0
          ? 'Nothing to rewind to yet: the only message so far is the goal.'
          : ['Send /rewind <message> to fork from just before one of these; the original is kept.', ...[...targets].reverse().map((t) => `/rewind ${t.index}  ${t.preview}`)].join('\n'));
      } catch (error) {
        this.showError(new Error(`Could not rewind the conversation: ${messageOf(error)}`));
      }
      return;
    }
    if (!/^\d+$/.test(arg)) {
      this.view.conversation.note('system', 'Usage: /rewind [<message>]: or /rewind alone to list them.');
      return;
    }
    let fork: ConversationRewindResponse;
    try {
      fork = await callDaemon('plans.rewind', { sessionId: original }, { index: Number(arg) });
    } catch (error) {
      this.showError(new Error(`Could not rewind the conversation: ${messageOf(error)}`));
      return;
    }
    await this.open(fork.sessionId);
    if (this.sessionId !== fork.sessionId) return;
    this.askPlanner(fork.rewoundMessage);
    this.view.conversation.note('system', `Rewound ${original} into a fork, ${fork.sessionId}: you are in the fork now, and the original is kept. Use /sessions to go back.`);
  }

  /** The planner backend a runner id names, if the daemon listed it. */
  private backendOf(runnerId: string | undefined): HostState['planner']['backends'][number] | undefined {
    const backends = this.snapshot.state.planner.backends;
    if (runnerId !== undefined) return backends.find((b) => (b.runner ?? b.id) === runnerId);
    const chosen = this.snapshot.state.planner.provider;
    return backends.find((b) => b.id === chosen);
  }

  /**
   * Sign one coding agent in from the chat (ADR-0052). No path switches the
   * planner: a runner names that agent, and absent names the planner it is on.
   * The agent's own status command is the verdict; a terminal that closes or
   * five minutes of polling ends the attempt as a failure the surface shows.
   */
  private async loginPlanner(runnerId?: string): Promise<void> {
    if (runnerId !== undefined && !this.backendOf(runnerId)) {
      // The daemon lists only agents it found: one it does not list has no
      // verdict to word, and a login for a missing binary would only fail.
      this.emit({
        type: 'plannerLoginEnded', runner: runnerId, ok: false,
        message: `Ordewell does not list the coding agent “${runnerId}”; refresh the runners and try again.`,
      });
      return;
    }
    const backend = this.backendOf(runnerId);
    const runner = backend ? (backend.runner ?? backend.id) : undefined;
    if (!runner) {
      const message = 'The active planner is not a coding agent; there is no login to run.';
      this.emit({ type: 'plannerLoginEnded', ok: false, message });
      this.view.conversation.note('system', message);
      return;
    }
    const label = backend?.label ?? runnerName(runner);
    const signIn = signInOfVerdict(runner, label, backend?.auth);
    await this.runLogin(runner, label, signIn);
  }

  private async runLogin(runner: string, label: string, signIn: ReturnType<typeof signInOfVerdict>): Promise<void> {
    // A key-based agent has no login Ordewell could run: the key entry is its way in.
    if (signInAction(signIn) === 'key' && signIn?.key) {
      const saved = await this.enterApiKey(signIn.key.provider, label);
      this.emit({
        type: 'plannerLoginEnded', runner, ok: saved,
        ...(saved ? {} : { message: 'The key was not saved.' }),
      });
      return;
    }
    if (!signIn?.login || signIn.login.length === 0) {
      const message = `Ordewell has no login for ${label}.`;
      this.emit({ type: 'plannerLoginEnded', runner, ok: false, message });
      this.view.conversation.note('system', message);
      return;
    }

    let terminal;
    try {
      terminal = await (this.options.openLogin ?? openLoginTerminal)(runner, label);
    } catch (error) {
      const detail = messageOf(error);
      const message = detail ? `${LOGIN_NO_TERMINAL} ${detail}` : LOGIN_NO_TERMINAL;
      this.emit({ type: 'plannerLoginEnded', runner, ok: false, message });
      this.view.conversation.note('system', message);
      return;
    }

    const outcome = await waitForSignIn({
      ended: terminal.ended,
      signedIn: () => this.runnerSignedIn(runner),
      ...(this.options.pollMs !== undefined ? { pollMs: this.options.pollMs } : {}),
      ...(this.options.loginTimeoutMs !== undefined ? { timeoutMs: this.options.loginTimeoutMs } : {}),
      ...(this.options.sleep !== undefined ? { sleep: this.options.sleep } : {}),
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
    });
    if (outcome.ok) {
      // The probe that the login changed is what redraws every pill and row.
      await this.refreshCatalog();
      this.emit({ type: 'plannerLoginEnded', runner, ok: true });
      return;
    }
    this.emit({ type: 'plannerLoginEnded', runner, ok: false, ...(outcome.message ? { message: outcome.message } : {}) });
    if (outcome.message === SIGN_IN_TIMEOUT) this.view.conversation.note('system', SIGN_IN_TIMEOUT);
  }

  /**
   * Whether the runner's own status command now says signed in. A read that
   * fails is no answer, so it stays `false` and the next poll asks again.
   */
  private async runnerSignedIn(runner: string): Promise<boolean> {
    try {
      const list = await callDaemon('runners.list', { workspace: this.workspace });
      return list.runners.find((entry) => entry.id === runner)?.auth?.state === 'signed-in';
    } catch {
      return false;
    }
  }

  /** Who plans (ADR-0009): the daemon judges the pick and the next detection redraws every pill. */
  private async setPlanner(provider: string): Promise<void> {
    await callDaemon('settings.update', undefined, { env: { AI_PROVIDER: provider }, workspace: this.workspace, sessionId: this.sessionId });
    await this.refreshCatalog();
  }

  /** The planner's own model and effort, a pair so neither outlives the other. */
  private async setPlannerModel(modelId: string, effort: string | undefined): Promise<void> {
    await callDaemon('settings.update', undefined, {
      orchestratorModel: modelId,
      // An effort is a variant of this model; the default is the empty string, never the last model's.
      plannerThinkingEffort: effort ?? '',
      workspace: this.workspace,
      sessionId: this.sessionId,
    });
    await this.refreshCatalog();
  }

  /** A Runners pill: the saved set every surface shares (ADR-0043), answered with what the daemon holds now. */
  private async setRunnerEnabled(runnerId: string, enabled: boolean, requestId: string): Promise<void> {
    let saved = !enabled;
    try {
      await callDaemon('runners.setEnabled', { id: runnerId }, { enabled });
      // The write landed: a list that cannot be read leaves the click's own
      // state as the answer, never the state it asked to leave.
      saved = enabled;
      try {
        const list = await callDaemon('runners.list', { workspace: this.workspace });
        const row = list.runners.find((entry) => entry.id === runnerId);
        if (row) saved = row.enabled !== false;
      } catch {
        // Detection below reads the list again; a save is not undone by a read.
      }
    } catch (error) {
      this.showError(error);
    } finally {
      this.emit({ type: 'runnerChoiceSaved', requestId, runnerId: runnerId as RunnerId, enabled: saved });
    }
    await this.refreshCatalog();
  }

  /**
   * The chat's Run block (ADR-0030): the same risk questions the extension
   * asks, then one write, then the values as the daemon holds them so a
   * declined or refused change puts its old value back.
   */
  private async changeSettings(change: SettingsChange): Promise<void> {
    const current = await callDaemon('settings.get', { workspace: this.workspace, sessionId: this.sessionId });
    const run = change.run && { ...change.run };
    if (run) {
      // The panel shows no delegation row until it is offered (ADR-0055 D21), and never sets the kept budget.
      if (!DELEGATION_OFFERED) delete run.delegationTokens;
      delete run.delegationBudget;
      for (const request of runSettingRiskConfirmations(run, current.run.delegationTokens, DELEGATION_OFFERED)) {
        if (await this.ask(request) === null) {
          this.emitRunSettings(current);
          return;
        }
      }
    }
    const body: Record<string, unknown> = { workspace: this.workspace, sessionId: this.sessionId };
    if (change.autonomous !== undefined) body.autonomousMode = change.autonomous;
    if (run && Object.keys(run).length > 0) body.run = run;
    if (change.maxParallel !== undefined) body.env = { ORDEWELL_MAX_PARALLEL: String(change.maxParallel) };
    const next = await callDaemon('settings.update', undefined, body);
    this.emitRunSettings(next);
  }

  /**
   * A write from the Settings tab: the Run block's risk questions first, so
   * the tab is no way round them, then the values as the daemon holds them to
   * every chat, whose Run block and approval note would otherwise show the old
   * ones until the next detection. Null when the user declined and nothing
   * was written.
   */
  async saveSettings(body: Record<string, unknown>): Promise<SettingsUpdateResponse | null> {
    const run = body.run;
    if (typeof run === 'object' && run !== null) {
      // Delegation is left out: the Subplanners row asks its own question before it writes.
      for (const request of runSettingRiskConfirmations(run as Partial<GlobalRunSettings>, 0, false)) {
        if (await this.ask(request) === null) return null;
      }
    }
    const next = await callDaemon('settings.update', undefined, { ...body, workspace: this.workspace });
    this.emitRunSettings(next);
    return next;
  }

  private emitRunSettings(settings: SettingsResponse): void {
    this.emit({
      type: 'setRunSettings',
      autonomous: settings.autonomousMode,
      run: settings.run,
      maxParallel: settings.maxParallel,
      delegationOffered: DELEGATION_OFFERED,
    });
  }

  private async systemCommand(command: string, taskId: string, requestId: number | undefined): Promise<void> {
    try {
      switch (command) {
        case 'cancel':
        case 'cancelResume':
        case 'resumeNow':
        case 'retry':
        case 'skip':
          await this.execute(taskActionCommand(SYSTEM_TASK_ACTIONS[command], taskId));
          break;
        case 'markComplete':
          await this.markByHand('complete', taskId);
          break;
        case 'markIncomplete':
          await this.markByHand('uncomplete', taskId);
          break;
        case 'revertTask':
          await this.revert(taskId);
          break;
        case 'forceStart':
          await this.forceStart(taskId);
          break;
        case 'runTask': {
          const gate = await callDaemon('plans.mergeGate', { sessionId: this.sessionId, taskId });
          // The seam's run_task refuses a gated task: a start past the gate is a force start, confirmed first.
          if (gate.mergeGate.length > 0) await this.forceStart(taskId, gate);
          else await this.start(taskActionCommand('run', taskId));
          break;
        }
        case 'executePlan':
          await this.executePlan(requestId);
          break;
        case 'stopExecution':
          await this.execute({ command: 'stop_run' });
          this.emit({ type: 'setState', state: 'planDraft' });
          break;
        case 'cancelPlannerResend':
          await callDaemon('plans.cancelResend', { sessionId: this.sessionId });
          break;
        case 'retryPlannerCompaction':
          await callDaemon('plans.retryCompact', { sessionId: this.sessionId });
          break;
      }
    } finally {
      this.refreshPlan();
    }
  }

  /** Approve and run the plan, or, with a run under way, approve what waits for approval (#95). */
  private async executePlan(requestId: number | undefined): Promise<void> {
    try {
      if (this.snapshot.state.isExecuting) {
        await this.execute({ command: 'run_plan' });
      } else {
        await this.startingRun(() => callDaemon('plans.execute', { sessionId: this.sessionId }));
        this.emit({ type: 'setState', state: 'approved' });
      }
    } finally {
      // The click showed "Starting…" before this answered: the activity settles it either way.
      const activity = this.view.run.current.activity;
      if (activity) this.emit({ type: 'runActivity', activity, ...(requestId !== undefined ? { requestId } : {}) });
    }
  }

  /**
   * Mark complete and Mark not done vouch for work no verdict passed, so an AI
   * or script task's override is asked in a real modal first and the yes goes
   * with the status it was asked about (ADR-0029). A manual task's is the
   * user's own sign-off and asks nothing.
   */
  private async markByHand(direction: OverrideDirection, taskId: string): Promise<void> {
    const command = taskActionCommand(direction, taskId);
    const { tasks, task } = this.planTask(taskId);
    if (!task || !overrideNeedsConfirmation(task)) { await this.execute(command); return; }
    const label = `task ${titledTaskRefOf(tasks, taskId) ?? taskId}`;
    if (this.view.run.current.activity?.advancesOnItsOwn) throw new Error(manualOverrideStopFirst(direction, label));
    if (await this.ask(overrideConfirmation(direction, label)) !== 'override') return;
    await this.execute(confirmedOverride(command, task.status));
  }

  /** ADR-0054: the preview names what goes with it, and the yes carries the ids the user was shown. */
  private async revert(taskId: string): Promise<void> {
    const preview = await callDaemon('plans.revertPreview', { sessionId: this.sessionId, taskId });
    if (!preview.revertible) throw new Error(preview.message);
    if (await this.ask(revertConfirmation(preview, taskId)) !== 'revert') return;
    await this.execute({ command: 'revert_task', task: taskId, confirmed: true, seen: preview.tasks.map((t) => t.taskId) });
  }

  private async forceStart(taskId: string, known?: MergeGateResponse): Promise<void> {
    const gate = known ?? await callDaemon('plans.mergeGate', { sessionId: this.sessionId, taskId });
    if (gate.mergeGate.length > 0) {
      const named = titledRefs(gate.mergeGate.map((t) => t.id), this.view.run.current.tasks);
      if (await this.ask(startPastGateConfirmation(named)) !== 'start') return;
    }
    await this.start(taskActionCommand('force-start', taskId));
  }

  /** A start reopens the run whose cards its last end left up. */
  private async start(command: ExecutionCommand): Promise<void> {
    await this.startingRun(() => this.execute(command));
  }

  /**
   * The last run's cards go before the call, not after it: the new run's first
   * status reaches the socket before the call answers, and clearing then would
   * wipe the worktree it reported, which later updates, carrying only the tasks
   * that moved, do not send again. A start the daemon refused takes the run
   * back from a fresh snapshot.
   */
  private async startingRun(call: () => Promise<unknown>): Promise<void> {
    this.view.run.clearIsolation();
    try {
      await call();
    } catch (err) {
      this.resync();
      throw err;
    }
  }

  /** The plan's own task, as the chat's cards were drawn from it: the run view's copy carries less. */
  private planTask(taskId: string): { tasks: Task[]; task: Task | undefined } {
    // A surface plan's tasks are the plan's tasks as sent: the cast names them so (ui's App does the same).
    const tasks = (this.snapshot.state.plan?.tasks ?? []) as Task[];
    return { tasks, task: [...walkPlan(tasks)].find((placed) => placed.task.id === taskId)?.task };
  }

  private async removeTask(taskId: string): Promise<void> {
    const { tasks, task } = this.planTask(taskId);
    // The daemon refuses it too; asking first would be asking about a removal that cannot happen.
    const refusal = task && loopRemovalRefusal(task);
    if (refusal) throw new Error(refusal);
    if (await this.ask(removeTaskConfirmation(tasks, taskId)) !== 'remove') return;
    await this.planEdit(callDaemon('plans.deleteTask', { sessionId: this.sessionId, taskId }));
  }

  /**
   * The handoff and conflict actions, as the extension's isolation module
   * takes them. Merge and discard cannot be undone, so each is asked in the
   * window first, in ui's words.
   */
  private async isolation(action: IsolationActionKind, taskId: string | undefined): Promise<void> {
    const sessionId = this.sessionId;
    try {
      switch (action) {
        case 'reviewDiff':
          // The run's diff is the Changes view's to draw (#19); without it, the daemon's read is what it says.
          if (this.reviewer) { this.reviewer.open(); return; }
          await callDaemon('plans.isolationDiff', { sessionId });
          return;
        case 'merge': {
          // Every Merge all, the plan card's too, goes through the preflight where the Changes view is there to ask it (ADR-0062 G8).
          if (this.reviewer) { await this.reviewer.mergeAll(); return; }
          const target = this.mergeTarget();
          const handoff = this.view.run.current.handoff ?? this.view.run.current.runMerge;
          const rule = handoff ? checkoutRule(handoff) : '';
          if (await this.ask(mergeAllConfirmation(target, rule, this.snapshot.state.isExecuting)) !== 'merge') return;
          await this.mergeAsked(target);
          break;
        }
        case 'discard':
          if (await this.ask(discardRunConfirmation()) !== 'discard') return;
          await callDaemon('plans.isolationDiscard', { sessionId });
          break;
        case 'cleanup':
          await callDaemon('plans.isolationCleanup', { sessionId });
          break;
        case 'resolveConflict': {
          if (!taskId) return;
          const resolved = await callDaemon('plans.resolveConflict', { sessionId, taskId });
          if (resolved.plan) this.showPlan(resolved.plan);
          break;
        }
      }
    } catch (error) {
      throw new Error(`Isolation action failed: ${messageOf(error)}`);
    } finally {
      this.refreshPlan();
    }
  }

  /** Where Merge all lands, as its confirmation names it. */
  mergeTarget(): string {
    const handoff = this.view.run.current.handoff ?? this.view.run.current.runMerge;
    return handoff ? mergeTarget(handoff) : 'the branch you have checked out';
  }

  /**
   * Merge all once the person has said yes elsewhere: the Changes view's
   * preflight asks its own question (ADR-0062 G8). False when it did not merge,
   * the refusal already shown.
   */
  async mergeConfirmed(): Promise<boolean> {
    try {
      return await this.mergeAsked(this.mergeTarget());
    } catch (error) {
      this.showError(new Error(`Isolation action failed: ${messageOf(error)}`));
      return false;
    } finally {
      this.refreshPlan();
    }
  }

  private async mergeAsked(target: string): Promise<boolean> {
    const sessionId = this.sessionId;
    /*
     * What the seam holds the merge for is its to name, one question at a time:
     * work no check has passed (ADR-0055 D9), then an ops task running in the
     * checkout (ADR-0020). Each yes goes with every later call.
     */
    const questions = { merge_past_check: ['pastChecks', mergePastChecksQuestion], merge_beside_ops: ['besideOps', mergeBesideOpsQuestion] } as const;
    const yes: { pastChecks?: true; besideOps?: true } = {};
    for (;;) {
      try {
        await callDaemon('plans.isolationMerge', { sessionId }, { ...yes });
        return true;
      } catch (error) {
        if (!(error instanceof DaemonError) || (error.code !== 'merge_past_check' && error.code !== 'merge_beside_ops')) throw error;
        const [flag, question] = questions[error.code];
        if (yes[flag]) throw error;
        if (await this.ask(question(error.message, target)) !== 'merge') return false;
        yes[flag] = true;
      }
    }
  }

  private async execute(command: ExecutionCommand): Promise<void> {
    await callDaemon('plans.executeCommand', { sessionId: this.sessionId }, command);
  }

  /** A task edit answers only ok: the plan it changed is read again, as the chat's cards show only what was accepted. */
  private async planEdit(call: Promise<unknown>): Promise<void> {
    try {
      await call;
    } finally {
      this.refreshPlan();
    }
  }

  /** The plan as the daemon holds it now. A load is the read that returns the whole surface plan; this host holds the lease already. */
  private async readPlan(): Promise<void> {
    const sessionId = this.sessionId;
    try {
      // A load at the holder would adopt the session again over its live turn.
      const plan = this.joined
        ? await this.readJoined(sessionId).then((saved) => saved && planOfSaved(saved.plan))
        : (await callDaemon('sessions.load', { id: sessionId, workspace: this.workspace })).plan;
      if (plan && sessionId === this.sessionId) this.showPlan(plan);
    } catch (error) {
      if (sessionId === this.sessionId) this.showError(error);
    }
  }

  private showLoaded(adopted: AdoptSessionResponse): void {
    this.showPlan(adopted.plan);
    if (adopted.plannerCompaction) this.view.receive(adopted.plannerCompaction);
  }

  private showPlan(plan: SurfacePlan): void {
    const status = this.dock && plan.status !== 'running' ? this.dock : plan.status;
    this.emit({ type: 'planUpdated', plan: { ...plan, status } });
    this.emit({ type: 'setState', state: plan.tasks.length === 0 ? 'empty' : plan.status === 'draft' || plan.status === 'rejected' ? 'planDraft' : 'approved' });
  }

  private showError(error: unknown): void {
    this.emit({ type: 'showError', error: messageOf(error) });
  }

  private cue(cue: SessionCue): void {
    switch (cue.type) {
      case 'reveal':
        return;
      case 'plan':
        this.dock = cue.dock === 'draft' ? 'draft' : null;
        this.refreshPlan();
        return;
      case 'settled':
        this.dock = cue.dock === 'draft' ? 'draft' : null;
        this.refreshPlan();
        if (this.view.run.current.activity) this.emit({ type: 'runActivity', activity: this.view.run.current.activity });
        return;
      case 'confirm':
        void this.isolationBlocked(cue.request);
        return;
      case 'commands':
        void this.postTaskCommands(cue.taskId);
        return;
    }
  }

  /**
   * The commands a task's runner loaded, read off its latest attempt's log as
   * the extension's latestTaskCommands does. The daemon writes a batch before
   * it sends the frame that cued this, so the read already holds it. A log
   * that cannot be read offers none: the card still sends what is typed.
   */
  private async postTaskCommands(taskId: string): Promise<void> {
    const sessionId = this.sessionId;
    const params = { id: sessionId, workspace: this.workspace, taskId };
    let commands: readonly RunnerCommand[] = [];
    try {
      const { attempts } = await callDaemon('sessions.taskLog', params);
      const latest = attempts.at(-1);
      if (latest !== undefined) {
        const { events } = await callDaemon('sessions.taskLogAttempt', { ...params, attempt: String(latest) });
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index];
          if (event?.type === 'runner_loaded') { commands = event.commands; break; }
        }
      }
    } catch {
      commands = [];
    }
    if (sessionId === this.sessionId) this.emit({ type: 'taskCommands', taskId, commands });
  }

  private async isolationBlocked(request: Extract<SessionCue, { type: 'confirm' }>['request']): Promise<void> {
    const choice = await this.ask(request);
    try {
      if (choice === 'stash') await callDaemon('plans.isolationStash', { sessionId: this.sessionId });
      else if (choice === 'shared_root') await callDaemon('plans.isolationRunWithout', { sessionId: this.sessionId });
    } catch (error) {
      this.emit({ type: 'showError', error: `Could not continue the run: ${messageOf(error)}` });
    }
  }

  private switchTo(sessionId: string, fresh: boolean, goal: string, link: Pick<SessionSnapshotView, 'held' | 'link'> = { held: null, link: null }): void {
    this.leaveHolder(sessionId);
    this.cancelHolderWatch();
    this.dispose();
    for (const log of this.taskLogs.values()) log.setState(undefined);
    this.taskLogs.clear();
    this.fresh = fresh;
    this.dock = null;
    this.emit({ type: 'restoreChat' });
    this.view.conversation.reset();
    this.view.run.reset();
    this.sticky.delete('planUpdated');
    this.sticky.delete('runView');
    this.sticky.delete('children');
    this.update({ sessionId, goal, ...link, restored: false, readOnly: false, state: reduceHost(this.snapshot.state, { type: 'restoreChat', now: Date.now() }) });
    this.follow(sessionId);
    void this.readRunSettings(sessionId);
  }

  /**
   * The daemon answers a live session with its own run settings, so the Run
   * block and the approval note the catalog kept from the last session are
   * read again for this one, as the extension sends them on each load.
   */
  private async readRunSettings(sessionId: string): Promise<void> {
    try {
      const settings = await callDaemon('settings.get', { workspace: this.workspace, sessionId });
      if (sessionId === this.sessionId && typeof settings.run === 'object' && settings.run !== null) this.emitRunSettings(settings);
    } catch (error) {
      if (sessionId === this.sessionId) this.emit({ type: 'showError', error: `Could not read this session's run settings: ${messageOf(error)}` });
    }
  }

  /** A window that moves off a session it joined lets main close the holder's connection once nothing else uses it. */
  private leaveHolder(next?: string): void {
    const joined = this.holderSession;
    if (joined === null || joined === next) return;
    this.holderSession = null;
    void window.ordewell.daemon.leave(joined);
  }

  private follow(sessionId: string): void {
    const stream = new SessionStream(this.view, (msg) => this.emit(msg), {
      load: () => this.load(sessionId),
      cue: (cue) => this.cue(cue),
      notice: (notice) => this.view.conversation.note('system', notice.message),
      failed: (error) => this.showError(error),
    }, () => this.fresh);
    this.stream = stream;
    this.unsubscribe = window.ordewell.daemon.subscribe(sessionId, (event) => {
      if (this.stream !== stream) return;
      if (!event) return;
      if (event.kind === 'closed') {
        if (this.joined) void this.rejoinHolder(sessionId);
        else this.reconnect(sessionId);
        return;
      }
      if (!isFrame(event.frame)) return;
      this.rejoinBackoff.reset();
      const wasGenerating = this.generating;
      stream.receive(event.frame);
      this.toTaskLogs(event.frame);
      // A turn's ended frame can trail the answer of the route that ran it, so
      // the frame releases what that answer could not (a Retry compaction's).
      if (wasGenerating && !this.generating) void this.sendHeldPrompt();
    });
  }

  /**
   * A socket that closed is joined again: when the daemon comes back, or, if
   * it never left (it closed this one socket), after a pause that doubles each
   * time, so a socket it keeps refusing is not asked for in a loop. The new
   * stream's first frame reloads the session.
   */
  private reconnect(sessionId: string): void {
    this.cancelRejoin();
    const again = (): void => {
      if (sessionId !== this.sessionId) return;
      this.dispose();
      this.follow(sessionId);
    };
    const offStatus = window.ordewell.daemon.onStatus((status) => { if (status.state === 'connected') again(); });
    const timer = setTimeout(() => {
      void window.ordewell.daemon.status().then((status) => { if (status.state === 'connected') again(); });
    }, this.rejoinBackoff.next());
    this.rejoin = () => { offStatus(); clearTimeout(timer); };
  }

  /**
   * A joined session's socket closed: its holder dropped it, restarted, or
   * exited. Asking main to join again tells which: the same or a new daemon
   * holding it is followed again, a lease that freed is the holder gone (W16),
   * and one whose daemon does not answer yet is asked again after a pause.
   */
  private async rejoinHolder(sessionId: string): Promise<void> {
    this.cancelRejoin();
    const link = this.snapshot.link;
    if (link?.kind !== 'joined') return;
    const joined = await window.ordewell.daemon.join(sessionId);
    if (sessionId !== this.sessionId || this.snapshot.link !== link) return;
    if (joined.ok) {
      this.rejoinBackoff.reset();
      this.update({ link: { kind: 'joined', holder: joined.holder } });
      this.dispose();
      this.follow(sessionId);
      return;
    }
    if (joined.reason === 'free') {
      this.dispose();
      this.leaveHolder();
      // Nothing runs the session now: what is drawn stays, and nothing writes until it is continued here.
      this.update({ link: { kind: 'gone', holder: link.holder }, readOnly: true });
      return;
    }
    if (joined.reason === 'unreachable') {
      // Its pid still holds the lease: the holder is away, not gone, and nothing may continue it here yet.
      if (!link.away) this.update({ link: { ...link, away: true } });
      const timer = setTimeout(() => { void this.rejoinHolder(sessionId); }, this.rejoinBackoff.next());
      this.rejoin = () => clearTimeout(timer);
      return;
    }
    this.leaveHolder();
    this.update({ link: null });
    await this.open(sessionId);
  }

  private cancelRejoin(): void {
    this.rejoin?.();
    this.rejoin = null;
  }

  private async load(sessionId: string): Promise<DaemonSessionState> {
    if (this.fresh) return { conversation: {} };
    if (this.joined) {
      const saved = await this.readJoined(sessionId);
      if (!saved) return { conversation: {} };
      const plan = planOfSaved(saved.plan);
      if (sessionId === this.sessionId) {
        this.showPlan(plan);
        if (saved.plannerCompaction) this.view.receive(saved.plannerCompaction);
      }
      return {
        conversation: saved.conversation ?? {},
        ...(saved.run ? { run: saved.run } : {}),
        ...(saved.plannerTurnId ? { plannerTurnId: saved.plannerTurnId } : {}),
        ...(saved.position ? { position: saved.position } : {}),
      };
    }
    const adopted = await callDaemon('sessions.load', { id: sessionId, workspace: this.workspace });
    if (sessionId === this.sessionId) this.showLoaded(adopted);
    return {
      conversation: adopted.plan,
      ...(adopted.run ? { run: adopted.run } : {}),
      ...(adopted.plannerTurnId ? { plannerTurnId: adopted.plannerTurnId } : {}),
      ...(adopted.position ? { position: adopted.position } : {}),
    };
  }

  /** Every frame reaches the open task logs too, in the order the socket gave it: each folds what is its own. */
  private toTaskLogs(frame: DaemonFrame): void {
    if (this.taskLogs.size === 0) return;
    if (frame.type === 'run_snapshot') {
      for (const log of this.taskLogs.values()) log.refresh();
      return;
    }
    if (frame.type === 'connected' || frame.type === 'child_tree' || frame.type === 'account_limits' || frame.type === 'notice') {
      if (frame.type === 'account_limits') for (const log of this.taskLogs.values()) log.pushAccountLimits();
      return;
    }
    const message: SessionMessage & Partial<StreamStamp> = frame;
    for (const log of this.taskLogs.values()) log.receive(message);
  }

  private emit(msg: HostToWebview): void {
    if (STICKY.has(msg.type)) this.sticky.set(msg.type, msg);
    const state = reduceHost(this.snapshot.state, { ...msg, now: Date.now() });
    if (state !== this.snapshot.state) this.update({ state });
    for (const port of [...this.ports]) port(msg);
  }

  private replay(listener: (msg: HostToWebview) => void): void {
    for (const msg of this.sticky.values()) listener(msg);
  }

  private update(changes: Partial<SessionSnapshotView>): void {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of [...this.storeListeners]) listener();
  }
}

const hosts = new Map<string, DaemonHost>();

/** The workspace's one session host: the plan pane, the planner and the task tabs all read the same. */
export function daemonHost(workspace: string): DaemonHost {
  let host = hosts.get(workspace);
  if (!host) {
    host = new DaemonHost(workspace);
    hosts.set(workspace, host);
  }
  return host;
}

/** Tests start from no host. */
export function resetDaemonHosts(): void {
  for (const host of hosts.values()) host.dispose();
  hosts.clear();
}
