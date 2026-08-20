import * as path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fsSync from 'fs';
import * as osMod from 'os';
import { DiscoveredModel } from '../models/Task';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type { RunnerPluginManifest, DiscoveryCommand, ApiDiscoveryConfig, ApiAuthMethod } from '../plugins/types';
import { augmentedPath, withPath } from '../utils/shellPath';
import { globalDataDir } from '../utils/globalDataDir';
import { planDirectLaunch } from '../utils/launch';
import { killTree } from '../utils/processTree';

const execAsync = promisify(exec);

/**
 * Injectable command runner. Defaults to the real `child_process` exec wrapper;
 * tests pass a fake so discovery never spawns a process.
 */
export type ExecImpl = (
  command: string,
  options?: { timeout?: number }
) => Promise<{ stdout: string }>;

// Discovery must find `claude`/`opencode` wherever the user installed them,
// even when the host process (GUI-launched VS Code, service-launched web
// server) inherits a minimal PATH — hence the augmented PATH.
const defaultExec: ExecImpl = async (command, options) => {
  const PATH = await augmentedPath();
  // `opencode models --verbose` emits a JSON block per model and grows with
  // every provider the user enables (~0.5MB with three providers today);
  // node's default 1MB maxBuffer would kill the child mid-stream and silently
  // degrade discovery to the variant-less plain parser.
  const { stdout } = await execAsync(command, { ...options, maxBuffer: 32 * 1024 * 1024, env: withPath(process.env, PATH) });
  return { stdout: String(stdout) };
};

/**
 * One raw model entry from an app-server `model/list` response (Codex's stdio
 * JSON-RPC protocol). Field names are the protocol's, not Ordewell's.
 */
export interface AppServerModel {
  id: string;
  displayName?: string;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[];
}

/**
 * Injectable app-server JSON-RPC client: spawn the command, drive
 * `initialize` → `model/list` over stdio, return the raw model list. Returns
 * null on any failure (spawn error, timeout, malformed response) so discovery
 * falls through to the on-disk cache file. Tests inject a fake so discovery
 * never spawns a real app-server.
 */
export type AppServerClientImpl = (
  command: string,
  args: string[],
  options?: { timeout?: number }
) => Promise<AppServerModel[] | null>;

const defaultAppServerClient: AppServerClientImpl = async (command, args, options) => {
  const PATH = await augmentedPath();
  // No shell here, so on Windows the command has to be resolved against
  // PATHEXT first — `codex` alone is a `.cmd` shim that CreateProcess cannot
  // start. A resolution failure returns the command unchanged, and the spawn's
  // own error still routes discovery to the on-disk cache.
  const launch = await planDirectLaunch(command, args).catch(() => null);
  if (!launch) return null;
  return new Promise((resolve) => {
    let child: import('child_process').ChildProcess;
    try {
      child = spawn(launch.file, launch.args, {
        env: withPath(process.env, PATH),
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsVerbatimArguments: launch.verbatim,
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: AppServerModel[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Tree-wide, for the same reason every other dispose path is: when
      // `codex` resolved to a shim the direct child is the interpreter, and
      // killing it leaves the app-server alive — holding its port, and
      // outliving the discovery call that started it.
      killTree(child);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), options?.timeout ?? 20000);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));

    let buffer = '';
    const send = (id: number, method: string, params: unknown) => {
      try {
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch {
        finish(null);
      }
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let msg: { id?: number; result?: { data?: AppServerModel[] } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          send(2, 'model/list', {});
        } else if (msg.id === 2) {
          finish(Array.isArray(msg.result?.data) ? msg.result!.data! : null);
        }
      }
    });
    send(1, 'initialize', { clientInfo: { name: 'ordewell', title: 'Ordewell', version: '0.1.0' } });
  });
};

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

