import type { RunnerManifest } from '../../plugins/types';
import type { TaskRunnerFlags } from './AgentAdapter';
import type { AcpToolCall } from './acpSchema';
import { AcpAdapter } from './AcpAdapter';
import { acpOrdewellBinding } from './acpOrdewell';
import { acpRoles } from './acpRoles';
import type { RunnerConnector } from './connectors';
import { NO_SERVERS, type RepoConfigReader } from './repoConfig';

/**
 * How a task's instructions reach an ACP agent, which has no system-prompt
 * field of its own (ADR-0018, C2; ADR-0060, R6). Never a file in the task's worktree: the
 * agent's own channel outside it where the agent has one, the first prompt of
 * each process otherwise.
 */
export type AcpInstructionsRoute =
  /** Ahead of the first prompt every process is sent, a resumed one's too. */
  | { kind: 'prompt' }
  /** In `session/new`'s `_meta` under `key`, a field the agent documents. */
  | { kind: 'meta'; key: string }
  /**
   * An owner-only file outside the worktree, named to the agent by a flag or
   * an environment variable, or found by name in a private directory the
   * variable names, for an agent that loads instruction files from the
   * directories it is given.
   */
  | { kind: 'file'; fileName: string; pass: { flag: string } | { env: string } | { envDir: string } };

/** Ordewell's MCP server as a settings file renders it: the token travels in `headers`, as in `session/new`. */
export interface AcpMcpEntry {
  name: string;
  url: string;
  headers: Readonly<Record<string, string>>;
}

/**
 * How Ordewell's MCP server reaches an agent that does not take it from
 * `session/new`: some agents store the servers given there and never connect
 * to them, and advertise no `mcpCapabilities.http`, yet load MCP servers from
 * a settings file of their own (ADR-0060, R4). The file holds the attempt's
 * token, so it is written owner-only into the process's private directory,
 * never the worktree, named to the agent by `pass`, removed with the process,
 * and swept at a later start if Ordewell died first. The attach is still judged
 * by the server's record of the token's first use, never by the file's being
 * written.
 */
export interface AcpMcpConfigRoute {
  kind: 'file';
  /** The name the agent's settings file has, inside the process's private directory. */
  fileName: string;
  /** The whole file, in the agent's own settings format, holding only Ordewell's server. */
  render(mcp: AcpMcpEntry): string;
  /** The environment variable the agent reads the settings file's path from. */
  pass: { env: string };
}

/**
 * How the plan's mode reaches the agent at spawn (ADR-0001; ADR-0060, R7): its own switch,
 * so the agent asks nothing a mode already settled. Without one the adapter
 * answers the agent's requests per the manifest's mode settings.
 */
export type AcpModeRoute =
  /** Arguments that put the agent in the mode the flags name, such as an allow-all flag. */
  | { kind: 'args'; args(flags: TaskRunnerFlags): readonly string[] }
  /** `session/set_mode` to the flags' `permissionMode`: the agent's own mode id, through the manifest's `permissionModeValues`. */
  | { kind: 'session-mode' };

/**
 * What an agent may do past a writable task. Each role is claimed only on
 * evidence (ADR-0026, ADR-0046; ADR-0060, R3): {@link AcpProfile.restricted} takes the
 * agent's own write and shell tools away and holds under ACP, Ordewell refuses
 * every edit, delete, move and command the agent still asks for, and a
 * recorded live run shows a write and a command refused with nothing left
 * behind. A planner also runs nothing the repository's config names (ADR-0028).
 */
export interface AcpRoles {
  /** The connector's `plans`: the agent can be the planner. */
  plans: boolean;
  /** The manifest has a mode tagged `readOnly` (ADR-0031), so ModeResolver can assign a read-only task. */
  readOnly: boolean;
}

/** A permission request, with the turn's first report of the same call where the agent sent one. */
export interface AcpAskedCall {
  request: AcpToolCall;
  report?: AcpToolCall;
}

/** Spawn-level controls that take the agent's own write, shell and web tools away. */
export interface AcpRestriction {
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  /**
   * Start the agent in a private directory of its own, the session's cwd and
   * its temp directory too, for an agent that takes the directory it starts in
   * as configuration to load: its hooks run the repository's code, and no
   * switch of its own turns them off (ADR-0028). The directory holds only the
   * instructions, as its own, and the MCP settings file where the profile has
   * one. The agent then reaches the workspace only by
   * asking, and every read is put to the envelope (ADR-0060, R3).
   */
  privateCwd?: boolean;
}

/**
 * Everything one ACP agent needs past the protocol itself: a profile is data,
 * so a new agent is a profile and a manifest, not an adapter (ADR-0060, R1).
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
   * The Ordewell tool a permission request is for, by its name on the server,
   * or null for any other call. Each agent words MCP calls its own way, in the
   * request and in the turn's report of the same call, so the profile reads
   * them; the binding then matches the result exactly (ADR-0022, S3). It is
   * decided before the call's kind is read, so a profile should not lean on
   * the kind: that is the agent's guess at what an MCP tool does.
   */
  ordewellTool(call: AcpAskedCall): string | null;
  /** The name the agent calls an Ordewell tool by, given its name on the server; the server's own name when absent. */
  toolName?(tool: string): string;
  /** Arguments that run the agent on the plan's model; absent when the agent cannot be told one at spawn. */
  modelArgs?(model: string): readonly string[];
  instructions: AcpInstructionsRoute;
  /**
   * Absent: the agent takes Ordewell's server in `session/new` and must
   * advertise `mcpCapabilities.http`. Present: it takes it from this settings
   * file, and needs no HTTP capability of the protocol's.
   */
  mcpConfig?: AcpMcpConfigRoute;
  /** Absent: the agent has no mode switch, so the adapter answers its requests per the mode. */
  mode?: AcpModeRoute;
  /** What the agent loads from a repository, handed instead to a planner and to a read-only task started outside it (ADR-0028). None when absent. */
  repoConfig?: RepoConfigReader;
  usageLimitReset?(tail: string, now: Date): Date | null;
  promptCacheTtlMs?: number;
  /** Absent: writable tasks only. */
  roles?: AcpRoles;
  /** Applied on a planner's start and a read-only task's, on top of `args` and `env`; required by any role. */
  restricted?: AcpRestriction;
}

const NO_REPO_CONFIG: RepoConfigReader = { instructions: () => [], projectServers: () => NO_SERVERS };

/** The connector for the agent `profile` describes, for the connector table. */
export function acpConnector(profile: AcpProfile): RunnerConnector {
  return {
    create: (deps) => new AcpAdapter(deps, profile),
    plans: acpRoles(profile).plans,
    ordewellTools: acpOrdewellBinding(profile),
    repoConfig: profile.repoConfig ?? NO_REPO_CONFIG,
    ...(profile.usageLimitReset ? { usageLimitReset: profile.usageLimitReset } : {}),
    ...(profile.promptCacheTtlMs !== undefined ? { promptCacheTtlMs: profile.promptCacheTtlMs } : {}),
  };
}
