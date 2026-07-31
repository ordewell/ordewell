import type { ResearchStepOutcome } from '../models/Task';

/**
 * One-line human summary of a research tool call, shared by every surface that
 * renders live planner progress (VS Code webview, CLI, TUI). Kept in core so
 * the arg-shape heuristics (file path vs. pattern vs. shell command) live in
 * one place instead of being re-derived per surface — which also means a new
 * tool becomes readable in all three UIs by being handled here once.
 */

function ellipsize(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * @param toolLabel The agent's own name for the tool, when a harness planner
 * produced the call (ADR-0009). It replaces the member name in the summary, so
 * the timeline says `Edit` rather than the catch-all `agent_tool` — and says
 * `WebFetch` rather than claiming a shell command ran.
 */
export function summarizeToolCall(tool: string, argsJson: string, toolLabel?: string): string {
  const display = toolLabel?.trim() || tool;
  if (tool === 'agent_tool') {
    // No Ordewell equivalent, so no arg shape to rely on: show the agent's name
    // plus whichever conventional field the call happens to carry.
    try {
      const args = JSON.parse(argsJson);
      const hint = args.path ?? args.file_path ?? args.filePath ?? args.pattern ?? args.query ?? args.url ?? args.command;
      if (hint) return `${display} ${ellipsize(String(hint), 50)}`;
    } catch {
      // fall through to the bare name
    }
    return display;
  }

  if (tool === 'spawn_research_agent') {
    try {
      const args = JSON.parse(argsJson);
      const prompt = typeof args.prompt === 'string' ? args.prompt : '';
      const oneLine = prompt.replace(/\s+/g, ' ').trim();
      return `spawn: "${oneLine.slice(0, 60)}${oneLine.length > 60 ? '…' : ''}"`;
    } catch {
      return 'spawn_research_agent';
    }
  }

  try {
    const args = JSON.parse(argsJson);

    // Ordered by specificity: a tool's defining argument wins over the generic
    // `path`, which several of the newer tools also accept as a search root.
    if (tool === 'find_symbol' && args.symbol) {
      return `find_symbol ${args.symbol}${args.language ? ` [${args.language}]` : ''}`;
    }
    if (tool === 'web_search' && args.query) {
      return `web_search "${ellipsize(String(args.query), 50)}"`;
    }
    if (tool === 'fetch' && args.url) {
      return `fetch ${ellipsize(String(args.url), 60)}`;
    }
    // The pattern is what a glob is about; the generic `path` below is only its
    // search root, and reporting that read as "glob src" for every call.
    if (tool === 'glob' && args.pattern) {
      return `glob ${ellipsize(String(args.pattern), 50)}`;
    }
    if (tool === 'grep' && args.pattern) {
      const mode = args.output_mode && args.output_mode !== 'content' ? ` (${args.output_mode})` : '';
      const scope = args.include ? ` in ${args.include}` : '';
      return `grep ${ellipsize(String(args.pattern), 40)}${scope}${mode}`;
    }

    const path = args.filePath || args.file_path || args.path;
    if (path) {
      const basename = String(path).split('/').pop() || String(path);
      return `${display} ${basename}`;
    }
    if (args.pattern) {
      return `${display} ${args.pattern}`;
    }
    if (args.command) {
      return `bash: ${String(args.command).slice(0, 40)}`;
    }
  } catch {
    // fall through to the bare tool name below
  }
  return display;
}

/**
 * Classify a tool outcome from its result text and success flag, so a surface
 * can render a refused `rm` or a denied `npm test` distinctly from a
 * successful run without re-deriving the refusal signatures per surface. The
 * refusal/denial strings come from `commandPolicy.ts`, `BaseFileSystem.ts`,
 * and the research-subagent wrapper — keeping the matching here means the
 * signatures stay in one place alongside the human summary.
 */
export function classifyOutcome(success: boolean, output: string): ResearchStepOutcome {
  if (!success) {
    if (/^Command refused:/.test(output) || /is not available\. You are a read-only research subagent/.test(output)) return 'refused';
    if (/not approved/i.test(output) || /^Access denied:/.test(output) || /needs user approval/i.test(output)) return 'denied';
    return 'failure';
  }
  return 'success';
}
