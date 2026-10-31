export interface ToolOutcome {
  success: boolean;
  output: string;
  truncated: boolean;
  /**
   * The child was killed at its time limit, so what it had not finished did
   * not happen (ADR-0036 S1). The adapters set it, and a sealed run's result
   * names the limit it ran out of rather than blaming the command.
   */
  timedOut?: boolean;
  /**
   * The signal that ended the child, if one did. The adapters report it, and a
   * sealed run's result reads it for the one that means its memory limit ended
   * the run (ADR-0036 S1).
   */
  signal?: NodeJS.Signals;
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

export interface BashOptions {
  /**
   * Run the command sealed (ADR-0036 S2): no network, no home directory,
   * nothing written reaching the workspace, and nobody asked. Refused where
   * the host has no sandbox to seal it in.
   */
  sealed?: boolean;
}

/** Where a read-only task's commands run (ADR-0046). */
export interface TaskShellSite {
  /** Where its commands start, and what their paths are confined to: the task's worktree, or the workspace root when the run does not isolate. */
  cwd: string;
  /** The task's own worktree, the one directory but scratch a sealed run may write; absent without one. */
  writable?: string;
  /**
   * The git worktree roots inside `writable` whose `.git` a sealed run must
   * not rewrite into a repository of its own (ADR-0046): one per repo in a
   * group. Left out, the single `writable` worktree's `.git` is protected.
   */
  worktrees?: readonly string[];
}

/**
 * Sealed runs of Ordewell's own scripts in a read-only task's shell, while
 * the shell is held for them (ADR-0050). They are judged by no command rule,
 * since the task did not write them, but run under the task's sealed profile
 * and are checked after as each of its sealed runs is: Ordewell runs no git
 * in a worktree a sealed run wrote anywhere but inside the seal (ADR-0046).
 */
export interface OwnSealedRuns {
  /** The repository roots the task's sealed runs may write: one per repo, none without a worktree. */
  readonly worktrees: readonly string[];
  /** Whether a sealed run has started in the shell: until one has, its worktree holds only what Ordewell checked out. */
  readonly touched: boolean;
  /** The attempt's scratch directory, which a sealed run has as `$TMPDIR` and `$HOME`. */
  readonly scratch: string;
  /** `script` run sealed from `cwd`, one of {@link worktrees}; refused once the shell is stopped, or where no sandbox can seal. */
  run(script: string, cwd: string): Promise<ToolOutcome>;
}

/**
 * A read-only task's `run_command` (ADR-0046): the planner's command rules at
 * the task's working directory, with nobody to ask. One per attempt, with a
 * scratch directory of its own; once one of its commands has run sealed,
 * every later one does.
 */
export interface TaskShell {
  run(command: string, signal?: AbortSignal): Promise<ToolOutcome>;
  /**
   * Hold the shell for Ordewell's own `work` (ADR-0050): no command of the
   * task runs until it settles, so nothing changes the worktree between the
   * sealed runs it makes. `signal` stops those runs.
   */
  hold?<T>(work: (runs: OwnSealedRuns) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** The attempt ended: its scratch directory goes. */
  end(): void;
}

export interface IFileSystem {
  readFile(path: string, opts?: ReadFileOpts): Promise<ToolOutcome>;
  readFiles(paths: string[]): Promise<ToolOutcome>;
  glob(pattern: string, opts?: GlobOptions): Promise<ToolOutcome>;
  grep(pattern: string, opts?: GrepOptions): Promise<ToolOutcome>;
  listDir(path: string, depth?: number): Promise<ToolOutcome>;
  /**
   * `signal` stops the planning turn this command belongs to: adapters kill
   * the spawned child rather than let it run out its own timeout. The other
   * tools here are short enough that the loop's between-call abort check is
   * indistinguishable from cancelling them mid-flight; a `bash` call is not.
   */
  bash(command: string, signal?: AbortSignal, opts?: BashOptions): Promise<ToolOutcome>;
  /** Definition-first lookup for one symbol. See `symbolPatterns.ts`. */
  findSymbol(symbol: string, opts?: FindSymbolOptions): Promise<ToolOutcome>;
  getWorkspaceRoot(): string;
  /**
   * Inject the human-approval channel for out-of-envelope access. Optional so
   * test doubles stay small; every adapter extending `BaseFileSystem` has it.
   */
  setApproval?(approval: import('./IApproval').IApproval): void;
  /** Held credentials read live by the outbound secret check. */
  setOutboundSecrets?(secrets: () => Iterable<string>): void;
  /** Where the filesystem tells the session, once, that the planner's shell runs without an OS sandbox here (ADR-0011 B5). */
  setNotice?(notice: (message: string) => void): void;
  /** The session ended: its scratch directory is removed, and the next command starts a fresh one (ADR-0011 B2). */
  endSession?(): void;
  /** Whether a command can run sealed on this host (ADR-0036 S6); where it cannot, the session's one notice says so. */
  canSeal?(): Promise<boolean>;
  /** A read-only task's shell at `site`, held to this session's allowlist and never asking (ADR-0046). */
  taskShell?(site: TaskShellSite): TaskShell;
}
