import { ORDEWELL_MCP_SERVER_NAME, TASK_COMPLETE_TOOL, type McpClientConfig } from '../mcp';
import { MCP_CLIENT_TOOL_NAMES, listed, ordewellToolNames, type OrdewellToolBinding } from './ordewellBinding';
import { MCP_TOKEN_VARIABLE_PREFIX } from './runnerEnv';

/** A server→client request, as far as telling one for an Ordewell tool needs it. */
export interface CodexAsk {
  method: string;
  params: Record<string, unknown>;
}

export interface CodexOrdewellBinding extends OrdewellToolBinding<CodexAsk> {
  /** The variables that carry the server's headers, with their values, for the app-server's environment. */
  env(mcp: McpClientConfig): Record<string, string>;
  /** The thread config's `mcp_servers`. */
  threadServers(mcp: McpClientConfig): Record<string, unknown>;
  /** What a task thread's instructions say about the tools. */
  taskInstructions(): string;
}

/**
 * The environment variables that carry the server's headers to Codex, by
 * header name. Codex reads the value from its own environment, so a token is
 * in no argument and in no config Codex could write to disk (ADR-0022, A5).
 * `TOKEN` in the name keeps Codex's default shell policy from handing the
 * value to the commands the model runs.
 */
function headerEnv(mcp: McpClientConfig): Record<string, string> {
  return Object.fromEntries(Object.keys(mcp.headers).map((header, i) => [header, `${MCP_TOKEN_VARIABLE_PREFIX}${i}`]));
}

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const quoted = (names: string[]) => listed(names.map((name) => `\`${name}\``));

export const CODEX_ORDEWELL: CodexOrdewellBinding = {
  // Codex names a call by server and tool; the model reaches the tool by Claude Code's name for it.
  toolName: MCP_CLIENT_TOOL_NAMES.toolName,
  toolNames: MCP_CLIENT_TOOL_NAMES.toolNames,
  /** An elicitation Codex raises for one of the server's tools: an approval the grant should have made unnecessary. */
  isOrdewellAsk: ({ method, params }) => method === 'mcpServer/elicitation/request' && params.serverName === ORDEWELL_MCP_SERVER_NAME,
  /** `mcpServer/startupStatus/updated`'s status, unsent until the thread has tried to connect. */
  attachState: (status) => (status === 'ready' ? 'connected' : status === null || status === undefined || status === 'starting' ? 'pending' : 'failed'),

  env(mcp) {
    return Object.fromEntries(Object.entries(headerEnv(mcp)).map(([header, name]) => [name, mcp.headers[header]]));
  },

  /**
   * `mcp_servers.ordewell` as Codex's config takes it (keys checked against
   * codex-cli 0.160.0: `codex mcp add --url`, and its config loader rejecting
   * a bad `default_tools_approval_mode`). `approve` pre-authorizes every tool
   * of this server and no other, in every sandbox and approval policy.
   */
  threadServers(mcp) {
    return { [mcp.name]: { url: mcp.url, env_http_headers: headerEnv(mcp), default_tools_approval_mode: 'approve' } };
  },

  /**
   * Codex 0.160 keeps MCP tools out of the model's tool list: they are reached
   * through its `exec` tool, which lists them in `ALL_TOOLS`. Told only to
   * "call the task_complete tool" a model never looks there, so the thread's
   * instructions say where to look.
   */
  taskInstructions() {
    const tools = ordewellToolNames('task');
    return [
      `This task has ${COUNT_WORDS[tools.length] ?? tools.length} tools from the \`${ORDEWELL_MCP_SERVER_NAME}\` MCP server: ${quoted(tools)}.`,
      `They are not in your tool list up front. Find them with the tool discovery you have (the \`exec\` tool's \`ALL_TOOLS\` list) and call them by their full names, ${quoted(this.toolNames('task'))}.`,
      `Look for them before you finish; the task is reported complete through \`${TASK_COMPLETE_TOOL}\`.`,
    ].join(' ');
  },
};
