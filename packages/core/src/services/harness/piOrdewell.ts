import { MCP_CLIENT_TOOL_NAMES, type AttachState, type OrdewellToolBinding } from './ordewellBinding';

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
