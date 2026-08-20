import type OpenAI from 'openai';
import { SchemaType, type FunctionDeclaration, type Schema } from '@google/generative-ai';

/**
 * Canonical definition of the read-only research tools the planner uses to
 * explore a workspace. Both the OpenAI- and Gemini-backed services drive the
 * same loop over the same tools, so the names, descriptions, and parameter
 * shapes live here once and are projected into each SDK's tool format. Keeping
 * a single source of truth stops the two provider lists from drifting apart.
 */

type ParamType = 'string' | 'number' | 'array' | 'boolean';

interface ResearchToolParam {
  type: ParamType;
  description: string;
  /** Element type for `array` parameters. */
  items?: { type: ParamType };
  /** Closed value set, projected as a JSON-schema enum. */
  enum?: string[];
}

export interface ResearchToolSpec {
  name: string;
  description: string;
  properties: Record<string, ResearchToolParam>;
  required: string[];
}

export const SPAWN_RESEARCH_AGENT = 'spawn_research_agent';

/**
 * Subagent tool (issue #34), opencode-style: one stateless read-only research
 * agent per call. Kept out of RESEARCH_TOOLS since it is projected in
 * separately via withSpawn().
 */
export const SPAWN_RESEARCH_AGENT_SPEC: ResearchToolSpec = {
  name: SPAWN_RESEARCH_AGENT,
  description: 'Launch a read-only research agent that explores the workspace with its own tools (read_file, read_files, glob, grep, find_symbol, list_dir, bash) and returns a single digest. When to use: an open-ended exploration thread you want answered without doing every lookup yourself — a subsystem to map, a question like "how does X flow through this codebase". Launch a new agent whenever such a thread emerges during research. To explore several independent areas, launch multiple agents CONCURRENTLY by putting several spawn_research_agent calls in one reply — they run in parallel. When NOT to use: reading a specific known file (read it directly), or small single-subsystem repos where direct exploration is already fast. Each agent is stateless: it sees nothing of this conversation and you cannot message it again. Its prompt must be self-contained — name the area or question, the paths or symbols to start from, and exactly what the digest must report back. Agents are read-only, cannot spawn further agents, and only their final digest returns to you.',
  properties: {
    prompt: { type: 'string', description: 'Self-contained task for the research agent, including what the digest must contain.' },
  },
  required: ['prompt'],
};

export const RESEARCH_TOOLS: ResearchToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file with line-numbered output and optional offset/limit for pagination. Path is relative to the workspace root; a path outside it requires user approval. When to use: read a file you already know the path of (from glob/grep/find_symbol results). When NOT to use: to find files — use glob or grep first to locate the right files.',
    properties: {
      path: { type: 'string', description: 'Relative path to the file' },
      offset: { type: 'number', description: '0-based line number to start reading from (default: 0)' },
      limit: { type: 'number', description: 'Maximum number of lines to return (default: 2000). Files larger than ~1 MB are rejected with an error — use grep instead for those.' },
    },
    required: ['path'],
  },
  {
    name: 'read_files',
    description: 'Read multiple known files at once. When to use: batch-read several files whose paths you already know. When NOT to use: discovering which files to read — use glob/grep first.',
    properties: {
      paths: { type: 'array', items: { type: 'string' }, description: 'Array of relative file paths to read' },
    },
    required: ['paths'],
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern (e.g. "src/**/*.ts"). Uses ripgrep for speed. When to use: find files by name/path pattern. When NOT to use: searching file contents (use grep) or browsing directory layout (use list_dir).',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern' },
      path: { type: 'string', description: 'Directory to search under (default: workspace root). Paths outside the workspace require user approval.' },
    },
    required: ['pattern'],
  },
  {
    name: 'grep',
    description: 'Search file contents with ripgrep. When to use: find code patterns, imports, or any text within files. When NOT to use: finding files by name (use glob), or locating where a named symbol is DEFINED (use find_symbol — it filters out the call sites that would otherwise fill this tool\'s result budget). Results are capped globally; use output_mode="files" to survey breadth cheaply, then re-run with output_mode="content" on a narrower path.',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for (set literal=true to match it as plain text instead)' },
      include: { type: 'string', description: 'Optional file glob to filter (e.g. "*.ts")' },
      path: { type: 'string', description: 'Directory to search under (default: workspace root). Paths outside the workspace require user approval.' },
      output_mode: { type: 'string', enum: ['content', 'files', 'count'], description: '"content" (default) returns matching lines; "files" returns only file paths; "count" returns per-file match counts. Prefer "files" or "count" when surveying breadth.' },
      context_before: { type: 'number', description: 'Lines of context before each match (content mode only)' },
      context_after: { type: 'number', description: 'Lines of context after each match (content mode only)' },
      literal: { type: 'boolean', description: 'Treat the pattern as a literal string rather than a regex' },
      case_insensitive: { type: 'boolean', description: 'Case-insensitive match' },
      head_limit: { type: 'number', description: 'Maximum rows returned (default 100)' },
    },
    required: ['pattern'],
  },
  {
    name: 'find_symbol',
    description: 'Locate where a named symbol is DEFINED, plus a per-file count of where it is referenced. Understands declaration syntax across TypeScript, Python, Go, Rust, JVM languages, C#, C/C++, Ruby, PHP, Swift, Elixir and more. When to use: "where is X defined", "what would changing X affect", scoping the blast radius of a task. When NOT to use: free-text or pattern search (use grep), or finding files by name (use glob). Strongly preferred over grep for named symbols — grep returns every import and call site, so the definition often falls outside the result cap.',
    properties: {
      symbol: { type: 'string', description: 'Exact symbol name (function, class, type, constant, …)' },
      language: { type: 'string', description: 'Optional language id or file extension ("typescript", "go", ".rs") to narrow the search in polyglot repos' },
      path: { type: 'string', description: 'Directory to search under (default: workspace root)' },
    },
    required: ['symbol'],
  },
  {
    name: 'list_dir',
    description: 'List directory contents as a tree. Use depth > 1 for nested tree view. When to use: getting oriented with project structure, seeing what directories exist. When NOT to use: finding specific files by name (use glob) or searching file contents (use grep).',
    properties: {
      path: { type: 'string', description: 'Relative path to the directory' },
      depth: { type: 'number', description: 'Directory depth for tree view (default: 1, flat listing)' },
    },
    required: ['path'],
  },
  {
    name: 'bash',
    description: 'Run a shell command for research. Read-only inspection (ls, tree, git log/status/diff/show, wc, find, rg, jq, …) runs immediately. Anything else — test suites, package managers, cloud CLIs like az/gh/aws/kubectl — pauses for one user approval and is then remembered for the rest of the session. Commands that write or mutate (rm, mv, cp, chmod, sudo, mkdir, git push/commit, output redirection, piping into a shell) are always refused: you are a planner, so describe the change as a task and let the runner make it. When to use: diagnosing before planning — reproduce a failure, query a remote environment, inspect build config. When NOT to use: file search (use glob/grep/find_symbol/list_dir instead).',
    properties: {
      command: { type: 'string', description: 'The shell command to run' },
    },
    required: ['command'],
  },
  {
    name: 'fetch',
    description: 'Fetch content from a URL (HTTP/HTTPS). Use for reading API documentation, library references, or package docs. URL confirmation is required — the tool may pause while awaiting approval.',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
    },
    required: ['url'],
  },
  {
    name: 'web_search',
    description: 'Search the web for result titles, URLs and snippets. When to use: you need docs for an unfamiliar library or API and have no URL yet — search first, then fetch the most promising result. When NOT to use: anything answerable from the workspace itself (use grep or find_symbol).',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
];

