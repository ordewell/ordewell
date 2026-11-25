import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fsSync from 'fs';
import { DiscoveredModel } from '../models/Task';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import { inProcessProvider, runnerCommand, type RunnerManifest, type DiscoveryCommand, type ApiDiscoveryConfig, type ApiAuthMethod, type ModelDiscoveryParser, type RunnerEnv, type RunnerSettingsFiles } from '../plugins/types';
import { augmentedPath, withPath } from '../utils/shellPath';
import { globalDataDir } from '../utils/globalDataDir';
import { expandRunnerHome } from '../utils/runnerHome';
import { withHostCredentials } from './hostCredentials';
import { discoverAppServerModels, type AppServerModel } from './harness/appServerModels';
import { discoverAcpModels, type AcpModelsAnswer } from './harness/acpModels';
import { discoverProviderModels } from './harness/ordewell/models';
import { recordRunnerAuth, runnerAuthClock, runnerSignIn, signedOutAuth } from './runnerAuth';
import { RunnerCredentialRefusal } from './signInHint';

export type { AppServerModel } from './harness/appServerModels';

const execAsync = promisify(exec);

/**
 * Injectable command runner. Defaults to the real `child_process` exec wrapper;
 * tests pass a fake so discovery never spawns a process.
 */
export type ExecImpl = (
  command: string,
  options?: { timeout?: number; env?: RunnerEnv }
) => Promise<{ stdout: string }>;

// Discovery must find `claude`/`opencode` wherever the user installed them,
// even when the host process (GUI-launched VS Code, service-launched web
// server) inherits a minimal PATH — hence the augmented PATH.
const defaultExec: ExecImpl = async (command, options) => {
  const PATH = await augmentedPath();
  // `opencode models --verbose` (v1) and `opencode api model.list` (v2) emit a
  // JSON block per model and grow with every provider the user enables
  // (~0.5MB with three providers today);
  // node's default 1MB maxBuffer would kill the child mid-stream and silently
  // degrade discovery to the variant-less plain parser.
  const { stdout } = await execAsync(command, { timeout: options?.timeout, maxBuffer: 32 * 1024 * 1024, env: withPath(options?.env ?? process.env, PATH) });
  return { stdout: String(stdout) };
};

/**
 * Injectable app-server JSON-RPC client: ask the runner's `app-server` for its
 * `model/list` and return the raw entries. Returns null on any failure (spawn
 * error, timeout, malformed response) so discovery falls through to the
 * on-disk cache file. Tests inject a fake so discovery never spawns a real
 * app-server.
 */
export type AppServerClientImpl = (
  command: string,
  args: string[],
  options?: { timeout?: number; env?: RunnerEnv }
) => Promise<AppServerModel[] | null>;

/** Exported for its test: the real client is the one place that spawns an app-server. */
export const defaultAppServerClient: AppServerClientImpl = (command, args, options) =>
  discoverAppServerModels(command, args, { timeout: options?.timeout, env: options?.env });

/**
 * Injectable ACP client: start the agent, open a session and return what it
 * offers. `'signed-out'` when the agent would open none until signed in, null
 * on any other failure (spawn error, timeout, malformed answer); either way
 * discovery falls through to the manifest's other methods. An empty list means
 * the agent answered and offered no model choice.
 */
export type AcpClientImpl = (
  command: string,
  args: string[],
  options?: { timeout?: number; env?: RunnerEnv }
) => Promise<AcpModelsAnswer>;

export const defaultAcpClient: AcpClientImpl = (command, args, options) =>
  discoverAcpModels(command, args, { timeout: options?.timeout, env: options?.env });

/**
 * Why a runner's last discovery listed nothing (ADR-0060, R9; #46 F6), or
 * `pending` while it is still being asked. `signed-out` and `no-credential`
 * are blockers: the agent refused, or its credential hook found no key to
 * start it with, and a refresh alone cannot fill the list. `no-choice` is an
 * agent that answered with no model to choose, so a planner on it runs on the
 * agent's own default model. `no-answer` is an ask that got nothing back (a
 * timeout, a failed start, a fallback-only answer), which says nothing about
 * the sign-in. `no-models` is a discovery that finished and listed nothing,
 * from a runner with no default of its own to run on.
 */
