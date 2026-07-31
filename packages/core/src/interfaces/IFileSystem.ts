export interface ToolOutcome {
  success: boolean;
  output: string;
  truncated: boolean;
}

export interface ReadFileOpts {
  maxBytes?: number;
  offset?: number;
  limit?: number;
}

/**
 * `content` returns matching lines, `files` only the paths that matched, and
 * `count` a per-file tally. Cheap models otherwise grep and then read whole
 * files to answer "which files touch this", burning rounds against the budget.
 */
export type GrepOutputMode = 'content' | 'files' | 'count';

export interface GrepOptions {
  /** File glob filter, e.g. `*.ts`. */
  include?: string;
  /** Search root. Relative to the workspace unless approved as external. */
  path?: string;
  outputMode?: GrepOutputMode;
  /** Lines of context around each match (`content` mode only). */
  contextBefore?: number;
  contextAfter?: number;
  /** Treat the pattern as a literal string rather than a regex. */
  literal?: boolean;
  caseInsensitive?: boolean;
  /** Global cap on returned rows. Defaults to {@link GREP_DEFAULT_HEAD_LIMIT}. */
  headLimit?: number;
}

export interface GlobOptions {
  /** Search root. Relative to the workspace unless approved as external. */
  path?: string;
  headLimit?: number;
}

export interface FindSymbolOptions {
  /** Language id or file extension, e.g. `typescript` or `.go`. Narrows the keyword set. */
  language?: string;
  /** Search root. Relative to the workspace unless approved as external. */
  path?: string;
}

/** Global row cap for grep. A per-file cap is not a budget — see PoolFileSystem. */
export const GREP_DEFAULT_HEAD_LIMIT = 100;

/**
 * Directories that are never interesting to a planner and would otherwise eat
 * the result budget. Applied by every search entry point, not just `glob` —
 * `dist/` and `.ordewell/` are frequently not gitignored.
 */
export const SEARCH_EXCLUSIONS = [
  'node_modules', '.git', '.ordewell', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache',
  'vendor', 'coverage', '.turbo', '.cache', '.gradle', 'Pods', '.terraform',
];

export interface IFileSystem {
  readFile(path: string, opts?: ReadFileOpts): Promise<ToolOutcome>;
  readFiles(paths: string[]): Promise<ToolOutcome>;
  glob(pattern: string, opts?: GlobOptions): Promise<ToolOutcome>;
  grep(pattern: string, opts?: GrepOptions): Promise<ToolOutcome>;
  listDir(path: string, depth?: number): Promise<ToolOutcome>;
  bash(command: string): Promise<ToolOutcome>;
  /** Definition-first lookup for one symbol. See `symbolPatterns.ts`. */
  findSymbol(symbol: string, opts?: FindSymbolOptions): Promise<ToolOutcome>;
  getWorkspaceRoot(): string;
  /**
   * Inject the human-approval channel for out-of-envelope access. Optional so
   * test doubles stay small; every adapter extending `BaseFileSystem` has it.
   */
  setApproval?(approval: import('./IApproval').IApproval): void;
}
