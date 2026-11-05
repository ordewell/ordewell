import { TaskModeUnsupportedError, type AgentAdapter, type AgentProcessDeps, type TaskModeAgentAdapter } from './AgentAdapter';
import { ClaudeCodeAdapter } from './ClaudeCodeAdapter';
import { CodexAdapter } from './CodexAdapter';
import { OpenCodeAdapter } from './OpenCodeAdapter';
import { CLAUDE_ORDEWELL } from './claudeOrdewell';
import { CODEX_ORDEWELL } from './codexOrdewell';
import { OPENCODE_ORDEWELL } from './openCodeOrdewell';
import type { OrdewellToolBinding } from './ordewellBinding';
import type { RepoConfigReader } from './repoConfig';
import type { KeySignInRoute } from '../signInHint';
import { CLAUDE_REPO_CONFIG } from './claudeRepoConfig';
import { CODEX_REPO_CONFIG } from './codexRepoConfig';
import { OPENCODE_REPO_CONFIG } from './openCodeRepoConfig';
import { claudeUsageLimitReset } from './claudeUsageLimit';
import { codexUsageLimitReset } from './codexUsageLimit';
import { acpConnector } from './acpProfiles';
import { COPILOT_CLI_PROFILE } from './copilotProfile';
import { QWEN_CODE_PROFILE } from './qwenProfile';
import { CLINE_PROFILE } from './clineProfile';
import { GEMINI_CLI_PROFILE } from './geminiProfile';
import { CURSOR_AGENT_PROFILE } from './cursorProfile';

/**
 * One runner's connector: the adapter that drives it over its programmatic
 * protocol, as a task's runner (ADR-0018, C1) and, where `plans` says so, as a
 * planner (ADR-0009).
 */
export interface RunnerConnector {
  create(deps: AgentProcessDeps): TaskModeAgentAdapter;
  /**
   * Whether the adapter can also plan. A connector can run tasks before it
   * can plan: the planner's envelope and read-only roles are their own work,
   * so a runner without them gets no harness planner and says why.
   */
  plans: boolean;
  /** How the adapter hands its runner the Ordewell MCP server (ADR-0022), without which it can neither run a task nor plan. */
  ordewellTools: OrdewellToolBinding;
  /** What the runner would load from a repository, which Ordewell reads for its planner instead (ADR-0028). */
  repoConfig: RepoConfigReader;
  /**
   * The runner uses its Ordewell token only once a prompt runs, so its first
   * turn is the attach check and a planner spawns it with that turn, not
   * before (ADR-0060, R5). Absent: it attaches as its session opens.
   */
  attachesOnFirstTurn?: boolean;
  /**
   * When the runner's usage limit resets, read from the tail of what it
   * printed as it stopped; null when the wording names no time. Absent for a
   * runner that prints none of its own — OpenCode passes its provider's error
   * text through. May throw on a time it cannot place.
   */
  usageLimitReset?(tail: string, now: Date): Date | null;
  /**
   * How long its prompt cache lasts: the shortest it may be, so a wake that
   * counts on it finds its prefix warm (ADR-0057 R4). Absent where it depends
   * on a provider Ordewell cannot see.
   */
  promptCacheTtlMs?: number;
  /** A key in Ordewell that signs the runner in, besides its own login. */
  signInRoute?: KeySignInRoute;
}

/** Claude's default, and what an API login gets; a subscription's runs recorded here write the hour-long kind. OpenAI's, which Codex uses, is 5 to 10 minutes idle. */
const FIVE_MINUTES = 5 * 60_000;

/**
 * The runners Ordewell drives over their own protocols, by runner id. Being
 * here is what gives a runner a task-mode connector, and with `plans` a
 * harness planner; a runner that is not here cannot run tasks at all. An ACP
 * runner plans only when its profile claims the role on evidence (ADR-0060, R3).
 */
export const CONNECTORS: Readonly<Record<string, RunnerConnector>> = {
  'claude-code': { create: (deps) => new ClaudeCodeAdapter(deps), plans: true, ordewellTools: CLAUDE_ORDEWELL, repoConfig: CLAUDE_REPO_CONFIG, usageLimitReset: claudeUsageLimitReset, promptCacheTtlMs: FIVE_MINUTES },
  codex: { create: (deps) => new CodexAdapter(deps), plans: true, ordewellTools: CODEX_ORDEWELL, repoConfig: CODEX_REPO_CONFIG, usageLimitReset: codexUsageLimitReset, promptCacheTtlMs: FIVE_MINUTES },
  opencode: { create: (deps) => new OpenCodeAdapter(deps), plans: true, ordewellTools: OPENCODE_ORDEWELL, repoConfig: OPENCODE_REPO_CONFIG },
  'copilot-cli': acpConnector(COPILOT_CLI_PROFILE),
  'qwen-code': acpConnector(QWEN_CODE_PROFILE),
  cline: acpConnector(CLINE_PROFILE),
  'gemini-cli': acpConnector(GEMINI_CLI_PROFILE),
  'cursor-agent': acpConnector(CURSOR_AGENT_PROFILE),
};

/** The connector for a runner id; undefined for an unknown id (including `toString`). */
export function connectorFor(runner: string): RunnerConnector | undefined {
  return Object.hasOwn(CONNECTORS, runner) ? CONNECTORS[runner] : undefined;
}

/** A harness planner for a runner, or null when the runner cannot plan. */
export function createPlannerAdapter(runner: string, deps: AgentProcessDeps): AgentAdapter | null {
  const connector = connectorFor(runner);
  return connector?.plans ? connector.create(deps) : null;
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
