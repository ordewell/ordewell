import type { AccountLimitSnapshot, GlobalRunSettings, IsolationPreview,
  AiProvider, RunnerAuth, RunnerCommand, DisplayBlock, DiscoveredModel, PromptHold, RunnerId, RunActivity, RunView, SurfacePlan,
  TaskModelAssignment,
} from '@ordewell/core';

/*
 * The messages between the extension host and the chat webview, both ways.
 * Types only: the host (tsup) and the webview (Vite) each compile this file,
 * so neither can drift from what the other sends.
 */

/** One selectable planner backend, with the reason it can't be picked when it can't. */
export interface PlannerBackend {
  id: string;
  label: string;
  kind: 'harness' | 'vendor';
  /** Harness planners only: the runner whose catalog supplies this planner's models. */
  runner?: string;
  usable: boolean;
  reason?: string;
  /** The runner's own login verdict: a signed-out agent stays usable and is flagged, never blocked. */
  auth?: RunnerAuth;
}

export interface RunnerMeta {
  id: string;
  displayName: string;
  enabled: boolean;
}

export interface RunnerModeMeta {
  id: string;
  label: string;
  description: string;
  cliValue?: string;
  autonomous?: boolean;
  /** Why this host cannot run the mode (a failed probe); shown, never assignable. */
  unavailable?: string;
}

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  apiProvider?: AiProvider;
  description?: string;
  pricing?: string;
}

/**
 * The plan and its run only. Whether a planner turn is out is not here: that
 * is `plannerTurn`, so a run started or stopped inside a turn leaves it open.
 */
export type ChatState = 'empty' | 'planDraft' | 'approved';

export type SystemCommand = 'cancel' | 'cancelResume' | 'cancelPlannerResend' | 'retryPlannerCompaction' | 'resumeNow' | 'skip' | 'retry' | 'forceStart' | 'runTask' | 'markComplete' | 'markIncomplete' | 'stopExecution' | 'executePlan';

/**
 * One field edit from a task card. Named by kind rather than read off which
 * keys a payload happens to carry: that guess let an emptied mode fall
 * through to removing the task.
 */
export type TaskEdit =
  | { kind: 'runner'; runner: RunnerId }
  | { kind: 'model'; assignment: TaskModelAssignment }
  | { kind: 'mode'; mode: string }
  | { kind: 'prompt'; prompt: string }
  | { kind: 'dependencies'; dependencies: string[] }
  | { kind: 'skills'; skills: string[] }
  /** Change versus ops (ADR-0020); the session refuses it once the task has started. */
  | { kind: 'ops'; ops: boolean };

/** A hand-written task from the add form: only what a user can fill in. */
export interface TaskDraft {
  title: string;
  prompt?: string;
  assignedRunner?: string;
  assignedModel?: TaskModelAssignment;
  taskMode?: string;
  dependencies: string[];
}

export type IsolationActionKind = 'reviewDiff' | 'merge' | 'discard' | 'cleanup' | 'resolveConflict';

/**
 * What changed in the host's conversation view since the last patch: the ids
 * of every block in order, and the blocks that are new or changed. A block
 * absent from `order` is gone. See `ConversationViewHost` for why the host
 * sends patches rather than the whole view.
 */
export interface ConversationPatch {
  type: 'conversationPatch';
  order: readonly string[];
  changed: readonly DisplayBlock[];
  /**
   * The view was replaced (a reset, a reload): ids are numbered
   * afresh, so one the webview kept may name a different block now.
   */
  replaced?: true;
}