export type UnlistedReason = 'pending' | 'signed-out' | 'no-credential' | 'no-choice' | 'no-answer' | 'no-models';

/** What one ACP ask said, before the manifest's other methods answer. */
type AcpOutcome =
  | { kind: 'signed-in' | 'signed-out' | 'no-choice' | 'no-answer' }
  | { kind: 'no-credential'; refused: string | null };

/**
 * The environment an ACP agent is asked under: the runner's, then what its
 * profile starts it with, then the key its credential hook reads for this one
 * start (ADR-0060, R9). A refusal when the hook finds no key, so nothing is
 * spawned, carrying the hook's own words only when it refused in the shared
 * type: any other throw could quote what it read.
 */
async function acpStartEnv(acp: NonNullable<RunnerManifest['modelDiscovery']['acp']>, env: RunnerEnv): Promise<{ env: RunnerEnv } | { refused: string | null }> {
  const started = { ...env, ...acp.env };
  if (!acp.credentials) return { env: started };
  try {
    // The hook reads the variables the agent would have without the profile's, as at a task's start.
    const credential = await acp.credentials({ env });
    return { env: { ...started, ...credential } };
  } catch (err) {
    return { refused: err instanceof RunnerCredentialRefusal ? err.message : null };
  }
}

function effortVariant(effort: string): { id: string; label: string } {
  return { id: effort, label: effort.charAt(0).toUpperCase() + effort.slice(1) };
}

/** Map app-server `model/list` entries to DiscoveredModels, dropping hidden ones. */
export function parseAppServerModels(raw: AppServerModel[]): DiscoveredModel[] {
  return raw
    .filter((m) => m.id && !m.hidden)
    .map((m) => ({
      modelId: m.id,
      modelLabel: m.displayName || m.id,
      runnerProvider: 'openai',
      variants: (m.supportedReasoningEfforts ?? []).map((e) => effortVariant(e.reasoningEffort)),
    }));
}

/**
 * Parse the runner's own on-disk catalog cache (Codex `models_cache.json`).
 * Same catalog as `model/list` but in the cache file's snake_case shape, with
 * `visibility: "hide"` in place of the protocol's `hidden` flag.
 */
export function parseCodexModelsCache(content: string): DiscoveredModel[] {
  try {
    const data = JSON.parse(content) as {
      models?: Array<{
        slug?: string;
        display_name?: string;
        visibility?: string;
        supported_reasoning_levels?: { effort: string; description?: string }[];
      }>;
    };
    if (!Array.isArray(data.models)) return [];
    return data.models
      .filter((m) => m.slug && m.visibility !== 'hide')
      .map((m) => ({
        modelId: m.slug!,
        modelLabel: m.display_name || m.slug!,
        runnerProvider: 'openai',
        variants: (m.supported_reasoning_levels ?? []).map((l) => effortVariant(l.effort)),
      }));
  } catch {
    return [];
  }
}

const GEMINI_MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a degraded runner discovery (a manifest fallback list, or an empty
 * one because the CLI failed) is remembered before the next lookup re-runs it.
 * The failure that goes stale while a host runs is a cold or misconfigured CLI;
 * without this, every planner switch and every runner-list refresh re-pays a
 * slow or failing spawn — `opencode models` boots a background service before it answers.
 * Bounded the same way `RunnerInstallation`'s negative verdict is, and a refresh
 * asks again at once.
 */
const NEGATIVE_TTL_MS = 60_000;

interface GeminiApiModel {
  name: string;
  displayName: string;
  supportedGenerationMethods?: string[];
  /** The longest prompt, as Gemini itself states it: the reply is not part of it. */
  inputTokenLimit?: number;
  /** The longest reply, limited apart from the prompt. */
  outputTokenLimit?: number;
}

function geminiDiscoveryCacheKey(apiKey: string): { key: string; dir: string; file: string } {
  const dir = globalDataDir();
  const hash = apiKey.slice(-8);
  return {
    key: `gemini-models:${hash}`,
    dir,
    file: path.join(dir, `gemini_models_${hash}.json`),
  };
}

