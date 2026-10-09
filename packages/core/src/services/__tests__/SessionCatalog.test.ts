import { describe, it, expect, vi } from 'vitest';
import { SessionCatalog, type SessionCatalogDeps } from '../SessionCatalog';
import { coerceAssignments } from '../ModelAllowlistResolver';
import { createTask, type DiscoveredModel, type RunnerId } from '../../models/Task';

const model = (modelId: string, variants: string[] = []): DiscoveredModel =>
  ({ modelId, modelLabel: modelId, variants: variants.map((id) => ({ id, label: id })) });

const MODES = [{ id: 'build', label: 'Build', description: '' }, { id: 'agent', label: 'Agent', description: '', autonomous: true }];

function setup(opts: {
  discovered?: Record<RunnerId, DiscoveredModel[]>;
  resolverCache?: Record<RunnerId, DiscoveredModel[]>;
  settings?: ReturnType<SessionCatalogDeps['settings']>;
  planRunners?: RunnerId[];
} = {}) {
  let settings = opts.settings ?? { enabledRunners: ['claude-code'] };
  let planRunners = opts.planRunners ?? [];
  const discovered = opts.discovered ?? {};
  const resolver = {
    modelsForRunners: vi.fn(async (runners: RunnerId[]) => Object.fromEntries(runners.map((r) => [r, discovered[r] ?? []]))),
    getCachedRunnerModels: vi.fn((runner: RunnerId) => opts.resolverCache?.[runner] ?? []),
  };
  const catalog = new SessionCatalog({
    config: { enabledRunners: ['claude-code', 'codex'], autonomousMode: true },
    registry: { getManifest: (id: string) => ['claude-code', 'codex', 'opencode'].includes(id)
      ? { name: id, displayName: id, runner: { command: id }, features: {}, modelDiscovery: { method: 'hardcoded' }, modes: MODES }
      : undefined },
    modelResolver: resolver,
    settings: () => settings,
    planRunners: () => planRunners,
  });
  return {
    catalog,
    resolver,
    setSettings: (next: typeof settings) => { settings = next; },
    setPlanRunners: (next: RunnerId[]) => { planRunners = next; },
  };
}

const ids = (models: DiscoveredModel[] | undefined) => models?.map((m) => m.modelId);

describe('SessionCatalog enabled runners and allowlist', () => {
  it('falls back to the host defaults until the user chooses runners', () => {
    const { catalog, setSettings } = setup({ settings: {} });
    expect(catalog.enabledRunners()).toEqual(['claude-code', 'codex']);

    setSettings({ enabledRunners: ['codex'] });
    expect(catalog.enabledRunners()).toEqual(['codex']);
  });

  it('excludes retired runner ids from settings and a saved plan catalog', () => {
    const { catalog } = setup({ settings: { enabledRunners: ['retired-runner', 'codex'] } });
    expect(catalog.enabledRunners()).toEqual(['codex']);
    expect(catalog.queryCatalog(['retired-runner', 'claude-code']).runners).toEqual(['claude-code']);
    expect(catalog.queryCatalog(['retired-runner']).modes).toEqual({});
  });

  it('reads the allowlist live, and unset means no restriction', () => {
    const { catalog, setSettings } = setup({ settings: { modelAllowlist: { codex: ['gpt-5'] } } });
    expect(catalog.allowlist()).toEqual({ codex: ['gpt-5'] });
    expect(catalog.allowlistFor('codex')).toEqual(['gpt-5']);
    expect(catalog.allowlistFor('claude-code')).toBeUndefined();

    setSettings({});
    expect(catalog.allowlist()).toEqual({});
  });
});

describe('SessionCatalog discovery cache', () => {
  it('merges a later discovery into what is known instead of replacing it', async () => {
    const { catalog } = setup({ discovered: { 'claude-code': [model('sonnet')], codex: [model('gpt-5')] } });

    await catalog.discover(['claude-code']);
    await catalog.discover(['codex']);

    expect(ids(catalog.models()['claude-code'])).toEqual(['sonnet']);
    expect(ids(catalog.models().codex)).toEqual(['gpt-5']);
  });

  it('prefers what the resolver holds now over its own snapshot, for runners it knows or the plan names', async () => {
    const { catalog, setPlanRunners } = setup({
      discovered: { 'claude-code': [model('sonnet')] },
      resolverCache: { 'claude-code': [model('sonnet', ['low', 'high'])], codex: [model('gpt-5')] },
    });
    await catalog.discover(['claude-code']);

    expect(catalog.models()['claude-code']?.[0].variants).toHaveLength(2);
    expect(catalog.models().codex).toBeUndefined();

    setPlanRunners(['codex']);
    expect(ids(catalog.models().codex)).toEqual(['gpt-5']);
  });

  it('forgets everything on reset', async () => {
    const { catalog } = setup({ discovered: { 'claude-code': [model('sonnet')] } });
    await catalog.discover(['claude-code']);

    catalog.reset();

    expect(catalog.models()).toEqual({});
    expect(catalog.known('claude-code')).toEqual([]);
  });
});

