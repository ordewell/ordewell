import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { AiProvider } from '../interfaces/IConfig';
import type { CatalogModel } from './ModelCatalog';
import { globalDataDir } from '../utils/globalDataDir';
import snapshotJson from './modelDetailsSnapshot.json';

/**
 * What models.dev knows about a model that a provider's own `/models` listing
 * does not say: window, reply cap, prices, tool calling, reasoning. The
 * provider's listing decides which models exist; this only describes them.
 *
 * Two sources serve it, newest first: the cache under Ordewell's data
 * directory (refreshed in the background at most once a day), and the snapshot
 * bundled with the build, trimmed to the providers in apiProviders.ts, which
 * serves offline and on the first start. A fetch that fails or is slow costs a
 * model pick or the planner nothing: lookups are synchronous reads of what is
 * already held (ADR-0040).
 *
 * The one network read is a single GET of MODELS_DEV_URL with no user data,
 * like the daily version check (ADR-0048). ORDEWELL_NO_MODELS_DEV=1 turns it
 * off (the snapshot and any cache still serve); ORDEWELL_MODELS_DEV_URL points
 * it elsewhere (a mirror, a test).
 */

export const MODELS_DEV_URL = 'https://models.dev/api.json';

export interface ModelDetails {
  name?: string;
  contextWindow?: number;
  /** The largest prompt, where models.dev states one below the window (OpenAI's GPT-5 models): what OpenCode measures a context against. */
  inputLimit?: number;
  maxOutputTokens?: number;
  /** USD per million tokens; a field models.dev does not state is absent. */
  pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  tools?: boolean;
  reasoning?: boolean;
  /** Effort levels the model takes, when models.dev lists them. */
  efforts?: string[];
}

/** A snapshot or cache body: our provider id, then the model's normalized key. */
export type DetailsTable = Record<string, Record<string, ModelDetails>>;

/**
 * Our provider ids to models.dev's. Endpoints that serve one vendor from two
 * regions map to the entry for the region the default base URL is in
 * (dashscope.aliyuncs.com is Alibaba's China endpoint). A provider with no
 * entry (`openai_compatible`, which can be anything; hunyuan, baichuan, yi,
 * which models.dev does not list) simply has no details.
 */
export const MODELS_DEV_PROVIDERS: Readonly<Partial<Record<AiProvider, string>>> = {
  openrouter: 'openrouter',
  google: 'google',
  openai: 'openai',
  xai: 'xai',
  groq: 'groq',
  deepseek: 'deepseek',
  together: 'togetherai',
  mistral: 'mistral',
  anthropic: 'anthropic',
  fireworks: 'fireworks-ai',
  perplexity: 'perplexity',
  zhipu: 'zhipuai',
  kimi: 'moonshotai-cn',
  cerebras: 'cerebras',
  deepinfra: 'deepinfra',
  doubao: 'volcengine',
  qwen: 'alibaba-cn',
  minimax: 'minimax-cn',
  stepfun: 'stepfun',
  siliconflow: 'siliconflow-cn',
  cohere: 'cohere',
  novita: 'novita-ai',
};

/**
 * The key a model is matched on, the same for a provider's listing and for
 * models.dev, so a spelling difference between them does not lose the match:
 *  1. lowercase;
 *  2. drop a leading `models/` (Gemini lists `models/gemini-2.5-pro`);
 *  3. drop a trailing `-latest`;
 *  4. drop a trailing snapshot date, `-20250929` or `-2025-09-29`;
 *  5. read `.` as `-`, since `claude-3.5-sonnet` and `claude-3-5-sonnet` are one model.
 * A `:variant` suffix (`:free`) is kept, since a variant is priced on its own.
 * An exact id still wins over a normalized one (see {@link lookupIn}).
 */
export function normalizeModelKey(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/-latest$/, '')
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '')
    .replace(/\./g, '-');
}

function lookupIn(table: DetailsTable | undefined, modelsDevProvider: string, model: string): ModelDetails | undefined {
  const entries = table?.[modelsDevProvider];
  if (!entries) return undefined;
  // Tables hold both spellings of a model that dates its ids (the dated id and
  // the normalized one), so the exact id is tried first and the normalized
  // key second.
  return entries[model.toLowerCase()] ?? entries[normalizeModelKey(model)];
}

