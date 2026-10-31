/**
 * Browser-safe entry point: pure plan-validation utilities with no Node or
 * AI-service dependencies. UI surfaces (the VS Code webview runs in a browser)
 * import runtime values from here instead of the main barrel, which bundles the
 * Gemini/OpenAI services and their `fs`/`child_process` imports.
 */
export { canMergeTasks, canSplitTask, canSetDependencies, dependencyCandidates, dependentsOf } from './services/TaskOps';
export type { TaskRef } from './services/TaskOps';
export { summarizeToolCall } from './services/researchStepSummary';
// Which agent tools write a file, so a surface's summary of a run of calls
// counts an edit the way a row's diff is decided.
export { isFileEditTool } from './services/harness/agentTools';
export { truncateCheckpointSummary, CHECKPOINT_TRUNCATE_LENGTH, IDLE_ACTIVITY } from './services/SessionMessage';
export { capConflictFiles } from './services/conflictFiles';
export { describeMergeResult, mergeOutcome, blockNotice, blockNotices, repairedLanded, repairedNotice } from './services/mergeResultNotice';
export { describeIsolationPreview } from './services/isolationPreviewText';
export type { IsolationPreviewNotice } from './services/isolationPreviewText';
export { handoffBaseLine, handoffBranchName, isRepoGroup, repoBaseLine, repoResultLines } from './services/mergeWording';
export type { HandoffForkRepo } from './services/mergeWording';
export { blockingFailures, repeatingChecks, planBlocks, type BlockingSubject, type PlanBlocks } from './services/blocking';
// What a loop's rows say (ADR-0045) is read the way the scheduler reads it.
export { betweenRounds, outOfRounds, loopRoundOf, checkOf, loopRemovalRefusal, type TaskLoop } from './models/Loop';
export { DELEGATION_OFFERED, PLANNED_WITH_LABEL, SUPERVISOR_LEVEL_LABEL, parseCount } from './services/runSettingsText';
// The shared conversation view (#51) is pure too, so every surface — a webview
// included — draws from the same reducer.
export * from './conversation';
// The task row view is pure for the same reason: the webview draws a task card
// from the facts the TUI paints its plan row from.
export * from './taskRow';
// A handoff's own wording (ADR-0047), shared by both task views so a severity
// and a reference read the same wherever they are drawn.
export { SEVERITY_LABEL, severityLabel, worstSeverity, handoffReferenceText } from './models/Handoff';
export type { FindingSeverity, HandoffArtifact, HandoffDigest, HandoffEvidence, HandoffFinding, StoredHandoff } from './models/Handoff';
export { taskOrderLabel, taskRef, taskRefOf, titledTaskRef, titledTaskRefOf, resolveTaskRef, resolveUserTaskRef } from './services/TaskRefs';
export type { RefTask } from './services/TaskRefs';
// The one runner default, shared with the webview so its initial state cannot
// drift from the plans the host builds.
export { DEFAULT_RUNNERS, pausedOnLimit } from './models/Task';
// A script task's body as its card and the approval card show it (ADR-0035).
export { scriptTaskText } from './models/ScriptTask';
// The run view is pure too: a surface seeds its state from the one empty run
// rather than re-declaring the shape.
export { EMPTY_RUN } from './services/runView';

export * from './models/Usage';
// An account's limits are worded once too, for the planner footer and each task log alike.
export * from './models/AccountLimits';

export { walkPlan, taskPlacement, subtreeIds } from './services/PlanTree';
export type { TreeTask, TaskPlacement } from './services/PlanTree';

// The one rule for the effort a model change keeps, so a surface's model
// picker lands where core's resolver would.
export { clampThinkingEffort } from './services/ModelAllowlistResolver';
