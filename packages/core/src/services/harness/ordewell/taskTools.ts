import type { ToolDefinition } from '../../model';
import type { InProcessTools } from '../../mcp/OrdewellMcpServer';
import type { McpToolReply } from '../../mcp/tools';

/**
 * Every task tool the runner offers natively, by the name the model sees and
 * the name the token's tool set serves. The token decides which exist: a
 * change task's serves `checkpoint` and `apply_patch`, a read-only task's the
 * sealed `run_command`, `save_patch`, `fetch` and `web_search` (ADR-0046), a
 * board's `post`; one it does not list is not offered. The task-record `read`
 * is `read_task` here (its alias on the server), since `read` is the file tool.
 */
const OFFERED: readonly { native: string; served: string }[] = [
  { native: 'task_complete', served: 'task_complete' },
  { native: 'read_task', served: 'read' },
  { native: 'checkpoint', served: 'checkpoint' },
  { native: 'apply_patch', served: 'apply_patch' },
  { native: 'run_command', served: 'run_command' },
  { native: 'save_patch', served: 'save_patch' },
  { native: 'fetch', served: 'fetch' },
  { native: 'web_search', served: 'web_search' },
  { native: 'post', served: 'post' },
];

/**
 * The attempt's task tools, called in-process through its token's grant
 * (ADR-0070, amending ADR-0022 S2): the same validation, scope and handler as
 * a `tools/call`, with no HTTP hop. A call after the token is revoked is an
 * error reply, never a verdict.
 */
export interface TaskTools {
  readonly definitions: readonly ToolDefinition[];
  has(name: string): boolean;
  call(name: string, args: unknown, signal: AbortSignal): Promise<McpToolReply>;
}

export function taskToolsOf(inProcess: InProcessTools): TaskTools {
  const listing = inProcess.list();
  const offered = OFFERED.flatMap((entry) => {
    const listed = listing.find((tool) => tool.name === entry.served);
    return listed ? [{ ...entry, definition: { name: entry.native, description: listed.description, parameters: listed.inputSchema } }] : [];
  });
  return {
    definitions: offered.map((entry) => entry.definition),
    has: (name) => offered.some((entry) => entry.native === name),
    call: (name, args, signal) => {
      const entry = offered.find((candidate) => candidate.native === name);
      if (!entry) return Promise.resolve({ text: `Unknown task tool: ${name}`, isError: true });
      return inProcess.call(entry.served, args, signal);
    },
  };
}
