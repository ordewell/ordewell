import { withPath } from '../../utils/shellPath';

/**
 * Host variables a runner must not inherit. A host started from inside a
 * Claude Code session carries `CLAUDECODE`, which a runner's `claude` reads as
 * being nested in that session, and a host being debugged carries Node flags
 * that every Node-based runner would pick up as its own.
 */
export const HOST_ONLY_VARIABLES: readonly string[] = ['CLAUDECODE', 'NODE_OPTIONS', 'NODE_INSPECT', 'NODE_DEBUG'];
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

function without<T>(source: Record<string, T>, drop: (key: string) => boolean): Record<string, T> {
  const kept: Record<string, T> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!drop(key)) kept[key] = value;
  }
  return kept;
}

/**
 * The environment a runner process is spawned under: the host's, minus
 * {@link HOST_ONLY} and any MCP token; then the workspace's own variables
 * (ADR-0016), which still win if they set a host-only one on purpose but never
 * supply a token; then the adapter's `launch` variables, the only source of one.
 */
export function runnerEnv(
  resolvedPath: string,
  workspace: Record<string, string> = {},
  launch: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const host = without(process.env, (key) => isHostOnly(key) || isMcpToken(key));
  return withPath(host, resolvedPath, { ...without(workspace, isMcpToken), ...launch });
}
