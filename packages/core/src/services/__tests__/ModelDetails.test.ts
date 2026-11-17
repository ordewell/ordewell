import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogModel } from '../ModelCatalog';
import { ModelDetailsStore, enrichCatalogModel, normalizeModelKey, trimModelsDev, type DetailsTable } from '../ModelDetails';
import { toOrchestratorOptions } from '../ProviderRouting';
import { discoverProviderModels } from '../harness/ordewell/models';

const dir = () => mkdtempSync(join(tmpdir(), 'ordewell-details-'));

const SNAPSHOT: DetailsTable = {
  anthropic: {
    'claude-sonnet-4-5': { contextWindow: 200_000, maxOutputTokens: 64_000, pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, tools: true, reasoning: true, efforts: ['none', 'low', 'high'] },
  },
  openai: {
    'text-only': { contextWindow: 8_000, tools: false },
  },
};

const RAW = {
  anthropic: { models: { 'claude-new': { id: 'claude-new', name: 'Claude New', tool_call: true, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'max'] }], limit: { context: 1_000_000, output: 128_000 }, cost: { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 } } } },
  'not-ours': { models: { x: { id: 'x' } } },
};

function store(extra: ConstructorParameters<typeof ModelDetailsStore>[0] = {}) {
  return new ModelDetailsStore({ snapshot: SNAPSHOT, cacheDir: dir, env: {}, ...extra });
}

describe('normalizeModelKey', () => {
  it.each([
    ['Claude-Sonnet-4-5-20250929', 'claude-sonnet-4-5'],
    ['claude-sonnet-4-5-2025-09-29', 'claude-sonnet-4-5'],
    ['models/gemini-2.5-pro', 'gemini-2-5-pro'],
    ['claude-3.5-sonnet', 'claude-3-5-sonnet'],
    ['gpt-4o-latest', 'gpt-4o'],
    ['meta/llama-3:free', 'meta/llama-3:free'],
  ])('%s -> %s', (id, key) => expect(normalizeModelKey(id)).toBe(key));
});

describe('trimModelsDev', () => {
  it('keeps our providers and the fields read, keyed by our provider id', () => {
    const table = trimModelsDev(RAW);
    expect(Object.keys(table)).toEqual(['anthropic']);
    expect(table.anthropic['claude-new']).toEqual({
      name: 'Claude New', contextWindow: 1_000_000, maxOutputTokens: 128_000,
      pricing: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }, tools: true, reasoning: true, efforts: ['low', 'max'],
    });
    expect(trimModelsDev('junk')).toEqual({});
  });

  it('stores a dated model under its normalized key without overwriting an exact one', () => {
    const table = trimModelsDev({ openai: { models: { 'gpt-5-20260101': { id: 'gpt-5-20260101', limit: { context: 1 } }, 'gpt-5': { id: 'gpt-5', limit: { context: 2 } } } } });
    expect(table.openai['gpt-5'].contextWindow).toBe(2);
    expect(table.openai['gpt-5-20260101'].contextWindow).toBe(1);
  });

  it('keeps an input limit models.dev states below the window', () => {
    const table = trimModelsDev({ openai: { models: { 'gpt-5': { id: 'gpt-5', limit: { context: 400_000, input: 272_000, output: 128_000 } } } } });
    expect(table.openai['gpt-5']).toEqual({ contextWindow: 400_000, inputLimit: 272_000, maxOutputTokens: 128_000 });
  });
});

describe('lookup', () => {
  it('matches a provider id to the snapshot through the normalization', () => {
    const s = store();
    expect(s.lookup('anthropic', 'claude-sonnet-4-5-20250929')?.contextWindow).toBe(200_000);
    expect(s.lookup('anthropic', 'claude-sonnet-4.5')?.contextWindow).toBe(200_000);
    expect(s.lookup('anthropic', 'nope')).toBeUndefined();
    expect(s.lookup('openai_compatible', 'claude-sonnet-4-5')).toBeUndefined();
  });
});

