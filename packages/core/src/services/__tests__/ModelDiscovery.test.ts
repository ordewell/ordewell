import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { discoverGeminiModels, ModelDiscovery, type ExecImpl } from '../ModelDiscovery';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { CLAUDE_CODE_MANIFEST } from '../../plugins/builtin/claude-code.manifest';
import { OPENCODE_MANIFEST } from '../../plugins/builtin/opencode.manifest';

function registryWith(...manifests: Array<{ name: string }>): RunnerRegistry {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  return { getManifest: (id: string) => byName.get(id) } as unknown as RunnerRegistry;
}

// A fetch that always fails — injected into command-based tests so the
// apiDiscovery path is skipped (returns null) and the test exercises the
// `claude --help` parsing path, not a live or mock API call.
const failingFetch = vi.fn(async () => { throw new Error('no fetch in command tests'); });

// Modern `claude --help`: the --model option is described in prose with example
// aliases, and there is NO enumerated "Available values:" list.
const MODERN_CLAUDE_HELP = `
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  -n, --name <name>                     Set a display name for this session
`;

describe('discoverGeminiModels', () => {
  it('follows nextPageToken and aggregates generative models from every page', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const requestUrl = new URL(String(input));
      const pageToken = requestUrl.searchParams.get('pageToken');

      const body = pageToken
        ? {
            models: [
              { name: 'models/gemini-page-two', displayName: 'Gemini Page Two', supportedGenerationMethods: ['generateContent'] },
            ],
          }
        : {
            models: [
              { name: 'models/gemini-page-one', displayName: 'Gemini Page One', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/embedding-only', displayName: 'Embedding Only', supportedGenerationMethods: ['embedContent'] },
            ],
            nextPageToken: 'page/two',
          };

      return { ok: true, json: async () => body } as Response;
    });

    const models = await discoverGeminiModels('test-key', undefined, fetchImpl as unknown as typeof fetch);

    expect(models.map((model) => model.modelId).sort()).toEqual([
      'gemini-page-one',
      'gemini-page-two',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchImpl.mock.calls[1][0])).searchParams.get('pageToken')).toBe('page/two');
  });
});

