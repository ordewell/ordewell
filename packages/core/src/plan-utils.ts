/**
 * Browser-safe entry point: pure plan-validation utilities with no Node or
 * AI-service dependencies. UI surfaces (the VS Code webview runs in a browser)
 * import runtime values from here instead of the main barrel, which bundles the
 * Gemini/OpenAI services and their `fs`/`child_process` imports.
 */
export { canSetDependencies, dependencyCandidates, dependentsOf } from './services/PlanTree';
export { summarizeToolCall } from './services/researchStepSummary';
// A daemon refusal flattened once, so the desktop renderer reads it as the CLI does.
export { DaemonRefusal, refusalOf } from './utils/daemonRefusal';
// Which agent tools write a file, so a surface's summary of a run of calls
// counts an edit the way a row's diff is decided.
export { isFileEditTool } from './services/harness/agentTools';
export { truncateCheckpointSummary, CHECKPOINT_TRUNCATE_LENGTH, IDLE_ACTIVITY } from './services/SessionMessage';
export { capConflictFiles } from './services/conflictFiles';
// What the planner's decision record still holds (ADR-0067): a surface shows it without the superseded entries.
export { live as standingRecord } from './services/decisionRecord';
export { describeMergeResult, mergeOutcome, blockNotice, blockNotices, repairedLanded, repairedNotice } from './services/mergeResultNotice';
export { describeIsolationPreview } from './services/isolationPreviewText';
export type { IsolationPreviewNotice } from './services/isolationPreviewText';
export { checkoutRule, handoffBaseLine, handoffBranchName, isRepoGroup, mergeBesideOpsConfirmation, mergePastChecksConfirmation, mergeTarget, repoBaseLine, repoResultLines } from './services/mergeWording';
export type { HandoffForkRepo } from './services/mergeWording';
export { blockingFailures, repeatingChecks, planBlocks, type BlockingSubject, type PlanBlocks } from './services/blocking';
// What a loop's rows say (ADR-0045) is read the way the scheduler reads it.
export { betweenRounds, outOfRounds, loopRoundOf, checkOf, loopRemovalRefusal, type TaskLoop } from './models/Loop';
// The run settings' own defaults, for a surface that restores them; pure, so a renderer may read them.
export { DEFAULT_AUTONOMOUS_MODE, DEFAULT_SUPERVISOR_RETRY_LIMIT, DEFAULT_WAKE_UP_READ_BUDGET, RUN_SETTINGS_DEFAULTS, SHAPE_LIMITS, type GlobalRunSettings, type TreeShape } from './services/runSettingsDefaults';
export { DEFAULT_MAX_PARALLEL } from './utils/maxParallel';
export { ACT_RISK, AUTORUN_RISK, DELEGATION_OFFERED, DELEGATION_NETWORK_RISK, DELEGATION_RISK, containersOffered, PLANNED_WITH_LABEL, SUBPLANNER_ACCOUNTING, SUBPLANNER_CHILD, SUBPLANNER_SCOPE, SUPERVISOR_LEVEL_LABEL, keptDelegationBudget, parseCount, rememberDelegationBudget } from './services/runSettingsText';
// The empty planner composer's tips (#137), one table for both planner chats.
export { COMPOSER_TIPS, composerTip, type ComposerTip } from './services/composerTips';
// The shared conversation view (#51) is pure too, so every surface — a webview
// included — draws from the same reducer.
export * from './conversation';
// The task row view is pure for the same reason: the webview draws a task card
// from the facts the TUI paints its plan row from.
export * from './taskRow';
// A handoff's own wording (ADR-0047), shared by both task views so a severity
// and a reference read the same wherever they are drawn.
export { SEVERITY_LABEL, severityLabel, worstSeverity, handoffReferenceText, heldWords } from './models/Handoff';
export { onOneLine } from './models/lineBreaks';
export type { FindingSeverity, HandoffArtifact, HandoffDigest, HandoffEvidence, HandoffFinding, StoredHandoff } from './models/Handoff';
export { taskOrderLabel, taskRef, taskRefOf, titledTaskRef, titledTaskRefOf, resolveTaskRef, resolveUserTaskRef } from './services/TaskRefs';
export type { RefTask } from './services/TaskRefs';
// The one runner default, shared with the webview so its initial state cannot
// drift from the plans the host builds.
export { DEFAULT_RUNNERS, pausedOnLimit } from './models/Task';
// The runner catalog is pure, so a renderer can list every agent, its name and
// its install page without the manifests' Node-only readers.
export { RUNNER_CATALOG, RUNNER_IDS, RUNNER_LABELS, RUNNER_INSTALL_DOCS, type RunnerCatalogEntry } from './services/runnerCatalog';
export { builtinPlannerBackends, HARNESS_PLANNER_REASON, HARNESS_PLANNER_UNAVAILABLE_REASON, type PlannerBackendEntry, type PlannerUsability } from './services/plannerBackends';
// The model a task's log last served, for a task log host that runs in a
// renderer the way TaskLogPanel runs in the extension: its account limits are that model's.
export { lastServedModel } from './models/TaskLog';
// A script task's body as its card and the approval card show it (ADR-0035).
export { scriptTaskText } from './models/ScriptTask';
// The VS Code webview words a signed-out agent from the verdict it is handed (ADR-0052).
export { describeRunnerSignIn, describeSignIn, describeSignInWays, signInAction, signInOfVerdict, TERMINAL_UI_SIGN_IN, type RunnerSignIn } from './services/signInHint';
// The vendors' labels and key variables, pure data a webview may hold: the key entry names the vendor it is for.
export { VENDORS, PROVIDER_PRIORITY, type ProviderRegistration } from './services/apiProviders';
// The run view is pure too: a surface seeds its state from the one empty run
// rather than re-declaring the shape, and a host in a renderer folds it the same way.
export { EMPTY_RUN, reduceRun } from './services/runView';

export * from './models/Usage';
// An account's limits are worded once too, for the planner footer and each task log alike.
export * from './models/AccountLimits';

export { walkPlan, taskPlacement, subtreeIds } from './services/PlanTree';
export type { TreeTask, TaskPlacement } from './services/PlanTree';
export { rejoinPlanTree } from './models/Task';

// The one rule for the effort a model change keeps, so a surface's model
// picker lands where core's resolver would.
export { clampThinkingEffort } from './services/ModelAllowlistResolver';
// The order a session's stamped broadcasts arrive in (ADR-0017), read the same by the TUI and the desktop.
export { StreamOrder, stampOf, type Placement } from './utils/streamOrder';
// Following a daemon socket behind a REST read, and when to follow it again, one way for every surface.
export { DaemonStream, type ConnectedFrame, type DaemonFrame } from './utils/daemonStream';
export { ReconnectBackoff } from './utils/reconnectBackoff';
// The daemon's routes, from which the desktop derives the allowlist its renderer calls through (ADR-0063 H4).
export { DAEMON_ROUTES, type DaemonRoute, type DaemonRouteId, type HttpMethod, type RouteBody, type RouteResponse, type RouteSpec } from './daemonRoutes';