interface GeminiApiModel {
  name: string;
  displayName: string;
  supportedGenerationMethods?: string[];
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

function applyVariants(models: DiscoveredModel[], manifest: RunnerPluginManifest): DiscoveredModel[] {
  const variants = manifest.modelDiscovery.variants;
  if (!variants || variants.length === 0) return models;
  // Only fill in models whose variants are empty (e.g. --help parsing or
  // canonical-alias fallback). Models that already carry per-model variants
  // from the API must keep them — the static list is a fallback, not an override.
  return models.map((m) => (m.variants.length > 0 ? m : { ...m, variants }));
}

/**
 * Resolve an auth token from a manifest's `apiDiscovery.auth` list. Each method
 * is tried in order; the first that yields a non-empty token wins.
 *
 * - `env`: reads `process.env[varName]`
 * - `file`: reads a JSON file at `path` (with `~` expansion) and extracts the
 *   value at `jsonPath` (dot-notation, e.g. `claudeAiOauth.accessToken`)
 *
 * Returns `{ header, value }` ready to set on the fetch `headers` object, or
 * `null` when no auth method yields a token.
 */
function resolveApiAuth(authMethods: ApiAuthMethod[]): { header: string; value: string } | null {
  for (const method of authMethods) {
    try {
      let token: string | undefined;
      if (method.type === 'env') {
        token = process.env[method.varName];
      } else {
        const filePath = method.path.replace(/^~/, osMod.homedir());
        if (!fsSync.existsSync(filePath)) continue;
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
  config: ApiDiscoveryConfig,
  fetchImpl?: typeof fetch
): Promise<DiscoveredModel[] | null> {
  const auth = resolveApiAuth(config.auth);
  if (!auth) return null;

  try {
    const headers: Record<string, string> = { ...config.headers, [auth.header]: auth.value };
    const response = await (fetchImpl ?? fetch)(config.url, { headers });
    if (!response.ok) return null;
    const data = await response.json();
    const text = JSON.stringify(data);
    return parseModelOutput(text, config.parser, {} as RunnerPluginManifest);
  } catch {
    return null;
  }
}

/**
 * Parse the Anthropic Models API response (`GET /v1/models`). The API returns
 * full model IDs (e.g. `claude-haiku-4-5-20251001`) sorted most-recent first.
 * We derive the short family alias (`haiku`, `opus`, `sonnet`, `fable`) that
 * the Claude Code CLI's `--model` flag accepts, deduplicating by family to
 * keep only the latest (first in the API's ordering).
 *
 * Per-model thinking variants come from two independent capabilities:
 * `capabilities.thinking.types.adaptive` (the model reasons without being told
 * how hard) and `capabilities.effort.{level}` (the rungs `--effort` accepts).
 * They are read separately because they are separate axes — the current model
 * line reports `thinking.types.enabled: false` alongside all five effort rungs,
 * so treating `enabled` as the gate for effort hid every rung on exactly the
 * models a user is most likely to plan with. A model with no capabilities gets
 * an empty variants array — the caller's static fallback fills in only when
 * variants are empty (see `applyVariants`).
 */
const ANTHROPIC_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const ANTHROPIC_VARIANT_LABELS: Record<string, string> = {
  adaptive: 'Adaptive',
  low: 'Low effort',
  medium: 'Medium effort',
  high: 'High effort',
  xhigh: 'Extra high effort',
  max: 'Max effort',
};

function anthropicCapabilitiesToVariants(
  caps?:
    | {
        thinking?: {
          supported?: boolean;
          types?: {
            adaptive?: { supported?: boolean };
            enabled?: { supported?: boolean };
          };
        };
        effort?: {
          supported?: boolean;
          low?: { supported?: boolean };
          medium?: { supported?: boolean };
          high?: { supported?: boolean };
          xhigh?: { supported?: boolean };
          max?: { supported?: boolean };
        };
      }
    | undefined,
): { id: string; label: string }[] {
  const variants: { id: string; label: string }[] = [];
  if (caps?.thinking?.supported && caps.thinking.types?.adaptive?.supported) {
    variants.push({ id: 'adaptive', label: ANTHROPIC_VARIANT_LABELS.adaptive });
  }
  if (caps?.effort?.supported) {
    for (const level of ANTHROPIC_EFFORT_LEVELS) {
      if (caps.effort[level]?.supported) {
        variants.push({ id: level, label: ANTHROPIC_VARIANT_LABELS[level] });
      }
    }
  }
  return variants;
}

function parseAnthropicModels(stdout: string): DiscoveredModel[] {
  try {
    const data = JSON.parse(stdout) as {
      data?: Array<{
        id: string;
        display_name?: string;
        capabilities?: Parameters<typeof anthropicCapabilitiesToVariants>[0];
      }>;
    };
    const models = data.data;
    if (!Array.isArray(models)) return [];

    const seen = new Set<string>();
    const result: DiscoveredModel[] = [];

    for (const m of models) {
      if (!m.id || typeof m.id !== 'string') continue;
      if (!m.id.startsWith('claude-')) continue;
      const segments = m.id.split('-');
      const family = segments[1];
      if (!family || !['opus', 'sonnet', 'haiku', 'fable'].includes(family)) continue;
      if (seen.has(family)) continue;
      seen.add(family);
      const label = m.display_name || family.charAt(0).toUpperCase() + family.slice(1);
      result.push({
        modelId: family,
        modelLabel: label,
        runnerProvider: 'anthropic',
        variants: anthropicCapabilitiesToVariants(m.capabilities),
      });
    }

    return result;
  } catch {
    return [];
  }
}

async function discoverFromCommand(manifest: RunnerPluginManifest, execImpl: ExecImpl): Promise<{ models: DiscoveredModel[]; fromFallback: boolean }> {
  const discovery = manifest.modelDiscovery;
  const commands: DiscoveryCommand[] = discovery.discoveryCommands ?? [
    { command: discovery.command!, args: discovery.args || [], parser: discovery.parser || 'line-by-line' },
  ];

  const runCommands = async (): Promise<DiscoveredModel[] | null> => {
    for (const cmd of commands) {
      try {
        // Generous timeout: a cold runner CLI may spawn its server, install
        // plugins, and fetch its catalog on first invocation after boot.
        const { stdout } = await execImpl(`${cmd.command} ${cmd.args.join(' ')}`, { timeout: 45000 });
        const models = parseModelOutput(stdout, cmd.parser || 'line-by-line', manifest);
        if (models.length > 0) return applyVariants(mergeCanonicalAliases(models, manifest), manifest);
      } catch { /* try next command */ }
    }
    return null;
  };

  // First pass. If every command timed out or came back empty, the CLI was
  // likely cold — it just spawned its server and hadn't fetched its catalog
  // yet. Retry once (the server is now warm) before degrading to the manifest
  // fallback, so a cold start never silently produces a short/empty list.
  const first = await runCommands();
  if (first) return { models: first, fromFallback: false };
  const second = await runCommands();
  if (second) return { models: second, fromFallback: false };

  return { models: applyVariants(buildFallbackModels(manifest), manifest), fromFallback: true };
}

/**
 * Merge `manifest.modelDiscovery.canonicalAliases` into a successful discovery
 * result. Discovered models take precedence (they reflect the installed CLI);
 * any canonical alias NOT already present is appended, so stable `--model`
 * contracts that the CLI's help text omits (e.g. Claude's 'haiku') are always
 * offered. Only applies when `canonicalAliases` is declared.
 */
function mergeCanonicalAliases(discovered: DiscoveredModel[], manifest: RunnerPluginManifest): DiscoveredModel[] {
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

function buildFallbackModels(manifest: RunnerPluginManifest): DiscoveredModel[] {
  // Prefer canonicalAliases (stable CLI contracts, e.g. Claude's opus/sonnet/
  // haiku) when declared; fall back to the generic fallbackModels list for
  // user plugins that have no canonical alias concept.
  const list = manifest.modelDiscovery.canonicalAliases ?? manifest.modelDiscovery.fallbackModels ?? [];
  return list.map((m) => ({
    modelId: m.modelId,
    modelLabel: m.modelLabel,
    runnerProvider: m.modelId.includes('/') ? m.modelId.split('/')[0] : undefined,
    variants: manifest.modelDiscovery.variants || [],
  }));
}

function parseModelOutput(stdout: string, parser: string, manifest: RunnerPluginManifest): DiscoveredModel[] {
  switch (parser) {
    case 'claude-help':
      return parseClaudeHelp(stdout);
    case 'opencode-models':
      return parseOpencodeModels(stdout, manifest);
    case 'opencode-models-verbose':
      return parseOpencodeModelsVerbose(stdout, manifest);
    case 'anthropic-models':
      return parseAnthropicModels(stdout);
    case 'line-by-line':
      return parseLineByLine(stdout);
    case 'json':
      return parseJson(stdout, manifest);
    case 'json-table':
      return parseJsonTable(stdout);
    default:
      return parseLineByLine(stdout);
  }
}

function parseClaudeHelp(stdout: string): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();

  const extractIds = (text: string) => {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const words = trimmed.split(/\s+/);
      for (const w of words) {
        const cleaned = w.replace(/[",()]/g, '');
        if (cleaned.length < 5) continue;
        if (cleaned.includes('-') && cleaned.length > 10 && !seen.has(cleaned)) {
          seen.add(cleaned);
          let label = cleaned.replace(/-20\d{6}/, '').replace(/-/g, ' ');
          label = label.replace(/\b\w/g, (c) => c.toUpperCase());
          if (cleaned.includes('sonnet')) label = 'Sonnet';
          else if (cleaned.includes('opus')) label = 'Opus';
          else if (cleaned.includes('haiku')) label = 'Haiku';
          models.push({ modelId: cleaned, modelLabel: label, variants: [] });
        }
      }
    }
  };

  // Prefer an explicit enumeration of model IDs when present, e.g.
  //   --model <model>   Available values: claude-opus-..., claude-sonnet-...
  const modelMatch = stdout.match(/--model\s+<model>\s+(?:.*?\n)*?\s*(?:Available|valid)(?:\s+values?|:\s*options?)\s*:\s*([\s\S]*?)(?:\n\s*\n|$)/i);

  if (modelMatch) {
    extractIds(modelMatch[1]);
  }
  if (models.length > 0) return models;

  // Modern `claude --help` describes --model in prose with quoted example
  // aliases: "Provide an alias for the latest model (e.g. 'fable', 'opus', or
  // 'sonnet') or a model's full name (e.g. 'claude-fable-5')." Those aliases
  // are the CLI's own contract for what --model accepts, so they ARE the model
  // list — extracted from the installed binary, never hardcoded here.
  // The option block: the `--model` line plus its indented continuation lines
  // (a line whose first non-space char is `-` starts the next option).
  const optionBlock = stdout.match(/--model\s+<model>[^\n]*(?:\n(?!\s*-)[^\n]*)*/);
  if (optionBlock) {
    const quoted = [...optionBlock[0].matchAll(/'([a-z][a-z0-9._/-]*)'/gi)].map((m) => m[1]);
    // Aliases (no separator, e.g. 'opus') resolve to the latest model of their
    // family and are always valid; full-name examples (e.g. 'claude-fable-5')
    // duplicate an alias, so only use them when no alias was found.
    const aliases = quoted.filter((q) => /^[a-z][a-z0-9]{2,19}$/.test(q));
    const chosen = aliases.length > 0 ? aliases : quoted.filter((q) => q.length >= 5);
    for (const id of chosen) {
      if (seen.has(id)) continue;
      seen.add(id);
      const label = id.replace(/-20\d{6}$/, '').split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      models.push({ modelId: id, modelLabel: label, variants: [] });
    }
  }

  return models;
}

function parseOpencodeModels(stdout: string, manifest: RunnerPluginManifest): DiscoveredModel[] {
  // The CLI output is the source of truth: accept ANY `provider/model` line
  // (custom providers included) rather than a hand-listed charset. Structure
  // required: a plain provider segment (no colon — excludes URLs), a slash,
  // and a whitespace-free remainder.
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z0-9._-]+\/[^\s"{}]+$/.test(l));
  if (lines.length === 0) return [];

  const preferred = manifest.modelDiscovery.preferredPatterns;
  const prefLabels = new Map<string, string>();
  if (preferred) {
    for (const { id, label } of preferred) {
      prefLabels.set(id, label);
    }
  }

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];

  for (const id of lines) {
    if (prefLabels.has(id) && !seen.has(id)) {
      seen.add(id);
      const provider = id.split('/')[0];
      models.push({ modelId: id, modelLabel: prefLabels.get(id)!, runnerProvider: provider, variants: [] });
    }
  }

  for (const id of lines) {
    if (!seen.has(id)) {
      seen.add(id);
      const provider = id.split('/')[0];
      models.push({ modelId: id, modelLabel: id.split('/').pop() || id, runnerProvider: provider, variants: [] });
    }
  }

  return models;
}

/**
 * Parse `opencode models --verbose` output.
 *
 * The format alternates between a `provider/model-id` line and a JSON block:
 *   opencode/claude-sonnet-4-6
 *   { "id": "claude-sonnet-4-6", ... "variants": { "low": {...}, "high": {...} } }
 *   opencode-go/deepseek-v4-pro
 *   { ... "variants": {} }
 *
 * Per-model variants are extracted directly from the JSON; models with no
 * variants get an empty array (the old static manifest variants are NOT applied).
 */
function parseOpencodeModelsVerbose(stdout: string, manifest: RunnerPluginManifest): DiscoveredModel[] {
  // Ensure trailing newline so the last model-id line is always captured by the split regex.
  // The CLI output is the source of truth: accept ANY `provider/model` id line
  // (custom providers, uppercase, version pins, multi-segment models). The only
  // structure required is a plain provider segment (no colon — excludes URLs)
  // followed by a whitespace-free remainder; JSON block lines never match
  // because they start with `{`, `}`, `"` or indentation.
  const normalized = stdout.endsWith('\n') ? stdout : stdout + '\n';
  const parts = normalized.split(/^([A-Za-z0-9._-]+\/[^\s"{}]+)\n/m);

  const preferred = manifest.modelDiscovery.preferredPatterns;
  const prefLabels = new Map<string, string>();
  if (preferred) {
    for (const { id, label } of preferred) prefLabels.set(id, label);
  }

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];

  for (let i = 1; i < parts.length - 1; i += 2) {
    const fullId = parts[i].trim();
    const jsonText = parts[i + 1].trim();
    if (seen.has(fullId)) continue;

    let variantIds: string[] = [];
    let modelLabel = prefLabels.get(fullId) || fullId.split('/').pop() || fullId;
    // The provider IS the printed prefix before the first `/` — exactly as
    // the CLI lists it (`opencode/…`, `opencode-go/…`, `openrouter/…`, or any
    // future provider). The JSON's providerID never overrides it.
    const runnerProvider = fullId.split('/')[0];

    try {
      const data = JSON.parse(jsonText) as {
        name?: string;
        variants?: Record<string, unknown>;
      };
      if (data.name) modelLabel = prefLabels.get(fullId) || data.name;
      variantIds = Object.keys(data.variants ?? {});
    } catch {
      // No parseable JSON block — keep the id-derived label, no variants.
    }

    seen.add(fullId);
    models.push({
      modelId: fullId,
      modelLabel,
      runnerProvider,
      variants: variantIds.map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) })),
    });
  }

  if (models.length === 0) return [];

  // Put preferred patterns first, then the rest alphabetically
  const prefOrder = preferred?.map((p) => p.id) ?? [];
  models.sort((a, b) => {
    const ai = prefOrder.indexOf(a.modelId);
    const bi = prefOrder.indexOf(b.modelId);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.modelId.localeCompare(b.modelId);
  });

  return models;
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

function parseJson(stdout: string, manifest: RunnerPluginManifest): DiscoveredModel[] {
  try {
    let data = JSON.parse(stdout);
    const jsonPath = manifest.modelDiscovery.jsonPath;
    if (jsonPath) {
      for (const key of jsonPath.split('.')) {
        if (data && typeof data === 'object') {
          data = (data as Record<string, unknown>)[key];
        }
      }
    }
    const arr = Array.isArray(data) ? data : [];
    return arr.map((item: unknown) => {
      if (typeof item === 'string') {
        const id = item;
        return { modelId: id, modelLabel: id, runnerProvider: id.includes('/') ? id.split('/')[0] : undefined, variants: [] };
      }
      if (typeof item === 'object' && item !== null) {
        const obj = item as Record<string, unknown>;
        const modelId = String(obj.id || obj.modelId || obj.model || '');
        return {
          modelId,
          modelLabel: String(obj.label || obj.name || obj.modelLabel || obj.id || ''),
          runnerProvider: modelId.includes('/') ? modelId.split('/')[0] : undefined,
          variants: [],
        };
      }
      const id = String(item);
      return { modelId: id, modelLabel: id, runnerProvider: id.includes('/') ? id.split('/')[0] : undefined, variants: [] };
    });
  } catch {
    return [];
  }
}

function parseJsonTable(stdout: string): DiscoveredModel[] {
  try {
    const data = JSON.parse(stdout);
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const outer = Object.values(data)[0];
      const arr = Array.isArray(outer) ? outer : [];
      return arr.map((item: unknown) => {
        if (typeof item === 'string') {
          const id = item;
          return { modelId: id, modelLabel: id, runnerProvider: id.includes('/') ? id.split('/')[0] : undefined, variants: [] };
        }
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>;
          const modelId = String(obj.id || obj.modelId || obj.model || '');
          return {
            modelId,
            modelLabel: String(obj.label || obj.name || obj.modelLabel || obj.id || ''),
            runnerProvider: modelId.includes('/') ? modelId.split('/')[0] : undefined,
            variants: [],
          };
        }
        const id = String(item);
        return { modelId: id, modelLabel: id, runnerProvider: id.includes('/') ? id.split('/')[0] : undefined, variants: [] };
      });
    }
  } catch { /* fall through */ }
  return [];
}

/**
 * @internal Per-runner executor-model discovery. This is the *implementation*
 * behind ModelResolver, not part of the public package API — construct it only
 * through ModelResolver (see CONTEXT.md "ModelResolver"). The resolver owns the
 * cache lifecycle via `discover()` + `clear()`.
 */
export class ModelDiscovery {
  private cache: Map<string, DiscoveredModel[]> = new Map();
  private registry: RunnerRegistry;
  private execImpl: ExecImpl;
  private fetchImpl?: typeof fetch;
  private appServerClient: AppServerClientImpl;
  private readFileImpl: (path: string) => string | null;