/**
 * The toolset a research subagent gets: the read-only exploration tools minus
 * the network tools (`fetch`/`web_search` can pause on user confirmation, which
 * a background subagent must never do) and minus the spawn tool itself (no
 * recursion). `bash` stays, but its own approval gate means a subagent can only
 * ever run the auto-tier read-only commands — an ask-tier command from a
 * background agent resolves to denied rather than prompting.
 */
const SUBAGENT_EXCLUDED = new Set(['fetch', 'web_search']);

export function subagentToolSpecs(): ResearchToolSpec[] {
  return RESEARCH_TOOLS.filter((t) => !SUBAGENT_EXCLUDED.has(t.name));
}

function withSpawn(): ResearchToolSpec[] {
  return [...RESEARCH_TOOLS, SPAWN_RESEARCH_AGENT_SPEC];
}

function projectOpenAi(specs: ResearchToolSpec[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return specs.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(t.properties).map(([key, param]) => [key, {
          type: param.type,
          description: param.description,
          ...(param.items ? { items: param.items } : {}),
          ...(param.enum ? { enum: param.enum } : {}),
        }])),
        required: t.required,
      },
    },
  }));
}

/** Project the canonical tools into OpenAI's chat-completions tool format. */
export function toOpenAiTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return projectOpenAi(withSpawn());
}

/** The subagent's own tool list in OpenAI format. */
export function toOpenAiSubagentTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return projectOpenAi(subagentToolSpecs());
}

const SCHEMA_TYPE: Record<ParamType, SchemaType> = {
  string: SchemaType.STRING,
  number: SchemaType.NUMBER,
  array: SchemaType.ARRAY,
  boolean: SchemaType.BOOLEAN,
};

/** Project the canonical tools into Gemini's function-declaration format. */
export function toGeminiToolDeclarations(): FunctionDeclaration[] {
  return withSpawn().map((t) => {
    const properties: Record<string, Schema> = {};
    for (const [key, param] of Object.entries(t.properties)) {
      properties[key] = {
        type: SCHEMA_TYPE[param.type],
        description: param.description,
        ...(param.items ? { items: { type: SCHEMA_TYPE[param.items.type] } } : {}),
        ...(param.enum ? { format: 'enum', enum: param.enum } : {}),
      };
    }
    return {
      name: t.name,
      description: t.description,
      parameters: { type: SchemaType.OBJECT, properties, required: t.required },
    };
  });
}
