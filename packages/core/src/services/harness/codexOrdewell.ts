import { ORDEWELL_MCP_SERVER_NAME, TASK_COMPLETE_TOOL, taskCompletionContract, type McpClientConfig } from '../mcp';
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
  /** What a task thread's instructions say about the tools, and how the task is to end. */
  taskInstructions(task?: { readOnly?: boolean; commits?: true }): string;
  /** What a planner thread's instructions add about the tools (ADR-0026), and where its web reads go (ADR-0027). */
  plannerInstructions(nativeSearch: boolean, hidden?: readonly string[], ownShell?: boolean, extra?: readonly string[]): string;
  /** The planner thread's `web_search` mode. */
  plannerWebSearch(nativeSearch: boolean): CodexWebSearchMode;
}

/** Who receives a Codex planner's own search: it runs at OpenAI, inside the model's turn. */
export const CODEX_SEARCH_PROVIDER = 'openai';

/**
 * Codex's `web_search` config modes (codex-cli 0.162.0). `cached` answers from
 * an OpenAI-maintained index with no external access; `indexed` reaches out
 * when the index gates it; `live` retrieves without restriction, and its
 * `openPage` and `findInPage` actions open URLs the model chose, which no
 * Ordewell guard would see. A planner thread therefore gets `cached` or
 * `disabled`, never the default a user's config or a full-access sandbox
 * would pick.
 */
export type CodexWebSearchMode = 'disabled' | 'cached' | 'indexed' | 'live';

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
const countOf = (names: string[]) => COUNT_WORDS[names.length] ?? String(names.length);
const quoted = (names: string[]) => listed(names.map((name) => `\`${name}\``));

export const CODEX_ORDEWELL: CodexOrdewellBinding = {
  // Codex names a call by server and tool; the model reaches the tool by Claude Code's name for it.
  toolName: MCP_CLIENT_TOOL_NAMES.toolName,
  toolNames: MCP_CLIENT_TOOL_NAMES.toolNames,
  // With its own search on, a model offered Ordewell's too tends to take that instead. Codex has no fetch of its own.
  plannerHidden: (start) => (start.nativeSearch ? ['web_search'] : []),
  sessionSearchProvider: CODEX_SEARCH_PROVIDER,
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
  taskInstructions({ readOnly = false, commits }: { readOnly?: boolean; commits?: true } = {}) {
    const role = readOnly ? 'readOnlyTask' : 'task';
    const tools = ordewellToolNames(role);
    const discovery = [
      `This task has ${countOf(tools)} tools from the \`${ORDEWELL_MCP_SERVER_NAME}\` MCP server: ${quoted(tools)}.`,
      `They are not in your tool list up front. Find them with the tool discovery you have (the \`exec\` tool's \`ALL_TOOLS\` list) and call them by their full names, ${quoted(this.toolNames(role))}.`,
      `Look for them before you finish; the task is reported complete through \`${TASK_COMPLETE_TOOL}\`.`,
    ].join(' ');
    const readOnlyNote = ` You have no native shell: read files, search the repository and run tests with \`${this.toolName('run_command')}\`. It is your only shell (ADR-0046). Read web pages with \`${this.toolName('fetch')}\` and search with \`${this.toolName('web_search')}\`: your own web search is off on this task.`;
    return `${discovery}${readOnly ? readOnlyNote : ''}\n\n${taskCompletionContract(commits ? { commits } : {})}`;
  },

  /**
   * The same discovery note for a planner, which also needs to know that its
   * commands and fetches go through Ordewell's tools: Codex's own shell is
   * sandboxed without network, so `gh`, a cloud CLI or `curl` fails there, and
   * a model that tried its shell first concludes the command cannot run.
   */
  plannerInstructions(nativeSearch, hidden, ownShell = true, extra) {
    const tools = ordewellToolNames('planner', hidden, extra);
    return [
      `You have ${countOf(tools)} tools from the \`${ORDEWELL_MCP_SERVER_NAME}\` MCP server: ${quoted(tools)}.`,
      `They are not in your tool list up front. Find them with the tool discovery you have (the \`exec\` tool's \`ALL_TOOLS\` list) and call them by their full names, ${quoted(this.toolNames('planner', hidden, extra))}.`,
      ownShell
        ? `Run shell commands with \`${this.toolName('run_command')}\`, not your own shell: yours is sandboxed without network, so git remotes, gh and cloud CLIs fail there.`
        : `You have no shell of your own on this machine: run every command, reads included, with \`${this.toolName('run_command')}\`.`,
      `Fetch web pages with \`${this.toolName('fetch')}\`, not curl or your shell.`,
      nativeSearch
        ? 'Search the web with your built-in web search.'
        : `Your built-in web search is off for this session; search with \`${this.toolName('web_search')}\`.`,
    ].join(' ');
  },

  plannerWebSearch: (nativeSearch) => (nativeSearch ? 'cached' : 'disabled'),
};