describe('cache and refresh', () => {
  const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

  it('fetches once, writes the cache, serves it ahead of the snapshot, and is not stale for a day', async () => {
    const cacheDir = dir();
    let now = 1_000_000;
    const fetchImpl = ok(RAW);
    const s = store({ cacheDir: () => cacheDir, fetchImpl, now: () => now });
    expect(s.isStale()).toBe(true);
    await s.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(existsSync(join(cacheDir, 'models-dev.json'))).toBe(true);
    expect(s.lookup('anthropic', 'claude-new')?.contextWindow).toBe(1_000_000);
    // The snapshot still answers for what the cache lacks.
    expect(s.lookup('openai', 'text-only')?.tools).toBe(false);

    now += 23 * 3_600_000;
    await s.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 2 * 3_600_000;
    expect(s.isStale()).toBe(true);
    await s.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a second process reads the first one\'s cache and does not fetch', async () => {
    const cacheDir = dir();
    await store({ cacheDir: () => cacheDir, fetchImpl: ok(RAW) }).refresh();
    const fetchImpl = ok(RAW);
    const other = store({ cacheDir: () => cacheDir, fetchImpl });
    expect(other.lookup('anthropic', 'claude-new')?.name).toBe('Claude New');
    await other.refresh();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serves the snapshot when the network fails, answers non-ok, or returns junk, and never throws', async () => {
    for (const fetchImpl of [
      vi.fn(async () => { throw new Error('offline'); }),
      vi.fn(async () => new Response('no', { status: 503 })),
      ok({ 'not-ours': {} }),
    ]) {
      const cacheDir = dir();
      const s = store({ cacheDir: () => cacheDir, fetchImpl });
      expect(s.lookup('anthropic', 'claude-sonnet-4-5')?.contextWindow).toBe(200_000);
      await expect(s.refresh()).resolves.toBeUndefined();
      expect(existsSync(join(cacheDir, 'models-dev.json'))).toBe(false);
      expect(s.lookup('anthropic', 'claude-sonnet-4-5')?.contextWindow).toBe(200_000);
    }
  });

  it('a lookup never waits on a fetch that has not answered', () => {
    const s = store({ fetchImpl: vi.fn(() => new Promise<Response>(() => undefined)) });
    expect(s.lookup('anthropic', 'claude-sonnet-4-5')?.contextWindow).toBe(200_000);
  });

  it('ignores a corrupt cache file', () => {
    const cacheDir = dir();
    writeFileSync(join(cacheDir, 'models-dev.json'), '{not json');
    expect(store({ cacheDir: () => cacheDir }).lookup('anthropic', 'claude-sonnet-4-5')?.contextWindow).toBe(200_000);
  });

  it('is off under ORDEWELL_NO_MODELS_DEV and reads ORDEWELL_MODELS_DEV_URL', async () => {
    const off = vi.fn();
    await store({ fetchImpl: off, env: { ORDEWELL_NO_MODELS_DEV: '1' } }).refresh();
    expect(off).not.toHaveBeenCalled();
    const on = ok(RAW);
    await store({ fetchImpl: on, env: { ORDEWELL_MODELS_DEV_URL: 'http://127.0.0.1:1/x.json' } }).refresh();
    expect(on).toHaveBeenCalledWith('http://127.0.0.1:1/x.json', expect.objectContaining({ method: 'GET' }));
  });
});

describe('enrichCatalogModel', () => {
  const bare: CatalogModel = { id: 'claude-sonnet-4-5-20250929', name: 'claude-sonnet-4-5-20250929', description: '', pricing: { prompt: '?', completion: '?' }, contextLength: 0 };

  it('fills what the listing left out', () => {
    const out = enrichCatalogModel('anthropic', bare, store());
    expect(out).toMatchObject({ contextLength: 200_000, maxOutputTokens: 64_000, tools: true, reasoning: true, efforts: ['none', 'low', 'high'], cachePricing: { read: 0.3, write: 3.75 } });
    expect(Number(out.pricing.prompt) * 1_000_000).toBeCloseTo(3);
  });

  it('lets what the listing states win', () => {
    const listed = { ...bare, contextLength: 123, maxOutputTokens: 5, tools: false, pricing: { prompt: '0.000001', completion: '0.000002' } };
    expect(enrichCatalogModel('anthropic', listed, store())).toMatchObject({ contextLength: 123, maxOutputTokens: 5, tools: false, pricing: listed.pricing });
  });

  it('leaves an unknown model as it was', () => {
    const unknown = { ...bare, id: 'mystery' };
    expect(enrichCatalogModel('anthropic', unknown, store())).toBe(unknown);
  });
});

describe('the planner picker reads the same details', () => {
  it('shows window and price for a non-OpenRouter provider', () => {
    const entry = enrichCatalogModel('anthropic', { id: 'claude-sonnet-4-5', name: 'Sonnet', description: '', pricing: { prompt: '?', completion: '?' }, contextLength: 0 }, store());
    const [option] = toOrchestratorOptions({ anthropic: [entry] }, []);
    expect(option).toMatchObject({ contextWindow: 200_000, maxOutputTokens: 64_000, pricing: '3/15' });
  });
});

describe('the runner list', () => {
  const listing = (ids: string[]) => vi.fn(async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 }));

  it('leaves out a model the catalog knows lacks tools, keeps unknown ones, and offers efforts only to reasoners', async () => {
    // The shared store reads the real snapshot: pick ids it holds.
    const snapshot = JSON.parse(readFileSync(join(__dirname, '..', 'modelDetailsSnapshot.json'), 'utf8')) as DetailsTable;
    const noTools = Object.entries(snapshot.openai).find(([, d]) => d.tools === false)?.[0];
    const reasoner = Object.entries(snapshot.openai).find(([, d]) => d.tools === true && d.reasoning === true)?.[0];
    const plain = Object.entries(snapshot.openai).find(([, d]) => d.tools === true && d.reasoning === false)?.[0];
    expect(noTools && reasoner && plain).toBeTruthy();

    const models = await discoverProviderModels({ OPENAI_API_KEY: 'k' }, 'openai', listing([noTools!, reasoner!, plain!, 'zz-unknown-model']));
    const byId = new Map(models.map((m) => [m.modelId, m]));
    expect(byId.has(`openai:${noTools}`)).toBe(false);
    expect(byId.has('openai:zz-unknown-model')).toBe(true);
    expect(byId.get(`openai:${reasoner}`)!.variants.length).toBeGreaterThan(0);
    expect(byId.get(`openai:${plain}`)!.variants).toEqual([]);
    expect(byId.get('openai:zz-unknown-model')!.variants).toEqual([]);
  });
});
