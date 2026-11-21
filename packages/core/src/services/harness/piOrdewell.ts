import * as path from 'path';
import { MCP_CLIENT_TOOL_NAMES, type AttachState, type OrdewellToolBinding } from './ordewellBinding';
import { isRecord, readText } from './repoConfig';

/**
 * The Ordewell server's tools as Pi meets them: the extension Ordewell loads
 * registers the server with `direct` exposure, so Pi names each tool
 * `mcp__ordewell__<tool>`, as Claude Code does. Pi asks about none of them,
 * and reports no MCP status over RPC: the attach state is the adapter's
 * verdict from the server's first-contact record, already in these words.
 */
export const PI_ORDEWELL: OrdewellToolBinding = {
  toolName: MCP_CLIENT_TOOL_NAMES.toolName,
  toolNames: MCP_CLIENT_TOOL_NAMES.toolNames,
  /** Pi has no web tools of its own, so the planner reads the web through Ordewell's (ADR-0027). */
  plannerHidden: () => [],
  isOrdewellAsk: () => false,
  attachState: (status): AttachState => (status === 'connected' || status === 'failed' ? status : 'pending'),
};

/** The tool namespace Pi files a server's tools under; two names that share one are one server to Pi. */
const namespace = (server: string) => server.replace(/-/g, '_');

/**
 * The server in the user's own Pi `mcp.json` that would take the place of
 * Ordewell's, or undefined. Pi's MCP support starts every server that file
 * defines, on every start, and one whose namespace is the name Ordewell's
 * extension registers wins over it, disabled or not: Ordewell's server then
 * hears from nobody, and the start would wait out the attach timeout. Only
 * an entry Pi would load counts, checked as Pi 1.6.0's loader checks it.
 */
export function piMcpCollision(agentDir: string, server: string): string | undefined {
  const text = readText(path.join(agentDir, 'mcp.json'));
  if (text === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return undefined; }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return undefined;
  return Object.entries(parsed.mcpServers).find(([name, entry]) => /^[A-Za-z0-9_-]+$/.test(name) && namespace(name) === namespace(server) && loads(entry))?.[0];
}

function loads(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  const { type, url, command } = entry;
  return (typeof url === 'string' && (type === undefined || type === 'http' || type === 'streamable-http'))
    || (typeof command === 'string' && (type === undefined || type === 'stdio'));
}