function readGeminiCache(apiKey: string): DiscoveredModel[] | null {
  try {
    const { file } = geminiDiscoveryCacheKey(apiKey);
    if (!fsSync.existsSync(file)) return null;
    const raw = fsSync.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (Date.now() - data.cachedAt > GEMINI_MODELS_CACHE_TTL_MS) return null;
    return data.models as DiscoveredModel[];
  } catch {
    return null;
  }
}

function writeGeminiCache(apiKey: string, models: DiscoveredModel[]): void {
  try {
    const { dir, file } = geminiDiscoveryCacheKey(apiKey);
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(
      file,
      JSON.stringify({ models, cachedAt: Date.now() }, null, 2)
    );
  } catch { /* empty */ }
}

/**
 * Delete the on-disk Gemini discovery cache for an API key so the next
 * discovery re-runs. Used by the resolver's `invalidate()` in production (no
 * injected fetch); best-effort — a missing file is a no-op.
 */
export function clearGeminiCache(apiKey: string): void {
  if (!apiKey) return;
  try {
    const { file } = geminiDiscoveryCacheKey(apiKey);
    if (fsSync.existsSync(file)) fsSync.rmSync(file);
  } catch { /* empty */ }
}

export async function discoverGeminiModels(apiKey: string, baseUrl?: string, fetchImpl?: typeof fetch): Promise<DiscoveredModel[]> {
  if (!apiKey) return [];

  // An injected fetch means the resolver owns caching — bypass the file cache.
  const useFileCache = !fetchImpl;
  if (useFileCache) {
    const cached = readGeminiCache(apiKey);
    if (cached && cached.length > 0) return cached;
  }

  const url = (baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');

  try {
    const models: DiscoveredModel[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({ key: apiKey });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await (fetchImpl ?? fetch)(`${url}/v1beta/models?${params}`, {
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) return [];

      const data = (await response.json()) as { models?: GeminiApiModel[]; nextPageToken?: string };
      for (const m of data.models ?? []) {
        const methods = m.supportedGenerationMethods ?? [];
        if (methods.includes('generateContent')) {
          const modelId = m.name.replace(/^models\//, '');
          models.push({
            modelId,
            modelLabel: m.displayName || modelId,
            runnerProvider: 'gemini',
            variants: [],
            ...(typeof m.inputTokenLimit === 'number' && m.inputTokenLimit > 0 ? { contextWindow: m.inputTokenLimit } : {}),
            ...(typeof m.outputTokenLimit === 'number' && m.outputTokenLimit > 0 ? { maxOutputTokens: m.outputTokenLimit } : {}),
          });
        }
      }

      pageToken = data.nextPageToken || undefined;
    } while (pageToken);

    models.sort((a, b) => {
      const aPro = a.modelId.includes('-pro');
      const bPro = b.modelId.includes('-pro');
      if (aPro && !bPro) return -1;
      if (!aPro && bPro) return 1;
      return b.modelId.localeCompare(a.modelId);
    });

    if (useFileCache && models.length > 0) writeGeminiCache(apiKey, models);
    return models;
  } catch {
    return [];
  }
}

function applyVariants(models: DiscoveredModel[], manifest: RunnerManifest): DiscoveredModel[] {
  const variants = manifest.modelDiscovery.variants;
  if (!variants || variants.length === 0) return models;
  // Only fill in models whose variants are empty (e.g. --help parsing or
  // canonical-alias fallback). Models that already carry per-model variants
  // from the API must keep them — the static list is a fallback, not an override.
  return models.map((m) => (m.variants.length > 0 ? m : { ...m, variants }));
}

function listDir(dir: string): string[] {
  try {
    return fsSync.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Resolve an auth token from a manifest's `apiDiscovery.auth` list. Each method
 * is tried in order; the first that yields a non-empty token wins.
 *
 * - `env`: reads `varName` from the runner's environment
 * - `file`: reads a JSON file at `path` (with `~` expansion) and extracts the
 *   value at `jsonPath` (dot-notation, e.g. `claudeAiOauth.accessToken`)
 *
 * Returns `{ header, value }` ready to set on the fetch `headers` object, or
 * `null` when no auth method yields a token.
 */
function resolveApiAuth(authMethods: ApiAuthMethod[], env: RunnerEnv): { header: string; value: string } | null {
  for (const method of authMethods) {
    try {
      let token: string | undefined;
      if (method.type === 'env') {
        token = env[method.varName];
      } else {
        const filePath = expandRunnerHome(typeof method.path === 'function' ? method.path(env) : method.path, env);
        if (!filePath || !fsSync.existsSync(filePath)) continue;
        const data = JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
        token = method.jsonPath.split('.').reduce((obj: unknown, key: string) => {
          if (obj && typeof obj === 'object') return (obj as Record<string, unknown>)[key] as unknown;
          return undefined;
        }, data) as string | undefined;
      }
      if (token) {
        const value = method.prefix ? `${method.prefix}${token}` : token;
        return { header: method.header, value };
      }
    } catch { /* try next auth method */ }
  }
  return null;
}

/**
 * Query an HTTP API endpoint for the model list. Used when the runner's CLI
 * has no model-listing subcommand (Claude Code). Returns the parsed models, or
 * `null` when no auth token is available or the request fails — in both cases
 * the caller falls through to command-based discovery.
 */
async function discoverFromApi(
  manifest: RunnerManifest,
  config: ApiDiscoveryConfig,
  env: RunnerEnv,
  fetchImpl?: typeof fetch
): Promise<DiscoveredModel[] | null> {
  const auth = resolveApiAuth(config.auth, env);
  if (!auth) return null;

  try {
    const headers: Record<string, string> = { ...config.headers, [auth.header]: auth.value };
    const response = await (fetchImpl ?? fetch)(config.url, { headers });
    if (!response.ok) return null;
    const data = await response.json();
    const text = JSON.stringify(data);
    return parseModelOutput(text, config.parser, manifest);
  } catch {
    return null;
  }
}

/**
 * Whether a discovery command was killed by its own timeout — the cold-CLI
 * signal (the server is still starting, the catalog is not fetched yet). A
 * non-zero exit is not this: the binary is missing, a flag was rejected, or a
 * port is busy, and none of those heal on a retry. `child_process.exec` rejects
 * a timed-out child with `killed: true`.
 */
function wasKilled(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { killed?: unknown }).killed === true;
}

async function discoverFromCommand(manifest: RunnerManifest, execImpl: ExecImpl, env: RunnerEnv): Promise<{ models: DiscoveredModel[]; fromFallback: boolean }> {
  const discovery = manifest.modelDiscovery;
  const commands: DiscoveryCommand[] = discovery.discoveryCommands ?? [
    { command: discovery.command!, args: discovery.args || [], parser: discovery.parser },
  ];

  const runCommands = async (): Promise<{ models: DiscoveredModel[] | null; timedOut: boolean }> => {
    let timedOut = false;
    for (const cmd of commands) {
      try {
        // Generous timeout: a cold runner CLI may spawn its server, install
        // extensions, and fetch its catalog on first invocation after boot.
        const { stdout } = await execImpl(`${cmd.command} ${cmd.args.join(' ')}`, { timeout: 45000, env });
        const models = parseModelOutput(stdout, cmd.parser, manifest);
        if (models.length > 0) return { models: applyVariants(mergeCanonicalAliases(models, manifest), manifest), timedOut };
      } catch (err) {
        // A killed command is the cold-start shape a warm retry can recover;
        // anything else is an answer, not a warm-up.
        if (wasKilled(err)) timedOut = true;
      }
    }
    return { models: null, timedOut };
  };

  // First pass. Retry once only when a command was killed by its timeout — the
  // CLI was cold and the server is warm by the second pass. A command that
  // exited non-zero said something real, and repeating it only doubles the wait.
  const first = await runCommands();
  if (first.models) return { models: first.models, fromFallback: false };
  if (first.timedOut) {
    const second = await runCommands();
    if (second.models) return { models: second.models, fromFallback: false };
  }

  return { models: applyVariants(buildFallbackModels(manifest), manifest), fromFallback: true };
}

/**
 * Merge `manifest.modelDiscovery.canonicalAliases` into a successful discovery
 * result. Discovered models take precedence (they reflect the installed CLI);
 * any canonical alias NOT already present is appended, so stable `--model`
 * contracts that the CLI's help text omits (e.g. Claude's 'haiku') are always
 * offered. Only applies when `canonicalAliases` is declared.
 */
function mergeCanonicalAliases(discovered: DiscoveredModel[], manifest: RunnerManifest): DiscoveredModel[] {
  const canonical = manifest.modelDiscovery.canonicalAliases;
  if (!canonical || canonical.length === 0) return discovered;
  const seen = new Set(discovered.map((m) => m.modelId));
  const gaps = canonical
    .filter((f) => !seen.has(f.modelId))
    .map((f) => ({
      modelId: f.modelId,
      modelLabel: f.modelLabel,
      runnerProvider: f.modelId.includes('/') ? f.modelId.split('/')[0] : undefined,
      variants: [],
    }));
  return gaps.length > 0 ? [...discovered, ...gaps] : discovered;
}

function buildFallbackModels(manifest: RunnerManifest): DiscoveredModel[] {
  const list = manifest.modelDiscovery.canonicalAliases ?? manifest.modelDiscovery.fallbackModels ?? [];
  return list.map((m) => ({
    modelId: m.modelId,
    modelLabel: m.modelLabel,
    runnerProvider: m.modelId.includes('/') ? m.modelId.split('/')[0] : undefined,
    variants: manifest.modelDiscovery.variants || [],
  }));
}

function parseModelOutput(stdout: string, parser: ModelDiscoveryParser | undefined, manifest: RunnerManifest): DiscoveredModel[] {
  return typeof parser === 'function' ? parser(stdout, manifest) : parseLineByLine(stdout);
}

function parseLineByLine(stdout: string): DiscoveredModel[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((line) => {
      const parts = line.split(/\s+/);
      const id = parts[0];
      const label = parts.slice(1).join(' ') || id;
      return { modelId: id, modelLabel: label, runnerProvider: id.includes('/') ? id.split('/')[0] : undefined, variants: [] };
    });
}

/**
 * @internal Per-runner executor-model discovery. This is the *implementation*
 * behind ModelResolver, not part of the public package API — construct it only
 * through ModelResolver (see CONTEXT.md "ModelResolver"). The resolver owns the
 * cache lifecycle via `discover()` + `clear()`.
 */
export class ModelDiscovery {
  private cache: Map<string, DiscoveredModel[]> = new Map();
  /**
   * Degraded results (a fallback list, or empty) remembered for
   * {@link NEGATIVE_TTL_MS}. They are deliberately not cached — a transient
   * failure must heal — but re-running a failing CLI on every lookup is the
   * other extreme.
   */
  private misses: Map<string, { models: DiscoveredModel[]; at: number }> = new Map();
  /**
   * Discoveries still running, so a second lookup of the same runner joins the
   * first instead of spawning the CLI again. A slow CLI is the case this
   * exists for: a planner switch and a runner-list refresh land inside one
   * another's wait, and two `opencode models` calls race each other for the
   * same background service.
   */
  private inflight: Map<string, Promise<DiscoveredModel[]>> = new Map();
  /**
   * Why a runner's last discovery listed nothing, where the runner said: a
   * surface shows the way to sign in rather than an empty list that a refresh
   * cannot fill (ADR-0060, R9).
   */
  private unlisted: Map<string, Exclude<UnlistedReason, 'pending'>> = new Map();
  /** The credential hook's own refusal, for a runner unlisted as `no-credential`. */
  private refusals: Map<string, string> = new Map();
  /** Bumped by every `clear()`: a discovery begun before one answers its own lookups but fills no cache. */
  private generation = 0;
  /** Bumped per runner by {@link forget}, as `generation` is for every runner. */
  private forgotten: Map<string, number> = new Map();
  private registry: RunnerRegistry;
  private execImpl: ExecImpl;
  private fetchImpl?: typeof fetch;
  private appServerClient: AppServerClientImpl;
  private acpClient: AcpClientImpl;
  private readFileImpl: (path: string) => string | null;
  private now: () => number;
  private env: () => Promise<RunnerEnv>;
  private workspace: () => string | undefined;

  constructor(
    registry: RunnerRegistry,
    execImpl: ExecImpl = defaultExec,
    fetchImpl?: typeof fetch,
    appServerClient: AppServerClientImpl = defaultAppServerClient,
    readFileImpl?: (path: string) => string | null,
    now: () => number = Date.now,
    env: () => Promise<RunnerEnv> = async () => process.env,
    acpClient: AcpClientImpl = defaultAcpClient,
    /** The workspace whose account `env` is, under which an ACP answer is recorded as the sign-in verdict (ADR-0052). */
    workspace: () => string | undefined = () => undefined,
  ) {
    this.workspace = workspace;
    this.registry = registry;
    this.execImpl = execImpl;
    this.fetchImpl = fetchImpl;
    this.appServerClient = appServerClient;
    this.acpClient = acpClient;
    this.now = now;
    this.env = env;
    this.readFileImpl = readFileImpl ?? ((filePath: string) => {
      try {
        const file = expandRunnerHome(filePath);
        return file ? fsSync.readFileSync(file, 'utf8') : null;
      } catch {
        return null;
      }
    });
  }

  /**
   * App-server discovery chain (ADR-0004): live `model/list` over stdio
   * JSON-RPC first, the runner's own on-disk catalog cache second. Returns
   * null when both fail so `discover()` falls through to the remaining
   * methods.
   */
  private async discoverFromAppServer(manifest: RunnerManifest, env: RunnerEnv): Promise<DiscoveredModel[] | null> {
    const config = manifest.modelDiscovery.appServer;
    if (!config) return null;

    const raw = await this.appServerClient(config.command, config.args, { env });
    if (raw) {
      const models = parseAppServerModels(raw);
      if (models.length > 0) return models;
    }

    const cacheFile = config.cacheFile && expandRunnerHome(typeof config.cacheFile === 'function' ? config.cacheFile(env) : config.cacheFile, env);
    if (cacheFile) {
      const content = this.readFileImpl(cacheFile);
      if (content) {
        const models = parseCodexModelsCache(content);
        if (models.length > 0) return models;
      }
    }

    return null;
  }

  /**
   * Every model this runner offers, each stamped with the runner it came from.
   * The stamp lives here rather than in the parsers because this is the only
   * place that knows both — a parser sees output, not which agent produced it.
   */
  async discover(runner: string): Promise<DiscoveredModel[]> {
    const models = await this.discoverRaw(runner);
    const manifest = this.registry.getManifest(runner);
    if (!manifest) return models;
    const runnerLabel = manifest.displayName || runner;
    return models.map((m) => ({ ...m, runnerId: runner, runnerLabel }));
  }

  private discoverRaw(runner: string): Promise<DiscoveredModel[]> {
    const cached = this.cache.get(runner);
    if (cached) return Promise.resolve(cached);

    const remembered = this.misses.get(runner);
    if (remembered && this.now() - remembered.at < NEGATIVE_TTL_MS) return Promise.resolve(remembered.models);

    const running = this.inflight.get(runner);
    if (running) return running;

    const started = this.discoverUncached(runner).finally(() => {
      // A `clear()` while this ran already dropped the entry, and a newer
      // lookup may have registered its own — only remove ours.
      if (this.inflight.get(runner) === started) this.inflight.delete(runner);
    });
    this.inflight.set(runner, started);
    return started;
  }

  private async discoverUncached(runner: string): Promise<DiscoveredModel[]> {
    const manifest = this.registry.getManifest(runner);
    if (!manifest) {
      return [];
    }

    const generation = this.generation;
    const forgotten = this.forgotten.get(runner) ?? 0;
    // Captured as the ask begins: the folder can move while the agent answers,
    // and a login or recheck since makes its answer stale (ADR-0052).
    const workspace = this.workspace();
    const asOf = runnerAuthClock();
    // Every runner is asked under the environment it is launched with: its
    // account, its home and its own files can all move with it.
    const env = await this.env().catch(() => process.env);
    const found = await this.discoverFromSources(manifest, env);
    const models = this.withSettingsModels(found.models, manifest, env);
    this.recordSignIn(manifest, found.acp, workspace, asOf);
    // Asked before a refresh: what the runner says now is the next lookup's to learn.
    if (generation !== this.generation || forgotten !== (this.forgotten.get(runner) ?? 0)) return models;
    this.refusals.delete(runner);
    if (models.length > 0 || found.acp?.kind === 'signed-in') this.unlisted.delete(runner);
    // With no handshake to say why: a cacheable answer is the runner's own
    // complete, empty catalog; any other is a degraded one, which says nothing.
    else if (!found.acp) this.unlisted.set(runner, found.cacheable ? 'no-models' : 'no-answer');
    else {
      this.unlisted.set(runner, found.acp.kind);
      if (found.acp.kind === 'no-credential' && found.acp.refused) this.refusals.set(runner, found.acp.refused);
    }
    if (found.cacheable && models.length > 0) this.cache.set(runner, models);
    else this.misses.set(runner, { models, at: this.now() });
    return models;
  }

  /**
   * What discovery's own ACP handshake says of the sign-in, recorded as a
   * turn's would be (#46 F5): an auth-required answer or a hook with no key
   * is signed out, and a session the agent opened is signed in. An ask that
   * got no answer says nothing.
   */
  private recordSignIn(manifest: RunnerManifest, acp: AcpOutcome | undefined, workspace: string | undefined, asOf: number): void {
    if (!acp || acp.kind === 'no-answer') return;
    const options = { source: 'discovery' as const, asOf };
    if (acp.kind === 'signed-in' || acp.kind === 'no-choice') recordRunnerAuth(manifest.name, { state: 'signed-in' }, workspace, options);
    else recordRunnerAuth(manifest.name, signedOutAuth(runnerSignIn(manifest), acp.kind === 'no-credential' ? 'no provider key' : undefined), workspace, options);
  }

  private async discoverFromSources(manifest: RunnerManifest, env: RunnerEnv): Promise<{ models: DiscoveredModel[]; cacheable: boolean; acp?: AcpOutcome }> {
    let cacheable = true;
    let acp: AcpOutcome | undefined;
    const discovery = manifest.modelDiscovery;

    // An in-process runner (ADR-0070) offers its own provider's catalog, on
    // the key the host holds for it too. A listing that failed offers nothing
    // this time, and is not cached behind a key that works on the next lookup.
    if (discovery.method === 'providers') {
      const provider = inProcessProvider(manifest);
      const models = provider ? await discoverProviderModels(withHostCredentials(env), provider, this.fetchImpl) : [];
      return { models, cacheable: models.length > 0 };
    }

    // 0. App-server JSON-RPC discovery (Codex). Live catalog first, the
    //    runner's own cache file second; falls through on total failure.
    if (discovery.appServer) {
      const appServerModels = await this.discoverFromAppServer(manifest, env);
      if (appServerModels && appServerModels.length > 0) return { models: appServerModels, cacheable: true };
      // Both live and cache-file sources failed — whatever the remaining
      // methods produce is a degraded fallback; don't cache it, so a
      // transient failure heals on the next lookup.
      cacheable = false;
    }

    // 0b. ACP discovery: the agent's own session options. A signed-out or
    //     silent agent offers nothing; the remaining methods answer instead.
    if (discovery.method === 'acp' && discovery.acp) {
      const started = await acpStartEnv(discovery.acp, env);
      const command = runnerCommand(manifest);
      const answer = 'env' in started && command ? await this.acpClient(command, discovery.acp.args, { env: started.env }) : null;
      if (Array.isArray(answer) && answer.length > 0) return { models: mergeCanonicalAliases(answer, manifest), cacheable: true, acp: { kind: 'signed-in' } };
      // No answer (signed out, timeout, failed start) is transient and must
      // not be cached behind a working fallback; an agent that answered with
      // no model choice is a stable answer, so the fallback may be cached.
      if (!Array.isArray(answer)) cacheable = false;
      acp = 'refused' in started ? { kind: 'no-credential', refused: started.refused }
        : answer === 'signed-out' ? { kind: 'signed-out' }
          : Array.isArray(answer) ? { kind: 'no-choice' } : { kind: 'no-answer' };
    }

    // 1. Try API discovery first (e.g. Anthropic Models API for Claude Code).
    //    Returns null when no auth token is available or the request fails —
    //    in both cases we fall through to command-based discovery.
    if (discovery.apiDiscovery) {
      const apiModels = await discoverFromApi(manifest, discovery.apiDiscovery, env, this.fetchImpl);
      if (apiModels && apiModels.length > 0) {
        return { models: applyVariants(mergeCanonicalAliases(apiModels, manifest), manifest), cacheable, acp };
      }
    }

    // 2. Command-based discovery (CLI subcommand or --help parsing).
    if ((discovery.method === 'command' || discovery.method === 'acp') && (discovery.command || discovery.discoveryCommands?.length)) {
      const result = await discoverFromCommand(manifest, this.execImpl, env);
      // A fallback-only result means the CLI wasn't reachable — don't cache
      // it, so a transient failure (PATH, network, cold start) heals on the
      // next lookup instead of persisting until an explicit refresh.
      return { models: result.models, cacheable: cacheable && !result.fromFallback, acp };
    }
    return { models: buildFallbackModels(manifest), cacheable, acp };
  }

  /**
   * Append the models registered in the runner's own settings. Read on every
   * discovery rather than cached apart, so a refresh picks up an edit;
   * whatever the sources already offer keeps its entry and metadata.
   */
  private withSettingsModels(models: DiscoveredModel[], manifest: RunnerManifest, env: RunnerEnv): DiscoveredModel[] {
    const read = manifest.modelDiscovery.settingsModels;
    if (!read) return models;
    const files: RunnerSettingsFiles = {
      read: (filePath) => {
        const file = expandRunnerHome(filePath, env);
        return file ? this.readFileImpl(file) : null;
      },
      list: (dir) => {
        const expanded = expandRunnerHome(dir, env);
        return expanded ? listDir(expanded) : [];
      },
      env,
    };
    const seen = new Set(models.map((m) => m.modelId));
    const added = read(files).filter((m) => !seen.has(m.modelId));
    return added.length > 0 ? [...models, ...applyVariants(added, manifest)] : models;
  }

  clear(): void {
    this.generation++;
    this.cache.clear();
    this.misses.clear();
    this.unlisted.clear();
    this.refusals.clear();
    // A refresh asks again at once; it must not join a run that began before it.
    this.inflight.clear();
  }

  /**
   * Forget one runner's catalog and why it listed nothing, so its next lookup
   * asks it again: a user's recheck of its sign-in (ADR-0052), never a
   * periodic refresh, which leaves a catalog cached until `clear()`.
   */
  forget(runner: string): void {
    this.forgotten.set(runner, (this.forgotten.get(runner) ?? 0) + 1);
    this.cache.delete(runner);
    this.misses.delete(runner);
    this.unlisted.delete(runner);
    this.refusals.delete(runner);
    this.inflight.delete(runner);
  }

  /**
   * Why each runner whose last discovery listed nothing did, where it is
   * known, and `pending` for one still being asked with nothing held; never
   * triggers discovery.
   */
  whyUnlisted(): Record<string, UnlistedReason> {
    const why: Record<string, UnlistedReason> = Object.fromEntries(this.unlisted);
    for (const runner of this.inflight.keys()) if (!this.cache.has(runner)) why[runner] = 'pending';
    return why;
  }

  /** The credential hook's own refusal for a runner unlisted as `no-credential`, credential-free by its type. */
  credentialRefusal(runner: string): string | undefined {
    return this.refusals.get(runner);
  }

  /** Whatever `discover()` has already cached for `runner` — never triggers discovery. */
  getCached(runner: string): DiscoveredModel[] | undefined {
    return this.cache.get(runner);
  }
}
