import type { AcpAskedCall, AcpProfile } from './acpProfiles';
import { ORDEWELL_TOOL_NAMES, ordewellToolNames, type AttachState, type OrdewellToolBinding } from './ordewellBinding';

const KNOWN_TOOLS = new Set(ORDEWELL_TOOL_NAMES);

/**
 * The Ordewell server's tools as an ACP agent meets them. ACP has no field
 * naming the MCP tool behind a tool call, so the profile reads the agent's own
 * words for one, in the request and its report; what it reads must then be one
 * of the server's tools exactly, never a name that merely starts like one
 * (ADR-0022, S3). ACP reports no MCP status of its own either: the attach
 * state is the adapter's verdict from the server's first-contact record,
 * already in this binding's words.
 */
export function acpOrdewellBinding(profile: Pick<AcpProfile, 'ordewellTool' | 'toolName'>): OrdewellToolBinding<AcpAskedCall> {
  const toolName = (tool: string): string => profile.toolName?.(tool) ?? tool;
  return {
    toolName,
    toolNames: (role, hidden, extra) => ordewellToolNames(role, hidden, extra).map(toolName),
    plannerHidden: () => [],
    isOrdewellAsk: (call) => {
      const name = profile.ordewellTool(call);
      return name !== null && KNOWN_TOOLS.has(name);
    },
    attachState: (status): AttachState => (status === 'connected' || status === 'failed' ? status : 'pending'),
  };
}
