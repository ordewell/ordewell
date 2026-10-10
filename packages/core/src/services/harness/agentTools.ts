import type { ResearchToolType } from '../../models/Task';

/**
 * Map a coding agent's own tool name onto Ordewell's research vocabulary
 * (ADR-0009, T5).
 *
 * A harness planner brings its own toolbox, and most of it overlaps ours: a
 * `Read` is a `read_file`, a `Grep` is a `grep`. Those map onto existing
 * members and render in every surface through the code path that is already
 * there. Everything else — `Edit`, `WebFetch`, `TodoWrite`, `Task`, whatever
 * ships next — becomes `agent_tool` carrying its real name.
 *
 * Nothing is relabelled as a tool it is not. Calling a web fetch a `bash` to
 * avoid adding a union member would put a lie in the timeline, which is the
 * point ADR-0008 spent its effort establishing.
 */
const KNOWN_TOOLS: Record<string, ResearchToolType> = {
  // Claude Code
  read: 'read_file',
  grep: 'grep',
  glob: 'glob',
  bash: 'bash',
  ls: 'list_dir',
  webfetch: 'fetch',
  websearch: 'web_search',
  // Codex — its sandboxed command tool is a shell by another name
  shell: 'bash',
  exec_command: 'bash',
  local_shell: 'bash',
  // OpenCode
  list: 'list_dir',
  fetch: 'fetch',
  // Ordewell's own research shell (ADR-0026), under every runner's name for it
  runcommand: 'bash',
};

/**
 * Claude Code and Codex call it `mcp__ordewell__<tool>`, OpenCode `ordewell_<tool>`.
 * Spelled out rather than built from `ORDEWELL_MCP_SERVER_NAME`: the webview
 * bundles this file, and `../mcp` brings the Node-only server with it.
 */
const ORDEWELL_TOOL_PREFIX = /^(mcp__ordewell__|ordewell_)/i;

/**
 * The tools that write a file, by their normalized names: Claude Code's,
 * OpenCode's, and the change kinds a Codex row is named for. Their output is
 * a diff (see `fileDiff.ts`) when the runner reported one.
 */
const FILE_EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'applypatch', 'patch', 'add', 'update', 'delete', 'filechange']);

export function isFileEditTool(name: string): boolean {
  return FILE_EDIT_TOOLS.has(name.trim().toLowerCase().replace(/[_-]/g, ''));
}

export interface MappedTool {
  tool: ResearchToolType;
  /** The agent's own name, kept whenever it differs from the member it mapped to. */
  toolLabel?: string;
}

/**
 * Classify one agent tool name. Case- and separator-insensitive, because the
 * three agents disagree on `Read` vs `read` vs `read_file` for the same thing.
 */
export function mapAgentTool(name: string): MappedTool {
  const normalized = name.trim().replace(ORDEWELL_TOOL_PREFIX, '').toLowerCase().replace(/[_-]/g, '');
  const direct = KNOWN_TOOLS[normalized] ?? KNOWN_TOOLS[name.trim().toLowerCase()];
  if (direct) {
    // The label survives even on a mapped tool: `Read` and `read_file` render
    // the same way, but the transcript should still say which one ran.
    return { tool: direct, toolLabel: name };
  }
  return { tool: 'agent_tool', toolLabel: name };
}

/**
 * Normalize an agent's tool arguments into the shapes `summarizeToolCall`
 * already knows how to read, so a harness `Read` gets a one-line summary
 * instead of a bare tool name. Unknown keys are preserved — the raw args stay
 * visible under the surfaces' output chevron.
 */
export function normalizeAgentArgs(tool: ResearchToolType, args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  const alias = (from: string, to: string) => {
    if (out[to] === undefined && out[from] !== undefined) out[to] = out[from];
  };
  if (tool === 'read_file' || tool === 'list_dir') {
    alias('filePath', 'path');
    alias('file_path', 'path');
    alias('target', 'path');
  }
  if (tool === 'bash') {
    alias('cmd', 'command');
    alias('script', 'command');
    // Codex hands the command over as an argv array; the summary wants a string.
    if (typeof out.command !== 'string' && Array.isArray(out.command)) {
      out.command = (out.command as unknown[]).join(' ');
    }
  }
  if (tool === 'fetch') alias('uri', 'url');
  if (tool === 'web_search') alias('q', 'query');
  return out;
}
