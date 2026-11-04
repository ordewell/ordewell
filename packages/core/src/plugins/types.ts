import type { DiscoveredModel } from '../models/Task';

export interface RunnerManifest {
  name: string;
  displayName: string;
  runner: { command: string };
  features: RunnerFeatures;
  modelDiscovery: RunnerModelDiscovery;
  contextFile?: string;
  contextFileAltPath?: string;
  modes?: RunnerMode[];
  /** How to ask whether the user is signed in. Absent when the runner offers no status command. */
  auth?: RunnerAuthSpec;
}

/** What a runner's status command answered, with both streams kept apart. */
export interface RunnerAuthStatus {
  /** The exit status; never negative, since a timeout or a failed spawn is not an answer. */
  code: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr together, for a reader that matches a line on either. */
  output: string;
  /** The merged probe environment, so a reader can consult the config the command read. */
  env: NodeJS.ProcessEnv;
  /**
   * What the answer is: the status command's output, or a failed turn's own
   * words. A reader that parses the status output (JSON, say) cannot parse
   * the turn's message, and one that judges a turn's words by the runner's
   * config must not let the probe's exit code guess for it.
   */
  kind: 'status' | 'turn';
}

/**
 * A runner's own answer to "is the user signed in?" — the CLI args that ask,
 * the args that log in, and how to read the answer. Declared here because a
 * surface must run the same login the runner's own CLI would, with no second
 * table to drift.
 */
export interface RunnerAuthSpec {
  /**
   * The CLI args that answer whether the user is signed in, e.g. `auth status`.
   * Absent when the runner has a login but no status command to ask (Copilot):
   * nothing is probed, the verdict stays `unknown`, and a failed turn's own
   * words (`signedOut`) are what learn it.
   */
  statusArgs?: string[];
  /** The CLI args that run the login, e.g. `auth login`. */
  loginArgs: string[];
  /**
   * Matched against the status command's stdout+stderr when it exits non-zero,
   * and against a failed turn's own words to tell a signed-out failure from an
   * unrelated one.
   */
  signedOut?: RegExp;
  /**
   * A runner-specific reader that overrides the exit-code/regex rule. `null`
   * means the answer said nothing about the login, which stays `unknown`
   * rather than guessing from an exit code or from a line meant for another
   * credential route. The reader owns both kinds of answer — the status
   * command's output and a failed turn's own words — told apart by
   * {@link RunnerAuthStatus.kind}; where the reader exists, it is the only
   * judge of either.
   */
  read?: (answer: RunnerAuthStatus) => 'signed-in' | 'signed-out' | null;
}

export interface RunnerFeatures {
  permissionModeValues?: Record<string, string>;
  modeSettings?: Record<string, Record<string, string>>;
}

/** A runner's own reader for its catalog's output, kept beside its manifest. */
export type ModelOutputParser = (output: string, manifest: RunnerManifest) => DiscoveredModel[];

/** How discovery output becomes models: one `id label` per line, or the runner's own reader. Absent means per line. */
export type ModelDiscoveryParser = 'line-by-line' | ModelOutputParser;

export interface DiscoveryCommand {
  command: string;
  args: string[];
  parser?: ModelDiscoveryParser;
}

/**
 * The environment a runner is launched with: the daemon's own, under the
 * workspace's (ADR-0016). A runner's files can move with it, as Claude Code's
 * do under `CLAUDE_CONFIG_DIR`.
 */
export type RunnerEnv = Readonly<Record<string, string | undefined>>;

/**
 * Reads an agent's provider credential from its own store for one start: the
 * variables to add to that start's environment, null when the agent needs none
 * from Ordewell, and a throw, naming the routes that would sign it in, when it
 * has none (ADR-0060, R9). What it answers holds a secret. `kind` is the
 * start's, absent when model discovery asks.
 */
export type RunnerCredentials = (context: { env: RunnerEnv; kind?: 'planner' | 'task' }) => Promise<Readonly<Record<string, string>> | null>;