export type WebviewToHost =
  | { type: 'getTaskCommands'; taskId: string }
  | { type: 'invokeTaskCommand'; taskId: string; name: string; args: string }
  /** Chat input: a message for the planner, or a slash command. */
  | {
      type: 'sendMessage';
      text: string;
      runners?: RunnerId[];
      /** The user typed it, so the conversation shows it as theirs; a button's message is not echoed. */
      typed?: boolean;
    }
  | { type: 'sendSystemCommand'; command: SystemCommand; taskId?: string; requestId?: number }
  | { type: 'editTask'; taskId: string; edit: TaskEdit }
  /** Asks the host to remove a task; the host confirms first, naming what depends on it. */
  | { type: 'removeTask'; taskId: string }
  | { type: 'addTask'; draft: TaskDraft }
  /** The user's answer to a task paused at a checkpoint; a rejection resumes the agent with the reason. */
  | { type: 'answerCheckpoint'; taskId: string; approved: boolean; reason?: string }
  /** A user message to a structured task (ADR-0018): queued behind its turn, or delivered at once if it waits for input. */
  | { type: 'sendTaskMessage'; taskId: string; text: string }
  /** Take back a message still queued behind a structured task's turn. */
  | { type: 'removeQueuedTaskMessage'; taskId: string; id: string }
  /** Force send (ADR-0023, F1): interrupt the task's running turn and deliver `text` next, ahead of anything queued. */
  | { type: 'sendTaskMessageNow'; taskId: string; text: string }
  /** Force send a message still queued behind a structured task's turn. */
  | { type: 'sendQueuedTaskMessageNow'; taskId: string; id: string }
  /** Stop a structured task's running turn; the task then waits for input. */
  | { type: 'interruptTask'; taskId: string }
  /**
   * The user answered an in-chat approval card. The id is the request's, so the
   * host resolves the same prompt any other surface would.
   */
  | { type: 'resolveApproval'; id: string; granted: boolean }
  /**
   * A prompt typed while the planner answers. The host holds it and sends it
   * when the turn ends — or at once, if the turn ended before this arrived.
   */
  | { type: 'holdPrompt'; text: string }
  /** Take back the newest queued prompt; the host answers with `promptUnsent`. */
  | { type: 'unsendPrompt' }
  /**
   * Send now (ADR-0023, F5): stop the planner turn in flight and answer `text`
   * in the turn that replaces it, ahead of anything waiting. With no turn
   * running it is a plain send.
   */
  | { type: 'sendMessageNow'; text: string }
  /** Send one held prompt now, by its position in the hold; the rest stay held in order. */
  | { type: 'sendHeldPromptNow'; index: number }
  | { type: 'ready' }
  /** A per-task model dropdown opened — re-discover so a stale/degraded catalog self-heals. */
  | { type: 'refreshModels' }
  | { type: 'stopResearch' }
  | { type: 'newSession' }
  /** A notice the webview raised (a task action, the watchdog) — the conversation belongs to the host. */
  | { type: 'addNote'; text: string }
  /** Open (or focus) the on-demand task-log tab for a structured task (ADR-0018, V1). */
  | { type: 'openTaskLog'; taskId: string }
  /** Open a workspace-relative file Ordewell kept, such as a handoff's saved patch (ADR-0050). */
  | { type: 'openFile'; path: string }
  /** The plan dock's dragged height in px, saved on release so every later session opens at it. */
  | { type: 'setPlanDockHeight'; height: number }
  /**
   * A Runners pill clicked: save the runner on or off in the settings file every
   * surface shares (ADR-0043), then re-send the runner list. It names the state
   * wanted, so a repeated or stale click can never flip a newer choice back;
   * `requestId` is what the host's `runnerChoiceSaved` answers.
   */
  | { type: 'setRunnerEnabled'; runnerId: RunnerId; enabled: boolean; requestId: string }
  /** Who plans (ADR-0009) — a vendor provider id or one of the harness planners. */
  | { type: 'setPlanner'; provider: string }
  /** The planner's own model and thinking effort, a pair so neither can outlive the other. */
  | { type: 'setPlannerModel'; modelId: string; effort?: string }
  /**
   * One setting changed in the Settings panel's Run block (ADR-0030). The host
   * validates and asks before Act or autorun; it answers with `setRunSettings`
   * either way, so a declined change shows its old value again.
   */
  | { type: 'changeSettings'; change: SettingsChange }
  /**
   * An action on an isolated run, from a task's conflict indicator or the
   * handoff card. Reviewing, merging, discarding and cleaning up are all
   * asymmetric operations the host alone can confirm and perform.
   */
  | { type: 'isolationAction'; action: IsolationActionKind; taskId?: string }
  /**
   * Sign a coding agent in with its own login, in a real terminal: the flows
   * are interactive. A runner names that agent; absent means the active planner.
   */
  | { type: 'loginPlanner'; runner?: string };

/** One change from the Settings panel's Run block: Full/Guarded, run settings (ADR-0030) or the parallel limit. */
export interface SettingsChange {
  autonomous?: boolean;
  run?: Partial<GlobalRunSettings>;
  maxParallel?: number;
}

