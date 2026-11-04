import type { RunnerManifest } from '../../plugins/types';
import type { TaskRunnerFlags } from './AgentAdapter';
import type { AcpToolCall } from './acpSchema';
import { AcpAdapter } from './AcpAdapter';
import { acpOrdewellBinding } from './acpOrdewell';
import type { RunnerConnector } from './connectors';
import { NO_SERVERS, type RepoConfigReader } from './repoConfig';

/**
 * How a task's instructions reach an ACP agent, which has no system-prompt
 * field of its own (ADR-0018, C2). Never a file in the task's worktree: the
 * agent's own channel outside it where the agent has one, the first prompt of
 * each process otherwise.
 */
export type AcpInstructionsRoute =
  /** Ahead of the first prompt every process is sent, a resumed one's too. */
  | { kind: 'prompt' }
  /** In `session/new`'s `_meta` under `key`, a field the agent documents. */
  | { kind: 'meta'; key: string }
  /** An owner-only file outside the worktree, named to the agent by a flag or an environment variable. */
  | { kind: 'file'; fileName: string; pass: { flag: string } | { env: string } };

/**
 * How the plan's mode reaches the agent at spawn (ADR-0001): its own switch,
 * so the agent asks nothing a mode already settled. Without one the adapter
 * answers the agent's requests per the manifest's mode settings.
 */
export type AcpModeRoute =
  /** Arguments that put the agent in the mode the flags name, such as an allow-all flag. */
  | { kind: 'args'; args(flags: TaskRunnerFlags): readonly string[] }
  /** `session/set_mode` to the flags' `permissionMode`: the agent's own mode id, through the manifest's `permissionModeValues`. */
  | { kind: 'session-mode' };

/**
 * Everything one ACP agent needs past the protocol itself: a profile is data,
 * so a new agent is a profile and a manifest, not an adapter.
 */
export interface AcpProfile {
  /** The runner's manifest: its command, display name, modes and login. */
  manifest: RunnerManifest;
  /** The arguments that make the command speak ACP on stdio. */
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  /** The oldest agent version this profile was checked against, compared with `agentInfo.version`. */
  minVersion?: string;
  /** How long `initialize`, `session/new` and the mode switch may each take; 30 s when absent. */
  initTimeoutMs?: number;
  /** How long the agent may take to first use its Ordewell token before the attach counts as missed; MCP_ATTACH_TIMEOUT_MS when absent. */
  attachTimeoutMs?: number;
  /**
   * The Ordewell tool a call names, by its name on the server, or null for
   * any other call. Each agent reports MCP calls in its own words, so the
   * profile reads them; the binding then matches the result exactly
   * (ADR-0022, S3).
   */
  ordewellTool(call: AcpToolCall): string | null;
  instructions: AcpInstructionsRoute;
  /** Absent: the agent has no mode switch, so the adapter answers its requests per the mode. */
  mode?: AcpModeRoute;
  /** What the agent loads from a repository, which the planner reads instead (ADR-0028). None when absent. */
  repoConfig?: RepoConfigReader;
  usageLimitReset?(tail: string, now: Date): Date | null;
  promptCacheTtlMs?: number;
}

const NO_REPO_CONFIG: RepoConfigReader = { instructions: () => [], projectServers: () => NO_SERVERS };

/** The connector for the agent `profile` describes, for the connector table. */
export function acpConnector(profile: AcpProfile): RunnerConnector {
  return {
    create: (deps) => new AcpAdapter(deps, profile),
    ordewellTools: acpOrdewellBinding(profile),
    repoConfig: profile.repoConfig ?? NO_REPO_CONFIG,
    ...(profile.usageLimitReset ? { usageLimitReset: profile.usageLimitReset } : {}),
    ...(profile.promptCacheTtlMs !== undefined ? { promptCacheTtlMs: profile.promptCacheTtlMs } : {}),
  };
}
