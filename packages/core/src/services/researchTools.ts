import { PLANNER_EXECUTION_TOOLS, PLANNER_POST, PLANNER_RECORD, PLANNER_TASK_READ_TOOLS, SEALED_PARAM, SEALED_RUNS, type McpTool, type PlannerToolHandler } from './mcp/tools';
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

/** An `array` parameter's elements: arrays themselves for a list of argument vectors. */
interface ResearchToolItems {
  type: ParamType;
  items?: ResearchToolItems;
}

interface ResearchToolParam {
  type: ParamType;
  description: string;
  /** Element type for `array` parameters. */
  items?: ResearchToolItems;
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
 * Subagent tool (issue #34, ADR-0005), opencode-style: one stateless read-only
 * research agent per call. Kept out of RESEARCH_TOOLS since it is projected in
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
    description: `Run a shell command for research. Read-only inspection (ls, tree, git log/status/diff/show, wc, find, rg, jq, …) runs immediately. Anything else — test suites, package managers, cloud CLIs like az/gh/aws/kubectl — pauses for one user approval and is then remembered for the rest of the session. Commands that write or mutate (rm, mv, cp, chmod, sudo, mkdir, git push/commit, output redirection, piping into a shell) never change anything: you are a planner, so describe the change as a task and let the runner make it. ${SEALED_RUNS} When to use: diagnosing before planning — reproduce a failure, query a remote environment, inspect build config. When NOT to use: file search (use glob/grep/find_symbol/list_dir instead).`,
    properties: {
      command: { type: 'string', description: 'The shell command to run' },
      sealed: { type: 'boolean', description: SEALED_PARAM },
    },
    required: ['command'],
  },
  {
    name: 'fetch',
    description: 'Fetch content from a URL (HTTP/HTTPS). Use for reading API documentation, library references, or package docs. Depending on the approval settings, the first fetch from a site may wait for the user to approve it. Private and local addresses are always refused, as is a URL that contains a credential, and each turn has a limited number of web reads; a refusal says why.',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
    },
    required: ['url'],
  },
  {
    name: 'web_search',
    description: 'Search the web for result titles, URLs and snippets. When to use: you need docs for an unfamiliar library or API and have no URL yet — search first, then fetch the most promising result. When NOT to use: anything answerable from the workspace itself (use grep or find_symbol). Depending on the approval settings, the first search may wait for the user to approve it; a query that contains a credential is refused, and searches count toward the turn\'s web reads.',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
];

/**
 * The toolset a research subagent gets: the same read-only exploration tools
 * the planner has, minus the spawn tool itself (no recursion). `fetch` and
 * `web_search` are included, but a subagent reaches them through a
 * non-prompting fetcher (ADR-0027, ADR-0008 T6): under `auto` they run as the
 * planner's do, and under `ask` only an origin or search already granted or
 * allowlisted succeeds — anything that would ask is refused, never prompted.
 * `bash` stays gated the same way at the capability boundary.
 */
export function subagentToolSpecs(): ResearchToolSpec[] {
  return RESEARCH_TOOLS;
}

function withSpawn(subagents: boolean): ResearchToolSpec[] {
  return subagents ? [...RESEARCH_TOOLS, SPAWN_RESEARCH_AGENT_SPEC] : [...RESEARCH_TOOLS];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const JSON_PARAM_TYPES: Record<string, ParamType> = { string: 'string', number: 'number', integer: 'number', boolean: 'boolean', array: 'array' };

/** A JSON schema's type as a research tool's; anything else, a union among them, is a string. */
function paramType(schema: Record<string, unknown>): ParamType {
  return (typeof schema.type === 'string' ? JSON_PARAM_TYPES[schema.type] : undefined) ?? 'string';
}

/** What an array schema holds, as deep as it nests; providers refuse an array that does not say. */
function itemsOf(schema: Record<string, unknown>): ResearchToolItems | undefined {
  if (paramType(schema) !== 'array') return undefined;
  const items = isRecord(schema.items) ? schema.items : {};
  const nested = itemsOf(items);
  return { type: paramType(items), ...(nested ? { items: nested } : {}) };
}

/**
 * One MCP tool's input as a research tool spec. A union (a task named by id
 * or by order) is declared a string, which every provider's schema can say and
 * the MCP schema still accepts.
 */
function specFromMcp(tool: McpTool<PlannerToolHandler>): ResearchToolSpec {
  const properties = isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required.filter((r): r is string => typeof r === 'string') : [];
  return {
    name: tool.name,
    description: tool.description,
    properties: Object.fromEntries(Object.entries(properties).map(([key, raw]) => {
      const schema = isRecord(raw) ? raw : {};
      const values = Array.isArray(schema.enum) ? schema.enum.filter((v): v is string => typeof v === 'string') : [];
      const items = itemsOf(schema);
      const param: ResearchToolParam = {
        type: paramType(schema),
        description: typeof schema.description === 'string' ? schema.description : '',
        ...(items ? { items } : {}),
        ...(values.length > 0 ? { enum: values } : {}),
      };
      return [key, param];
    })),
    required,
  };
}

/**
 * The planner's execution tools (ADR-0029) as the API planner declares them:
 * read off the Ordewell MCP server's own schemas, so both routes to the
 * command seam take the same arguments.
 */
export function executionToolSpecs(): ResearchToolSpec[] {
  return PLANNER_EXECUTION_TOOLS.map(specFromMcp);
}

/** Whether `name` is one of {@link executionToolSpecs}. */
export function isExecutionTool(name: string): boolean {
  return PLANNER_EXECUTION_TOOLS.some((tool) => tool.name === name);
}

/** The conversation's tools: the research tools, and the execution tools when the session offers them. */
function conversationSpecs(execution: boolean, subagents: boolean): ResearchToolSpec[] {
  return execution ? [...withSpawn(subagents), ...executionToolSpecs()] : withSpawn(subagents);
}

/** Whether a planner's list holds `post`: where a board can reach it, as `plannerToolSet` serves it (ADR-0057 R11). */
export function listsPost(offer: { delegates?: boolean; subplanner?: boolean } | undefined): boolean {
  return offer?.delegates === true || offer?.subplanner === true;
}

/**
 * The planner's tools declared as their MCP schemas stand: the task reads and
 * the decision record (ADR-0067), every planner's. `post` comes last, so a
 * list with it starts as the flat list does, byte for byte.
 */
function plannerListed(board: boolean): readonly McpTool<PlannerToolHandler>[] {
  return [...PLANNER_TASK_READ_TOOLS, PLANNER_RECORD, ...(board ? [PLANNER_POST] : [])];
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

/** Project the canonical tools into OpenAI's chat-completions tool format; `plannerTools` adds the task reads and the execution tools, and `board` adds `post` to them. */
export function toOpenAiTools(plannerTools = false, board = false): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return [...projectOpenAi(conversationSpecs(plannerTools, true)), ...(plannerTools ? plannerListed(board).map((t): OpenAI.Chat.Completions.ChatCompletionTool => ({
    type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema },
  })) : [])];
}

