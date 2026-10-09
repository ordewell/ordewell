export interface RunnerManifest {
  name: string;
  displayName: string;
  runner: { command: string };
  features: RunnerFeatures;
  modelDiscovery: RunnerModelDiscovery;
  contextFile?: string;
  contextFileAltPath?: string;
  modes?: RunnerMode[];
}

export interface RunnerFeatures {
  permissionModeValues?: Record<string, string>;
  modeSettings?: Record<string, Record<string, string>>;
}

export type ModelDiscoveryParser = 'claude-help' | 'opencode-models' | 'opencode-models-verbose' | 'anthropic-models' | 'line-by-line' | 'json' | 'json-table';

export interface DiscoveryCommand {
  command: string;
  args: string[];
  parser?: ModelDiscoveryParser;
}

export type ApiAuthMethod =
  | { type: 'env'; varName: string; header: string; prefix?: string }
  | { type: 'file'; path: string; jsonPath: string; header: string; prefix?: string };

export interface ApiDiscoveryConfig {
  url: string;
  headers?: Record<string, string>;
  auth: ApiAuthMethod[];
  parser: ModelDiscoveryParser;
}

export interface RunnerModelDiscovery {
  method: 'command' | 'hardcoded';
  command?: string;
  args?: string[];
  parser?: ModelDiscoveryParser;
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
   * Optional last-resort list for a CLI that cannot enumerate
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

export interface RunnerMode {
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

export interface RunnerEntry {
  manifest: RunnerManifest;
}
