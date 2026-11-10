import { CONFINED_RESEARCH_TOOLS } from '../ResearchSubagents';
import { subagentToolSpecs } from '../researchTools';
import type { McpTool, McpToolContext, McpToolReply } from './tools';

/**
 * What answers a research token's calls: one read, by tool name, confined to
 * the planner's workspace (`confinedRead`). The session side owns it.
 */
export interface ResearchToolHandler {
  read(name: string, args: Record<string, unknown>, context: McpToolContext): Promise<McpToolReply>;
}

/**
 * A research token's whole tool list: the workspace reads of
 * {@link CONFINED_RESEARCH_TOOLS}, described as the API research agent sees
 * them. Nothing else is in it, so a runner rule that fails open still finds
 * only reads behind this server.
 */
export const RESEARCH_READ_TOOLS: readonly McpTool<ResearchToolHandler>[] = subagentToolSpecs()
  .filter((spec) => CONFINED_RESEARCH_TOOLS.has(spec.name))
  .map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: { type: 'object' as const, properties: spec.properties, required: spec.required },
    annotations: { readOnlyHint: true },
    call: (handler: ResearchToolHandler, args: unknown, context: McpToolContext) =>
      typeof args === 'object' && args !== null && !Array.isArray(args)
        ? handler.read(spec.name, args as Record<string, unknown>, context)
        : Promise.resolve({ text: `${spec.name} takes an object of named arguments.`, isError: true }),
  }));