export type HostToWebview =
  | { type: 'taskCommands'; taskId: string; commands: readonly RunnerCommand[] }
  | { type: 'setState'; state: ChatState }
  | ConversationPatch
  /**
   * A planner turn opened or closed: what turns a send into a hold, and Esc
   * into unsend or stop. `startedAt` (ISO) dates an open one for its elapsed
   * time (#81); an older daemon sends none.
   */
  | { type: 'plannerTurn'; active: boolean; startedAt?: string }
  /** The planner is working without producing anything visible; keeps the webview's watchdog quiet. */
  | { type: 'plannerLiveness' }
  /**
   * The open turn itself produced something: an event carrying its turn id.
   * Unlike liveness, which names no turn, this says the turn is still out, so
   * a webview whose watchdog gave up on it locks the composer again.
   */
  | { type: 'plannerTurnAlive' }
  | { type: 'planUpdated'; plan: SurfacePlan }
  /**
   * The run as the host folded every session event: each task's plan fields and
   * what the status stream said, the run's merge view, usage, run settings,
   * handoff and last Merge all result. One message per change — the webview
   * mirrors it, and a late joiner is sent `Session.runSnapshot()` through this
   * same message.
   */
  | { type: 'runView'; view: RunView }
  /**
   * What the scheduler is doing after an Execute settled: the authoritative
   * word that ends the webview's own "Starting…" and starts the run's real
   * state. `requestId` is the Execute that asked, so a reply that outlives the
   * session it belonged to is dropped.
   */
  | { type: 'runActivity'; activity: RunActivity; requestId?: number }
  | { type: 'taskOutput'; taskId: string; text: string }
  /** The queued prompts the host is holding for the next planner turn, oldest first. */
  | { type: 'heldPrompts'; prompts: PromptHold }
  /** Queued text the host gave back, to go above whatever is in the input. */
  | { type: 'promptUnsent'; text: string }
  | { type: 'showError'; error: string }
  | { type: 'setModels'; models: DiscoveredModel[] }
  | { type: 'setRunners'; runners: RunnerMeta[] }
  /**
   * The answer to one `setRunnerEnabled`, saved, refused or failed: `enabled`
   * is what the shared list holds for that runner now. Only this settles a
   * pill click; a runner list names no request, so one that discovery began
   * before the save can neither settle the click nor undo it.
   */
  | { type: 'runnerChoiceSaved'; requestId: string; runnerId: RunnerId; enabled: boolean }
  /** The remembered plan dock height in px; absent until the user first drags it. */
  | { type: 'planDockHeight'; height?: number }
  /** The user's autonomy level, run settings (ADR-0030) and parallel limit, sent on ready and after each change. */
  | { type: 'setRunSettings'; autonomous: boolean; run: GlobalRunSettings; maxParallel: number }
  /** `/settings`: open the Settings panel at its Run block. */
  | { type: 'openSettings' }
  /** Discovered skills (global ~/.ordewell/skills/ + workspace .ordewell/skills/, global wins over workspace) for the /skill-name suggestion dropdown. */
  | { type: 'setSkills'; skills: { name: string; description: string; appliesTo?: 'planner' | 'task' }[] }
  /** Every `applies-to: task` skill, user-only ones included: what a task card's skill chips can attach. */
  | { type: 'setTaskSkills'; skills: { name: string; description: string }[] }
  | { type: 'setConfiguredProviders'; providers: AiProvider[] }
  | { type: 'setModelOptions'; modelOptions: ModelOption[] }
  /** The per-runner model allowlist, sent on ready and after each change: what a task card flags a model against. */
  | { type: 'setModelAllowlist'; allowlist: Record<string, string[]> }
  | { type: 'setModelsByRunner'; modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>> }
  /**
   * The login a `loginPlanner` asked for has ended, so the webview clears its
   * pending state. `runner` is the agent the host actually signed in — the
   * resolved one, even when the request named none — and `message` is the short
   * reason a sign-in did not finish, shown inline.
   */
  | { type: 'plannerLoginEnded'; runner?: string; ok: boolean; message?: string }
  /** `notice` is the one line the runner list shows while a runner's modes are off on this host, and the page that explains it. */
  | { type: 'setModesByRunner'; modesByRunner: Record<string, RunnerModeMeta[]>; notice?: { line: string; docs: string } | null }
  | { type: 'setModelConfig'; modelConfig: { orchestrator: string; orchestratorProvider?: string } }
  | { type: 'setPlannerBackends'; backends: PlannerBackend[]; provider: string; runner?: string; effort?: string }
  | { type: 'setModelDiscoveryErrors'; errors: Record<string, string> }
  /**
   * A session was (re)loaded: the webview drops the previous session's plan,
   * task output, isolation and any stuck busy state. The conversation itself
   * arrives as a `conversationPatch`.
   */
  | { type: 'restoreChat' }
  /**
   * Every installed runner's account limits as the host's monitor last read
   * them, sent on each change and on ready. Live account data: it outlives a
   * restored or new session, and is never part of the planner's usage.
   */
  | { type: 'accountLimits'; limits: readonly AccountLimitSnapshot[] }
  /**
   * What the workspace's repositories and branches say about isolated worktrees,
   * read now. `null` is "being read": sent when the answer shown belongs to a
   * workspace or a webview that is gone, so an old branch is never shown as
   * current. A read that failed arrives as a `failed` preview, never as null.
   */
  | { type: 'isolationPreview'; preview: IsolationPreview | null };