interface RawModel {
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  tool_call?: unknown;
  reasoning_options?: unknown;
  limit?: { context?: unknown; input?: unknown; output?: unknown };
  cost?: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown };
}

const positive = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined);
const price = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

function detailsFromRaw(raw: RawModel): ModelDetails {
  const out: ModelDetails = {};
  if (typeof raw.name === 'string' && raw.name !== '') out.name = raw.name;
  const context = positive(raw.limit?.context);
  if (context !== undefined) out.contextWindow = context;
  const inputLimit = positive(raw.limit?.input);
  if (inputLimit !== undefined) out.inputLimit = inputLimit;
  const output = positive(raw.limit?.output);
  if (output !== undefined) out.maxOutputTokens = output;
  const input = price(raw.cost?.input);
  const completion = price(raw.cost?.output);
  if (input !== undefined && completion !== undefined) {
    out.pricing = { input, output: completion };
    const cacheRead = price(raw.cost?.cache_read);
    const cacheWrite = price(raw.cost?.cache_write);
    if (cacheRead !== undefined) out.pricing.cacheRead = cacheRead;
    if (cacheWrite !== undefined) out.pricing.cacheWrite = cacheWrite;
  }
  if (typeof raw.tool_call === 'boolean') out.tools = raw.tool_call;
  if (typeof raw.reasoning === 'boolean') out.reasoning = raw.reasoning;
  if (Array.isArray(raw.reasoning_options)) {
    for (const option of raw.reasoning_options as { type?: unknown; values?: unknown }[]) {
      if (option?.type === 'effort' && Array.isArray(option.values)) {
        out.efforts = option.values.filter((v): v is string => typeof v === 'string');
      }
    }
  }
  return out;
}

/**
 * models.dev's `api.json` cut down to what is read here: only the providers
 * above, only the fields above, keyed by our provider id. The same cut feeds
 * the cache and the bundled snapshot (scripts/refresh-model-snapshot.mjs), so
 * both have one shape. A model is stored under its own id and, when that
 * differs, its normalized key too.
 */
