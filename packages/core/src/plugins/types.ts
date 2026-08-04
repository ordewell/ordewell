
export interface RunnerPluginManifest {
  name: string;
  displayName: string;
  description: string;
  version: string;
  author?: string;
  homepage?: string;

  runner: PluginRunnerDef;
  features: PluginFeatures;
  modelDiscovery: PluginModelDiscovery;
  contextFile?: string;
  contextFileAltPath?: string;
  modes?: PluginMode[];
}

export interface PluginRunnerDef {
  command: string;
  argsTemplate: string[];
  promptInArgs: boolean;
  env?: Record<string, string>;
  /** When true, the runner requires a PTY. HeadlessRunner wraps with `script` to allocate one. */
  requiresTty?: boolean;
}

export interface PluginFeatures {
  modelSelection: boolean;
  thinkingEffort: boolean;
  planMode: boolean;
  planModeFlag: string;
  buildModeFlag?: string;
  /** Flag appended when headless mode is on, so the agent never prompts for permission (e.g. Claude's --dangerously-skip-permissions). */
  headlessFlag?: string;
  thinkingFlag?: string;
  thinkingValueEnabled?: string;
  thinkingValueDisabled?: string;
  thinkingValueAdaptive?: string;
  /** Maps mode IDs to the CLI --permission-mode value. Used by {{feature:permissionModeVal}}. */
  permissionModeValues?: Record<string, string>;
}

export type PluginParser = 'claude-help' | 'opencode-models' | 'opencode-models-verbose' | 'anthropic-models' | 'line-by-line' | 'json' | 'json-table';

export interface DiscoveryCommand {
  command: string;
  args: string[];
  parser?: PluginParser;
}

export type ApiAuthMethod =
  | { type: 'env'; varName: string; header: string; prefix?: string }
  | { type: 'file'; path: string; jsonPath: string; header: string; prefix?: string };

export interface ApiDiscoveryConfig {
  url: string;
  headers?: Record<string, string>;
  auth: ApiAuthMethod[];
  parser: PluginParser;
}

export interface PluginModelDiscovery {
  method: 'command' | 'hardcoded';
  command?: string;
  args?: string[];
  parser?: PluginParser;
  jsonPath?: string;
  /**
   * Stdio JSON-RPC discovery (Codex `app-server`): spawn the command, send
   * `initialize` then `model/list`, and read the catalog from the response.
   * Tried BEFORE apiDiscovery and command discovery. When the call fails,
   * `cacheFile` (the runner's own on-disk catalog cache, `~` expanded) is
   * read before falling through to the remaining discovery methods.
   */
  appServer?: { command: string; args: string[]; cacheFile?: string };
  /**
   * Optional last-resort list for user plugins whose CLI cannot enumerate
   * models. Used only when command discovery fails entirely or the CLI is
   * unavailable. Built-in manifests must NOT use this: anything listed here is
   * shown to the user as available even when it isn't.
   */
  fallbackModels?: { modelId: string; modelLabel: string }[];
  /**
   * Stable `--model` aliases that the runner's CLI always accepts but its help
   * text may omit (e.g. Claude's 'haiku'). Merged into successful discovery
   * results to fill gaps — discovered models take precedence, missing aliases
   * are appended — and used as the last resort when discovery fails entirely.
   * Unlike `fallbackModels`, entries must be stable CLI-accepted aliases
   * (contracts that always resolve), not arbitrary model IDs.
   */
  canonicalAliases?: { modelId: string; modelLabel: string }[];
  /**
   * HTTP API discovery — tried BEFORE command discovery. When the runner's CLI
   * has no model-listing subcommand (Claude Code), an API endpoint can serve as
   * the authoritative source. Auth methods are tried in order; the first that
   * yields a token is used. If no auth method yields a token or the request
   * fails, discovery falls through to `discoveryCommands` + `canonicalAliases`.
   */
  apiDiscovery?: ApiDiscoveryConfig;
  preferredPatterns?: { id: string; label: string }[];
  variants?: { id: string; label: string }[];
  discoveryCommands?: DiscoveryCommand[];
}

export interface PluginMode {
  id: string;
  label: string;
  description: string;
  /** CLI value passed to the runner's permission/mode flag. Defaults to id if omitted. */
  cliValue?: string;
  /** Marks this mode as the runner's most permissive mode — the resolved default when autonomous mode is ON. */
  autonomous?: boolean;
  /** Marks this mode as the runner's conservative build mode — the resolved default when autonomous mode is OFF. */
  safe?: boolean;
}

export interface PluginEntry {
  manifest: RunnerPluginManifest;
  source: 'builtin' | 'user';
  installPath?: string;
}

export interface ResolveContext {
  prompt: string;
  model?: string;
  thinkingEffort?: string;
  /** All variant ids the assigned model offers — lets {{opencodeVariantConfig}} disable the non-chosen ones. */
  modelVariants?: string[];
  mode: string;
  /**
   * Autonomy axis: when true, resolve {{if headless}} blocks and the
   * {{feature:headless}} token so the agent never stops to ask for permission.
   * True for every orchestrated task run — nobody is watching the terminal on
   * Ordewell's behalf — independently of the session *shape* below.
   */
  headless?: boolean;
  /**
   * Session-shape axis: true when the runner is launched onto a real TTY the
   * user can attach to (a tmux window, a VS Code pseudoterminal), so the
   * runner's own TUI should come up rather than its non-interactive
   * subcommand. Defaults to `!headless` for callers that predate the split.
   */
  interactive?: boolean;
  /** The task's working directory — needed by runners whose autonomy flags name a path. */
  cwd?: string;
}

export interface RunnerInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  promptInArgs: boolean;
}

/**
 * Persistent storage seam for plugin manifests. The RunnerRegistry delegates
 * all filesystem operations to this interface so the plugin lifecycle is
 * testable without real I/O.
 */
export interface IPluginStore {
  /** Path to the user plugins directory (~/.config/ordewell/plugins/). */
  getUserPluginsDir(): string;
  /** List subdirectory names inside the user plugins directory. */
  listUserPluginDirs(): string[];
  /** Read and parse a manifest.json from pluginDir. Returns null on failure. */
  loadManifest(pluginDir: string): RunnerPluginManifest | null;
  /** Recursively copy sourceDir to destDir. */
  copyDir(sourceDir: string, destDir: string): void;
  /** Recursively remove a directory. */
  removeDir(dir: string): void;
  /** Ensure a directory exists (mkdir -p). */
  ensureDir(dir: string): void;
  /** Write a text file. */
  writeFile(filePath: string, content: string): void;
  /** Read a UTF-8 text file. Returns null on ENOENT or read error. */
  readFile(filePath: string): string | null;
  /** True if path exists and is a directory. */
  dirExists(path: string): boolean;
  /** True if path exists. */
  exists(path: string): boolean;
}
