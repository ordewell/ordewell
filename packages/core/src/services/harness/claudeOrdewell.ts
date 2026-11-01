import { ORDEWELL_MCP_SERVER_NAME, ownerOnlyConfigFile, type McpClientConfig, type OwnerOnlyFile } from '../mcp';
import * as path from 'path';
import { isRecord, readText } from './repoConfig';
import { MCP_CLIENT_TOOL_NAMES, type OrdewellToolBinding, type OrdewellToolRole } from './ordewellBinding';

/** What Claude Code is launched with to reach the server: its arguments, and the file they name. */
export interface ClaudeOrdewellLaunch {
  args: string[];
  /** Holds the token; the caller removes it once the process that reads it is gone. */
  config: OwnerOnlyFile;
}

export interface ClaudeOrdewellBinding extends OrdewellToolBinding<string> {
  /** `servers` are others to put in the same file, by name; none of them can stand in for Ordewell's. */
  launch(mcp: McpClientConfig, role: OrdewellToolRole, servers?: Record<string, unknown>): ClaudeOrdewellLaunch;
}

/**
 * Refuse an ambiguous claim: Claude does not document MCP config precedence.
 * Only `.mcp.json` is read: Claude takes MCP servers from it and from the
 * user's own config, and ignores an `mcpServers` key in a settings file
 * (`claude mcp list` over a project whose `.claude/settings.json` declares one
 * does not list it), so a stale entry there is no claim on the name.
 */
export function assertNoClaudeTaskCollision(cwd: string): void {
  const text = readText(path.join(cwd, '.mcp.json'));
  if (text === undefined) return;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return; }
  if (isRecord(parsed) && isRecord(parsed.mcpServers) && Object.hasOwn(parsed.mcpServers, ORDEWELL_MCP_SERVER_NAME)) {
    throw new Error('.mcp.json declares an MCP server named ordewell; rename or remove the ordewell server before starting this task.');
  }
}

export const CLAUDE_ORDEWELL: ClaudeOrdewellBinding = {
  toolName: MCP_CLIENT_TOOL_NAMES.toolName,
  toolNames: MCP_CLIENT_TOOL_NAMES.toolNames,
  /** ADR-0027: `WebSearch` and `WebFetch` carry Claude's web reads, both asked through the policy. */
  plannerHidden: () => ['fetch', 'web_search'],
  /** `can_use_tool`'s `tool_name`. */
  isOrdewellAsk: (toolName: string) => MCP_CLIENT_TOOL_NAMES.isToolName(toolName),
  /** `mcp_status` reports `pending` until the CLI's connection attempt settles. */
  attachState: (status) => (status === 'connected' ? 'connected' : status === 'pending' ? 'pending' : 'failed'),

  /**
   * `--mcp-config` takes a path as well as inline JSON; the path keeps the
   * token out of the argv every local user can list (ADR-0022, A5).
   * `alwaysLoad` because the CLI otherwise defers MCP tools behind its tool
   * search, and a model that has to look an Ordewell tool up first tends to
   * go on without it.
   */
  launch(mcp: McpClientConfig, role: OrdewellToolRole, servers: Record<string, unknown> = {}): ClaudeOrdewellLaunch {
    const config = ownerOnlyConfigFile('mcp.json', JSON.stringify({
      mcpServers: { ...servers, [mcp.name]: { type: 'http', url: mcp.url, headers: mcp.headers, alwaysLoad: true } },
    }));
    return { args: ['--mcp-config', config.path, '--allowedTools', MCP_CLIENT_TOOL_NAMES.toolNames(role, mcp.hidden, mcp.extraTools).join(',')], config };
  },
};
