import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

import type { OrchestratorPool } from '../../pool/orchestratorPool';

function fakePool(overrides: Partial<OrchestratorPool> = {}): OrchestratorPool {
  const pool = {
    getProviderModels: vi.fn(),
    ...overrides,
  } as unknown as OrchestratorPool;
  return pool;
}

describe('GET /api/models', () => {
  let app: Hono;
  let pool: OrchestratorPool;

  beforeEach(async () => {
    pool = fakePool();
    const { modelsRoute } = await import('../../routes/models');
    app = new Hono();
    app.route('/api/models', modelsRoute(pool));
  });

  it('returns runner-discovered models only (no orchestrator/OpenRouter model IDs leaked)', async () => {
    const claudeModels = [
      { modelId: 'claude-opus-4-20250514', modelLabel: 'Claude Opus 4', variants: [{ id: 'adaptive', label: 'Adaptive' }, { id: 'low', label: 'Low effort' }, { id: 'medium', label: 'Medium effort' }, { id: 'high', label: 'High effort' }] },
      { modelId: 'claude-sonnet-4-20250514', modelLabel: 'Claude Sonnet 4', variants: [{ id: 'adaptive', label: 'Adaptive' }, { id: 'low', label: 'Low effort' }, { id: 'medium', label: 'Medium effort' }] },
    ];
    const opencodeModels = [
      { modelId: 'opencode-go/deepseek-v4-pro', modelLabel: 'DeepSeek V4 Pro', variants: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }] },
    ];
    const orchestratorModels = [
      { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'OpenRouter', apiProvider: 'openrouter' as const, pricing: '0.14/0.28' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'Google', apiProvider: 'google' as const },
    ];
    vi.mocked(pool.getProviderModels).mockResolvedValue({
      models: [...claudeModels, ...opencodeModels],
      modelsByRunner: { 'claude-code': claudeModels, 'opencode': opencodeModels },
      modesByRunner: { 'claude-code': [{ id: 'default', label: 'Default', description: 'Ask to edit' }], 'opencode': [{ id: 'build', label: 'Build', description: 'Edit files' }] },
      orchestratorModel: 'openai/gpt-4o',
      providers: ['openrouter', 'google'],
      orchestratorModels,
      providerErrors: {},
    });

    const res = await app.request('/api/models', { method: 'GET' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ modelId: string }>; modelsByRunner: Record<string, unknown[]>; orchestratorModel: string; providers: string[]; orchestratorModels: Array<{ provider: string }>; providerErrors: Record<string, string> };
    expect(body.models).toHaveLength(3);
    expect(body.modelsByRunner['claude-code']).toHaveLength(2);
    expect(body.modelsByRunner['opencode']).toHaveLength(1);
    // Runner models use runner-native IDs, not OpenRouter routing IDs
    expect(body.models.every((m: { modelId: string }) => !m.modelId.includes('openai/') && !m.modelId.includes('deepseek/') && !m.modelId.includes('anthropic/'))).toBe(true);
    expect(body.models.some((m: { modelId: string }) => m.modelId === 'claude-opus-4-20250514')).toBe(true);
    expect(body.models.some((m: { modelId: string }) => m.modelId === 'opencode-go/deepseek-v4-pro')).toBe(true);
    expect(body.orchestratorModel).toBe('openai/gpt-4o');
    expect(body.providers).toEqual(['openrouter', 'google']);
    // The orchestrator catalog spans providers and names each one.
    expect(body.orchestratorModels).toHaveLength(2);
    expect(body.orchestratorModels.map((m: any) => m.provider)).toEqual(['OpenRouter', 'Google']);
    expect(body.providerErrors).toEqual({});
    // Modes ride along on this same fetch — without them a surface can offer a
    // per-task runner picker but not the mode picker that has to follow it.
    expect((body as any).modesByRunner['claude-code']).toEqual([{ id: 'default', label: 'Default', description: 'Ask to edit' }]);
  });

  it('surfaces per-provider fetch failures without dropping working providers', async () => {
    vi.mocked(pool.getProviderModels).mockResolvedValue({
      models: [],
      modelsByRunner: { 'claude-code': [], 'opencode': [] },
      modesByRunner: {},
      orchestratorModel: '',
      providers: ['openrouter', 'openai'],
      orchestratorModels: [
        { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'OpenRouter', apiProvider: 'openrouter' as const },
      ],
      providerErrors: { openai: 'Failed to fetch models: 401 Unauthorized' },
    });

    const res = await app.request('/api/models', { method: 'GET' });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.orchestratorModels).toHaveLength(1);
    expect(body.orchestratorModels[0].provider).toBe('OpenRouter');
    expect(body.providerErrors.openai).toContain('401');
  });

  it('returns empty models when no API keys are configured', async () => {
    vi.mocked(pool.getProviderModels).mockResolvedValue({
      models: [],
      modelsByRunner: { 'claude-code': [], 'opencode': [] },
      modesByRunner: {},
      orchestratorModel: '',
      providers: [],
      orchestratorModels: [],
      providerErrors: {},
    });

    const res = await app.request('/api/models', { method: 'GET' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[]; orchestratorModel: string; providers: string[]; orchestratorModels: unknown[] };
    expect(body.models).toEqual([]);
    expect(body.orchestratorModel).toBe('');
    expect(body.providers).toEqual([]);
    expect(body.orchestratorModels).toEqual([]);
  });
});
