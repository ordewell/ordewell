/**
 * The runner's own tools, as the loop sees them: a name, a description, a JSON
 * Schema for the arguments, and an `execute`. The set is neutral and identical
 * for every model; Ordewell's plan covers todo, subagent, question and LSP
 * work, so there are deliberately no tools for them.
 */

/** A JSON Schema object for a tool's arguments, the shape every provider's tool format takes. */
export interface ToolSchema {
  type: 'object';
  properties: Record<string, { type: 'string' | 'number' | 'boolean'; description: string }>;
  required: string[];
  additionalProperties: false;
}

export interface ToolContext {
  /** The task's worktree: the cwd of `shell`, the root relative paths resolve against, the only place `edit` and `write` reach. */
  worktree: string;
  signal: AbortSignal;
  /**
   * The environment child processes are built from. A source, not a result:
   * `shell` and `grep` filter it through {@link buildToolEnv}, so passing
   * `process.env` here still leaks nothing.
   */
  env: NodeJS.ProcessEnv;
  /**
   * Where a result too long for the model is saved in full (ADR-0032): outside
   * the worktree, under Ordewell's data directory. `read` may read it back.
   */
  outputDir: string;
  /**
   * Further places `read` may read, such as the workspace root when the task's
   * mode allows it. Never writable: `edit` and `write` stay in the worktree.
   */
  extraReadRoots?: readonly string[];
}

export interface ToolResult {
  /** What the model reads. */
  text: string;
  /** The call failed: the model reads `text` as the reason. */
  isError: boolean;
  /** Structured facts for the task log; the model never sees them. */
  details?: Readonly<Record<string, unknown>>;
  /**
   * The tool bounded this result itself, one page with its own way to continue
   * (`read`). {@link runTool} then leaves the text alone: a footer that says
   * where the next page starts would otherwise be what the cap cut.
   */
  paged?: boolean;
}

/**
 * What a call does, for the gate (a later task's Guarded and read-only modes):
 * `read` touches nothing, `write` changes files in the worktree, `exec` runs a
 * program of the model's choosing.
 */
export type ToolEffect = 'read' | 'write' | 'exec';

export interface OrdewellTool {
  name: string;
  description: string;
  parameters: ToolSchema;
  effect: ToolEffect;
  /** Which end of a result too long for the model survives: a build log's end holds its error. Default `head`. */
  keep?: 'head' | 'tail';
  execute(args: Readonly<Record<string, unknown>>, context: ToolContext): Promise<ToolResult>;
}