describe('ModelDiscovery — Claude Code', () => {
  it('extracts the alias examples the CLI itself advertises in --help prose', async () => {
    const exec: ExecImpl = vi.fn(async (command: string) => {
      if (command.includes('--help')) return { stdout: MODERN_CLAUDE_HELP };
      throw new Error('unexpected command: ' + command);
    });
    const discovery = new ModelDiscovery(registryWith(CLAUDE_CODE_MANIFEST), exec, failingFetch);

    const models = await discovery.discover('claude-code');
    const ids = models.map((m) => m.modelId);

    // Aliases come straight from the installed CLI's own help text, plus the
    // canonical 'haiku' alias merged in from canonicalAliases (the help prose
    // uses "e.g." and omits it even though `claude --model haiku` is valid).
    expect(ids).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    // The full-name example duplicates an alias — must not appear as a model.
    expect(ids.some((id) => id.includes('claude-fable-5'))).toBe(false);
    // Quoted tokens from OTHER options' descriptions must not leak in.
    expect(models.find((m) => m.modelId === 'opus')!.modelLabel).toBe('Opus');
    // The merged 'haiku' carries the manifest-declared label.
    expect(models.find((m) => m.modelId === 'haiku')!.modelLabel).toBe('Haiku');
  });

  it('returns the canonical alias fallback when the CLI is unavailable', async () => {
    const exec: ExecImpl = vi.fn(async () => { throw new Error('ENOENT'); });
    const discovery = new ModelDiscovery(registryWith(CLAUDE_CODE_MANIFEST), exec, failingFetch);

    const models = await discovery.discover('claude-code');
    expect(models.map((m) => m.modelId)).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
    expect(models.every((m) => m.variants.length === 6)).toBe(true);
  });

  it('does not cache a fallback-only result — the next lookup retries discovery', async () => {
    // Each discover() makes up to two passes (cold-start retry). The first
    // discover() fails both passes → returns the canonical fallback (not
    // cached); only the second discover() reaches the CLI and returns the
    // discovered + merged list.
    let calls = 0;
    const exec: ExecImpl = vi.fn(async (command: string) => {
      calls++;
      if (calls <= 2) throw new Error('ENOENT');
      if (command.includes('--help')) return { stdout: MODERN_CLAUDE_HELP };
      throw new Error('unexpected');
    });
    const discovery = new ModelDiscovery(registryWith(CLAUDE_CODE_MANIFEST), exec, failingFetch);

    const first = await discovery.discover('claude-code');
    expect(first.map((m) => m.modelId)).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
    const retry = await discovery.discover('claude-code');
    expect(retry.map((m) => m.modelId)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });

  it('still parses an explicit enumerated model list from --help when present', async () => {
    const helpWithList = `
  --model <model>   Available values: claude-opus-4-20250514, claude-sonnet-4-20250514

  -n, --name <name>
`;
    const exec: ExecImpl = vi.fn(async (command: string) => {
      if (command.includes('--help')) return { stdout: helpWithList };
      throw new Error('no');
    });
    const discovery = new ModelDiscovery(registryWith(CLAUDE_CODE_MANIFEST), exec, failingFetch);

    const ids = (await discovery.discover('claude-code')).map((m) => m.modelId);

    expect(ids).toEqual(expect.arrayContaining(['claude-opus-4-20250514', 'claude-sonnet-4-20250514']));
  });

  it('merges canonical aliases from canonicalAliases so a help-text gap never drops a valid model', async () => {
    // Help text advertises only opus + sonnet — haiku and fable are omitted
    // even though they are valid `--model` aliases.
    const helpMissingHaiku = `
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'opus', or 'sonnet') or a model's full
                                        name (e.g. 'claude-sonnet-5').
  -n, --name <name>
`;
    const exec: ExecImpl = vi.fn(async (command: string) => {
      if (command.includes('--help')) return { stdout: helpMissingHaiku };
      throw new Error('unexpected');
    });
    const discovery = new ModelDiscovery(registryWith(CLAUDE_CODE_MANIFEST), exec, failingFetch);

    const ids = (await discovery.discover('claude-code')).map((m) => m.modelId);

    // Discovered aliases first, then the missing canonical aliases appended.
    expect(ids).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
  });

  it('does not duplicate an alias already discovered from --help', async () => {
    // Help text advertises haiku explicitly — the fallback entry must not
    // produce a second 'haiku' row.
    const helpWithHaiku = `
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'haiku', 'opus', or 'sonnet') or a
                                        model's full name (e.g. 'claude-sonnet-5').
  -n, --name <name>
`;
    const exec: ExecImpl = vi.fn(async (command: string) => {
      if (command.includes('--help')) return { stdout: helpWithHaiku };
      throw new Error('unexpected');
    });
    const discovery = new ModelDiscovery(registryWith(CLAUDE_CODE_MANIFEST), exec, failingFetch);

    const models = await discovery.discover('claude-code');
    const haikuEntries = models.filter((m) => m.modelId === 'haiku');

    expect(haikuEntries).toHaveLength(1);
    // fable is still filled in from canonicalAliases.
    expect(models.map((m) => m.modelId)).toEqual(['haiku', 'opus', 'sonnet', 'fable']);
  });
});

describe('ModelDiscovery — Claude Code API (Anthropic Models API)', () => {
  // Simulates the GET /v1/models response: full model IDs sorted most-recent
  // first, with display_name. The parser derives short aliases and dedupes by
  // family, keeping the latest.
  const ANTHROPIC_API_RESPONSE = JSON.stringify({
    data: [
      { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
      { id: 'claude-fable-5', display_name: 'Claude Fable 5' },
      { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
      { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' },
      { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
    ],
  });

  // A fetch that returns the mock API response — simulates a successful
  // Anthropic Models API call.
  function apiFetch(responseBody: string, status = 200): typeof fetch {
    return vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(responseBody),
    }) as unknown as Response) as typeof fetch;
  }

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  // A no-op exec — should never be called when API discovery succeeds.
  const noExec: ExecImpl = vi.fn(async () => { throw new Error('exec should not be called'); });

  it('derives short aliases from the Anthropic Models API, deduped by family', async () => {
    const discovery = new ModelDiscovery(
      registryWith(CLAUDE_CODE_MANIFEST),
      noExec,
      apiFetch(ANTHROPIC_API_RESPONSE),
    );

    const models = await discovery.discover('claude-code');
    const byId = new Map(models.map((m) => [m.modelId, m]));

    // One entry per family, latest only (opus-4-8 over opus-4-7, sonnet-5 over sonnet-4-6).
    expect(models.map((m) => m.modelId)).toEqual(['sonnet', 'fable', 'opus', 'haiku']);
    expect(byId.get('haiku')!.modelLabel).toBe('Claude Haiku 4.5');
    expect(byId.get('opus')!.modelLabel).toBe('Claude Opus 4.8');
    // No capabilities in the fixture → empty variants → static fallback
    // (6 entries, no disabled) applied by applyVariants.
    expect(models.every((m) => m.variants.length === 6)).toBe(true);
  });

  it('falls through to command discovery when the API returns an error', async () => {
    const exec: ExecImpl = vi.fn(async (command: string) => {
      if (command.includes('--help')) return { stdout: MODERN_CLAUDE_HELP };
      throw new Error('unexpected');
    });
    const discovery = new ModelDiscovery(
      registryWith(CLAUDE_CODE_MANIFEST),
      exec,
      apiFetch('{"type":"error","error":{"type":"authentication_error"}}', 401),
    );

    const ids = (await discovery.discover('claude-code')).map((m) => m.modelId);
    expect(ids).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });

  it('falls through to command discovery when no auth token is resolvable', async () => {
    // Custom manifest with an auth method that points to a non-existent env var
    // and a non-existent file — resolveApiAuth returns null, so the API is
    // never queried and command discovery runs.
    const manifestNoAuth = {
      ...CLAUDE_CODE_MANIFEST,
      modelDiscovery: {
        ...CLAUDE_CODE_MANIFEST.modelDiscovery,
        apiDiscovery: {
          url: 'https://api.anthropic.com/v1/models',
          headers: {},
          auth: [
            { type: 'env' as const, varName: 'NONEXISTENT_KEY_XYZ', header: 'X-Api-Key' },
            { type: 'file' as const, path: '/nonexistent/path/creds.json', jsonPath: 'token', header: 'Authorization', prefix: 'Bearer ' },
          ],
          parser: 'anthropic-models' as const,
        },
      },
    };
    const exec: ExecImpl = vi.fn(async (command: string) => {
      if (command.includes('--help')) return { stdout: MODERN_CLAUDE_HELP };
      throw new Error('unexpected');
    });
    const fetchShouldNotBeCalled = vi.fn(async () => { throw new Error('fetch should not be called'); }) as unknown as typeof fetch;
    const discovery = new ModelDiscovery(
      registryWith(manifestNoAuth),
      exec,
      fetchShouldNotBeCalled,
    );

    const ids = (await discovery.discover('claude-code')).map((m) => m.modelId);
    expect(ids).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(fetchShouldNotBeCalled).not.toHaveBeenCalled();
  });

  it('does not call exec when the API succeeds', async () => {
    const discovery = new ModelDiscovery(
      registryWith(CLAUDE_CODE_MANIFEST),
      noExec,
      apiFetch(ANTHROPIC_API_RESPONSE),
    );

    await discovery.discover('claude-code');

    expect(noExec).not.toHaveBeenCalled();
  });

  it('handles a model with no display_name by deriving a label from the family', async () => {
    const response = JSON.stringify({
      data: [
        { id: 'claude-haiku-4-5-20251001' },
      ],
    });
    const discovery = new ModelDiscovery(
      registryWith(CLAUDE_CODE_MANIFEST),
      noExec,
      apiFetch(response),
    );

    const models = await discovery.discover('claude-code');
    const haiku = models.find((m) => m.modelId === 'haiku');
    expect(haiku).toBeDefined();
    expect(haiku!.modelLabel).toBe('Haiku');
  });

  it('derives per-model thinking variants from API capabilities', async () => {
    // The Anthropic Models API returns capabilities.thinking.types and
    // capabilities.effort per model. A model that supports adaptive + enabled
    // thinking with low/medium/high effort must show exactly those variants —
    // not the full static ladder (no xhigh/max it doesn't support, no disabled
    // which is a CLI off-mode rather than an API capability).
    const response = JSON.stringify({
      data: [
        {
          id: 'claude-sonnet-5',
          display_name: 'Claude Sonnet 5',
          capabilities: {
            thinking: {
              supported: true,
              types: { adaptive: { supported: true }, enabled: { supported: true } },
            },
            effort: {
              supported: true,
              low: { supported: true },
              medium: { supported: true },
              high: { supported: true },
            },
          },
        },
      ],
    });
    const discovery = new ModelDiscovery(
      registryWith(CLAUDE_CODE_MANIFEST),
      noExec,
      apiFetch(response),
    );

    const models = await discovery.discover('claude-code');
    const sonnet = models.find((m) => m.modelId === 'sonnet')!;

    expect(sonnet.variants.map((v) => v.id)).toEqual(['adaptive', 'low', 'medium', 'high']);
    expect(sonnet.variants.map((v) => v.label)).toEqual(['Adaptive', 'Low effort', 'Medium effort', 'High effort']);
  });

  it('different models get different variant lists based on their capabilities', async () => {
    // Opus supports the full effort ladder (low→max); Haiku supports only
    // low/medium. Each model's variant list must reflect what IT supports, not
    // a uniform static list stamped across every model.
    const response = JSON.stringify({
      data: [
        {
          id: 'claude-opus-4-8',
          display_name: 'Claude Opus 4.8',
          capabilities: {
            thinking: {
              supported: true,
              types: { adaptive: { supported: true }, enabled: { supported: true } },
            },
            effort: {
              supported: true,
              low: { supported: true },
              medium: { supported: true },
              high: { supported: true },
              xhigh: { supported: true },
              max: { supported: true },
            },
          },
        },
        {
          id: 'claude-haiku-4-5-20251001',
          display_name: 'Claude Haiku 4.5',
          capabilities: {
            thinking: {
              supported: true,
              types: { adaptive: { supported: true }, enabled: { supported: true } },
            },
            effort: {
              supported: true,
              low: { supported: true },
              medium: { supported: true },
            },
          },
        },
      ],
    });
    const discovery = new ModelDiscovery(
      registryWith(CLAUDE_CODE_MANIFEST),
      noExec,
      apiFetch(response),
    );

    const models = await discovery.discover('claude-code');
    const opus = models.find((m) => m.modelId === 'opus')!;
    const haiku = models.find((m) => m.modelId === 'haiku')!;

    expect(opus.variants.map((v) => v.id)).toEqual(['adaptive', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(haiku.variants.map((v) => v.id)).toEqual(['adaptive', 'low', 'medium']);
  });

  it('offers the effort rungs of a model whose only thinking type is adaptive', async () => {
    // What the API actually returns for the current model line: no `enabled`
    // thinking type, yet every effort rung supported — and `claude --effort`
    // takes them all. Reading effort through the `enabled` gate left these
    // models with "Adaptive" as their sole choice.
    const response = JSON.stringify({
      data: [
        {
          id: 'claude-opus-5',
          display_name: 'Claude Opus 5',
          capabilities: {
            thinking: {
              supported: true,
              types: { adaptive: { supported: true }, enabled: { supported: false } },
            },
            effort: {
              supported: true,
              low: { supported: true },
              medium: { supported: true },
              high: { supported: true },
              xhigh: { supported: true },
              max: { supported: true },
            },
          },
        },
      ],
    });
    const discovery = new ModelDiscovery(registryWith(CLAUDE_CODE_MANIFEST), noExec, apiFetch(response));

    const opus = (await discovery.discover('claude-code')).find((m) => m.modelId === 'opus')!;
    expect(opus.variants.map((v) => v.id)).toEqual(['adaptive', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('drops the effort rungs a model does not support', async () => {
    // `effort.supported: false` means the model runs at one fixed effort —
    // offering rungs anyway would send a level the CLI silently ignores.
    const response = JSON.stringify({
      data: [
        {
          id: 'claude-haiku-4-5-20251001',
          display_name: 'Claude Haiku 4.5',
          capabilities: {
            thinking: { supported: true, types: { adaptive: { supported: false }, enabled: { supported: true } } },
            effort: { supported: false, low: { supported: false }, high: { supported: false } },
          },
        },
      ],
    });
    const discovery = new ModelDiscovery(registryWith(CLAUDE_CODE_MANIFEST), noExec, apiFetch(response));

    const haiku = (await discovery.discover('claude-code')).find((m) => m.modelId === 'haiku')!;
    // Empty here, so the manifest's static ladder fills in (applyVariants) —
    // the picker never goes blank, it just stops claiming per-model precision.
    expect(haiku.variants.map((v) => v.id)).toEqual(CLAUDE_CODE_MANIFEST.modelDiscovery.variants!.map((v) => v.id));
  });
});

describe('ModelDiscovery — OpenCode', () => {
  it('parses provider/model lines from `opencode models` — exactly what the CLI reports', async () => {
    const exec: ExecImpl = vi.fn(async () => ({
      stdout: [
        'opencode-go/deepseek-v4-pro',
        'opencode/gpt-5.1',
        'opencode/some-other-model',
      ].join('\n'),
    }));
    const discovery = new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec);

    const models = await discovery.discover('opencode');
    const byModelId = new Map(models.map((m) => [m.modelId, m]));

    expect(models.map((m) => m.modelId).sort()).toEqual([
      'opencode-go/deepseek-v4-pro',
      'opencode/gpt-5.1',
      'opencode/some-other-model',
    ].sort());
    expect(byModelId.get('opencode-go/deepseek-v4-pro')!.runnerProvider).toBe('opencode-go');
    expect(byModelId.get('opencode/gpt-5.1')!.runnerProvider).toBe('opencode');
    // No Claude/Anthropic alias leakage into the OpenCode list.
    expect(models.some((m) => m.modelId === 'opus' || m.modelId === 'sonnet')).toBe(false);
  });

  it('returns an empty list (not hardcoded models) when every discovery command fails', async () => {
    // The reported bug: with `opencode` unavailable, users saw a phantom
    // hardcoded list (DeepSeek V4 Pro, Kimi K2.6, GPT-5.1, …) they never had.
    const exec: ExecImpl = vi.fn(async () => { throw new Error('ENOENT'); });
    const discovery = new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec);

    expect(await discovery.discover('opencode')).toEqual([]);
  });

  it('parses multi-segment model ids (e.g. openrouter/vendor/model)', async () => {
    // Regression: the verbose split regex only matched `provider/single-segment`,
    // so every `openrouter/vendor/model` (two slashes) was dropped — no OpenRouter
    // model ever reached the picker despite 300+ being available.
    const verboseOutput = [
      'openrouter/deepseek/deepseek-v4-flash',
      JSON.stringify({ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', providerID: 'openrouter', variants: {} }),
      'openrouter/anthropic/claude-3.5-sonnet',
      JSON.stringify({ id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', providerID: 'openrouter', variants: {} }),
    ].join('\n');
    const exec: ExecImpl = vi.fn(async () => ({ stdout: verboseOutput }));
    const discovery = new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec);

    const models = await discovery.discover('opencode');
    const ids = models.map((m) => m.modelId);
    expect(ids).toContain('openrouter/deepseek/deepseek-v4-flash');
    expect(ids).toContain('openrouter/anthropic/claude-3.5-sonnet');
    expect(models.every((m) => m.runnerProvider === 'openrouter')).toBe(true);
  });

  it('parses verbose output and extracts per-model variants', async () => {
    const verboseOutput = [
      'opencode/claude-sonnet-4-6',
      JSON.stringify({
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        providerID: 'opencode',
        variants: { low: {}, medium: {}, high: {}, max: {} },
      }),
      'opencode-go/kimi-k2.6',
      JSON.stringify({
        id: 'kimi-k2.6',
        name: 'Kimi K2.6',
        providerID: 'opencode-go',
        variants: {},
      }),
    ].join('\n');

    const exec: ExecImpl = vi.fn(async () => ({ stdout: verboseOutput }));
    const discovery = new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec);

    const models = await discovery.discover('opencode');
    const byId = new Map(models.map((m) => [m.modelId, m]));

    const sonnet = byId.get('opencode/claude-sonnet-4-6');
    expect(sonnet).toBeDefined();
    expect(sonnet!.runnerProvider).toBe('opencode');
    expect(sonnet!.variants.map((v) => v.id)).toEqual(['low', 'medium', 'high', 'max']);

    const kimi = byId.get('opencode-go/kimi-k2.6');
    expect(kimi).toBeDefined();
    expect(kimi!.runnerProvider).toBe('opencode-go');
    expect(kimi!.variants).toHaveLength(0);
  });

  it('accepts ANY provider/model shape the CLI reports — custom providers, uppercase, version pins', async () => {
    // The `opencode models` output is the source of truth: a provider Ordewell
    // has never heard of must flow through both parsers untouched.
    const exoticIds = [
      'MyAzure/GPT-4o',
      'my.custom-provider/Meta-Llama-3.1-405B-Instruct',
      'together/qwen/Qwen2.5-Coder-32B',
      'local_llm/model@2024-12-01',
      'openrouter/mistralai/mixtral:free',
    ];

    // Plain parser: bare id lines.
    const plainExec: ExecImpl = vi.fn(async (cmd: string) => {
      if (cmd.includes('--verbose')) throw new Error('no verbose');
      return { stdout: exoticIds.join('\n') + '\n' };
    });
    const plain = await new ModelDiscovery(registryWith(OPENCODE_MANIFEST), plainExec).discover('opencode');
    expect(plain.map((m) => m.modelId).sort()).toEqual([...exoticIds].sort());

    // Verbose parser: id line + JSON block per model.
    const verboseOutput = exoticIds
      .flatMap((id) => [id, JSON.stringify({ id: id.split('/').slice(1).join('/'), variants: { high: {} } }, null, 2)])
      .join('\n');
    const verboseExec: ExecImpl = vi.fn(async () => ({ stdout: verboseOutput }));
    const verbose = await new ModelDiscovery(registryWith(OPENCODE_MANIFEST), verboseExec).discover('opencode');
    expect(verbose.map((m) => m.modelId).sort()).toEqual([...exoticIds].sort());
    for (const m of verbose) expect(m.variants.map((v) => v.id)).toEqual(['high']);
  });

  it('does not mistake URLs or JSON block lines for model ids', async () => {
    const output = [
      'See https://opencode.ai/docs for details',
      'https://models.dev/catalog',
      'opencode/real-model',
      '{',
      '  "id": "real-model",',
      '  "api": { "url": "https://opencode.ai/zen/v1" },',
      '  "variants": {}',
      '}',
    ].join('\n');
    const exec: ExecImpl = vi.fn(async () => ({ stdout: output }));
    const models = await new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec).discover('opencode');
    expect(models.map((m) => m.modelId)).toEqual(['opencode/real-model']);
  });

  it('keeps every configured provider (zen + go + openrouter) from real-shaped verbose output', async () => {
    // Mirrors the real CLI: pretty-printed JSON blocks, tilde alias ids, and
    // nested vendor/model ids — a regression net for multi-provider users.
    const verboseOutput = [
      'opencode/big-pickle',
      JSON.stringify({ id: 'big-pickle', name: 'Big Pickle', providerID: 'opencode', variants: {} }, null, 2),
      'opencode/claude-sonnet-5',
      JSON.stringify({ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', providerID: 'opencode', variants: { low: {}, high: {} } }, null, 2),
      'opencode-go/deepseek-v4-pro',
      JSON.stringify({ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', providerID: 'opencode-go', variants: { low: {}, high: {} } }, null, 2),
      'openrouter/~anthropic/claude-fable-latest',
      JSON.stringify({ id: '~anthropic/claude-fable-latest', name: 'Claude Fable (latest)', providerID: 'openrouter', variants: { low: {}, medium: {}, high: {} } }, null, 2),
      'openrouter/deepseek/deepseek-chat',
      JSON.stringify({ id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', providerID: 'openrouter', variants: {} }, null, 2),
    ].join('\n');

    const exec: ExecImpl = vi.fn(async () => ({ stdout: verboseOutput }));
    const discovery = new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec);

    const models = await discovery.discover('opencode');
    const providers = new Set(models.map((m) => m.runnerProvider));
    expect(providers).toEqual(new Set(['opencode', 'opencode-go', 'openrouter']));
    expect(models.map((m) => m.modelId)).toContain('openrouter/~anthropic/claude-fable-latest');
    expect(models.map((m) => m.modelId)).toContain('openrouter/deepseek/deepseek-chat');
    expect(models).toHaveLength(5);
  });

  it('the provider is the printed prefix — never renamed, never taken from the JSON', async () => {
    const verboseOutput = [
      'opencode/claude-sonnet-4-6',
      // Even a JSON block claiming a different providerID must not override the prefix.
      JSON.stringify({ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', providerID: 'something-else', variants: {} }),
      'opencode-go/kimi-k2.6',
      JSON.stringify({ id: 'kimi-k2.6', name: 'Kimi K2.6', providerID: 'opencode-go', variants: {} }),
    ].join('\n');
    const exec: ExecImpl = vi.fn(async () => ({ stdout: verboseOutput }));
    const discovery = new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec);

    const byId = new Map((await discovery.discover('opencode')).map((m) => [m.modelId, m]));
    expect(byId.get('opencode/claude-sonnet-4-6')!.runnerProvider).toBe('opencode');
    expect(byId.get('opencode/claude-sonnet-4-6')!.runnerProviderLabel).toBeUndefined();
    expect(byId.get('opencode-go/kimi-k2.6')!.runnerProvider).toBe('opencode-go');
    expect(byId.get('opencode-go/kimi-k2.6')!.runnerProviderLabel).toBeUndefined();
  });

  it('verbose parser sorts alphabetically and labels from the CLI JSON', async () => {
    const verboseOutput = [
      'opencode/some-other-model',
      JSON.stringify({ id: 'some-other-model', name: 'Some Other', providerID: 'opencode', variants: {} }),
      'opencode-go/deepseek-v4-pro',
      JSON.stringify({ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', providerID: 'opencode-go', variants: { low: {}, high: {} } }),
    ].join('\n');

    const exec: ExecImpl = vi.fn(async () => ({ stdout: verboseOutput }));
    const discovery = new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec);

    const models = await discovery.discover('opencode');
    expect(models[0].modelId).toBe('opencode-go/deepseek-v4-pro');
    expect(models[0].modelLabel).toBe('DeepSeek V4 Pro');
    expect(models[0].runnerProvider).toBe('opencode-go');
    expect(models[1].runnerProvider).toBe('opencode');
  });

  it('retries once when a cold CLI times out on the first pass, then succeeds', async () => {
    // Cold start: both discovery commands (verbose + plain) throw on the first
    // pass while the just-spawned opencode server warms up and fetches its
    // catalog. Without the retry, discovery degrades to an empty list and the
    // picker silently goes short. A single retry after warm-up recovers it.
    let pass = 0;
    const exec: ExecImpl = vi.fn(async (_cmd: string) => {
      // Two commands per pass (verbose, then plain). Fail every command on the
      // first pass; serve the real list on the second.
      if (pass < 2) { pass++; throw new Error('ETIMEDOUT'); }
      pass++;
      return { stdout: ['opencode/gpt-5.1', 'opencode-go/deepseek-v4-pro'].join('\n') };
    });
    const discovery = new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec);

    const models = await discovery.discover('opencode');
    expect(models.map((m) => m.modelId).sort()).toEqual(['opencode-go/deepseek-v4-pro', 'opencode/gpt-5.1']);
  });

  it('degrades to an empty list only after the retry also fails', async () => {
    // A persistently unavailable CLI (not merely cold) must still return [] —
    // the retry cannot conjure a catalog. Both passes throw for every command.
    const exec: ExecImpl = vi.fn(async () => { throw new Error('ENOENT'); });
    const discovery = new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec);

    expect(await discovery.discover('opencode')).toEqual([]);
    // 2 commands × 2 passes = 4 attempts before giving up.
    expect(exec).toHaveBeenCalledTimes(4);
  });
});

describe('ModelDiscovery — Claude Code variants', () => {
  it('applies the static fallback variants to models parsed from --help', async () => {
    // --help text carries no capability info, so parsed models start with
    // empty variants and applyVariants fills in the manifest's static fallback
    // list (6 entries: adaptive + 5 effort levels, no disabled).
    const exec: ExecImpl = vi.fn(async (command: string) => {
      if (command.includes('--help')) return { stdout: MODERN_CLAUDE_HELP };
      throw new Error('unexpected');
    });
    const discovery = new ModelDiscovery(registryWith(CLAUDE_CODE_MANIFEST), exec, failingFetch);

    const models = await discovery.discover('claude-code');
    expect(models.length).toBeGreaterThan(0);

    const variantIds = models[0].variants.map((v) => v.id);
    expect(variantIds).toEqual(['adaptive', 'low', 'medium', 'high', 'xhigh', 'max']);
  });
});
