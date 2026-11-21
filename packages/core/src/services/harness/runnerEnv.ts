import { withPath } from '../../utils/shellPath';
import { OPENCODE_CONFIG_VARIABLE, withoutParentOrdewell } from './openCodeOrdewell';

/**
 * What a coding agent's shell tool sets for the commands it runs, naming the
 * session that ran them, its process, how it was started, or a channel back
 * into it. Ordewell started from such a shell (a plugin, a skill, a user's
 * `ordewell run` in a Claude Code Bash call) carries them, and a runner that
 * inherits them is one more child of that session: Claude Code links its
 * transcript to the parent and writes into the parent's notes, and the
 * parent's messaging token reaches every runner. A daemon outlives the session
 * that started it, so the parent they name is not even the one asking.
 * Read from each agent's build: what Claude Code 2.1.330 sets for its shell
 * and drops itself before starting a detached session, what Codex 0.170.0 sets
 * for its shell commands, and what OpenCode's bash tool sets. None of them
 * configures an agent: base URLs, models, accounts and proxies stay.
 */
export const PARENT_SESSION_VARIABLES: readonly string[] = [
  // Claude Code: `claude` reads it as being nested in that session.
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_CHILD_NOTES_DIR',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_STARTER_MAY_HOLD_CONNECTOR_FILE',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  // The parent's surface, which a child `claude` would take for its own (`claude-desktop`, `local-agent`).
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  // Codex's shell commands.
  'CODEX_THREAD_ID',
  'CODEX_TOOL_CALL_ID',
  // OpenCode's bash tool.
  'OPENCODE_SESSION_ID',
];
const PARENT_SESSION = new Set(PARENT_SESSION_VARIABLES);

/**
 * `env` minus {@link PARENT_SESSION_VARIABLES}, under any spelling: what a
 * daemon starts under, so the processes it runs beside its runners (git, a
 * worktree's setup command) are no part of the session that started it either.
 */
export function withoutParentSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !PARENT_SESSION.has(key.toUpperCase())));
}

/**
 * Host variables a runner must not inherit: a parent agent session's
 * ({@link PARENT_SESSION_VARIABLES}), and the Node flags of a host being
 * debugged, which every Node-based runner would pick up as its own.
 */
export const HOST_ONLY_VARIABLES: readonly string[] = [...PARENT_SESSION_VARIABLES, 'NODE_OPTIONS', 'NODE_INSPECT', 'NODE_DEBUG'];
const HOST_ONLY = new Set(HOST_ONLY_VARIABLES);

/**
 * The variables that carry an attempt's MCP server credential to a runner
 * reading its headers from its environment (ADR-0022, A5). A host that is
 * itself an Ordewell runner's child carries its parent's, so only the
 * adapter's own launch environment may set them: inherited, a stale or
 * surplus token would reach a child given no server, or sit beside a fresh one.
 */
export const MCP_TOKEN_VARIABLE_PREFIX = 'ORDEWELL_MCP_TOKEN_';

// Windows variable names are case-insensitive.
const isHostOnly = (key: string) => HOST_ONLY.has(key.toUpperCase());
const isMcpToken = (key: string) => key.toUpperCase().startsWith(MCP_TOKEN_VARIABLE_PREFIX);
const isOpenCodeConfig = (key: string) => key.toUpperCase() === OPENCODE_CONFIG_VARIABLE;

/**
 * `source` minus what `drop` names, and with an OpenCode configuration
 * stripped of any parent Ordewell's server: the same credential as a token,
 * carried in a variable every harness hands on to what it runs.
 */
function inherited(source: Record<string, string | undefined>, drop: (key: string) => boolean): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || drop(key)) continue;
    kept[key] = isOpenCodeConfig(key) ? withoutParentOrdewell(value) : value;
  }
  return kept;
}

/**
 * The environment a runner process is spawned under: the host's, minus
 * {@link HOST_ONLY} and any MCP token; then the workspace's own variables
 * (ADR-0016), which still win if they set a host-only one on purpose but never
 * supply a token; then the adapter's `launch` variables, the only source of one.
 * Neither inherited source keeps a parent Ordewell's OpenCode server entry.
 * `drop` removes what a launch must not carry from either inherited source,
 * such as the credentials a native-shell planner must not hold (ADR-0036 N2.2).
 * `platform` is the one the runner starts on, which decides whether two
 * spellings of a name are one variable or two.
 */
export function runnerEnv(
  resolvedPath: string,
  workspace: Record<string, string> = {},
  launch: Record<string, string> = {},
  drop?: (name: string) => boolean,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const host = inherited(process.env, (key) => isHostOnly(key) || isMcpToken(key) || drop?.(key) === true);
  return withPath(host, resolvedPath, { ...inherited(workspace, (key) => isMcpToken(key) || drop?.(key) === true), ...launch }, platform);
}