export type ApiAuthMethod =
  | { type: 'env'; varName: string; header: string; prefix?: string }
  /** `path` is `~` expanded; a function of the runner's environment when that relocates the file. */
  | { type: 'file'; path: string | ((env: RunnerEnv) => string); jsonPath: string; header: string; prefix?: string };

/** What a runner's settings reader may look at, with `~` expanded in every path. */
export interface RunnerSettingsFiles {
  /** The file's content, or null when it is missing or unreadable. A leading `~` is the home `env` gives the runner. */
  read(file: string): string | null;
  /** The names of the entries in `dir`, or none when it is missing. A leading `~` is read as in {@link read}. */
  list(dir: string): string[];
  env: RunnerEnv;
}

export interface ApiDiscoveryConfig {
  url: string;
  headers?: Record<string, string>;
  auth: ApiAuthMethod[];
  parser: ModelDiscoveryParser;
}

export interface RunnerModelDiscovery {
  /**
   * `acp` asks the running agent over the Agent Client Protocol first; the
   * manifest's `discoveryCommands` and aliases are what it falls back to, so a
   * runner using it still declares them.
   */
  method: 'command' | 'hardcoded' | 'acp';
  command?: string;
  args?: string[];
  parser?: ModelDiscoveryParser;
  /**
   * Stdio JSON-RPC discovery (Codex `app-server`): spawn the command, send
   * `initialize` then `model/list`, and read the catalog from the response.
   * Tried BEFORE apiDiscovery and command discovery. When the call fails,
   * `cacheFile` (the runner's own on-disk catalog cache, `~` expanded, or
   * found from the runner's environment) is read before falling through to
   * the remaining discovery methods.
   */
  appServer?: { command: string; args: string[]; cacheFile?: string | ((env: RunnerEnv) => string) };
  /**
   * ACP discovery (`method: 'acp'`): start `runner.command` with `args`, run
   * `initialize` and `session/new` in a scratch directory with no MCP servers,
   * and read the models and efforts the new session offers. No prompt is sent,
   * so nothing is billed. Any failure, signed-out included, falls through to
   * the remaining methods: discovery never gates a pick (ADR-0040).
   *
   * `env` and `credentials` are the ones the runner's ACP profile starts it
   * with, so an agent that reads its key only from its environment is asked
   * as it runs (ADR-0060, R9). A hook that refuses is no answer, and nothing
   * is spawned.
   */
  acp?: { args: string[]; env?: Readonly<Record<string, string>>; credentials?: RunnerCredentials };
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
   * The runner names its models `provider/model` (OpenCode), so an id of that
   * shape can be its own rather than an OpenRouter slug left from a vendor
   * planner.
   */
  providerQualifiedIds?: boolean;
  /**
   * HTTP API discovery — tried BEFORE command discovery. When the runner's CLI
   * has no model-listing subcommand (Claude Code), an API endpoint can serve as
   * the authoritative source. Auth methods are tried in order; the first that
   * yields a token is used. If no auth method yields a token or the request
   * fails, discovery falls through to `discoveryCommands` + `canonicalAliases`.
   */
  apiDiscovery?: ApiDiscoveryConfig;
  /**
   * Models registered in the runner's own settings, such as gateway IDs no
   * catalog lists, read as the runner itself resolves its settings files.
   * Appended to whatever the other methods produced, success or fallback: an
   * ID they already offer keeps their entry. Missing or unreadable files add
   * nothing.
   */
  settingsModels?: (files: RunnerSettingsFiles) => DiscoveredModel[];
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
  /** Marks this mode as the runner's read-only mode — what a task the planner marks read-only runs in (ADR-0031). */
  readOnly?: boolean;
  /** The mode runs under an OS sandbox, so a host where the runner's sandbox cannot start cannot offer it. */
  sandboxed?: boolean;
  /**
   * Why this mode cannot be used on this host. Set by the registry from a host
   * probe, never by a manifest: a mode with a reason is listed, so the user is
   * told, but never assigned, kept or run.
   */
  unavailable?: string;
}

export interface RunnerEntry {
  manifest: RunnerManifest;
}
