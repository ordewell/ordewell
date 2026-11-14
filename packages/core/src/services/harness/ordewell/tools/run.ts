import { capResult } from './output';
import type { OrdewellTool, ToolContext, ToolResult } from './types';

/** What the gate decides about one call. A refusal's reason is what the model reads. */
export type GateDecision = { allow: true } | { allow: false; reason: string };

/**
 * THE GATE: the one place the loop can ask before a tool runs. Guarded mode
 * asks the user here for a `write` or `exec` call, and the read-only profile
 * refuses them here; with no gate every call runs (Full). It sees the call
 * after its arguments are checked and before anything touches the disk.
 */
export type ToolGate = (call: { tool: OrdewellTool; args: Readonly<Record<string, unknown>> }) => GateDecision | Promise<GateDecision>;

function typeProblem(tool: OrdewellTool, args: Readonly<Record<string, unknown>>): string | null {
  const { properties, required } = tool.parameters;
  for (const name of required) {
    if (args[name] === undefined) return `missing required argument "${name}"`;
  }
  for (const [name, value] of Object.entries(args)) {
    const spec = properties[name];
    if (!spec) return `unknown argument "${name}"; ${tool.name} takes ${Object.keys(properties).join(', ') || 'no arguments'}`;
    if (value === undefined) continue;
    if (typeof value !== spec.type || (spec.type === 'number' && !Number.isFinite(value))) {
      return `argument "${name}" must be a ${spec.type}, not ${Array.isArray(value) ? 'an array' : value === null ? 'null' : `a ${typeof value}`}`;
    }
  }
  return null;
}

function failure(text: string, details?: Record<string, unknown>): ToolResult {
  return { text, isError: true, ...(details ? { details } : {}) };
}

/**
 * Run one tool call: check the arguments against the tool's schema, ask the
 * gate, execute, and bound the output. It never throws for a tool's own
 * failure, since the loop hands the model what went wrong and lets it go on;
 * an abort is the one thing that does not become a result.
 */
export async function runTool(
  tool: OrdewellTool,
  args: Readonly<Record<string, unknown>>,
  context: ToolContext,
  options: { gate?: ToolGate } = {},
): Promise<ToolResult> {
  const problem = typeProblem(tool, args);
  if (problem) return failure(`Invalid arguments for ${tool.name}: ${problem}.`);

  if (options.gate) {
    const decision = await options.gate({ tool, args });
    if (!decision.allow) return failure(decision.reason, { refused: true });
  }
  context.signal.throwIfAborted();

  let result: ToolResult;
  try {
    result = await tool.execute(args, context);
  } catch (err) {
    if (context.signal.aborted) throw err;
    return failure(`${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return capResult(result, context.outputDir, tool.keep);
}
