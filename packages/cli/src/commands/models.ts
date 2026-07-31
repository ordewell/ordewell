import {
  EnvConfig,
  collectProviderCredentials,
  configuredProviders,
  fetchAllProviderModels,
  toOrchestratorOptions,
  ORCHESTRATOR_SHORTCUTS,
  getProviderMeta,
  type AiProvider,
  type OrchestratorOption,
} from '@ordewell/core';
import { handleModel } from './model';

const PER_PROVIDER_LIMIT = 50;

export async function handleModels(subArgs: string[]): Promise<void> {
  // `models` lists every provider's catalog straight from the config, with no
  // daemon involved — the one command that still works before a server exists.
  // Setting a model is a different job, and it belongs to whoever owns the
  // "push to the daemon, then persist" ordering: `ordewell model set`.
  const setIdx = subArgs.indexOf('--set');
  if (setIdx !== -1 && subArgs[setIdx + 1]) {
    const rest = subArgs.filter((_, i) => i !== setIdx && i !== setIdx + 1);
    return handleModel(['set', subArgs[setIdx + 1], ...rest]);
  }

  const config = new EnvConfig();
  const providers = configuredProviders(config);

  if (providers.length === 0) {
    console.error('No providers configured. Set an API key for a provider, e.g.:');
    console.error('  OPENROUTER_API_KEY=...   (OpenRouter)');
    console.error('  GEMINI_API_KEY=...       (Google Gemini)');
    console.error('  OPENAI_API_KEY=...       (OpenAI)');
    console.error('  OPENAI_COMPATIBLE_BASE_URL=...  (self-hosted / OpenAI-compatible)');
    process.exit(1);
  }

  const { apiKeys, baseUrls } = collectProviderCredentials(config);

  let models: OrchestratorOption[];
  let errors: Record<string, string>;
  try {
    const result = await fetchAllProviderModels({ apiKeys, baseUrls });
    models = toOrchestratorOptions(result.models, ORCHESTRATOR_SHORTCUTS);
    errors = result.errors;
  } catch (err) {
    // A hard throw here means the whole fan-out failed (not a single provider);
    // surface it and stop rather than printing an empty list.
    console.error(`Failed to fetch models: ${err instanceof Error ? (err as Error).message : String(err)}`);
    process.exit(1);
    return;
  }

  const providerLabel = (p: AiProvider) => getProviderMeta(p)?.label ?? p;

  console.log(
    `\nAvailable models (${models.length}) across ${providers.length} configured provider(s):`,
  );

  // Group under each configured provider, in priority order, so every model
  // is shown next to the provider whose key serves it.
  for (const provider of providers) {
    const forProvider = models.filter((m) => m.apiProvider === provider);
    if (forProvider.length === 0) continue;
    console.log(`\n${providerLabel(provider)}`);
    for (const m of forProvider.slice(0, PER_PROVIDER_LIMIT)) {
      const price = m.pricing ? ` · $${m.pricing}/MTok` : '';
      console.log(`  ${m.id}`);
      console.log(`    ${m.label}${price}`);
    }
    if (forProvider.length > PER_PROVIDER_LIMIT) {
      console.log(`  ... and ${forProvider.length - PER_PROVIDER_LIMIT} more (showing first ${PER_PROVIDER_LIMIT})`);
    }
  }

  // Flag anything that didn't work: a configured provider whose catalog fetch
  // failed, or one that returned nothing.
  const producing = new Set(models.map((m) => m.apiProvider));
  const failed = providers.filter((p) => errors[p]);
  const empty = providers.filter((p) => !errors[p] && !producing.has(p));

  if (failed.length > 0 || empty.length > 0) {
    console.error('');
    for (const p of failed) {
      console.error(`⚠ ${providerLabel(p)}: ${errors[p]}`);
    }
    for (const p of empty) {
      console.error(`⚠ ${providerLabel(p)}: no models returned (check the API key or base URL).`);
    }
  }

  console.log(
    `\n  Current orchestrator model: ${process.env.ORCHESTRATOR_MODEL || 'deepseek/deepseek-v4-flash'}`,
  );
  console.log(`  Set with: ordewell models --set <model_id>`);
}