export function trimModelsDev(raw: unknown): DetailsTable {
  const table: DetailsTable = {};
  if (typeof raw !== 'object' || raw === null) return table;
  const providers = raw as Record<string, { models?: Record<string, RawModel> } | undefined>;
  for (const [ours, theirs] of Object.entries(MODELS_DEV_PROVIDERS)) {
    const models = theirs ? providers[theirs]?.models : undefined;
    if (!models || typeof models !== 'object') continue;
    const entries: Record<string, ModelDetails> = {};
    for (const [key, model] of Object.entries(models)) {
      if (typeof model !== 'object' || model === null) continue;
      const id = (typeof model.id === 'string' ? model.id : key).toLowerCase();
      const details = detailsFromRaw(model);
      entries[id] = details;
      // An undated alias never overwrites a model of that exact id.
      entries[normalizeModelKey(id)] ??= details;
    }
    table[ours] = entries;
  }
  return table;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_FILE = 'models-dev.json';

interface CacheFile {
  fetchedAt: number;
  table: DetailsTable;
}

export interface ModelDetailsOptions {
  /** The bundled snapshot; replaceable so a test controls the offline answer. */
  snapshot?: DetailsTable;
  /** Where the cache lives; `globalDataDir()` by default, read on use. */
  cacheDir?: () => string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** How long a cache serves before a refresh is due. */
  ttlMs?: number;
}

export class ModelDetailsStore {
  private readonly snapshot: DetailsTable;
  private readonly options: ModelDetailsOptions;
  private held: CacheFile | null | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(options: ModelDetailsOptions = {}) {
    this.options = options;
    this.snapshot = options.snapshot ?? (snapshotJson as unknown as DetailsTable);
  }

  private cachePath(): string {
    return join((this.options.cacheDir ?? globalDataDir)(), CACHE_FILE);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private loadCache(): CacheFile | null {
    if (this.held !== undefined) return this.held;
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath(), 'utf8')) as Partial<CacheFile>;
      this.held = typeof parsed.fetchedAt === 'number' && parsed.table && typeof parsed.table === 'object'
        ? { fetchedAt: parsed.fetchedAt, table: parsed.table }
        : null;
    } catch {
      this.held = null;
    }
    return this.held;
  }

  /** Whether the cache is missing or older than the TTL. */
  isStale(): boolean {
    const cache = this.loadCache();
    return !cache || this.now() - cache.fetchedAt >= (this.options.ttlMs ?? DAY_MS) || cache.fetchedAt > this.now() + DAY_MS;
  }

  /**
   * What is held for a model: the cache first, then the snapshot for what the
   * cache lacks. Never waits on the network; a stale cache starts a refresh
   * and still answers.
   */
  lookup(provider: AiProvider, model: string): ModelDetails | undefined {
    const theirs = MODELS_DEV_PROVIDERS[provider];
    if (!theirs) return undefined;
    this.refreshInBackground();
    return lookupIn(this.loadCache()?.table, theirs, model) ?? lookupIn(this.snapshot, theirs, model);
  }

  /** Starts a refresh when one is due and none is running; never throws, never awaited by a caller that must not wait. */
  refreshInBackground(): void {
    void this.refresh();
  }

  /** Settles once a due refresh is done. Resolves, never rejects, on every failure. */
  refresh(): Promise<void> {
    const env = this.options.env ?? process.env;
    if (this.inFlight) return this.inFlight;
    const off = env.ORDEWELL_NO_MODELS_DEV;
    if (off !== undefined && off !== '' && off !== '0' && off.toLowerCase() !== 'false') return Promise.resolve();
    if (!this.isStale()) return Promise.resolve();
    const run = this.fetchAndStore(env.ORDEWELL_MODELS_DEV_URL || MODELS_DEV_URL)
      .catch(() => undefined)
      .finally(() => { this.inFlight = undefined; });
    this.inFlight = run;
    return run;
  }

  private async fetchAndStore(url: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await (this.options.fetchImpl ?? fetch)(url, { method: 'GET', signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      const table = trimModelsDev(await response.json());
      // An answer that holds no provider we know is not a catalog: keep what we have.
      if (Object.keys(table).length === 0) return;
      const cache: CacheFile = { fetchedAt: this.now(), table };
      this.held = cache;
      const file = this.cachePath();
      mkdirSync(dirname(file), { recursive: true });
      // Rename so a reader in another process never sees half a file.
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(cache));
      renameSync(temp, file);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * A provider's listing merged with models.dev. The listing decides which
 * models exist and wins for anything it states; models.dev fills only what it
 * left out (a window of 0 and a price of '?' both mean "not stated"). A model
 * models.dev does not know comes back as it was.
 */
export function enrichCatalogModel(provider: AiProvider, model: CatalogModel, store: ModelDetailsStore = modelDetails()): CatalogModel {
  const details = store.lookup(provider, model.id);
  if (!details) return model;
  const out: CatalogModel = { ...model };
  if (out.contextLength <= 0 && details.contextWindow !== undefined) out.contextLength = details.contextWindow;
  if (out.maxOutputTokens === undefined && details.maxOutputTokens !== undefined) out.maxOutputTokens = details.maxOutputTokens;
  const stated = (price: string) => price.trim() !== '' && Number.isFinite(Number(price));
  if (!(stated(out.pricing.prompt) && stated(out.pricing.completion)) && details.pricing) {
    out.pricing = { prompt: String(details.pricing.input / 1_000_000), completion: String(details.pricing.output / 1_000_000) };
  }
  if (details.pricing && (details.pricing.cacheRead !== undefined || details.pricing.cacheWrite !== undefined)) {
    out.cachePricing = {
      ...(details.pricing.cacheRead !== undefined ? { read: details.pricing.cacheRead } : {}),
      ...(details.pricing.cacheWrite !== undefined ? { write: details.pricing.cacheWrite } : {}),
    };
  }
  if (out.tools === undefined && details.tools !== undefined) out.tools = details.tools;
  if (details.reasoning !== undefined) out.reasoning = details.reasoning;
  if (details.efforts) out.efforts = details.efforts;
  if ((!out.name || out.name === out.id) && details.name) out.name = details.name;
  return out;
}

let shared: ModelDetailsStore | undefined;

/** The process-wide store, on the real data directory and the platform fetch. */
export function modelDetails(): ModelDetailsStore {
  shared ??= new ModelDetailsStore();
  return shared;
}

/** For tests: the next {@link modelDetails} builds a store afresh. */
export function resetModelDetails(): void {
  shared = undefined;
}
