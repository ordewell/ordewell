import { ORDEWELL_MCP_SERVER_NAME, PLANNER_TOOLS, TASK_TOOLS } from '../mcp';

export class McpAttachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpAttachError';
  }
}

/** Which token's tools a runner is handed (ADR-0022, A1). */
export type OrdewellToolRole = 'task' | 'planner';

/** A runner's report on the Ordewell server's connection, in one vocabulary for every runner. */
export type AttachState = 'connected' | 'pending' | 'failed';

/**
 * How one runner is handed the Ordewell MCP server (ADR-0022): the names it
 * calls the server's tools by, which of its permission requests are for them,
 * and what its report of the connection means. Each runner's binding adds how
 * the server is written into that runner's launch or configuration, which has
 * no common shape.
 *
 * `Ask` is the runner's own permission request, as far as telling one for an
 * Ordewell tool needs it.
 */
export interface OrdewellToolBinding<Ask = never> {
  /** The name the runner calls an Ordewell tool by, and reports its calls and requests under. */
  toolName(tool: string): string;
  /** Every tool `role` is given, under the runner's names, in the server's order. */
  toolNames(role: OrdewellToolRole): string[];
  /** Whether a permission request is for one of the server's tools, which is never refused or left waiting (ADR-0022, S3). */
  isOrdewellAsk(ask: Ask): boolean;
  /** What the runner's own status word for the server says about its connection. */
  attachState(status: string | null | undefined): AttachState;
}

/** The tools of a role, by their names on the server. */
export function ordewellToolNames(role: OrdewellToolRole): string[] {
  return (role === 'task' ? TASK_TOOLS : PLANNER_TOOLS).map((tool) => tool.name);
}

/** The naming half of a binding for a runner that names a server's tool `<prefix><tool>`. */
export function prefixedToolNames(prefix: string): Pick<OrdewellToolBinding, 'toolName' | 'toolNames'> & { hasPrefix(name: string): boolean } {
  return {
    toolName: (tool) => `${prefix}${tool}`,
    toolNames: (role) => ordewellToolNames(role).map((tool) => `${prefix}${tool}`),
    hasPrefix: (name) => name.startsWith(prefix),
  };
}

/** `mcp__<server>__<tool>`: how Claude Code names an MCP tool, and the name Codex's `exec` tool lists one under too. */
export const MCP_CLIENT_TOOL_NAMES = prefixedToolNames(`mcp__${ORDEWELL_MCP_SERVER_NAME}__`);

/** `a`, `a and b`, `a, b and c`. */
export function listed(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Ask the runner until it reports the server connected or failed, or the
 * deadline passes. `probe` gets the time left and answers with the runner's
 * latest report, waiting for one however it must.
 */
export async function awaitAttach(probe: (msLeft: number) => Promise<AttachState>, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    const state = await probe(left);
    if (state !== 'pending') return state === 'connected';
    if (pollMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        timer.unref?.();
      });
    }
  }
}