  constructor(
    registry: RunnerRegistry,
    execImpl: ExecImpl = defaultExec,
    fetchImpl?: typeof fetch,
    appServerClient: AppServerClientImpl = defaultAppServerClient,
    readFileImpl?: (path: string) => string | null,
  ) {
    this.registry = registry;
    this.execImpl = execImpl;
    this.fetchImpl = fetchImpl;
    this.appServerClient = appServerClient;
    this.readFileImpl = readFileImpl ?? ((filePath: string) => {
      try {
        return fsSync.readFileSync(filePath.replace(/^~/, osMod.homedir()), 'utf8');
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
  private async discoverFromAppServer(manifest: RunnerPluginManifest): Promise<DiscoveredModel[] | null> {
    const config = manifest.modelDiscovery.appServer;
    if (!config) return null;

    const raw = await this.appServerClient(config.command, config.args);
    if (raw) {
      const models = parseAppServerModels(raw);
      if (models.length > 0) return models;
    }

    if (config.cacheFile) {
      const content = this.readFileImpl(config.cacheFile);
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

  private async discoverRaw(runner: string): Promise<DiscoveredModel[]> {
    if (this.cache.has(runner)) {
      return this.cache.get(runner)!;
    }

    const manifest = this.registry.getManifest(runner);
    if (!manifest) {
      return [];
    }

    let models: DiscoveredModel[];
    let cacheable = true;
    const discovery = manifest.modelDiscovery;

    // 0. App-server JSON-RPC discovery (Codex). Live catalog first, the
    //    runner's own cache file second; falls through on total failure.
    if (discovery.appServer) {
      const appServerModels = await this.discoverFromAppServer(manifest);
      if (appServerModels && appServerModels.length > 0) {
        this.cache.set(runner, appServerModels);
        return appServerModels;
      }
      // Both live and cache-file sources failed — whatever the remaining
      // methods produce is a degraded fallback; don't cache it, so a
      // transient failure heals on the next lookup.
      cacheable = false;
    }

    // 1. Try API discovery first (e.g. Anthropic Models API for Claude Code).
    //    Returns null when no auth token is available or the request fails —
    //    in both cases we fall through to command-based discovery.
    if (discovery.apiDiscovery) {
      const apiModels = await discoverFromApi(discovery.apiDiscovery, this.fetchImpl);
      if (apiModels && apiModels.length > 0) {
        models = applyVariants(mergeCanonicalAliases(apiModels, manifest), manifest);
        if (cacheable && models.length > 0) this.cache.set(runner, models);
        return models;
      }
    }

    // 2. Command-based discovery (CLI subcommand or --help parsing).
    if (discovery.method === 'command' && (discovery.command || discovery.discoveryCommands?.length)) {
      const result = await discoverFromCommand(manifest, this.execImpl);
      models = result.models;
      // A fallback-only result means the CLI wasn't reachable — don't cache
      // it, so a transient failure (PATH, network, cold start) heals on the
      // next lookup instead of persisting until an explicit refresh.
      cacheable = !result.fromFallback;
    } else {
      models = buildFallbackModels(manifest);
    }

    if (cacheable && models.length > 0) this.cache.set(runner, models);
    return models;
  }

  clear(): void {
    this.cache.clear();
  }

  /** Whatever `discover()` has already cached for `runner` — never triggers discovery. */
  getCached(runner: string): DiscoveredModel[] | undefined {
    return this.cache.get(runner);
  }
}
