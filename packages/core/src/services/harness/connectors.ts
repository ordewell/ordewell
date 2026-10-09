import { TaskModeUnsupportedError, type AgentAdapter, type AgentProcessDeps, type TaskModeAgentAdapter } from './AgentAdapter';
import { ClaudeCodeAdapter } from './ClaudeCodeAdapter';
import { CodexAdapter } from './CodexAdapter';
import { OpenCodeAdapter } from './OpenCodeAdapter';
import { CLAUDE_ORDEWELL } from './claudeOrdewell';
import { CODEX_ORDEWELL } from './codexOrdewell';
import { OPENCODE_ORDEWELL } from './openCodeOrdewell';
import type { OrdewellToolBinding } from './ordewellBinding';

/**
 * One runner's connector: the adapter that drives it over its programmatic
 * protocol, as a planner (ADR-0009) and as a task's runner (ADR-0018, C1).
 */
export interface RunnerConnector {
  create(deps: AgentProcessDeps): TaskModeAgentAdapter;
  /** How the adapter hands its runner the Ordewell MCP server (ADR-0022), without which it can neither run a task nor plan. */
  ordewellTools: OrdewellToolBinding;
}

/**
 * The runners Ordewell drives over their own protocols, by runner id. Being
 * here is what gives a runner a task-mode connector and a harness planner; a
 * runner that is not here cannot run tasks at all.
 */
export const CONNECTORS: Readonly<Record<string, RunnerConnector>> = {
  'claude-code': { create: (deps) => new ClaudeCodeAdapter(deps), ordewellTools: CLAUDE_ORDEWELL },
  codex: { create: (deps) => new CodexAdapter(deps), ordewellTools: CODEX_ORDEWELL },
  opencode: { create: (deps) => new OpenCodeAdapter(deps), ordewellTools: OPENCODE_ORDEWELL },
};

/** The connector for a runner id; undefined for an unknown id (including `toString`). */
export function connectorFor(runner: string): RunnerConnector | undefined {
  return Object.hasOwn(CONNECTORS, runner) ? CONNECTORS[runner] : undefined;
}

/** A harness planner for a runner, or null when the runner cannot plan. */
export function createPlannerAdapter(runner: string, deps: AgentProcessDeps): AgentAdapter | null {
  return connectorFor(runner)?.create(deps) ?? null;
}

/** Whether Ordewell can run a runner's tasks (ADR-0018, S3). */
export function supportsTaskMode(runner: string): boolean {
  return connectorFor(runner) !== undefined;
}

/** The adapter that drives one task. Throws {@link TaskModeUnsupportedError} for a runner without a connector. */
export function createTaskAdapter(runner: string, deps: AgentProcessDeps): TaskModeAgentAdapter {
  const connector = connectorFor(runner);
  if (!connector) throw new TaskModeUnsupportedError(runner);
  return connector.create(deps);
}
