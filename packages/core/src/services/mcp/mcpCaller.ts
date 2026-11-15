/**
 * Who made a tool call, as far as the runner's own request metadata says. It
 * is read for one purpose: leaving a delegate's reads out of the planner's
 * read limit (ADR-0068 R2). The model writes none of it, and it never decides
 * what a call may do: the envelope (ADR-0008) still does.
 */
export interface McpCaller {
  /** The runner says one of its subagents made the call. */
  subagent?: true;
  /** The runner's id for the tool use this call answers, for the harness to tie to the agent it announced. */
  toolUseId?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The caller a tools/call's `_meta` names, or undefined when it names none.
 * Codex (0.167.0) sends its turn's metadata, whose `parent_thread_id` a
 * spawned subagent's thread carries and a root thread does not; Claude Code
 * (2.1.325) sends the tool use's id. Anything unreadable names no one, so the
 * call is charged as the planner's.
 */
export function callerOf(meta: unknown): McpCaller | undefined {
  const fields = record(meta);
  if (!fields) return undefined;
  const turn = record(fields['x-codex-turn-metadata']);
  const parent = text(turn?.parent_thread_id);
  if (parent && parent !== text(turn?.thread_id)) return { subagent: true };
  const toolUseId = text(fields['claudecode/toolUseId']);
  return toolUseId ? { toolUseId } : undefined;
}
