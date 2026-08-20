import * as fs from "fs";
import * as path from "path";
import { globalDataDir } from "../utils/globalDataDir";
export interface CatalogModel {
  id: string;
  name: string;
  description: string;
  pricing: { prompt: string; completion: string };
  contextLength: number;
}

interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  pricing?: { prompt: string; completion: string };
  context_length?: number;
}

const CACHE_KEY = 'model-catalog';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function storageKey(baseUrl: string): string {
  return `${CACHE_KEY}:${baseUrl}`;
}

function globalCacheDir(): string {
  return globalDataDir();
}

export class ModelCatalog {
  static async fetchModels(apiKey: string, baseUrl?: string, fetchImpl?: typeof fetch): Promise<CatalogModel[]> {
    const url = (baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    // An injected fetch means the resolver owns caching — bypass the file cache
    // so callers (and tests) get exactly what the seam returns.
    const useFileCache = !fetchImpl;
    if (useFileCache) {
      const cached = this.readCache(storageKey(url));
      if (cached) {
        try {
          return JSON.parse(cached) as CatalogModel[];
        } catch { /* empty */ }
      }
    }

    // OpenRouter's /models endpoint is public, so the catalog can be fetched
    // without a key. Only send Authorization when we actually have one.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await (fetchImpl ?? fetch)(`${url}/models`, { headers });

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { data?: OpenRouterModel[] };
    const models: CatalogModel[] = (data.data ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description ?? '',
      pricing: {
        prompt: m.pricing?.prompt ?? '?',
        completion: m.pricing?.completion ?? '?',
      },
      contextLength: m.context_length ?? 0,
    }));

    if (useFileCache) this.writeCache(storageKey(url), models);
    return models;
  }

  /**
   * Delete the on-disk catalog cache for a base URL so the next fetch re-runs.
   * Used by the resolver's `invalidate()` in production (no injected fetch);
   * best-effort — a missing file or unreadable dir is a no-op.
   */
  static clearCache(baseUrl?: string): void {
    try {
      const url = (baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
      const key = storageKey(url);
      const cacheDir = globalCacheDir();
      const cacheFile = path.join(cacheDir, `${key.replace(/[:/]/g, '_')}.json`);
      if (fs.existsSync(cacheFile)) fs.rmSync(cacheFile);
    } catch { /* empty */ }
  }

  private static readCache(key: string): string | null {
    try {
      const cacheDir = globalCacheDir();
      const cacheFile = path.join(cacheDir, `${key.replace(/[:/]/g, '_')}.json`);
      if (!fs.existsSync(cacheFile)) return null;
      const raw = fs.readFileSync(cacheFile, 'utf8');
      const data = JSON.parse(raw);
      if (Date.now() - data.cachedAt > CACHE_TTL_MS) return null;
      return JSON.stringify(data.models);
    } catch {
      return null;
    }
  }

  private static writeCache(key: string, models: CatalogModel[]): void {
    try {
      const cacheDir = globalCacheDir();
      fs.mkdirSync(cacheDir, { recursive: true });
      const cacheFile = path.join(cacheDir, `${key.replace(/[:/]/g, '_')}.json`);
      fs.writeFileSync(
        cacheFile,
        JSON.stringify({ models, cachedAt: Date.now() }, null, 2)
      );
    } catch { /* empty */ }
  }
}
