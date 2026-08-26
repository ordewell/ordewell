/**
 * Browser-safe entry point: pure plan-validation utilities with no Node or
 * AI-service dependencies. UI surfaces (the VS Code webview runs in a browser)
 * import runtime values from here instead of the main barrel, which bundles the
 * Gemini/OpenAI services and their `fs`/`child_process` imports.
 */
export { canMergeTasks, canSplitTask, canSetDependencies, dependencyCandidates, dependentsOf } from './services/TaskOps';
export type { TaskRef } from './services/TaskOps';
export { summarizeToolCall } from './services/researchStepSummary';
export { truncateCheckpointSummary, CHECKPOINT_TRUNCATE_LENGTH } from './services/SessionMessage';