describe('SessionCatalog views', () => {
  it('shows the planner only allowlisted models, but checks edits against the whole catalog', async () => {
    const { catalog } = setup({
      discovered: { 'claude-code': [model('sonnet'), model('haiku')] },
      settings: { enabledRunners: ['claude-code'], modelAllowlist: { 'claude-code': ['haiku'] } },
    });

    const live = await catalog.live();
    const edit = catalog.edit(['claude-code']);

    expect(live.runners).toEqual(['claude-code']);
    expect(ids(live.models['claude-code'])).toEqual(['haiku']);
    expect(ids(edit.modelsByRunner['claude-code'])).toEqual(['sonnet', 'haiku']);
    expect(edit.perRunnerAllowlist).toEqual({ 'claude-code': ['haiku'] });
    expect(edit.runnerModes['claude-code']).toEqual(MODES);
  });

  it('reads a runner enabled since the catalog was built', async () => {
    const { catalog, setSettings } = setup({ discovered: { codex: [model('gpt-5')] } });
    setSettings({ enabledRunners: ['claude-code', 'codex'] });

    const live = await catalog.live();

    expect(live.runners).toEqual(['claude-code', 'codex']);
    expect(ids(live.models.codex)).toEqual(['gpt-5']);
  });

  it('keeps the whole catalog for coercion while filtering the prompt view', async () => {
    const { catalog } = setup({
      discovered: { 'claude-code': [model('sonnet', ['low']), model('haiku')] },
      settings: { modelAllowlist: { 'claude-code': ['sonnet'] } },
    });

    const planning = await catalog.planning(['claude-code']);

    expect(ids(planning.modelsByRunner['claude-code'])).toEqual(['sonnet', 'haiku']);
    expect(ids(planning.filteredModels['claude-code'])).toEqual(['sonnet']);
    expect(planning.runnerModes['claude-code']).toEqual(MODES);
    expect(ids(catalog.known('claude-code'))).toEqual(['sonnet', 'haiku']);
  });

  it('describes one runner with its models, modes and default mode, without remembering it', async () => {
    const { catalog } = setup({ discovered: { codex: [model('gpt-5')] } });

    const runner = await catalog.runner('codex');

    expect(ids(runner.models)).toEqual(['gpt-5']);
    expect(runner.modes).toEqual(MODES);
    expect(runner.defaultMode).toBe('agent');
    expect(catalog.known('codex')).toEqual([]);
  });
});

describe('SessionCatalog.admit', () => {
  it('keeps an admitted runner\'s models alongside the others', async () => {
    const { catalog } = setup({ discovered: { 'claude-code': [model('sonnet')] } });
    await catalog.discover(['claude-code']);

    catalog.admit('codex', [model('gpt-5')]);

    expect(ids(catalog.models()['claude-code'])).toEqual(['sonnet']);
    expect(ids(catalog.models().codex)).toEqual(['gpt-5']);
  });

  it('never lets an empty discovery displace what is known', () => {
    const { catalog } = setup();
    catalog.admit('codex', [model('gpt-5')]);

    catalog.admit('codex', []);

    expect(ids(catalog.known('codex'))).toEqual(['gpt-5']);
  });

  it('gives coercion the variants it clamps an admitted runner\'s effort against', () => {
    const { catalog } = setup();
    const task = createTask({
      id: 't1', order: 1, title: 'T', prompt: 'p', assignedRunner: 'codex',
      assignedModel: { modelId: 'gpt-5', modelLabel: 'gpt-5', thinkingEffort: 'xhigh' },
    });

    const unadmitted = coerceAssignments([task], catalog.allowlist(), ['codex'], catalog.models());
    expect(unadmitted[0].assignedModel?.thinkingEffort).toBe('xhigh');

    catalog.admit('codex', [model('gpt-5', ['low', 'high'])]);
    const admitted = coerceAssignments([task], catalog.allowlist(), ['codex'], catalog.models());
    expect(admitted[0].assignedModel?.thinkingEffort).toBe('high');
    expect(admitted[0].assignedModel?.availableVariants).toEqual(['low', 'high']);
  });
});