/** The subagent's own tool list in OpenAI format; `only` narrows it, as a confined agent's is (ADR-0066). */
export function toOpenAiSubagentTools(only?: ReadonlySet<string>): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return projectOpenAi(only ? subagentToolSpecs().filter((t) => only.has(t.name)) : subagentToolSpecs());
}

const SCHEMA_TYPE: Record<ParamType, SchemaType> = {
  string: SchemaType.STRING,
  number: SchemaType.NUMBER,
  array: SchemaType.ARRAY,
  boolean: SchemaType.BOOLEAN,
};

/**
 * Project the canonical tools into Gemini's function-declaration format;
 * `plannerTools` adds the task reads and the execution tools, `board` adds
 * `post` to them, and `subagents` withholds the spawn tool, which this backend
 * cannot run (ADR-0005).
 */
export function toGeminiToolDeclarations(plannerTools = false, subagents = true, board = false): FunctionDeclaration[] {
  const tools = conversationSpecs(plannerTools, subagents).map((t) => {
    const properties: Record<string, Schema> = {};
    for (const [key, param] of Object.entries(t.properties)) {
      properties[key] = {
        type: SCHEMA_TYPE[param.type],
        description: param.description,
        ...(param.items ? { items: geminiItems(param.items) } : {}),
        ...(param.enum ? { format: 'enum', enum: param.enum } : {}),
      };
    }
    // Gemini refuses an object schema with no properties, so a tool that takes none declares no parameters.
    return Object.keys(properties).length === 0
      ? { name: t.name, description: t.description }
      : { name: t.name, description: t.description, parameters: { type: SchemaType.OBJECT, properties, required: t.required } };
  });
  const reads = plannerTools ? plannerListed(board).map((t): FunctionDeclaration => {
    const schema = geminiSchema(t.inputSchema);
    return { name: t.name, description: t.description,
      parameters: { ...schema, type: SchemaType.OBJECT, properties: schema.properties ?? {} },
    };
  }) : [];
  return [...tools, ...reads];
}

function geminiItems(items: ResearchToolItems): Schema {
  return { type: SCHEMA_TYPE[items.type], ...(items.items ? { items: geminiItems(items.items) } : {}) };
}

function geminiSchema(value: unknown): Schema {
  const raw = value as { type?: string; description?: string; enum?: string[]; properties?: Record<string, unknown>; required?: string[]; items?: unknown; anyOf?: unknown[] };
  if (raw.anyOf) return { ...geminiSchema(raw.anyOf[0]), ...(raw.description ? { description: raw.description } : {}) };
  const description = raw.description ? { description: raw.description } : {};
  if (raw.type === 'object') return { type: SchemaType.OBJECT, ...description,
    properties: Object.fromEntries(Object.entries(raw.properties ?? {}).map(([k, v]) => [k, geminiSchema(v)])), required: raw.required ?? [],
  };
  if (raw.type === 'array') return { type: SchemaType.ARRAY, ...description, items: geminiSchema(raw.items) };
  if (raw.type === 'integer' || raw.type === 'number') return { type: SchemaType.NUMBER, ...description };
  if (raw.type === 'boolean') return { type: SchemaType.BOOLEAN, ...description };
  return { type: SchemaType.STRING, ...description, ...(raw.enum ? { format: 'enum', enum: raw.enum } : {}) };
}
