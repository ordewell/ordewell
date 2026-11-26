import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { discoverGeminiModels, ModelDiscovery, type ExecImpl } from '../ModelDiscovery';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { CLAUDE_CODE_MANIFEST } from '../../plugins/builtin/claude-code.manifest';
import { OPENCODE_MANIFEST } from '../../plugins/builtin/opencode.manifest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Claude discovery reads its settings and credentials under HOME, or where
// CLAUDE_CONFIG_DIR moves them, and the machine's managed settings: an empty
// home, no config dir and no managed files keep a developer's own gateway
// models out of the exact lists below.
vi.mock('fs', async (importOriginal) =>
  (await import('./claudeManagedSettings')).hidingClaudeManagedSettings(await importOriginal<typeof import('fs')>()));

let home: string;
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-discovery-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

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

  it('remembers a fallback-only result for a short TTL instead of re-running the CLI every lookup', async () => {
    // The first lookup fails and returns the canonical fallback. That result is
    // not cached (it must heal) but IS remembered for a TTL, so a planner switch
    // or a repeated lookup right after does not re-pay a slow/failing CLI. Past
    // the TTL the CLI is asked again and the discovered list wins.
    let calls = 0;
    let clock = 0;
    const exec: ExecImpl = vi.fn(async (command: string) => {
      calls++;
      if (calls === 1) throw new Error('ENOENT');
      if (command.includes('--help')) return { stdout: MODERN_CLAUDE_HELP };
      throw new Error('unexpected');
    });
    const discovery = new ModelDiscovery(registryWith(CLAUDE_CODE_MANIFEST), exec, failingFetch, undefined, undefined, () => clock);

    const first = await discovery.discover('claude-code');
    expect(first.map((m) => m.modelId)).toEqual(['opus', 'sonnet', 'haiku', 'fable']);

    clock = 30_000;
    const withinTtl = await discovery.discover('claude-code');
    expect(withinTtl.map((m) => m.modelId)).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
    expect(exec).toHaveBeenCalledTimes(1);

    // 60s TTL is internal; step past any plausible value.
    clock = 61_000;
    const afterTtl = await discovery.discover('claude-code');
    expect(afterTtl.map((m) => m.modelId)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('clear() drops a remembered miss so the next lookup re-runs the CLI', async () => {
    let calls = 0;
    const exec: ExecImpl = vi.fn(async (command: string) => {
      calls++;
      if (calls === 1) throw new Error('ENOENT');
      if (command.includes('--help')) return { stdout: MODERN_CLAUDE_HELP };
      throw new Error('unexpected');
    });
    const discovery = new ModelDiscovery(registryWith(CLAUDE_CODE_MANIFEST), exec, failingFetch);

    expect((await discovery.discover('claude-code')).map((m) => m.modelId)).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
    discovery.clear();
    expect((await discovery.discover('claude-code')).map((m) => m.modelId)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(exec).toHaveBeenCalledTimes(2);
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

  // A workspace's environment can name another OpenCode account and config.
  it('runs its discovery commands under the environment runners are launched with', async () => {
    const env = { HOME: '/home/work', OPENCODE_CONFIG: '/accounts/work/opencode.json' };
    const exec = vi.fn<ExecImpl>(async () => ({ stdout: 'opencode/gpt-5.1' }));
    await new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec, undefined, undefined, undefined, undefined, async () => env).discover('opencode');

    expect(exec).toHaveBeenCalled();
    for (const [, options] of exec.mock.calls) expect(options?.env).toBe(env);
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

  it('retries the variant-bearing catalog after a cold failure instead of taking the variant-less list', async () => {
    // Real `opencode api model.list` v2.4.1 shape, trimmed to one model.
    const api = JSON.stringify({
      location: { directory: '/Users/someone' },
      data: [{
        modelID: 'deepseek-v4.1-flash',
        providerID: 'opencode-go',
        type: 'chat',
        name: 'DeepSeek V4.1 Flash 1017',
        enabled: true,
        variants: [
          { id: 'low', settings: { reasoningEffort: 'low' } },
          { id: 'high', settings: { reasoningEffort: 'high' } },
          { id: 'max', settings: { reasoningEffort: 'max' } },
        ],
        limit: { context: 1000000, output: 384000 },
      }],
    });
    let apiCalls = 0;
    const exec: ExecImpl = vi.fn(async (cmd: string) => {
      if (cmd.includes('models --verbose')) throw new Error('Unrecognized flag: --verbose');
      if (cmd.includes('api model.list')) {
        apiCalls++;
        // Cold OpenCode server: the catalog command is killed by its timeout,
        // while the plain listing answers from the warm server.
        if (apiCalls === 1) throw Object.assign(new Error('ETIMEDOUT'), { killed: true });
        return { stdout: api };
      }
      return { stdout: 'opencode-go/deepseek-v4.1-flash\n' };
    });

    const models = await new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec).discover('opencode');

    const model = models.find((m) => m.modelId === 'opencode-go/deepseek-v4.1-flash');
    expect(model?.variants.map((v) => v.id)).toEqual(['low', 'high', 'max']);
  });

  it('reads the per-model variants of opencode v2.4.1\'s `api model.list` answer', async () => {
    // Trimmed from the real CLI on this machine (2026-11-26): `variants` is an
    // array of { id, settings }, and a model that accepts no effort has [].
    const api = JSON.stringify({
      location: { directory: '/Users/someone' },
      data: [
        {
          modelID: 'deepseek-v4.1-flash', providerID: 'opencode-go', type: 'chat',
          name: 'DeepSeek V4.1 Flash 1017', enabled: true,
          variants: [
            { id: 'low', settings: { reasoningEffort: 'low' } },
            { id: 'high', settings: { reasoningEffort: 'high' } },
            { id: 'max', settings: { reasoningEffort: 'max' } },
          ],
          limit: { context: 1000000, output: 384000 },
        },
        {
          modelID: 'gpt-6-luna', providerID: 'opencode-go', type: 'chat',
          name: 'GPT-6 Luna', enabled: true,
          variants: [
            { id: 'none', settings: { reasoningEffort: 'none' } },
            { id: 'low', settings: { reasoningEffort: 'low' } },
            { id: 'medium', settings: { reasoningEffort: 'medium' } },
            { id: 'high', settings: { reasoningEffort: 'high' } },
            { id: 'xhigh', settings: { reasoningEffort: 'xhigh' } },
            { id: 'max', settings: { reasoningEffort: 'max' } },
          ],
          limit: { context: 1050000, output: 128000 },
        },
        {
          modelID: 'mimo-v2.6-pro', providerID: 'opencode-go', type: 'chat',
          name: 'MiMo-V2.6-Pro', enabled: true, variants: [],
          limit: { context: 1048576, output: 131072 },
        },
      ],
    });
    const exec: ExecImpl = vi.fn(async (cmd: string) => {
      if (cmd.includes('models --verbose')) throw new Error('Unrecognized flag: --verbose');
      if (cmd.includes('api model.list')) return { stdout: api };
      throw new Error('plain listing should not be reached');
    });

    const models = await new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec).discover('opencode');
    const byId = new Map(models.map((m) => [m.modelId, m]));

    expect(byId.get('opencode-go/deepseek-v4.1-flash')!.variants.map((v) => v.id)).toEqual(['low', 'high', 'max']);
    expect(byId.get('opencode-go/gpt-6-luna')!.variants.map((v) => v.id)).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    // No variants is still no variants: nothing is invented for a model that takes no effort.
    expect(byId.get('opencode-go/mimo-v2.6-pro')!.variants).toEqual([]);
  });

  it('does not cache a variant-less answer degraded by a failed catalog command', async () => {
    const api = JSON.stringify({
      data: [{
        modelID: 'deepseek-v4.1-flash',
        providerID: 'opencode-go',
        name: 'DeepSeek V4.1 Flash 1017',
        enabled: true,
        variants: [{ id: 'low', settings: {} }, { id: 'high', settings: {} }],
      }],
    });
    let apiHealthy = false;
    const exec: ExecImpl = vi.fn(async (cmd: string) => {
      if (cmd.includes('models --verbose')) throw new Error('Unrecognized flag: --verbose');
      if (cmd.includes('api model.list')) {
        // A server that exits non-zero (not a timeout) is answered by the plain
        // listing too, and must not become the daemon's permanent catalog.
        if (!apiHealthy) throw Object.assign(new Error('Server process exited with code 1'), { code: 1 });
        return { stdout: api };
      }
      return { stdout: 'opencode-go/deepseek-v4.1-flash\n' };
    });
    let clock = 0;
    const discovery = new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec, undefined, undefined, undefined, () => clock);

    const first = await discovery.discover('opencode');
    expect(first.find((m) => m.modelId === 'opencode-go/deepseek-v4.1-flash')!.variants).toEqual([]);

    // Before the degraded answer's short negative TTL, re-reading it is fine.
    clock += 30_000;
    // But it must not be the daemon's catalog for good: once the CLI answers,
    // the next lookup recovers the variants instead of serving the plain list.
    apiHealthy = true;
    clock += 31_000;
    const later = await discovery.discover('opencode');
    expect(later.find((m) => m.modelId === 'opencode-go/deepseek-v4.1-flash')!.variants.map((v) => v.id)).toEqual(['low', 'high']);
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

  it('reads each model\'s window from the limit.context of its verbose block', async () => {
    const verboseOutput = [
      'opencode/claude-sonnet-4-6',
      JSON.stringify({ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', providerID: 'opencode', limit: { context: 200000, output: 64000 }, variants: {} }),
      'opencode-go/kimi-k2.6',
      JSON.stringify({ id: 'kimi-k2.6', name: 'Kimi K2.6', providerID: 'opencode-go', variants: {} }),
    ].join('\n');
    const exec: ExecImpl = vi.fn(async () => ({ stdout: verboseOutput }));

    const models = await new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec).discover('opencode');

    const windows = Object.fromEntries(models.map((m) => [m.modelId, m.contextWindow]));
    expect(windows).toEqual({ 'opencode/claude-sonnet-4-6': 200000, 'opencode-go/kimi-k2.6': undefined });
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

  it('retries once when a cold CLI is killed by its timeout, then succeeds', async () => {
    // Cold start: both discovery commands (verbose + plain) time out on the
    // first pass while the just-spawned opencode server warms up and fetches its
    // catalog. `exec` rejects a timed-out child as killed. Without the retry,
    // discovery degrades to an empty list and the picker silently goes short.
    let pass = 0;
    const exec: ExecImpl = vi.fn(async (_cmd: string) => {
      // Three commands per pass (verbose, api, then plain). Time out every
      // command on the first pass; serve the real list on the second.
      if (pass < 3) { pass++; throw Object.assign(new Error('ETIMEDOUT'), { killed: true }); }
      pass++;
      return { stdout: ['opencode/gpt-5.1', 'opencode-go/deepseek-v4-pro'].join('\n') };
    });
    const discovery = new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec);

    const models = await discovery.discover('opencode');
    expect(models.map((m) => m.modelId).sort()).toEqual(['opencode-go/deepseek-v4-pro', 'opencode/gpt-5.1']);
  });

  it('does not retry a command that exited non-zero — the error is an answer', async () => {
    // A missing binary, a rejected flag or a busy port cannot heal on a retry.
    // Repeating the command only doubles the wait (a failing `opencode models`
    // still boots its background service first), so one pass is enough.
    const exec: ExecImpl = vi.fn(async () => { throw new Error('ENOENT'); });
    const discovery = new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec);

    expect(await discovery.discover('opencode')).toEqual([]);
    // 3 commands × 1 pass = 3 attempts.
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('degrades to an empty list only after the timeout retry also fails', async () => {
    // A persistently cold CLI (times out both passes) must still return [] —
    // the retry cannot conjure a catalog.
    const exec: ExecImpl = vi.fn(async () => { throw Object.assign(new Error('ETIMEDOUT'), { killed: true }); });
    const discovery = new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec);

    expect(await discovery.discover('opencode')).toEqual([]);
    // 3 commands × 2 passes = 6 attempts before giving up.
    expect(exec).toHaveBeenCalledTimes(6);
  });

  it('reads variants from `api model.list` when opencode v2 rejects --verbose', async () => {
    // v2 dropped `models --verbose` (it prints help and exits non-zero) and
    // serves the same catalog, variants included, over its local API.
    const apiOutput = JSON.stringify({
      location: { directory: '/work' },
      data: [
        { id: 'claude-sonnet-5', modelID: 'claude-sonnet-5', providerID: 'opencode', name: 'Claude Sonnet 5', enabled: true, variants: [{ id: 'low', settings: {} }, { id: 'high', settings: {} }] },
        { id: 'big-pickle', modelID: 'big-pickle', providerID: 'opencode', name: 'Big Pickle', enabled: true, variants: [] },
        { id: '~anthropic/claude-fable-latest', modelID: '~anthropic/claude-fable-latest', providerID: 'openrouter', enabled: true, variants: [{ id: 'medium' }] },
        { id: 'off', modelID: 'off', providerID: 'opencode', name: 'Off', enabled: false, variants: [] },
      ],
    });
    const exec: ExecImpl = vi.fn(async (cmd: string) => {
      if (cmd.includes('--verbose')) throw Object.assign(new Error('Unrecognized flag'), { code: 1 });
      if (cmd.includes('api model.list')) return { stdout: apiOutput };
      throw new Error('the plain listing should not be needed');
    });

    const models = await new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec).discover('opencode');

    const byId = new Map(models.map((m) => [m.modelId, m]));
    expect([...byId.keys()].sort()).toEqual(['opencode/big-pickle', 'opencode/claude-sonnet-5', 'openrouter/~anthropic/claude-fable-latest']);
    expect(byId.get('opencode/claude-sonnet-5')!.modelLabel).toBe('Claude Sonnet 5');
    expect(byId.get('opencode/claude-sonnet-5')!.variants.map((v) => v.id)).toEqual(['low', 'high']);
    expect(byId.get('opencode/claude-sonnet-5')!.runnerProvider).toBe('opencode');
    expect(byId.get('openrouter/~anthropic/claude-fable-latest')!.modelLabel).toBe('~anthropic/claude-fable-latest');
    // A rejected flag is an answer, not a cold start: one pass, no retry.
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('reads each model\'s window from the limit.context `api model.list` reports', async () => {
    // Trimmed from what opencode 2.0.31 printed: every one of its 113 models
    // carried `limit.context`; `input` was absent on some, so it is not the window.
    const apiOutput = JSON.stringify({
      data: [
        { id: 'claude-haiku-5-5', modelID: 'claude-haiku-5-5', providerID: 'opencode', name: 'Claude Haiku 5.5', enabled: true, variants: [], limit: { context: 1000000, output: 128000 } },
        { id: 'nemotron-3.5-super-vl-free', modelID: 'nemotron-3.5-super-vl-free', providerID: 'opencode', name: 'Nemotron 3.5 Super VL Free', enabled: true, variants: [], limit: { context: 1048576, input: 1048576, output: 131072 } },
        { id: 'unsized', modelID: 'unsized', providerID: 'opencode', name: 'Unsized', enabled: true, variants: [] },
      ],
    });
    const exec: ExecImpl = vi.fn(async (cmd: string) => {
      if (cmd.includes('api model.list')) return { stdout: apiOutput };
      throw Object.assign(new Error('Unrecognized flag'), { code: 1 });
    });

    const models = await new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec).discover('opencode');

    const windows = Object.fromEntries(models.map((m) => [m.modelId, m.contextWindow]));
    expect(windows).toEqual({ 'opencode/claude-haiku-5-5': 1000000, 'opencode/nemotron-3.5-super-vl-free': 1048576, 'opencode/unsized': undefined });
  });

  it('falls through to the plain listing when the api answer is not a model list', async () => {
    // A v1 CLI that does not know `api`, or an HTTP error body, must not hide
    // the catalog `opencode models` reports.
    const exec: ExecImpl = vi.fn(async (cmd: string) => {
      if (cmd.includes('--verbose')) throw new Error('Unrecognized flag');
      if (cmd.includes('api model.list')) return { stdout: 'HTTP 404 Not Found' };
      return { stdout: 'opencode/gpt-5.1\n' };
    });

    const models = await new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec).discover('opencode');

    expect(models.map((m) => m.modelId)).toEqual(['opencode/gpt-5.1']);
  });

  it('shares one discovery between lookups of the same runner that overlap', async () => {
    // A planner switch and a runner-list refresh land inside one another's
    // wait; two `opencode models` calls would race for the same service.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const exec: ExecImpl = vi.fn(async (cmd: string) => {
      if (!cmd.includes('models --verbose')) throw new Error('not the v1 catalog');
      await gate;
      return { stdout: 'opencode/gpt-5.1\n' };
    });
    const discovery = new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec);

    const a = discovery.discover('opencode');
    const b = discovery.discover('opencode');
    release();
    expect((await a).map((m) => m.modelId)).toEqual(['opencode/gpt-5.1']);
    expect((await b).map((m) => m.modelId)).toEqual(['opencode/gpt-5.1']);

    // One command, once — not once per lookup.
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('does not join a discovery that began before clear()', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let call = 0;
    const exec: ExecImpl = vi.fn(async (cmd: string) => {
      if (!cmd.includes('models --verbose')) throw new Error('nope');
      if (call++ === 0) { await gate; return { stdout: 'opencode/stale\n' }; }
      return { stdout: 'opencode/fresh\n' };
    });
    const discovery = new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec);

    const before = discovery.discover('opencode');
    discovery.clear();
    const after = await discovery.discover('opencode');
    release();
    await before;

    expect(after.map((m) => m.modelId)).toEqual(['opencode/fresh']);
  });

  it('leaves the cache to the discovery after clear() when one begun before it ends last', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let call = 0;
    const exec: ExecImpl = vi.fn(async (cmd: string) => {
      if (!cmd.includes('models --verbose')) throw new Error('nope');
      if (call++ === 0) { await gate; return { stdout: 'opencode/stale\n' }; }
      return { stdout: 'opencode/fresh\n' };
    });
    const discovery = new ModelDiscovery(registryWith(OPENCODE_MANIFEST), exec);

    const before = discovery.discover('opencode');
    discovery.clear();
    await discovery.discover('opencode');
    release();

    expect((await before).map((m) => m.modelId)).toEqual(['opencode/stale']);
    expect(discovery.getCached('opencode')?.map((m) => m.modelId)).toEqual(['opencode/fresh']);
    expect((await discovery.discover('opencode')).map((m) => m.modelId)).toEqual(['opencode/fresh']);
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
