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

/**
 * A file a restricted start hands the agent, for an agent with no deny flag of
 * its own: a settings file that registers a hook refusing writes and commands,
 * or the hook's script, or a settings file that denies the agent's own tools
 * in a home of configuration {@link AcpRestriction.configDirs} moves (ADR-0060, R3).
 */
export interface AcpRestrictedFile {
  /** Its name in the process's private directory, under one of {@link AcpRestriction.configDirs} for a file the agent finds there. */
  fileName: string;
  /**
   * The whole file, from the private directory's path alone, so one file can
   * name another there: a hook's settings name its script. Nothing of the
   * attempt reaches it, neither the provider credential nor the token, so the
   * file never holds a secret; Ordewell's server reaches the agent by
   * `session/new` or {@link AcpProfile.mcpConfig}.
   */
  render(dir: string): string;
  /** Absent: the agent finds it by another file's naming it. */
  pass?: { env: string } | { flag: string };
}

/** Spawn-level controls that take the agent's own write, shell and web tools away. */
export interface AcpRestriction {
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  /**
   * Start the agent in a private directory of its own, the session's cwd and
   * its temp directory too, for an agent that takes the directory it starts in
   * as configuration to load: its hooks run the repository's code, and no
   * switch of its own turns them off (ADR-0028). The directory holds only
   * what this start hands the agent: the instructions, as its own, the MCP
   * settings file where the profile has one, and {@link files}. The agent then
   * reaches the workspace only by asking, and every read is put to the
   * envelope (ADR-0060, R3).
   */
  privateCwd?: boolean;
  /**
   * Written owner-only into the process's private directory, never the
   * worktree, and gone with it, for an agent whose own controls are a settings
   * file or a hook rather than a flag. A layer under the adapter's refusal of
   * every edit, delete, move and command by its kind, never in place of it.
   */
  files?: readonly AcpRestrictedFile[];
  /**
   * Variables that move the agent's home of configuration, each set to an
   * owner-only directory of this start's own in its private directory, empty
   * but for the {@link files} named inside it, so the user's global settings,
   * rules, hooks, plugins and skills do not load. What the agent keeps there
   * goes with the process.
   */
  configDirs?: readonly string[];
  /**
   * The agent's own tool that loads a deferred tool's schema, for an agent
   * that refuses a call of an MCP tool the model has not loaded first: a
   * planner's or read-only task's first prompt tells the model to load each
   * Ordewell tool with it, as the recordings of those starts show working
   * (ADR-0060, R3). A writable start's prompt stays as its recordings have it.
   */
  toolSearch?: string;
}

/** What an extension request's answer may depend on: the start it came to, never a person. */
export interface AcpExtensionContext {
  kind: 'planner' | 'task';
  /** A planner's start or a read-only task's, under {@link AcpProfile.restricted}. */
  restricted: boolean;
}

/**
 * The answer to one of the agent's own client-bound methods. `params` is
 * whatever the agent sent, so a handler narrows it; undefined means the
 * request is not one it can answer, and the agent hears "method not found",
 * as it would with no handler at all.
 */
export type AcpExtensionHandler = (params: unknown, context: AcpExtensionContext) => Record<string, unknown> | undefined;

/** What a profile's credential hook may read: the variables the agent would start under without it. */
export interface AcpCredentialContext {
  /** The host's environment, then the workspace's own variables over it (ADR-0016). */
  env: Readonly<Record<string, string | undefined>>;
  kind: 'planner' | 'task';
}

/**
 * The provider credential one spawn of an agent starts under: the key
 * configured in Ordewell, in the variables that agent reads, else what the
 * agent's own store holds where it does not read that store over ACP
 * (ADR-0060, R9; ADR-0051). Answers the variables to add to that spawn's
 * environment, null when the agent needs none from Ordewell, and throws,
 * naming the routes that would sign it in, when it has none. What it answers
 * holds a secret: it reaches the process's environment and nothing else.
 */
export type AcpCredentials = (context: AcpCredentialContext) => Promise<Readonly<Record<string, string>> | null>;

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
  /** Absent: the agent finds its own provider credential, and its spawn carries none from Ordewell. */
  credentials?: AcpCredentials;
  /**
   * A route besides the agent's own login that signs it in, as a clause the
   * signed-out message offers after that login: the one `credentials` reads.
   */
  signInRoute?: string;
  /** The oldest agent version this profile was checked against, compared with `agentInfo.version`. */
  minVersion?: string;
  /** How long `initialize`, `session/new` and the mode switch may each take; 30 s when absent. */
  initTimeoutMs?: number;
  /**
   * How long the agent may take to first use its Ordewell token before the
   * attach counts as missed, from its start or, under `attach: 'firstTurn'`,
   * from the first turn's; MCP_ATTACH_TIMEOUT_MS when absent.
   */
  attachTimeoutMs?: number;
  /**
   * When the agent first uses its Ordewell token (ADR-0060, R5). `sessionNew`,
   * the default: by the time its session is open, so the task is sent only
   * once it has. `firstTurn`: only once a prompt starts its runtime, as an
   * agent that connects its MCP servers then does, so the task's prompt is
   * the check. That turn is kept only if the token is used before it ends;
   * otherwise it is discarded with its process. No planner role: a planner
   * has no task to send as the check.
   */
  attach?: 'sessionNew' | 'firstTurn';
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
  /**
   * Answers to the agent's own requests by method, for an agent that holds a
   * turn until the client replies to one (Cursor's `cursor/ask_question`).
   * Every other request is answered "method not found". A method in ACP's
   * client namespaces (`session/`, `fs/`, `terminal/`) is the adapter's: a
   * handler under one is never served (ADR-0060).
   */
  extensionRequests?: Readonly<Record<string, AcpExtensionHandler>>;
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
