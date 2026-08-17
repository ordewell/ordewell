import { IFileSystem, GrepOptions, GrepOutputMode, ToolOutcome } from '../interfaces/IFileSystem';
import { IWebFetcher } from '../interfaces/IWebFetcher';
import { redactSecrets } from '../utils/redactSecrets';

const GREP_OUTPUT_MODES: GrepOutputMode[] = ['content', 'files', 'count'];

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Models emit these in snake_case (that is how the schema declares them), so
 * the mapping to the camelCase {@link GrepOptions} lives here rather than being
 * re-derived in every filesystem adapter.
 */
function grepOptions(args: Record<string, unknown>): GrepOptions {
  const mode = str(args.output_mode ?? args.outputMode);
  return {
    include: str(args.include),
    path: str(args.path),
    outputMode: GREP_OUTPUT_MODES.includes(mode as GrepOutputMode) ? (mode as GrepOutputMode) : undefined,
    contextBefore: num(args.context_before ?? args.contextBefore),
    contextAfter: num(args.context_after ?? args.contextAfter),
    literal: bool(args.literal),
    caseInsensitive: bool(args.case_insensitive ?? args.caseInsensitive),
    headLimit: num(args.head_limit ?? args.headLimit),
  };
}

/**
 * Short, non-alarming answer for a call the turn was stopped before running.
 * The call still needs *an* answer — a dangling tool_call leaves the provider's
 * message history invalid for whatever the user does next.
 */
export const STOPPED_TOOL_RESULT =
  'Stopped by the user — this call was not executed, and no further tool calls will run this turn.';

/**
 * Run one research tool and construct its result. Every sink downstream — the
 * persisted session's research step, the tool result sent to the model
 * provider, the fallback plan prompt, the live progress stream — reads the
 * `output` this function returns, which is why credential redaction is applied
 * here rather than at each sink: one application keeps the disk copy and the
 * provider payload identical, and no third party receives key material a file
 * happened to contain.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  fs: IFileSystem,
  fetcher?: IWebFetcher,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  const outcome = await runTool(name, args, fs, fetcher, signal);
  return { ...outcome, output: redactSecrets(outcome.output) };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  fs: IFileSystem,
  fetcher?: IWebFetcher,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  if (signal?.aborted) return { success: false, output: STOPPED_TOOL_RESULT, truncated: false };
  switch (name) {
    case 'read_file': {
      const offset = num(args.offset);
      const limit = num(args.limit);
      const maxBytes = num(args.maxBytes);
      return fs.readFile(String(args.path ?? ''), { offset, limit, maxBytes });
    }
    case 'read_files': {
      const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
      return fs.readFiles(paths);
    }
    case 'glob': return fs.glob(String(args.pattern ?? ''), { path: str(args.path), headLimit: num(args.head_limit ?? args.headLimit) });
    case 'grep': return fs.grep(String(args.pattern ?? ''), grepOptions(args));
    case 'find_symbol': return fs.findSymbol(String(args.symbol ?? ''), { language: str(args.language), path: str(args.path) });
    case 'list_dir': return fs.listDir(String(args.path ?? ''), num(args.depth));
    case 'bash': return fs.bash(String(args.command ?? ''), signal);
    case 'fetch': {
      if (!fetcher) return { success: false, output: 'Web fetching is not available in this environment.', truncated: false };
      const url = String(args.url ?? '');
      const allowed = await fetcher.confirm(url);
      if (!allowed) return { success: false, output: `URL fetch denied by user: ${url}`, truncated: false };
      return fetcher.fetch(url);
    }
    case 'web_search': {
      if (!fetcher?.search) {
        return { success: false, output: 'Web search is not available in this environment. If you already know a documentation URL, use the fetch tool instead.', truncated: false };
      }
      const query = String(args.query ?? '').trim();
      if (!query) return { success: false, output: 'web_search requires a non-empty "query".', truncated: false };
      return fetcher.search(query);
    }
    // Budget models hallucinate two kinds of tools: plan-committing ones
    // (create_task, submit_plan) and implementation ones (create_file,
    // write_file). Steer both back: you are a planner, tasks run later,
    // and the commit channel is raw JSON in the reply text.
    default: return {
      success: false,
      output: `Unknown tool: ${name}. You are a PLANNER — you never create or edit files yourself; the coding agents executing the plan will do that later. Your tools are read-only research tools: read_file, read_files, glob, grep, find_symbol, list_dir, bash, fetch, web_search. To commit the final plan, output it as a raw JSON object with a "tasks" array directly in your reply text (no tool call).`,
      truncated: false,
    };
  }
}
